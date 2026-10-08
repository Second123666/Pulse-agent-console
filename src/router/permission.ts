import type { Router } from 'vue-router'
import { useAuthStoreWithout } from '@/store/modules/auth'

/** 登录后的回跳目标：只接受站内路径，防开放重定向 */
function safeRedirect(value: unknown): string {
  const path = typeof value === 'string' ? value : ''
  return (path.startsWith('/') && !path.startsWith('//')) ? path : '/'
}

export function setupPageGuard(router: Router) {
  router.beforeEach(async (to, from, next) => {
    const authStore = useAuthStoreWithout()

    // 1) 后端可达性 + 模型信息（沿用原逻辑：/session 失败 → /500）。
    //    未登录也要查 —— 缺根 .env 时前端跳 /500 是既有的排障信号，
    //    若先判登录，故障时只会停在登录页，看不到「后端未启动」的明确提示。
    if (!authStore.session) {
      try {
        await authStore.getSession()
      }
      catch {
        if (to.path !== '/500') {
          next({ name: '500' })
          return
        }
      }
    }

    // 2) 已登录访问登录页 → 直接回工作台（或回跳原目标）
    if (to.name === 'Login') {
      if (authStore.token)
        next({ path: safeRedirect(to.query.redirect) })
      else
        next()
      return
    }

    // 3) 未登录 → 登录页，并记录来源路径供登录后回跳
    if (!authStore.token) {
      next({ name: 'Login', query: { redirect: to.fullPath } })
      return
    }

    // 4) 已登录但尚无用户信息（如刷新页面）：校验 token 并取回当前用户
    if (!authStore.user) {
      try {
        await authStore.getUserInfo()
      }
      catch (error: any) {
        if (error?.response?.status === 401) {
          // token 过期或伪造：清掉本地登录态，回登录页
          authStore.removeToken()
          next({ name: 'Login', query: { redirect: to.fullPath } })
          return
        }
        next({ name: '500' })
        return
      }
    }

    next()
  })
}
