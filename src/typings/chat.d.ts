declare namespace Chat {

	interface AgentStep {
		type: 'thought' | 'tool_call' | 'tool_result'
		content?: string
		id?: string
		name?: string
		arguments?: string
	}

	interface Chat {
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
