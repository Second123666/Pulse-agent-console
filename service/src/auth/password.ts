import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt) as (password: string, salt: string, keylen: number) => Promise<Buffer>

/** scrypt 派生密钥长度（字节） */
const KEY_LENGTH = 64
/** 随机盐长度（字节） */
const SALT_LENGTH = 16

export interface PasswordHash {
  /** scrypt 派生结果的 hex 表示 */
  hash: string
  /** 随机盐的 hex 表示，与用户一一对应（防彩虹表） */
  salt: string
}

/**
 * 生成密码哈希（Node 内置 scrypt，零依赖）。
 * 不使用 crypto-js：那是前端摘要库，不是密码学 KDF。
 */
export async function hashPassword(plain: string): Promise<PasswordHash> {
  const salt = randomBytes(SALT_LENGTH).toString('hex')
  const derived = await scryptAsync(plain, salt, KEY_LENGTH)
  return { hash: derived.toString('hex'), salt }
}

/** 校验密码：用同一 salt 重新派生后定长比较，避免逐字符短路泄露 */
export async function verifyPassword(plain: string, hash: string, salt: string): Promise<boolean> {
  const derived = await scryptAsync(plain, salt, KEY_LENGTH)
  const stored = Buffer.from(hash, 'hex')
  if (stored.length !== derived.length)
    return false
  return timingSafeEqual(stored, derived)
}
