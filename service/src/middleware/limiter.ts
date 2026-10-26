import { rateLimit } from 'express-rate-limit'
import { isNotEmptyString } from '../utils/is'

const MAX_REQUEST_PER_HOUR = process.env.MAX_REQUEST_PER_HOUR

const rawMax = (isNotEmptyString(MAX_REQUEST_PER_HOUR) && !isNaN(Number(MAX_REQUEST_PER_HOUR)))
  ? parseInt(MAX_REQUEST_PER_HOUR)
  : 0
// 0 语义为「不限制」，但 express-rate-limit 6.x 拒绝 0（ERR_ERL_MAX_ZERO 校验警告
// 会在启动时打印一屏堆栈），因此换算成一个足够大的上限表达同等含义。
const maxCount = rawMax > 0 ? rawMax : 1000000

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000, // Maximum number of accesses within an hour
  max: maxCount,
  statusCode: 200, // 200 means success，but the message is 'Too many request from this IP in 1 hour'
  message: async (req, res) => {
    res.send({ status: 'Fail', message: 'Too many request from this IP in 1 hour', data: null })
  },
})

/**
 * 登录/注册专用限流：防暴力破解（按 IP，15 分钟内最多 20 次失败）。
 * 与全局 limiter 不同，这里**不**受 MAX_REQUEST_PER_HOUR 影响，始终生效；
 * 且只统计失败请求，正常用户不会被自己成功登录的次数拖累。
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  skipSuccessfulRequests: true,
  statusCode: 429,
  message: { status: 'Fail', message: '尝试过于频繁，请 15 分钟后再试', data: null },
})

export { authLimiter, limiter }
