import { createHmac } from 'node:crypto'
import { safeEqual } from '../utils/safeEqual'

export interface JwtPayload {
  /** 用户 id 的字符串形式（遵循 JWT sub 惯例） */
  sub: string
  /** 用户名 */
  name: string
  /** 角色：admin | user */
  role: string
  /** 签发时间（秒） */
  iat: number
  /** 过期时间（秒） */
  exp: number
}

/** 签发时传入的业务载荷（iat / exp 由 signToken 生成） */
export type JwtClaims = Omit<JwtPayload, 'iat' | 'exp'>

const HEADER = { alg: 'HS256', typ: 'JWT' }

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decodeJson(segment: string): any {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
  }
  catch {
    return undefined
  }
}

function signature(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url')
}

/** 签发 HS256 JWT（手写实现，约 40 行，避免为此引入 jsonwebtoken 依赖） */
export function signToken(claims: JwtClaims, secret: string, ttlSeconds: number): string {
  const now = Math.floor(Date.now() / 1000)
  const payload: JwtPayload = { ...claims, iat: now, exp: now + ttlSeconds }
  const data = `${encodeJson(HEADER)}.${encodeJson(payload)}`
  return `${data}.${signature(data, secret)}`
}

/**
 * 校验 JWT：任何不合法一律返回 null（由调用方决定 401）。
 *
 * 防御的攻击面：
 * - 篡改签名 / 篡改载荷 → HMAC 校验不过
 * - 算法混淆（alg:none 或换成其他算法）→ **先**校验 header.alg 必须是 HS256
 * - 过期 → exp 检查
 * - 用其他密钥签发 → HMAC 校验不过
 */
export function verifyToken(token: string, secret: string): JwtPayload | null {
  const parts = token.split('.')
  if (parts.length !== 3)
    return null

  const [headerSegment, payloadSegment, signatureSegment] = parts

  const header = decodeJson(headerSegment)
  // 算法混淆防护：只认 HS256。必须在验签之前判断，否则 alg:none 会绕过验签
  if (header?.alg !== 'HS256')
    return null

  if (!safeEqual(signature(`${headerSegment}.${payloadSegment}`, secret), signatureSegment))
    return null

  const payload = decodeJson(payloadSegment)
  if (!payload || typeof payload.sub !== 'string' || typeof payload.exp !== 'number')
    return null

  // exp 为秒级时间戳
  if (payload.exp * 1000 <= Date.now())
    return null

  return payload as JwtPayload
}
