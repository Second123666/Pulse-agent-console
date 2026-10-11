import type { MessageContent } from '../types'

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
  /** 本轮用户输入。13.1 起允许是多模态分片数组（string 仍是常态） */
  message: MessageContent
  lastContext?: { conversationId?: string; parentMessageId?: string }
  process?: (chat: ChatMessage) => void
  systemMessage?: string
  temperature?: number
  top_p?: number
  /** 外部中止信号（客户端断开时联动中止上游请求） */
  signal?: AbortSignal
}
