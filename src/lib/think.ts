// Splits inline reasoning out of a non-streamed reply.
//
// Some serving setups leave the model's reasoning inside the content as <think>...</think>.
// The gateway removes it while streaming but not in non-streamed replies. Handled forms:
//   "<think>R</think>A"   -> reasoning R, answer A (several blocks are joined)
//   "<think>R"            -> reasoning R, no answer (the reply stopped inside the block)
//   "R</think>A"          -> reasoning R, answer A (the opening tag was part of the prompt)

export interface ThinkSplit {
  reasoning: string
  content: string
  found: boolean
}

const OPEN = '<think>'
const CLOSE = '</think>'

export function splitThink(text: string): ThinkSplit {
  const parts: string[] = []
  let rest = text

  // Leading reasoning whose opening tag was in the prompt template.
  const firstOpen = rest.indexOf(OPEN)
  const firstClose = rest.indexOf(CLOSE)
  if (firstClose !== -1 && (firstOpen === -1 || firstClose < firstOpen)) {
    parts.push(rest.slice(0, firstClose))
    rest = rest.slice(firstClose + CLOSE.length)
  }

  let answer = ''
  for (;;) {
    const open = rest.indexOf(OPEN)
    if (open === -1) {
      answer += rest
      break
    }
    answer += rest.slice(0, open)
    const close = rest.indexOf(CLOSE, open + OPEN.length)
    if (close === -1) {
      parts.push(rest.slice(open + OPEN.length))
      break
    }
    parts.push(rest.slice(open + OPEN.length, close))
    rest = rest.slice(close + CLOSE.length)
  }

  if (parts.length === 0) return { reasoning: '', content: text, found: false }
  return {
    reasoning: parts
      .map((part) => part.trim())
      .filter(Boolean)
      .join('\n\n'),
    content: answer.replace(/^\s+/, ''),
    found: true,
  }
}
