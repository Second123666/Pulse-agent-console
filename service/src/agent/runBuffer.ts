import type { AgentEvent, SequencedAgentEvent } from './types'

/**
 * 每次运行的事件缓冲与事件出口，供 SSE 断线重连时续传（`Last-Event-ID`）。
 *
 * **为什么是纯内存**：重放是「尽力而为」的能力 —— 服务重启、超出 TTL、或事件被容量
 * 淘汰后缓冲区自然失效，前端退回「整轮重发」。落盘得不偿失：事件流是过程数据，
 * 没有任何跨进程复用价值，却要额外背上清理与一致性负担。
 *
 * **为什么收尾后不删**：客户端断线后往往是在运行**已经跑完**才重连上的
 * （网络抖一下，回答其实已经生成好了）。这时重放尾部事件正是最有价值的场景 ——
 * 删掉就等于把这轮回答丢了。因此缓冲一律只按 TTL 回收。
 *
 * **为什么还要管「出口」**：服务端未必立刻察觉断线。断网时循环可能还在跑，
 * 此时重连上来光补发旧事件是不够的，后续新事件也得有地方去 —— 出口就是「当前
 * 该往哪条连接写」，续传时由新连接接手（旧的那条已经死了）。
 */

/** 缓冲保留时长：按最后一次写入计时 */
export const RUN_BUFFER_TTL_MS = 5 * 60 * 1000

/** 单次运行最多保留的事件条数，超出淘汰最旧的 */
export const RUN_BUFFER_MAX_EVENTS = 1000

/**
 * 运行的事件出口。`send` 推事件，`close` 由缓冲在运行结束时回调 ——
 * 收尾必须走它而不是直接 `res.end()`：续传之后出口已换成新连接，写死的 res 会结束错对象
 */
export interface RunSink {
  send: (event: SequencedAgentEvent) => void
  close: () => void
}

interface BufferedRun {
  /** 已发送的事件，seq 严格递增 */
  events: SequencedAgentEvent[]
  /** 下一条事件的序号（从 1 开始）。独立计数而非用 events.length —— 淘汰后仍要保持单调 */
  nextSeq: number
  /** 最后一次写入时间。用「最后写入」而非「创建时间」，长任务才不会被中途回收 */
  updatedAt: number
  /** 运行是否已结束（正常收尾 / 中止 / 异常都算） */
  finished: boolean
  /** 当前出口；没有连接接手时为 null（事件仍进缓冲，等客户端重连来取） */
  sink: RunSink | null
}

const runs = new Map<string, BufferedRun>()

/** 回收超过 TTL 的运行，返回回收条数 */
export function pruneRuns(now = Date.now()): number {
  let removed = 0
  for (const [runId, run] of runs) {
    if (now - run.updatedAt > RUN_BUFFER_TTL_MS) {
      runs.delete(runId)
      removed += 1
    }
  }
  return removed
}

/**
 * 记录一条已发出的事件，返回盖上 seq 的版本。
 *
 * seq 在这里统一分配：loop.ts 只构造语义事件，序号是传输层的关注点，
 * 集中一处才不会出现「某个调用点忘了带序号」导致的重放错位。
 */
export function appendRunEvent(runId: string, event: AgentEvent, now = Date.now()): SequencedAgentEvent {
  pruneRuns(now)

  let run = runs.get(runId)
  if (!run) {
    run = { events: [], nextSeq: 1, updatedAt: now, finished: false, sink: null }
    runs.set(runId, run)
  }

  const sequenced: SequencedAgentEvent = { ...event, seq: run.nextSeq }
  run.nextSeq += 1
  run.events.push(sequenced)
  run.updatedAt = now

  // 超容量淘汰最旧的：重连的客户端关心的是「我刚断在哪」之后的内容，保留最近的才有意义
  if (run.events.length > RUN_BUFFER_MAX_EVENTS)
    run.events.splice(0, run.events.length - RUN_BUFFER_MAX_EVENTS)

  // 出口写失败（对端已消失）只清掉出口，缓冲照记 —— 客户端重连时仍能补齐这段
  if (run.sink) {
    try {
      run.sink.send(sequenced)
    }
    catch {
      run.sink = null
    }
  }

  return sequenced
}

/**
 * 挂上事件出口（同时作为「这次运行开始」的登记点，因此运行不存在时会新建）。
 *
 * 返回 false 表示**挂不上** —— 运行不存在或已结束，调用方应直接收尾连接，
 * 否则客户端会一直等一个永远不会再有事件的流。
 */
export function attachRunSink(runId: string, sink: RunSink, now = Date.now()): boolean {
  pruneRuns(now)

  let run = runs.get(runId)
  if (!run) {
    run = { events: [], nextSeq: 1, updatedAt: now, finished: false, sink: null }
    runs.set(runId, run)
  }

  if (run.finished)
    return false

  run.sink = sink
  return true
}

/** 摘下事件出口。带上 sink 做身份比对，避免旧连接的 close 回调把新连接摘掉 */
export function detachRunSink(runId: string, sink: RunSink): void {
  const run = runs.get(runId)
  if (run && run.sink === sink)
    run.sink = null
}

/**
 * 标记运行结束并结束当前出口。
 *
 * **缓冲保留**，只把出口关掉：客户端此后重连仍能补发到尾部事件（含定稿的 answer）。
 */
export function finishRun(runId: string): void {
  const run = runs.get(runId)
  if (!run || run.finished)
    return

  run.finished = true
  const sink = run.sink
  run.sink = null
  sink?.close()
}

/**
 * 取 `afterSeq` 之后的事件用于重放。
 *
 * 返回 **null 表示无法续传**，调用方必须据此拒绝请求，绝不能当成「没有新事件」：
 * - 该运行不在缓冲里（从未存在 / 已被 TTL 回收 / 服务重启过）
 * - 请求的位置已被容量淘汰，中间有缺口 —— 只补后半段会让前端看到断裂的事件流
 *
 * 返回**空数组是合法结果**：请求位置已经是最新，只是暂时没有新事件。
 */
export function replayRunEvents(runId: string, afterSeq: number, now = Date.now()): SequencedAgentEvent[] | null {
  pruneRuns(now)

  const run = runs.get(runId)
  if (!run)
    return null

  const firstSeq = run.events[0]?.seq
  // 缺口检测：请求位置早于「最旧保留事件」的前一条，说明中间那些已被淘汰
  if (firstSeq !== undefined && afterSeq < firstSeq - 1)
    return null

  return run.events.filter(event => event.seq > afterSeq)
}

/** 丢弃某次运行的缓冲（测试与显式清理用） */
export function dropRun(runId: string): void {
  runs.delete(runId)
}

/** 当前缓冲的运行数（观测与测试用） */
export function bufferedRunCount(): number {
  return runs.size
}
