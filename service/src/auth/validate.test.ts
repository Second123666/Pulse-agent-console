import { describe, expect, it } from 'vitest'
import { validateInvite, validatePassword, validateUsername } from './validate'

describe('validateUsername', () => {
  it('接受合法用户名', () => {
    expect(validateUsername('alice')).toBeNull()
    expect(validateUsername('a_b-1')).toBeNull()
    expect(validateUsername('ab')).toBeNull()
    expect(validateUsername('a'.repeat(32))).toBeNull()
  })

  it('拒绝非法用户名', () => {
    expect(validateUsername('a')).not.toBeNull() // 过短
    expect(validateUsername('a'.repeat(33))).not.toBeNull() // 过长
    expect(validateUsername('has space')).not.toBeNull()
    expect(validateUsername('中文用户名')).not.toBeNull()
    expect(validateUsername('')).not.toBeNull()
    expect(validateUsername(123)).not.toBeNull()
    expect(validateUsername(undefined)).not.toBeNull()
  })
})

describe('validatePassword', () => {
  it('接受 8-128 位密码', () => {
    expect(validatePassword('12345678')).toBeNull()
    expect(validatePassword('x'.repeat(128))).toBeNull()
  })

  it('拒绝过短 / 过长 / 非字符串', () => {
    expect(validatePassword('1234567')).not.toBeNull()
    expect(validatePassword('x'.repeat(129))).not.toBeNull()
    expect(validatePassword(12345678)).not.toBeNull()
    expect(validatePassword(undefined)).not.toBeNull()
  })
})

describe('validateInvite', () => {
  it('未配置邀请码时开放注册', () => {
    expect(validateInvite(undefined, '')).toBeNull()
    expect(validateInvite('anything', '')).toBeNull()
  })

  it('配置邀请码后必须携带且匹配', () => {
    expect(validateInvite('invite-code', 'invite-code')).toBeNull()
    expect(validateInvite('wrong', 'invite-code')).not.toBeNull()
    expect(validateInvite(undefined, 'invite-code')).not.toBeNull()
    expect(validateInvite('invite-code-longer', 'invite-code')).not.toBeNull()
  })
})
