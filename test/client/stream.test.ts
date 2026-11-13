import { describe, expect, it } from 'vitest'
import {
  applyChunk,
  createCompletionState,
  mergeToolCallDeltas,
  parseCompletion,
  readChatStream,
} from '../../src/lib/stream'
import type { ToolCall } from '../../src/lib/types'

const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
  `data: ${JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    model: 'glm-5.3-flash',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`

const USAGE = `data: ${JSON.stringify({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  model: 'glm-5.3-flash',
  choices: [],
  usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
})}\n\n`

/** A body that delivers `bytes` in pieces of the given sizes (cycled). */
function body(text: string, sizes: number[] = [text.length]): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  let at = 0
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) {
        controller.close()
        return
      }
      const size = sizes[i++ % sizes.length] ?? 1
      controller.enqueue(bytes.slice(at, at + size))
      at += size
    },
  })
}

const FULL = [
  ': queued · position 2 of 3 · waiting 1s\n\n',
  ': queued · position 1 of 3 · waiting 2s\n\n',
  chunk({ role: 'assistant', content: '' }),
  chunk({ reasoning_content: 'Thinking ' }),
  chunk({ reasoning_content: 'about ünïcödé ✓.' }),
  ': ka\n\n',
  chunk({ content: 'Hello, ' }),
  chunk({ content: '世界 🌍!' }),
  chunk({}, 'stop'),
  USAGE,
  'data: [DONE]\n\n',
].join('')

describe('readChatStream', () => {
  it('accumulates reasoning, content, finish reason, usage and queue notices', async () => {
    const state = await readChatStream(body(FULL))
    expect(state.reasoning).toBe('Thinking about ünïcödé ✓.')
    expect(state.content).toBe('Hello, 世界 🌍!')
    expect(state.finishReason).toBe('stop')
    expect(state.usage).toEqual({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 })
    expect(state.model).toBe('glm-5.3-flash')
    expect(state.done).toBe(true)
    expect(state.queueNotices).toBe(2)
    expect(state.queue?.position).toBe(1)
    expect(state.comments).toBe(3)
    expect(state.error).toBeNull()
  })

  it('handles byte chunks that split multi-byte characters and lines', async () => {
    const expected = await readChatStream(body(FULL))
    for (const sizes of [[1], [2], [3], [5, 1, 7], [13], [64, 3]]) {
      const state = await readChatStream(body(FULL, sizes))
      expect(state, `sizes ${sizes.join(',')}`).toEqual(expected)
    }
  })

  it('reports events as they arrive', async () => {
    const kinds: string[] = []
    await readChatStream(body(FULL), (_state, kind) => kinds.push(kind))
    expect(kinds.slice(0, 2)).toEqual(['queue', 'queue'])
    expect(kinds).toContain('comment')
    expect(kinds.at(-1)).toBe('done')
  })

  it('keeps the text received before an in-stream error event', async () => {
    const text = [
      chunk({ content: 'Partial ' }),
      'data: {"error":{"type":"preempted","message":"Server reclaimed."}}\n\n',
      'data: [DONE]\n\n',
    ].join('')
    const state = await readChatStream(body(text, [7]))
    expect(state.content).toBe('Partial ')
    expect(state.error).toEqual({ type: 'preempted', message: 'Server reclaimed.' })
    expect(state.done).toBe(true)
  })

  it('leaves done false when the stream ends without [DONE]', async () => {
    const state = await readChatStream(body(chunk({ content: 'cut' })))
    expect(state.content).toBe('cut')
    expect(state.done).toBe(false)
  })

  it('ignores data lines that are not JSON', async () => {
    const state = await readChatStream(body(`data: not json\n\n${chunk({ content: 'ok' })}data: [DONE]\n\n`))
    expect(state.content).toBe('ok')
  })

  it('accumulates tool-call fragments by index', async () => {
    const text = [
      chunk({
        tool_calls: [
          { index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } },
        ],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"Oslo"}' } }] }),
      chunk({}, 'tool_calls'),
      USAGE,
      'data: [DONE]\n\n',
    ].join('')
    const state = await readChatStream(body(text))
    expect(state.toolCalls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } },
    ])
    expect(state.finishReason).toBe('tool_calls')
  })
})

describe('applyChunk', () => {
  it('does not index into an empty choices array', () => {
    const state = createCompletionState()
    applyChunk(state, { choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })
    expect(state.usage?.total_tokens).toBe(3)
    applyChunk(state, null)
    applyChunk(state, { choices: [null] })
    expect(state.content).toBe('')
  })
})

describe('mergeToolCallDeltas', () => {
  it('keeps calls at different indexes apart', () => {
    const calls: ToolCall[] = []
    mergeToolCallDeltas(calls, [
      { index: 0, id: 'a', function: { name: 'f', arguments: '{}' } },
      { index: 1, id: 'b', function: { name: 'g', arguments: '{"x":' } },
    ])
    mergeToolCallDeltas(calls, [{ index: 1, function: { arguments: '1}' } }])
    expect(calls.map((c) => [c.id, c.function.name, c.function.arguments])).toEqual([
      ['a', 'f', '{}'],
      ['b', 'g', '{"x":1}'],
    ])
  })
})

describe('parseCompletion', () => {
  it('reads a plain completion with separate reasoning', () => {
    const state = parseCompletion({
      id: 'chatcmpl-2',
      model: 'glm-5.3-flash',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'Answer', reasoning_content: 'Because.' },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    })
    expect(state.content).toBe('Answer')
    expect(state.reasoning).toBe('Because.')
    expect(state.inlineThink).toBe(false)
    expect(state.usage?.total_tokens).toBe(3)
  })

  it('splits an inline <think> block out of a non-streamed reply', () => {
    const state = parseCompletion({
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content: '<think>Mock inline reasoning.</think>\n\nThe answer.' },
        },
      ],
    })
    expect(state.reasoning).toBe('Mock inline reasoning.')
    expect(state.content).toBe('The answer.')
    expect(state.inlineThink).toBe(true)
  })

  it('reads tool calls and null content', () => {
    const state = parseCompletion({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }],
          },
        },
      ],
    })
    expect(state.content).toBe('')
    expect(state.toolCalls[0]?.function.arguments).toBe('{"a":1}')
  })

  it('survives unexpected shapes', () => {
    expect(parseCompletion(null).content).toBe('')
    expect(parseCompletion({ choices: [] }).finishReason).toBeNull()
  })
})
