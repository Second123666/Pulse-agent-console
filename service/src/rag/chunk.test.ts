import { describe, expect, it } from 'vitest'
import { chunkText } from './chunk'

describe('chunkText', () => {
  it('短文本单块', () => {
    expect(chunkText('你好世界')).toEqual(['你好世界'])
  })

  it('空输入返回空数组', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   \n  ')).toEqual([])
  })

  it('长文本切成多块且每块不超过窗口', () => {
    const text = Array.from({ length: 300 }, (_, i) => `第${i}段`.repeat(10)).join('\n\n')
    const chunks = chunkText(text, 500, 50)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks)
      expect(chunk.length).toBeLessThanOrEqual(500)
  })

  it('相邻块保留 50 字重叠', () => {
    const para = '字'.repeat(1000)
    const chunks = chunkText(para, 500, 50)
    expect(chunks.length).toBeGreaterThan(1)
    for (let i = 0; i < chunks.length - 1; i++)
      expect(chunks[i + 1].startsWith(chunks[i].slice(-50))).toBe(true)
  })

  it('markdown 标题独立成段且不并入相邻内容', () => {
    const text = `# 标题一\n\n${'内容甲'.repeat(200)}\n\n## 标题二\n\n${'内容乙'.repeat(200)}`
    const chunks = chunkText(text, 200, 20)
    expect(chunks[0]).toBe('# 标题一')
    expect(chunks.some(chunk => chunk.includes('## 标题二'))).toBe(true)
    expect(chunks[0]).not.toContain('## 标题二')
  })
})
