# bb-plugin-variaq

`bb-plugin-variaq` is a thin integration layer that lets BB agents and users
run the standalone [VariaQ](https://github.com/aaronphifer/variaq)
hybrid-compute research platform. VariaQ is a separate Python application and
dependency; this plugin invokes its CLI and returns its persisted results. The
plugin does not implement or duplicate quantum algorithms.

```text
bb
  ↓
bb-plugin-variaq
  ↓
VariaQ schema-v1 CLI
  ↓
VariaQ
  ├── classical
  ├── Qiskit
  └── CUDA-Q
```

Starting with bb-plugin-variaq 0.2.0, the integration boundary is VariaQ's
native `--json` output (schema version `1`). The plugin validates the envelope,
forwards VariaQ's structured data, and no longer parses human-readable tables
or scrapes run IDs from prose.

VariaQ remains fully usable without BB. The plugin is responsible only for BB
tool/CLI registration, validated argument construction, bounded subprocess
execution, and structured result forwarding.

## Prerequisites

- BB 0.43.x with Plugin SDK 0.4.104
- Node.js 22.19 or a compatible version supported by BB
- Linux-native Python 3.12
- a separate VariaQ 0.3.x installation; 0.3.0 is the verified version

Create a VariaQ environment separately from this repository:

```bash
git clone https://github.com/aaronphifer/variaq.git
cd variaq
git checkout v0.3.0  # VariaQ 0.3.0
python3.12 -m venv .venv
.venv/bin/python -m pip install -e '.[quantum]'
```

The `quantum` extra supplies the local Qiskit workflow. CUDA-Q is optional:

```bash
.venv/bin/python -m pip install -e '.[quantum,cudaq]'
```

VariaQ 0.3.0 constrains CUDA-Q to `>=0.16,<0.17`; do not independently
upgrade it beyond VariaQ's supported range.

## Installation

For a local checkout:

```bash
npm ci
npm run build
bb plugin install /path/to/bb-plugin-variaq --yes
```

Reload after changing settings or source:

```bash
bb plugin reload variaq
```

No package is published by this repository-preparation change.

## Configuration

Source defaults contain no machine-specific paths.

| Setting | Default | Purpose |
| --- | --- | --- |
| `pythonPath` | empty | Python interpreter containing VariaQ; otherwise auto-discovered |
| `projectDir` | empty | standalone VariaQ checkout; otherwise auto-discovered |
| `dbPath` | empty | use VariaQ's `data/variaq.sqlite3` default |
| `problemsDir` | empty | use VariaQ's `data/problems` default |
| `timeoutMs` | `120000` | per-command timeout, allowed range 1,000–3,600,000 ms |

Configured paths must be absolute. `pythonPath` must be an executable file and
`projectDir` must be a directory. Machine-local values belong in BB's plugin
settings, never in tracked files:

```bash
bb plugin config variaq set pythonPath /path/to/variaq/.venv/bin/python
bb plugin config variaq set projectDir /path/to/variaq
bb plugin config variaq set dbPath /path/to/variaq/data/variaq.sqlite3
bb plugin config variaq set problemsDir /path/to/variaq/data/problems
bb plugin config variaq set timeoutMs 120000
bb plugin reload variaq
```

## Agent tools

The plugin registers ten BB tools:

- `variaq_status` and `variaq_version`
- `variaq_problem_generate` and `variaq_problem_show`
- `variaq_solve`, `variaq_benchmark`, and `variaq_compare_quantum`
- `variaq_runs_list`, `variaq_run_show`, and `variaq_run_reproduce`

The eight experiment/store tools are accompanied by the two status/version
tools so agents can validate the local environment before running work.

## BB CLI and example workflow

```bash
bb variaq status --json
bb variaq version --json

problem_json=$(bb variaq problem-generate \
  --nodes 6 --edge-probability 0.5 --seed 42 --json)
problem_id=$(printf '%s\n' "$problem_json" | jq -r '.problemId')

bb variaq problem-show "$problem_id" --json
bb variaq solve "$problem_id" --solver exact --seed 42 --json
bb variaq solve "$problem_id" --solver heuristic --seed 42 --json
bb variaq solve "$problem_id" --solver qaoa --seed 42 --json
bb variaq benchmark "$problem_id" \
  --solvers exact,heuristic,qaoa --repeats 1 --seed 42 --json
bb variaq compare-quantum "$problem_id" --p 1 --repeats 1 --json
bb variaq runs --limit 10 --json
bb variaq run run-<uuid> --json
bb variaq reproduce run-<uuid> --json
```

All `solve`, `benchmark`, `compare-quantum`, and `reproduce` commands now
return VariaQ's structured schema-v1 envelope directly. There is no prose
parsing or run-ID scraping.

## Version compatibility

The verified combination is:

```text
bb-plugin-variaq 0.2.0
VariaQ           0.3.0
Plugin SDK       0.4.104
BB host          0.43.x
VariaQ schema    1
```

bb-plugin-variaq 0.2.x is verified against VariaQ 0.3.x and schema version `1`.
Patch releases within the 0.3 series are accepted. Other VariaQ series or future
schema versions are reported as unsupported with a clear compatibility error.

## CUDA-Q and GPU behavior

CUDA-Q is optional. Users without it retain exact, heuristic, and Qiskit QAOA
workflows. `cudaq-cpu` is available only when CUDA-Q exposes `qpp-cpu`.
`cudaq-gpu` additionally requires the NVIDIA target, a usable driver, and at
least one GPU reported by CUDA-Q.

Capabilities are queried from VariaQ itself via `variaq capabilities --json`.
Driver resets, device allocation, container access, and other runtime changes
can therefore make GPU availability appear or disappear without any plugin
change. A registered NVIDIA target alone is not treated as a usable GPU.

One verified Pop!_OS development machine had CUDA-Q 0.16.0.post1, `qpp-cpu`,
the NVIDIA target, and one compatible GPU. This is an example, not a portable
requirement or assumption.

## Limitations

- VariaQ 0.3.0 provides local execution only; there is no physical-QPU path.
- There is no IBM Runtime/provider integration and no credential handling.
- Generic CI does not require CUDA-Q, an NVIDIA GPU, a physical QPU, or remote
  services.
- This plugin does not schedule work across Fleet and has no Triagewall
  integration.
- Solver correctness belongs to VariaQ's own test suite; plugin tests cover the
  integration boundary.

## Deterministic smoke test

With the plugin installed and configured:

```bash
npm run smoke
```

The bounded, local-only script checks status/version, generates a seeded
six-node MaxCut problem, runs exact/heuristic/Qiskit, runs `cudaq-cpu` only when
available, benchmarks, and lists/shows persisted runs. Set
`VARIAQ_SMOKE_GPU=1` to opt into `cudaq-gpu` when status says it is available.
It performs no network quantum execution.

## Development and verification

```bash
npm ci
npm run typecheck
npm run test:unit
npm run test:integration
bb plugin types --check
npm run build
npm pack --dry-run
```

Real integration tests use `VARIAQ_TEST_PROJECT` and `VARIAQ_TEST_PYTHON` when
set. They default to the local development checkout. Optional CUDA-Q CPU tests
run only with `VARIAQ_TEST_CUDAQ=1`:

```bash
VARIAQ_TEST_PROJECT=/path/to/variaq \
VARIAQ_TEST_PYTHON=/path/to/variaq/.venv/bin/python \
VARIAQ_TEST_CUDAQ=1 \
npm run test:integration
```

The normal GitHub Actions plugin job uses the deterministic fake CLI. A
separate Linux integration job checks out the immutable VariaQ `v0.3.0` tag,
installs `.[quantum]`, and exercises local classical/Qiskit workflows.
CUDA-Q and GPU verification remain manual or suitable for a future self-hosted
runner.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution boundaries and
[SECURITY.md](SECURITY.md) for the subprocess security model.

## Failure behavior

VariaQ's exit codes are preserved by the BB CLI and agent tools:

- `0` — success
- `1` — solver/runtime failure (a run may still be persisted)
- `2` — usage/lookup/input error

Subprocesses use argv arrays with `shell: false`, capture bounded stdout/stderr,
and are terminated after the configured timeout. In `--json` mode the plugin
expects valid schema-v1 JSON on stdout; malformed output produces a clear
integration error with bounded excerpts instead of heuristic recovery.

Error responses do not include the subprocess environment.
