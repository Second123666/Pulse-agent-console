import { beforeEach, describe, expect, it } from 'vitest'

// 环境必须在**动态 import 之前**设置（getDb 惰性读 env，首次调用即固定路径）
process.env.AGENT_DB_PATH = ':memory:'

const { recordUsage, summarizeUsage } = await import('./store')
const { getDb } = await import('../store/db')

beforeEach(() => {
  getDb().exec('DELETE FROM usage')
})

/** 固定「现在」，让按天分组的断言可复现 */
const NOW = new Date('2026-10-10T12:00:00').getTime()
const DAY = 24 * 60 * 60 * 1000

function record(overrides: Partial<Parameters<typeof recordUsage>[0]> = {}) {
  recordUsage({
    userId: 1,
    conversationUuid: 1002,
    model: 'deepseek-flash',
    promptTokens: 100,
    completionTokens: 20,
    durationMs: 1500,
    createdAt: NOW,
    ...overrides,
  })
}

describe('recordUsage / summarizeUsage', () => {
  it('写入后能汇总出总量', () => {
    record({ promptTokens: 100, completionTokens: 20, durationMs: 1500 })
    record({ promptTokens: 300, completionTokens: 40, durationMs: 2500 })

    const summary = summarizeUsage(1, 30, NOW)
    expect(summary.total).toEqual({
      runs: 2,
      promptTokens: 400,
      completionTokens: 60,
      totalTokens: 460,
      durationMs: 4000,
    })
  })

  it('空库返回全 0 而非 null', () => {
    const summary = summarizeUsage(1, 30, NOW)
    expect(summary.total).toEqual({ runs: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, durationMs: 0 })
    expect(summary.daily).toEqual([])
    expect(summary.conversations).toEqual([])
  })

  it('按天分组：不同日期各成一行，同日累加', () => {
    record({ createdAt: NOW, promptTokens: 10, completionTokens: 1 })
    record({ createdAt: NOW - 60 * 1000, promptTokens: 20, completionTokens: 2 })
    record({ createdAt: NOW - DAY, promptTokens: 30, completionTokens: 3 })

    const summary = summarizeUsage(1, 30, NOW)
    expect(summary.daily).toHaveLength(2)
    // 日期倒序，最新在前
    expect(summary.daily[0].runs).toBe(2)
    expect(summary.daily[0].promptTokens).toBe(30)
    expect(summary.daily[1].runs).toBe(1)
    expect(summary.daily[1].promptTokens).toBe(30)
  })

  it('按会话分组：conversation_uuid 为 null 的归一组，且不与他人的混淆', () => {
    record({ conversationUuid: 1002, promptTokens: 10, completionTokens: 1 })
    record({ conversationUuid: 1002, promptTokens: 10, completionTokens: 1 })
    record({ conversationUuid: 2003, promptTokens: 5, completionTokens: 1 })
    record({ conversationUuid: null, promptTokens: 7, completionTokens: 1 })

    const summary = summarizeUsage(1, 30, NOW)
    const byUuid = new Map(summary.conversations.map(row => [row.conversationUuid, row]))
    expect(byUuid.get(1002)?.runs).toBe(2)
    expect(byUuid.get(2003)?.runs).toBe(1)
    expect(byUuid.get(null)?.runs).toBe(1)
    // 按 totalTokens 倒序
    expect(summary.conversations[0].conversationUuid).toBe(1002)
  })

  it('窗口外的记录不计入', () => {
    record({ createdAt: NOW })
    record({ createdAt: NOW - 40 * DAY })

    const summary = summarizeUsage(1, 30, NOW)
    expect(summary.total.runs).toBe(1)
  })

  it('多租户隔离：看不到别人的用量', () => {
    record({ userId: 1, promptTokens: 100, completionTokens: 20 })
    record({ userId: 2, promptTokens: 999, completionTokens: 999 })

    const summary = summarizeUsage(1, 30, NOW)
    expect(summary.total.runs).toBe(1)
    expect(summary.total.promptTokens).toBe(100)

    // 换用户读，读到的也是他自己那一份
    expect(summarizeUsage(2, 30, NOW).total.promptTokens).toBe(999)
    expect(summarizeUsage(3, 30, NOW).total.runs).toBe(0)
  })

  it('负值/非整数入参被夹到合法范围（不写坏库）', () => {
    record({ promptTokens: -5, completionTokens: -1, durationMs: -100, conversationUuid: -3 })
    const summary = summarizeUsage(1, 30, NOW)
    expect(summary.total).toMatchObject({ promptTokens: 0, completionTokens: 0, durationMs: 0 })
    expect(summary.conversations[0].conversationUuid).toBeNull()
  })
})
