import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { readFileTool } from './readFile'

const REPO_ROOT = path.resolve(process.cwd(), '..')
const TEST_DIR = path.join(REPO_ROOT, 'service', 'data')
const BIG_FILE = path.join(TEST_DIR, 'readfile-big.txt')

afterAll(async () => {
  await fs.rm(BIG_FILE, { force: true })
})

describe('read_file', () => {
  it('读取仓库内文件', async () => {
    const content = await readFileTool.handler({ path: 'service/package.json' })
    expect(content).toContain('"name"')
  })

  it('拒绝 .. 逃逸', async () => {
    await expect(readFileTool.handler({ path: '../../Windows/win.ini' })).rejects.toThrow('超出仓库范围')
  })

  it('拒绝仓库外绝对路径', async () => {
    await expect(readFileTool.handler({ path: 'C:\\Windows\\win.ini' })).rejects.toThrow('超出仓库范围')
  })

  it('文件不存在抛错', async () => {
    await expect(readFileTool.handler({ path: 'no-such-file-xyz.md' })).rejects.toThrow('文件不存在')
  })

  it('超过 100KB 上限抛错', async () => {
    await fs.mkdir(TEST_DIR, { recursive: true })
    await fs.writeFile(BIG_FILE, 'x'.repeat(100 * 1024 + 1))
    const relative = path.relative(REPO_ROOT, BIG_FILE).split(path.sep).join('/')
    await expect(readFileTool.handler({ path: relative })).rejects.toThrow('100KB')
  })
})
