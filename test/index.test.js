import assert from 'node:assert/strict'
import test from 'node:test'
import {
  apply,
  Config,
  decodePayload,
  findSessionCookie,
  findUnsupportedVersion,
  mintCookie,
  requestAuthority,
} from '../lib/index.js'

const DAY = 86_400_000

/** Serialize a payload the way DSH does, without a usable signature. */
function cookie(authority, issuedAt, expiresAt, version = 1, name = 'dsh-auth-demo') {
  const body = Buffer.from(JSON.stringify({ version, authority, issuedAt, expiresAt, id: 'peer' })).toString('base64url')
  return { header: `${name}=v${version}.${body}.c2ln`, value: `v${version}.${body}.c2ln` }
}

/** Minimal Cordis context capturing the Connection listener and mints. */
function harness(rawConfig, options = {}) {
  let listener
  const warnings = []
  const minted = options.minted ?? 'dsh-auth-demo=v1.minted.sig'
  const ctx = {
    logger: () => ({
      warn: (...args) => warnings.push(args.map(String).join(' ')),
      info: () => {},
    }),
    get: (service) => (service === 'webServer' ? { protocol: options.protocol ?? 'http:' } : undefined),
    on: (event, fn) => {
      assert.equal(event, 'connection/request')
      listener = fn
    },
    connection: {
      authenticatedUrl: (base) => `${base}?token=test-token`,
      authorizeIndex: (req, res) => {
        if (options.mintFails === true) return
        res.writeHead(303, { 'set-cookie': minted })
        res.end()
      },
    },
  }
  apply(ctx, rawConfig)
  assert.equal(typeof listener, 'function')
  return {
    warnings,
    async dispatch(req, res = fakeResponse()) {
      let nextCalled = false
      await listener(req, res, async () => { nextCalled = true })
      return { res, nextCalled }
    },
  }
}

/** A response double recording Set-Cookie writes. */
function fakeResponse() {
  const headers = {}
  return {
    headersSent: false,
    headers,
    setHeader(name, value) { headers[name.toLowerCase()] = value },
  }
}

function request(host, cookieHeader) {
  return { headers: { host, cookie: cookieHeader } }
}

test('parses the authority the way Connection does', () => {
  assert.equal(requestAuthority('127.0.0.1:3080', false), '127.0.0.1:3080')
  assert.equal(requestAuthority('127.0.0.1:80', false), '127.0.0.1')
  assert.equal(requestAuthority('Example.COM:443', true), 'https://example.com')
  assert.equal(requestAuthority(undefined, false), undefined)
  assert.equal(requestAuthority('bad host', false), undefined)
})

test('decodes v1 and v2 payloads and rejects malformed values', () => {
  const now = Date.now()
  const v1 = cookie('127.0.0.1:3080', now, now + DAY)
  assert.deepEqual(decodePayload(v1.value), { version: 1, authority: '127.0.0.1:3080', issuedAt: now, expiresAt: now + DAY })
  assert.equal(decodePayload('v9.body.sig'), undefined)
  assert.equal(decodePayload('v1.not-base64!!!.sig'), undefined)
  assert.equal(decodePayload('v1.' + Buffer.from('{}').toString('base64url') + '.sig'), undefined)
})

test('selects the matching session cookie and prefers the earliest expiry', () => {
  const now = Date.now()
  const other = cookie('127.0.0.1:4000', now, now + 2 * DAY, 1, 'dsh-auth-other')
  const late = cookie('127.0.0.1:3080', now, now + 20 * DAY, 1, 'dsh-auth-late')
  const soon = cookie('127.0.0.1:3080', now, now + 1 * DAY, 1, 'dsh-auth-soon')
  const found = findSessionCookie(`${other.header}; ${late.header}; ${soon.header}`, '127.0.0.1:3080')
  assert.equal(found.value, soon.value)
})

test('skips degenerate and elapsed candidates instead of vetoing renewal', () => {
  const now = Date.now()
  const good = cookie('127.0.0.1:3080', now - DAY, now + DAY)
  const degenerate = cookie('127.0.0.1:3080', now, now, 1, 'dsh-auth-degenerate')
  const elapsed = cookie('127.0.0.1:3080', now - 2 * DAY, now - DAY, 1, 'dsh-auth-elapsed')
  const found = findSessionCookie(
    `${degenerate.header}; ${elapsed.header}; ${good.header}`,
    '127.0.0.1:3080',
    now,
  )
  assert.equal(found.value, good.value)
})

