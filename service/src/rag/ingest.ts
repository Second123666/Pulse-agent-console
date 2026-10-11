/* eslint-disable no-console */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { getDb } from '../store/db'
import { chunkText } from './chunk'
import { embedTexts } from './embed'
import { upsert } from './store'

const KNOWLEDGE_DIR = path.resolve(process.cwd(), 'knowledge')

/**
 * CLI 摄取没有「当前用户」，统一挂到管理员名下。
 *
 * 在「适配 userId」与「标记 deprecated」之间选了前者：`service/knowledge/` 批量灌库
 * 在开发期仍然好用（12.2 的上传接口是给终端用户用的，一次一个文件，不适合灌整套文档）。
 * 挂管理员是唯一说得通的归属 —— 能跑这条命令行的人本来就是这个部署的运维者。
 */
function adminUserId(): number {
  const row = getDb()
    .prepare('SELECT id FROM users WHERE role = \'admin\' ORDER BY id LIMIT 1')
    .get() as { id: number } | undefined
  if (!row)
    throw new Error('库中没有管理员账号，无法确定知识库归属。请先注册首个账号（首个注册用户即管理员）。')
  return Number(row.id)
}

async function main(): Promise<void> {
  let files: string[]
  try {
    files = (await fs.readdir(KNOWLEDGE_DIR)).filter(file => /\.(md|txt)$/i.test(file)).sort()
  }
  catch {
    console.error(`知识库目录不存在或无法读取：${KNOWLEDGE_DIR}`)
    process.exit(1)
  }
  if (files.length === 0) {
    console.error(`知识库目录为空：${KNOWLEDGE_DIR}，请放入 .md/.txt 文档`)
    process.exit(1)
  }

  const userId = adminUserId()

  const chunks: Array<{ id: string; text: string; docId: string }> = []
  const texts: string[] = []
  for (const file of files) {
    const content = await fs.readFile(path.join(KNOWLEDGE_DIR, file), 'utf-8')
    const pieces = chunkText(content)
    pieces.forEach((piece, i) => {
      chunks.push({ id: `${file}:${i}`, text: piece, docId: file })
      texts.push(piece)
    })
  }

  console.log(`切块完成：${files.length} 个文件，共 ${chunks.length} 块，开始生成 embedding...`)
  const vectors = await embedTexts(texts)
  await upsert(chunks.map((chunk, i) => ({
    id: chunk.id,
    text: chunk.text,
    vector: vectors[i],
    userId,
    docId: chunk.docId,
  })))
  console.log(`摄取完成：${chunks.length} 块已入库（归属 userId=${userId}，service/data/agent.db 的 vectors 表）`)
}

main().catch((error) => {
  console.error(`摄取失败：${error?.message ?? error}`)
  console.error('提示：请检查 service/.env 中 OPENAI_API_BASE_URL / EMBEDDING_MODEL / API_KEY 配置，确认该模型服务商支持 embeddings 接口。')
  process.exit(1)
})
