import { randomUUID } from 'node:crypto'
import * as dotenv from 'dotenv'
import { sendResponse } from '../utils'
import { contentChars, contentText } from '../utils/content'
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

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: MessageContent }> = []
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

    const response = await fetch(`${apiBaseUrl}/chat/completions`, {
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

    // 与前端约定：每次推送全量累计文本，detail 透传 finish_reason 以支持长回复续写
    const emit = () => {
      process?.({
        id: assistantMessage.id,
        text: assistantText,
        conversationId,
        detail: { choices: [{ finish_reason: finishReason }] },
      } as ChatMessage)
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
    return sendResponse({ type: 'Success', data: { id: assistantMessage.id, text: assistantText, conversationId } })
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
