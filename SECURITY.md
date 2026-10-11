# Security policy

## Scope

The plugin invokes the configured local Python interpreter as
`python -m variaq`. It passes validated argv arrays directly to the process
with `shell: false`, captures bounded stdout/stderr, and enforces a configurable
timeout. Configured paths must be absolute; the Python executable and VariaQ
checkout are validated before use.

The plugin requires no API credentials, contains no analytics or telemetry,
and has no physical-QPU, IBM Runtime/provider, or other remote execution path.
It does not intentionally include environment values in errors.

Any future remote service, provider credential, or physical-QPU integration
requires a separate explicit security and privacy review before implementation.

## Reporting

When a public repository exists, use GitHub private vulnerability reporting if
it is enabled. Otherwise contact the repository owner privately through their
published profile contact. Do not include active secrets or sensitive system
data in a public issue. No project-specific private security email is currently
published.

## Candidate execution and reports

Paired analysis uses stored campaigns and VariaQ-derived evidence only; it does
not execute solvers. Reports remain beneath the configured output root with
component-by-component directory symlink rejection and VariaQ's artifact guards.
A subprocess timeout sends termination and escalates to a kill; completed v0.8
attempts remain persisted, but an in-flight native result may be lost. The plugin
never resumes or automatically retries work. Independently running CLI campaigns
are not coordinated by VariaQ's web-worker lock. Keep one execution owner.

Supported versions are a compatibility policy, not permission for physical-QPU
execution. No new credentials, external execution, shell, or arbitrary analytics
code is introduced by candidate compatibility.

## Candidate dependency review

The candidate lockfile audit reports six affected development packages (four
high, two moderate); `npm audit --omit=dev` reports zero affected production
packages. These are real upstream advisories, not a claim that development use
is harmless. The plugin runtime imports Zod and Node built-ins, invokes local
Python with argument arrays, and does not call the affected libraries directly.

| Locked package | Development dependency path | Advisory exposure |
| --- | --- | --- |
| brace-expansion 5.0.9 | bb-app → npm → minimatch | [Stack/CPU exhaustion from hostile brace patterns](https://github.com/advisories/GHSA-qhr7-859c-m2p7) |
| http-cache-semantics 4.2.0 | bb-app → npm → make-fetch-happen | [Cross-user cached response disclosure with max-stale](https://github.com/advisories/GHSA-ch52-4w7c-c8xp) |
| ip-address 10.5.0 | bb-app → npm → proxy/SOCKS tooling | [Incorrect address classifiers/subnet checks](https://github.com/advisories/GHSA-j6r3-76f7-8jcv), plus unbounded diagnostic input |
| postcss-selector-parser 7.1.4 | bb-app → npm → dependency query tooling | [CPU exhaustion from hostile selectors](https://github.com/advisories/GHSA-rj75-hqrm-r3gf) |
| source-map-js 1.2.1 | vitest → vite → postcss | [Event-loop exhaustion from hostile indexed source maps](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) |
| undici 6.28.0 | bb-app → npm → download/build tooling | [WebSocket denial of service](https://github.com/advisories/GHSA-rfgv-xxqx-mfg5), plus retry-interceptor response splitting |

The reviewed plugin surfaces expose no user-controlled glob, HTTP cache/proxy,
CSS/source-map parsing or WebSocket path into these packages. Exploitability in
npm/build/test tooling depends on its inputs and configuration; hostile package
metadata, network peers and development assets remain relevant risks. This review
does not audit BB host internals or establish that these advisories are unreachable
in every development invocation. Use isolated CI/cache environments and review
narrow compatible dependency fixes before a broad public release. No forced audit
fix, broad upgrade or suppression was applied.
