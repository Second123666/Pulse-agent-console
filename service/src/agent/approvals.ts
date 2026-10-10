/**
 * 工具执行审批（human-in-the-loop）的跨请求通道。
 *
 * `/agent-process` 的 SSE 连接是**单向**的（只能服务端 → 客户端），用户的「允许/拒绝」
 * 只能从另一个 HTTP 请求（`POST /agent-approve`）回来。所以挂起的循环与决策请求之间
 * 需要一个进程内的登记表来对接：循环在此登记并 await，决策请求在此唤醒。
 *
 * 进程内 Map 即可满足：单实例部署、审批生命周期只有几十秒，重启后挂起的运行本就没有意义。
 */

/** 审批等待上限：超时未决策**视为拒绝**（fail-closed，不默认放行） */
export const APPROVAL_TIMEOUT_MS = 60 * 1000

/** 拒绝（含超时）时回填给模型的错误文本 —— 与 loop.ts 共用同一措辞 */
export const APPROVAL_DENIED_MESSAGE = '用户未批准执行'

interface PendingApproval {
  /** 发起该次运行的用户，防止他人凭 runId 替他决策 */
  userId: number
  settle: (approved: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

/** key = `${runId}:${toolCallId}`；runId 为随机 UUID，toolCallId 由模型生成 */
const pending = new Map<string, PendingApproval>()

function keyOf(runId: string, toolCallId: string): string {
  return `${runId}:${toolCallId}`
}

/**
 * 登记并挂起等待用户决策；超时按拒绝收尾。
 * 同一 key 重复登记时，先到的按拒绝收尾再覆盖 —— 否则旧 Promise 会悬挂到超时才释放。
 */
export function awaitApproval(params: {
  runId: string
  toolCallId: string
  userId: number
  timeoutMs?: number
}): Promise<boolean> {
  const { runId, toolCallId, userId, timeoutMs = APPROVAL_TIMEOUT_MS } = params
  const key = keyOf(runId, toolCallId)

  const previous = pending.get(key)
  if (previous) {
    clearTimeout(previous.timer)
    pending.delete(key)
    previous.settle(false)
  }

  return new Promise<boolean>((resolve) => {
    let settled = false
    const settle = (approved: boolean) => {
      if (settled)
        return
      settled = true
      resolve(approved)
    }
    const timer = setTimeout(() => {
      pending.delete(key)
      settle(false)
    }, timeoutMs)
    pending.set(key, { userId, settle, timer })
  })
}

export type ResolveApprovalResult = 'ok' | 'not-found' | 'forbidden'

/** 决策回传：唤醒对应挂起的循环。只有发起该次运行的同一用户才能决策 */
export function resolveApproval(params: {
  runId: string
  toolCallId: string
  userId: number
  approved: boolean
}): ResolveApprovalResult {
  const key = keyOf(params.runId, params.toolCallId)
  const entry = pending.get(key)
  if (!entry)
    return 'not-found'
  if (entry.userId !== params.userId)
    return 'forbidden'

  clearTimeout(entry.timer)
  pending.delete(key)
  entry.settle(params.approved)
  return 'ok'
}

/**
 * 一次运行结束时清空其全部待决审批，按拒绝收尾。
 * 客户端断开 / 循环异常退出时若不清理，挂起的 Promise 会一直悬到 60s 超时。
 */
export function clearRunApprovals(runId: string): number {
  const prefix = `${runId}:`
  let cleared = 0
  for (const [key, entry] of pending) {
    if (!key.startsWith(prefix))
      continue
    clearTimeout(entry.timer)
    pending.delete(key)
    entry.settle(false)
    cleared++
  }
  return cleared
}

/** 当前待决审批数（供测试断言无泄漏） */
export function pendingApprovalCount(): number {
  return pending.size
}
