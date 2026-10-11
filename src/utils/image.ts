/**
 * 图片附件的压缩与体积口径（workflow 13.2 上传、13.3 落库缩略图）。
 *
 * 为什么必须压：`express.json({ limit: '10mb' })` 是整包上限，而 base64 相对二进制还要膨胀约 33%。
 * 一张手机原图（3~8MB）不压直接发，光它自己就能把请求顶到上限之外。
 */

/** 长边上限。1568px 是主流视觉模型的最优长边（超过只花更多 token，不带来更多细节） */
export const MAX_IMAGE_LONG_EDGE = 1568

/** JPEG 质量。0.8 是肉眼几乎无差、体积却能砍到几分之一的档位 */
export const JPEG_QUALITY = 0.8

/** 落库缩略图的长边：气泡里只显示 96px 见方，512 在 2 倍屏上都还有余量 */
export const THUMB_LONG_EDGE = 512

/** 落库缩略图的 JPEG 质量：比发送档低半档 —— 这张只给人眼看，不给模型看 */
export const THUMB_QUALITY = 0.7

/** 一次发送最多带几张图 */
export const MAX_ATTACHMENTS = 6

/** 单张压缩后的 base64 字符上限：压到这个数还超，说明这张图压不动，只能拒 */
export const MAX_IMAGE_BASE64_CHARS = 2 * 1024 * 1024

/**
 * 一次发送里所有图片 base64 的总字符上限。
 * 上限设 6MB 而不是贴着 10MB 走 —— 剩下的 4MB 要留给 systemMessage、历史消息与 JSON 结构本身。
 */
export const MAX_TOTAL_BASE64_CHARS = 6 * 1024 * 1024

/**
 * 单条消息 `meta_json` 里图片 base64 的**合计**上限（13.3）。
 *
 * 会话同步是「整份状态原样全量推」，meta 会跟着每次同步原样上传，
 * 也原样落进 SQLite 的一行。卡死在这里，超限的几张只留文字占位 ——
 * 一张缩略图约 40KB，200KB 足够放下一轮正常带图消息的全部缩略图
 */
export const MAX_META_IMAGE_CHARS = 200 * 1024

export interface CompressedImage {
  /** `data:image/jpeg;base64,...`，直接放进 `image_url.url` */
  dataUrl: string
  /** base64 字符数（含前缀）—— 这就是实际上行的体积，用它做限额判断 */
  bytes: number
  width: number
  height: number
}

/** 字节数的可读写法（与 `Setting/Knowledge.vue` 里的同名函数口径一致） */
export function formatBytes(bytes: number): string {
  if (bytes < 1024)
    return `${bytes}B`
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`
}

/** 是不是浏览器认得的图片。`file.type` 在个别系统上会是空串，退回扩展名判断 */
export function isImageFile(file: File): boolean {
  if (file.type)
    return file.type.startsWith('image/')
  return /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(file.name)
}

/** 从任意 src（data URL 等）解码。data URL 同源，不会把 canvas 污染成不可读 */
function loadFromSrc(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片解码失败'))
    img.src = src
  })
}

/** 用 `<img>` 解码（blob URL 同源，不会把 canvas 污染成不可读） */
function loadImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file)
  return loadFromSrc(url).finally(() => URL.revokeObjectURL(url))
}

/**
 * 按 `longEdge` 等比缩放后画进 canvas。
 *
 * - **只缩不放**：已经比上限小的图按原尺寸重编码，不会被拉伸
 * - **先铺白底再画**：PNG/WebP 的透明区直接转 JPEG 会变成刺眼的黑块
 * - 尺寸无效或没有 2d 上下文一律抛 `Error`，由调用方翻成用户可读提示
 */
function drawScaled(img: HTMLImageElement, longEdge: number): HTMLCanvasElement {
  const naturalWidth = img.naturalWidth
  const naturalHeight = img.naturalHeight
  if (!naturalWidth || !naturalHeight)
    throw new Error('图片没有有效尺寸')

  const scale = Math.min(1, longEdge / Math.max(naturalWidth, naturalHeight))
  const width = Math.max(1, Math.round(naturalWidth * scale))
  const height = Math.max(1, Math.round(naturalHeight * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx)
    throw new Error('当前环境不支持 canvas')

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(img, 0, 0, width, height)
  return canvas
}

/**
 * 压成「长边 ≤ 1568 的 JPEG」。
 *
 * 失败一律抛 `Error`，由调用方转成用户可读的提示（这里不碰 UI）
 */
export async function compressImage(file: File): Promise<CompressedImage> {
  const img = await loadImage(file)
  const canvas = drawScaled(img, MAX_IMAGE_LONG_EDGE)
  // toDataURL 在 canvas 被跨源内容污染时会抛 SecurityError —— 由调用方兜成通用提示
  const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
  return { dataUrl, bytes: dataUrl.length, width: canvas.width, height: canvas.height }
}

/**
 * 把一张已经是 data URL 的图再压成**落库用的缩略图**（13.3）。
 *
 * 发送给模型的那份保持 1568px 不动（画质直接影响模型看得懂与否），
 * 消息气泡与 `meta_json` 里挂的是这一张 —— 96px 的显示位用不着 1568px 的数据
 */
export async function toThumbnail(dataUrl: string): Promise<string> {
  const img = await loadFromSrc(dataUrl)
  const canvas = drawScaled(img, THUMB_LONG_EDGE)
  return canvas.toDataURL('image/jpeg', THUMB_QUALITY)
}

/**
 * 批量转缩略图。**单张失败退回原图**，不让一张坏图把整批附件的消息挂掉 ——
 * 体积失控的部分交给落库时的 `MAX_META_IMAGE_CHARS` 兜底
 */
export async function toThumbnails(dataUrls: string[]): Promise<string[]> {
  return Promise.all(dataUrls.map(async (item) => {
    try {
      return await toThumbnail(item)
    }
    catch {
      return item
    }
  }))
}
