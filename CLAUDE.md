# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目形态

chatgpt-web v2.11.1（Vue3 + naive-ui）的 Agent 化升级版，项目名「思脉AI工作台 / pulse · agent console」。

**双 package 结构**：根目录是前端，`service/` 是 Express 后端，两边各自独立 `pnpm install`，**没有一键启动脚本，必须开两个终端**。

## 常用命令

```bash
# 前端（仓库根目录）
pnpm dev          # vite dev server → http://localhost:1002
pnpm build        # run-p type-check build-only
pnpm type-check   # vue-tsc --noEmit
pnpm lint         # eslint .

# 后端（service/）
pnpm start        # esno ./src/index.ts（单次）→ http://localhost:3002
pnpm dev          # esno watch ./src/index.ts（热重载）
pnpm type-check   # tsc --noEmit
pnpm test         # vitest run（39 例 / 10 文件）
pnpm lint         # eslint .
pnpm ingest       # 扫描 knowledge/ → embedding → 写入向量库

# 跑单个测试文件
cd service && pnpm vitest run src/agent/loop.test.ts
```

## 架构

### 两条并行的对话链路

`service/src/index.ts` 里同时挂着两套，**改的时候别串**：

- `POST /chat-process` — 原有普通对话，逐行 JSON（非 SSE）
- `POST /agent-process` — Agent 模式，SSE（`text/event-stream`）逐事件推送

另有 `/config`、`/session`、`/verify`。路由同时挂在 `''` 和 `/api` 两个前缀下（`index.ts:122-123`），前端通过 vite 代理走 `/api`。

### Agent 内核调用链

```
agent/openaiClient.ts  chatCompletion()  非流式 OpenAI 兼容封装；OpenAIError 包装 HTTP 状态 + 截断 body
        ↓
agent/loop.ts          runAgent()        ReAct while 循环：模型 → tool_calls → 执行 → role:'tool' 回填
        ↓
agent/registry.ts      register/list/get/toOpenAITools()
        ↓
tools/*.ts             calculator / getTime / webSearch / readFile / ragSearch
```

- `agent/types.ts` 的 `AgentEvent` 是判别联合：`thought | tool_call | tool_result | answer | error`
- 工具在 `tools/index.ts` 统一 import 完成自注册；`index.ts:10` 靠 `import './tools'` 的副作用触发
- 熔断：`AGENT_MAX_STEPS`（步数）+ `AGENT_TOKEN_BUDGET`（token），超限注入 BREAKER_PROMPT 强制收尾
- 自愈：工具抛错时把错误文本作为 tool result 回填，让模型自行修正

### 配置读取

`service/src/utils/config.ts` 导出 `agentConfig`，**`dotenv.config()` 在这里和 `chatgpt/index.ts` 各调用一次** —— 依赖 `process.cwd()`，所以服务必须从 `service/` 目录启动。

### RAG 链路

`rag/chunk.ts`（切块，500 字 + 50 重叠）→ `rag/embed.ts`（向量化）→ `rag/store.ts`（内存 + JSON 持久化到 `service/data/vectors.json`，已 gitignore）→ 作为 `tools/ragSearch.ts` 接入。

embedding 不可用时（缺 key / 接口失败）自动降级为关键词匹配，不抛错。

### MCP 兼容层

`service/src/mcp/` 启动时按 `MCP_SERVERS` 环境变量拉取远端工具并桥接进 registry，单 server 失败不影响其他，格式非法静默忽略。

### 前端 Agent 链路

`src/api/index.ts` 的 `fetchAgentProcess()` 解析 SSE → `src/store/modules/settings` 的 `agentMode`（持久化）→ `src/views/chat/components/Message/ToolCallCard.vue` 渲染步骤流。

**注意**：Header 里的 Agent 开关仅在 `isMobile` 时渲染，桌面端的开关是底部工具栏的机器人图标。

## 坑与约束

### 根 `.env` 必须存在（新克隆必丢）

被根 `.gitignore` 忽略，所以重新拉代码后会消失。缺了它 `VITE_GLOB_API_URL` 为 `undefined` → axios 不带 `/api` 前缀 → 请求打到 `/session` 而非 `/api/session` → vite 代理只匹配 `/api` → **404 → 前端跳 `/500`**。

四个变量：`VITE_GLOB_API_URL=/api`、`VITE_APP_API_BASE_URL=http://127.0.0.1:3002/`、`VITE_GLOB_OPEN_LONG_REPLY=false`、`VITE_GLOB_APP_PWA=false`。

### pnpm 11 拦截构建脚本

pnpm 11 默认不跑依赖的 postinstall，而 `runDepsStatusCheck` 在**任何** `pnpm <脚本>` 之前都会执行 `pnpm install` —— 后者一旦 exit 1，**所有 pnpm 脚本全部 exit 1**（不只是 `pnpm dev`）。

放行配置写在 `pnpm-workspace.yaml`（前后端各一份）：

```yaml
allowBuilds:
  esbuild: true
  vue-demi: true # 仅前端需要
```

**不要**写进 `package.json` 的 `pnpm` 字段 —— pnpm 11 已不再读取，只会打印 warning 并忽略。

### Windows 进程残留（高频）

`esno watch` 为热重载会 spawn 孙进程，结束时杀不掉，导致端口残留、**旧代码继续服务新请求**（极难排查）。必须手动按 PID 杀：

```bash
netstat -ano | findstr :3002
taskkill /F /PID <PID>
```

vite 遇到端口占用**会静默顺延**到 1003/1004，所以「页面打开了但行为不对」时先确认端口对不对。

### 其他

- `service/.npmrc` 的 `store-dir` 是沙箱规避（默认 store 路径被限制），别删
- PowerShell 下 `curl -d` 的引号会被吞，改用 `--data @file`
- embedding 必须用独立服务商（DeepSeek 无 embedding 接口），配 `EMBEDDING_API_KEY` / `EMBEDDING_API_BASE_URL` / `EMBEDDING_MODEL`

### 护栏（来自 workflow.md）

- 现有 `/chat-process` 端点与普通对话功能**任何时候都不能坏**
- API key 只走 `.env`，严禁硬编码、严禁提交 `.env`
- 每轮改动结束时 `type-check` 必须通过

## 扩展约定

**加一个新工具**：新建 `service/src/tools/<name>.ts` 定义 `Tool`（name / description / parameters JSON Schema / handler）→ 在 `tools/index.ts` 注册 → 配套 `<name>.test.ts`。

**进度记录**：`PROGRESS.md` 每轮追加一行 `- [日期] 完成 <任务名>：<结果 / 留下的坑>`；`workflow.md` 是迭代协议与任务清单。
