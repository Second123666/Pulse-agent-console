// 文档切块：markdown/txt 按标题与段落切块，windowSize 字窗口 + overlapSize 字重叠

export interface TextChunk {
  id: string
  text: string
}

/** 按标题（markdown #）与空行段落切分原始文本为段 */
function splitSegments(text: string): string[] {
  const lines = text.split('\n')
  const segments: string[] = []
  let current: string[] = []

  const flush = () => {
    const segment = current.join('\n').trim()
    if (segment)
      segments.push(segment)
    current = []
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    // markdown 标题独立成段
    if (/^#{1,6}\s+/.test(line)) {
      flush()
      segments.push(line)
      continue
    }
    // 空行分隔段落
    if (!line) {
      flush()
      continue
    }
    current.push(line)
  }
  flush()
  return segments
}

/**
 * 切块：段合并成不超过 windowSize 的块；相邻块之间保留上一块末尾 overlapSize 字作为重叠。
 * 超长段落按 window - overlap 步进硬切并同样带重叠。
 */
export function chunkText(text: string, windowSize = 500, overlapSize = 50): string[] {
  const segments = splitSegments(text)
  const chunks: string[] = []
  let buffer = ''

  const flushBuffer = () => {
    if (!buffer.trim())
      return
    chunks.push(buffer)
    // 保留末尾 overlapSize 字供下一块衔接
    buffer = buffer.slice(-overlapSize)
  }

  const pushSegment = (segment: string) => {
    if (buffer.length + segment.length + 1 > windowSize)
      flushBuffer()
    buffer = buffer ? `${buffer}\n${segment}` : segment
  }

  for (const segment of segments) {
    if (segment.length <= windowSize) {
      pushSegment(segment)
      continue
    }
    // 超长段落：先 flush 当前 buffer，再按窗口重叠硬切
    flushBuffer()
    buffer = ''
    let start = 0
    while (start < segment.length) {
      chunks.push(segment.slice(start, start + windowSize))
      if (start + windowSize >= segment.length)
        break
      start += windowSize - overlapSize
    }
    buffer = segment.slice(-overlapSize)
  }
  flushBuffer()

  return chunks
}
