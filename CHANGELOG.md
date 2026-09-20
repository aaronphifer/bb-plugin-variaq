# Changelog

All notable changes to this project will be documented in this file.

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
