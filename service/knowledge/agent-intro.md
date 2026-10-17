# Agent 化升级说明（测试文档）

本项目在现有 ChatGPT Web 项目基础上进行 Agent 化升级，核心能力包括：

## ReAct 循环

Agent 通过「思考 → 调用工具 → 观察结果 → 继续思考」的循环完成复杂任务，
直至模型认为无需再调用工具时输出最终回答。

## 工具系统

- calculator：安全四则运算
- get_time：当前时间与时区换算
- web_search：联网搜索（走 DeepSeek Search API，复用 API_KEY）
- read_file：只读仓库内文件

## 熔断机制

当工具调用步数达到 AGENT_MAX_STEPS 或 token 消耗超过 AGENT_TOKEN_BUDGET 时，
系统注入熔断提示，要求模型立即总结收尾，防止死循环。
