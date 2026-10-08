import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { signToken, verifyToken } from './jwt'

const SECRET = 'test-secret'
const CLAIMS = { sub: '1', name: 'alice', role: 'admin' }

/** 手工构造 token（模拟攻击者）：可产出正常签发路径不会出现的形态 */
function forge(payload: any, secret: string, alg = 'HS256'): string {
  const header = Buffer.from(JSON.stringify({ alg, typ: 'JWT' }), 'utf8').toString('base64url')
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')
  return `${header}.${body}.${sig}`
}

describe('jwt', () => {
  it('签发后可验证并还原载荷', () => {
    const token = signToken(CLAIMS, SECRET, 3600)
    const payload = verifyToken(token, SECRET)

    expect(payload).toMatchObject(CLAIMS)
    expect(payload!.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))
    expect(payload!.iat).toBeLessThanOrEqual(Math.floor(Date.now() / 1000))
  })

  it('拒绝被篡改的签名', () => {
    const token = signToken(CLAIMS, SECRET, 3600)
    const [header, payload, sig] = token.split('.')
    // 改动签名最后一个字符（保持长度不变）
    const forgedSig = `${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`

    expect(verifyToken(`${header}.${payload}.${forgedSig}`, SECRET)).toBeNull()
  })

  it('拒绝被篡改的载荷（沿用原签名）', () => {
    const token = signToken(CLAIMS, SECRET, 3600)
    const [header, , sig] = token.split('.')
    const evil = Buffer.from(
      JSON.stringify({ ...CLAIMS, sub: '2', role: 'admin', iat: 0, exp: 9999999999 }),
      'utf8',
    ).toString('base64url')

    expect(verifyToken(`${header}.${evil}.${sig}`, SECRET)).toBeNull()
  })

  it('拒绝已过期的 token', () => {
    // ttl 为负 → exp 已过
    expect(verifyToken(signToken(CLAIMS, SECRET, -1), SECRET)).toBeNull()
    expect(verifyToken(forge({ ...CLAIMS, iat: 0, exp: 1 }, SECRET), SECRET)).toBeNull()
  })

  it('拒绝算法混淆攻击 alg:none（空签名）', () => {
    const token = forge({ ...CLAIMS, iat: 0, exp: 9999999999 }, SECRET, 'none')
    const [header, payload] = token.split('.')

    expect(verifyToken(`${header}.${payload}.`, SECRET)).toBeNull()
  })

  it('拒绝算法混淆攻击 alg:none（即便签名本身正确）', () => {
    // 攻击者把 header 改成 alg:none 并用真实密钥签名 —— 仍必须拒绝
    const token = forge({ ...CLAIMS, iat: 0, exp: 9999999999 }, SECRET, 'none')
    expect(verifyToken(token, SECRET)).toBeNull()
  })

  it('拒绝大小写变形的算法名（hs256）', () => {
    const token = forge({ ...CLAIMS, iat: 0, exp: 9999999999 }, SECRET, 'hs256')
    expect(verifyToken(token, SECRET)).toBeNull()
  })

  it('拒绝用其它密钥签发的 token', () => {
    expect(verifyToken(signToken(CLAIMS, 'other-secret', 3600), SECRET)).toBeNull()
  })

  it('拒绝缺少 exp / sub 的载荷', () => {
    expect(verifyToken(forge({ ...CLAIMS, iat: 0 }, SECRET), SECRET)).toBeNull()
    expect(verifyToken(forge({ name: 'alice', iat: 0, exp: 9999999999 }, SECRET), SECRET)).toBeNull()
  })

  it('拒绝格式非法的 token', () => {
    expect(verifyToken('', SECRET)).toBeNull()
    expect(verifyToken('not-a-token', SECRET)).toBeNull()
    expect(verifyToken('a.b', SECRET)).toBeNull()
    expect(verifyToken('a.b.c.d', SECRET)).toBeNull()
    expect(verifyToken('a.b.c', SECRET)).toBeNull()
  })
})
