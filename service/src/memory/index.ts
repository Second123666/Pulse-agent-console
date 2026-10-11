import { chatCompletion } from '../agent/openaiClient'
import { embedTexts } from '../rag/embed'
import type { MessageContent } from '../types'
import { contentText } from '../utils/content'
import { getMemory, searchMemories, upsertMemory } from './store'

/**
 * 长期记忆：跨会话召回。
 *
 * 两条路径：
 * - `rememberConversation()` —— 会话进行到一定长度后生成摘要并入库（异步、失败静默）
 * - `recallMemories()` —— 新一轮对话开始时按语义相似度召回相关摘要
 *
 * 降级策略与 RAG 保持一致：**embedding 不可用就静默跳过召回/向量**，绝不影响对话本身。
 */

/** 触发摘要的最小会话长度（消息条数，含本轮） */
const MIN_MESSAGES_TO_SUMMARIZE = 6
/** 距上次摘要至少新增这么多条消息才重新摘要（控制额外的模型调用开销） */
const MIN_NEW_MESSAGES = 4
/**
 * 距上次摘要的最长时间：前端只回传最近 20 条历史（AGENT_HISTORY_LIMIT），
 * 会话很长时「新增条数」会永远停在 22 条不再增长，光靠条数判断记忆会过期。
 * 用时间兜底：即使没有新材料，超过这个间隔也刷新一次（每次多一次模型调用，成本有界）。
 */
const REFRESH_MIN_INTERVAL_MS = 10 * 60 * 1000
/** 默认召回条数 */
const RECALL_TOP_K = 3
/** 摘要输入的最大字符数：只取最近的部分，避免把整段超长会话塞进请求 */
const SUMMARY_INPUT_MAX_CHARS = 6000

const SUMMARY_PROMPT = [
  '你是会话记忆压缩器。把下面这段对话压缩成一条可跨会话复用的长期记忆。',
  '要求：',
  '1. 只保留对后续对话有用的事实：用户的身份与偏好、正在进行的项目与约束、已做出的决定与结论；',
  '2. 丢弃寒暄、重复内容与一次性的中间过程；',
  '3. 用第三人称陈述，不超过 200 字；',
  '4. 直接输出记忆正文，不要任何前缀、标题或解释。',
].join('\n')

/** 把召回的记忆拼进 system message；没有记忆时原样返回 */
export function composeSystemMessage(systemMessage: string | undefined, memories: string[]): string | undefined {
  if (memories.length === 0)
    return systemMessage

  const block = [
    '## 相关历史记忆（来自既往会话，供参考；不必向用户复述，也不要声称你记得未在此列出的事）',
    ...memories.map(summary => `- ${summary}`),
  ].join('\n')

  const base = systemMessage?.trim()
  return base ? `${base}\n\n${block}` : block
}

/**
 * 召回与该 query 相关的历史记忆摘要。
 * embedding 不可用（未配置 / 接口失败）时返回空数组 —— 静默降级，不影响本轮对话。
 */
export async function recallMemories(userId: number, query: string, k = RECALL_TOP_K): Promise<string[]> {
  const trimmed = query?.trim()
  if (!Number.isInteger(userId) || userId <= 0 || !trimmed)
    return []

  try {
    const [embedding] = await embedTexts([trimmed])
    if (!embedding?.length)
      return []
    return searchMemories(userId, embedding, k).map(item => item.summary)
  }
  catch (error: any) {
    globalThis.console.warn('[memory] 记忆召回失败，本次跳过：', error?.message ?? error)
    return []
  }
}

/**
 * 为一个会话生成/刷新长期记忆。
 *
 * 触发条件：消息数达到 `MIN_MESSAGES_TO_SUMMARIZE`，且距上次摘要新增了
 * `MIN_NEW_MESSAGES` 条以上（避免每轮都多花一次模型调用）。
 * 任何一步失败都只打日志、返回 false，不向上抛 —— 记忆是增强项，不能拖垮对话。
 */
export async function rememberConversation(params: {
  userId: number
  conversationId: number
  messages: Array<{ role: 'user' | 'assistant'; content: MessageContent }>
}): Promise<boolean> {
  const { userId, conversationId, messages } = params
  if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(conversationId) || conversationId <= 0)
    return false

  // 取文本再判空：多模态消息（13.1）的 content 是数组，原来的 `typeof === 'string'`
  // 会把「带文字说明的图片消息」整条丢掉，那句说明本该进摘要
  const usable = messages.filter(item => contentText(item.content).trim() !== '')
  if (usable.length < MIN_MESSAGES_TO_SUMMARIZE)
    return false

  try {
    // 读库也在 try 内：本函数被 fire-and-forget 调用，任何抛出都会变成 unhandled rejection
    const existing = getMemory(userId, conversationId)
    if (existing) {
      const grewEnough = usable.length - existing.messageCount >= MIN_NEW_MESSAGES
      const staleEnough = Date.now() - existing.createdAt >= REFRESH_MIN_INTERVAL_MS
      if (!grewEnough && !staleEnough)
        return false
    }

    const transcript = usable
      .map(item => `${item.role === 'user' ? '用户' : '助手'}：${contentText(item.content)}`)
      .join('\n')
      .slice(-SUMMARY_INPUT_MAX_CHARS)

    const result = await chatCompletion({
      messages: [
        { role: 'system', content: SUMMARY_PROMPT },
        { role: 'user', content: transcript },
      ],
      tool_choice: 'none',
      temperature: 0.2,
    })

    const summary = result.content?.trim()
    if (!summary)
      return false

    // embedding 失败不丢摘要：以 NULL 向量入库（本轮召回不到，但数据留住了），
    // 也正因为入库了，message_count 守卫不会让下一轮重复花钱做同样的摘要
    let embedding: number[] | null = null
    try {
      const [vector] = await embedTexts([summary])
      embedding = vector?.length ? vector : null
    }
    catch (error: any) {
      globalThis.console.warn('[memory] 摘要向量化失败，仅存文本（该条暂不可召回）：', error?.message ?? error)
    }

    upsertMemory({ userId, conversationId, summary, embedding, messageCount: usable.length })
    return true
  }
  catch (error: any) {
    globalThis.console.warn('[memory] 生成会话摘要失败，本次跳过：', error?.message ?? error)
    return false
  }
}
