import type { Tool } from '../agent/types'

function formatNow(timeZone?: string): string {
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }
  if (timeZone)
    options.timeZone = timeZone
  return new Intl.DateTimeFormat('zh-CN', options).format(new Date())
}

export const getTime: Tool = {
  name: 'get_time',
  description: '返回当前日期时间，可按 IANA 时区（如 Asia/Shanghai、UTC、America/New_York）换算，缺省为本地时区',
  parameters: {
    type: 'object',
    properties: {
      timezone: { type: 'string', description: 'IANA 时区标识，缺省为服务器本地时区' },
    },
  },
  handler: async (args) => {
    const timezone = args.timezone ? String(args.timezone).trim() : ''
    try {
      return formatNow(timezone || undefined)
    }
    catch {
      throw new Error(`无效的时区: ${timezone}`)
    }
  },
}
