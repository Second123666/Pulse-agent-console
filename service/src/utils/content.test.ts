import { describe, expect, it } from 'vitest'
import { contentChars, contentImageCount, contentText } from './content'

/** 一张「10 字符 data URI」的假图 */
const IMAGE = { type: 'image_url', image_url: { url: 'data:image/png;base64,0123456789' } } as const

describe('contentText（13.1）', () => {
  it('string 入参原样返回 —— 与放宽前的直接读取逐字一致', () => {
    expect(contentText('你好')).toBe('你好')
    expect(contentText('')).toBe('')
  })

  it('null / undefined 返回空串，不抛错', () => {
    expect(contentText(null)).toBe('')
    expect(contentText(undefined)).toBe('')
  })

  it('数组只拼 text 分片，图片分片不参与', () => {
    expect(contentText([{ type: 'text', text: '图里是' }, IMAGE])).toBe('图里是')
    expect(contentText([IMAGE, { type: 'text', text: '一只猫' }, { type: 'text', text: '！' }])).toBe('一只猫！')
  })

  it('全图片消息返回空串', () => {
    expect(contentText([IMAGE])).toBe('')
  })

  it('形状不对的分片静默跳过（入参来自请求体，形状由客户端决定）', () => {
    expect(contentText([{ type: 'image_url' } as any])).toBe('')
    expect(contentText([{ type: 'text' } as any])).toBe('')
    expect(contentText(['字符串分片'] as any)).toBe('')
    expect(contentText([null] as any)).toBe('')
  })
})

describe('contentChars（13.1）', () => {
  it('string 就是 .length', () => {
    expect(contentChars('你好啊')).toBe(3)
    expect(contentChars('')).toBe(0)
  })

  it('null / undefined 为 0', () => {
    expect(contentChars(null)).toBe(0)
    expect(contentChars(undefined)).toBe(0)
  })

  it('数组按文本长度算，而不是分片个数', () => {
    // 分片个数是 1，字符数是 5 —— 用 .length 会把历史裁剪算错
    expect(contentChars([{ type: 'text', text: '你好世界' }, { type: 'text', text: '！' }])).toBe(5)
  })

  it('图片按 data URI 长度计，不能当 0 —— 否则一 MB 的图在 MAX_CHARS 裁剪里隐形', () => {
    expect(contentChars([IMAGE])).toBe(IMAGE.image_url.url.length)
    expect(contentChars([{ type: 'text', text: '看' }, IMAGE])).toBe(1 + IMAGE.image_url.url.length)
  })
})

describe('contentImageCount（13.1）', () => {
  it('string / null 不含图片', () => {
    expect(contentImageCount('你好')).toBe(0)
    expect(contentImageCount(null)).toBe(0)
  })

  it('只数 image_url 分片', () => {
    expect(contentImageCount([{ type: 'text', text: '看图' }, IMAGE, IMAGE])).toBe(2)
    expect(contentImageCount([{ type: 'text', text: '纯文本' }])).toBe(0)
  })
})