test('reports an unsupported payload version and ignores it', () => {
  const now = Date.now()
  const future = cookie('127.0.0.1:3080', now - DAY, now + DAY, 3, 'dsh-auth-future')
  assert.equal(findUnsupportedVersion(future.header), 'v3')
  assert.equal(findSessionCookie(future.header, '127.0.0.1:3080', now), undefined)
  assert.equal(findUnsupportedVersion(cookie('127.0.0.1:3080', now, now + DAY).header), undefined)
  assert.equal(findUnsupportedVersion('other=v1.a.b'), undefined)
  assert.equal(findUnsupportedVersion('dsh-auth-bad=not-a-version'), undefined)
})

test('renews when the remaining lifetime is below the fraction', async () => {
  const now = Date.now()
  const h = harness({})
  const { res, nextCalled } = await h.dispatch(
    request('127.0.0.1:3080', cookie('127.0.0.1:3080', now - 20 * DAY, now + 10 * DAY).header),
  )
  assert.equal(nextCalled, true)
  assert.equal(res.headers['set-cookie'], 'dsh-auth-demo=v1.minted.sig')
})

test('warns once about an unsupported version and renews the valid cookie', async () => {
  const now = Date.now()
  const h = harness({})
  const future = cookie('127.0.0.1:3080', now - 20 * DAY, now + 10 * DAY, 3, 'dsh-auth-future')
  const real = cookie('127.0.0.1:3080', now - 20 * DAY, now + 10 * DAY)
  const header = `${future.header}; ${real.header}`

  const first = await h.dispatch(request('127.0.0.1:3080', header))
  assert.equal(first.res.headers['set-cookie'], 'dsh-auth-demo=v1.minted.sig')
  await h.dispatch(request('127.0.0.1:3080', header))
  assert.equal(h.warnings.filter((w) => w.includes('unsupported payload version')).length, 1)
})

test('leaves a fresh cookie alone', async () => {
  const now = Date.now()
  const h = harness({})
  const { res, nextCalled } = await h.dispatch(
    request('127.0.0.1:3080', cookie('127.0.0.1:3080', now - DAY, now + 29 * DAY).header),
  )
  assert.equal(nextCalled, true)
  assert.equal(res.headers['set-cookie'], undefined)
})

test('ignores an API cookie (v2), another authority, and a sent response', async () => {
  const now = Date.now()
  const h = harness({})
  const v2 = await h.dispatch(request('127.0.0.1:3080', cookie('127.0.0.1:3080', now - 20 * DAY, now + 10 * DAY, 2).header))
  assert.equal(v2.res.headers['set-cookie'], undefined)

  const other = await h.dispatch(request('127.0.0.1:3080', cookie('127.0.0.1:4000', now - 20 * DAY, now + 10 * DAY).header))
  assert.equal(other.res.headers['set-cookie'], undefined)

  const sent = fakeResponse()
  sent.headersSent = true
  const skipped = await h.dispatch(request('127.0.0.1:3080', cookie('127.0.0.1:3080', now - 20 * DAY, now + 10 * DAY).header), sent)
  assert.equal(skipped.res.headers['set-cookie'], undefined)
})

test('throttles a second mint inside minIntervalMinutes', async () => {
  const now = Date.now()
  const h = harness({ minIntervalMinutes: 60 })
  const header = cookie('127.0.0.1:3080', now - 20 * DAY, now + 10 * DAY).header
  const first = await h.dispatch(request('127.0.0.1:3080', header))
  assert.equal(first.res.headers['set-cookie'], 'dsh-auth-demo=v1.minted.sig')
  const second = await h.dispatch(request('127.0.0.1:3080', header))
  assert.equal(second.res.headers['set-cookie'], undefined)
  assert.equal(second.nextCalled, true)
})

test('reads volatile config references live', async () => {
  const now = Date.now()
  let minutes = 60
  const h = harness({ minIntervalMinutes: { get: () => minutes } })
  const header = cookie('127.0.0.1:3080', now - 20 * DAY, now + 10 * DAY).header

  const first = await h.dispatch(request('127.0.0.1:3080', header))
  assert.equal(first.res.headers['set-cookie'], 'dsh-auth-demo=v1.minted.sig')

  const throttled = await h.dispatch(request('127.0.0.1:3080', header))
  assert.equal(throttled.res.headers['set-cookie'], undefined)

  minutes = 0
  const live = await h.dispatch(request('127.0.0.1:3080', header))
  assert.equal(live.res.headers['set-cookie'], 'dsh-auth-demo=v1.minted.sig')
})

