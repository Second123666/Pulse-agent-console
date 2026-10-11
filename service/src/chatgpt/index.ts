import { randomUUID } from 'node:crypto'
import * as dotenv from 'dotenv'
import { sendResponse } from '../utils'
import { contentChars, contentImageCount, contentText } from '../utils/content'
import { isNotEmptyString } from '../utils/is'
import type { ApiModel, ChatContext, MessageContent, ModelConfig } from '../types'
import type { ChatMessage, RequestOptions } from './types'

dotenv.config()

const ErrorCodeMessage: Record<string, string> = {
  401: '[API] 提供错误的API密钥 | Incorrect API key provided',
  403: '[API] 服务器拒绝访问，请稍后再试 | Server refused to access, please try again later',
  502: '[API] 错误的网关 | Bad Gateway',
  503: '[API] 服务器繁忙，请稍后再试 | Server is busy, please try again later',
  504: '[API] 网关超时 | Gateway Time-out',
  500: '[API] 服务器繁忙，请稍后再试 | Internal Server Error',
}

const timeoutMs: number = !isNaN(+process.env.TIMEOUT_MS) ? +process.env.TIMEOUT_MS : 100 * 1000
const disableDebug: boolean = process.env.DISABLE_DEBUG === 'true'
const apiKey = process.env.API_KEY
const model = isNotEmptyString(process.env.API_MODEL) ? process.env.API_MODEL : 'glm-4-flash'
const apiBaseUrl = (isNotEmptyString(process.env.API_BASE_URL)
  ? process.env.API_BASE_URL
  : 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$|\s+/g, '')

if (!isNotEmptyString(apiKey))
  throw new Error('Missing API_KEY environment variable')

const apiModel: ApiModel = 'OpenAICompatible'

/**
 * 上游「内容格式不认」的典型状态码（13.4 降级用）。
 * **刻意不含 401 / 403 / 429 / 5xx** —— 那些是密钥、限流、服务本身的问题，
 * 剥掉图片重试只会白打一次请求，还会把真正的错误往后挪
 */
const CONTENT_REJECT_STATUSES = new Set([400, 413, 415, 422])

/** 降级提示：随 SSE 帧带出去，前端 toast 展示一次 */
const MULTIMODAL_DEGRADE_NOTICE = '当前模型不支持图片，已按纯文本发送'

/**
 * 把多模态 content 剥成纯文本：丢掉图片分片、文字拼接（string 原样返回）。
 * 纯图片消息（一个字都没有）给个占位 —— 空串同样是上游不认的非法内容
 */
function toTextOnly(content: MessageContent): string {
  if (typeof content === 'string')
    return content
  return contentText(content) || '[图片已省略]'
}

// 对话历史保存在内存中，以消息 id 为键、通过 parentMessageId 链接成对话
interface MessageRecord {
  id: string
  role: 'user' | 'assistant'
  /** 13.1 起允许是多模态分片数组（user 消息）；assistant 消息恒为字符串，见 chatReplyProcess 里的 assistantText */
  content: MessageContent
  parentMessageId?: string
  conversationId?: string
}

const messageStore = new Map<string, MessageRecord>()

// 沿 parentMessageId 向上回溯取最近的对话历史，按条数和字符数截断以适配模型上下文
function buildHistory(parentMessageId?: string): Array<{ role: 'user' | 'assistant'; content: MessageContent }> {
  const chain: MessageRecord[] = []
  let currentId = parentMessageId
  while (currentId && messageStore.has(currentId)) {
    const record = messageStore.get(currentId)!
    chain.unshift(record)
    currentId = record.parentMessageId
  }

  const MAX_MESSAGES = 20
  const MAX_CHARS = 12000
  const recent = chain.slice(-MAX_MESSAGES)
  // 用 contentChars 而非 content.length：多模态消息的 .length 是分片个数（1 或 2），
  // 拿它当字符数会让一张 1MB 的图只算 1 字，历史永远裁不掉
  while (recent.length > 1 && recent.reduce((sum, m) => sum + contentChars(m.content), 0) > MAX_CHARS)
    recent.shift()

  return recent.map(({ role, content }) => ({ role, content }))
}

