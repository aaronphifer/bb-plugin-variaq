## 0.4.0 (unreleased)

- VariaQ 0.5.0 compatibility; `schema_version` `1` validation remains mandatory.
- Assignment quantum support via QAOA and CUDA-Q (when VariaQ's `cudaq` extra is installed).
- Subset Selection quantum support via QAOA and CUDA-Q.
- Capability-driven quantum family discovery: solver `supported_families` are
  consumed directly from `variaq capabilities --json`; no plugin-side hardcoded
  solver/family matrix.
- Generalized `variaq_compare_quantum`: works on any problem family supported by
  the selected quantum solvers as reported by VariaQ capabilities.
- Preserve VariaQ 0.5 BQM metadata, feasibility diagnostics (`feasible_sample_count`,
  `infeasible_sample_count`), penalty metadata, expectation, lowered energy, and
  timing fields without recalculation or flattening.
- Graph Partition quantum attempts are rejected based on live VariaQ capabilities
  (quantum support is not advertised in VariaQ 0.5.0).
- Updated human-readable CLI formatting for solve/benchmark to show family, backend,
  status, objective, expectation, and feasible/total samples where present.
- Hosted CI updated to VariaQ `v0.5.0`; generic-family and Assignment/Subset quantum
  coverage added. CUDA-Q remains optional in hosted CI.
- No external domain semantics, adapter execution, Ollama Fleet, Triagewall,
  physical QPU, UI, or web API added.

# Changelog

All notable changes to this project will be documented in this file.

## [0.4.0] - Unreleased

- Target VariaQ 0.5.x and its stable machine-readable CLI contract.
- Recognize all four generic problem families: `maxcut`, `assignment`,
  `subset-selection`, `graph-partition`.
- Consume solver `supported_families` from `variaq capabilities --json`; let
  VariaQ advertise which families each quantum solver supports.
- Add quantum support for `assignment` and `subset-selection` through VariaQ 0.5.
- Generalize `compare quantum` so it works for any family supported by the selected
  quantum solvers, not only MaxCut.
- Preserve VariaQ 0.5 BQM/feasibility/expectation metadata in solve, benchmark,
  compare-quantum, and run records.
- Reject Graph Partition quantum runs from VariaQ capabilities rather than a
  hardcoded family list.
- Update human-readable CLI formatting for multi-family results.
- Update CI to verify against VariaQ `v0.5.0` and exercise quantum workflows for
  Assignment and Subset Selection.

Physical-QPU execution, external domain adapter execution, and downstream
project integrations are not part of this release.

## [0.3.0] - Unreleased

- VariaQ 0.4.x compatibility; `schema_version` `1` validation remains mandatory.
- Family-aware problem generation for all VariaQ 0.4 generic families:
  `maxcut`, `assignment`, `subset-selection`, `graph-partition`.
- Capability model consumes VariaQ's per-solver `supported_families` from
  `variaq capabilities --json`; no plugin-side hardcoded solver/family matrix.
- Compare-quantum eligibility derived from VariaQ capabilities rather than a
  plugin-level family check.
- `variaq_problem_import` agent tool and `bb variaq problem-import` CLI command
  for importing structured problem artifacts, with safe temporary-file staging
  and no arbitrary filesystem traversal.
- Solve/benchmark/compare-quantum paths inspect the problem family and reject
  unsupported solver/family combinations with structured VariaQ errors before
  invoking VariaQ where practical.
- Objective sense (`maximize` / `minimize`) and opaque problem/run IDs are
  preserved across all families.
- `runs list`, `run show`, and `run reproduce` are family-neutral.
- Added `bb variaq status` human formatting for VariaQ capabilities.
- Smoke script now exercises an `assignment` workflow in addition to MaxCut.
- Updated hosted CI to VariaQ `v0.4.x` and added generic-family unit and
  integration coverage.
- No external domain semantics, adapter execution, Ollama Fleet, Triagewall,
  physical QPU, UI, or web API added.

## [0.2.0] - Unreleased

- Target VariaQ 0.3.x and its stable machine-readable CLI contract.
- Validate VariaQ `schema_version = "1"` envelopes; reject unknown future
  schemas with a clear compatibility error.
- Consume native `--json` output from VariaQ for:
  `capabilities`, `problem generate/show`, `solve`, `benchmark`,
  `compare quantum`, `runs list/show`, and `runs reproduce`.
- Replace plugin-side capability inference with `variaq capabilities --json`;
  VariaQ is now authoritative about solver, framework, and CUDA-Q availability.
- Return structured benchmark/comparison results directly; remove the old
  run-ID scraping path and human comparison-table parsing.
- Preserve structured errors (`type`, `message`, `run_id`, `context`,
  `retryable`) and warnings from VariaQ.
- Preserve VariaQ exit semantics:
  `0` success, `1` solver/runtime failure, `2` usage/lookup/input error.
- Reproduction results now include `lineage` and `environment_differences`.
- Update CI to verify against VariaQ `v0.3.0`.

Physical-QPU execution and remote quantum-provider integration are not part
of this release.

## [0.1.0] - Unreleased

- Initial thin integration with the standalone VariaQ CLI.
- Eight experiment and persisted-run tools, plus status and version tools (ten
  BB agent tools total), and the matching `bb variaq` CLI.
- Safe argv-based subprocess boundary with bounded output and timeouts.
- Persisted-run resolution for solve, benchmark, reproduce, and quantum
  comparison operations.
- `compare-quantum` support based only on stable run IDs, not presentation
  prose.
- Dynamic CUDA-Q CPU, NVIDIA target, driver, and GPU capability detection.
- Explicit VariaQ nonzero-exit and timeout propagation.

Physical-QPU execution and remote quantum-provider integration are not part of
this release.
