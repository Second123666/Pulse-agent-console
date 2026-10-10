import type { GenericAbortSignal } from 'axios'
import { get, post } from '@/utils/request'
import { useAuthStore, useSettingStore } from '@/store'

export function fetchChatAPI<T = any>(
  prompt: string,
  options?: { conversationId?: string; parentMessageId?: string },
  signal?: GenericAbortSignal,
) {
  return post<T>({
    url: '/chat',
    data: { prompt, options },
    signal,
  })
}

export function fetchChatConfig<T = any>() {
  return post<T>({
    url: '/config',
  })
}

/** /chat-process SSE 帧（后端逐块推送的完整累计文本） */
export interface ChatProcessEvent {
  id: string
  text: string
  conversationId?: string
  detail?: { choices: Array<{ finish_reason?: string | null }> }
  status?: 'Success' | 'Fail'
  message?: string
}

/**
 * 调用 /chat-process（SSE），逐帧解析并以回调方式暴露。
 * 替代 axios onDownloadProgress 的「累积全量文本 + 切最后一行」方案：
 * 增量块只含新帧、每帧只解析一次（O(n)），且协议与 /agent-process 统一。
 */
export function fetchChatAPIProcessStream(params: {
  prompt: string
  options?: { conversationId?: string; parentMessageId?: string }
  signal?: AbortSignal
  onEvent: (event: ChatProcessEvent) => void
}): Promise<void> {
  const settingStore = useSettingStore()
  const authStore = useAuthStore()
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  params.signal?.addEventListener('abort', onAbort)

  const body: Record<string, any> = { prompt: params.prompt, options: params.options }
  if (authStore.isAPIModel) {
    body.systemMessage = settingStore.systemMessage
    body.temperature = settingStore.temperature
    body.top_p = settingStore.top_p
  }

  return fetch(`${import.meta.env.VITE_GLOB_API_URL}/chat-process`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authStore.token ? { Authorization: `Bearer ${authStore.token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  })
    .then(async (response) => {
      // 走的是原生 fetch（不经过 axios），401 需在此单独处理：清 token + 回登录页
      if (response.status === 401) {
        authStore.handleUnauthorized()
        throw new Error('登录状态已过期，请重新登录')
      }

      if (!response.ok || !response.body)
        throw new Error(`对话请求失败：HTTP ${response.status}`)

      const reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''
      // 逐块读取，解析 SSE 的 data: 行（解析器与 fetchAgentProcess 一致）
      while (true) {
        const { done, value } = await reader.read()
        if (done)
          break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:'))
            continue
          const payload = trimmed.slice(5).trim()
          if (!payload)
            continue
          // 只捕获 JSON.parse 的失败（半截帧等，解析不了属预期）
          let event: ChatProcessEvent
          try {
            event = JSON.parse(payload) as ChatProcessEvent
          }
          catch {
            continue
          }
          params.onEvent(event)
        }
      }
    })
    .finally(() => {
      params.signal?.removeEventListener('abort', onAbort)
    })
}

export function fetchSession<T>() {
  return post<T>({
    url: '/session',
  })
}

export function fetchVerify<T>(token: string) {
  return post<T>({
    url: '/verify',
    data: { token },
  })
}

/** 后端 /auth/* 返回的公开用户信息（不含 password_hash / salt） */
export interface AuthUser {
  id: number
  username: string
  role: 'admin' | 'user'
}

/** 登录 / 注册成功后的会话载荷：JWT + 用户信息 */
export interface AuthSessionPayload {
  token: string
  user: AuthUser
}

export function fetchLogin<T = AuthSessionPayload>(username: string, password: string) {
  return post<T>({
    url: '/auth/login',
    data: { username, password },
  })
}

export function fetchRegister<T = AuthSessionPayload>(username: string, password: string, inviteCode?: string) {
  return post<T>({
    url: '/auth/register',
    data: { username, password, inviteCode },
  })
}

/** 当前登录用户：应用启动时用它校验本地 token 是否仍然有效 */
export function fetchMe<T = { user: AuthUser }>() {
  return get<T>({
    url: '/auth/me',
  })
}

/** 服务端会话消息（与后端 messages 表列对应） */
export interface ServerMessage {
  role: 'user' | 'assistant'
  content: string
  agentSteps?: Chat.AgentStep[]
  /** 其余展示字段：dateTime / inversion / error / quote / requestOptions / conversationOptions */
  meta?: Record<string, any> | null
  createdAt: number
}

/** 服务端会话（含消息） */
export interface ServerConversation {
  uuid: number
  title: string
  createdAt: number
  updatedAt: number
  messages: ServerMessage[]
}

/** 会话元信息（不含消息体） */
export interface ServerConversationMeta {
  uuid: number
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
}

/** 会话元信息列表（侧边栏用） */
export function fetchConversationList<T = { conversations: ServerConversationMeta[] }>() {
  return post<T>({
    url: '/conversation/list',
  })
}

/** 取会话（含消息）；uuid 省略时返回全部 —— 启动水合走这条 */
export function fetchConversationGet<T = { conversations: ServerConversation[] }>(uuid?: number) {
  return post<T>({
    url: '/conversation/get',
    data: uuid === undefined ? {} : { uuid },
  })
}

/** 全量保存（服务端按 uuid upsert 并裁掉未提交的会话） */
export function fetchConversationSave<T = { saved: number; deleted: number }>(conversations: ServerConversation[]) {
  return post<T>({
    url: '/conversation/save',
    data: { conversations },
  })
}

/** 删除单个会话（连带其消息） */
export function fetchConversationDelete<T = { deleted: boolean }>(uuid: number) {
  return post<T>({
    url: '/conversation/delete',
    data: { uuid },
  })
}

/** 跨会话消息检索的一条命中 */
export interface MessageSearchHit {
  conversationUuid: number
  conversationTitle: string
  role: 'user' | 'assistant'
  /** 命中片段（已截取 + 折叠换行） */
  snippet: string
  /** 命中词在 snippet 中的区间，供前端高亮；start === end 表示无法定位 */
  matchStart: number
  matchEnd: number
  /** 该消息在所属会话中的下标，跳转定位用 */
  messageIndex: number
  createdAt: number
}

/** 跨会话检索消息正文（服务端 LIKE，按 user_id 隔离） */
export function fetchConversationSearch<T = { hits: MessageSearchHit[] }>(q: string, limit = 20) {
  return get<T>({
    url: '/conversation/search',
    data: { q, limit },
  })
}

/** 单轮模型调用的用量与耗时 */
export interface AgentUsageStep {
  turn: number
  promptTokens: number
  completionTokens: number
  durationMs: number
}

/** 一次 Agent 运行的累计用量（仅 answer 事件带出） */
export interface AgentUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  durationMs: number
  steps: AgentUsageStep[]
}

/** Agent 模式 SSE 事件（与后端 /agent-process 推送格式对应） */
export interface AgentEvent {
  type: 'thought' | 'text_delta' | 'tool_call' | 'tool_result' | 'tool_approval_request' | 'answer' | 'error'
  content?: string
  id?: string
  name?: string
  arguments?: string
  message?: string
  /** 仅 tool_approval_request：展示给用户的审批理由 */
  reason?: string
  /** 仅 answer：本轮累计用量（老后端不返回时缺省） */
  usage?: AgentUsage
  /** 本次运行内单调递增的事件序号（老后端不返回时缺省）；断线重连凭它报「收到哪了」 */
  seq?: number
}

/**
 * 续传请求被拒（缓冲过期 / 运行已结束 / 服务重启过）。
 *
 * 单独一种错误类型，是为了让调用方能把它和「真的出错了」区分开：
 * 前者应退回整轮重发，后者该照常报错。
 */
export class AgentResumeUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentResumeUnavailableError'
  }
}

/** Agent 连接状态：connecting（请求已发出）→ live（已收到首个事件）→ closed（流结束或出错）；
 *  stalled 由上层按「静默超时」判定，用于提示用户连接可能已中断 */
export type AgentConnectionState = 'connecting' | 'live' | 'stalled' | 'closed'

/** 断点续传的续传位置：上次运行的 runId + 已收到的最大 seq */
export interface AgentResumeCursor {
  runId: string
  lastSeq: number
}

export interface FetchAgentProcessParams {
  prompt: string
  systemMessage?: string
  /** 历史上下文（不含本轮 prompt），缺省为空 */
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>
  /** 会话 uuid：后端据此挂靠长期记忆摘要 */
  conversationId?: number
  signal?: AbortSignal
  /**
   * 断点续传（8.2）：带上它则不发新运行，而是请服务端补发 `lastSeq` 之后的事件。
   * 服务端拒绝时抛 AgentResumeUnavailableError，由上层决定是否整轮重发
   */
  resume?: AgentResumeCursor
  /** 每个 SSE 事件回调一次 */
  onEvent: (event: AgentEvent) => void
  /** 连接状态变化回调（用于上层做静默超时提示与手动重试） */
  onStateChange?: (state: AgentConnectionState) => void
  /** 本次运行的 runId（响应头 X-Agent-Run-Id）：审批决策凭它回传 */
  onRunId?: (runId: string) => void
}

/** 调用 /agent-process，SSE 逐帧解析并以回调方式暴露 */
export function fetchAgentProcess({ prompt, systemMessage, messages, conversationId, signal, resume, onEvent, onStateChange, onRunId }: FetchAgentProcessParams): Promise<void> {
  const authStore = useAuthStore()
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort)

  onStateChange?.('connecting')

  return fetch(`${import.meta.env.VITE_GLOB_API_URL}/agent-process`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authStore.token ? { Authorization: `Bearer ${authStore.token}` } : {}),
      // 续传标记：seq 只在单次运行内唯一，所以 runId 必须随行 —— 只凭 Last-Event-ID 定位不到是哪一次运行
      ...(resume ? { 'Last-Event-ID': String(resume.lastSeq), 'X-Agent-Run-Id': resume.runId } : {}),
    },
    body: JSON.stringify({ prompt, systemMessage, messages: messages ?? [], conversationId }),
    signal: controller.signal,
  })
    .then(async (response) => {
      // 走的是原生 fetch（不经过 axios），401 需在此单独处理：清 token + 回登录页
      if (response.status === 401) {
        authStore.handleUnauthorized()
        throw new Error('登录状态已过期，请重新登录')
      }

      // 409 = 服务端明确拒绝续传（缓冲过期 / 运行已结束 / 服务重启过）。
      // 单独抛类型化错误：上层据此退回「整轮重发」，而不是把它当成普通失败展示给用户
      if (resume && response.status === 409)
        throw new AgentResumeUnavailableError('续传不可用')

      if (!response.ok || !response.body)
        throw new Error(`Agent 请求失败：HTTP ${response.status}`)

      // 审批决策要凭 runId 走 /agent-approve 回传，必须在读流前先拿到并上报
      const runId = response.headers.get('X-Agent-Run-Id')
      if (runId)
        onRunId?.(runId)

      const reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''
      let live = false
      // 逐块读取，解析 SSE 的 data: 行
      while (true) {
        const { done, value } = await reader.read()
        if (done)
          break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:'))
            continue
          const payload = trimmed.slice(5).trim()
          if (!payload)
            continue
          // 只捕获 JSON.parse 的失败（半截帧等，解析不了属预期）。
          // 不把 onEvent 包进来：回调内的异常若被吞掉，会成为静默失败的根源
          let event: AgentEvent
          try {
            event = JSON.parse(payload) as AgentEvent
          }
          catch {
            // 忽略无法解析的帧
            continue
          }
          if (!live) {
            live = true
            onStateChange?.('live')
          }
          onEvent(event)
        }
      }
    })
    .catch((error) => {
      // 读流中断（网络抖动 / 服务端异常关闭）也走这里
      onStateChange?.('closed')
      throw error
    })
    .finally(() => {
      signal?.removeEventListener('abort', onAbort)
      onStateChange?.('closed')
    })
}

/**
 * 回传工具审批决策，唤醒 /agent-process 里挂起等待的循环。
 * SSE 是单向的，决策只能走这条独立请求；runId 来自 /agent-process 的 X-Agent-Run-Id 响应头
 */
export function fetchAgentApprove<T = { approved: boolean }>(runId: string, toolCallId: string, approved: boolean) {
  return post<T>({
    url: '/agent-approve',
    data: { runId, toolCallId, approved },
  })
}

/** 用量汇总里的总量 */
export interface UsageTotals {
  runs: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  durationMs: number
}

export interface UsageDailyRow extends UsageTotals {
  /** 本地日期 YYYY-MM-DD */
  date: string
}

export interface UsageConversationRow extends UsageTotals {
  conversationUuid: number | null
}

export interface UsageSummary {
  days: number
  total: UsageTotals
  daily: UsageDailyRow[]
  conversations: UsageConversationRow[]
}

/** 用量汇总（按天 + 按会话）。days 缺省 30，后端上限 365 */
export function fetchUsageSummary<T = UsageSummary>(days = 30) {
  return get<T>({
    url: '/usage/summary',
    data: { days },
  })
}
