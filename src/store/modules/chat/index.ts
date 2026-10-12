import { ref } from 'vue'
import { defineStore } from 'pinia'
import { defaultState, getLocalState, setLocalState } from './helper'
import { router } from '@/router'
import { t } from '@/locales'
import type { ServerConversation, ServerMessage } from '@/api'
import { fetchConversationGet, fetchConversationList, fetchConversationSave } from '@/api'
import { useAuthStore } from '@/store/modules/auth'
import { MAX_ATTACHMENTS, MAX_META_IMAGE_CHARS, formatBytes } from '@/utils/image'

/** 后端同步防抖间隔（毫秒） */
const SERVER_SYNC_DEBOUNCE_MS = 1000

/**
 * 已完成服务端水合的**用户 id**（未水合为 null）。
 *
 * 刻意放在模块作用域而非 state —— 它绝不能持久化：若把「已水合」写进 localStorage，
 * 下次启动会在还没拉到服务端数据时就允许同步，用旧本地状态覆盖服务端，静默丢数据。
 *
 * 存 user id 而非布尔值：换账号登录时 id 不匹配会自动重新水合，
 * 避免把上一个账号的本地会话同步进新账号（跨账号串数据）。
 */
let hydratedUserId: number | null = null
let syncTimer: ReturnType<typeof setTimeout> | null = null

/** 当前登录用户是否已完成水合（未登录 / 换过账号 → false） */
function isHydratedForCurrentUser(): boolean {
  const authStore = useAuthStore()
  return !!authStore.token && authStore.user?.id !== undefined && authStore.user.id === hydratedUserId
}

/**
 * 图片附件按 `MAX_META_IMAGE_CHARS` 裁一刀，超限的那几张**只留文字占位**。
 *
 * 全量同步是整份状态原样推、`meta_json` 也是整条原样落库 —— 不在这里收口，
 * 一条带 6 张图的消息就能让同步 body 撞上后端 10mb 上限，**连纯文本消息一起保存失败**
 */
function clipImages(images: string[]): string[] {
  const out: string[] = []
  let used = 0
  for (const item of images) {
    if (typeof item !== 'string')
      continue
    if (used + item.length <= MAX_META_IMAGE_CHARS) {
      out.push(item)
      used += item.length
      continue
    }
    out.push(t('chat.imageOmitted', { size: formatBytes(item.length) }))
  }
  return out
}

/**
 * 14.1：消息的渲染 id 序号。
 *
 * 虚拟列表拿 `key` 当身份（高度缓存 `keyToHeightOffset` 按 key 记），用下标当 key 会在
 * 「删掉中间一条」之后让后面所有消息整体前移 —— 高度缓存认错人，滚动位置错乱。
 * 序号 + 时间戳足够在单次会话内唯一，不必上 uuid（这里每帧都可能分配，越便宜越好）
 */
let messageIdSeq = 0
function nextMessageId(): string {
  messageIdSeq += 1
  return `m${messageIdSeq}-${Date.now().toString(36)}`
}

/**
 * 整体替换消息（updateChatByUuid）时保住它的渲染 id。
 * 流式渲染每帧都走这条路径，丢了 id 等于每帧换 key —— 虚拟列表会把整条消息重挂载
 */
function keepMessageId(prev: Chat.Chat | undefined, next: Chat.Chat): Chat.Chat {
  return (prev?.id && !next.id) ? { ...next, id: prev.id } : next
}

/** 前端消息 → 服务端消息。loading / agentStalled 属瞬时态，不入库（否则刷新后永久转圈） */
function toServerMessage(item: Chat.Chat): ServerMessage {
  return {
    role: item.inversion ? 'user' : 'assistant',
    content: item.text ?? '',
    ...(item.agentSteps?.length ? { agentSteps: item.agentSteps } : {}),
    meta: {
      dateTime: item.dateTime,
      inversion: !!item.inversion,
      error: !!item.error,
      quote: item.quote ?? null,
      conversationOptions: item.conversationOptions ?? null,
      requestOptions: item.requestOptions,
      // 用量随消息落库：不存的话刷新后那行小字就消失了
      ...(item.usage ? { usage: item.usage } : {}),
      // 图片走 meta_json，content 仍是纯字符串（conversation/routes 的强校验不碰）
      ...((item.images?.length) ? { images: clipImages(item.images) } : {}),
    },
    // dateTime 是本地化字符串，Date.parse 不可靠，解析不出就退化为当前时间；
    // 消息顺序由数组下标保证，时间戳仅用于展示与排序
    createdAt: Date.parse(item.dateTime) || Date.now(),
  }
}

