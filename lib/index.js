/**
 * Sliding renewal for the DSH web browser-session cookie.
 *
 * DSH mints its `dsh-auth-*` cookie once, during the `?token=` exchange at
 * `GET /`, with an absolute expiry (`cookieMaxAgeDays`, default 30). Nothing
 * refreshes it afterwards, so even a browser that visits every day has to
 * reopen the tokenized startup URL once that absolute lifetime elapses.
 *
 * This host plugin listens on Connection's `connection/request` waterfall,
 * which wraps every authenticated `/api` HTTP request after admission and
 * before the response is written. When the browser cookie's remaining lifetime
 * falls below a fraction of its total lifetime, the plugin re-runs DSH's own
 * token exchange against a synthetic request/response pair and copies the
 * resulting `Set-Cookie` onto the live response.
 *
 * Consequences of that design:
 * - It is event-driven, not a timer. Renewal happens while the page is in use.
 * - It only works while the cookie is still valid: admission rejects an expired
 *   cookie before this hook runs, so a lapsed session still needs the token URL.
 * - It never reads the signing secret and never reproduces the cookie's
 *   signature; the payload parse below is an untrusted scheduling hint only.
 *
 * @module dsh-cookie-renew
 */

import z from '@deepseek-ai/schemastery'

/** Stable Cordis plugin name. */
export const name = 'cookie-renew'

/** Services required before the plugin can attach its listener. */
export const inject = ['connection']

/** Prefix shared by every browser-session cookie DSH mints. */
const COOKIE_PREFIX = 'dsh-auth-'

/** Defaults applied when the plugin config omits a field. */
const DEFAULTS = Object.freeze({
  renewBelowFraction: 0.5,
  minIntervalMinutes: 60,
  debug: false,
})

/** Upper bound for the throttle in minutes: 365 days. */
const MAX_INTERVAL_MINUTES = 365 * 24 * 60

/**
 * Plugin config schema. Every field is volatile, so the Host settings service
 * can expose it to an automatic settings page without remounting the plugin.
 * Descriptions explain each field to form UIs; the bounds are strict, so an
 * out-of-range profile value fails validation at load.
 */
export const Config = z.object({
  renewBelowFraction: z.number()
    .default(DEFAULTS.renewBelowFraction)
    .min(Number.MIN_VALUE)
    .max(1)
    .description(
      'Renew when the session cookie has at most this fraction of its lifetime left; ' +
      '0.5 renews halfway, 1 renews on the first eligible request per throttle window.',
    )
    .volatile(),
  minIntervalMinutes: z.number()
    .default(DEFAULTS.minIntervalMinutes)
    .min(0)
    .max(MAX_INTERVAL_MINUTES)
    .description(
      'Minimum minutes between renewals for the same authority; 0 disables the throttle. ' +
      'Values above 525600 (365 days) are rejected.',
    )
    .volatile(),
  debug: z.boolean()
    .default(DEFAULTS.debug)
    .description('Log each successful cookie renewal through the plugin logger.')
    .volatile(),
}).description('Browser-session cookie renewal for DSH Connection.')

/** Largest cookie value body the parser is willing to decode. */
const MAX_PAYLOAD_BYTES = 4096

/**
 * Unwrap a config field. Cordis supplies a live reference with `get()` for a
 * volatile field; tests and programmatic callers may supply the plain value.
 *
 * @param value - plain config value or live reference.
 * @returns the current plain value.
 */
function configValue(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function'
    ? value.get()
    : value
}

/**
 * Recompute the authority exactly as Connection does for its cookies: the
 * origin under TLS (scheme included), the bare host under plain HTTP.
 *
 * @param host - the request's `Host` header.
 * @param secure - whether the receiving listener serves TLS.
 * @returns the normalized authority, or undefined for a malformed Host.
 */
export function requestAuthority(host, secure) {
  if (typeof host !== 'string' || host.length === 0) return undefined
  try {
    const url = new URL(`${secure ? 'https:' : 'http:'}//${host}`)
    return secure ? url.origin : url.host
  } catch {
    return undefined
  }
}

/**
 * Decode the signed payload's JSON body. The signature is deliberately not
 * checked: the value is only consulted to schedule renewal, never trusted.
 *
 * @param value - one `dsh-auth-*` cookie value.
 * @returns the decoded payload, or undefined when malformed.
 */
