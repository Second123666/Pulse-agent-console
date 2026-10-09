import type { Router } from 'vue-router'
import { useAuthStoreWithout } from '@/store/modules/auth'
import { useChatStore } from '@/store/modules/chat'

/** 登录后的回跳目标：只接受站内路径，防开放重定向 */
function safeRedirect(value: unknown): string {
  const path = typeof value === 'string' ? value : ''
  return (path.startsWith('/') && !path.startsWith('//')) ? path : '/'
}

export function setupPageGuard(router: Router) {
  router.beforeEach(async (to, from, next) => {
    const authStore = useAuthStoreWithout()

    // 出错统一跳 /500；**已在 /500 则放行** —— 否则守卫每次进入 /500 都再跳一次 /500，
    // vue-router 会判定「无限重定向」并中止导航（页面直接卡死，控制台刷屏）
    const toError = () => {
      if (to.path === '/500')
        next()
      else
        next({ name: '500' })
    }

    // 1) 后端可达性 + 模型信息（沿用原逻辑：/session 失败 → /500）。
    //    未登录也要查 —— 缺根 .env 时前端跳 /500 是既有的排障信号，
    //    若先判登录，故障时只会停在登录页，看不到「后端未启动」的明确提示。
    if (!authStore.session) {
      try {
        await authStore.getSession()
      }
      catch {
        toError()
        return
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
          // token 过期或伪造（如后端换了 JWT_SECRET）：清掉本地登录态，回登录页
          authStore.removeToken()
          next({ name: 'Login', query: { redirect: to.fullPath } })
          return
        }
        toError()
        return
      }
    }

    // 5) 会话持久化：登录后从后端加载会话（服务端有数据则以服务端为准）。
    //    放在守卫里而不是组件里 —— 水合会整体替换会话列表，必须在 Chat 视图
    //    读取 route.params.uuid 之前完成，否则会先渲染出错误的空会话
    const chatStore = useChatStore()
    const routeUuid = to.name === 'Chat' ? Number(to.params.uuid) : undefined
    await chatStore.hydrateFromServer(Number.isInteger(routeUuid) ? routeUuid : undefined)

    // 水合后原路由指向的会话可能已不存在（如本地新建但服务端没有），回退到最近一条
    if (to.name === 'Chat' && chatStore.history.length > 0) {
      const requested = Number(to.params.uuid)
      if (!chatStore.history.some(item => item.uuid === requested)) {
        next({ name: 'Chat', params: { uuid: chatStore.history[0].uuid } })
        return
      }
    }

    next()
  })
}
