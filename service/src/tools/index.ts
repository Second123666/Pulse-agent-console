import { register } from '../agent/registry'
import { calculator } from './calculator'

// 全部工具在此注册；服务端启动时 import './tools' 即可生效
register(calculator)
