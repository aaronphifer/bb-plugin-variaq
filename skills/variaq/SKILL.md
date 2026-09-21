---
name: variaq
description: "Use when running VariaQ hybrid-compute experiments (classical/Qiskit/CUDA-Q) from bb — generating problems, solving, benchmarking, planning campaigns, executing campaigns, analyzing results, generating reports, or inspecting/reproducing experiment runs."
---

# VariaQ from bb

The VariaQ plugin is a thin adapter: every capability below shells out to the
**standalone** VariaQ CLI (`python -m variaq`) from its installed checkout.
No solver/quantum logic, campaign planning, analysis, statistics, report
generation, BQM logic, plotting, or provenance logic lives in this plugin —
read VariaQ's own ARCHITECTURE.md for solver internals.

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
  generation seed, sense). **Read-only.**
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
- `variaq_campaign_plan` — non-executing preview of a campaign: requested run
  count, solver breakdown, unavailable combinations, and max-run warnings.
  **Read-only.**
- `variaq_campaign_run` — execute all planned solver runs bounded by an explicit
  `maxRuns` value; only sets `--override-max-runs` when the caller explicitly
  opts in. Campaigns can contain mixed success/failed/skipped/unavailable results;
  the plugin preserves VariaQ's exact status summary.
- `variaq_campaign_list` / `variaq_campaign_show` — browse and inspect stored
  campaigns. **Read-only.**
- `variaq_analyze_runs` / `variaq_analyze_campaign` — read-only aggregate
  analysis over selected runs or a single campaign. Returns VariaQ's
  `AnalysisResult` directly (groups, quality, feasibility, timing, resources,
  repeat statistics, scaling points, comparisons, warnings, source run IDs).
  The plugin does not compute statistics itself.
- `variaq_report_campaign` — generate JSON/CSV/Markdown reports (and optional
  plots if matplotlib is installed) from a campaign's stored runs. Writes files
  beneath the configured `reportOutputDir` and rejects path traversal. The
  report preserves `report_id`, `source_run_ids`, `report_format_version`,
  `generated_at`, and `variaq_version`.

## CLI

`bb variaq --help` lists the same operations (`bb variaq status`, `solve …`,
`bb variaq benchmark …`, `bb variaq runs …`, `bb variaq campaign-plan …`,
`bb variaq campaign-run …`, `bb variaq campaigns …`, `bb variaq campaign …`,
`bb variaq analyze-campaign …`, `bb variaq report-campaign …`, …); add `--json`
for machine-readable output.

## Constraints

- **Solver/family compatibility is dynamic.** Use `variaq_status` to discover
  which families each quantum solver supports in the current VariaQ release;
  do not assume MaxCut-only or any other hardcoded list.
- **CUDA-Q solvers fail** unless VariaQ was installed with its `cudaq` extra —
  the run persists with status `failed` and the error names the missing extra.
- A discoverable CUDA-Q `nvidia` target is not enough for GPU availability;
  status also requires a usable NVIDIA driver and a positive CUDA-Q GPU count.
- **No physical QPU execution exists anywhere in this VariaQ release.**
- **Campaign execution is local and single-threaded.** Plan before large runs;
  `variaq_campaign_plan` is safe and non-executing.
- **Analysis is read-only.** The plugin does not calculate statistics, gaps,
  or scaling points; it forwards VariaQ's `AnalysisResult` unchanged.
- **Reports derive from stored runs.** Report generation may create files, but
  it never mutates run records, problems, or campaign definitions.
- Problems default to `<checkout>/data/problems/` and the experiment DB to
  `<checkout>/data/variaq.sqlite3` — change via `bb plugin config variaq set <key>`
  (`dbPath`, `problemsDir`, `pythonPath`, `projectDir`, `reportOutputDir`,
  `timeoutMs`). Report outputs are constrained to `reportOutputDir`.
- All runs are deterministic given their seed; VariaQ appends runs, it never
  mutates them.
- Quantum runs may return some feasible and some infeasible samples. The plugin
  reports VariaQ's own feasibility counts and objective; it does not treat
  nonzero infeasible counts as a run failure.
- **Graph Partition quantum support remains unadvertised** unless VariaQ
  capabilities change in a future release.
- bb-plugin-variaq 0.5.x is verified against VariaQ 0.6.x and schema version `1`.
  Other VariaQ series or schema versions are reported as unsupported.