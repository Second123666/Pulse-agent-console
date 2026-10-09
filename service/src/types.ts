export interface RequestProps {
  prompt: string
  options?: ChatContext
  systemMessage: string
  temperature?: number
  top_p?: number
  /** Agent 模式的历史上下文（不含本轮 prompt），缺省为空 */
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>
  /**
   * Agent 模式的会话 uuid（前端 Chat.Chat.uuid）。
   * 仅用于长期记忆：把摘要挂到具体会话上，缺省则不生成记忆。
   * 注意与 `options.conversationId`（旧链路的上游会话 id，字符串）无关。
   */
  conversationId?: number
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
