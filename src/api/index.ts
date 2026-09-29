import type { AxiosProgressEvent, GenericAbortSignal } from 'axios'
import { post } from '@/utils/request'
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

/** Agent 模式 SSE 事件（与后端 /agent-process 推送格式对应） */
export interface AgentEvent {
  type: 'thought' | 'text_delta' | 'tool_call' | 'tool_result' | 'answer' | 'error'
  content?: string
  id?: string
  name?: string
  arguments?: string
  message?: string
}

export interface FetchAgentProcessParams {
  prompt: string
  systemMessage?: string
  /** 历史上下文（不含本轮 prompt），缺省为空 */
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>
  signal?: AbortSignal
  /** 每个 SSE 事件回调一次 */
  onEvent: (event: AgentEvent) => void
}

/** 调用 /agent-process，SSE 逐帧解析并以回调方式暴露 */
export function fetchAgentProcess({ prompt, systemMessage, messages, signal, onEvent }: FetchAgentProcessParams): Promise<void> {
  const authStore = useAuthStore()
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort)

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
      if (!response.ok || !response.body)
        throw new Error(`Agent 请求失败：HTTP ${response.status}`)

      const reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''
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
          try {
            onEvent(JSON.parse(payload) as AgentEvent)
          }
          catch {
            // 忽略无法解析的帧
          }
        }
      }
    })
    .finally(() => {
      signal?.removeEventListener('abort', onAbort)
    })
}
