import { describe, expect, it } from 'vitest'
import { CAP_NOTICE, CAP_NOTICE_TEXT, splitCapNotice } from '../../src/lib/cap'
import { LINKS, tagged, UTM } from '../../src/lib/links'
import { splitThink } from '../../src/lib/think'

describe('splitThink', () => {
  it('splits a leading think block', () => {
    expect(splitThink('<think>reasoning here</think>\n\nThe answer.')).toEqual({
      reasoning: 'reasoning here',
      content: 'The answer.',
      found: true,
    })
  })

  it('leaves text without think tags alone', () => {
    expect(splitThink('Just an answer with <b>tags</b>.')).toEqual({
      reasoning: '',
      content: 'Just an answer with <b>tags</b>.',
      found: false,
    })
  })

  it('treats an unclosed block as reasoning that was cut off', () => {
    expect(splitThink('<think>still thinking when the cap hit')).toEqual({
      reasoning: 'still thinking when the cap hit',
      content: '',
      found: true,
    })
  })

  it('handles a closing tag whose opening tag was in the prompt template', () => {
    expect(splitThink('reasoning first\n</think>\nanswer')).toEqual({
      reasoning: 'reasoning first',
      content: 'answer',
      found: true,
    })
  })

  it('joins several blocks', () => {
    const result = splitThink('<think>a</think>One <think>b</think>two')
    expect(result.reasoning).toBe('a\n\nb')
    expect(result.content).toBe('One two')
  })
})

describe('splitCapNotice', () => {
  it('removes the exact notice the gateway appends', () => {
    expect(CAP_NOTICE).toBe('\n\n[Response is too large for your current plan. Try a smaller request.]')
    expect(splitCapNotice(`Long answer${CAP_NOTICE}`)).toEqual({ content: 'Long answer', capped: true })
  })

  it('handles a reply that is only the notice', () => {
    expect(splitCapNotice(CAP_NOTICE)).toEqual({ content: '', capped: true })
    expect(splitCapNotice(CAP_NOTICE_TEXT)).toEqual({ content: '', capped: true })
  })

  it('leaves normal text and mid-text mentions alone', () => {
    expect(splitCapNotice('Normal answer.')).toEqual({ content: 'Normal answer.', capped: false })
    const quoted = `He said ${CAP_NOTICE_TEXT} and moved on.`
    expect(splitCapNotice(quoted)).toEqual({ content: quoted, capped: false })
  })

  it('holds back a partial notice while streaming, and only then', () => {
    const partial = `Answer${CAP_NOTICE.slice(0, 20)}`
    expect(splitCapNotice(partial, { partial: true })).toEqual({ content: 'Answer', capped: false })
    expect(splitCapNotice(partial)).toEqual({ content: partial, capped: false })
    // Every prefix of the notice is held back while streaming.
    for (let i = 3; i < CAP_NOTICE.length; i++) {
      expect(splitCapNotice(`x${CAP_NOTICE.slice(0, i)}`, { partial: true }).content).toBe('x')
    }
    // Text that diverges from the notice shows again.
    expect(splitCapNotice('x\n\n[link](y)', { partial: true }).content).toBe('x\n\n[link](y)')
  })

  it('finds the notice when streamed chunks are joined', () => {
    const chunks = [
      'Some ',
      'answer',
      '\n\n[Response is too ',
      'large for your current plan. ',
      'Try a smaller request.]',
    ]
    let content = ''
    for (const piece of chunks) {
      content += piece
      expect(splitCapNotice(content, { partial: true }).content).not.toContain('[Response')
    }
    expect(splitCapNotice(content)).toEqual({ content: 'Some answer', capped: true })
  })
})

describe('tagged links', () => {
  it('adds the campaign parameters to molochai.dev and dash.molochai.dev links', () => {
    expect(tagged('https://molochai.dev/docs')).toBe(`https://molochai.dev/docs?${UTM}`)
    expect(tagged('https://dash.molochai.dev/account')).toBe(`https://dash.molochai.dev/account?${UTM}`)
  })

  it('puts them before a fragment and after an existing query', () => {
    expect(tagged('https://molochai.dev/docs/errors#codes')).toBe(
      `https://molochai.dev/docs/errors?${UTM}#codes`,
    )
    expect(tagged('https://molochai.dev/docs?x=1#y')).toBe(`https://molochai.dev/docs?x=1&${UTM}#y`)
  })

  it('never tags the API host or other sites', () => {
    expect(tagged('https://api.molochai.dev/api/v1')).toBe('https://api.molochai.dev/api/v1')
    expect(tagged('https://github.com/Moloch-AI')).toBe('https://github.com/Moloch-AI')
  })

  it('tags every site link the UI uses', () => {
    for (const [name, href] of Object.entries(LINKS)) {
      const host = new URL(href).hostname
      if (host === 'molochai.dev' || host === 'dash.molochai.dev') {
        expect(href, name).toContain(UTM)
      } else {
        expect(href, name).not.toContain('utm_')
      }
    }
  })
})
