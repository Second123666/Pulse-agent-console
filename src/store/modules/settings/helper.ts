import { ss } from '@/utils/storage'

const LOCAL_NAME = 'settingsStorage'

export interface SettingsState {
  systemMessage: string
  temperature: number
  top_p: number
  /** Agent 模式开关（持久化），开启后聊天走 /agent-process */
  agentMode: boolean
}

export function defaultSetting(): SettingsState {
  return {
    systemMessage: '你是一个乐于助人的智能助手，请仔细遵循用户的指令，并使用 markdown 格式回复。',
    temperature: 0.8,
    top_p: 1,
    agentMode: false,
  }
}

export function getLocalState(): SettingsState {
  const localSetting: SettingsState | undefined = ss.get(LOCAL_NAME)
  return { ...defaultSetting(), ...localSetting }
}

export function setLocalState(setting: SettingsState): void {
  ss.set(LOCAL_NAME, setting)
}

export function removeLocalState() {
  ss.remove(LOCAL_NAME)
}
