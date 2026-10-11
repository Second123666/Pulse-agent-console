import { ss } from '@/utils/storage'
import { t } from '@/locales'

const LOCAL_NAME = 'chatStorage'

export function defaultState(): Chat.ChatState {
  const uuid = 1002
  return {
    active: uuid,
    usingContext: true,
    history: [{ uuid, title: t('chat.newChatTitle'), isEdit: false }],
    chat: [{ uuid, data: [] }],
  }
}

export function getLocalState(): Chat.ChatState {
  const localState = ss.get(LOCAL_NAME)
  return { ...defaultState(), ...localState }
}

/**
 * 剥掉图片再落 localStorage。
 *
 * 两个硬理由，缺一个都会出事：
 * 1. `localStorage` 配额只有 5MB，而 `ss.set` 写失败时**整份会话状态都不再持久化**（只在内存里活着）
 * 2. `recordState()` 在流式渲染期间每帧都调，`setLocalState` 是**全量 JSON.stringify** ——
 *    把几 MB 的 base64 挂进 `$state`，等于每个 SSE 帧都序列化几 MB
 *
 * 图片的持久层是服务端（`meta.images`），刷新后 `hydrateFromServer` 会补回来；
 * 本地这份只是启动前的引导缓存，没有图片不影响文字会话照常可用
 */
function withoutImages(state: Chat.ChatState): Chat.ChatState {
  const hasImages = state.chat.some(item => item.data.some(message => message.images?.length))
  if (!hasImages)
    return state

  return {
    ...state,
    chat: state.chat.map(item => ({
      ...item,
      data: item.data.map((message) => {
        if (!message.images?.length)
          return message
        const next = { ...message }
        delete next.images
        return next
      }),
    })),
  }
}

export function setLocalState(state: Chat.ChatState) {
  ss.set(LOCAL_NAME, withoutImages(state))
}
