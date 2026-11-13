// Shapes used by the playground. They follow the OpenAI chat format plus the MolochAI extensions
// (`name` and `available` on models, `reasoning_content` on messages and deltas).

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatMessage {
  role: Role
  content: string | null
  reasoning_content?: string
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  stream?: boolean
  temperature?: number
  top_p?: number
  tools?: unknown[]
  tool_choice?: unknown
}

export interface Usage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export interface ModelInfo {
  id: string
  name?: string
  available?: boolean
}

export interface AccountModel {
  id: string
  name?: string
  available?: boolean
  context_limit?: number | null
}

export interface AccountInfo {
  plan?: string | null
  plan_expires_at?: string | null
  tier?: string | null
  context_limit?: number | null
  default_model?: string | null
  models?: AccountModel[]
}

/** Parsed from a `: queued · position 2 of 3 · waiting 4s` comment line. */
export interface QueueInfo {
  position: number
  total: number
  waitingSeconds: number | null
  text: string
}
