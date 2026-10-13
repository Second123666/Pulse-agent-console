import { defineStore } from 'pinia'
import type { UserInfo, UserState } from './helper'
import { defaultSetting, defaultUserInfo, getLocalState, setLocalState } from './helper'

export const useUserStore = defineStore('user-store', {
  // 账号未知（未登录 / 刷新后守卫还没拉到 user）时先给默认值；
  // 身份就位后由 loadForUser 换成该账号自己的那份
  state: (): UserState => defaultSetting(),

  actions: {
    /** 身份变化时调用（登录 / 注册 / 刷新后拿到 user）：切到该账号自己的显示偏好 */
    loadForUser(userId: number) {
      this.userId = userId
      this.userInfo = getLocalState(userId).userInfo
    },

    /** 退出登录：清空当前账号的偏好，别让下一个登录的人看到上一个人的昵称 */
    clearForLogout() {
      this.userId = null
      this.userInfo = defaultUserInfo()
    },

    updateUserInfo(userInfo: Partial<UserInfo>) {
      this.userInfo = { ...this.userInfo, ...userInfo }
      this.recordState()
    },

    resetUserInfo() {
      this.userInfo = defaultUserInfo()
      this.recordState()
    },

    /** 账号未知时不写盘 —— 否则会把默认值当成某个账号的偏好存下来 */
    recordState() {
      if (this.userId == null)
        return
      setLocalState(this.userId, this.userInfo)
    },
  },
})
