// Sends one chat request through the playground server and tracks everything the UI shows:
// streamed text and reasoning, queue progress, timing, rate-limit headers and errors.

import { reactive } from 'vue'
import { apiFetch, type Fetcher } from '../lib/api'
import {
  describeHttpError,
  describeNetworkError,
  describeStreamError,
  describeTruncatedStream,
  type ErrorInfo,
} from '../lib/errors'
import { type CompletionState, createCompletionState, parseCompletion, readChatStream } from '../lib/stream'
import type { ChatRequest } from '../lib/types'

export type RunStatus = 'idle' | 'waiting' | 'streaming' | 'done' | 'stopped' | 'error'

export interface RunState {
  status: RunStatus
  streamed: boolean
  completion: CompletionState
  error: ErrorInfo | null
  httpStatus: number | null
  /** Milliseconds from sending to the first reasoning, answer or tool-call text (streaming only). */
  firstTokenMs: number | null
  totalMs: number | null
  rateLimitRemaining: string | null
  rateLimitLimit: string | null
}

function initialState(): RunState {
  return {
    status: 'idle',
    streamed: false,
    completion: createCompletionState(),
    error: null,
    httpStatus: null,
    firstTokenMs: null,
    totalMs: null,
    rateLimitRemaining: null,
    rateLimitLimit: null,
  }
}

export interface RunDeps {
  fetch?: Fetcher
  now?: () => number
}

export function useRun(deps: RunDeps = {}) {
  const fetcher = deps.fetch ?? apiFetch
  const now = deps.now ?? (() => performance.now())
  const state = reactive<RunState>(initialState())
  let controller: AbortController | null = null

  async function run(request: ChatRequest): Promise<void> {
    controller?.abort()
    const own = new AbortController()
    controller = own
    Object.assign(state, initialState(), { status: 'waiting', streamed: request.stream === true })
    const started = now()

    try {
      const res = await fetcher('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: own.signal,
      })
      state.httpStatus = res.status
      state.rateLimitRemaining = res.headers.get('x-ratelimit-remaining')
      state.rateLimitLimit = res.headers.get('x-ratelimit-limit')

      if (!res.ok) {
        state.error = describeHttpError(res.status, await res.text(), res.headers)
        state.status = 'error'
        return
      }

      const type = res.headers.get('content-type') ?? ''
      if (type.includes('text/event-stream') && res.body) {
        state.streamed = true
        state.status = 'streaming'
        const completion = state.completion
        await readChatStream(
          res.body,
          (current) => {
            if (
              state.firstTokenMs === null &&
              (current.content || current.reasoning || current.toolCalls.length > 0)
            ) {
              state.firstTokenMs = now() - started
            }
          },
          completion,
        )
        if (completion.error) {
          state.error = describeStreamError(completion.error)
          state.status = 'error'
        } else if (!completion.done) {
          state.error = describeTruncatedStream()
          state.status = 'error'
        } else {
          state.status = 'done'
        }
        return
      }

      const text = await res.text()
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        state.error = describeHttpError(502, text, res.headers)
        state.status = 'error'
        return
      }
      state.streamed = false
      state.completion = parseCompletion(json)
      state.status = 'done'
    } catch {
      // A newer run replaced this one: leave its state alone.
      if (controller !== own) return
      if (own.signal.aborted) {
        state.status = 'stopped'
      } else {
        state.error = describeNetworkError()
        state.status = 'error'
      }
    } finally {
      if (controller === own) {
        state.totalMs = now() - started
        controller = null
      }
    }
  }

  function stop(): void {
    controller?.abort()
  }

  function clear(): void {
    stop()
    Object.assign(state, initialState())
  }

  return { state, run, stop, clear }
}
