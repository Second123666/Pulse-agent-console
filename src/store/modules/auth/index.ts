import { defineStore } from 'pinia'
import { getToken, removeToken, setToken } from './helper'
import type { AuthSessionPayload, AuthUser } from '@/api'
import { store } from '@/store/helper'
import { useChatStore } from '@/store/modules/chat'
import { useUserStore } from '@/store/modules/user'
import { fetchLogin, fetchMe, fetchRegister, fetchSession } from '@/api'

/**
 * 身份变化时同步「显示偏好」的归属账号。
 *
 * 显示偏好（头像 / 昵称 / 简介，见 store/modules/user）在本地是**按账号分份存的**，
 * 所以身份一变就得切份 —— 否则 A 账号设过的昵称会跟着 B 账号显示出来。
 * 三处写入点（登录 / 注册 / 刷新后 /auth/me）都必须经过这里。
 */
function syncUserPrefs(user: AuthUser | null) {
  const userStore = useUserStore()
  if (user)
    userStore.loadForUser(user.id)
  else
    userStore.clearForLogout()
}

interface SessionResponse {
  auth: boolean
  model: string
}

export type { AuthUser }

export interface AuthState {
  token: string | undefined
  session: SessionResponse | null
  /** 当前登录用户（来自 /auth/login 响应或 /auth/me，刷新后重新拉取） */
  user: AuthUser | null
}

export const useAuthStore = defineStore('auth-store', {
  state: (): AuthState => ({
    token: getToken(),
    session: null,
    user: null,
  }),

  getters: {
    isAPIModel(state): boolean {
      return !!state.session?.model
    },

    /** 后端是否要求注册邀请码（配置了 AUTH_SECRET_KEY 时为 true） */
    needInviteCode(state): boolean {
      return !!state.session?.auth
    },

    isLoggedIn(state): boolean {
      return !!state.token
    },
  },

  actions: {
    async getSession() {
      try {
        const { data } = await fetchSession<SessionResponse>()
        this.session = { ...data }
        return Promise.resolve(data)
      }
      catch (error) {
        return Promise.reject(error)
      }
    },

    setToken(token: string) {
      this.token = token
      setToken(token)
    },

    removeToken() {
      this.token = undefined
      removeToken()
    },

    /** 登录：成功后写入 token 与用户信息 */
    async login(username: string, password: string) {
      const { data } = await fetchLogin<AuthSessionPayload>(username, password)
      this.setToken(data.token)
      this.user = data.user
      syncUserPrefs(data.user)
      return data.user
    },

    /** 注册：首个注册用户成为管理员；后端要求邀请码时必须携带 */
    async register(username: string, password: string, inviteCode?: string) {
      const { data } = await fetchRegister<AuthSessionPayload>(username, password, inviteCode)
      this.setToken(data.token)
      this.user = data.user
      syncUserPrefs(data.user)
      return data.user
    },

    /** 拉取当前登录用户 —— 兼作 token 有效性校验（过期/伪造 → 401） */
    async getUserInfo() {
      const { data } = await fetchMe<{ user: AuthUser }>()
      this.user = data.user
      syncUserPrefs(data.user)
      return data.user
    },

    /** 退出登录：JWT 无状态，清掉本地登录态即可 */
    logout() {
      // 同时复位会话同步状态：否则同一浏览器换账号登录时，
      // 会把上一个账号的本地会话同步进新账号（跨账号串数据）
      useChatStore().resetForLogout()
      this.removeToken()
      this.user = null
      syncUserPrefs(null)
    },

    /**
     * 401 统一处理：清 token + 跳登录页（区别于 403 无权限，后者由调用方自行处理）。
     *
     * 用整页跳转而非 router.push：axios 拦截器引用 router 会形成循环依赖，
     * 且登录态失效本就该整页重置（与 utils/request 里既有的 reload 做法一致）。
     */
    handleUnauthorized() {
      this.logout()

      const { pathname, search, hash } = window.location
      if (pathname === '/login')
        return

      const redirect = encodeURIComponent(`${pathname}${search}${hash}`)
      window.location.href = `/login?redirect=${redirect}`
    },
  },
})

export function useAuthStoreWithout() {
  return useAuthStore(store)
}
