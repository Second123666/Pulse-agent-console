import type { Tool } from '../agent/types'

// 安全的表达式求值：自写递归下降解析，仅支持 + - * / % 括号与小数，禁止 eval
function evaluate(expr: string): number {
  let pos = 0
  const src = expr

  const skipSpace = () => {
    while (pos < src.length && /\s/.test(src[pos]))
      pos++
  }

  const peek = (): string => {
    skipSpace()
    return src[pos]
  }

  const parseNumber = (): number => {
    skipSpace()
    const start = pos
    while (pos < src.length && /[0-9.]/.test(src[pos]))
      pos++
    const raw = src.slice(start, pos)
    if (!raw)
      throw new Error(`位置 ${pos} 处应为数字`)
    const num = Number(raw)
    if (Number.isNaN(num))
      throw new Error(`非法数字: ${raw}`)
    return num
  }

  const parseFactor = (): number => {
    const ch = peek()
    if (ch === '-') {
      pos++
      return -parseFactor()
    }
    if (ch === '(') {
      pos++
      const value = parseExpression()
      skipSpace()
      if (src[pos] !== ')')
        throw new Error('缺少右括号 )')
      pos++
      return value
    }
    return parseNumber()
  }

  const parseTerm = (): number => {
    let value = parseFactor()
    while (true) {
      const ch = peek()
      if (ch === '*') {
        pos++
        value *= parseFactor()
      }
      else if (ch === '/') {
        pos++
        const divisor = parseFactor()
        if (divisor === 0)
          throw new Error('除数不能为 0')
        value /= divisor
      }
      else if (ch === '%') {
        pos++
        const divisor = parseFactor()
        if (divisor === 0)
          throw new Error('取模除数不能为 0')
        value %= divisor
      }
      else {
        break
      }
    }
    return value
  }

  const parseExpression = (): number => {
    let value = parseTerm()
    while (true) {
      const ch = peek()
      if (ch === '+') {
        pos++
        value += parseTerm()
      }
      else if (ch === '-') {
        pos++
        value -= parseTerm()
      }
      else {
        break
      }
    }
    return value
  }

  const result = parseExpression()
  skipSpace()
  if (pos < src.length)
    throw new Error(`位置 ${pos} 处存在无法解析的字符: ${src[pos]}`)
  return result
}

export const calculator: Tool = {
  name: 'calculator',
  description: '安全计算数学表达式（支持 + - * / % 括号与小数），返回计算结果',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: '要计算的数学表达式，例如 (1+2)*3.5' },
    },
    required: ['expression'],
  },
  handler: async (args) => {
    const expression = String(args.expression ?? '').trim()
    if (!expression)
      throw new Error('expression 不能为空')
    const raw = evaluate(expression)
    // 消除浮点误差
    return String(Math.round(raw * 1e10) / 1e10)
  },
}
