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
  return Number.isFinite(raw) && raw > 0 ? raw : 100 * 1000
}

function summarizeBody(body: string): string {
  return body.length > 500 ? `${body.slice(0, 500)}…` : body
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

  const payload: Record<string, unknown> = {
    model,
    messages: options.messages,
  }
  if (options.tools?.length)
    payload.tools = options.tools
  if (options.tool_choice)
    payload.tool_choice = options.tool_choice
  if (options.temperature !== undefined)
    payload.temperature = options.temperature
  if (options.maxTokens)
    payload.max_tokens = options.maxTokens

  try {
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
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
