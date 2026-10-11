import type { MessageContent } from '../types'

/**
 * content 的三个读取口。13.1 把 `content` 从 `string` 放宽成 `string | ContentPart[]` 之后，
 * 各处「当成字符串用」的代码统一走这里，而不是各自 `Array.isArray` —— 免得漏一处就炸。
 *
 * 三者对 string 入参都**原样等价于放宽前的写法**（`contentText(c) === c`、`contentChars(c) === c.length`），
 * 所以老格式请求的行为逐字不变。
 *
 * 入参来自请求体，形状由客户端决定：所有取值都做兜底，绝不抛错。
 */

/** 取出纯文本（图片分片不参与）。用于日志、长期记忆摘要、token 估算。 */
export function contentText(content: MessageContent | null | undefined): string {
  if (typeof content === 'string')
    return content
  if (!Array.isArray(content))
    return ''
  return content
    .map(part => ((part?.type === 'text' && typeof part.text === 'string') ? part.text : ''))
    .join('')
}

/**
 * 粗略字符数，供历史截断（`MAX_CHARS`）用。
 * 图片按 data URI 的**长度**计 —— 那就是实际上行的字符数；按 0 计会把一 MB 的 base64 留在上下文里不裁。
 */
export function contentChars(content: MessageContent | null | undefined): number {
  if (typeof content === 'string')
    return content.length
  if (!Array.isArray(content))
    return 0
  return content.reduce((sum, part) => {
    if (part?.type === 'text' && typeof part.text === 'string')
      return sum + part.text.length
    if (part?.type === 'image_url' && typeof part.image_url?.url === 'string')
      return sum + part.image_url.url.length
    return sum
  }, 0)
}

/** 图片分片的数量。token 估算用（base64 长度不能当 token 数，见 loop.ts 的 IMAGE_TOKEN_ESTIMATE）。 */
export function contentImageCount(content: MessageContent | null | undefined): number {
  if (!Array.isArray(content))
    return 0
  return content.filter(part => part?.type === 'image_url').length
}
