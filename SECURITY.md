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

The candidate lockfile audit reports five affected development packages (three
high, two moderate); `npm audit --omit=dev` reports zero affected production
packages. The previously reported `source-map-js` 1.2.1 exposure
(GHSA-68fv-2mgg-jv7q) is remediated by the lockfile override to 1.2.2 and no
longer appears in the audit. These are real upstream advisories, not a claim
that development use is harmless. The plugin runtime imports Zod and Node
built-ins, invokes local Python with argument arrays, and does not call the
affected libraries directly. All five packages are development-only transitive
dependencies of the npm tooling bundled inside the `bb-app` development
dependency; none is reachable from the shipped plugin runtime.

| Locked package | Development dependency path | Advisory exposure |
| --- | --- | --- |
| brace-expansion 5.0.9 | bb-app → npm → minimatch | [Quadratic-time `{a},b}` expansion CPU exhaustion](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr) (moderate); [nested brace group recursion stack exhaustion](https://github.com/advisories/GHSA-qhr7-859c-m2p7) and [parseCommaParts recursion stack exhaustion](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p) (high) |
| http-cache-semantics 4.2.0 | bb-app → npm → make-fetch-happen | [Cross-user cached response disclosure with max-stale](https://github.com/advisories/GHSA-ch52-4w7c-c8xp) (high) |
| ip-address 10.5.0 | bb-app → npm → proxy/SOCKS tooling | [isLinkLocal recognizes fe80::/64 rather than fe80::/10, allowing SSRF](https://github.com/advisories/GHSA-rpw4-54j3-4h4q); [no NAT64 64:ff9b:1::/48 classifier, allowing SSRF](https://github.com/advisories/GHSA-2vr4-cq9g-pvrc); [cross-family isInSubnet comparison can admit out-of-range addresses](https://github.com/advisories/GHSA-j6r3-76f7-8jcv); [unbounded parse diagnostic can stall the process](https://github.com/advisories/GHSA-h3mg-xc3c-68pw) (all moderate) |
| postcss-selector-parser 7.1.4 | bb-app → npm → dependency query tooling | [Quadratic flat selector parsing CPU exhaustion](https://github.com/advisories/GHSA-rj75-hqrm-r3gf) (moderate) |
| undici 6.28.0 | bb-app → npm → node-gyp build tooling | [DoS via unrequested WebSocket subprotocol](https://github.com/advisories/GHSA-rfgv-xxqx-mfg5) (high); [DoS via unhandled error in WebSocket permessage-deflate decompression](https://github.com/advisories/GHSA-3wwx-pv8p-q78v) (moderate); [downstream response splitting via retry interceptor](https://github.com/advisories/GHSA-r53p-7pc4-xj5r) (low) |

The reviewed plugin surfaces expose no user-controlled glob expansion,
HTTP cache/proxy, CSS selector, or WebSocket path into these packages.
Exploitability in npm/build/test tooling depends on its inputs and
configuration; hostile package metadata, network peers and development assets
remain relevant risks. This review does not audit BB host internals or
establish that these advisories are unreachable in every development
invocation. Use isolated CI/cache environments and review narrow compatible
dependency fixes before a broad public release. No forced audit fix, broad
upgrade or suppression was applied.