export function decodePayload(value) {
  if (typeof value !== 'string' || value.length > MAX_PAYLOAD_BYTES) return undefined
  const parts = value.split('.')
  if (parts.length !== 3) return undefined
  const [version, body] = parts
  if (version !== 'v1' && version !== 'v2') return undefined
  let decoded
  try {
    decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) return undefined
  const { version: payloadVersion, authority, issuedAt, expiresAt } = decoded
  if ((payloadVersion !== 1 && payloadVersion !== 2) || `v${payloadVersion}` !== version) return undefined
  if (typeof authority !== 'string' || authority.length === 0) return undefined
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)) return undefined
  return { version: payloadVersion, authority, issuedAt, expiresAt }
}

/**
 * Report the first `dsh-auth-*` payload version this plugin does not parse.
 *
 * Unknown versions are skipped by `decodePayload`, which would otherwise make a
 * future DSH release stop renewal silently. This helper exists only to turn
 * that drift into a one-time warning.
 *
 * @param header - the request's `Cookie` header.
 * @returns the unsupported version token (for example `v3`), if any.
 */
export function findUnsupportedVersion(header) {
  if (typeof header !== 'string') return undefined
  for (const segment of header.split(';')) {
    const at = segment.indexOf('=')
    if (at < 0) continue
    if (!segment.slice(0, at).trim().startsWith(COOKIE_PREFIX)) continue
    const parts = segment.slice(at + 1).trim().split('.')
    if (parts.length !== 3) continue
    const version = parts[0]
    if (version === 'v1' || version === 'v2') continue
    if (/^v\d+$/u.test(version)) return version
  }
  return undefined
}

/**
 * Find the browser-session cookie belonging to one authority.
 *
 * Several `dsh-auth-*` cookies can coexist (cookies are not port-scoped), so
 * candidates are matched by the authority inside their payload. When more than
 * one matches, the earliest valid expiry wins so a planted far-future value
 * cannot stop a genuinely expiring cookie from being renewed. Degenerate or
 * already-elapsed payloads are skipped for the same reason: they must not win
 * selection and then veto renewal in `renew`.
 *
 * @param header - the request's `Cookie` header.
 * @param authority - normalized request authority.
 * @param now - current epoch milliseconds, injected for tests.
 * @returns the matching cookie value and payload, if any.
 */
export function findSessionCookie(header, authority, now = Date.now()) {
  if (typeof header !== 'string') return undefined
  let best
  for (const segment of header.split(';')) {
    const at = segment.indexOf('=')
    if (at < 0) continue
    const cookieName = segment.slice(0, at).trim()
    if (!cookieName.startsWith(COOKIE_PREFIX)) continue
    const value = segment.slice(at + 1).trim()
    const payload = decodePayload(value)
    if (payload === undefined || payload.version !== 1 || payload.authority !== authority) continue
    if (payload.expiresAt <= payload.issuedAt) continue
    if (payload.issuedAt > now || payload.expiresAt <= now) continue
    if (best === undefined || payload.expiresAt < best.payload.expiresAt) best = { value, payload }
  }
  return best
}

/**
 * Re-run DSH's launch-token exchange to obtain a freshly minted cookie.
 *
 * `authenticatedUrl` exposes the process token and `authorizeIndex` performs
 * the exchange; both are public Connection members, so this stays independent
 * of the cookie format and the signing secret. The synthetic response captures
 * the status and `Set-Cookie` header.
 *
 * @param connection - the host Connection service (`ctx.connection`).
 * @param protocol - `'http:'` or `'https:'` of the receiving listener.
 * @param headers - the live request headers (Host and Cookie are all DSH reads).
 * @param onFailure - optional receiver for a human-readable failure reason.
 * @returns the serialized Set-Cookie value, or undefined when minting failed.
 */
