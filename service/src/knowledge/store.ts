import { createHash } from 'node:crypto'
import { chunkText } from '../rag/chunk'
import { embedTexts } from '../rag/embed'
import { type VectorRecord, all, remove, upsert } from '../rag/store'
import { getDb } from '../store/db'

/**
 * 知识库的数据访问层。
 *
 * **多租户隔离**：与 `conversation/store.ts` 同样的约定 —— 所有导出函数的第一个参数
 * 都是 `userId`，且每条 SQL 都带 `user_id = ?` 过滤；向量库侧则依赖 `VectorRecord.userId`
 * （见 rag/store.ts 的 search/all）。
 *
 * 元数据（文件名、块数、上传时间）放 SQLite，向量本体留在 `data/vectors.json` ——
 * 元数据要能按用户查询与排序，向量是大块载荷，分开各取所长。
 */

/**
 * 原始文件大小上限（base64 解码后的字节数）。
 * body 上限是 `express.json({ limit: '10mb' })`，而 base64 会膨胀约 1/3，
 * 这里取 2MB 留足余量，也远大于任何真实的知识库文档。
 */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024

/**
 * 允许的扩展名。
 * PDF / docx 需要额外的解析依赖（违反「新依赖能不加就不加」），本阶段不做 ——
 * 界面上要明确提示不支持的类型，而不是默默失败。
 */
export const ALLOWED_EXTENSIONS = ['.md', '.txt'] as const

/** embedding 分批大小：一次请求塞太多块会被服务商拒绝或超时（原 ingest 是一次性批量） */
const EMBED_BATCH_SIZE = 16

/** 文档元信息（向量本体不在这里，见 rag/store.ts） */
export interface KnowledgeDoc {
  docId: string
  name: string
  chunks: number
  chars: number
  createdAt: number
}

/**
 * 上传相关的**语义化错误**：路由层据此回 400（用户输入问题）而不是 500（服务端故障），
 * 并把 message 原样透给前端 —— 「文件过大」和「向量化服务不可用」对用户是两回事。
 */
export class KnowledgeUploadError extends Error {}

interface DocRow {
  doc_id: string
  name: string
  chunks: number
  chars: number
  created_at: number
}

function toDoc(row: DocRow): KnowledgeDoc {
  return {
    docId: row.doc_id,
    name: row.name,
    chunks: Number(row.chunks),
    chars: Number(row.chars),
    createdAt: Number(row.created_at),
  }
}

/** 取小写扩展名（含点）；没有扩展名返回空串 */
export function extensionOf(name: string): string {
  const index = name.lastIndexOf('.')
  return index > 0 ? name.slice(index).toLowerCase() : ''
}

/**
 * 文档 id = **内容的 SHA-256 前 16 位**。
 *
 * 用内容而不是文件名做 id，是为了让「同一份文件重复上传」天然幂等；
 * 而**同名不同内容视为两份文档**（各自的 docId 不同），不会像原来的 `${文件名}:${序号}`
 * 那样互相覆盖。16 位十六进制（64 bit）对个人知识库的规模来说碰撞概率可忽略。
 */
export function contentDocId(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex').slice(0, 16)
}

/** 分批向量化：逐批调用，任何一批失败都抛出（由调用方包装成 KnowledgeUploadError） */
async function embedInBatches(texts: string[]): Promise<number[][]> {
  const vectors: number[][] = []
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE)
    const batchVectors = await embedTexts(batch)
    if (batchVectors.length !== batch.length)
      throw new Error(`向量化返回条数不匹配（期望 ${batch.length}，实际 ${batchVectors.length}）`)
    vectors.push(...batchVectors)
  }
  return vectors
}

