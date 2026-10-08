import { beforeEach, describe, expect, it } from 'vitest'
import { getDb } from '../store/db'
import {
  DuplicateUsernameError,
  authenticate,
  countUsers,
  createUser,
  findById,
  findByUsername,
  toPublicUser,
} from './users'

// db.ts 在**首次 getDb() 调用时**才读取该变量（惰性），此处赋值先于任何测试调用，
// 因此本文件使用独立内存库，不会碰到 service/data/agent.db
process.env.AGENT_DB_PATH = ':memory:'

describe('users', () => {
  beforeEach(() => {
    getDb().exec('DELETE FROM users')
  })

  it('首个注册用户成为管理员，其余为普通用户', async () => {
    const first = await createUser('alice', 'password-1')
    const second = await createUser('bob', 'password-2')

    expect(first.role).toBe('admin')
    expect(second.role).toBe('user')
    expect(countUsers()).toBe(2)
  })

  it('重复用户名抛 DuplicateUsernameError', async () => {
    await createUser('alice', 'password-1')

    await expect(createUser('alice', 'password-2')).rejects.toThrow(DuplicateUsernameError)
  })

  it('authenticate：正确密码返回用户，错误密码与不存在用户返回 null', async () => {
    const alice = await createUser('alice', 'password-1')

    await expect(authenticate('alice', 'password-1')).resolves.toMatchObject({ id: alice.id, username: 'alice' })
    await expect(authenticate('alice', 'wrong-password')).resolves.toBeNull()
    await expect(authenticate('nobody', 'password-1')).resolves.toBeNull()
  })

  it('密码不落明文，可按键查回', async () => {
    const row = await createUser('alice', 'password-1')

    expect(row.password_hash).not.toContain('password-1')
    expect(row.salt).toMatch(/^[0-9a-f]{32}$/)
    expect(findByUsername('alice')!.password_hash).toBe(row.password_hash)
    expect(findById(row.id)!.username).toBe('alice')
    expect(findByUsername('nobody')).toBeUndefined()
  })

  it('toPublicUser 不泄露 password_hash / salt', () => {
    const publicUser = toPublicUser({
      id: 1,
      username: 'alice',
      password_hash: 'secret-hash',
      salt: 'secret-salt',
      role: 'admin',
      created_at: 0,
    })

    expect(publicUser).toEqual({ id: 1, username: 'alice', role: 'admin' })
    expect(JSON.stringify(publicUser)).not.toContain('secret')
  })
})