/** 服务端消息 → 前端消息 */
function toLocalMessage(message: ServerMessage): Chat.Chat {
  const meta = (message.meta ?? {}) as Record<string, any>
  return {
    dateTime: typeof meta.dateTime === 'string' ? meta.dateTime : new Date(message.createdAt).toLocaleString(),
    text: message.content,
    inversion: message.role === 'user',
    ...(meta.error ? { error: true } : {}),
    ...((typeof meta.quote === 'string' && meta.quote) ? { quote: meta.quote } : {}),
    ...((Array.isArray(message.agentSteps) && message.agentSteps.length) ? { agentSteps: message.agentSteps } : {}),
    ...(meta.usage ? { usage: meta.usage as Chat.AgentUsage } : {}),
    // meta 里的图片是外部数据：只认字符串数组，坏值直接丢，不让它把整条消息的水合搞崩
    ...((Array.isArray(meta.images) && meta.images.length)
      ? { images: meta.images.filter((item: unknown): item is string => typeof item === 'string').slice(0, MAX_ATTACHMENTS) }
      : {}),
    conversationOptions: meta.conversationOptions ?? null,
    requestOptions: meta.requestOptions ?? { prompt: message.content, options: null },
  }
}

/** 整份状态 → 服务端会话数组（与 localStorage 的全量写语义一致） */
function toServerConversations(state: Chat.ChatState): ServerConversation[] {
  return state.history.map((history) => {
    const data = state.chat.find(item => item.uuid === history.uuid)?.data ?? []
    const messages = data.map(toServerMessage)
    return {
      uuid: history.uuid,
      title: history.title,
      createdAt: messages[0]?.createdAt ?? Date.now(),
      updatedAt: messages[messages.length - 1]?.createdAt ?? Date.now(),
      messages,
    }
  })
}

/**
 * 「跳到某条消息并高亮」的一次性目标（9.5 会话搜索）。
 *
 * 刻意放在模块作用域而非 state —— 它是瞬时的 UI 意图，绝不能进 localStorage：
 * 持久化会让下次打开应用时凭空闪一下某条旧消息。
 *
 * 用 ref 而非普通变量，是因为目标通常在 Chat 视图**已经挂载之后**才被设置
 * （命令面板要先 `setActive` 切路由），视图得能 watch 到这次变化。
 */
export const pendingJumpTarget = ref<{ uuid: number; index: number } | null>(null)

/** 设置跳转目标（命令面板选中一条消息命中时调用） */
export function setPendingJump(uuid: number, index: number) {
  pendingJumpTarget.value = { uuid, index }
}

/** 清掉跳转目标（已定位，或重试到放弃时调用） */
export function clearPendingJump() {
  pendingJumpTarget.value = null
}

