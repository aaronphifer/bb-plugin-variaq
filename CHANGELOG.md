# Changelog

All notable changes to this project will be documented in this file.

## 0.5.1 - Unreleased

Maintenance-only release.

- Fix duplicated plot-format requests in `variaq_report_campaign` when both `formats: ["plots"]` and `plots: true` are supplied; `formats` is now canonical and `plots: true` only ensures "plots" appears once.
- Update GitHub Actions to Node 24-native action versions (`actions/checkout@v6`, `actions/setup-node@v7`, `actions/setup-python@v7`) to resolve Node 20 deprecation warnings while preserving existing workflow behavior.
- Apply a compatible `overrides` remediation for npm audit findings in the `bb-app` development dependency chain; runtime dependencies remain clean.

## 0.5.0 - 2026-02-19

- VariaQ 0.6.0 compatibility; `schema_version` `1` validation remains mandatory.
- Campaign planning (`variaq_campaign_plan`) and execution (`variaq_campaign_run`) with VariaQ's max-run guard preserved.
- Campaign list/show (`variaq_campaign_list`, `variaq_campaign_show`).
- Analysis tools (`variaq_analyze_runs`, `variaq_analyze_campaign`) that return VariaQ-derived groups, quality/feasibility/timing/resource summaries, and scaling points without recalculating statistics in the plugin.
- Report generation (`variaq_report_campaign`) for JSON/CSV/Markdown (and optional plots when matplotlib is installed), with safe output path containment under the configured report output directory.
- Preserved source_run_ids, report IDs, null metrics, and mixed campaign status summaries (success/failed/skipped/unavailable).
- Hosted CI updated to VariaQ `v0.6.0` with bounded campaign plan/run, analyze-campaign, and report-generation smoke coverage.
- No external domain semantics, adapter execution, Ollama Fleet, Triagewall, physical QPU, UI, or web API added.

## 0.4.0 - 2025-08-29

- VariaQ 0.5.x compatibility; `schema_version` `1` validation remains mandatory.
- Family-aware problem generation for all VariaQ 0.5 generic families: `maxcut`, `assignment`, `subset-selection`, `graph-partition`.
- Capability model consumes VariaQ's per-solver `supported_families` from `variaq capabilities --json`; no plugin-side hardcoded solver/family matrix.
- Compare-quantum eligibility derived from VariaQ capabilities rather than a plugin-level family check.
- `variaq_problem_import` agent tool and `bb variaq problem-import` CLI command for importing structured problem artifacts, with safe temporary-file staging and no arbitrary filesystem traversal.
- Solve/benchmark/compare-quantum paths inspect the problem family and reject unsupported solver/family combinations with structured VariaQ errors before invoking VariaQ where practical.
- Objective sense (`maximize` / `minimize`) and opaque problem/run IDs are preserved across all families.
- `runs list`, `run show`, and `run reproduce` are family-neutral.
- Added `bb variaq status` human formatting for VariaQ capabilities.
- Smoke script now exercises an `assignment` workflow in addition to MaxCut.
- Updated hosted CI to VariaQ `v0.5.0` and added generic-family unit and integration coverage.
- No external domain semantics, adapter execution, Ollama Fleet, Triagewall, physical QPU, UI, or web API added.

## 0.2.0 - 2025-02-10

- Target VariaQ 0.3.x and its stable machine-readable CLI contract.
- Validate VariaQ `schema_version = "1"` envelopes; reject unknown future schemas with a clear compatibility error.
- Consume native `--json` output from VariaQ for: `capabilities`, `problem generate/show`, `solve`, `benchmark`, `compare quantum`, `runs list/show`, and `runs reproduce`.
- Replace plugin-side capability inference with `variaq capabilities --json`; VariaQ is now authoritative about solver, framework, and CUDA-Q availability.
- Return structured benchmark/comparison results directly; remove the old run-ID scraping path and human comparison-table parsing.
- Preserve structured errors (`type`, `message`, `run_id`, `context`, `retryable`) and warnings from VariaQ.
- Preserve VariaQ exit semantics: `0` success, `1` solver/runtime failure, `2` usage/lookup/input error.
- Reproduction results now include `lineage` and `environment_differences`.
- Update CI to verify against VariaQ `v0.3.0`.

Physical-QPU execution and remote quantum-provider integration are not part of this release.

## 0.1.0 - 2025-01-22

- Initial thin integration with the standalone VariaQ CLI.
- Eight experiment and persisted-run tools, plus status and version tools (ten BB agent tools total), and the matching `bb variaq` CLI.
- Safe argv-based subprocess boundary with bounded output and timeouts.
- Persisted-run resolution for solve, benchmark, reproduce, and quantum comparison operations.
- `compare-quantum` support based only on stable run IDs, not presentation prose.
- Dynamic CUDA-Q CPU, NVIDIA target, driver, and GPU capability detection.
- Explicit VariaQ nonzero-exit and timeout propagation.

Physical-QPU execution and remote quantum-provider integration are not part of this release.
