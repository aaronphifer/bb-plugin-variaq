---
name: variaq
description: "Use when running VariaQ hybrid-compute experiments (classical/Qiskit/CUDA-Q) from bb — generating problems, solving, benchmarking, or inspecting/reproducing experiment runs."
---

# VariaQ from bb

The VariaQ plugin is a thin adapter: every capability below shells out to the
**standalone** VariaQ CLI (`python -m variaq`) from its installed checkout.
No solver/quantum logic lives in this plugin — read VariaQ's own
ARCHITECTURE.md for solver internals.

## Tools

- `variaq_status` — report the resolved Python/check-out, VariaQ and CUDA-Q
  versions, qpp-cpu support, NVIDIA target/driver/GPU state, physical QPU
  status, solver availability, and the solver `supported_families` reported
  by VariaQ capabilities. Use this before choosing optional solvers.
- `variaq_version` — verify the integration first; reports the VariaQ version.
- `variaq_problem_generate` — deterministic problem generation in any generic
  family (`maxcut`, `assignment`, `subset-selection`, `graph-partition`) →
  `problemId`.
- `variaq_problem_show` — full problem document (family-specific data,
  generation seed, sense).
- `variaq_solve` — one solver run on a problem; returns `runId` + full run
  record (objective, optimality gap, solution bitstring, backend metrics,
  feasibility diagnostics, BQM metadata). Solver/family compatibility is checked
  against VariaQ capabilities before execution. Solvers: `exact`, `heuristic`,
  `qaoa`, `cudaq-cpu`, `cudaq-gpu`.
- `variaq_benchmark` — table comparing multiple solvers on one problem, plus the
  individual run ids and persisted records.
- `variaq_compare_quantum` — matched Qiskit/CUDA-Q comparison for any problem
  family supported by the selected quantum solvers (per VariaQ capabilities).
  Returns persisted run ids and records.
- `variaq_runs_list` / `variaq_run_show` / `variaq_run_reproduce` — browse,
  inspect, and re-execute durable runs from the SQLite experiment store.

## CLI

`bb variaq --help` lists the same operations (`bb variaq status`, `solve …`,
`bb variaq benchmark …`, `bb variaq runs …`, …); add `--json` for
machine-readable output.

## Constraints

- **Solver/family compatibility is dynamic.** Use `variaq_status` to discover
  which families each quantum solver supports in the current VariaQ release;
  do not assume MaxCut-only or any other hardcoded list.
- **CUDA-Q solvers fail** unless VariaQ was installed with its `cudaq` extra —
  the run persists with status `failed` and the error names the missing extra.
- A discoverable CUDA-Q `nvidia` target is not enough for GPU availability;
  status also requires a usable NVIDIA driver and a positive CUDA-Q GPU count.
- **No physical QPU execution exists anywhere in this VariaQ release.**
- Problems default to `<checkout>/data/problems/` and the experiment DB to
  `<checkout>/data/variaq.sqlite3` — change via `bb plugin config variaq set <key>`
  (`dbPath`, `problemsDir`, `pythonPath`, `projectDir`, `timeoutMs`).
- All runs are deterministic given their seed; VariaQ appends runs, it never
  mutates them.
- Quantum runs may return some feasible and some infeasible samples. The plugin
  reports VariaQ's own feasibility counts and objective; it does not treat
  nonzero infeasible counts as a run failure.
