import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunSink } from './runBuffer'
import {
  RUN_BUFFER_MAX_EVENTS,
  RUN_BUFFER_TTL_MS,
  appendRunEvent,
  attachRunSink,
  bufferedRunCount,
  detachRunSink,
  dropRun,
  finishRun,
  pruneRuns,
  replayRunEvents,
} from './runBuffer'

/** 固定时间基准：TTL 相关断言全部走显式 now，不依赖真实时钟 */
const T0 = new Date('2026-10-10T12:00:00').getTime()

/** 每个用例用自己的 runId，避免模块级缓冲跨用例互相污染 */
let runId = ''
let n = 0

beforeEach(() => {
  runId = `run-${++n}`
  // 缓冲是模块级单例，用例之间必须清干净：用一个远超 TTL 的 now 把所有运行都判过期
  pruneRuns(Number.MAX_SAFE_INTEGER)
})

function thought(content = 'x') {
  return { type: 'thought' as const, content }
}

describe('运行事件缓冲与重放（8.1）', () => {
  it('seq 从 1 开始单调递增，且原事件字段原样保留', () => {
    const first = appendRunEvent(runId, thought('a'), T0)
    const second = appendRunEvent(runId, thought('b'), T0)
    const third = appendRunEvent(runId, { type: 'answer', content: 'done' }, T0)

    expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3])
    expect(first).toMatchObject({ type: 'thought', content: 'a' })
    expect(third).toMatchObject({ type: 'answer', content: 'done' })
  })

  it('重放只返回 afterSeq 之后的事件', () => {
    for (let i = 0; i < 5; i++)
      appendRunEvent(runId, thought(`t${i}`), T0)

    expect(replayRunEvents(runId, 0, T0)?.map(e => e.seq)).toEqual([1, 2, 3, 4, 5])
    expect(replayRunEvents(runId, 3, T0)?.map(e => e.seq)).toEqual([4, 5])
    expect(replayRunEvents(runId, 5, T0)).toEqual([])
  })

  it('请求位置已是最新 → 空数组（可续传，只是没有新事件）', () => {
    appendRunEvent(runId, thought(), T0)
    const missed = replayRunEvents(runId, 1, T0)

    expect(missed).not.toBeNull()
    expect(missed).toEqual([])
  })

  it('未知 runId → null（无法续传，而非「没有新事件」）', () => {
    expect(replayRunEvents('never-existed', 0, T0)).toBeNull()
  })

  it('超过 TTL 后无法续传，pruneRuns 回收它', () => {
    appendRunEvent(runId, thought(), T0)

    // TTL 内仍可续传
    expect(replayRunEvents(runId, 0, T0 + RUN_BUFFER_TTL_MS - 1)).toHaveLength(1)

    const afterTtl = T0 + RUN_BUFFER_TTL_MS + 1
    expect(replayRunEvents(runId, 0, afterTtl)).toBeNull()
    expect(bufferedRunCount()).toBe(0)
  })

  it('持续写入会刷新 TTL：长任务不会在中途被回收', () => {
    appendRunEvent(runId, thought('start'), T0)
    // 每隔大半个 TTL 写一条，累计远超一个 TTL
    const midway = T0 + RUN_BUFFER_TTL_MS - 1000
    appendRunEvent(runId, thought('mid'), midway)

    expect(replayRunEvents(runId, 0, midway + RUN_BUFFER_TTL_MS - 1)?.map(e => e.seq)).toEqual([1, 2])
  })

  it('超过容量上限时淘汰最旧，且被淘汰区间无法续传（有缺口就不假装能补）', () => {
    const total = RUN_BUFFER_MAX_EVENTS + 5
    for (let i = 0; i < total; i++)
      appendRunEvent(runId, thought(`t${i}`), T0)

    // 最新一条的 seq 仍等于总条数 —— 淘汰不重置计数
    const all = replayRunEvents(runId, total - 2, T0)
    expect(all?.map(e => e.seq)).toEqual([total - 1, total])

    // 请求被淘汰掉的早期区间 → 有缺口 → null
    expect(replayRunEvents(runId, 0, T0)).toBeNull()
    // 请求位置正好紧邻最旧保留事件（seq 6 的前一条是 5）→ 连续，可续传
    expect(replayRunEvents(runId, 5, T0)).toHaveLength(RUN_BUFFER_MAX_EVENTS)
  })

  it('不同运行的 seq 互不干扰', () => {
    appendRunEvent('run-a', thought(), T0)
    appendRunEvent('run-a', thought(), T0)
    appendRunEvent('run-b', thought(), T0)

    expect(replayRunEvents('run-a', 0, T0)?.map(e => e.seq)).toEqual([1, 2])
    expect(replayRunEvents('run-b', 0, T0)?.map(e => e.seq)).toEqual([1])
    expect(bufferedRunCount()).toBe(2)
  })

  it('dropRun 之后无法续传', () => {
    appendRunEvent(runId, thought(), T0)
    dropRun(runId)

    expect(replayRunEvents(runId, 0, T0)).toBeNull()
  })

  it('pruneRuns 只回收过期的，返回回收条数', () => {
    appendRunEvent('stale', thought(), T0)
    appendRunEvent('fresh', thought(), T0 + RUN_BUFFER_TTL_MS)

    expect(pruneRuns(T0 + RUN_BUFFER_TTL_MS + 1)).toBe(1)
    expect(bufferedRunCount()).toBe(1)
  })
})

