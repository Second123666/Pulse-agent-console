# AI-chat Agent 化升级 — 设计文档

日期：2026-09-19
状态：已批准（方案 A）
项目：`chatgpt-web-main`（chatgpt-web v2.11.1，Vue3 + naive-ui 前端，Express 后端）

## 目标

将现有纯对话应用升级为 Agent 项目，核心能力：

1. **工具调用（Function Calling）**：模型可调用本地工具（搜索、文件、计算等）
2. **多步自主任务循环**：ReAct 范式（思考→行动→观察→再思考）直到任务完成
3. **RAG 知识库问答**：本地轻量向量库，检索以工具形式融入推理循环

简历卖点：自研 ReAct Agent 引擎、声明式工具协议、思考链路实时可视化、失败自愈、预算熔断。

## 已确认决策

| 决策点 | 选择 |
|--------|------|
| Agent 内核 | 方案 A：后端自研轻量 ReAct 循环，不引入 LangChain |
| 模型接入 | OpenAI 兼容多模型（DeepSeek/通义/Kimi/GLM 可配置切换） |
| 执行位置 | 后端主导，前端 SSE/流式接收每步进度 |
| RAG 存储 | 本地轻量向量库（JSON/SQLite 文件） |
| 交付方式 | 开发侧 loop 工作流 md，AI 迭代重构执行 |

## 架构

```
浏览器前端 (Vue3 + naive-ui)
   │ SSE 流式
   ▼
Express 后端 (service/)
   ├─ /chat-process     现有普通对话（保留不动）
   └─ /agent-process    新增 Agent 端点
        └─ agent/AgentLoop：messages + tools + while 循环
             ├─ tools/ToolRegistry：声明式注册表（名称 → JSON Schema + handler）
             │    ├─ calculator / web_search / read_file / get_time
             │    └─ rag_search（知识库检索）
             ├─ rag/：文档切块 → embedding → 本地向量库 → 相似度检索
             └─ 每步事件流式推送：thought / tool_call / tool_result / answer / error
```

## 关键设计

### Agent 循环（ReAct）

- 维护 messages 数组，调用带 `tools` 参数的 OpenAI 兼容 chat completions
- 模型返回 `tool_calls` → 逐个执行本地 handler → 结果以 `role: 'tool'` 回填 → 继续循环
- 模型返回纯文本 → 循环结束，输出最终答复
- **熔断**：最大步数（默认 10）+ 累计 token 预算，超限强制收尾
- **失败自愈**：工具抛错时把错误信息作为 tool result 回填，让模型自行修正重试

### 工具协议（声明式）

```ts
interface Tool {
  name: string
  description: string
  parameters: JSONSchema7 // 直接传给 OpenAI tools 参数
  handler: (args: any) => Promise<string>
}
```

新工具 = 在 registry 加一条记录。

### RAG

- 文档切块（按段落 + 重叠窗口）→ 调 embedding API → 向量存本地 JSON 文件
- 检索 = 余弦相似度 top-k；embedding 不可用时降级为关键词匹配
- `rag_search` 是一个普通工具，Agent 自主决定何时查知识库

### 前端

- 聊天界面增加「Agent 模式」开关
- 工具调用渲染为折叠卡片：工具名 + 参数 + 结果
- Agent 步骤流式追加展示，最终答复复用现有 markdown 渲染

### 错误处理

- SSE 事件中区分 `error` 类型，前端红条提示
- 单工具失败不中断循环（回填错误让模型处理）；循环级失败返回部分结果 + 错误说明

### 测试

- 后端：agent loop 与工具 handler 用 vitest 单测（mock 模型 API）
- 验证命令：`cd service && pnpm type-check`、根目录 `pnpm type-check && pnpm lint`

## 实施方式

按 `workflow.md` 循环执行，每轮迭代完成一个任务，详见该文件。
