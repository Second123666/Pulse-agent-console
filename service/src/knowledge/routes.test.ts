import type { Server } from 'node:http'
import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// 环境必须在**动态 import 之前**设置（authConfig 在模块求值时读 env）
process.env.AGENT_DB_PATH = ':memory:'
process.env.AUTH_SECRET_KEY = ''
process.env.JWT_SECRET = 'test-jwt-secret'

// 测试不打真实 embedding 接口：mock 掉后，向量化成功/失败都由测试自己控制
const { mockEmbedTexts } = vi.hoisted(() => ({ mockEmbedTexts: vi.fn() }))
vi.mock('../rag/embed', () => ({ embedTexts: mockEmbedTexts }))

const { knowledgeRouter } = await import('./routes')
const { authRouter } = await import('../auth/routes')
const { getDb } = await import('../store/db')
const { all, clear } = await import('../rag/store')
const { MAX_UPLOAD_BYTES, ingestDocument } = await import('./store')
const { ragSearch } = await import('../tools/ragSearch')

let server: Server
let base: string

beforeAll(async () => {
  const app = express()
  app.use(express.json({ limit: '10mb' }))
  // 与 index.ts 相同的双前缀挂载
  app.use('', authRouter)
  app.use('/api', authRouter)
  app.use('', knowledgeRouter)
  app.use('/api', knowledgeRouter)

  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve)
  })
  const address = server.address()
  const port = (typeof address === 'object' && address) ? address.port : 0
  base = `http://127.0.0.1:${port}`
})

afterAll(() => {
  server?.close()
})

beforeEach(async () => {
  mockEmbedTexts.mockReset()
  // 向量库 12.5 起也在 SQLite 里（与 knowledge_docs 同库），测试间必须清干净
  await clear()
  const db = getDb()
  db.exec('DELETE FROM knowledge_docs')
  db.exec('DELETE FROM users')
})

async function register(username: string) {
  const response = await fetch(`${base}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'password-1' }),
  })
  const body = await response.json() as any
  const token = body.data.token as string
  const me = await fetch(`${base}/auth/me`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()) as any
  return { token, userId: Number(me.data.user.id) }
}

/** 上传：content 自动 base64 后发 */
async function upload(token: string | null, name: string, content: string | null) {
  const response = await fetch(`${base}/knowledge/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ name, contentBase64: content === null ? null : Buffer.from(content, 'utf-8').toString('base64') }),
  })
  return { status: response.status, body: await response.json() as any }
}

