// Equivalent curl and Python code for the request in the editor. The key is never included:
// both read it from the MOLOCHAI_API_KEY environment variable.

import type { ChatRequest } from './types'

export const PUBLIC_BASE_URL = 'https://api.molochai.dev/api/v1'

export function toCurl(request: ChatRequest): string {
  const body = JSON.stringify(request, null, 2)
  return [
    `curl -sS${request.stream ? 'N' : ''} "\${MOLOCHAI_BASE_URL:-${PUBLIC_BASE_URL}}/chat/completions" \\`,
    '  -H "Authorization: Bearer $MOLOCHAI_API_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    "  -d @- <<'JSON'",
    body,
    'JSON',
  ].join('\n')
}

/** Render a JSON value as a Python literal (None/True/False, 4-space indents). */
export function pyLiteral(value: unknown, indent = 0): string {
  const pad = ' '.repeat(indent)
  const inner = ' '.repeat(indent + 4)
  if (value === null || value === undefined) return 'None'
  if (value === true) return 'True'
  if (value === false) return 'False'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'None'
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return `[\n${value.map((item) => `${inner}${pyLiteral(item, indent + 4)},`).join('\n')}\n${pad}]`
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
    if (entries.length === 0) return '{}'
    return `{\n${entries
      .map(([key, v]) => `${inner}${JSON.stringify(key)}: ${pyLiteral(v, indent + 4)},`)
      .join('\n')}\n${pad}}`
  }
  return 'None'
}

/** Python with the official OpenAI SDK pointed at the MolochAI base URL. */
export function toPython(request: ChatRequest): string {
  const args: string[] = [
    `    model=${pyLiteral(request.model)},`,
    `    messages=${pyLiteral(request.messages, 4)},`,
  ]
  if (request.temperature !== undefined) args.push(`    temperature=${pyLiteral(request.temperature)},`)
  if (request.top_p !== undefined) args.push(`    top_p=${pyLiteral(request.top_p)},`)
  if (request.tools !== undefined) args.push(`    tools=${pyLiteral(request.tools, 4)},`)
  if (request.tool_choice !== undefined) args.push(`    tool_choice=${pyLiteral(request.tool_choice, 4)},`)
  if (request.stream) args.push('    stream=True,')

  const lines = [
    'import os',
    '',
    'from openai import OpenAI  # pip install openai',
    '',
    'client = OpenAI(',
    `    base_url=os.environ.get("MOLOCHAI_BASE_URL", "${PUBLIC_BASE_URL}"),`,
    '    api_key=os.environ["MOLOCHAI_API_KEY"],',
    ')',
    '',
  ]
  if (request.stream) {
    lines.push(
      'stream = client.chat.completions.create(',
      ...args,
      ')',
      '',
      'for chunk in stream:',
      '    if not chunk.choices:  # the last chunk carries only usage',
      '        print("\\n", chunk.usage)',
      '        continue',
      '    delta = chunk.choices[0].delta',
      '    # Reasoning models also send delta.reasoning_content (a MolochAI extension).',
      '    if delta.content:',
      '        print(delta.content, end="", flush=True)',
    )
  } else {
    lines.push(
      'response = client.chat.completions.create(',
      ...args,
      ')',
      '',
      'message = response.choices[0].message',
      'print(message.content)',
      'print(response.choices[0].finish_reason, response.usage)',
    )
  }
  return `${lines.join('\n')}\n`
}
