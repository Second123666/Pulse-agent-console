export interface RequestProps {
  prompt: string
  options?: ChatContext
  systemMessage: string
  temperature?: number
  top_p?: number
  /** Agent 模式的历史上下文（不含本轮 prompt），缺省为空 */
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>
}

export interface ChatContext {
  conversationId?: string
  parentMessageId?: string
}

export interface ModelConfig {
  apiModel?: ApiModel
  timeoutMs?: number
}

export type ApiModel = 'OpenAICompatible'
