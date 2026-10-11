import { beforeEach, describe, expect, it, vi } from 'vitest'

// 环境必须在**动态 import 之前**设置
process.env.AGENT_DB_PATH = ':memory:'

// 外部依赖全部 mock：本文件只验证记忆编排逻辑，不打真实模型 / embedding 接口
vi.mock('../rag/embed', () => ({ embedTexts: vi.fn() }))
vi.mock('../agent/openaiClient', () => ({ chatCompletion: vi.fn() }))

const { embedTexts } = await import('../rag/embed')
const { chatCompletion } = await import('../agent/openaiClient')
const { composeSystemMessage, recallMemories, rememberConversation } = await import('./index')
const { getMemory, upsertMemory } = await import('./store')
const { getDb } = await import('../store/db')

const embedMock = vi.mocked(embedTexts)
const completionMock = vi.mocked(chatCompletion)

beforeEach(() => {
  vi.clearAllMocks()
  getDb().exec('DELETE FROM memory')
})

/** 构造 n 条有效消息 */
function messages(n: number): Array<{ role: 'user' | 'assistant'; content: string }> {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
    content: `第 ${i} 条`,
  }))
}

describe('composeSystemMessage', () => {
  it('没有记忆时原样返回（undefined 也是 undefined）', () => {
    expect(composeSystemMessage('你是助手', [])).toBe('你是助手')
    expect(composeSystemMessage(undefined, [])).toBeUndefined()
  })

  it('有记忆时追加在原文之后，保留原文', () => {
    const result = composeSystemMessage('你是助手', ['用户在做 Agent 工作台'])
    expect(result).toContain('你是助手')
    expect(result).toContain('用户在做 Agent 工作台')
    expect(result!.indexOf('你是助手')).toBeLessThan(result!.indexOf('用户在做 Agent 工作台'))
  })

  it('原本没有 system message 时也能独立成块', () => {
    const result = composeSystemMessage(undefined, ['记忆一', '记忆二'])
    expect(result).toContain('记忆一')
    expect(result).toContain('记忆二')
  })
})

describe('recallMemories', () => {
  it('按相似度返回摘要文本', async () => {
    embedMock.mockResolvedValue([[1, 0, 0]])
    upsertMemory({ userId: 1, conversationId: 1, summary: '相关记忆', embedding: [1, 0, 0], messageCount: 6 })
    upsertMemory({ userId: 1, conversationId: 2, summary: '无关记忆', embedding: [0, 0, 1], messageCount: 6 })

    const result = await recallMemories(1, '查询内容', 1)
    expect(result).toEqual(['相关记忆'])
  })

  it('embedding 接口失败时静默返回空数组', async () => {
    embedMock.mockRejectedValue(new Error('EMBEDDING_API_KEY 缺失'))

    await expect(recallMemories(1, '查询内容')).resolves.toEqual([])
  })

  it('embedding 返回空向量时返回空数组', async () => {
    embedMock.mockResolvedValue([[]])

    await expect(recallMemories(1, '查询内容')).resolves.toEqual([])
  })

  it('userId 或 query 非法时直接返回空数组，不调用 embedding', async () => {
    await expect(recallMemories(0, '查询内容')).resolves.toEqual([])
    await expect(recallMemories(1, '   ')).resolves.toEqual([])
    expect(embedMock).not.toHaveBeenCalled()
  })
})

