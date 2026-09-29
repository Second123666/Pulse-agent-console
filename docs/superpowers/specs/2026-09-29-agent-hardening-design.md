# 思脉AI工作台 — Agent 链路加固与记忆层设计

日期：2026-09-29
状态：待批准
项目：`chatgpt-web-main`（chatgpt-web v2.11.1，Vue3 + naive-ui 前端，Express 后端）
前序：`2026-09-19-agent-upgrade-design.md`（Phase 0–5，已完成）

## 背景

Phase 0–5 已全部完成，Agent 内核（ReAct 循环、熔断、自愈、工具注册表、MCP 桥接、RAG 降级）具备可用性，`workflow.md` 的「简历可讲」判定已达标。

但一次针对流式、记忆、会话存储三条线的代码审查发现：Agent 链路是新建的，而**记忆与会话存储直接继承了 chatgpt-web 原版的单轮 + localStorage 设计**，未随 Agent 化一起升级。此外存在若干正确性与健壮性缺口，其中两处表现为「UI 在骗用户」，面试演示时容易被当场发现。

本设计覆盖这些问题，分为「链路加固」（Phase 6）、「存储与记忆层」（Phase 7）两部分，另附可选的「SSE 断点续传」（Phase 8，加分项）。

## 现状缺口

以下均为代码审查确认的结论，附证据位置。

### 流式

| 缺口 | 证据 |
|---|---|
| 上游未开流式，每个 ReAct step 需等模型完整生成 | `agent/openaiClient.ts:96-104` 一次性 `fetch` + `await response.text()`，无 `stream: true` |
| SSE 只有步骤级粒度，无 token 级增量 | `agent/types.ts:4-9` 的 `AgentEvent` 无任何 `*_delta` 类型 |
| 停止按钮停不掉后端，`runAgent` 继续跑完整个循环 | `index.ts:52-78` 未监听 `req.on('close')`；`loop.ts:45-49` 调 `chatCompletion` 时不传 `signal`（`ChatCompletionOptions.signal` 字段已存在但从未被使用） |
| 无心跳帧，长工具调用期间连接空闲 | `index.ts:59-61` 仅在有事件时写入 |
| 前端无法感知连接状态，断流后气泡永久卡在 loading | `api/index.ts:87-136` 无连接状态回调；`index.vue` 无静默超时检测，用户只能刷新页面 |
| 无断线恢复能力 | 无 `Last-Event-ID` 与事件缓冲实现，网络抖动后需整轮重发（Agent 循环有副作用，重发会重复执行工具并重复计费） |

**后果**：一个 3 步任务的首次输出可能延迟 20–40 秒，然后 `answer` 一次性整段返回。Agent 模式的交互体感**劣于**并存的普通模式 `/chat-process`（后者是逐 token 流式的），与「Agent 化升级」的定位相反。用户点击停止后 token 仍在消耗；网络抖动时前端静默卡死，且没有安全的恢复路径。

### 记忆

| 缺口 | 证据 |
|---|---|
| Agent 模式零多轮记忆，每轮失忆重启 | `index.ts:66` 硬编码 `messages: [{ role: 'user', content: prompt }]`；前端 `api/index.ts:99` body 仅 `{ prompt, systemMessage }` |
| 「上下文记忆」开关在 Agent 模式下无任何作用 | `index.vue:693-697` 渲染该开关并提示「携带历史消息」，但 `index.vue:128-174` 的 agent 分支不读 `options`、不传历史 |
| token 预算熔断对中文基本失效 | `loop.ts:29-33` 按 `字符数 / 4` 估算；中文实际约 1 字 ≈ 0.6–1 token，低估约 4 倍 |
| 无长期记忆层 | RAG 仅索引 `knowledge/` 静态文档，无法记住对话内容；无摘要压缩、无跨会话召回 |
| 工具结果无截断 | `tools/readFile.ts` 单文件上限 100KB，`tools/ragSearch.ts` 拼接 top-3，均原样进入 `messages` |

