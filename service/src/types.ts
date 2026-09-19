export interface RequestProps {
  prompt: string
  options?: ChatContext
  systemMessage: string
  temperature?: number
  top_p?: number
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
