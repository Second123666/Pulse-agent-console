import { timingSafeEqual } from 'node:crypto'

/**
 * 定长安全比较（防时序侧信道）。
 *
 * 长度不同直接返回 false —— 长度本身不是秘密，而 timingSafeEqual 对不等长
 * 输入会抛错，必须先拦截。
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length)
    return false
  return timingSafeEqual(bufA, bufB)
}
