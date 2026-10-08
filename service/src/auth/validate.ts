import { safeEqual } from '../utils/safeEqual'

/** 用户名规则：2-32 位字母/数字/下划线/连字符（限 ASCII，避免 Unicode 同形字混淆） */
export const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{2,32}$/

export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 128

/** 校验用户名；通过返回 null，否则返回错误信息 */
export function validateUsername(username: unknown): string | null {
  if (typeof username !== 'string' || !USERNAME_PATTERN.test(username))
    return '用户名需为 2-32 位字母、数字、下划线或连字符'
  return null
}

/** 校验密码；通过返回 null，否则返回错误信息 */
export function validatePassword(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH)
    return `密码长度需为 ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} 位`
  return null
}

/**
 * 校验注册邀请码（即原 AUTH_SECRET_KEY，语义已降级）。
 * 未配置邀请码 → 开放注册；配置后 → 必须携带且定长比较匹配。
 */
export function validateInvite(inviteCode: unknown, expected: string): string | null {
  if (!expected)
    return null
  if (typeof inviteCode !== 'string' || !safeEqual(inviteCode, expected))
    return '邀请码无效'
  return null
}