describe('POST /knowledge/upload', () => {
  it('上传成功并落库，rag_search 能检索到', async () => {
    mockEmbedTexts.mockImplementation(async (texts: string[]) => texts.map(() => [1, 0, 0]))
    const { token, userId } = await register('uploader')

    const result = await upload(token, 'doc.md', '# 标题\n\n松鼠的尾巴特别蓬松，这是测试内容')
    expect(result.status).toBe(200)
    expect(result.body.status).toBe('Success')
    expect(result.body.data.doc.name).toBe('doc.md')
    expect(result.body.data.doc.chunks).toBeGreaterThan(0)
    expect(result.body.data.doc.docId).toMatch(/^[0-9a-f]{16}$/)

    // 落库的两种确认：元信息进了 SQLite，块进了向量库且能被检索
    const docId = result.body.data.doc.docId
    const row = getDb().prepare('SELECT user_id, name FROM knowledge_docs WHERE doc_id = ?').get(docId) as any
    expect(row).toBeTruthy()
    expect(Number(row.user_id)).toBe(userId)

    const { ragSearch } = await import('../tools/ragSearch')
    const searchResult = await ragSearch.handler({ query: '松鼠' }, { userId })
    expect(searchResult).toContain('松鼠')
  })

  it('同内容重复上传幂等：不新增块', async () => {
    mockEmbedTexts.mockImplementation(async (texts: string[]) => texts.map(() => [1, 0, 0]))
    const { token, userId } = await register('uploader')
    const content = '重复内容：水獭喜欢在水上漂流。'

    const first = await upload(token, 'a.md', content)
    const second = await upload(token, 'b.md', content)

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    // docId 只由内容决定，同内容必然同 id
    expect(second.body.data.doc.docId).toBe(first.body.data.doc.docId)
    // 只有一条元信息、一块向量
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM knowledge_docs WHERE user_id = ?').get(userId)).toEqual({ n: 1 })
    expect(await all(userId)).toHaveLength(1)
    // 同内容重复上传也只该向量化一次（embedding 要花钱）
    expect(mockEmbedTexts).toHaveBeenCalledTimes(1)
  })

  it('同名不同内容视为两份文档，互不覆盖', async () => {
    mockEmbedTexts.mockImplementation(async (texts: string[]) => texts.map(() => [1, 0, 0]))
    const { token, userId } = await register('uploader')

    await upload(token, 'note.md', '第一份内容')
    await upload(token, 'note.md', '第二份内容')

    expect(await all(userId)).toHaveLength(2)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM knowledge_docs WHERE user_id = ?').get(userId)).toEqual({ n: 2 })
  })

  it('中文经 base64 往返后不乱码', async () => {
    mockEmbedTexts.mockImplementation(async (texts: string[]) => texts.map(() => [1, 0, 0]))
    // 必须用注册返回的 id：users 表是 AUTOINCREMENT，DELETE 不会把序号重置回 1
    const { token, userId } = await register('uploader')
    const content = '中文测试：熊猫喜欢吃竹子，含 emoji 🐼。'
    await upload(token, 'zh.md', content)
    const chunks = await all(userId)
    expect(chunks.some(chunk => chunk.text.includes('🐼'))).toBe(true)
  })

  it('非 .md/.txt 被拒（400 且说明原因）', async () => {
    const { token } = await register('uploader')
    const result = await upload(token, 'run.exe', 'binary')
    expect(result.status).toBe(400)
    expect(result.body.message).toContain('不支持的文件类型')
    expect(result.body.message).toContain('.md')
  })

  it('超大文件被拒', async () => {
    const { token } = await register('uploader')
    // 只要 base64 长度越线即可触发，不必真造 2MB 的内容
    const oversized = 'A'.repeat(Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 9)
    const response = await fetch(`${base}/knowledge/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ name: 'big.md', contentBase64: oversized }),
    })
    expect(response.status).toBe(400)
    expect((await response.json() as any).message).toContain('文件过大')
  })

  it('解码后的字节数超限也拒（store 层的第二道防线）', async () => {
    const { userId } = await register('uploader')
    const content = 'x'.repeat(MAX_UPLOAD_BYTES + 1)
    await expect(ingestDocument({ userId, name: 'big.md', content })).rejects.toThrow('文件过大')
  })

  it('非 base64 内容被拒，不会把乱码切块入库', async () => {
    mockEmbedTexts.mockImplementation(async (texts: string[]) => texts.map(() => [1, 0, 0]))
    const { token, userId } = await register('uploader')
    const response = await fetch(`${base}/knowledge/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ name: 'plain.md', contentBase64: '这不是 base64，是纯文本' }),
    })
    expect(response.status).toBe(400)
    expect((await response.json() as any).message).toContain('base64')
    expect(await all(userId)).toHaveLength(0)
  })

  it('embedding 失败返回明确错误（400，带原因），不写库', async () => {
    mockEmbedTexts.mockRejectedValue(new Error('EMBEDDING_API_KEY 未配置'))
    const { token, userId } = await register('uploader')

    const result = await upload(token, 'doc.md', '需要向量化的内容')
    expect(result.status).toBe(400)
    expect(result.body.message).toContain('向量化失败')
    expect(result.body.message).toContain('EMBEDDING_API_KEY')
    // 失败不落半份：向量库与注册表都是空的
    expect(await all(userId)).toHaveLength(0)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM knowledge_docs').get()).toEqual({ n: 0 })
  })

  it('空文件被拒', async () => {
    const { token } = await register('uploader')
    const result = await upload(token, 'doc.md', '   ')
    expect(result.status).toBe(400)
    expect(result.body.message).toContain('空')
  })

  it('缺少文件名 / 内容被拒', async () => {
    const { token } = await register('uploader')
    expect((await upload(token, '', 'x')).status).toBe(400)
    expect((await upload(token, 'a.md', null)).status).toBe(400)
  })

  it('未登录返回 401', async () => {
    const result = await upload(null, 'doc.md', '内容')
    expect(result.status).toBe(401)
  })
})

async function listDocs(token: string | null) {
  const response = await fetch(`${base}/knowledge/list`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  })
  return { status: response.status, body: await response.json() as any }
}

async function remove(token: string | null, docId: string) {
  const response = await fetch(`${base}/knowledge/${docId}`, {
    method: 'DELETE',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  })
  return { status: response.status, body: await response.json() as any }
}

async function reindex(token: string | null, docId: string) {
  const response = await fetch(`${base}/knowledge/reindex`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ docId }),
  })
  return { status: response.status, body: await response.json() as any }
}