export function mintCookie(connection, protocol, headers, onFailure) {
  const fail = (reason) => {
    onFailure?.(reason)
    return undefined
  }
  const host = headers?.host
  if (typeof host !== 'string' || host.length === 0) return fail('missing Host header')
  let tokenUrl
  try {
    tokenUrl = connection.authenticatedUrl(`${protocol}//${host}/`)
  } catch (error) {
    return fail(`authenticatedUrl() failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  let token
  try {
    token = new URL(tokenUrl).searchParams.get('token')
  } catch {
    return fail('authenticatedUrl() returned an invalid URL')
  }
  if (token === null || token.length === 0) return fail('authenticatedUrl() returned no token')
  let status
  let cookie
  const response = {
    writeHead(code, outgoing) {
      status = code
      if (outgoing !== null && typeof outgoing === 'object') {
        for (const [name, value] of Object.entries(outgoing)) {
          if (name.toLowerCase() === 'set-cookie') cookie = value
        }
      }
    },
    end() {},
  }
  try {
    connection.authorizeIndex(
      { method: 'GET', url: `/?token=${encodeURIComponent(token)}`, headers },
      response,
    )
  } catch (error) {
    return fail(`authorizeIndex() failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (status !== 303) return fail(`token exchange returned status ${String(status)}`)
  if (typeof cookie !== 'string' || cookie.length === 0) {
    return fail('token exchange returned no Set-Cookie header')
  }
  return cookie
}

/**
 * Attach the renewal listener to Connection.
 *
 * @param ctx - Host plugin context.
 * @param rawConfig - optional plugin config.
 */
export function apply(ctx, rawConfig) {
  const logger = ctx.logger?.('cookie-renew')
  const currentConfig = () => {
    const minIntervalMinutes = configValue(rawConfig?.minIntervalMinutes) ?? DEFAULTS.minIntervalMinutes
    return {
      renewBelowFraction: configValue(rawConfig?.renewBelowFraction) ?? DEFAULTS.renewBelowFraction,
      minIntervalMinutes,
      minIntervalMs: minIntervalMinutes * 60_000,
      debug: configValue(rawConfig?.debug) ?? DEFAULTS.debug,
    }
  }

  const missing = ['authenticatedUrl', 'authorizeIndex']
    .filter((method) => typeof ctx.connection?.[method] !== 'function')
  if (missing.length > 0) {
    logger?.warn(
      'Connection does not expose %s(); browser-cookie renewal is disabled',
      missing.join(', '),
    )
    return
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.effect(
        () => settingsCtx.settings.configure({ auto: true }, ctx.fiber),
        'cookie-renew: automatic settings form',
      )
    })
  }

  const lastMint = new Map()
  const reported = new Set()

  const reportOnce = (key, message, ...args) => {
    if (reported.has(key)) return
    reported.add(key)
    logger?.warn(message, ...args)
  }

  const renew = (req, res) => {
    try {
      if (res.headersSent === true) return
      const protocol = ctx.get('webServer')?.protocol === 'https:' ? 'https:' : 'http:'
      const headers = req?.headers ?? {}
      const authority = requestAuthority(headers.host, protocol === 'https:')
      if (authority === undefined) return
      const unsupported = findUnsupportedVersion(headers.cookie)
      if (unsupported !== undefined) {
        reportOnce(`version:${unsupported}`, 'ignoring a dsh-auth cookie with unsupported payload version %s', unsupported)
      }

      const now = Date.now()
      const found = findSessionCookie(headers.cookie, authority, now)
      if (found === undefined) return

      const config = currentConfig()
      const lifetime = found.payload.expiresAt - found.payload.issuedAt
      const remaining = found.payload.expiresAt - now
      if (lifetime <= 0 || remaining <= 0) return
      if (remaining > lifetime * config.renewBelowFraction) return
      if (now - (lastMint.get(authority) ?? 0) < config.minIntervalMs) return

      let failure
      const cookie = mintCookie(ctx.connection, protocol, headers, (reason) => { failure = reason })
      if (cookie === undefined) {
        reportOnce(`mint:${authority}`, 'could not mint a replacement browser cookie for %s: %s', authority, failure ?? 'unknown reason')
        return
      }
      res.setHeader('set-cookie', cookie)
      lastMint.set(authority, now)
      if (config.debug) logger?.info('renewed the browser cookie for %s', authority)
    } catch (error) {
      reportOnce('renew', 'browser-cookie renewal failed: %s', error instanceof Error ? error.message : String(error))
    }
  }

  ctx.on('connection/request', async (req, res, next) => {
    renew(req, res)
    await next()
  })
}