**后果**：Agent 模式无法进行任何多轮对话；`AGENT_TOKEN_BUDGET=30000` 在中文场景下需累积到 10 万+ token 才触发，5.1 的熔断实测结论对中文不成立。

### 会话存储

| 缺口 | 证据 |
|---|---|
| 全量重写 × 高频触发 | `store/modules/chat/helper.ts:4` 纯 localStorage；`store/modules/chat/index.ts:196-198` 的 `recordState()` 挂在每个 action 末尾，Agent 模式下每个 `tool_result` 触发一次全量 JSON 序列化 + 写盘 |
| 超配额异常被静默吞掉 | `utils/storage/index.ts:18` 的 `setItem` 无 try/catch，超 5MB 抛 `QuotaExceededError`；该异常冒泡至 `api/index.ts:124-129` 被「忽略无法解析的帧」的 catch 吞掉 |
| `/session` 端点不是会话存储 | `index.ts:90-99` 仅返回 `{ auth, model }`，是握手端点 |
| 后端零持久化 | `service/data/` 下仅 `vectors.json`，无数据库 |
| 两模式数据混用导致上下文错位 | agent 消息 `conversationOptions: null`（`index.vue:158`），而 `index.vue:39` 的 `conversationList` 过滤条件为 `!!item.conversationOptions`，导致普通/Agent 交替时 `lastContext` 跳过 Agent 轮次接到更早的普通轮次 |

**后果**：`QuotaExceededError` 会表现为「UI 无声停止更新」，用户与开发者均无任何线索。换浏览器即丢数据，不能多端、不能搜索、不能分享。

### 其他确认缺陷

- **`onRegenerate` 无 Agent 分支**：`index.vue:281-390` 仅调用 `fetchChatAPIProcess`，对 Agent 消息点「重新生成」会静默掉进普通模式。
- **熔断分支可能返回空回答**：`loop.ts:87-90` 在熔断后模型仍要求调用工具时，直接发出仅含「（因预算/步数限制提前截断）」的 `answer` 事件，无任何实质内容。

## 已确认决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 覆盖范围 | Phase 6（7 项）+ Phase 7（3 项）全量；Phase 8（2 项）为可选加分 | 简历故事完整，且加分项不阻塞达标 |
| 断线恢复策略 | 手动重试 + 断线状态可见；Phase 8 再做 `Last-Event-ID` 重放 | Agent 循环有副作用，自动重试会重复执行工具并重复计费 |
| 任务清单载体 | 新建 `workflow-v2.md`，`workflow.md` 归档不动 | v1 作为已完成的历史快照保留；避免 `LOOP_COMPLETE` 语义混淆 |
| 设计文档位置 | `docs/superpowers/specs/`（对齐 v1 惯例） | 保持项目既有约定 |
| 会话持久化存储 | `node:sqlite`（Node 24 内置） | 零新依赖，符合「能不加就不加」护栏；无原生编译、不动 `allowBuilds`、无 pnpm 11 摩擦 |
| 会话迁移策略 | localStorage 立即写（保持现状）+ 防抖异步同步后端 | 普通对话功能零风险；防抖顺带消除写放大问题 |
| 流式事件模型 | 新增 `text_delta` 增量通道，`thought`/`answer` 保留为定稿事件 | 向后兼容，不波及历史持久化与 `agentSteps` 写入 |

环境已验证：Node v24.14.0，`node:sqlite` 无需 flag 可直接使用（仅输出一条 `ExperimentalWarning`）。

## 架构

```
浏览器前端 (Vue3 + naive-ui)
   │ ① 传历史 messages（6.1）
   │ ② 收 text_delta 实时渲染 + thought/answer 定稿（6.2）
   │ ③ AbortSignal 双向联动（6.3）
   │ ④ 连接状态机 + 静默超时检测 + 断线重试（6.7）
   │ ⑤ 双写：localStorage 立即 + 防抖同步后端（7.1）
   ▼
Express 后端 (service/)
   ├─ /chat-process      普通对话（全程不动）
   ├─ /agent-process     Agent 端点
   │    └─ agent/loop.ts  ReAct 循环
   │         ├─ openaiClient.chatCompletionStream()   ← 新增，上游流式
   │         ├─ 工具结果截断（7.3，单点）
   │         └─ 熔断：tool_choice:'none' 强制文本收尾
   ├─ /conversation/*    会话 CRUD（7.1，新增）
   └─ memory/            长期记忆（7.2，新增）
        ├─ 摘要生成（会话结束时）
        ├─ 召回（新会话按 embedding 相似度）
        └─ 存储 → node:sqlite
```

