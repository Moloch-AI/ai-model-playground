// Turns a chat completion stream (or a non-streamed completion) into one state object:
// answer text, reasoning, tool calls, finish reason, usage, queue progress and in-stream errors.

import { parseQueueComment, type SseEvent, SseParser } from './sse'
import { splitThink } from './think'
import type { QueueInfo, ToolCall, Usage } from './types'

/** An error event sent after the stream opened (HTTP status stays 200). */
export interface StreamErrorPayload {
  type?: string
  message?: string
  [key: string]: unknown
}

export interface CompletionState {
  id: string | null
  model: string | null
  content: string
  reasoning: string
  toolCalls: ToolCall[]
  finishReason: string | null
  usage: Usage | null
  queue: QueueInfo | null
  queueNotices: number
  comments: number
  error: StreamErrorPayload | null
  done: boolean
  /** A non-streamed reply had its reasoning inline in a <think> block, split out here. */
  inlineThink: boolean
}

export type StreamEventKind = 'chunk' | 'comment' | 'queue' | 'done' | 'error' | 'ignored'

export function createCompletionState(): CompletionState {
  return {
    id: null,
    model: null,
    content: '',
    reasoning: '',
    toolCalls: [],
    finishReason: null,
    usage: null,
    queue: null,
    queueNotices: 0,
    comments: 0,
    error: null,
    done: false,
    inlineThink: false,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readUsage(value: unknown): Usage | null {
  if (!isRecord(value)) return null
  const num = (key: string) => (typeof value[key] === 'number' ? (value[key] as number) : 0)
  return {
    prompt_tokens: num('prompt_tokens'),
    completion_tokens: num('completion_tokens'),
    total_tokens: num('total_tokens'),
  }
}

/** Accumulate tool-call fragments by index (MolochAI sends them whole; other providers split them). */
export function mergeToolCallDeltas(calls: ToolCall[], deltas: unknown): void {
  if (!Array.isArray(deltas)) return
  for (const raw of deltas) {
    if (!isRecord(raw)) continue
    const index = typeof raw.index === 'number' ? raw.index : calls.length
    let call = calls[index]
    if (!call) {
      call = { id: '', type: 'function', function: { name: '', arguments: '' } }
      calls[index] = call
    }
    if (typeof raw.id === 'string' && raw.id) call.id = raw.id
    const fn = isRecord(raw.function) ? raw.function : null
    if (fn && typeof fn.name === 'string') call.function.name += fn.name
    if (fn && typeof fn.arguments === 'string') call.function.arguments += fn.arguments
  }
}

/** Apply one `chat.completion.chunk`. The usage chunk has `choices: []`. */
export function applyChunk(state: CompletionState, chunk: unknown): void {
  if (!isRecord(chunk)) return
  if (typeof chunk.id === 'string') state.id = chunk.id
  if (typeof chunk.model === 'string') state.model = chunk.model
  const usage = readUsage(chunk.usage)
  if (usage) state.usage = usage
  if (!Array.isArray(chunk.choices) || chunk.choices.length === 0) return
  const choice = chunk.choices[0]
  if (!isRecord(choice)) return
  const delta = isRecord(choice.delta) ? choice.delta : {}
  if (typeof delta.reasoning_content === 'string') state.reasoning += delta.reasoning_content
  if (typeof delta.content === 'string') state.content += delta.content
  mergeToolCallDeltas(state.toolCalls, delta.tool_calls)
  if (typeof choice.finish_reason === 'string') state.finishReason = choice.finish_reason
}

/** Apply one parsed SSE event and say what it was. */
export function applySseEvent(state: CompletionState, event: SseEvent): StreamEventKind {
  if (event.kind === 'comment') {
    state.comments++
    const queue = parseQueueComment(event.text)
    if (!queue) return 'comment'
    state.queue = queue
    state.queueNotices++
    return 'queue'
  }
  const data = event.data.trim()
  if (data === '[DONE]') {
    state.done = true
    return 'done'
  }
  let payload: unknown
  try {
    payload = JSON.parse(data)
  } catch {
    return 'ignored'
  }
  if (isRecord(payload) && isRecord(payload.error)) {
    state.error = payload.error as StreamErrorPayload
    return 'error'
  }
  applyChunk(state, payload)
  return 'chunk'
}

/**
 * Read an SSE response body to the end, updating `state` (pass a reactive object to render as
 * text arrives). `onEvent` runs after each event. Rejects with the fetch AbortError when the
 * request is aborted; whatever arrived before stays in `state`.
 */
export async function readChatStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (state: CompletionState, kind: StreamEventKind) => void = () => {},
  state: CompletionState = createCompletionState(),
): Promise<CompletionState> {
  const decoder = new TextDecoder()
  const parser = new SseParser((event) => onEvent(state, applySseEvent(state, event)))
  const reader = body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parser.push(decoder.decode(value, { stream: true }))
    }
    parser.push(decoder.decode())
    parser.end()
  } finally {
    reader.releaseLock()
  }
  return state
}

/**
 * Read a non-streamed `chat.completion`. The gateway strips inline <think> blocks only while
 * streaming, so a plain reply may carry its reasoning in `content`; it is split out here.
 */
export function parseCompletion(json: unknown): CompletionState {
  const state = createCompletionState()
  state.done = true
  if (!isRecord(json)) return state
  if (typeof json.id === 'string') state.id = json.id
  if (typeof json.model === 'string') state.model = json.model
  state.usage = readUsage(json.usage)
  const choice = Array.isArray(json.choices) ? json.choices[0] : undefined
  if (!isRecord(choice)) return state
  if (typeof choice.finish_reason === 'string') state.finishReason = choice.finish_reason
  const message = isRecord(choice.message) ? choice.message : {}
  const content = typeof message.content === 'string' ? message.content : ''
  const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : ''
  if (Array.isArray(message.tool_calls)) {
    mergeToolCallDeltas(
      state.toolCalls,
      message.tool_calls.map((call, index) => (isRecord(call) ? { index, ...call } : call)),
    )
  }
  const split = splitThink(content)
  state.content = split.content
  state.reasoning = reasoning
  if (split.found) {
    state.inlineThink = true
    state.reasoning = reasoning ? `${reasoning}\n\n${split.reasoning}` : split.reasoning
  }
  return state
}
