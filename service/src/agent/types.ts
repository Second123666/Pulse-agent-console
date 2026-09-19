import type { OpenAIToolCall } from './openaiClient'

/** Agent 运行过程中通过 onEvent 逐条推送的流式事件（判别联合） */
export type AgentEvent =
  | { type: 'thought'; content: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | { type: 'tool_result'; id: string; name: string; content: string }
  | { type: 'answer'; content: string }
  | { type: 'error'; message: string }

/** 工具定义：元信息 + 执行函数 */
export interface Tool {
  name: string
  description: string
  parameters: Record<string, unknown>
  handler: (args: Record<string, unknown>) => Promise<string> | string
}

/** 一次 Agent 运行的输入参数 */
export interface AgentRunOptions {
  /** 对话历史（不含本轮 user 消息之外的辅助消息） */
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  /** 可用工具，缺省为空（纯问答） */
  tools?: Tool[]
  /** 每产生一个事件立即回调（SSE 推送用） */
  onEvent: (event: AgentEvent) => void
  systemMessage?: string
  /** 最大工具调用步数，缺省读 AGENT_MAX_STEPS */
  maxSteps?: number
  /** token 预算，缺省读 AGENT_TOKEN_BUDGET */
  tokenBudget?: number
}

export type { OpenAIToolCall }
