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
  ├── QAOA / CUDA-Q quantum simulators
  ├── campaign planning, execution, and storage
  ├── read-only analysis
  └── report generation
```

Starting with bb-plugin-variaq 0.2.0, the integration boundary is VariaQ's
native `--json` output (schema version `1`). The plugin validates the envelope,
forwards VariaQ's structured data, and no longer parses human-readable tables
or scrapes run IDs from prose.

VariaQ remains fully usable without BB. The plugin is responsible only for BB
tool/CLI registration, validated argument construction, bounded subprocess
execution, safe temporary-file staging, report path containment, and structured
result forwarding. The plugin does not implement campaign planning, analysis,
statistics, report generation, solver logic, BQM logic, plotting, or provenance
logic — VariaQ remains authoritative for all of these.

## Prerequisites

- BB 0.43.x with Plugin SDK 0.4.104
- Node.js 22.19 or a compatible version supported by BB
- Linux-native Python 3.12
- a separate VariaQ 0.6.x installation; 0.6.0 is the verified version

Create a VariaQ environment separately from this repository:

```bash
git clone https://github.com/aaronphifer/variaq.git
cd variaq
git checkout v0.6.0  # VariaQ 0.6.0
python3.12 -m venv .venv
.venv/bin/python -m pip install -e '.[quantum]'
```

The `quantum` extra supplies the local Qiskit workflow. CUDA-Q is optional:

```bash
.venv/bin/python -m pip install -e '.[quantum,cudaq]'
```

VariaQ 0.6.0 constrains CUDA-Q to `>=0.16,<0.17`; do not independently
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
| `reportOutputDir` | empty | safe default under the project workspace |
| `timeoutMs` | `120000` | per-command timeout, allowed range 1,000–3,600,000 ms |

Configured paths must be absolute. `pythonPath` must be an executable file and
`projectDir` must be a directory. Machine-local values belong in BB's plugin
settings, never in tracked files:

```bash
bb plugin config variaq set pythonPath /path/to/variaq/.venv/bin/python
bb plugin config variaq set projectDir /path/to/variaq
bb plugin config variaq set dbPath /path/to/variaq/data/variaq.sqlite3
bb plugin config variaq set problemsDir /path/to/variaq/data/problems
bb plugin config variaq set reportOutputDir /path/to/variaq/reports
bb plugin config variaq set timeoutMs 120000
bb plugin reload variaq
```

## Agent tools

The plugin registers seventeen BB tools:

- `variaq_status` and `variaq_version`
- `variaq_problem_generate`, `variaq_problem_show`, and `variaq_problem_import`
- `variaq_solve`, `variaq_benchmark`, and `variaq_compare_quantum`
- `variaq_campaign_plan`, `variaq_campaign_run`, `variaq_campaign_list`, and `variaq_campaign_show`
- `variaq_analyze_runs` and `variaq_analyze_campaign`
- `variaq_report_campaign`
- `variaq_runs_list`, `variaq_run_show`, and `variaq_run_reproduce`

Tools are divided into read-only and execution/write categories:

**Read-only:** `variaq_status`, `variaq_version`, `variaq_problem_show`,
`variaq_runs_list`, `variaq_run_show`, `variaq_campaign_plan`,
`variaq_campaign_list`, `variaq_campaign_show`, `variaq_analyze_runs`,
`variaq_analyze_campaign`.

**Execution / write:** `variaq_problem_generate`, `variaq_problem_import`,
`variaq_solve`, `variaq_benchmark`, `variaq_compare_quantum`,
`variaq_campaign_run`, `variaq_run_reproduce`, `variaq_report_campaign`.

## BB CLI and example workflow

```bash
bb variaq status --json
bb variaq version --json

problem_json=$(bb variaq problem-generate \
  maxcut --nodes 6 --edge-probability 0.5 --seed 42 --json)
problem_id=$(printf '%s\n' "$problem_json" | jq -r '.problemId')

bb variaq problem-show "$problem_id" --json
bb variaq solve "$problem_id" --solver exact --seed 42 --json
bb variaq solve "$problem_id" --solver heuristic --seed 42 --json
bb variaq solve "$problem_id" --solver qaoa --seed 42 --json
bb variaq benchmark "$problem_id" \
  --solvers exact,heuristic,qaoa --repeats 1 --seed 42 --json
bb variaq compare-quantum "$problem_id" --p 1 --repeats 1 --json

