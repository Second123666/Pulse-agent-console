<script lang="ts" setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import MarkdownIt from 'markdown-it'
import MdKatex from '@vscode/markdown-it-katex'
import MdLinkAttributes from 'markdown-it-link-attributes'
import MdMermaid from 'mermaid-it-markdown'
import hljs from 'highlight.js'
import { useBasicLayout } from '@/hooks/useBasicLayout'
import { t } from '@/locales'
import { copyToClip } from '@/utils/copy'

interface Props {
  inversion?: boolean
  error?: boolean
  text?: string
  loading?: boolean
  asRawText?: boolean
}

const props = defineProps<Props>()

const { isMobile } = useBasicLayout()

const textRef = ref<HTMLElement>()

const mdi = new MarkdownIt({
  html: false,
  linkify: true,
  highlight(code, language) {
    const validLang = !!(language && hljs.getLanguage(language))
    if (validLang) {
      const lang = language ?? ''
      return highlightBlock(hljs.highlight(code, { language: lang }).value, lang)
    }
    return highlightBlock(hljs.highlightAuto(code).value, '')
  },
})

mdi.use(MdLinkAttributes, { attrs: { target: '_blank', rel: 'noopener' } }).use(MdKatex).use(MdMermaid)

const wrapClass = computed(() => {
  return [
    'text-wrap',
    'min-w-[20px]',
    'message-enter',
    isMobile.value ? 'p-2' : 'px-4 py-2.5',
    props.inversion
      ? 'rounded-2xl rounded-br-sm bg-[#0D9488] text-white dark:bg-[#0F766E] shadow-sm'
      : 'rounded-2xl rounded-tl-sm bg-white border border-[#E4E4DE] text-[#1A1D21] dark:bg-[#17191E] dark:border-[#26292F] dark:text-[#E6E8EB]',
    props.inversion ? 'message-request' : 'message-reply',
    { 'text-red-500': props.error },
  ]
})

const text = computed(() => {
  const value = props.text ?? ''
  if (!props.asRawText) {
    // 对数学公式进行处理，自动添加 $$ 符号
    const escapedText = escapeBrackets(escapeDollarNumber(value))
    return mdi.render(escapedText)
  }
  return value
})

const isThinking = computed(() => {
  return props.loading && (props.text ?? '') === t('chat.thinking')
})

/**
 * 复制图标只能写成**内联 SVG**。
 *
 * 代码块的 HTML 是 markdown-it 的 highlight 回调拼出来的字符串，经 v-html 注入，
 * 完全在 Vue 组件树之外 —— 所以用不了项目里的 SvgIcon（那是 Vue 组件）。
 * 形状是「两个叠在一起的圆角方块」，即通用的复制图标。
 */
const COPY_ICON_SVG = '<svg class="code-block-header__copy-icon" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="6" width="8" height="8" rx="1.5"/><path d="M10 6V4.5A1.5 1.5 0 0 0 8.5 3h-5A1.5 1.5 0 0 0 2 4.5v5A1.5 1.5 0 0 0 3.5 11H6"/></svg>'

function highlightBlock(str: string, lang?: string) {
  return `<pre class="code-block-wrapper"><div class="code-block-header"><span class="code-block-header__lang">${lang}</span><button type="button" class="code-block-header__copy" aria-label="${t('chat.copyCode')}">${COPY_ICON_SVG}<span class="code-block-header__copy-text">${t('chat.copyCode')}</span></button></div><code class="hljs code-block-body ${lang}">${str}</code></pre>`
}

/** 复制成功/失败提示的保留时长 */
const COPY_FEEDBACK_MS = 1000

let copyResetTimer: ReturnType<typeof setTimeout> | undefined

/**
 * 复制按钮走**事件委托**，挂在稳定的 textRef 容器上，而不是逐个按钮绑定。
 *
 * 正文是 v-html 注入的，每次重渲染都会整片替换 DOM —— 逐个 addEventListener 就得在
 * 每次 onUpdated 重新 querySelectorAll 全量节点再重绑（流式输出时每帧都触发）。
 * 委托只需挂一次，DOM 怎么换都不受影响，也就不会重复触发。
 */
function handleCopyClick(event: MouseEvent) {
  const btn = (event.target as Element | null)?.closest<HTMLElement>('.code-block-header__copy')
  const label = btn?.querySelector<HTMLElement>('.code-block-header__copy-text')
  if (!btn || !label)
    return

  // 代码正文是 header 的下一个兄弟节点（见 highlightBlock 拼出的结构）。
  // markdown-it 的围栏内容**含末尾那个换行**（闭合围栏前的一个），直接复制会比作者写的多一行，
  // 这里去掉它 —— 剪贴板内容与源码逐字节一致，粘进编辑器也不会平白多一个空行。
  // 只剥一个换行：末尾的缩进/空格是代码的一部分，不能用 trimEnd 一并削掉
  const raw = btn.parentElement?.nextElementSibling?.textContent ?? ''
  const code = raw.endsWith('\n') ? raw.slice(0, -1) : raw

  const flash = (text: string) => {
    label.textContent = text
    if (copyResetTimer)
      clearTimeout(copyResetTimer)
    copyResetTimer = setTimeout(() => {
      label.textContent = t('chat.copyCode')
    }, COPY_FEEDBACK_MS)
  }

  copyToClip(code)
    .then(() => flash(`✓ ${t('chat.copied')}`))
    .catch(() => flash(`✗ ${t('chat.copyFailed')}`))
}

function escapeDollarNumber(text: string) {
  let escapedText = ''

  for (let i = 0; i < text.length; i += 1) {
    let char = text[i]
    const nextChar = text[i + 1] || ' '

    if (char === '$' && nextChar >= '0' && nextChar <= '9')
      char = '\\$'

    escapedText += char
  }

  return escapedText
}

function escapeBrackets(text: string) {
  const pattern = /(```[\s\S]*?```|`.*?`)|\\\[([\s\S]*?[^\\])\\\]|\\\((.*?)\\\)/g
  return text.replace(pattern, (match, codeBlock, squareBracket, roundBracket) => {
    if (codeBlock)
      return codeBlock
    else if (squareBracket)
      return `$$${squareBracket}$$`
    else if (roundBracket)
      return `$${roundBracket}$`
    return match
  })
}

onMounted(() => {
  textRef.value?.addEventListener('click', handleCopyClick)
})

onUnmounted(() => {
  textRef.value?.removeEventListener('click', handleCopyClick)
  if (copyResetTimer)
    clearTimeout(copyResetTimer)
})
</script>

<template>
  <div :class="wrapClass">
    <div ref="textRef" class="leading-relaxed break-words">
      <div v-if="!inversion">
        <div v-if="isThinking" class="thinking-dots" aria-label="思考中">
          <span /><span /><span />
        </div>
        <template v-else>
          <div v-if="!asRawText" class="markdown-body" :class="{ 'markdown-body-generate': loading }" v-html="text" />
          <div v-else class="whitespace-pre-wrap" v-text="text" />
        </template>
      </div>
      <div v-else class="whitespace-pre-wrap" v-text="text" />
    </div>
  </div>
</template>

<style lang="less">
@import url(./style.less);
</style>
