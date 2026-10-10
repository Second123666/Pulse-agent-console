import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Tool } from '../agent/types'

// 仓库根目录 = service/ 的上级（pnpm start / vitest 均从 service/ 启动）
const REPO_ROOT = path.resolve(process.cwd(), '..')
const MAX_BYTES = 100 * 1024

export const readFileTool: Tool = {
  name: 'read_file',
  description: '只读仓库内的文本文件（相对仓库根目录的路径），单文件不超过 100KB',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对仓库根目录的文件路径，例如 docs/README.md' },
    },
    required: ['path'],
  },
  // 读取本地文件属敏感操作（虽已限制在仓库内），执行前需用户确认
  requiresApproval: true,
  approvalReason: '读取本地仓库文件，可能包含敏感内容',
  handler: async (args) => {
    const filePath = String(args.path ?? '').trim()
    if (!filePath)
      throw new Error('path 不能为空')

    const resolved = path.resolve(REPO_ROOT, filePath)
    const relative = path.relative(REPO_ROOT, resolved)
    // 拒绝 .. 逃逸与仓库外绝对路径
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('路径超出仓库范围，禁止访问')

    let stat
    try {
      stat = await fs.stat(resolved)
    }
    catch {
      throw new Error(`文件不存在或无法访问: ${filePath}`)
    }
    if (!stat.isFile())
      throw new Error(`目标不是文件: ${filePath}`)
    if (stat.size > MAX_BYTES)
      throw new Error(`文件超过 100KB 上限（${stat.size} 字节）`)

    return await fs.readFile(resolved, 'utf-8')
  },
}
