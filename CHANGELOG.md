# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.1] - 2026-11-18

### Changed

- Raised `engines.node` from `>=20` to `>=24.9.0`, the Node floor every dsh
  0.2.2 runtime declares, and trimmed CI from Node 20/22/24 to Node 24/26.
  dsh does not gate plugins on `engines.node`; the field states the
  deployment floor the plugin is realistically installed under.

### Fixed

- README now describes the harness range accurately: dsh evaluates
  `engines.dsh` with prereleases included, so `^0.2.1-rc.3` admits every
  0.2.x runtime and the Connection renewal path is unchanged through
  0.2.2-rc.5. A profile override row whose id does not exist is skipped
  with a warning on dsh 0.2.2, not silently.

## [1.0.0] - 2026-10-25

First public release. The package was previously an unpublished local checkout
at `0.1.0`; the version was raised to `1.0.0` to mark the first tagged,
installable release. There is no `0.1.0` tag and no API change to migrate from.

### Added

- Sliding renewal of the DSH web `dsh-auth-*` browser-session cookie on
  Connection's `connection/request` waterfall: the cookie is re-minted through
  DSH's own `?token=` exchange once its remaining lifetime falls below
  `renewBelowFraction` of the total lifetime.
- Candidate selection by request authority, skipping degenerate or already
  elapsed payloads so a stale or planted cookie cannot mask the live one.
- `minIntervalMinutes` throttle against mint storms, keyed per authority.
- Strict, volatile Schemastery `Config` (`renewBelowFraction`,
  `minIntervalMinutes`, `debug`) shared by profile validation and the Host
  settings descriptors, with `auto: true` registration.
- Bundle patch (`cordis.patch.yml`) so the plugin can be selected through
  `dsh.profile.bundles` and toggled on the sidebar **Plugins** page.
- Square SVG icon and `en`/`zh` display metadata.
- Diagnostics: a one-time warning for an unsupported cookie payload version and
  a one-time warning when minting fails, both without disturbing API traffic.
- Test suite covering selection, threshold, throttle, config schema, volatile
  references, failure handling, and the mint path.

### Notes

- `engines.dsh` is pinned to `^0.2.1-rc.3`, the harness line this release is
  verified against.
- The plugin is a keep-alive, not a re-login: an already expired cookie is
  rejected by admission before the hook runs.
