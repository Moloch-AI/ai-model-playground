// Maps API and playground errors to a message for people: what happened and what to do next.
// Code decides on the HTTP status, `type`/`code` and headers, never on message text; the server's
// own message is shown as-is because it can carry extra detail.

import { LINKS } from './links'
import type { StreamErrorPayload } from './stream'

export type ErrorSource = 'api' | 'playground' | 'stream' | 'network'

export interface ErrorLink {
  label: string
  href: string
}

export interface ErrorInfo {
  source: ErrorSource
  status: number | null
  type: string | null
  title: string
  /** The server's own message, if any. */
  message: string | null
  /** What to do next. */
  action: string
  retryable: boolean
  fields: Array<{ field: string; messages: string[] }>
  details: Array<{ label: string; value: string }>
  links: ErrorLink[]
  resetsAt: string | null
  retryAfterSeconds: number | null
}

export interface HeaderReader {
  get(name: string): string | null
}

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function fmtInt(value: number): string {
  return value.toLocaleString('en-US')
}

/** "2026-11-13T12:00:00Z" -> local time plus the original value. */
export function formatResetTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${date.toLocaleString()} (${iso})`
}

function base(partial: Partial<ErrorInfo> & Pick<ErrorInfo, 'title' | 'action'>): ErrorInfo {
  return {
    source: 'api',
    status: null,
    type: null,
    message: null,
    retryable: false,
    fields: [],
    details: [],
    links: [],
    resetsAt: null,
    retryAfterSeconds: null,
    ...partial,
  }
}

function parseRetryAfter(headers?: HeaderReader): number | null {
  const raw = headers?.get('retry-after')
  if (!raw) return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds)
  const date = Date.parse(raw)
  if (Number.isNaN(date)) return null
  return Math.max(0, Math.ceil((date - Date.now()) / 1000))
}

function requestIdDetail(error: Json): Array<{ label: string; value: string }> {
  const id = str(error.request_id)
  return id ? [{ label: 'Request id', value: id }] : []
}

function describePlayground(
  status: number,
  type: string,
  message: string | null,
  headers?: HeaderReader,
): ErrorInfo {
  const common = { source: 'playground' as const, status, type, message }
  const retryAfter = parseRetryAfter(headers)
  switch (type) {
    case 'playground_auth_required':
      return base({
        ...common,
        title: 'Access token needed',
        action: 'Enter the access token set in PLAYGROUND_ACCESS_TOKEN on the playground server.',
      })
    case 'playground_rate_limited':
      return base({
        ...common,
        title: 'Too many requests to this playground',
        action: `Wait ${retryAfter ?? 'a few'} seconds, then send again. The server allows PLAYGROUND_RATE_LIMIT requests per minute per address.`,
        retryable: true,
        retryAfterSeconds: retryAfter,
      })
    case 'playground_body_too_large':
      return base({
        ...common,
        title: 'Request too large for the playground server',
        action: 'Shorten the conversation, or raise PLAYGROUND_MAX_BODY_BYTES on the server.',
      })
    case 'playground_upstream_unreachable':
      return base({
        ...common,
        title: 'The playground server could not reach the API',
        action: 'Check MOLOCHAI_BASE_URL and the server’s network connection, then send again.',
        retryable: true,
      })
    case 'playground_upstream_redirect':
      return base({
        ...common,
        title: 'The API answered with a redirect',
        action: 'Set MOLOCHAI_BASE_URL to the final https:// URL and restart the playground server.',
      })
    case 'playground_forbidden_host':
    case 'playground_forbidden_origin':
      return base({
        ...common,
        title: 'Blocked by the playground server',
        action:
          'Without an access token the server only answers on localhost. Open it through http://localhost:<port>, or set PLAYGROUND_ACCESS_TOKEN (see the README’s Security section).',
      })
    default:
      return base({
        ...common,
        title: `Playground server error (${status})`,
        action:
          status >= 500 ? 'Check the server console, then send again.' : 'Check the request and send again.',
        retryable: status >= 500,
      })
  }
}

/** Describe a failed HTTP response (any status >= 400). The body may or may not be JSON. */
export function describeHttpError(status: number, bodyText: string, headers?: HeaderReader): ErrorInfo {
  let json: Json | null = null
  try {
    const parsed: unknown = JSON.parse(bodyText)
    if (isRecord(parsed)) json = parsed
  } catch {
    json = null
  }
  const error = json && isRecord(json.error) ? json.error : null
  const type = str(error?.type) ?? str(json?.code)
  const message = str(error?.message) ?? str(json?.message)

  if (type?.startsWith('playground_')) return describePlayground(status, type, message, headers)

  const common = { source: 'api' as const, status, type, message }
  const retryAfter = parseRetryAfter(headers)
  const extra = error ?? {}

  switch (status) {
    case 401:
      return base({
        ...common,
        title: 'The API did not accept the key',
        action:
          'Check MOLOCHAI_API_KEY in the playground server’s environment (.env), then restart the server. The key may be mistyped or revoked; keys are created in the dashboard.',
        links: [{ label: 'API keys', href: LINKS.apiKeys }],
      })
    case 402: {
      const plan = str(extra.plan)
      return base({
        ...common,
        title: 'No active plan and no credit',
        action: 'Choose a plan or add credit in the dashboard, then send again.',
        details: plan ? [{ label: 'Plan', value: plan }] : [],
        links: [
          { label: 'Dashboard', href: LINKS.dashboard },
          { label: 'Pricing', href: LINKS.pricing },
        ],
      })
    }
    case 403:
      if (type === 'email_unverified') {
        return base({
          ...common,
          title: 'Email address not verified',
          action: 'Confirm the email address on the account (see the dashboard), then send again.',
          links: [{ label: 'Dashboard', href: LINKS.dashboard }],
        })
      }
      return base({
        ...common,
        title: 'Access denied (403)',
        action: 'The API refused this request for this key. Check the account in the dashboard.',
        links: [{ label: 'Dashboard', href: LINKS.dashboard }],
      })
    case 413: {
      const cap = num(extra.context_cap)
      const estimated = num(extra.estimated_tokens)
      const boundBy = str(extra.bound_by)
      const plan = str(extra.plan)
      const details: ErrorInfo['details'] = []
      if (estimated !== null) details.push({ label: 'Estimated prompt tokens', value: fmtInt(estimated) })
      if (cap !== null) details.push({ label: 'Context limit', value: `${fmtInt(cap)} tokens` })
      if (boundBy === 'plan') {
        details.push({ label: 'Limit set by', value: plan ? `your plan (${plan})` : 'your plan' })
      } else if (boundBy === 'server') {
        details.push({ label: 'Limit set by', value: 'the server serving this model' })
      }
      const action =
        boundBy === 'server'
          ? 'Shorten the system message or remove earlier turns. The serving server’s limit is lower than your plan’s, so a bigger plan would not help here.'
          : boundBy === 'plan'
            ? 'Shorten the system message or remove earlier turns. A plan with a larger context also raises this limit.'
            : 'Shorten the system message or remove earlier turns, then send again.'
      return base({
        ...common,
        title: 'The prompt is longer than the context limit',
        action,
        details,
        links: boundBy === 'plan' ? [{ label: 'Pricing', href: LINKS.pricing }] : [],
      })
    }
    case 422: {
      const fields: ErrorInfo['fields'] = []
      const errors = json && isRecord(json.errors) ? json.errors : {}
      for (const [field, value] of Object.entries(errors)) {
        const messages = Array.isArray(value) ? value.filter((m): m is string => typeof m === 'string') : []
        fields.push({ field, messages })
      }
      const modelInvalid = fields.some((f) => f.field === 'model')
      return base({
        ...common,
        type: type ?? 'validation_error',
        title: 'The API rejected the request',
        action: modelInvalid
          ? 'The model id is not in the catalog. Pick a model from the list (use Refresh to reload it).'
          : 'Fix the fields listed below, then send again.',
        fields,
      })
    }
    case 429: {
      const resetsAt = str(extra.resets_at)
      if (type === 'session_quota_exceeded') {
        return base({
          ...common,
          title: 'Session limit reached (5-hour window)',
          action: 'Wait until the session window resets. The playground does not retry this automatically.',
          resetsAt,
          details: resetsAt ? [{ label: 'Resets at', value: formatResetTime(resetsAt) }] : [],
        })
      }
      if (type === 'quota_exceeded') {
        const details: ErrorInfo['details'] = []
        const plan = str(extra.plan)
        if (plan) details.push({ label: 'Plan', value: plan })
        for (const period of ['monthly', 'weekly'] as const) {
          const used = num(extra[`${period}_used`])
          const cap = num(extra[`${period}_cap`])
          if (used !== null && cap !== null) {
            details.push({
              label: `${period === 'monthly' ? 'Monthly' : 'Weekly'} usage`,
              value: `${fmtInt(used)} of ${fmtInt(cap)}`,
            })
          }
        }
        if (resetsAt) details.push({ label: 'Resets at', value: formatResetTime(resetsAt) })
        return base({
          ...common,
          title: 'Quota used up',
          action:
            'Wait until the quota resets, or add credit in the dashboard. The playground does not retry this automatically.',
          resetsAt,
          details,
          links: [{ label: 'Dashboard', href: LINKS.dashboard }],
        })
      }
      const limit = headers?.get('x-ratelimit-limit')
      return base({
        ...common,
        title: 'Rate limit reached',
        action: `Wait ${retryAfter ?? 'a few'} seconds, then send again.${limit ? ` The API allows ${limit} requests per minute per account.` : ''}`,
        retryable: true,
        retryAfterSeconds: retryAfter,
      })
    }
    case 502:
    case 503:
    case 504:
      return describeGatewayFailure(status, type, extra, common)
    case 524:
      return base({
        ...common,
        message: null,
        type: type ?? 'edge_timeout',
        title: 'Edge timeout (524)',
        action:
          'Cloudflare in front of the API gives up on a plain request after about 100 seconds. Turn streaming on and send again.',
        retryable: true,
      })
    default:
      return base({
        ...common,
        title: status >= 500 ? `Server error (${status})` : `Request failed (${status})`,
        action: status >= 500 ? 'Send again in a few seconds.' : 'Check the request and send again.',
        retryable: status >= 500,
        details: requestIdDetail(extra),
      })
  }
}

function describeGatewayFailure(
  status: number,
  type: string | null,
  error: Json,
  common: Pick<ErrorInfo, 'source' | 'status' | 'type' | 'message'>,
): ErrorInfo {
  const details = requestIdDetail(error)
  const backoff = 'Send again in a few seconds; wait longer between repeated tries.'
  switch (type) {
    case 'model_unavailable': {
      const model = str(error.model)
      return base({
        ...common,
        title: `No server is serving ${model ?? 'this model'} right now`,
        action:
          'Try again in a few minutes, or pick another model. The API never switches to a different model for you.',
        retryable: true,
        details: model ? [{ label: 'Model', value: model }, ...details] : details,
      })
    }
    case 'server_busy':
      return base({
        ...common,
        title: 'All model servers are busy',
        action: backoff,
        retryable: true,
        details,
      })
    case 'upstream_timeout':
      return base({
        ...common,
        title: 'The model server took too long',
        action: `${backoff} Streaming avoids most timeouts.`,
        retryable: true,
        details,
      })
    case 'upstream_unreachable':
      return base({
        ...common,
        title: 'The model server could not be reached',
        action: backoff,
        retryable: true,
        details,
      })
    case 'no_usage_accounting':
      return base({
        ...common,
        title: 'The request could not be accounted for',
        action: `${backoff} If it keeps happening, contact support with the request id.`,
        retryable: true,
        details,
        links: [{ label: 'Contact', href: LINKS.contact }],
      })
    case 'upstream_error': {
      const upstreamStatus = num(error.status)
      const retryable = upstreamStatus === null || upstreamStatus >= 500
      return base({
        ...common,
        title: `The model server returned an error${upstreamStatus ? ` (${upstreamStatus})` : ''}`,
        action: retryable
          ? backoff
          : 'Check the request; sending it again unchanged will likely fail the same way.',
        retryable,
        details,
      })
    }
    default:
      return base({
        ...common,
        title: `Server error (${status})`,
        action: backoff,
        retryable: true,
        details,
      })
  }
}

/** Describe an error event that arrived inside a stream (the HTTP status was 200). */
export function describeStreamError(payload: StreamErrorPayload): ErrorInfo {
  const type = str(payload.type)
  const common = { source: 'stream' as const, status: null, type, message: str(payload.message) }
  const details = requestIdDetail(payload)
  const elapsed = num(payload.elapsed_s)
  if (elapsed !== null) details.push({ label: 'Elapsed', value: `${elapsed} s` })
  const partial = 'Any text above is incomplete.'
  switch (type) {
    case 'preempted':
      return base({
        ...common,
        title: 'The server stopped mid-reply (preempted)',
        action: `The server serving this model was reclaimed. Send again in about a minute. ${partial}`,
        retryable: true,
        details,
      })
    case 'upstream_timeout':
      return base({
        ...common,
        title: 'The model server timed out mid-reply',
        action: `Send again in a few seconds. ${partial}`,
        retryable: true,
        details,
      })
    case 'server_busy':
      return base({
        ...common,
        title: 'All model servers are busy',
        action: `Send again in a few seconds. ${partial}`,
        retryable: true,
        details,
      })
    case 'upstream_unreachable':
      return base({
        ...common,
        title: 'Lost the model server mid-reply',
        action: `Send again in a few seconds. ${partial}`,
        retryable: true,
        details,
      })
    case 'upstream_error': {
      const upstreamStatus = num(payload.status)
      if (upstreamStatus !== null)
        details.unshift({ label: 'Upstream status', value: String(upstreamStatus) })
      return base({
        ...common,
        title: 'The model server returned an error mid-reply',
        action: `Send again in a few seconds. ${partial}`,
        retryable: upstreamStatus === null || upstreamStatus >= 500,
        details,
      })
    }
    default:
      return base({
        ...common,
        title: 'The stream ended with an error',
        action: `Send again. ${partial}`,
        retryable: true,
        details,
      })
  }
}

/** The browser could not reach the playground server at all. */
export function describeNetworkError(): ErrorInfo {
  return base({
    source: 'network',
    title: 'Could not reach the playground server',
    action: 'Check that the server (npm start or npm run dev) is still running, then send again.',
    retryable: true,
  })
}

/** The stream ended without [DONE] and without an error event. */
export function describeTruncatedStream(): ErrorInfo {
  return base({
    source: 'stream',
    type: 'stream_truncated',
    title: 'The stream ended early',
    action: 'The connection closed before the reply finished. Send again. Any text above is incomplete.',
    retryable: true,
  })
}
