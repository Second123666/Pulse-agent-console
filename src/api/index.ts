import type { AxiosProgressEvent, GenericAbortSignal } from 'axios'
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

export function fetchChatAPIProcess<T = any>(
  params: {
    prompt: string
    options?: { conversationId?: string; parentMessageId?: string }
    signal?: GenericAbortSignal
    onDownloadProgress?: (progressEvent: AxiosProgressEvent) => void },
) {
  const settingStore = useSettingStore()
  const authStore = useAuthStore()

  let data: Record<string, any> = {
    prompt: params.prompt,
    options: params.options,
  }

  if (authStore.isAPIModel) {
    data = {
      ...data,
      systemMessage: settingStore.systemMessage,
      temperature: settingStore.temperature,
      top_p: settingStore.top_p,
    }
  }

  return post<T>({
    url: '/chat-process',
    data,
    signal: params.signal,
    onDownloadProgress: params.onDownloadProgress,
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

/** Agent 模式 SSE 事件（与后端 /agent-process 推送格式对应） */
export interface AgentEvent {
  type: 'thought' | 'text_delta' | 'tool_call' | 'tool_result' | 'answer' | 'error'
  content?: string
  id?: string
  name?: string
  arguments?: string
  message?: string
}

/** Agent 连接状态：connecting（请求已发出）→ live（已收到首个事件）→ closed（流结束或出错）；
 *  stalled 由上层按「静默超时」判定，用于提示用户连接可能已中断 */
export type AgentConnectionState = 'connecting' | 'live' | 'stalled' | 'closed'

export interface FetchAgentProcessParams {
  prompt: string
  systemMessage?: string
  /** 历史上下文（不含本轮 prompt），缺省为空 */
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>
  signal?: AbortSignal
  /** 每个 SSE 事件回调一次 */
  onEvent: (event: AgentEvent) => void
  /** 连接状态变化回调（用于上层做静默超时提示与手动重试） */
  onStateChange?: (state: AgentConnectionState) => void
}

/** 调用 /agent-process，SSE 逐帧解析并以回调方式暴露 */
export function fetchAgentProcess({ prompt, systemMessage, messages, signal, onEvent, onStateChange }: FetchAgentProcessParams): Promise<void> {
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
    },
    body: JSON.stringify({ prompt, systemMessage, messages: messages ?? [] }),
    signal: controller.signal,
  })
    .then(async (response) => {
      // 走的是原生 fetch（不经过 axios），401 需在此单独处理：清 token + 回登录页
      if (response.status === 401) {
        authStore.handleUnauthorized()
        throw new Error('登录状态已过期，请重新登录')
      }

      if (!response.ok || !response.body)
        throw new Error(`Agent 请求失败：HTTP ${response.status}`)

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
