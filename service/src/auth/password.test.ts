import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from './password'

describe('password', () => {
  it('正确密码校验通过，错误密码不通过', async () => {
    const { hash, salt } = await hashPassword('correct horse battery')

    await expect(verifyPassword('correct horse battery', hash, salt)).resolves.toBe(true)
    await expect(verifyPassword('wrong password', hash, salt)).resolves.toBe(false)
    await expect(verifyPassword('', hash, salt)).resolves.toBe(false)
  })

  it('同一密码两次哈希不同（随机盐）', async () => {
    const a = await hashPassword('same-password')
    const b = await hashPassword('same-password')

    expect(a.salt).not.toBe(b.salt)
    expect(a.hash).not.toBe(b.hash)
  })

  it('哈希与盐中不含明文', async () => {
    const plain = 'plain-text-should-not-appear'
    const { hash, salt } = await hashPassword(plain)

    expect(hash).not.toContain(plain)
    expect(salt).not.toContain(plain)
    expect(hash).toMatch(/^[0-9a-f]{128}$/)
    expect(salt).toMatch(/^[0-9a-f]{32}$/)
  })

  it('哈希被篡改或长度异常时不通过（且不抛错）', async () => {
    const { hash, salt } = await hashPassword('some-password')
    const tampered = `${hash.slice(0, -1)}${hash.endsWith('0') ? '1' : '0'}`

    await expect(verifyPassword('some-password', tampered, salt)).resolves.toBe(false)
    await expect(verifyPassword('some-password', 'abcd', salt)).resolves.toBe(false)
    await expect(verifyPassword('some-password', hash, 'wrong-salt')).resolves.toBe(false)
  })
})