describe('rememberConversation', () => {
  it('消息不足 6 条时不摘要、不调用模型', async () => {
    await expect(rememberConversation({ userId: 1, conversationId: 10, messages: messages(4) })).resolves.toBe(false)
    expect(completionMock).not.toHaveBeenCalled()
    expect(getMemory(1, 10)).toBeNull()
  })

  it('正常路径：生成摘要并连同向量入库', async () => {
    completionMock.mockResolvedValue({ content: '  用户在做 Agent 工作台  ', toolCalls: [], finishReason: 'stop' })
    embedMock.mockResolvedValue([[1, 0]])

    await expect(rememberConversation({ userId: 1, conversationId: 10, messages: messages(6) })).resolves.toBe(true)

    const row = getMemory(1, 10)
    expect(row!.summary).toBe('用户在做 Agent 工作台') // 已 trim
    expect(row!.messageCount).toBe(6)
  })

  it('距上次摘要新增不足 4 条时跳过，避免重复花模型调用', async () => {
    completionMock.mockResolvedValue({ content: '摘要', toolCalls: [], finishReason: 'stop' })
    embedMock.mockResolvedValue([[1, 0]])
    await rememberConversation({ userId: 1, conversationId: 10, messages: messages(6) })
    expect(completionMock).toHaveBeenCalledTimes(1)

    // 只多了 2 条：跳过
    await expect(rememberConversation({ userId: 1, conversationId: 10, messages: messages(8) })).resolves.toBe(false)
    expect(completionMock).toHaveBeenCalledTimes(1)

    // 累计新增 4 条：重新摘要
    await expect(rememberConversation({ userId: 1, conversationId: 10, messages: messages(10) })).resolves.toBe(true)
    expect(completionMock).toHaveBeenCalledTimes(2)
    expect(getMemory(1, 10)!.messageCount).toBe(10)
  })

  it('条数不再增长（前端截断历史）但已超过刷新间隔时仍会重摘', async () => {
    completionMock.mockResolvedValue({ content: '摘要', toolCalls: [], finishReason: 'stop' })
    embedMock.mockResolvedValue([[1, 0]])
    await rememberConversation({ userId: 1, conversationId: 10, messages: messages(6) })

    // 模拟 11 分钟前的旧记忆：历史被截断在 6 条，条数差为 0，但时间到了
    getDb().prepare('UPDATE memory SET created_at = ? WHERE user_id = ? AND conversation_id = ?')
      .run(Date.now() - 11 * 60 * 1000, 1, 10)

    await expect(rememberConversation({ userId: 1, conversationId: 10, messages: messages(6) })).resolves.toBe(true)
    expect(completionMock).toHaveBeenCalledTimes(2)
  })

  it('embedding 失败时仍保留摘要（向量为 NULL，暂不可召回）', async () => {
    completionMock.mockResolvedValue({ content: '摘要正文', toolCalls: [], finishReason: 'stop' })
    embedMock.mockRejectedValue(new Error('embedding 接口失败'))

    await expect(rememberConversation({ userId: 1, conversationId: 10, messages: messages(6) })).resolves.toBe(true)
    expect(getMemory(1, 10)!.summary).toBe('摘要正文')

    // 再次调用不会重复摘要（message_count 已记录）
    completionMock.mockClear()
    await expect(rememberConversation({ userId: 1, conversationId: 10, messages: messages(6) })).resolves.toBe(false)
    expect(completionMock).not.toHaveBeenCalled()
  })

  it('模型调用失败时返回 false 且不写库', async () => {
    completionMock.mockRejectedValue(new Error('HTTP 500'))

    await expect(rememberConversation({ userId: 1, conversationId: 10, messages: messages(6) })).resolves.toBe(false)
    expect(getMemory(1, 10)).toBeNull()
  })

  it('模型返回空内容时返回 false', async () => {
    completionMock.mockResolvedValue({ content: '   ', toolCalls: [], finishReason: 'stop' })

    await expect(rememberConversation({ userId: 1, conversationId: 10, messages: messages(6) })).resolves.toBe(false)
    expect(getMemory(1, 10)).toBeNull()
  })

  it('空内容消息不计入条数，也不进入摘要输入', async () => {
    completionMock.mockResolvedValue({ content: '摘要', toolCalls: [], finishReason: 'stop' })
    embedMock.mockResolvedValue([[1, 0]])

    const withBlanks = [...messages(5), { role: 'user' as const, content: '   ' }]
    await expect(rememberConversation({ userId: 1, conversationId: 10, messages: withBlanks })).resolves.toBe(false)
    expect(completionMock).not.toHaveBeenCalled()
  })

  it('多模态消息：带文字的计入条数并把文字写进摘要，纯图片的不计入（13.1）', async () => {
    completionMock.mockResolvedValue({ content: '摘要', toolCalls: [], finishReason: 'stop' })
    embedMock.mockResolvedValue([[1, 0]])

    const withImage = [
      ...messages(5),
      { role: 'user' as const, content: [{ type: 'text' as const, text: '这张图是架构图' }] },
    ]
    await expect(rememberConversation({ userId: 1, conversationId: 10, messages: withImage })).resolves.toBe(true)
    const transcript = completionMock.mock.calls[0][0].messages.map(m => String(m.content)).join(' ')
    expect(transcript).toContain('这张图是架构图')

    // 纯图片（没有一个字）不该被算成一条有效消息
    completionMock.mockClear()
    const imageOnly = [
      ...messages(5),
      { role: 'user' as const, content: [{ type: 'image_url' as const, image_url: { url: 'data:image/png;base64,AAAA' } }] },
    ]
    await expect(rememberConversation({ userId: 1, conversationId: 11, messages: imageOnly })).resolves.toBe(false)
    expect(completionMock).not.toHaveBeenCalled()
  })

  it('userId / conversationId 非法时直接返回 false', async () => {
    await expect(rememberConversation({ userId: 0, conversationId: 10, messages: messages(6) })).resolves.toBe(false)
    await expect(rememberConversation({ userId: 1, conversationId: 0, messages: messages(6) })).resolves.toBe(false)
    expect(completionMock).not.toHaveBeenCalled()
  })
})