describe('事件出口（8.1 续传接手）', () => {
  /** 可观测的假出口 */
  function makeSink() {
    const sent: number[] = []
    const close = vi.fn()
    const sink: RunSink = {
      send: event => sent.push(event.seq),
      close,
    }
    return { sink, sent, close }
  }

  it('事件同时进缓冲与出口，seq 一致', () => {
    const { sink, sent } = makeSink()
    attachRunSink(runId, sink)

    appendRunEvent(runId, thought('a'), T0)
    appendRunEvent(runId, thought('b'), T0)

    expect(sent).toEqual([1, 2])
    expect(replayRunEvents(runId, 0, T0)?.map(e => e.seq)).toEqual([1, 2])
  })

  it('出口写失败只清出口，事件仍进缓冲（重连时可补齐）', () => {
    const sink: RunSink = {
      send: () => { throw new Error('socket closed') },
      close: vi.fn(),
    }
    attachRunSink(runId, sink)

    expect(() => appendRunEvent(runId, thought(), T0)).not.toThrow()
    expect(replayRunEvents(runId, 0, T0)).toHaveLength(1)
  })

  it('运行结束后挂不上出口（调用方据此收尾，不让客户端空等）', () => {
    const { sink } = makeSink()
    attachRunSink(runId, sink)
    finishRun(runId)

    const { sink: late } = makeSink()
    expect(attachRunSink(runId, late, T0)).toBe(false)
  })

  it('finishRun 关闭当前出口，但缓冲保留（客户端仍能补发到尾部事件）', () => {
    const { sink, close } = makeSink()
    attachRunSink(runId, sink)
    appendRunEvent(runId, { type: 'answer', content: 'done' }, T0)

    finishRun(runId)

    expect(close).toHaveBeenCalledTimes(1)
    expect(replayRunEvents(runId, 0, T0)?.map(e => e.seq)).toEqual([1])
  })

  it('finishRun 幂等：重复调用不会重复关闭出口', () => {
    const { sink, close } = makeSink()
    attachRunSink(runId, sink)

    finishRun(runId)
    finishRun(runId)

    expect(close).toHaveBeenCalledTimes(1)
  })

  it('摘出口按身份比对：旧连接的 close 摘不掉新接手的出口', () => {
    const { sink: oldSink } = makeSink()
    const { sink: newSink, sent, close } = makeSink()

    attachRunSink(runId, oldSink)
    attachRunSink(runId, newSink) // 续传接手
    detachRunSink(runId, oldSink) // 旧连接的 close 迟到

    appendRunEvent(runId, thought(), T0)
    expect(sent).toEqual([1])

    // 运行结束应当关的是当前出口（新连接），而不是已经死掉的那条
    finishRun(runId)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('无出口时事件只进缓冲（客户端已断，等重连来取）', () => {
    appendRunEvent(runId, thought(), T0)
    expect(replayRunEvents(runId, 0, T0)).toHaveLength(1)
  })
})
