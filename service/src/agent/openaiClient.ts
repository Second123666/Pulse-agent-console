import type { MessageContent } from '../types'
import { agentConfig } from '../utils/config'
import { isNotEmptyString } from '../utils/is'

/** OpenAI Chat Completions 线协议中的消息（含工具调用） */
export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  /** 13.1 放开为 `string | ContentPart[]`：图片走 image_url 分片；string 仍是绝大多数消息的形态 */
  content: MessageContent | null
  tool_call_id?: string
  tool_calls?: OpenAIToolCall[]
}

export interface OpenAIToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** OpenAI tools 参数格式 */
export interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export type OpenAIToolChoice = 'auto' | 'none' | { type: 'function'; function: { name: string } }

export interface ChatCompletionOptions {
  messages: OpenAIMessage[]
  tools?: OpenAITool[]
  tool_choice?: OpenAIToolChoice
  temperature?: number
  maxTokens?: number
  /** 自定义接口地址，缺省用 OPENAI_API_BASE_URL */
  baseURL?: string
  /** 自定义模型，缺省用 OPENAI_API_MODEL */
  model?: string
  signal?: AbortSignal
}

/** 上游返回的 token 用量（OpenAI 兼容格式的驼峰化） */
export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface ChatCompletionResult {
  content: string | null
  toolCalls: OpenAIToolCall[]
  finishReason: string | null
  /** 上游未返回 usage 时缺省（调用方需容忍缺省，不得假定一定存在） */
  usage?: TokenUsage
}

/**
 * 解析上游 usage 字段；字段缺失或非数字时返回 undefined。
 *
 * 之所以不抛错：usage 只是统计信息，拿不到时应静默降级为「无用量」，
 * 绝不能因为上游少给一个字段就把整轮对话打断。
 */
function parseUsage(raw: any): TokenUsage | undefined {
  const promptTokens = Number(raw?.prompt_tokens)
  const completionTokens = Number(raw?.completion_tokens)
  if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens))
    return undefined
  const totalTokens = Number(raw?.total_tokens)
  return {
    promptTokens,
    completionTokens,
    totalTokens: Number.isFinite(totalTokens) ? totalTokens : promptTokens + completionTokens,
  }
}

/** 统一错误包装：HTTP 状态 + body 摘要（截断至 500 字符） */
export class OpenAIError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message)
    this.name = 'OpenAIError'
  }
}

function timeoutMs(): number {
  const raw = Number(process.env.TIMEOUT_MS)
  return (Number.isFinite(raw) && raw > 0) ? raw : 100 * 1000
}

function summarizeBody(body: string): string {
  return body.length > 500 ? `${body.slice(0, 500)}…` : body
}

/** 流式响应的单个 chunk（仅声明用到的字段） */
interface StreamChunk {
  /** 用量通常只在末帧非空（部分实现每帧带 `usage: null`） */
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  } | null
  choices?: Array<{
    finish_reason?: string | null
    delta?: {
      content?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
  }>
}

/** 组装请求体，流式与非流式共用（stream 为 true 时带上 stream 字段） */
function buildPayload(options: ChatCompletionOptions, model: string, stream: boolean): Record<string, unknown> {
  // messages 整体原样透传：content 是 string 还是分片数组，上游线协议两者都认，
  // 这里不做任何转换 —— 13.1 放开 content 类型时这一段一行没动就是它没被破坏的证据
  const payload: Record<string, unknown> = {
    model,
    messages: options.messages,
  }
  if (stream)
    payload.stream = true
  if (options.tools?.length)
    payload.tools = options.tools
  if (options.tool_choice)
    payload.tool_choice = options.tool_choice
  if (options.temperature !== undefined)
    payload.temperature = options.temperature
  if (options.maxTokens)
    payload.max_tokens = options.maxTokens
  return payload
}

export async function chatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResult> {
  const apiKey = process.env.API_KEY
  if (!isNotEmptyString(apiKey))
    throw new OpenAIError('Missing API_KEY environment variable', 0, '')

  const baseURL = (options.baseURL ?? agentConfig.openaiApiBaseUrl).trim().replace(/\/+$/, '')
  const model = options.model ?? agentConfig.openaiApiModel

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs())
  const signal = options.signal ?? controller.signal

  const payload = buildPayload(options, model, false)

  try {
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal,
    })

    const rawBody = await response.text()
    if (!response.ok)
      throw new OpenAIError(`Chat completions request failed with status ${response.status}`, response.status, summarizeBody(rawBody))

    const data = JSON.parse(rawBody)
    const choice = data.choices?.[0]
    return {
      content: choice?.message?.content ?? null,
      toolCalls: choice?.message?.tool_calls ?? [],
      finishReason: choice?.finish_reason ?? null,
      usage: parseUsage(data.usage),
    }
  }
  catch (error) {
    if (error instanceof OpenAIError)
      throw error
    if (error?.name === 'AbortError')
      throw new OpenAIError('Chat completions request timed out', 0, '')
    throw error
  }
  finally {
    clearTimeout(timer)
  }
}