export const useChatStore = defineStore('chat-store', {
  state: (): Chat.ChatState => getLocalState(),

  getters: {
    getChatHistoryByCurrentActive(state: Chat.ChatState) {
      const index = state.history.findIndex(item => item.uuid === state.active)
      if (index !== -1)
        return state.history[index]
      return null
    },

    getChatByUuid(state: Chat.ChatState) {
      return (uuid?: number) => {
        if (uuid)
          return state.chat.find(item => item.uuid === uuid)?.data ?? []
        return state.chat.find(item => item.uuid === state.active)?.data ?? []
      }
    },
  },

  actions: {
    setUsingContext(context: boolean) {
      this.usingContext = context
      this.recordState()
    },

    addHistory(history: Chat.History, chatData: Chat.Chat[] = []) {
      this.history.unshift(history)
      this.chat.unshift({ uuid: history.uuid, data: chatData })
      this.active = history.uuid
      this.reloadRoute(history.uuid)
    },

    updateHistory(uuid: number, edit: Partial<Chat.History>) {
      const index = this.history.findIndex(item => item.uuid === uuid)
      if (index !== -1) {
        this.history[index] = { ...this.history[index], ...edit }
        this.recordState()
      }
    },

    async deleteHistory(index: number) {
      this.history.splice(index, 1)
      this.chat.splice(index, 1)

      if (this.history.length === 0) {
        this.active = null
        this.reloadRoute()
        return
      }

      if (index > 0 && index <= this.history.length) {
        const uuid = this.history[index - 1].uuid
        this.active = uuid
        this.reloadRoute(uuid)
        return
      }

      if (index === 0) {
        if (this.history.length > 0) {
          const uuid = this.history[0].uuid
          this.active = uuid
          this.reloadRoute(uuid)
        }
      }

      if (index > this.history.length) {
        const uuid = this.history[this.history.length - 1].uuid
        this.active = uuid
        this.reloadRoute(uuid)
      }
    },

    async setActive(uuid: number) {
      this.active = uuid
      return await this.reloadRoute(uuid)
    },

    getChatByUuidAndIndex(uuid: number, index: number) {
      if (!uuid || uuid === 0) {
        if (this.chat.length)
          return this.chat[0].data[index]
        return null
      }
      const chatIndex = this.chat.findIndex(item => item.uuid === uuid)
      if (chatIndex !== -1)
        return this.chat[chatIndex].data[index]
      return null
    },

    addChatByUuid(uuid: number, chat: Chat.Chat) {
      // 14.1：所有新消息在这里统一拿渲染 id（虚拟列表的 key），下面三处 push 都推它
      const message: Chat.Chat = chat.id ? chat : { ...chat, id: nextMessageId() }

      if (!uuid || uuid === 0) {
        if (this.history.length === 0) {
          const uuid = Date.now()
          this.history.push({ uuid, title: message.text, isEdit: false })
          this.chat.push({ uuid, data: [message] })
          this.active = uuid
          this.recordState()
        }
        else {
          this.chat[0].data.push(message)
          if (this.history[0].title === t('chat.newChatTitle'))
            this.history[0].title = message.text
          this.recordState()
        }
      }

      const index = this.chat.findIndex(item => item.uuid === uuid)
      if (index !== -1) {
        this.chat[index].data.push(message)
        if (this.history[index].title === t('chat.newChatTitle'))
          this.history[index].title = message.text
        this.recordState()
      }
    },

    updateChatByUuid(uuid: number, index: number, chat: Chat.Chat) {
      if (!uuid || uuid === 0) {
        if (this.chat.length) {
          this.chat[0].data[index] = keepMessageId(this.chat[0].data[index], chat)
          this.recordState()
        }
        return
      }

      const chatIndex = this.chat.findIndex(item => item.uuid === uuid)
      if (chatIndex !== -1) {
        this.chat[chatIndex].data[index] = keepMessageId(this.chat[chatIndex].data[index], chat)
        this.recordState()
      }
    },

    updateChatSomeByUuid(uuid: number, index: number, chat: Partial<Chat.Chat>) {
      if (!uuid || uuid === 0) {
        if (this.chat.length) {
          this.chat[0].data[index] = { ...this.chat[0].data[index], ...chat }
          this.recordState()
        }
        return
      }

      const chatIndex = this.chat.findIndex(item => item.uuid === uuid)
      if (chatIndex !== -1) {
        this.chat[chatIndex].data[index] = { ...this.chat[chatIndex].data[index], ...chat }
        this.recordState()
      }
    },

    deleteChatByUuid(uuid: number, index: number) {
      if (!uuid || uuid === 0) {
        if (this.chat.length) {
          this.chat[0].data.splice(index, 1)
          this.recordState()
        }
        return
      }

      const chatIndex = this.chat.findIndex(item => item.uuid === uuid)
      if (chatIndex !== -1) {
        this.chat[chatIndex].data.splice(index, 1)
        this.recordState()
      }
    },

    clearChatByUuid(uuid: number) {
      if (!uuid || uuid === 0) {
        if (this.chat.length) {
          this.chat[0].data = []
          this.recordState()
        }
        return
      }

      const index = this.chat.findIndex(item => item.uuid === uuid)
      if (index !== -1) {
        this.chat[index].data = []
        this.recordState()
      }
    },

    clearHistory() {
      this.$state = { ...defaultState() }
      this.recordState()
    },

    async reloadRoute(uuid?: number) {
      this.recordState()
      await router.push({ name: 'Chat', params: { uuid } })
    },

    recordState() {
      setLocalState(this.$state)
      this.scheduleServerSync()
    },

    /**
     * 防抖同步到后端：localStorage 仍是立即写（现有行为不变），服务端只是补一份。
     * 防抖同时消掉了流式渲染期间每 60ms 一次的全量写放大。
     */
    scheduleServerSync() {
      if (!isHydratedForCurrentUser())
        return
      if (syncTimer)
        clearTimeout(syncTimer)
      syncTimer = setTimeout(() => {
        syncTimer = null
        void this.syncToServer()
      }, SERVER_SYNC_DEBOUNCE_MS)
    },

    /** 全量推送当前会话状态；失败只告警不抛出 —— 后端不可用时降级为纯 localStorage */
    async syncToServer() {
      if (!isHydratedForCurrentUser())
        return
      try {
        await fetchConversationSave(toServerConversations(this.$state))
      }
      catch (error) {
        console.warn('[chat] 会话同步到后端失败，本次降级为本地存储：', error)
      }
    },

    /**
     * 启动时从后端加载会话（每个用户只做一次）。
     * - 服务端有数据 → 以服务端为准，整体替换本地状态
     * - 服务端为空   → 保留本地并整体上传（老用户首次升级的迁移路径）
     * - 请求失败     → 保持未水合，之后所有同步静默跳过，普通对话不受影响
     *
     * `preferredUuid` 传当前路由指向的会话：`Layout.vue` 挂载时会无条件把路由
     * replace 成 `active`，若这里不沿用路由，用户打开的旧会话会被顶掉。
     */
    async hydrateFromServer(preferredUuid?: number) {
      const authStore = useAuthStore()
      const userId = authStore.user?.id
      if (!authStore.token || userId === undefined || userId === hydratedUserId)
        return

      try {
        const listResult = await fetchConversationList()
        if (listResult.data.conversations.length === 0) {
          hydratedUserId = userId
          await this.syncToServer()
          return
        }

        const getResult = await fetchConversationGet()
        const conversations = getResult.data.conversations
        this.history = conversations.map(item => ({ uuid: item.uuid, title: item.title, isEdit: false }))
        // 14.1：水合出来的消息也补渲染 id（虚拟列表的 key 不能是下标）
        this.chat = conversations.map(item => ({
          uuid: item.uuid,
          data: item.messages.map(message => ({ ...toLocalMessage(message), id: nextMessageId() })),
        }))
        this.active = (preferredUuid !== undefined && this.history.some(item => item.uuid === preferredUuid))
          ? preferredUuid
          : (this.history[0]?.uuid ?? null)
        setLocalState(this.$state)
        hydratedUserId = userId
      }
      catch (error) {
        console.warn('[chat] 从后端加载会话失败，本次仅用本地存储：', error)
      }
    },

    /**
     * 退出登录时清理。
     * 仅当本账号的会话确已同步到服务端（hydratedUserId 有值）才清空本地 ——
     * 避免同一浏览器换账号登录时，上一账号的会话残留在本地被下一个账号看到；
     * 未同步过则保留本地数据，防止把只在本地存在的会话清没了。
     */
    resetForLogout() {
      if (hydratedUserId === null)
        return
      if (syncTimer) {
        clearTimeout(syncTimer)
        syncTimer = null
      }
      hydratedUserId = null
      this.$state = { ...defaultState() }
      setLocalState(this.$state)
    },
  },
})