### 长期记忆分三层

| 层 | 内容 | 实现 |
|---|---|---|
| 工作记忆 | 当前会话历史 | 6.1 传入 + 滑动窗口 |
| 长期记忆 | 跨会话摘要 | 会话结束生成摘要 → 存 SQLite → 新会话按 embedding 召回 top-k 注入 system message |
| 语义记忆 | `knowledge/` 文档 | 现有 RAG，**本次不动** |

召回复用 `rag/embed.ts` 与 `rag/store.ts` 的余弦相似度实现，**不新建第二个向量库**。embedding 不可用时静默跳过召回（与现有 RAG 降级策略一致）。

## 关键设计

### 流式事件模型

新增一条增量通道，不改动现有事件契约：

```
新增:  text_delta { content }    模型增量输出，仅用于实时渲染
保留:  thought / answer          定稿事件，仍是唯一事实来源
```

前端消费顺序：

1. 收到 `text_delta` → 追加到当前气泡的实时缓冲区并渲染
2. 收到 `thought` → 将缓冲区内容移入 `agentSteps`，清空缓冲区
3. 收到 `answer` → 用完整文本覆盖缓冲区并定稿

**为什么不改 `thought`/`answer` 本身**：它们是历史持久化与 `agentSteps` 的写入依据，改动会波及 6.4 与 7.1。新增通道即向后兼容。

上游侧新增 `chatCompletionStream()`，与 `chatCompletion()` 返回同构的 `ChatCompletionResult`，使 `loop.ts` 的改动面最小。

> **实现坑（必须注意）**：流式响应中 `tool_calls` 是分片下发的。`delta.tool_calls[i].function.arguments` 是**逐段字符串**，须按 `index` 累积拼接；`id` 与 `name` 仅出现在首片，后续片只有 `arguments`。直接覆盖会导致工具参数残缺。

### 中断与心跳

- `AgentRunOptions` 增加 `signal?: AbortSignal`，透传至 `chatCompletionStream`
- `index.ts` 中 `req.on('close', () => controller.abort())`
- SSE 每 15 秒写入 `: ping\n\n` 注释帧（SSE 规范中注释帧被客户端忽略，仅用于保活）

### 连接韧性

分两层，**服务端保活**与**客户端感知**解决的是不同问题，缺一不可：

| 层 | 问题 | 方案 |
|---|---|---|
| 服务端（6.3） | 长工具调用期间连接空闲，可能被中间层掐断 | 15s `: ping\n\n` 注释帧保活 |
| 客户端（6.7） | 流真的断了，前端无法感知，气泡永久 loading | 连接状态机 `connecting → live → stalled / closed` + 静默超时检测（30s）+ 气泡内断线提示与重试按钮 |

**断线重试为手动触发，不做自动重试**：Agent 循环有副作用（工具已执行、token 已消耗），自动重试会重复执行整个循环并重复计费。这是与普通对话链路的关键差异。

**断点续传（Phase 8，可选）**：服务端按 `runId` 缓冲已发事件（TTL 5 分钟），客户端以 `Last-Event-ID` 重连时只重放缺失事件，**不重新执行 Agent 循环** —— 这正是"重放而非重跑"的价值所在。`AgentEvent` 增加单调递增 `seq` 字段，属纯增量改动。

### 存储健壮性

三处修改：

1. `utils/storage/index.ts` 的 `set()` 包裹 try/catch，捕获 `QuotaExceededError` 并降级（不再抛出）
2. `api/index.ts:124-129` 的 catch 收窄为仅捕获 `JSON.parse` 异常 —— 当前写法会吞掉 `onEvent` 回调内的所有异常，是静默失败的根源
3. `agentSteps` 落盘前裁剪：`tool_result` 的 `content` 超过阈值时存截断版本

