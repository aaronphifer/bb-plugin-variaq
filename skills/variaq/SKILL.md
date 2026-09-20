---
name: variaq
description: "Use when running VariaQ MaxCut experiments (classical/Qiskit/CUDA-Q) from bb — generating problems, solving, benchmarking, or inspecting/reproducing experiment runs."
---

# VariaQ from bb

The VariaQ plugin is a thin adapter: every capability below shells out to the
**standalone** VariaQ CLI (`python -m variaq`) from its installed checkout.
No solver/quantum logic lives in this plugin — read VariaQ's own
ARCHITECTURE.md for solver internals.

## Tools

- `variaq_status` — report the resolved Python/check-out, VariaQ and CUDA-Q
  versions, qpp-cpu support, NVIDIA target/driver/GPU state, and solver
  availability. Use this before choosing optional solvers.
- `variaq_version` — verify the integration first; reports the VariaQ version.
- `variaq_problem_generate` — deterministic MaxCut (nodes, edgeProbability,
  seed) → `problemId`.
- `variaq_problem_show` — full problem document (edges, weights, generation).
- `variaq_solve` — one solver run on a problem; returns `runId` + full run
  record (objective, optimality gap, solution bitstring, backend metrics).
  Solvers: `exact`, `heuristic`, `qaoa` (Qiskit statevector), `cudaq-cpu`,
  `cudaq-gpu`.
- `variaq_benchmark` — table comparing multiple solvers on one problem,
  plus the individual run ids and persisted records.
- `variaq_compare_quantum` — matched Qiskit/CUDA-Q comparison. Returns persisted
  run ids and records; the plugin does not parse VariaQ's presentation-only
  comparison detail.
- `variaq_runs_list` / `variaq_run_show` / `variaq_run_reproduce` — browse,
  inspect, and re-execute durable runs from the SQLite experiment store.

## CLI

`bb variaq --help` lists the same operations (`bb variaq status`, `solve …`,
`bb variaq benchmark …`, `bb variaq runs …`, …); add `--json` for
machine-readable output.

## Constraints

- **CUDA-Q solvers fail** unless VariaQ was installed with its `cudaq` extra —
  the run persists with status `failed` and the error names the missing extra.
- A discoverable CUDA-Q `nvidia` target is not enough for GPU availability;
  status also requires a usable NVIDIA driver and a positive CUDA-Q GPU count.
- No physical QPU execution exists anywhere in VariaQ 0.2.0.
- Problems default to `<checkout>/data/problems/` and the experiment DB to
  `<checkout>/data/variaq.sqlite3` — change via `bb plugin config variaq set <key>`
  (`dbPath`, `problemsDir`, `pythonPath`, `projectDir`, `timeoutMs`).
- All runs are deterministic given their seed; VariaQ appends runs, it never
  mutates them.
