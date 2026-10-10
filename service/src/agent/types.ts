import type { OpenAIToolCall } from './openaiClient'

/** 单轮模型调用的用量与耗时 */
export interface AgentUsageStep {
  /** 第几轮模型调用（0 起）：正常一轮问答 = 步数 + 1 次调用 */
  turn: number
  promptTokens: number
  completionTokens: number
  durationMs: number
}

/**
 * 一次 Agent 运行的累计用量，随 `answer` 事件带出（**纯增量字段**，老前端忽略即可）。
 * 上游未返回 usage 时，token 计数为 0，durationMs 仍真实有效。
 */
export interface AgentUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** 整轮运行的墙钟耗时（含工具执行与审批等待） */
  durationMs: number
  /** 逐轮明细，供「各步耗时」展示与落库 */
  steps: AgentUsageStep[]
}

/** Agent 运行过程中通过 onEvent 逐条推送的流式事件（判别联合） */
export type AgentEvent =
  | { type: 'thought'; content: string }
  /** 模型文本增量，仅用于实时渲染；定稿仍以 thought / answer 为准 */
  | { type: 'text_delta'; content: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | { type: 'tool_result'; id: string; name: string; content: string }
  /** 需审批的工具已挂起等待用户决策（纯增量事件，不影响既有事件语义） */
  | { type: 'tool_approval_request'; id: string; name: string; arguments: string; reason: string }
  | { type: 'answer'; content: string; usage?: AgentUsage }
  | { type: 'error'; message: string }

/**
 * 带上序号的 AgentEvent —— **SSE 实际发到线上的形态**。
 *
 * `seq` 是本次运行内从 1 开始、单调递增的整数，供断线重连时用 `Last-Event-ID`
 * 定位重放起点（见 runBuffer.ts）。
 *
 * 单独定义而不是把 `seq` 塞进 AgentEvent 的每个分支：产生事件的地方（loop.ts）
 * 不关心序号，让它们继续只构造语义事件，序号在唯一的出口（/agent-process 的
 * writeEvent）统一盖上 —— 否则每个 `onEvent({ type: ... })` 调用点都得自己记数，
 * 漏一处就会出现重放错位。现有字段语义完全不变。
 */
export type SequencedAgentEvent = AgentEvent & { seq: number }

/** 工具定义：元信息 + 执行函数 */
export interface Tool {
  name: string
  description: string
  parameters: Record<string, unknown>
  handler: (args: Record<string, unknown>) => Promise<string> | string
  /** 执行前是否需用户确认（human-in-the-loop）；缺省 false */
  requiresApproval?: boolean
  /** 展示给用户的审批理由（requiresApproval 为真时建议填写） */
  approvalReason?: string
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
  /** 中止信号：客户端断开时中止循环，避免继续消耗 token */
  signal?: AbortSignal
  /**
   * 需审批的工具执行前调用，挂起等待用户决策，resolve(true) 才执行。
   * **缺省视为拒绝（fail-closed）** —— 未接线审批通道时，需审批的工具一律不执行
   */
  requestApproval?: (request: { id: string; name: string; arguments: string; reason: string }) => Promise<boolean>
}

export type { OpenAIToolCall }
