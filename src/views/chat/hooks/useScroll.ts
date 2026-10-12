import type { Ref } from 'vue'
import { nextTick } from 'vue'

/**
 * 滚动目标：虚拟列表实例（vueuc `VVirtualList`）的**最小接口**。
 * 只声明真正用到的两项能力，不把 vueuc 的类型细节铺到调用方
 */
export interface ScrollTarget {
  /** 列表内部真正的滚动元素 —— 判断「是否贴底」只能读它的 scrollTop / scrollHeight */
  listElRef: HTMLElement | null
  scrollTo: (options: { top?: number; index?: number; position?: 'top' | 'bottom' }) => void
}

interface ScrollReturn {
  scrollToBottom: () => Promise<void>
  scrollToTop: () => Promise<void>
  scrollToBottomIfAtBottom: () => Promise<void>
}

/** 贴底判定阈值：与底部的距离小于它就认为「用户仍在底部」，继续跟随 */
const BOTTOM_THRESHOLD = 100

/**
 * 消息列表的滚动语义（14.1 起由虚拟列表接管）。
 *
 * 与老实现（直接写 `scrollTop`）的关键区别：**滚动必须走虚拟列表的 `scrollTo`**。
 * 它的滚动高度是「已测量项的真实高度 + 未测量项的估算值」算出来的，
 * 外部直接改 `scrollTop` 会绕过它自己的位置推算（未渲染项一多就会对不上）。
 */
export function useScroll(target: Ref<ScrollTarget | null>): ScrollReturn {
  const scrollToBottom = async () => {
    await nextTick()
    target.value?.scrollTo({ position: 'bottom' })
    // 新消息/新一行的高度要等 ResizeObserver 回调后才进高度树（同帧内、绘制前），
    // 此刻「底部」是按估算值算的 —— 下一帧再贴一次才真正到底
    requestAnimationFrame(() => target.value?.scrollTo({ position: 'bottom' }))
  }

  const scrollToTop = async () => {
    await nextTick()
    target.value?.scrollTo({ position: 'top' })
  }

  const scrollToBottomIfAtBottom = async () => {
    await nextTick()
    const el = target.value?.listElRef
    if (!el)
      return
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distanceToBottom <= BOTTOM_THRESHOLD)
      target.value?.scrollTo({ position: 'bottom' })
  }

  return {
    scrollToBottom,
    scrollToTop,
    scrollToBottomIfAtBottom,
  }
}
