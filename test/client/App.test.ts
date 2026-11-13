// @vitest-environment happy-dom
// Main flows of the UI against a stubbed fetch: model list, streaming, notices, errors, access
// token and stop.

import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../src/App.vue'
import { CAP_NOTICE } from '../../src/lib/cap'

type Handler = (init: RequestInit | undefined) => Response | Promise<Response>

interface Call {
  url: string
  init: RequestInit | undefined
}

function stubFetch(routes: Record<string, Handler>) {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      const handler = routes[url]
      if (!handler) return new Response('{"message":"Not found."}', { status: 404 })
      return handler(init)
    }),
  )
  return calls
}

const json = (status: number, value: unknown, headers: Record<string, string> = {}): Handler => {
  return () =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    })
}

/** An SSE response. With `hang`, it never ends but errors when the request is aborted. */
function sse(parts: string[], options: { hang?: boolean; headers?: Record<string, string> } = {}): Handler {
  return (init) => {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(encoder.encode(part))
        if (!options.hang) controller.close()
        init?.signal?.addEventListener('abort', () => {
          controller.error(new DOMException('The operation was aborted.', 'AbortError'))
        })
      },
    })
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', ...options.headers },
    })
  }
}

const delta = (d: Record<string, unknown>, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: 'c1', model: 'glm-5.3-flash', choices: [{ index: 0, delta: d, finish_reason: finish }] })}\n\n`

const MODELS = {
  object: 'list',
  data: [
    { id: 'glm-5.3-flash', object: 'model', name: 'GLM-5.3-Flash', available: true },
    { id: 'gemma4-26b-a4b-qat', object: 'model', name: 'Gemma4-26B-A4B-QAT', available: false },
  ],
}
const ACCOUNT = {
  plan: 'pro',
  tier: 'pro',
  context_limit: 65536,
  default_model: 'glm-5.3-flash',
  models: [{ id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', available: true, context_limit: 32768 }],
}

let wrapper: VueWrapper | null = null

async function mountApp() {
  wrapper = mount(App, { attachTo: document.body })
  await flushPromises()
  return wrapper
}

async function typeAndSend(w: VueWrapper, text: string) {
  const textarea = w.find('textarea[id^="content-"]')
  await textarea.setValue(text)
  await textarea.trigger('keydown', { key: 'Enter', ctrlKey: true })
  await flushPromises()
}

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('App', () => {
  it('lists models by display name, marks unavailable ones and picks the default', async () => {
    stubFetch({ '/api/models': json(200, MODELS), '/api/account': json(200, ACCOUNT) })
    const w = await mountApp()
    const options = w.findAll('#model-select option').map((o) => o.text())
    expect(options).toEqual(['GLM-5.3-Flash', 'Gemma4-26B-A4B-QAT (unavailable)'])
    expect((w.find('#model-select').element as HTMLSelectElement).value).toBe('glm-5.3-flash')
    expect(w.text()).toContain('context 32,768 tokens')
    expect(w.find('.account').text()).toContain('pro')
  })

  it('explains model_unavailable when an unavailable model is chosen', async () => {
    stubFetch({ '/api/models': json(200, MODELS), '/api/account': json(200, ACCOUNT) })
    const w = await mountApp()
    await w.find('#model-select').setValue('gemma4-26b-a4b-qat')
    expect(w.text()).toContain('No server is serving this model right now.')
    expect(w.text()).toContain('503 model_unavailable')
  })

  it('streams reasoning and answer separately, shows the cap notice apart, and fills the stats', async () => {
    const calls = stubFetch({
      '/api/models': json(200, MODELS),
      '/api/account': json(200, ACCOUNT),
      '/api/chat': sse(
        [
          ': queued · position 1 of 2 · waiting 3s\n\n',
          delta({ role: 'assistant', content: '' }),
          delta({ reasoning_content: 'Let me think.' }),
          ': ka\n\n',
          delta({ content: 'The answer' }),
          delta({ content: ' is 42.' }),
          delta({ content: CAP_NOTICE }),
          delta({}, 'length'),
          `data: ${JSON.stringify({ id: 'c1', model: 'glm-5.3-flash', choices: [], usage: { prompt_tokens: 5, completion_tokens: 25, total_tokens: 30 } })}\n\n`,
          'data: [DONE]\n\n',
        ],
        { headers: { 'X-RateLimit-Remaining': '57', 'X-RateLimit-Limit': '60' } },
      ),
    })
    const w = await mountApp()
    await typeAndSend(w, 'What is the answer?')

    const chat = calls.find((c) => c.url === '/api/chat')
    expect(chat?.init?.method).toBe('POST')
    expect(JSON.parse(String(chat?.init?.body))).toEqual({
      model: 'glm-5.3-flash',
      messages: [{ role: 'user', content: 'What is the answer?' }],
      stream: true,
    })

    await vi.waitFor(() => expect(w.find('.status').text()).toMatch(/^Done/))
    const answer = w.find('.answer .text-block').text()
    expect(answer).toBe('The answer is 42.')
    expect(answer).not.toContain('Response is too large')
    expect(w.find('.notice-warning').text()).toContain(
      '[Response is too large for your current plan. Try a smaller request.]',
    )
    expect(w.find('details.reasoning').text()).toContain('Let me think.')
    const stats = w.find('.stats').text()
    expect(stats).toContain('length')
    expect(stats).toContain('30')
    expect(stats).toContain('57 of 60 per minute')
    expect(stats).toContain('queued · position 1 of 2 · waiting 3s')

    // Add the reply to the conversation: the cap notice is not part of it, the reasoning is kept.
    const append = w.findAll('button').find((b) => b.text() === 'Add to conversation')
    await append?.trigger('click')
    const textareas = w.findAll('textarea[id^="content-"]')
    expect(textareas).toHaveLength(3)
    expect((textareas[1]?.element as HTMLTextAreaElement | undefined)?.value).toBe('The answer is 42.')
    expect(w.text()).toContain('Reasoning attached')
  })

  it('splits inline <think> out of a non-streamed reply', async () => {
    stubFetch({
      '/api/models': json(200, MODELS),
      '/api/account': json(200, ACCOUNT),
      '/api/chat': json(200, {
        id: 'c2',
        object: 'chat.completion',
        model: 'glm-5.3-flash',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: '<think>Hidden.</think>Shown.' },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }),
    })
    const w = await mountApp()
    const streamToggle = w.findAll('label.check').find((l) => l.text().includes('Stream the response'))
    await streamToggle?.find('input').setValue(false)
    await typeAndSend(w, 'Hi')
    await vi.waitFor(() => expect(w.find('.status').text()).toMatch(/^Done/))
    expect(w.find('.answer .text-block').text()).toBe('Shown.')
    expect(w.find('details.reasoning').text()).toContain('Hidden.')
    expect(w.text()).toContain('inline in a')
  })

  it('shows mapped errors with what to do next', async () => {
    stubFetch({
      '/api/models': json(200, MODELS),
      '/api/account': json(200, ACCOUNT),
      '/api/chat': json(413, {
        error: {
          type: 'context_length_exceeded',
          message: 'Too big.',
          estimated_tokens: 70000,
          context_cap: 65536,
          bound_by: 'plan',
          plan: 'pro',
        },
      }),
    })
    const w = await mountApp()
    await typeAndSend(w, 'Long prompt')
    await vi.waitFor(() => expect(w.find('.error-panel').exists()).toBe(true))
    const panel = w.find('.error-panel').text()
    expect(panel).toContain('The prompt is longer than the context limit')
    expect(panel).toContain('65,536 tokens')
    expect(panel).toContain('your plan (pro)')
    expect(panel).toContain('HTTP 413')
  })

  it('shows in-stream errors after the partial text', async () => {
    stubFetch({
      '/api/models': json(200, MODELS),
      '/api/account': json(200, ACCOUNT),
      '/api/chat': sse([
        delta({ content: 'Partial' }),
        'data: {"error":{"type":"preempted","message":"Server reclaimed."}}\n\n',
        'data: [DONE]\n\n',
      ]),
    })
    const w = await mountApp()
    await typeAndSend(w, 'Hi')
    await vi.waitFor(() => expect(w.find('.error-panel').exists()).toBe(true))
    expect(w.find('.answer .text-block').text()).toBe('Partial')
    expect(w.find('.error-panel').text()).toContain('preempted')
  })

  it('stops a running request', async () => {
    const calls = stubFetch({
      '/api/models': json(200, MODELS),
      '/api/account': json(200, ACCOUNT),
      '/api/chat': sse([delta({ content: 'Still going' })], { hang: true }),
    })
    const w = await mountApp()
    await typeAndSend(w, 'Hi')
    await vi.waitFor(() => expect(w.find('.answer .text-block').text()).toContain('Still going'))
    const stop = w.findAll('button').find((b) => b.text().startsWith('Stop'))
    expect(stop).toBeDefined()
    await stop?.trigger('click')
    await vi.waitFor(() => expect(w.find('.status').text()).toMatch(/^Stopped/))
    const chat = calls.find((c) => c.url === '/api/chat')
    expect(chat?.init?.signal?.aborted).toBe(true)
    expect(w.find('.answer .text-block').text()).toContain('Still going')
  })

  it('asks for the access token, keeps it in sessionStorage and sends it', async () => {
    const token = 'correct-horse-battery-staple'
    const calls = stubFetch({
      '/api/models': (init) => {
        const auth = new Headers(init?.headers).get('Authorization')
        return auth === `Bearer ${token}`
          ? json(200, MODELS)(init)
          : json(401, { error: { type: 'playground_auth_required', message: 'Token.' } })(init)
      },
      '/api/account': json(200, ACCOUNT),
    })
    const w = await mountApp()
    expect(w.find('#access-token').exists()).toBe(true)
    expect(w.find('#model-select').exists()).toBe(false)

    await w.find('#access-token').setValue('wrong-token')
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(w.text()).toContain('That token was not accepted')

    await w.find('#access-token').setValue(token)
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(sessionStorage.getItem('molochai-playground:access-token')).toBe(token)
    expect(localStorage.length).toBe(0)
    expect(w.find('#model-select').exists()).toBe(true)
    const last = calls.filter((c) => c.url === '/api/models').at(-1)
    expect(new Headers(last?.init?.headers).get('Authorization')).toBe(`Bearer ${token}`)
  })

  it('validates the editor before sending', async () => {
    const calls = stubFetch({ '/api/models': json(200, MODELS), '/api/account': json(200, ACCOUNT) })
    const w = await mountApp()
    await typeAndSend(w, '   ')
    expect(w.find('.form-error').text()).toContain('Message 1 is empty')
    expect(calls.some((c) => c.url === '/api/chat')).toBe(false)
  })

  it('offers the request as curl and Python with the key as an environment variable', async () => {
    stubFetch({ '/api/models': json(200, MODELS), '/api/account': json(200, ACCOUNT) })
    const w = await mountApp()
    await w.find('textarea[id^="content-"]').setValue('Hello')
    expect(w.find('#panel-curl pre').text()).toContain('Bearer $MOLOCHAI_API_KEY')
    await w.find('#tab-python').trigger('click')
    expect(w.find('#panel-python pre').text()).toContain('os.environ["MOLOCHAI_API_KEY"]')
  })

  it('toggles and remembers the theme', async () => {
    stubFetch({ '/api/models': json(200, MODELS), '/api/account': json(200, ACCOUNT) })
    const w = await mountApp()
    const button = w.findAll('button').find((b) => /theme/.test(b.text()))
    await button?.trigger('click')
    const saved = localStorage.getItem('molochai-playground:theme')
    expect(saved === 'light' || saved === 'dark').toBe(true)
    expect(document.documentElement.dataset.theme).toBe(saved)
  })
})
