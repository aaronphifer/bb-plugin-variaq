# Changelog

All notable changes to this project will be documented in this file.

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
