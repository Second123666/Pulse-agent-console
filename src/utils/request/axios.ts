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
    if (response.status === 200)
      return response

    throw new Error(response.status.toString())
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
