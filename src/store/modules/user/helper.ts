import secondAvatar from '@/assets/second.jpg'
import { ss } from '@/utils/storage'

const LOCAL_NAME = 'userStorage'

export interface UserInfo {
  avatar: string
  name: string
  description: string
}

export interface UserState {
  userInfo: UserInfo
}

export function defaultSetting(): UserState {
  return {
    userInfo: {
      // 用 import 而不是写死 '/src/assets/...'：后者只在 dev server 下能解析，
      // 生产构建里那个路径根本不存在，头像会 404
      avatar: secondAvatar,
      // 空 = 「用户没自定义过昵称」，显示层回落到当前账号的用户名（见 UserAvatar）。
      // 这里**不能**写死一个名字：本应用是多账号的，写死会让每个新用户都顶着
      // 同一个名字（上游遗留的就是 'Second'，登录后也没有任何代码去覆盖它）
      name: '',
      description: '',
    },
  }
}

export function getLocalState(): UserState {
  const localSetting: UserState | undefined = ss.get(LOCAL_NAME)
  return { ...defaultSetting(), ...localSetting }
}

export function setLocalState(setting: UserState): void {
  ss.set(LOCAL_NAME, setting)
}