/** 当前用户已上传的文档，按上传时间倒序 */
export function listDocuments(userId: number): KnowledgeDoc[] {
  const rows = getDb()
    .prepare('SELECT doc_id, name, chunks, chars, created_at FROM knowledge_docs WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId) as DocRow[]
  return rows.map(toDoc)
}

/** 带索引状态的文档：`indexed` 表示登记的块数与实际向量块数一致 */
export interface KnowledgeDocStatus extends KnowledgeDoc {
  vectorChunks: number
  indexed: boolean
}

/**
 * 文档列表 + 索引状态。
 *
 * 索引状态的存在理由：向量写入与元信息登记是两步，中间失败或 reindex 中途挂掉时
 * 两者会不一致 —— 列表里看得出来，用户才不会以为「传上去了就一定能检索到」。
 */
export async function listDocumentsWithStatus(userId: number): Promise<KnowledgeDocStatus[]> {
  const docs = listDocuments(userId)
  if (docs.length === 0)
    return []

  const counts = new Map<string, number>()
  for (const record of await all(userId))
    counts.set(record.docId, (counts.get(record.docId) ?? 0) + 1)

  return docs.map((doc) => {
    const vectorChunks = counts.get(doc.docId) ?? 0
    return { ...doc, vectorChunks, indexed: vectorChunks === doc.chunks }
  })
}

/** 单个文档的元信息；不属于该用户时返回 null */
export function getDocument(userId: number, docId: string): KnowledgeDoc | null {
  const row = getDb()
    .prepare('SELECT doc_id, name, chunks, chars, created_at FROM knowledge_docs WHERE user_id = ? AND doc_id = ?')
    .get(userId, docId) as DocRow | undefined
  return row ? toDoc(row) : null
}

/**
 * 上传一份文档：校验 → 切块 → 分批向量化 → 写入向量库 → 登记元信息。
 *
 * 内容相同的文档**幂等**：已存在时直接返回既有记录，不重复向量化（embedding 要花钱）。
 */
export async function ingestDocument(input: { userId: number; name: string; content: string }): Promise<KnowledgeDoc> {
  const { userId, name, content } = input

  const ext = extensionOf(name)
  if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(ext))
    throw new KnowledgeUploadError(`不支持的文件类型「${ext || '无扩展名'}」，目前仅支持 ${ALLOWED_EXTENSIONS.join(' / ')}`)

  if (!content.trim())
    throw new KnowledgeUploadError('文件内容为空')

  const bytes = Buffer.byteLength(content, 'utf-8')
  if (bytes > MAX_UPLOAD_BYTES)
    throw new KnowledgeUploadError(`文件过大（${(bytes / 1024 / 1024).toFixed(2)}MB），上限 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB`)

  const docId = contentDocId(content)
  const existing = getDocument(userId, docId)
  if (existing)
    return existing

  const chunks = chunkText(content)
  if (chunks.length === 0)
    throw new KnowledgeUploadError('文件切块后为空，请检查内容')

  let vectors: number[][]
  try {
    vectors = await embedInBatches(chunks)
  }
  catch (error: any) {
    // 明确回给前端：这是「向量化服务不可用」，不是「文件有问题」
    throw new KnowledgeUploadError(`向量化失败：${error?.message ?? error}。请检查 service/.env 的 EMBEDDING_* 配置与服务商可用性`)
  }

  await upsert(chunks.map((text, i) => ({
    id: `${docId}:${i}`,
    text,
    vector: vectors[i],
    userId,
    docId,
  }) satisfies VectorRecord))

  const doc: KnowledgeDoc = {
    docId,
    name,
    chunks: chunks.length,
    chars: content.length,
    createdAt: Date.now(),
  }
  getDb()
    .prepare('INSERT OR REPLACE INTO knowledge_docs (user_id, doc_id, name, chunks, chars, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, doc.docId, doc.name, doc.chunks, doc.chars, doc.createdAt)

  return doc
}

/**
 * 删除一份文档：先删向量块、再删元信息。
 *
 * **两个条件都带 `userId`** —— 只按 docId 删的话，猜到别人的 docId 就能删别人的文档。
 * 返回删除的块数；文档不存在返回 null（路由层据此回 404）。
 */
export async function deleteDocument(userId: number, docId: string): Promise<{ removedChunks: number } | null> {
  const doc = getDocument(userId, docId)
  if (!doc)
    return null

  const removedChunks = await remove(record => record.userId === userId && record.docId === docId)
  getDb()
    .prepare('DELETE FROM knowledge_docs WHERE user_id = ? AND doc_id = ?')
    .run(userId, docId)

  return { removedChunks }
}

/** 从块 id（`${docId}:${序号}`）里取回序号，用于还原块顺序 —— 格式由本模块自己生成，切分是安全的 */
function chunkIndexOf(id: string): number {
  const value = Number(id.slice(id.lastIndexOf(':') + 1))
  return Number.isFinite(value) ? value : 0
}

/**
 * 重建索引：用**当前的 embedding 配置**重新向量化该文档已有的块。
 *
 * 刻意**不重新切块** —— 切块参数没变时块边界不会变，而重切需要保存原始正文；
 * 「配置变更」通常指的是换了 embedding 模型，那时真正要重算的就是向量。
 * 返回重建的块数；文档不存在返回 null。
 */
export async function reindexDocument(userId: number, docId: string): Promise<{ chunks: number } | null> {
  const doc = getDocument(userId, docId)
  if (!doc)
    return null

  const chunks = (await all(userId))
    .filter(record => record.docId === docId)
    .sort((a, b) => chunkIndexOf(a.id) - chunkIndexOf(b.id))

  if (chunks.length === 0)
    return { chunks: 0 }

  let vectors: number[][]
  try {
    vectors = await embedInBatches(chunks.map(chunk => chunk.text))
  }
  catch (error: any) {
    throw new KnowledgeUploadError(`重新向量化失败：${error?.message ?? error}。请检查 service/.env 的 EMBEDDING_* 配置与服务商可用性`)
  }

  await upsert(chunks.map((chunk, i) => ({ ...chunk, vector: vectors[i] })))
  return { chunks: chunks.length }
}
