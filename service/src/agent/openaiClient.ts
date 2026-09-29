import { agentConfig } from '../utils/config'
import { isNotEmptyString } from '../utils/is'

/** OpenAI Chat Completions 线协议中的消息（含工具调用） */
export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
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

export interface ChatCompletionResult {
  content: string | null
  toolCalls: OpenAIToolCall[]
  finishReason: string | null
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
