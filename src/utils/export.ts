/**
 * 会话导出：把一段会话转成可带走的文本（Markdown / 纯文本）。
 *
 * **只用 store 里的原始 `text`（markdown 源文）**，不去反解 `v-html` 渲染后的 DOM ——
 * 渲染结果已经过 markdown-it（代码块被包成自定义结构、公式被 katex 改写、mermaid 被替换成容器），
 * 反解既丢格式又不可靠；原始文本才是唯一可信的源。
 *
 * 不引入新依赖：剥 markdown 标记用一组正则完成，够用且行为可预期。
 */

/** 导出所需的最小会话形状：标题 + 消息列表（直接从 store 取，不做任何加工） */
export interface ExportConversation {
  title: string
  messages: Chat.Chat[]
}

/** token 数简写：1234 → 1.2k（与 Message/index.vue 的展示口径保持一致） */
function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0)
    return '0'
  return value < 1000 ? String(Math.round(value)) : `${(value / 1000).toFixed(1)}k`
}

/** 耗时简写：4300 → 4.3s（不足 1 秒显示毫秒） */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0)
    return '0s'
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** 本地时区的 `YYYY-MM-DD HH:mm:ss` */
function stamp(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
}

/** 角色标签：`inversion` 为 true 表示这条是用户发出的 */
function roleLabel(inversion?: boolean): string {
  return inversion ? '用户' : '助手'
}

/** 把多行文本整体缩进成 Markdown 引用块（每行加 `> `，空行也要加，否则引用会断） */
function quote(text: string): string {
  return text
    .split('\n')
    .map(line => (line ? `> ${line}` : '>'))
    .join('\n')
}

/**
 * Agent 步骤流 → Markdown 引用块。
 *
 * 不导出这段的话，Agent 会话导出后就只剩最终回答 —— 工具调用、参数、结果、审批决策全部丢失，
 * 而「Agent 干了什么」恰恰是这类会话最值得留痕的部分。
 */
function stepsToMarkdown(steps: Chat.AgentStep[]): string {
  const blocks: string[] = []

  for (const step of steps) {
    if (step.type === 'thought' && step.content)
      blocks.push(quote(`**思考**\n${step.content}`))
    else if (step.type === 'tool_call')
      blocks.push(quote(`**工具调用** \`${step.name ?? ''}\`\n\`\`\`json\n${step.arguments ?? '{}'}\n\`\`\``))
    else if (step.type === 'tool_result' && step.content)
      blocks.push(quote(`**工具结果** \`${step.name ?? ''}\`\n\`\`\`\n${step.content}\n\`\`\``))
    else if (step.type === 'tool_approval')
      blocks.push(quote(`**审批** \`${step.name ?? ''}\` —— ${step.approved === true ? '已批准' : step.approved === false ? '已拒绝/超时' : '待决策'}${step.reason ? `（${step.reason}）` : ''}`))
  }

  return blocks.join('\n\n')
}

/** 用量行：等宽小字，用行内代码表示 */
function usageToMarkdown(usage: Chat.AgentUsage): string {
  return `\`${formatTokens(usage.promptTokens)} in · ${formatTokens(usage.completionTokens)} out · ${formatDuration(usage.durationMs)}\``
}

/** 会话 → Markdown 全文 */
export function toMarkdown(conv: ExportConversation): string {
  const lines: string[] = [
    `# ${conv.title || '未命名会话'}`,
    '',
    `> 导出时间：${stamp()}`,
    '',
    '---',
    '',
  ]

  conv.messages.forEach((item, index) => {
    lines.push(`## ${roleLabel(item.inversion)}`)
    lines.push('')

    if (item.text)
      lines.push(item.text)

    // 与界面一致：正文在上，步骤流在下
    if (item.agentSteps?.length) {
      lines.push('')
      lines.push(stepsToMarkdown(item.agentSteps))
    }

    if (item.usage && !item.inversion) {
      lines.push('')
      lines.push(usageToMarkdown(item.usage))
    }

    if (index < conv.messages.length - 1) {
      lines.push('')
      lines.push('---')
      lines.push('')
    }
  })

  return lines.join('\n')
}

