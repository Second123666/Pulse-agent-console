import { afterEach, describe, expect, it, vi } from 'vitest'
import { awaitApproval, clearRunApprovals, pendingApprovalCount, resolveApproval } from './approvals'

// 每个用例都从零开始：残留的待决项会让 pendingApprovalCount 断言失真
afterEach(() => {
  clearRunApprovals('run-1')
  clearRunApprovals('run-2')
  vi.useRealTimers()
})

describe('approvals', () => {
  it('决策回传唤醒挂起的等待（批准）', async () => {
    const waiting = awaitApproval({ runId: 'run-1', toolCallId: 'c1', userId: 7 })
    expect(pendingApprovalCount()).toBe(1)

    expect(resolveApproval({ runId: 'run-1', toolCallId: 'c1', userId: 7, approved: true })).toBe('ok')
    await expect(waiting).resolves.toBe(true)
    expect(pendingApprovalCount()).toBe(0)
  })

  it('拒绝同样唤醒，结果为 false', async () => {
    const waiting = awaitApproval({ runId: 'run-1', toolCallId: 'c1', userId: 7 })
    expect(resolveApproval({ runId: 'run-1', toolCallId: 'c1', userId: 7, approved: false })).toBe('ok')
    await expect(waiting).resolves.toBe(false)
  })

  it('超时未决策视为拒绝，且不留下残留登记', async () => {
    vi.useFakeTimers()
    const waiting = awaitApproval({ runId: 'run-1', toolCallId: 'c1', userId: 7, timeoutMs: 1000 })

    vi.advanceTimersByTime(999)
    expect(pendingApprovalCount()).toBe(1)

    vi.advanceTimersByTime(1)
    await expect(waiting).resolves.toBe(false)
    expect(pendingApprovalCount()).toBe(0)
  })

  it('他人不能凭 runId 替原发起人决策', async () => {
    const waiting = awaitApproval({ runId: 'run-1', toolCallId: 'c1', userId: 7 })

    expect(resolveApproval({ runId: 'run-1', toolCallId: 'c1', userId: 8, approved: true })).toBe('forbidden')
    // 被拒后仍应挂起，原发起人依然可以正常决策
    expect(pendingApprovalCount()).toBe(1)
    expect(resolveApproval({ runId: 'run-1', toolCallId: 'c1', userId: 7, approved: true })).toBe('ok')
    await expect(waiting).resolves.toBe(true)
  })

  it('未知 key 返回 not-found（运行已结束或已超时）', () => {
    expect(resolveApproval({ runId: 'nope', toolCallId: 'x', userId: 7, approved: true })).toBe('not-found')
  })

  it('clearRunApprovals 只清本 run，且按拒绝收尾', async () => {
    const a = awaitApproval({ runId: 'run-1', toolCallId: 'c1', userId: 7 })
    const b = awaitApproval({ runId: 'run-2', toolCallId: 'c1', userId: 7 })

    expect(clearRunApprovals('run-1')).toBe(1)
    await expect(a).resolves.toBe(false)
    // 另一个 run 不受影响
    expect(pendingApprovalCount()).toBe(1)
    expect(resolveApproval({ runId: 'run-2', toolCallId: 'c1', userId: 7, approved: true })).toBe('ok')
    await expect(b).resolves.toBe(true)
  })

  it('同一 key 重复登记：旧等待按拒绝收尾，不会悬挂到超时', async () => {
    const first = awaitApproval({ runId: 'run-1', toolCallId: 'c1', userId: 7 })
    const second = awaitApproval({ runId: 'run-1', toolCallId: 'c1', userId: 7 })

    await expect(first).resolves.toBe(false)
    expect(pendingApprovalCount()).toBe(1)
    expect(resolveApproval({ runId: 'run-1', toolCallId: 'c1', userId: 7, approved: true })).toBe('ok')
    await expect(second).resolves.toBe(true)
  })
})
