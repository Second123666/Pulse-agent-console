import { getDb } from '../store/db'
import { hashPassword, verifyPassword } from './password'

export type UserRole = 'admin' | 'user'

/** users 表行结构 */
export interface UserRow {
  id: number
  username: string
  password_hash: string
  salt: string
  role: UserRole
  created_at: number
}

/** 对外暴露的用户信息（绝不含 password_hash / salt） */
export interface PublicUser {
  id: number
  username: string
  role: UserRole
}

export class DuplicateUsernameError extends Error {
  constructor(username: string) {
    super(`用户名已存在：${username}`)
    this.name = 'DuplicateUsernameError'
  }
}

export function toPublicUser(row: UserRow): PublicUser {
  return { id: row.id, username: row.username, role: row.role }
}

export function countUsers(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }
  return row.n
}

export function findByUsername(username: string): UserRow | undefined {
  return getDb().prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined
}

export function findById(id: number): UserRow | undefined {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined
}

/**
 * 创建用户。**首个注册用户成为管理员**（bootstrap，与 Gitea/Jellyfin 同款做法），
 * 其余均为普通用户。
 */
export async function createUser(username: string, password: string): Promise<UserRow> {
  if (findByUsername(username))
    throw new DuplicateUsernameError(username)

  const { hash, salt } = await hashPassword(password)
  const role: UserRole = countUsers() === 0 ? 'admin' : 'user'
  const createdAt = Date.now()

  const result = getDb()
    .prepare('INSERT INTO users (username, password_hash, salt, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(username, hash, salt, role, createdAt)

  return { id: Number(result.lastInsertRowid), username, password_hash: hash, salt, role, created_at: createdAt }
}

/** 用户不存在时使用的哑元哈希/盐：让「用户不存在」与「密码错误」耗时一致 */
const DUMMY_HASH = '0'.repeat(128)
const DUMMY_SALT = '0'.repeat(32)

/** 校验用户名 + 密码；成功返回用户行，失败返回 null */
export async function authenticate(username: string, password: string): Promise<UserRow | null> {
  const row = findByUsername(username)

  if (!row) {
    // 仍走一次等价的 scrypt：否则可通过响应耗时枚举出哪些用户名存在
    await verifyPassword(password, DUMMY_HASH, DUMMY_SALT)
    return null
  }

  const ok = await verifyPassword(password, row.password_hash, row.salt)
  return ok ? row : null
}
