import { ref } from 'vue'

/**
 * 命令面板的开关状态（9.6 可见入口）。
 *
 * 放在模块作用域而非面板组件内部，是为了让**侧边栏的「搜索」入口**也能开它 ——
 * 面板此前只有 Ctrl+K 一个入口，不按快捷键就永远发现不了。
 *
 * **刻意不进 localStorage**：与 9.5 的 pendingJumpTarget 同理，这是瞬时的 UI 意图，
 * 持久化会让下次打开应用凭空弹出一个面板。
 *
 * 这里只翻 ref，收尾（清关键字、清检索结果、聚焦输入框）由面板自己 watch 完成 ——
 * 于是快捷键、侧边栏按钮、遮罩点击三条路径走的是同一套语义，不会各漏一半。
 */
export const commandPaletteVisible = ref(false)

/** 打开命令面板（侧边栏的搜索入口调用） */
export function openCommandPalette() {
  commandPaletteVisible.value = true
}