/** 判断是否为调用方主动中止（区别于内部超时） */
function isCallerAbort(options: ChatCompletionOptions, error: unknown): boolean {
  return !!options.signal?.aborted && (error as { name?: string })?.name === 'AbortError'
}

/**
 * 流式版本：请求体带 `stream: true`，逐块解析上游 SSE。
 *
 * 文本增量通过 `onDelta` 实时回调；返回值与 `chatCompletion` **同构**，
 * 便于调用方无差别替换。tool_calls 在流式下分片下发，需按 index 累积拼接。
 */
export async function chatCompletionStream(
  options: ChatCompletionOptions,
  onDelta?: (content: string) => void,
): Promise<ChatCompletionResult> {
  const apiKey = process.env.API_KEY
  if (!isNotEmptyString(apiKey))
    throw new OpenAIError('Missing API_KEY environment variable', 0, '')

  const baseURL = (options.baseURL ?? agentConfig.openaiApiBaseUrl).trim().replace(/\/+$/, '')
  const model = options.model ?? agentConfig.openaiApiModel

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs())
  const signal = options.signal ?? controller.signal

  const payload = buildPayload(options, model, true)

  try {
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal,
    })

    if (!response.ok) {
      const rawBody = await response.text()
      throw new OpenAIError(`Chat completions request failed with status ${response.status}`, response.status, summarizeBody(rawBody))
    }
    if (!response.body)
      throw new OpenAIError('Chat completions response has no body', response.status, '')

    let content = ''
    let finishReason: string | null = null
    let usage: TokenUsage | undefined
    // 按 index 累积 tool_calls 分片：id 与 name 仅出现在首片，arguments 逐段拼接
    const toolCallParts = new Map<number, { id: string; name: string; args: string }>()

    const handleLine = (line: string) => {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:'))
        return
      const payloadText = trimmed.slice(5).trim()
      if (!payloadText || payloadText === '[DONE]')
        return
      let chunk: StreamChunk
      try {
        chunk = JSON.parse(payloadText) as StreamChunk
      }
      catch {
        return // 上游偶发半截帧，跳过而非中断整条流
      }
      // usage 必须在取 choices 之前读：末帧的 choices 通常是空数组，
      // 先按「无 choice 就 return」处理会把这唯一的用量帧丢掉
      if (chunk.usage)
        usage = parseUsage(chunk.usage) ?? usage
      const choice = chunk.choices?.[0]
      if (!choice)
        return
      if (choice.finish_reason)
        finishReason = choice.finish_reason
      const delta = choice.delta
      if (!delta)
        return
      if (typeof delta.content === 'string' && delta.content !== '') {
        content += delta.content
        onDelta?.(delta.content)
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const part of delta.tool_calls) {
          const index = typeof part.index === 'number' ? part.index : 0
          const acc = toolCallParts.get(index) ?? { id: '', name: '', args: '' }
          if (part.id)
            acc.id = part.id
          if (part.function?.name)
            acc.name = part.function.name
          if (part.function?.arguments)
            acc.args += part.function.arguments
          toolCallParts.set(index, acc)
        }
      }
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done)
        break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines)
        handleLine(line)
    }
    // 上游可能不以换行结尾，处理残留缓冲
    if (buffer)
      handleLine(buffer)

    const toolCalls: OpenAIToolCall[] = [...toolCallParts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({
        id: v.id,
        type: 'function' as const,
        function: { name: v.name, arguments: v.args },
      }))

    return {
      content: content || null,
      toolCalls,
      finishReason,
      usage,
    }
  }
  catch (error) {
    if (error instanceof OpenAIError)
      throw error
    if (error?.name === 'AbortError') {
      // 调用方主动中止：原样抛出，便于上层按 AbortError 识别为正常路径而非故障
      if (isCallerAbort(options, error))
        throw error
      throw new OpenAIError('Chat completions request timed out', 0, '')
    }
    throw error
  }
  finally {
    clearTimeout(timer)
  }
}
