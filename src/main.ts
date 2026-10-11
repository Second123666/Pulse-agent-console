import { createApp } from 'vue'
import App from './App.vue'
import { setupI18n } from './locales'
import { setupAssets, setupScrollbarStyle } from './plugins'
import { setupStore } from './store'
import { setupRouter } from './router'

/**
 * 清理已移除模块留下的 localStorage 残留。
 *
 * 提示词仓库在 v3 10.3 被整体删除，但老用户浏览器里还留着它的数据（键 `promptStore`）。
 * `removeItem` 对不存在的键是空操作，所以每次启动无脑跑一遍即可 ——
 * 不需要额外的「迁移已执行」标记，也就不会有标记与实际状态不一致的问题。
 *
 * 等确认没有存量用户后可以删掉这段（留个记号：2026-10-11 移除）。
 */
function cleanupRemovedStores() {
  window.localStorage.removeItem('promptStore')
}

async function bootstrap() {
  const app = createApp(App)
  setupAssets()

  setupScrollbarStyle()

  cleanupRemovedStores()

  setupStore(app)

  setupI18n(app)

  await setupRouter(app)

  app.mount('#app')
}

bootstrap()
