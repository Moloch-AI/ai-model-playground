// Incremental parser for server-sent events, following the WHATWG event-stream rules:
// lines end in \n, \r\n or \r; `data:` lines accumulate until a blank line; lines starting with
// `:` are comments. Comments are reported (not dropped) because the MolochAI gateway uses them for
// keep-alives (`: ka`, `: hb`) and queue progress (`: queued · position 2 of 3 · waiting 4s`).

import type { QueueInfo } from './types'

export type SseEvent = { kind: 'data'; data: string } | { kind: 'comment'; text: string }

export class SseParser {
  private buffer = ''
  private data: string[] = []
  private readonly onEvent: (event: SseEvent) => void

  constructor(onEvent: (event: SseEvent) => void) {
    this.onEvent = onEvent
  }

  /** Feed decoded text. Chunk boundaries can fall anywhere, including inside a line ending. */
  push(text: string): void {
    const buf = this.buffer + text
    let start = 0
    let i = 0
    while (i < buf.length) {
      const ch = buf[i]
      if (ch === '\n') {
        this.line(buf.slice(start, i))
        start = i + 1
      } else if (ch === '\r') {
        // A \r at the very end may be the first half of \r\n: wait for the next chunk.
        if (i + 1 === buf.length) break
        this.line(buf.slice(start, i))
        if (buf[i + 1] === '\n') i++
        start = i + 1
      }
      i++
    }
    this.buffer = buf.slice(start)
  }

  /** Flush at end of stream. A final event without its blank line is still delivered. */
  end(): void {
    if (this.buffer.length > 0) {
      const rest = this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer
      this.buffer = ''
      this.line(rest)
    }
    this.dispatch()
  }

  private line(line: string): void {
    if (line === '') {
      this.dispatch()
      return
    }
    if (line.startsWith(':')) {
      const text = line.slice(1)
      this.onEvent({ kind: 'comment', text: text.startsWith(' ') ? text.slice(1) : text })
      return
    }
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') this.data.push(value)
    // `event`, `id` and `retry` are not used by chat completion streams.
  }

  private dispatch(): void {
    if (this.data.length === 0) return
    const data = this.data.join('\n')
    this.data = []
    this.onEvent({ kind: 'data', data })
  }
}

const QUEUE_RE = /^queued\s*·\s*position\s+(\d+)\s+of\s+(\d+)(?:\s*·\s*waiting\s+(\d+(?:\.\d+)?)\s*s)?/i

/**
 * Read queue progress from a comment such as `queued · position 2 of 3 · waiting 4s`.
 * The format is informational and may change, so anything else returns null.
 */
export function parseQueueComment(text: string): QueueInfo | null {
  const match = QUEUE_RE.exec(text.trim())
  if (!match) return null
  return {
    position: Number(match[1]),
    total: Number(match[2]),
    waitingSeconds: match[3] === undefined ? null : Number(match[3]),
    text: text.trim(),
  }
}
