import axios, { type AxiosResponse } from 'axios'
import { useAuthStore } from '@/store'

const service = axios.create({
  baseURL: import.meta.env.VITE_GLOB_API_URL,
})

service.interceptors.request.use(
  (config) => {
    const token = useAuthStore().token
    if (token)
      config.headers.Authorization = `Bearer ${token}`
    return config
  },
  (error) => {
    return Promise.reject(error.response)
  },
)

service.interceptors.response.use(
  (response: AxiosResponse): AxiosResponse => {
    // 2xx 一律算成功（axios 的 validateStatus 默认也认 2xx）。早先这里写死
    // `status === 200`，于是按 HTTP 语义返回 **201 Created** 的注册接口被当成
    // 失败抛出去 —— 用户只看到一个光秃秃的 "201" 提示，token 也拿不到，
    // 注册完不会自动登录（见 store/modules/auth 的 register）。
    if (response.status >= 200 && response.status < 300)
      return response

    throw new Error(`HTTP ${response.status}`)
  },
  (error) => {
    // 401 统一处理：登录态失效 → 清 token + 跳登录页（区别于 403 无权限）
    // /auth/* 自身的 401 例外（如登录密码错误），交给页面展示提示
    const status = error?.response?.status
    const url = String(error?.config?.url ?? '')
    if (status === 401 && !url.startsWith('/auth/')) {
      const authStore = useAuthStore()
      if (authStore.token)
        authStore.handleUnauthorized()
    }

    return Promise.reject(error)
  },
)

export default service
