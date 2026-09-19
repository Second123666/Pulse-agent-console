import { describe, expect, it } from 'vitest'
import { getTime } from './getTime'

describe('getTime', () => {
  it('缺省时区返回当前本地时间（符合 YYYY/MM/DD HH:mm:ss 格式）', async () => {
    const result = await getTime.handler({})
    expect(result).toMatch(/\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}/)
    expect(result).toContain(String(new Date().getFullYear()))
  })

  it('指定时区可换算', async () => {
    const utc = await getTime.handler({ timezone: 'UTC' })
    expect(utc).toMatch(/\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}/)
    const shanghai = await getTime.handler({ timezone: 'Asia/Shanghai' })
    // UTC 与上海相差 8 小时，格式化结果必然不同
    expect(shanghai).not.toBe(utc)
  })

  it('无效时区抛错', async () => {
    await expect(getTime.handler({ timezone: 'Mars/Olympus' })).rejects.toThrow('无效的时区')
  })
})
