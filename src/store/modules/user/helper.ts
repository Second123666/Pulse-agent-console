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
  /**
   * 当前这份偏好属于哪个账号；null = 未登录 / 守卫还没拉到 user。
   * **不持久化**（只有 userInfo 落盘，见 setLocalState）。
   */
  userId: number | null
}

export function defaultUserInfo(): UserInfo {
  return {
    // 用 import 而不是写死 '/src/assets/...'：后者只在 dev server 下能解析，
    // 生产构建里那个路径根本不存在，头像会 404
    avatar: secondAvatar,
    // 空 = 「用户没自定义过昵称」，显示层回落到当前账号的用户名（见 UserAvatar）。
    // 这里**不能**写死一个名字：本应用是多账号的，写死会让每个新用户都顶着
    // 同一个名字（上游遗留的就是 'Second'，登录后也没有任何代码去覆盖它）
    name: '',
    description: '',
  }
}

export function defaultSetting(): UserState {
  return { userInfo: defaultUserInfo(), userId: null }
}

/**
 * 落盘结构是**一个账号一份**：键是 user id，值是该账号的显示偏好。
 *
 * 早先这里存的是单份全局对象 —— 在 A 账号的设置面板改过昵称，B、C 账号登录后
 * 看到的都是同一个昵称。本应用是多账号的，那等于把一个人的显示偏好强加给所有人
 * （用户实测：建了 xiaoming / test1，左下角还是上一个人留下的 "test"）。
 */
type StoredPrefs = Record<string, UserInfo>

function readAll(): StoredPrefs {
  const raw = ss.get(LOCAL_NAME)

  if (!raw || typeof raw !== 'object')
    return {}

  // 旧格式（单份、没分账号）没法判断属于谁，直接丢弃并清掉 —— 它正是串号的根源
  if ('userInfo' in raw) {
    ss.remove(LOCAL_NAME)
    return {}
  }

  return raw as StoredPrefs
}

/** 取某个账号的显示偏好；账号未知时给默认值 */
export function getLocalState(userId?: number | null): UserState {
  if (userId == null)
    return defaultSetting()

  const prefs = readAll()[String(userId)]
  return { userInfo: { ...defaultUserInfo(), ...prefs }, userId }
}

export function setLocalState(userId: number, userInfo: UserInfo): void {
  const all = readAll()
  all[String(userId)] = userInfo
  ss.set(LOCAL_NAME, all)
}
