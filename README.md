# dsh-cookie-renew

[![CI](https://github.com/edisoncks/dsh-cookie-renew/actions/workflows/ci.yml/badge.svg)](https://github.com/edisoncks/dsh-cookie-renew/actions/workflows/ci.yml)

Sliding renewal for the DSH web GUI's browser-session cookie.

DSH mints its `dsh-auth-*` cookie once, during the `?token=` exchange at
`GET /`, with an absolute expiry (`connection.cookieMaxAgeDays`, default
30 days). Nothing refreshes it afterwards, so even a browser that visits
every day has to reopen the tokenized startup URL once that absolute
lifetime elapses.

This host plugin keeps the session alive while the GUI is in use. It listens on
Connection's `connection/request` waterfall — which wraps every authenticated
`/api` HTTP request after admission — and, when the cookie's remaining
lifetime drops below a fraction of its total lifetime, re-runs DSH's own token
exchange and attaches the fresh `Set-Cookie` to the live response.

- One runtime dependency (`@deepseek-ai/schemastery`), host-side only, Node >= 20.
- Installs from a pinned tag:
  `dsh plugin --profile web add github:edisoncks/dsh-cookie-renew#v1.0.0`
  (see **Install**).
- Never reads the signing secret and never signs a cookie itself.
- Turns an absolute 30-day credential into a renewable one (see **Caveats**).

## How it works

1. `connection/request` fires after `/api` admission and before the response
   is written. The listener always calls `next()`, so API traffic is untouched.
2. The plugin locates the `dsh-auth-*` cookie whose payload names the request's
   normalized authority (`host:port` over HTTP, `https://host[:port]` over
   TLS). The payload is only a scheduling hint — its signature is not trusted
   or checked. Candidates with a degenerate or already-elapsed payload are
   skipped, so a stale or planted value cannot mask the real cookie.
3. When `remaining <= lifetime * renewBelowFraction` and the throttle has
   elapsed, it mints a replacement:
   - `ctx.connection.authenticatedUrl()` exposes the process launch token;
   - `ctx.connection.authorizeIndex()` runs the real exchange against a
     synthetic `{ method: 'GET', url: '/?token=…', headers }` request;
   - the captured `Set-Cookie` is written to the real response.
4. The process token is never persisted, and the cookie keeps working across
   DSH restarts because the signing secret lives in
   `$DSH_HOME/.credentials.yaml`.

## Renewal cadence

Renewal is event-driven, not timed: it happens on the first `/api` request
after the threshold, while the page is open.

| Visits | Renewals with the default 30-day lifetime and `0.5` threshold |
|---|---|
| Daily | About every 15 days; expiry stays between 15 and 30 days out. |
| Every 20–29 days | Once per visit. |
| One long idle tab | None while idle; the last mint's expiry still stands, so a tab idle for the full lifetime still loses the session. |

`minIntervalMinutes` is a floor against mint storms, not the cadence.

## Install

The package is a DSH *bundle*. Its `package.json` declares
`dsh.bundle.patch: ./cordis.patch.yml`, and that file mounts the plugin through
an `insert:` row. Selecting the bundle in the profile
(`dsh.profile.bundles`) is what loads it **and** what makes it show up on the
sidebar **Plugins → Installed plugins** page with a switch.

Install the tagged release from GitHub. `dsh plugin` forwards to pnpm inside
the profile, so one command writes the dependency and selects the bundle:

```sh
dsh plugin --profile web add github:edisoncks/dsh-cookie-renew#v1.0.0
```

Pin a tag, not a branch: `#main` re-resolves to whatever the branch holds on
the next install, while `#v1.0.0` pins the released commit. pnpm installs
this package's one runtime dependency (`@deepseek-ai/schemastery`) itself, so
no local `npm install` is involved.

That command is shorthand for two edits in `~/.dsh/profiles/web/package.json`:

```json
"dependencies": {
  "dsh-cookie-renew": "github:edisoncks/dsh-cookie-renew#v1.0.0"
},
"dsh": {
  "profile": {
    "bundles": ["…", "dsh-cookie-renew"]
  }
}
```

If the profile already lists the dependency, just select the bundle: add
`"dsh-cookie-renew"` to `dsh.profile.bundles`, or flip its switch under
**Plugins → Installed plugins**.

`package.json` has no `private` field and is not published to a registry; the
git tag is the distribution channel.

### From a local checkout

For development against a working copy, install a link instead:

```sh
(cd "$HOME/codes/dsh-cookie-renew" && npm install)
dsh plugin --profile web add link:"$HOME/codes/dsh-cookie-renew"
```

A `link:` install resolves straight out of the checkout: the checkout needs
its own `node_modules`, and the package's `files` list and `engines.dsh` pin
are not enforced. A package has one dependency entry, so switching back is the
same `add` with the `github:…#vX.Y.Z` specifier, which replaces the `link:`
entry.

The entry's default config ships in the bundle patch. Override it from the
profile's own `cordis.patch.yml` by entry id:

```yaml
- id: dsh-cookie-renew
  name: dsh-cookie-renew
  config:
    renewBelowFraction: 0.5
    minIntervalMinutes: 60
```

Do not wrap that override in `insert:` — `insert:` adds a second entry, and the
old hand-wired install used it. A bare row targets the existing id; a bare row
whose id does not exist is silently skipped.

`package.json` declares `engines.dsh: ^0.2.1-rc.3`, the harness line this
plugin is verified against, so `dsh plugin` refuses to install it on a
runtime outside that range instead of failing later at renewal time.

Restart `dsh web` to mount the plugin. The existing cookie stays valid; no
token URL is needed.

The cookie lifetime itself still comes from the `connection` row's
`cookieMaxAgeDays`. Each successful renewal resets expiry to that full lifetime
from the moment of the mint.

## Config

| Field | Default | Meaning |
|---|---|---|
| `renewBelowFraction` | `0.5` | Renew when remaining lifetime is at or below this fraction of the total lifetime. `(0, 1]`; `1` renews on the first request each throttle window. |
| `minIntervalMinutes` | `60` | Never mint twice for one authority inside this window. `0` disables the throttle; values above 365 days are rejected. |
| `debug` | `false` | Log each successful renewal through `ctx.logger('cookie-renew')`. |

The Host validates the profile against the plugin's strict Schemastery schema:
use numbers for the two numeric fields and a boolean for `debug`, keep
`renewBelowFraction` in `(0, 1]`, and keep `minIntervalMinutes` between `0` and
365 days. A wrong-type or out-of-range value fails schema validation at load,
so this plugin entry does not activate; because the entry is optional, the rest
of DSH keeps running and the startup warning names the field.
`minIntervalMinutes: 0` deliberately disables the throttle.

The same strict schema backs the Host settings descriptors, so a settings-form
or config-editor write with an out-of-range value is rejected and leaves the
profile unchanged. The plugin exports the volatile `Config` and registers
`auto: true` with the Host settings service. That is the host side of an in-app
form: the Host exposes the descriptors, but this package ships no browser half,
so the current Web GUI has no form to render. A client that builds pages from
`autoGenerate` descriptors can consume them, including each field's description
and bounds; until then, edit these values in the profile patch.

## Verify

Open **Settings → Built-in plugins → Plugin list**, expand **Global**, and
search for `cookie`. The card shows **Cookie Renew**, its description, the
entry id `dsh-cookie-renew`, module `dsh-cookie-renew`, and an active fiber.

Both that card and the sidebar **Plugins** row draw the cookie icon from
`icon.svg`.

The sidebar **Plugins → Installed plugins** page also lists it, because that
page manages profile *bundles* and this package now declares one. Its switch
maps to the presence of `dsh-cookie-renew` in `dsh.profile.bundles`; the
package stays installed while the switch is off, and switching it back on
remounts the entry without a reinstall.

For a quick live check, set `debug: true` and `renewBelowFraction: 0.999`,
restart, and load the page once: the console logs one renewal and the cookie's
`Expires` jumps to the full lifetime. Set the fraction back afterwards.

## Display metadata

`locale/en.json` and `locale/zh.json` supply the title and description:

```json
{
  "meta": {
    "title": "Cookie Renew",
    "description": "Renews the DSH web browser session cookie before it expires."
  }
}
```

The inventory resolves `<package>/locale/en.json` and
`<package>/package.json` through Node's ESM resolver, so `package.json` must
export both subpaths:

```json
"exports": {
  ".": "./lib/index.js",
  "./locale/*.json": "./locale/*.json",
  "./package.json": "./package.json"
}
```

Without those exports the inventory silently falls back to the package name and
no description.

## Icon

`icon.svg` is the plugin art: a 36×36 (1:1) bitten cookie with chocolate chips,
flat SVG with two gradients and no external references. `package.json` declares
it as `"icon": "./icon.svg"`.

The inventory reads the icon without evaluating plugin code:

- The declared path is relative and must stay inside the package directory.
- The file is SVG, PNG, JPEG, or WebP, at most 256 KiB.
- Keep it square — the UI renders it in a square tile next to the title.
- A declared `icon` wins over an exported `<package>/icon` subpath, and the file
  must be listed in `package.json` `files` to ship.

## Package layout

| Path | Role |
|---|---|
| `cordis.patch.yml` | Bundle patch: `insert`s the `dsh-cookie-renew` entry with the default config. This is the layer the loader composes for the bundle. |
| `lib/index.js` | Host plugin: `name`, `inject: ['connection']`, `Config` (volatile schema), `apply(ctx, config)`, and exported helpers used by tests. |
| `icon.svg` | Square (36×36) plugin icon, declared through `package.json`'s `icon` field and embedded by the inventory as a data URL. |
| `locale/en.json`, `locale/zh.json` | Inventory title and description. |
| `test/index.test.js` | Threshold, throttle, authority/v2 filtering, candidate filtering, config schema (strict bounds) and live refs, diagnostics, failure handling, and minting tests. |
| `package.json` | ESM package, `dsh.bundle.patch` pointing at the bundle patch, `icon` pointing at the art, one dependency (`@deepseek-ai/schemastery`), `engines.node >= 20`, `engines.dsh ^0.2.1-rc.3`. |
| `LICENSE` | MIT license text. |
| `CHANGELOG.md` | Release notes, one section per tag. |
| `package-lock.json` | Lockfile for CI's `npm ci`; ignored when the package is consumed as a dependency. |
| `.github/workflows/ci.yml` | CI: `npm ci` and `npm test` on Node 20/22/24, plus the packed-file-list check. |

## Test

```sh
node --test test/*.test.js
```

The suite uses only `node:test`, so it needs no extra tooling. CI runs it on
Node 20, 22, and 24 against the lockfile, then checks that `npm pack` still
ships only the intended files.

## Releases

Releases are annotated git tags named `vX.Y.Z` on `main`, and `CHANGELOG.md`
records what changed. Installs should pin a tag
(`github:edisoncks/dsh-cookie-renew#v1.0.0`), so an upgrade is an explicit
edit of that tag rather than a silent move of a branch.

To cut one: bump `version` in `package.json`, add the matching
`CHANGELOG.md` heading, commit, then:

```sh
git tag -a v1.0.0 -m v1.0.0
git push --follow-tags
```

## Caveats

- **Only while valid.** Admission rejects an expired cookie before the hook
  runs, so a lapsed session still needs the printed `?token=` URL. This is a
  keep-alive, not a re-login.
- **Only `/api` HTTP requests.** WebSocket frames, static assets, and the index
  page do not trigger a mint. Every page load issues API calls, so normal use is
  covered.
- **Tied to the 0.2.1 line.** The hook and the two Connection methods are
  public, including the synthetic request/response shape, but the cookie
  prefix, the v1 payload shape, the authority spelling, the `303` status, and
  the lowercase `set-cookie` key are internal. `engines.dsh` pins the verified
  line, and an unknown payload version is logged once instead of stopping
  silently.
- **A stolen cookie becomes perpetually renewable.** Keep the GUI loopback-only,
  or bound exposure with `trustedHosts` and TLS.
- **Per authority.** Browsers ignore ports when sending cookies; DSH binds this
  cookie's name and payload to the request authority (`host:port` over HTTP,
  `https://host[:port]` over TLS) instead. Moving the GUI to another port
  therefore needs a fresh token exchange.

## Uninstall

Switch it off, then remove it — the manager drops both the bundle selection and
the profile dependency:

```sh
dsh plugin --profile web remove dsh-cookie-renew
```

Restart `dsh web`. Existing cookies remain valid until they expire. If you
installed it by hand around an older layout, also delete any leftover
`- insert:` block for it from `~/.dsh/profiles/web/cordis.patch.yml`, or the
entry comes back the next time the module resolves.

## Troubleshooting

- **`ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK` / read-only file system** when
  installing inside a file sandbox: pnpm 12 keeps its store operation lock under
  `$XDG_RUNTIME_DIR`, which may be read-only there. Retry with
  `env -u XDG_RUNTIME_DIR dsh plugin …`.
- **No renewals**: the cookie must already be below the threshold. Lower
  `renewBelowFraction` or enable `debug`.
- **A settings-form write is rejected**: the schema is strict; the value is out
  of range or the wrong type. The profile is unchanged and the plugin keeps
  running.
- **Plugin entry fails after a manual config edit**: the strict schema rejects
  wrong types and out-of-range values. Fix the field in the profile patch
  (Settings → General → Open configuration file) and restart `dsh web`; the rest
  of DSH keeps running and renewal is off until then.
- **`unsupported payload version` warning**: DSH changed its cookie payload
  format. Update the plugin and its `engines.dsh` pin; the plugin stops
  renewing (it leaves the existing cookie untouched) until then.
- **`could not mint ... status N`**: the token exchange returned an unexpected
  status (or no `Set-Cookie`). That usually means a harness change; check the
  pin.
- **`Connection does not expose ...` at mount**: the harness no longer matches
  the pinned range. The plugin disables itself instead of failing every
  request.
- **Plugin missing from the sidebar Plugins page**: that page lists bundles, so
  check `"dsh-cookie-renew"` in `dsh.profile.bundles` and that
  `package.json` still declares `dsh.bundle.patch`. A bundle selected without
  a bundle patch shows up with a `not-bundle` problem instead.
- **The row is mounted at boot**: restart `dsh web` after changing the bundle
  selection or the patch.

## License

[MIT](./LICENSE) © 2026 Edison Chong.