# Campaign workflow: plan first, then run, then analyze and report.
campaign_json=$(cat <<'EOF'
{
  "campaign_format_version": "1",
  "name": "maxcut-scaling",
  "family": "maxcut",
  "problem_sizes": [4, 6, 8],
  "problem_seeds": [1, 2],
  "solvers": ["exact", "heuristic"],
  "repeats": 1,
  "base_seed": 42,
  "generator_parameters": {"edge_probability": 0.4},
  "solver_config": {}
}
EOF
)
bb variaq campaign-plan "$campaign_json" --json
bb variaq campaign-run "$campaign_json" --max-runs 100 --json
bb variaq campaigns --limit 10 --json
bb variaq campaign <campaign-id> --json
bb variaq analyze-campaign <campaign-id> --group-by problem_id --group-by solver --scaling-x problem_size --json
bb variaq report-campaign <campaign-id> --output-dir ./reports --formats json,csv,markdown --json

bb variaq runs --limit 10 --json
bb variaq run run-<uuid> --json
bb variaq reproduce run-<uuid> --json
```

All `solve`, `benchmark`, `compare-quantum`, `campaign-run`, and `reproduce`
commands return VariaQ's structured schema-v1 envelope directly. There is no
prose parsing or run-ID scraping.

## Version compatibility

The verified combination is:

```text
bb-plugin-variaq 0.5.0
VariaQ           0.6.0
Plugin SDK       0.4.104
BB host          0.43.x
VariaQ schema    1
```

bb-plugin-variaq 0.5.x is verified against VariaQ 0.6.x and schema version `1`.
Patch releases within the 0.5 plugin series and 0.6 VariaQ series are accepted.
Other VariaQ series or future schema versions are reported as unsupported with a
clear compatibility error.

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

## VariaQ problem families

Starting with bb-plugin-variaq 0.4.0, the plugin exposes VariaQ 0.5's generic
problem families:

| Family           | Classical | Quantum |
|------------------|-----------|---------|
| MaxCut           | yes       | yes     |
| Assignment       | yes       | yes     |
| Subset Selection | yes       | yes     |
| Graph Partition  | yes       | not advertised |

This matrix comes from VariaQ `capabilities --json` and may evolve with future
VariaQ releases. Check `variaq_status` for the live solver `supported_families`
list rather than relying on this table.

- **MaxCut** — partition graph nodes to maximize cut weight.
- **Assignment** — assign generic tasks to resources with scores/costs, optional
  prohibited pairs, capacities, and demands.
- **Subset Selection** — choose candidates with values/costs, optional budget,
  cardinality bounds, and pairwise interactions.
- **Graph Partitioning** — partition a weighted graph with optional balance
  constraints. Quantum support is not advertised in VariaQ 0.5.0.

The plugin remains a thin adapter: it does not understand external project
semantics. A downstream domain adapter translates project objects into these
generic families and maps results back:

```text
domain project
     ↓
domain adapter
     ↓
VariaQ generic problem
     ↑
     │
bb-plugin-variaq
```

Project-specific adapters live outside this plugin.

## Campaign, analysis, and reporting

Starting with bb-plugin-variaq 0.5.0 and VariaQ 0.6.0:

- **Campaign plan** (`variaq_campaign_plan` / `bb variaq campaign-plan`) is
  non-executing and safe. It previews requested run counts, solver breakdown,
  unavailable combinations, and max-run warnings.
- **Campaign run** (`variaq_campaign_run` / `bb variaq campaign-run`) executes
  solvers. It passes an explicit `maxRuns` value to VariaQ and only adds
  `--override-max-runs` when the caller sets `overrideMaxRuns: true`. The plugin
  does not bypass VariaQ's safety guard.
- **Analysis** is read-only and returns VariaQ's `AnalysisResult` directly. The
  plugin does not compute statistics, gaps, or scaling points.
- **Reports** derive from stored runs and preserve `source_run_ids`,
  `report_id`, `report_format_version`, `generated_at`, and `variaq_version`.
  Report outputs are written beneath the configured `reportOutputDir` and cannot
  escape that root (path traversal and absolute-outside-root paths are rejected).

## Limitations

- VariaQ 0.6.0 provides local execution only; there is no physical-QPU path.
- There is no IBM Runtime/provider integration and no credential handling.
- Generic CI does not require CUDA-Q, an NVIDIA GPU, a physical QPU, or remote
  services.
- Campaign execution is local and single-threaded.
- This plugin does not schedule work across Fleet and has no Triagewall
  integration.
- Solver correctness belongs to VariaQ's own test suite; plugin tests cover the
  integration boundary.
- A quantum run may return some infeasible samples; the plugin preserves
  VariaQ's feasibility diagnostics and does not treat them as a plugin error.
- Optional matplotlib plots are only generated when VariaQ's reporting layer
  detects matplotlib; they are not required for core functionality.

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
separate Linux integration job checks out the immutable VariaQ `v0.6.0` tag,
installs `.[quantum]`, exercises local classical/Qiskit workflows, and runs a
bounded campaign plan/run, analysis, and report-generation smoke. CUDA-Q, GPU,
and matplotlib verification remain manual or suitable for a future self-hosted
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
