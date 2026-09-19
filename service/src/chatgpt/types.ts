export interface ChatMessage {
  id: string
  text: string
  delta?: string
  conversationId?: string
  detail?: {
    choices: Array<{
      delta?: { content?: string }
      finish_reason?: string | null
    }>
  }
}

export interface RequestOptions {
  message: string
  lastContext?: { conversationId?: string; parentMessageId?: string }
  process?: (chat: ChatMessage) => void
  systemMessage?: string
  temperature?: number
  top_p?: number
}