async function chatReplyProcess(options: RequestOptions) {
  const { message, lastContext, process, systemMessage, temperature, top_p } = options
  // 超时与客户端中止都会让 fetch 抛 AbortError，靠这个标志区分（catch 里要用，故声明在 try 外）：
  // 只有「内部超时」该报给用户，「客户端中止」是正常路径
  let timedOut = false
  try {
    const parentMessageId = lastContext?.parentMessageId
    const conversationId = (parentMessageId && messageStore.get(parentMessageId)?.conversationId)
      || lastContext?.conversationId
      || randomUUID()

    const userMessage: MessageRecord = { id: randomUUID(), role: 'user', content: message, parentMessageId, conversationId }
    messageStore.set(userMessage.id, userMessage)

    const assistantMessage: MessageRecord = { id: randomUUID(), role: 'assistant', content: '', parentMessageId: userMessage.id, conversationId }
    // 回复文本用局部变量累加，再写回 assistantMessage.content。
    // MessageRecord.content 放宽成 MessageContent 是为了存 user 侧的多模态消息，
    // 而 `union += string` 在类型上过不去 —— 助手这条恒为纯文本，用局部 string 才是实话
    let assistantText = ''

    let messages: Array<{ role: 'system' | 'user' | 'assistant'; content: MessageContent }> = []
    if (isNotEmptyString(systemMessage))
      messages.push({ role: 'system', content: systemMessage })
    messages.push(...buildHistory(parentMessageId), { role: 'user', content: message })

    if (!disableDebug)
      global.console.log(`[API] model: ${model} | messages: ${messages.length} | prompt: ${contentText(message).slice(0, 50)}`)

    const controller = new AbortController()
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    // 外部信号（客户端断开）联动中止上游请求；读取结束后统一清理监听
    const onExternalAbort = () => controller.abort()
    options.signal?.addEventListener('abort', onExternalAbort)

    const requestUpstream = () => fetch(`${apiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        temperature,
        top_p,
      }),
      signal: controller.signal,
    })

    let response = await requestUpstream()

    // ---- 13.4 非多模态模型的降级：失败后剥图重试一次 ----
    //
    // 选**失败降级**而不是能力开关，理由有三：
    // ① 能力开关要先知道模型支不支持图，而 OpenAI 兼容网关的模型名五花八门，
    //    配错方向的后果是「能看图的模型被静默剥图」或「不能看图的模型每次必炸」，都很难发现；
    // ② 失败降级对支持图片的模型是**零成本**（一次请求都不会多发），默认行为不变，老格式请求逐字不动；
    // ③ 开关需要一个配置面（环境变量 + /config 下发 + 前端感知），失败降级把整件事收在这一处。
    // 代价是不支持图片的模型每轮会先白挨一次 4xx —— 但剥图后立刻写回 messageStore，
    // 后续轮次的历史已经是纯文本，**只有第一次带图的请求会付出这次往返**
    let degraded = false
    if (!response.ok && CONTENT_REJECT_STATUSES.has(response.status) && !options.signal?.aborted
      && messages.some(item => contentImageCount(item.content) > 0)) {
      const rejectedText = await response.text().catch(() => '')
      global.console.log(`[API] 上游拒绝多模态内容 (${response.status})，剥离图片重试一次：${rejectedText.slice(0, 200)}`)
      // 连历史一起剥：不能只管本轮，上一轮留在历史里的图片同样会把请求再顶回来一次
      messages = messages.map(item => ({ role: item.role, content: toTextOnly(item.content) }))
      // 写回存储：下一轮 buildHistory 取到的就是纯文本，降级只在带图的第一轮发生一次
      userMessage.content = toTextOnly(message)
      response = await requestUpstream()
      // 重试成功才算降级成立：仍失败就照常报错，错误来自第二次请求、不带提示
      degraded = response.ok
    }
    const notice = degraded ? MULTIMODAL_DEGRADE_NOTICE : undefined

    if (!response.ok || !response.body) {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onExternalAbort)
      const status = String(response.status)
      const errorText = await response.text().catch(() => '')
      global.console.log(`[API] request failed (${status}): ${errorText}`)
      if (Reflect.has(ErrorCodeMessage, status))
        return sendResponse({ type: 'Fail', message: ErrorCodeMessage[status] })
      return sendResponse({ type: 'Fail', message: `Request failed with status ${status}` })
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    let finishReason: string | null = null

    // 与前端约定：每次推送全量累计文本，detail 透传 finish_reason 以支持长回复续写；
    // 降级说明（notice）每帧都带，前端去重后只 toast 一次
    const emit = () => {
      process?.({
        id: assistantMessage.id,
        text: assistantText,
        conversationId,
        detail: { choices: [{ finish_reason: finishReason }] },
        ...(notice ? { notice } : {}),
      } satisfies ChatMessage)
    }

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done)
          break
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:'))
            continue
          const payload = trimmed.slice(5).trim()
          if (!payload || payload === '[DONE]')
            continue
          try {
            const data = JSON.parse(payload)
            const deltaContent: string = data.choices?.[0]?.delta?.content ?? ''
            if (data.choices?.[0]?.finish_reason)
              finishReason = data.choices[0].finish_reason
            if (deltaContent) {
              assistantText += deltaContent
              assistantMessage.content = assistantText
              emit()
            }
          }
          catch {
            // 忽略无法解析的行
          }
        }
      }
    }
    finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onExternalAbort)
    }

    messageStore.set(assistantMessage.id, assistantMessage)
    emit()
    return sendResponse({ type: 'Success', data: { id: assistantMessage.id, text: assistantText, conversationId, ...(notice ? { notice } : {}) } })
  }
  catch (error: any) {
    // 客户端主动中止（用户点停止 / 关页面）：原样上抛，由调用方按 error.name 静默处理。
    // 不能在此转成 Fail —— 连接已断没人收，且每次停止都刷一段堆栈
    if (options.signal?.aborted)
      throw error

    global.console.log(error)
    const failMessage = timedOut
      ? 'Request timed out'
      : (error?.message ?? 'Please check the back-end console')
    return sendResponse({ type: 'Fail', message: failMessage })
  }
}

async function chatConfig() {
  return sendResponse<ModelConfig>({
    type: 'Success',
    data: { apiModel, timeoutMs },
  })
}

function currentModel(): ApiModel {
  return apiModel
}

export type { ChatContext, ChatMessage }

export { chatReplyProcess, chatConfig, currentModel }
