import { describe, expect, it } from 'vitest'
import {
  describeHttpError,
  describeNetworkError,
  describeStreamError,
  describeTruncatedStream,
} from '../../src/lib/errors'
import { UTM } from '../../src/lib/links'

const headers = (values: Record<string, string> = {}) => new Headers(values)
const body = (value: unknown) => JSON.stringify(value)

describe('describeHttpError', () => {
  it('401: points at the server-side key, not the browser', () => {
    const info = describeHttpError(401, body({ message: 'Unauthenticated.' }))
    expect(info.title).toMatch(/did not accept the key/)
    expect(info.action).toContain('MOLOCHAI_API_KEY')
    expect(info.message).toBe('Unauthenticated.')
    expect(info.retryable).toBe(false)
    expect(info.links[0]?.href).toBe(`https://dash.molochai.dev/account?${UTM}`)
  })

  it('402 no_active_plan', () => {
    const info = describeHttpError(
      402,
      body({ error: { type: 'no_active_plan', message: 'No plan.', plan: null } }),
    )
    expect(info.type).toBe('no_active_plan')
    expect(info.retryable).toBe(false)
    expect(info.links.map((l) => l.label)).toEqual(['Dashboard', 'Pricing'])
    expect(info.links.every((l) => l.href.includes(UTM))).toBe(true)
  })

  it('403 email_unverified (bare body with code)', () => {
    const info = describeHttpError(
      403,
      body({ message: 'Verify your email to continue.', code: 'email_unverified' }),
    )
    expect(info.type).toBe('email_unverified')
    expect(info.title).toBe('Email address not verified')
    expect(info.retryable).toBe(false)
  })

  it('413 bound by plan explains the cap and the plan', () => {
    const info = describeHttpError(
      413,
      body({
        error: {
          type: 'context_length_exceeded',
          message: 'Too big.',
          estimated_tokens: 70000,
          context_cap: 65536,
          bound_by: 'plan',
          plan: 'pro',
        },
      }),
    )
    expect(info.details).toEqual([
      { label: 'Estimated prompt tokens', value: '70,000' },
      { label: 'Context limit', value: '65,536 tokens' },
      { label: 'Limit set by', value: 'your plan (pro)' },
    ])
    expect(info.action).toMatch(/larger context/)
    expect(info.retryable).toBe(false)
  })

  it('413 bound by the server says a bigger plan would not help', () => {
    const info = describeHttpError(
      413,
      body({ error: { type: 'context_length_exceeded', context_cap: 32768, bound_by: 'server' } }),
    )
    expect(info.details).toContainEqual({ label: 'Limit set by', value: 'the server serving this model' })
    expect(info.action).toMatch(/would not help/)
  })

  it('422 lists field errors and spots an unknown model', () => {
    const info = describeHttpError(
      422,
      body({
        message: 'The selected model is invalid.',
        errors: { model: ['The selected model is invalid.'] },
      }),
    )
    expect(info.fields).toEqual([{ field: 'model', messages: ['The selected model is invalid.'] }])
    expect(info.action).toMatch(/Pick a model/)
    const other = describeHttpError(422, body({ message: 'x', errors: { temperature: ['Too high.'] } }))
    expect(other.action).toMatch(/Fix the fields/)
  })

  it('429 session_quota_exceeded surfaces resets_at and is not retryable', () => {
    const info = describeHttpError(
      429,
      body({
        error: { type: 'session_quota_exceeded', message: 'Session cap.', resets_at: '2026-11-13T15:00:00Z' },
      }),
    )
    expect(info.resetsAt).toBe('2026-11-13T15:00:00Z')
    expect(info.details[0]?.value).toContain('2026-11-13T15:00:00Z')
    expect(info.retryable).toBe(false)
  })

  it('429 quota_exceeded shows usage and resets_at', () => {
    const info = describeHttpError(
      429,
      body({
        error: {
          type: 'quota_exceeded',
          plan: 'pro',
          monthly_used: 10_000_000,
          monthly_cap: 10_000_000,
          resets_at: '2026-12-01T00:00:00Z',
        },
      }),
    )
    expect(info.details).toContainEqual({ label: 'Monthly usage', value: '10,000,000 of 10,000,000' })
    expect(info.resetsAt).toBe('2026-12-01T00:00:00Z')
    expect(info.retryable).toBe(false)
  })

  it('429 Too Many Attempts uses Retry-After and X-RateLimit-Limit', () => {
    const info = describeHttpError(
      429,
      body({ message: 'Too Many Attempts.' }),
      headers({ 'Retry-After': '7', 'X-RateLimit-Limit': '60' }),
    )
    expect(info.retryAfterSeconds).toBe(7)
    expect(info.action).toContain('Wait 7 seconds')
    expect(info.action).toContain('60 requests per minute')
    expect(info.retryable).toBe(true)
  })

  it('503 model_unavailable says the API will not switch models', () => {
    const info = describeHttpError(
      503,
      body({ error: { type: 'model_unavailable', message: 'No server.', model: 'gemma4-26b-a4b-qat' } }),
    )
    expect(info.title).toContain('gemma4-26b-a4b-qat')
    expect(info.action).toMatch(/never switches/)
    expect(info.retryable).toBe(true)
  })

  it.each([
    [502, 'upstream_unreachable', true],
    [502, 'upstream_timeout', true],
    [502, 'no_usage_accounting', true],
    [503, 'server_busy', true],
    [504, 'upstream_timeout', true],
  ])('%i %s is retryable', (status, type, retryable) => {
    const info = describeHttpError(status, body({ error: { type, message: 'x', request_id: 'req-1' } }))
    expect(info.type).toBe(type)
    expect(info.retryable).toBe(retryable)
    expect(info.details).toContainEqual({ label: 'Request id', value: 'req-1' })
  })

  it('upstream_error is retryable only for 5xx upstream statuses', () => {
    expect(describeHttpError(502, body({ error: { type: 'upstream_error', status: 500 } })).retryable).toBe(
      true,
    )
    expect(describeHttpError(502, body({ error: { type: 'upstream_error', status: 400 } })).retryable).toBe(
      false,
    )
  })

  it('524 HTML from the edge suggests streaming and never shows the HTML', () => {
    const info = describeHttpError(524, '<!DOCTYPE html><title>524</title>')
    expect(info.title).toContain('524')
    expect(info.action).toMatch(/streaming/)
    expect(info.message).toBeNull()
    expect(info.retryable).toBe(true)
  })

  it('maps playground-server errors separately from API errors', () => {
    const auth = describeHttpError(
      401,
      body({ error: { type: 'playground_auth_required', message: 'Token.' } }),
    )
    expect(auth.source).toBe('playground')
    expect(auth.title).toBe('Access token needed')
    const limited = describeHttpError(
      429,
      body({ error: { type: 'playground_rate_limited', message: 'Slow down.' } }),
      headers({ 'Retry-After': '12' }),
    )
    expect(limited.source).toBe('playground')
    expect(limited.retryAfterSeconds).toBe(12)
    const tooBig = describeHttpError(
      413,
      body({ error: { type: 'playground_body_too_large', message: 'Big.' } }),
    )
    expect(tooBig.action).toContain('PLAYGROUND_MAX_BODY_BYTES')
  })

  it('handles unknown statuses and empty bodies', () => {
    expect(describeHttpError(500, '').retryable).toBe(true)
    expect(describeHttpError(418, 'teapot').retryable).toBe(false)
  })
})

describe('describeStreamError', () => {
  it('preempted asks for a retry in about a minute', () => {
    const info = describeStreamError({ type: 'preempted', message: 'Server reclaimed.' })
    expect(info.source).toBe('stream')
    expect(info.status).toBeNull()
    expect(info.action).toMatch(/about a minute/)
    expect(info.retryable).toBe(true)
  })

  it('upstream_timeout shows elapsed_s', () => {
    const info = describeStreamError({ type: 'upstream_timeout', message: 'Busy.', elapsed_s: 181.2 })
    expect(info.details).toContainEqual({ label: 'Elapsed', value: '181.2 s' })
  })

  it('upstream_error shows the upstream status', () => {
    const info = describeStreamError({ type: 'upstream_error', status: 503 })
    expect(info.details[0]).toEqual({ label: 'Upstream status', value: '503' })
    expect(info.retryable).toBe(true)
  })

  it('unknown types still produce a message', () => {
    expect(describeStreamError({}).title).toBe('The stream ended with an error')
  })
})

describe('other failures', () => {
  it('network and truncated-stream errors are retryable', () => {
    expect(describeNetworkError().retryable).toBe(true)
    expect(describeTruncatedStream().type).toBe('stream_truncated')
  })
})
