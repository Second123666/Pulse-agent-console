import { promises as fs } from 'node:fs'
import path from 'node:path'
import { chunkText, type TextChunk } from './chunk'
import { embedTexts } from './embed'
import { upsert } from './store'

const KNOWLEDGE_DIR = path.resolve(process.cwd(), 'knowledge')

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

  const chunks: TextChunk[] = []
  const texts: string[] = []
  for (const file of files) {
    const content = await fs.readFile(path.join(KNOWLEDGE_DIR, file), 'utf-8')
    const pieces = chunkText(content)
    pieces.forEach((piece, i) => {
      chunks.push({ id: `${file}:${i}`, text: piece })
      texts.push(piece)
    })
  }

  console.log(`切块完成：${files.length} 个文件，共 ${chunks.length} 块，开始生成 embedding...`)
  const vectors = await embedTexts(texts)
  await upsert(chunks.map((chunk, i) => ({ id: chunk.id, text: chunk.text, vector: vectors[i] })))
  console.log(`摄取完成：${chunks.length} 块已入库（service/data/vectors.json）`)
}

main().catch((error) => {
  console.error(`摄取失败：${error?.message ?? error}`)
  console.error('提示：请检查 service/.env 中 OPENAI_API_BASE_URL / EMBEDDING_MODEL / API_KEY 配置，确认该模型服务商支持 embeddings 接口。')
  process.exit(1)
})
