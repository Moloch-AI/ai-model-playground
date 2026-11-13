// Builds the chat request from the editor state, with the checks the API would otherwise reject.

import type { ChatMessage, ChatRequest, ToolCall } from './types'

export type EditorRole = 'user' | 'assistant' | 'tool'

export interface EditorMessage {
  uid: number
  role: EditorRole
  content: string
  /** Reasoning from an earlier reply, sent back as `reasoning_content` to keep it across turns. */
  reasoning?: string
  toolCalls?: ToolCall[]
  toolCallId?: string
}

export type ToolChoice = '' | 'auto' | 'none' | 'required'

export interface Params {
  /** null = not sent, so the API uses the model's default. */
  temperature: number | null
  topP: number | null
  stream: boolean
  /** JSON text of the `tools` array; empty = not sent. */
  tools: string
  toolChoice: ToolChoice
}

export interface EditorState {
  model: string
  system: string
  messages: EditorMessage[]
  params: Params
}

let nextUid = 1

/** A new editor message with a unique key for list rendering. */
export function newMessage(
  role: EditorRole,
  content = '',
  extra: Partial<EditorMessage> = {},
): EditorMessage {
  return { ...extra, uid: nextUid++, role, content }
}

export type BuildResult = { ok: true; request: ChatRequest } | { ok: false; error: string }

export function defaultParams(): Params {
  return { temperature: null, topP: null, stream: true, tools: '', toolChoice: '' }
}

export function buildChatRequest(state: EditorState): BuildResult {
  if (!state.model) return { ok: false, error: 'Pick a model first.' }

  const messages: ChatMessage[] = []
  if (state.system.trim() !== '') messages.push({ role: 'system', content: state.system })

  for (const [index, m] of state.messages.entries()) {
    const n = index + 1
    const hasToolCalls = m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0
    if (m.content.trim() === '' && !hasToolCalls && m.role !== 'tool') {
      return { ok: false, error: `Message ${n} is empty. Write something or delete it.` }
    }
    const message: ChatMessage = {
      role: m.role,
      content: m.content === '' && hasToolCalls ? null : m.content,
    }
    if (m.role === 'assistant' && m.reasoning) message.reasoning_content = m.reasoning
    if (hasToolCalls) message.tool_calls = m.toolCalls
    if (m.role === 'tool') {
      const id = (m.toolCallId ?? '').trim()
      if (!id)
        return { ok: false, error: `Message ${n} is a tool result and needs the tool_call_id it answers.` }
      message.tool_call_id = id
    }
    messages.push(message)
  }
  if (!messages.some((m) => m.role !== 'system')) {
    return { ok: false, error: 'Add at least one user message.' }
  }

  const request: ChatRequest = { model: state.model, messages, stream: state.params.stream }
  const { temperature, topP } = state.params
  if (temperature !== null) {
    if (!(temperature >= 0 && temperature <= 2))
      return { ok: false, error: 'temperature must be between 0 and 2.' }
    request.temperature = temperature
  }
  if (topP !== null) {
    if (!(topP >= 0 && topP <= 1)) return { ok: false, error: 'top_p must be between 0 and 1.' }
    request.top_p = topP
  }

  if (state.params.tools.trim() !== '') {
    let tools: unknown
    try {
      tools = JSON.parse(state.params.tools)
    } catch {
      return { ok: false, error: 'Tools is not valid JSON. It must be a JSON array of tool definitions.' }
    }
    if (!Array.isArray(tools) || tools.length === 0) {
      return { ok: false, error: 'Tools must be a non-empty JSON array of tool definitions (OpenAI format).' }
    }
    request.tools = tools
    if (state.params.toolChoice) request.tool_choice = state.params.toolChoice
  }

  return { ok: true, request }
}

/** A starting point for the tools editor (OpenAI tool format). */
export const EXAMPLE_TOOLS = JSON.stringify(
  [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Current weather for a city.',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    },
  ],
  null,
  2,
)