/**
 * 剥掉常见 Markdown 标记，保留换行与列表结构。
 *
 * 只处理会话正文里真正会出现的语法（标题/强调/行内代码/围栏/引用/链接/图片/分隔线）；
 * 表格、脚注、HTML 等不做处理 —— 与其猜错不如原样留着，用户能看懂。
 */
function stripMarkdown(src: string): string {
  let out = src

  // 引用：行首的 > 先剥掉。
  // **必须在去围栏之前**：Agent 步骤流整段是引用块，围栏写作 `> ```json`，
  // 行首不是反引号，先去掉 `>` 才能让后面的围栏规则认出来
  out = out.replace(/^[ \t]*>[ \t]?/gm, '')
  // 围栏代码块：去掉 ``` 围栏行本身，保留代码内容（必须先于行内代码，否则行内规则会啃到围栏标记）
  out = out.replace(/^[ \t]*```[^\n]*$/gm, '')
  // 行内代码：`code` → code
  out = out.replace(/`([^`\n]+)`/g, '$1')
  // 图片：![alt](url) → alt
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  // 链接：[text](url) → text (url)，保留 URL 以免丢失信息
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
  // 标题：行首的 # 标记去掉，文字保留
  out = out.replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
  // 强调：**x** / __x__ 先剥，再剥 *x* / _x_
  out = out.replace(/(\*\*|__)(.*?)\1/g, '$2')
  out = out.replace(/(\*|_)(?!\s)(.*?)(?<!\s)\1/g, '$2')
  // 分隔线：独占一行的 --- / *** / ___ → 换成短横线，保留视觉分段
  out = out.replace(/^[ \t]*([-*_])[ \t]*\1[ \t]*\1[-*_ \t]*$/gm, '---')
  // 折叠掉因剥离产生的连续空行（超过两个换行压成两个）
  out = out.replace(/\n{3,}/g, '\n\n')

  return out.trim()
}

/** 会话 → 纯文本全文 */
export function toPlainText(conv: ExportConversation): string {
  const lines: string[] = [
    conv.title || '未命名会话',
    `导出时间：${stamp()}`,
    '='.repeat(40),
    '',
  ]

  conv.messages.forEach((item, index) => {
    lines.push(`[${roleLabel(item.inversion)}]`)
    lines.push('')

    if (item.text)
      lines.push(stripMarkdown(item.text))

    if (item.agentSteps?.length) {
      lines.push('')
      // 步骤流走同一套剥离逻辑（它本身就是 markdown 引用块）
      lines.push(stripMarkdown(stepsToMarkdown(item.agentSteps)))
    }

    if (item.usage && !item.inversion) {
      lines.push('')
      lines.push(`${formatTokens(item.usage.promptTokens)} in · ${formatTokens(item.usage.completionTokens)} out · ${formatDuration(item.usage.durationMs)}`)
    }

    if (index < conv.messages.length - 1) {
      lines.push('')
      lines.push('-'.repeat(40))
      lines.push('')
    }
  })

  return lines.join('\n')
}

/**
 * 文件名：`<会话标题>-<YYYYMMDD>.<ext>`，空标题回退 `conversation`。
 *
 * 标题来自用户输入，可能含 Windows 非法字符（`\ / : * ? " < > |`）或超长，
 * 不清理会导致浏览器静默改写成别的名字。
 */
export function buildExportFileName(title: string, ext: 'md' | 'txt'): string {
  const cleaned = (title || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim()

  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const day = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`

  return `${cleaned || 'conversation'}-${day}.${ext}`
}

/** 触发浏览器下载（Blob + 临时 <a>，与项目其余下载路径同构） */
export function downloadText(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.style.display = 'none'
  link.href = url
  link.setAttribute('download', filename)
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
