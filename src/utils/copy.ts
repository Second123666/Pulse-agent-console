/**
 * 复制文本到剪贴板。
 *
 * 主路径是 Clipboard API —— 但它**只在安全上下文可用**（HTTPS 或 localhost），
 * 且可能因权限被拒、文档失焦而 reject，所以两条失败路径都兜到已废弃的
 * `document.execCommand('copy')`。
 *
 * 两条路都失败时 **reject**，不静默：调用方需要据此给出「复制失败」反馈，
 * 否则用户点了按钮什么也没发生，无从判断是没复制上还是没点到。
 */
export async function copyToClip(text: string): Promise<string> {
  // 主路径：Clipboard API
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return text
    }
    catch {
      // 落到下面的降级路径
    }
  }

  // 降级路径：execCommand（非安全上下文 / 老浏览器）
  return new Promise<string>((resolve, reject) => {
    try {
      const input = document.createElement('textarea')
      input.setAttribute('readonly', 'readonly')
      input.value = text
      // 固定定位 + 全透明：避免插入/选中时页面跳动或闪一下
      input.style.position = 'fixed'
      input.style.top = '0'
      input.style.opacity = '0'
      document.body.appendChild(input)
      input.select()

      const ok = document.execCommand('copy')
      document.body.removeChild(input)

      if (ok)
        resolve(text)
      else
        reject(new Error('execCommand("copy") 返回 false'))
    }
    catch (error) {
      reject(error)
    }
  })
}