describe('知识库管理 API（12.3）', () => {
  beforeEach(() => {
    mockEmbedTexts.mockImplementation(async (texts: string[]) => texts.map(() => [1, 0, 0]))
  })

  it('列表只返回自己的文档，并带索引状态', async () => {
    const a = await register('owner-a')
    const b = await register('owner-b')
    await upload(a.token, 'mine.md', '甲的文档内容')
    await upload(b.token, 'theirs.md', '乙的文档内容')

    const ra = await listDocs(a.token)
    expect(ra.status).toBe(200)
    expect(ra.body.data.docs).toHaveLength(1)
    expect(ra.body.data.docs[0].name).toBe('mine.md')
    expect(ra.body.data.docs[0].indexed).toBe(true)
    expect(ra.body.data.docs[0].vectorChunks).toBe(ra.body.data.docs[0].chunks)

    const rb = await listDocs(b.token)
    expect(rb.body.data.docs).toHaveLength(1)
    expect(rb.body.data.docs[0].name).toBe('theirs.md')
  })

  it('索引状态能反映块数不一致（向量缺失）', async () => {
    const { token, userId } = await register('stale-check')
    await upload(token, 'doc.md', '用于验证索引状态的内容')
    // 模拟「元信息登记了、向量却没了」—— 中途失败的另一半
    const { remove: removeVectors } = await import('../rag/store')
    await removeVectors(record => record.userId === userId)

    const list = await listDocs(token)
    expect(list.body.data.docs[0].indexed).toBe(false)
    expect(list.body.data.docs[0].vectorChunks).toBe(0)
  })

  it('无 token 访问 /knowledge/list 返回 401', async () => {
    const result = await listDocs(null)
    expect(result.status).toBe(401)
  })

  it('删除自己的文档后检索不再命中，列表也清空', async () => {
    const { token, userId } = await register('deleter')
    const up = await upload(token, 'gone.md', '这段文档里藏着代号 FALCON-3000')
    const docId = up.body.data.doc.docId

    expect(await ragSearch.handler({ query: 'FALCON' }, { userId })).toContain('FALCON')

    const removed = await remove(token, docId)
    expect(removed.status).toBe(200)
    expect(removed.body.data.removedChunks).toBeGreaterThan(0)

    expect(await ragSearch.handler({ query: 'FALCON' }, { userId })).not.toContain('FALCON')
    expect((await listDocs(token)).body.data.docs).toHaveLength(0)
    expect(await all(userId)).toHaveLength(0)
  })

  it('删除他人文档返回 404 且不动对方数据', async () => {
    const victim = await register('victim')
    const attacker = await register('attacker')
    const up = await upload(victim.token, 'secret.md', '被害者的文档内容')
    const docId = up.body.data.doc.docId

    const result = await remove(attacker.token, docId)
    expect(result.status).toBe(404)

    // 对方的元信息与向量块都完好无损
    expect((await listDocs(victim.token)).body.data.docs).toHaveLength(1)
    expect(await all(victim.userId)).toHaveLength(1)
  })

  it('docId 格式非法一律 400，不进查询', async () => {
    const { token } = await register('bad-id')
    expect((await remove(token, 'short')).status).toBe(400)
    // 17 位（非固定 16 位）
    expect((await remove(token, 'DEADBEEFDEADBEEFX')).status).toBe(400)
    expect((await remove(token, 'has space here')).status).toBe(400)
    expect((await reindex(token, 'not-hex')).status).toBe(400)
    // 合法但不存在 → 404（不区分「存在但不是你的」）
    expect((await remove(token, 'deadbeefdeadbeef')).status).toBe(404)
  })

  it('reindex 后块 id 稳定、向量被替换', async () => {
    const { token, userId } = await register('reindexer')
    // 单个分段也要切块：chunkText 的窗口是 500 字，这里造 10 + 4×200 = 810 字
    // （第一次写成 ×120 = 490 字，恰好不超窗，只切出一块 —— 断言 isGreaterThanOrEqual(2) 就挂了）
    const up = await upload(token, 'doc.md', `重建索引用的长文档。${'内容句。'.repeat(200)}`)
    const docId = up.body.data.doc.docId
    const idsBefore = (await all(userId)).filter(r => r.docId === docId).map(r => r.id).sort()
    expect(idsBefore.length).toBeGreaterThanOrEqual(2)

    mockEmbedTexts.mockImplementation(async (texts: string[]) => texts.map(() => [0, 1, 0]))
    const result = await reindex(token, docId)
    expect(result.status).toBe(200)
    expect(result.body.data.chunks).toBe(idsBefore.length)

    const records = (await all(userId)).filter(r => r.docId === docId)
    expect(records.map(r => r.id).sort()).toEqual(idsBefore)
    expect(records.every(r => r.vector[0] === 0 && r.vector[1] === 1)).toBe(true)
  })

  it('reindex 别人的文档返回 404', async () => {
    const victim = await register('victim2')
    const attacker = await register('attacker2')
    const up = await upload(victim.token, 'v.md', '受害者的内容')
    expect((await reindex(attacker.token, up.body.data.doc.docId)).status).toBe(404)
  })

  it('reindex 未登录返回 401', async () => {
    expect((await reindex(null, 'deadbeefdeadbeef')).status).toBe(401)
  })

  it('embedding 失败时 reindex 回 400 且说明原因', async () => {
    const { token } = await register('reindex-fail')
    const up = await upload(token, 'doc.md', '文档内容')
    mockEmbedTexts.mockRejectedValue(new Error('EMBEDDING_API_KEY 未配置'))

    const result = await reindex(token, up.body.data.doc.docId)
    expect(result.status).toBe(400)
    expect(result.body.message).toContain('重新向量化失败')
  })
})
