import { randomBytes } from 'node:crypto'
import { authConfig } from '../utils/config'

let resolved: string | undefined

/**
 * JWT 签名密钥解析。
 *
 * 优先取 .env 的 JWT_SECRET；未配置时生成**进程内临时随机密钥**并告警。
 * 绝不使用硬编码默认值 —— 那等同于没有鉴权（攻击者可直接伪造 token）。
 * 临时密钥的代价：服务重启后所有登录态失效，故仅作兜底。
 */
export function getJwtSecret(): string {
  if (resolved)
    return resolved

  if (authConfig.jwtSecret) {
    resolved = authConfig.jwtSecret
    return resolved
  }

  resolved = randomBytes(32).toString('hex')
  globalThis.console.warn('[auth] 未配置 JWT_SECRET，已生成进程内临时密钥：服务重启后所有登录态失效。请在 service/.env 中配置 JWT_SECRET。')
  return resolved
}
