import { agentConfig } from '../utils/config'
import { isNotEmptyString } from '../utils/is'

function envString(name: string, fallback = ''): string {
  return isNotEmptyString(process.env[name]) ? process.env[name]!.trim() : fallback
}

/** 调用 OpenAI 兼容 embeddings 接口批量生成向量；失败时抛出带配置提示的错误 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  // 独立 embedding 配置（EMBEDDING_* 优先），未配置时回退到 Agent 的 OPENAI_* 配置
  const apiKey = envString('EMBEDDING_API_KEY', process.env.API_KEY ?? '')
  const baseURL = envString('EMBEDDING_API_BASE_URL', agentConfig.openaiApiBaseUrl).trim().replace(/\/+$/, '')
  const model = envString('EMBEDDING_MODEL', agentConfig.embeddingModel)

  if (!isNotEmptyString(apiKey))
    throw new Error('缺少 EMBEDDING_API_KEY（或 API_KEY）环境变量（service/.env）')
  if (!isNotEmptyString(baseURL))
    throw new Error('缺少 EMBEDDING_API_BASE_URL（或 OPENAI_API_BASE_URL）环境变量（service/.env）')
  if (!isNotEmptyString(model))
    throw new Error('缺少 EMBEDDING_MODEL 环境变量（service/.env）')

  const response = await fetch(`${baseURL}/embeddings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, input: texts }),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`embedding 接口失败（HTTP ${response.status}）：${body.slice(0, 200)}`)
  }

  const data = await response.json() as { data?: Array<{ embedding: number[] }> }
  const embeddings = (data.data ?? []).map(item => item.embedding)
  if (embeddings.length !== texts.length)
    throw new Error(`embedding 返回数量（${embeddings.length}）与输入数量（${texts.length}）不一致`)
  return embeddings
}