test('keeps serving API traffic when minting fails, warning once', async () => {
  const now = Date.now()
  const h = harness({}, { mintFails: true })
  const header = cookie('127.0.0.1:3080', now - 20 * DAY, now + 10 * DAY).header
  const first = await h.dispatch(request('127.0.0.1:3080', header))
  assert.equal(first.nextCalled, true)
  assert.equal(first.res.headers['set-cookie'], undefined)
  await h.dispatch(request('127.0.0.1:3080', header))
  assert.equal(h.warnings.filter((w) => w.includes('could not mint')).length, 1)
})


test('exports a volatile, bounded config schema for automatic forms', () => {
  assert.equal(Config.type, 'object')
  for (const field of ['renewBelowFraction', 'minIntervalMinutes', 'debug']) {
    assert.equal(Config.dict[field].meta.volatile, true, field)
  }
  assert.equal(Config.dict.renewBelowFraction.type, 'number')
  assert.equal(Config.dict.minIntervalMinutes.type, 'number')
  assert.equal(Config.dict.debug.type, 'boolean')
  assert.equal(Config.dict.renewBelowFraction.meta.max, 1)
  assert.ok(Config.dict.renewBelowFraction.meta.min > 0)
  assert.equal(Config.dict.minIntervalMinutes.meta.min, 0)
  assert.equal(Config.dict.minIntervalMinutes.meta.max, 365 * 24 * 60)
  assert.match(Config.meta.description, /cookie/i)
  assert.match(Config.dict.renewBelowFraction.meta.description, /halfway/i)
  assert.match(Config.dict.minIntervalMinutes.meta.description, /throttle/i)
  assert.match(Config.dict.debug.meta.description, /renewal/i)
})

test('rejects out-of-range values instead of repairing them', () => {
  for (const raw of [
    { renewBelowFraction: 2 },
    { renewBelowFraction: 0 },
    { minIntervalMinutes: -1 },
    { minIntervalMinutes: 1e12 },
  ]) {
    const result = Config['~standard'].validate(raw)
    assert.ok(result.issues, JSON.stringify(raw))
  }

  const valid = Config['~standard'].validate({
    renewBelowFraction: 0.5,
    minIntervalMinutes: 60,
    debug: false,
  })
  assert.equal(valid.issues, undefined)
  assert.equal(valid.value.renewBelowFraction.get(), 0.5)
})

test('disables itself when Connection lacks the token exchange', () => {
  const warnings = []
  let registered = false
  apply(
    {
      logger: () => ({ warn: (...args) => warnings.push(args.map(String).join(' ')), info: () => {} }),
      get: () => undefined,
      on: () => { registered = true },
      connection: {},
    },
    {},
  )
  assert.equal(registered, false)
  assert.match(warnings[0], /authenticatedUrl, authorizeIndex/)
})

test('opts into the automatic settings form', () => {
  const presentations = []
  apply(
    {
      logger: () => ({ warn: () => {}, info: () => {} }),
      get: () => undefined,
      on: () => {},
      connection: {
        authenticatedUrl: () => '',
        authorizeIndex: () => {},
      },
      inject: (_services, callback) => callback({
        effect: (run) => run(),
        settings: {
          configure: (policy) => { presentations.push(policy) },
        },
      }),
    },
    {},
  )
  assert.deepEqual(presentations, [{ auto: true }])
})

test('mints through the public token exchange only on a 303', () => {
  const connection = {
    authenticatedUrl: (base) => `${base}?token=tok`,
    authorizeIndex: (req, res) => {
      assert.equal(req.url, '/?token=tok')
      res.writeHead(303, { 'set-cookie': 'fresh=1' })
      res.end()
    },
  }
  assert.equal(mintCookie(connection, 'http:', { host: '127.0.0.1:3080' }), 'fresh=1')
  const refusing = { ...connection, authorizeIndex: (req, res) => res.writeHead(401) }
  const reasons = []
  assert.equal(
    mintCookie(refusing, 'http:', { host: '127.0.0.1:3080' }, (reason) => reasons.push(reason)),
    undefined,
  )
  assert.match(reasons[0], /status 401/)
})
