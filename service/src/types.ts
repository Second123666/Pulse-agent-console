/**
 * OpenAI Chat Completions 多模态 content 的单个分片（13.1 放开）。
 * 图片走 `image_url`，url 是 base64 data URI —— 与前端 FileReader.readAsDataURL 的产物一致。
 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/**
 * 消息 content 的线协议类型：纯文本（现状，绝大多数消息都是它）或多模态分片数组。
 * 放宽是**加宽**不是替换 —— string 仍合法且必须走与改动前完全一致的路径。
 * 取文本 / 数字数用 `utils/content.ts` 的 `contentText` / `contentChars`，别自己写 `Array.isArray`。
 */
export type MessageContent = string | ContentPart[]

export interface RequestProps {
  prompt: MessageContent
  options?: ChatContext
  systemMessage: string
  temperature?: number
  top_p?: number
  /** Agent 模式的历史上下文（不含本轮 prompt），缺省为空 */
  messages?: Array<{ role: 'user' | 'assistant'; content: MessageContent }>
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
