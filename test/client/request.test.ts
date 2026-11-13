import { describe, expect, it } from 'vitest'
import { pyLiteral, toCurl, toPython } from '../../src/lib/codegen'
import { buildChatRequest, defaultParams, type EditorState, newMessage } from '../../src/lib/request'
import type { ChatRequest } from '../../src/lib/types'

function state(overrides: Partial<EditorState> = {}): EditorState {
  return {
    model: 'glm-5.3-flash',
    system: '',
    messages: [newMessage('user', 'Hello')],
    params: defaultParams(),
    ...overrides,
  }
}

describe('buildChatRequest', () => {
  it('builds a minimal streaming request without unset parameters', () => {
    const result = buildChatRequest(state())
    expect(result).toEqual({
      ok: true,
      request: { model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'Hello' }], stream: true },
    })
  })

  it('adds the system message and set parameters', () => {
    const result = buildChatRequest(
      state({
        system: 'Be brief.',
        params: { ...defaultParams(), temperature: 0.2, topP: 0.5, stream: false },
      }),
    )
    expect(result.ok && result.request).toEqual({
      model: 'glm-5.3-flash',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Hello' },
      ],
      stream: false,
      temperature: 0.2,
      top_p: 0.5,
    })
  })

  it('sends reasoning back and supports tool turns', () => {
    const call = { id: 'call_1', type: 'function' as const, function: { name: 'f', arguments: '{}' } }
    const result = buildChatRequest(
      state({
        messages: [
          newMessage('user', 'Weather?'),
          newMessage('assistant', '', { reasoning: 'Need a tool.', toolCalls: [call] }),
          newMessage('tool', '{"temp":3}', { toolCallId: 'call_1' }),
        ],
        params: {
          ...defaultParams(),
          tools: '[{"type":"function","function":{"name":"f"}}]',
          toolChoice: 'auto',
        },
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.request.messages[1]).toEqual({
      role: 'assistant',
      content: null,
      reasoning_content: 'Need a tool.',
      tool_calls: [call],
    })
    expect(result.request.messages[2]).toEqual({
      role: 'tool',
      content: '{"temp":3}',
      tool_call_id: 'call_1',
    })
    expect(result.request.tool_choice).toBe('auto')
  })

  it('explains what is missing', () => {
    expect(buildChatRequest(state({ model: '' }))).toMatchObject({ ok: false, error: 'Pick a model first.' })
    expect(buildChatRequest(state({ messages: [newMessage('user', '  ')] }))).toMatchObject({
      ok: false,
      error: expect.stringContaining('Message 1 is empty'),
    })
    expect(buildChatRequest(state({ messages: [newMessage('tool', 'x')] }))).toMatchObject({
      ok: false,
      error: expect.stringContaining('tool_call_id'),
    })
    expect(buildChatRequest(state({ messages: [] }))).toMatchObject({ ok: false })
    expect(buildChatRequest(state({ params: { ...defaultParams(), tools: '{nope' } }))).toMatchObject({
      ok: false,
      error: expect.stringContaining('not valid JSON'),
    })
    expect(buildChatRequest(state({ params: { ...defaultParams(), tools: '{}' } }))).toMatchObject({
      ok: false,
    })
  })
})

const REQUEST: ChatRequest = {
  model: 'glm-5.3-flash',
  messages: [
    { role: 'system', content: 'Be "brief".' },
    { role: 'user', content: "It's a test\nwith two lines and $HOME" },
  ],
  stream: true,
  temperature: 0.5,
}

describe('toCurl', () => {
  it('reads the key and base URL from the environment and sends the body through a quoted heredoc', () => {
    const curl = toCurl(REQUEST)
    expect(curl).toContain('Authorization: Bearer $MOLOCHAI_API_KEY')
    // A shell default expansion, not a JS template placeholder.
    expect(curl).toContain(`"\${MOLOCHAI_BASE_URL:-https://api.molochai.dev/api/v1}/chat/completions"`)
    expect(curl).toContain("<<'JSON'")
    expect(curl.startsWith('curl -sSN ')).toBe(true)
    const body = curl.slice(curl.indexOf("<<'JSON'\n") + 9, curl.lastIndexOf('\nJSON'))
    expect(JSON.parse(body)).toEqual(REQUEST)
  })

  it('omits -N for non-streaming requests', () => {
    expect(toCurl({ ...REQUEST, stream: false }).startsWith('curl -sS ')).toBe(true)
  })
})

describe('toPython', () => {
  it('uses the OpenAI SDK with the key from the environment', () => {
    const py = toPython(REQUEST)
    expect(py).toContain('api_key=os.environ["MOLOCHAI_API_KEY"]')
    expect(py).toContain('os.environ.get("MOLOCHAI_BASE_URL", "https://api.molochai.dev/api/v1")')
    expect(py).toContain('stream=True,')
    expect(py).toContain('temperature=0.5,')
    expect(py).toContain('if not chunk.choices:')
    expect(py).not.toContain('top_p')
  })

  it('writes the non-streaming variant', () => {
    const py = toPython({ ...REQUEST, stream: false })
    expect(py).toContain('response = client.chat.completions.create(')
    expect(py).not.toContain('stream=True')
  })

  it('renders JSON values as Python literals', () => {
    expect(pyLiteral(null)).toBe('None')
    expect(pyLiteral(true)).toBe('True')
    expect(pyLiteral({ a: [1, false], b: 'x"y' })).toBe(
      '{\n    "a": [\n        1,\n        False,\n    ],\n    "b": "x\\"y",\n}',
    )
    expect(pyLiteral([])).toBe('[]')
  })
})
