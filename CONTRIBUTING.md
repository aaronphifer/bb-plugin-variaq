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

Install VariaQ 0.2.0 separately with Python 3.12 and its `quantum` extra, then
run:

```bash
VARIAQ_TEST_PROJECT=/path/to/variaq \
VARIAQ_TEST_PYTHON=/path/to/variaq/.venv/bin/python \
npm run test:integration
```

These tests cover the CLI contract and local exact, heuristic, and Qiskit
flows. They must not reimplement VariaQ solver-correctness tests.

CUDA-Q is optional. On a compatible local or self-hosted machine:

```bash
VARIAQ_TEST_PROJECT=/path/to/variaq \
VARIAQ_TEST_PYTHON=/path/to/variaq/.venv/bin/python \
VARIAQ_TEST_CUDAQ=1 \
npm run test:integration
```

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
