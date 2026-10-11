# Contributing

`bb-plugin-variaq` must remain a thin BB-to-VariaQ integration layer. Quantum
algorithms, solver implementations, backend math, and experiment persistence
belong in the standalone VariaQ project and must not be duplicated here.

## Setup

```bash
npm ci
npm run typecheck
npm run test:unit
bb plugin types --check
npm run build
npm pack --dry-run
```

The unit suite uses `tests/fake_variaq.py` to verify argument construction,
exit codes, malformed output, timeouts, missing executables, path/settings
validation, capability changes, and persisted run-ID extraction without a
solver installation.

## Real VariaQ integration

Install VariaQ 0.6.0 or the local 0.8.0rc1 candidate separately with Python 3.12 and its `quantum` extra, then
run:

```bash
VARIAQ_TEST_PROJECT=/path/to/variaq \
VARIAQ_TEST_PYTHON=/path/to/variaq/.venv/bin/python \
VARIAQ_TEST_VERSION=0.8.0rc1 \
npm run test:integration
```

To validate the stable VariaQ 0.8.0 release instead, point
`VARIAQ_TEST_VERSION=0.8.0` at the pinned stable-tag checkout (the exact commit
SHA is pinned at release time, mirroring the CI matrix placeholder).

These tests cover the CLI contract and local exact, heuristic, and Qiskit
flows. They must not reimplement VariaQ solver-correctness tests.

CUDA-Q is optional. On a compatible local or self-hosted machine:

```bash
VARIAQ_TEST_PROJECT=/path/to/variaq \
VARIAQ_TEST_PYTHON=/path/to/variaq/.venv/bin/python \
VARIAQ_TEST_VERSION=0.8.0rc1 \
VARIAQ_TEST_CUDAQ=1 \
npm run test:integration
```

GPU integration additionally requires `VARIAQ_TEST_GPU=1`. Set the expected
version to `0.6.0` when validating the legacy tagged checkout.

Use `npm run smoke` for a deterministic installed-plugin workflow. GPU work is
opt-in with `VARIAQ_SMOKE_GPU=1`; neither physical-QPU nor remote-provider tests
belong in the plugin's required CI.

## Pull-request expectations

- Use only the public `@get-bb/plugin-sdk` surface.
- Keep all subprocess execution shell-free, bounded, and schema-driven.
- Add fake-CLI regression coverage when changing VariaQ output handling.
- Update the explicit compatibility contract when changing supported VariaQ,
  BB, or Plugin SDK versions.
- Do not commit local settings, experiment databases, generated problems,
  credentials, dependency directories, coverage, logs, or build output.

CI runs the legacy and candidate integration suite against the immutable VariaQ
commit pins in `.github/workflows/ci.yml`. Keep `VARIAQ_TEST_VERSION` matched to
each source revision. A candidate pin must come from reviewed release-branch
code; do not substitute main, v0.7, a moving candidate branch, or an unverified build.
