// The gateway appends this text to the content when a reply stops at the plan's output cap
// (with no tool call). The playground shows it as a notice, not as part of the answer.

export const CAP_NOTICE_TEXT = '[Response is too large for your current plan. Try a smaller request.]'
export const CAP_NOTICE = `\n\n${CAP_NOTICE_TEXT}`

export interface CapSplit {
  content: string
  capped: boolean
}

/**
 * Remove the cap notice from the end of `content`.
 * With `partial: true` (while streaming) a trailing fragment that could be the start of the
 * notice ("\n\n[Resp") is held back too, so it never flashes up as part of the answer.
 */
export function splitCapNotice(content: string, options: { partial?: boolean } = {}): CapSplit {
  if (content.endsWith(CAP_NOTICE)) {
    return { content: content.slice(0, -CAP_NOTICE.length), capped: true }
  }
  if (content.endsWith(CAP_NOTICE_TEXT) && content.slice(0, -CAP_NOTICE_TEXT.length).trim() === '') {
    return { content: '', capped: true }
  }
  if (options.partial) {
    for (let length = Math.min(CAP_NOTICE.length - 1, content.length); length >= 3; length--) {
      if (content.endsWith(CAP_NOTICE.slice(0, length))) {
        return { content: content.slice(0, -length), capped: false }
      }
    }
  }
  return { content, capped: false }
}