### 熔断修正

`loop.ts` 熔断后若模型仍返回 `tool_calls`，不再直接返回光秃秃的截断提示，而是**再发一次请求并置 `tool_choice: 'none'`**，强制模型输出文本总结。多一次调用，换回一个真实回答。

### token 估算中文化

按 CJK 与非 CJK 分开计权：

```
tokens ≈ CJK字符数 × 1 + 非CJK字符数 / 4
```

CJK 系数 1 为保守上界（现代 tokenizer 实测约 0.6–1）。系数提取为常量便于后续按实测调整。

## 错误处理

- 流式中断（用户停止）：前端按 `AbortError` 静默处理，不显示错误条；后端 `abort` 后正常 `res.end()`
- 上游流式解析失败：降级为抛出 `OpenAIError`，由 `runAgent` 的既有错误路径处理
- SQLite 写入失败：记录日志，不影响对话主流程（持久化是增强，不是依赖）
- 长期记忆召回失败：静默跳过，对话照常进行
- 存储超配额：降级为不写 localStorage，内存态继续工作

## 护栏（本阶段新增）

除继承 `workflow.md` 原有四条护栏外，新增：

- **Phase 6 期间 `/agent-process` 的事件契约不得破坏**：`thought`/`tool_call`/`tool_result`/`answer`/`error` 的字段与语义保持兼容，`text_delta` 为纯增量。理由：前端 `agentSteps` 持久化依赖这些字段，破坏契约会使历史会话无法回放
- **Phase 7 引入 `node:sqlite` 须在 `PROGRESS.md` 说明理由**（依原护栏「新依赖需说明理由」，虽非 npm 依赖，但属新增运行时能力）

## 测试策略

| 层次 | 方式 |
|---|---|
| 后端单测 | vitest，新增 `openaiClient` 流式解析（含 tool_calls 分片累积）、token 估算、工具结果截断、摘要生成的用例；沿用假 client 注入模式 |
| 前端 | 类型检查 + lint（无单测基建，维持现状） |
| 端到端 | 每项任务附手动验证步骤，结论记入 `PROGRESS.md`（沿用 v1 惯例） |

**验证命令**：后端 `cd service && pnpm vitest run && pnpm type-check`；前端根目录 `pnpm type-check && pnpm lint`。

## 刻意不改的部分

审查中确认但**主动决定不修改**的项，记录于此以防后续迭代误改：

- **`/chat-process` 的全量帧**（`service/src/index.ts:46`）：每帧携带累计完整文本，长回复下带宽呈 O(n²)，看似浪费。实为 chatgpt-web 原版的**刻意设计** —— 每帧自包含，丢帧不损坏消息，客户端无需维护累积状态。改为增量帧会同时破坏前端解析逻辑与「普通对话不能坏」护栏，收益远小于风险
- **`src/views/chat/index.vue:220-222` 的空 catch**：普通对话链路 `onDownloadProgress` 的部分帧容错。流式响应最后一行常为半截 JSON，解析失败属预期行为。**与 6.4 要修的 `api/index.ts:124-129` 是两回事**，后者吞掉的是回调内的真实异常
- **现有 RAG 链路**：7.2 的长期记忆复用其 embedding 与余弦相似度实现，不重构

## 完成判定

- Phase 6 全部 `[x]` → 「Agent 模式真正可用」（多轮记忆、token 级流式、可中断、断线可感知、无静默失败）
- Phase 7 全部 `[x]` → 「简历故事完整」（服务端会话持久化 + 三层记忆架构）
- Phase 6 + 7 全部勾选 → 迭代协议输出 `LOOP_COMPLETE`
- Phase 8（SSE 断点续传）为加分项，任务标为 `[~]` 默认跳过，不计入达标判定

## 实施方式

按 `workflow-v2.md` 循环执行，每轮迭代完成一个任务，详见该文件。
