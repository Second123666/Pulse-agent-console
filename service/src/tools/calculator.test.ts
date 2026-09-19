import { describe, expect, it } from 'vitest'
import { calculator } from './calculator'

describe('calculator', () => {
  it('四则运算与运算优先级', async () => {
    expect(await calculator.handler({ expression: '1+2*3' })).toBe('7')
    expect(await calculator.handler({ expression: '10-2-3' })).toBe('5')
    expect(await calculator.handler({ expression: '10/4' })).toBe('2.5')
    expect(await calculator.handler({ expression: '10%3' })).toBe('1')
  })

  it('括号与小数', async () => {
    expect(await calculator.handler({ expression: '(1+2)*3.5' })).toBe('10.5')
    expect(await calculator.handler({ expression: '((1+2)*(3+4))' })).toBe('21')
    expect(await calculator.handler({ expression: '0.1+0.2' })).toBe('0.3')
  })

  it('一元负号', async () => {
    expect(await calculator.handler({ expression: '-5+3' })).toBe('-2')
    expect(await calculator.handler({ expression: '2*-3' })).toBe('-6')
  })

  it('非法输入与除零抛错', async () => {
    await expect(calculator.handler({ expression: '1/0' })).rejects.toThrow('除数不能为 0')
    await expect(calculator.handler({ expression: '1%0' })).rejects.toThrow('取模除数不能为 0')
    await expect(calculator.handler({ expression: '2**3' })).rejects.toThrow()
    await expect(calculator.handler({ expression: 'abc' })).rejects.toThrow('应为数字')
    await expect(calculator.handler({ expression: '' })).rejects.toThrow('不能为空')
    await expect(calculator.handler({})).rejects.toThrow('不能为空')
  })
})
