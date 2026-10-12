declare namespace Chat {

	interface AgentStep {
		type: 'thought' | 'tool_call' | 'tool_result' | 'tool_approval'
		content?: string
		id?: string
		name?: string
		arguments?: string
		/** 仅 tool_approval：展示给用户的审批理由 */
		reason?: string
		/** 仅 tool_approval：undefined = 待决策，true = 已批准，false = 已拒绝/超时 */
		approved?: boolean
	}

	/** 单轮模型调用的用量与耗时 */
	interface AgentUsageStep {
		turn: number
		promptTokens: number
		completionTokens: number
		durationMs: number
	}

	/** 一次 Agent 运行的累计用量（随 answer 事件带出，落盘于消息 meta 以便刷新后仍可见） */
	interface AgentUsage {
		promptTokens: number
		completionTokens: number
		totalTokens: number
		durationMs: number
		steps: AgentUsageStep[]
	}

	interface Chat {
		/**
		 * 渲染用稳定 id（14.1）：虚拟列表的 key 用它，**不能用下标** ——
		 * 下标会在删除中间消息后整体前移，让高度缓存认错人（错位直到重新测量）。
		 * 只在内存里生成，**不进服务端 meta**：刷新后整体水合，key 全换一遍无所谓
		 */
		id?: string
		dateTime: string
		text: string
		inversion?: boolean
		error?: boolean
		loading?: boolean
		quote?: string
		/** Agent 模式的思考与工具调用步骤流 */
		agentSteps?: AgentStep[]
		/** Agent 连接静默超时标记（超过 N 秒无事件），用于提示「连接可能已中断」+ 手动重试 */
		agentStalled?: boolean
		/** 本轮的 token 用量与耗时（仅 Agent 模式，随 answer 事件带回） */
		usage?: AgentUsage
		/**
		 * 本条消息附带的图片（13.3）。元素有两种形态，渲染时按前缀分辨：
		 * - `data:image/...` —— 缩略图，直接 `<img>` 显示
		 * - 其它文本 —— 落库时体积超限留下的文字占位（原图没存下来）
		 *
		 * **只进内存与服务端 meta，不进 localStorage**（见 `chat/helper.ts` 的 `setLocalState`）：
		 * 刷新后由 `hydrateFromServer` 从 `meta.images` 恢复
		 */
		images?: string[]
		conversationOptions?: ConversationRequest | null
		requestOptions: { prompt: string; options?: ConversationRequest | null }
	}

	interface History {
		title: string
		isEdit: boolean
		uuid: number
	}

	interface ChatState {
		active: number | null
		usingContext: boolean;
		history: History[]
		chat: { uuid: number; data: Chat[] }[]
	}

	interface ConversationRequest {
		conversationId?: string
		parentMessageId?: string
	}

	interface ConversationResponse {
		conversationId?: string
		detail?: {
			choices: { delta?: { content?: string }; finish_reason?: string | null }[]
		}
		id: string
		text: string
	}
}
