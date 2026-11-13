import { describe, expect, it } from 'vitest'
import { parseQueueComment, type SseEvent, SseParser } from '../../src/lib/sse'

function parseAll(chunks: string[]): SseEvent[] {
  const events: SseEvent[] = []
  const parser = new SseParser((event) => events.push(event))
  for (const chunk of chunks) parser.push(chunk)
  parser.end()
  return events
}

const STREAM = [
  ': queued · position 2 of 3 · waiting 4s',
  '',
  'data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}',
  '',
  ': ka',
  '',
  'data: {"choices":[{"index":0,"delta":{"content":"Hé ✓"}}]}',
  '',
  'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}',
  '',
  'data: [DONE]',
  '',
  '',
].join('\n')

const EXPECTED: SseEvent[] = [
  { kind: 'comment', text: 'queued · position 2 of 3 · waiting 4s' },
  { kind: 'data', data: '{"choices":[{"index":0,"delta":{"role":"assistant"}}]}' },
  { kind: 'comment', text: 'ka' },
  { kind: 'data', data: '{"choices":[{"index":0,"delta":{"content":"Hé ✓"}}]}' },
  {
    kind: 'data',
    data: '{"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}',
  },
  { kind: 'data', data: '[DONE]' },
]

describe('SseParser', () => {
  it('parses data events and comments in order', () => {
    expect(parseAll([STREAM])).toEqual(EXPECTED)
  })

  it('gives the same result for every two-way split of the stream', () => {
    for (let i = 0; i <= STREAM.length; i++) {
      expect(parseAll([STREAM.slice(0, i), STREAM.slice(i)]), `split at ${i}`).toEqual(EXPECTED)
    }
  })

  it('gives the same result when fed one character at a time', () => {
    expect(parseAll([...STREAM])).toEqual(EXPECTED)
  })

  it('gives the same result for random chunk sizes', () => {
    let seed = 42
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let round = 0; round < 200; round++) {
      const chunks: string[] = []
      let at = 0
      while (at < STREAM.length) {
        const size = 1 + Math.floor(random() * 40)
        chunks.push(STREAM.slice(at, at + size))
        at += size
      }
      expect(parseAll(chunks)).toEqual(EXPECTED)
    }
  })

  it('accepts \\r\\n and \\r line endings, including \\r\\n split across chunks', () => {
    const crlf = STREAM.replace(/\n/g, '\r\n')
    expect(parseAll([crlf])).toEqual(EXPECTED)
    for (let i = 0; i <= crlf.length; i++) {
      expect(parseAll([crlf.slice(0, i), crlf.slice(i)])).toEqual(EXPECTED)
    }
    expect(parseAll([STREAM.replace(/\n/g, '\r')])).toEqual(EXPECTED)
  })

  it('joins multi-line data with newlines and accepts data: without a space', () => {
    expect(parseAll(['data:first\ndata: second\n\n'])).toEqual([{ kind: 'data', data: 'first\nsecond' }])
  })

  it('ignores event, id and retry fields', () => {
    expect(parseAll(['event: message\nid: 7\nretry: 1000\ndata: x\n\n'])).toEqual([
      { kind: 'data', data: 'x' },
    ])
  })

  it('delivers a final event that has no trailing blank line', () => {
    expect(parseAll(['data: [DONE]'])).toEqual([{ kind: 'data', data: '[DONE]' }])
    expect(parseAll(['data: [DONE]\r'])).toEqual([{ kind: 'data', data: '[DONE]' }])
  })

  it('reports comments with an empty body and keeps colons inside data', () => {
    expect(parseAll([':\n\ndata: {"a":"b:c"}\n\n'])).toEqual([
      { kind: 'comment', text: '' },
      { kind: 'data', data: '{"a":"b:c"}' },
    ])
  })
})

describe('parseQueueComment', () => {
  it('reads position, total and wait time', () => {
    expect(parseQueueComment('queued · position 2 of 3 · waiting 4s')).toEqual({
      position: 2,
      total: 3,
      waitingSeconds: 4,
      text: 'queued · position 2 of 3 · waiting 4s',
    })
    expect(parseQueueComment('queued · position 1 of 12 · waiting 2.5s')?.waitingSeconds).toBe(2.5)
    expect(parseQueueComment('queued · position 5 of 9')?.waitingSeconds).toBeNull()
  })

  it('returns null for other comments', () => {
    expect(parseQueueComment('ka')).toBeNull()
    expect(parseQueueComment('hb')).toBeNull()
    expect(parseQueueComment('something else entirely')).toBeNull()
  })
})
