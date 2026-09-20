#!/usr/bin/env bash
set -euo pipefail

command -v bb >/dev/null
command -v jq >/dev/null
command -v timeout >/dev/null

BB_TIMEOUT_SECONDS=${BB_TIMEOUT_SECONDS:-300}
if ! [[ "$BB_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  printf 'BB_TIMEOUT_SECONDS must be a positive integer\n' >&2
  exit 2
fi

run_bb() {
  timeout --foreground "$BB_TIMEOUT_SECONDS" bb "$@"
}

status_json=$(run_bb variaq status --json)
printf '%s\n' "$status_json"
run_bb variaq version --json

if problem_json=$(run_bb variaq problem-generate maxcut --nodes 6 --edge-probability 0.5 --seed 42 --json 2>&1); then
  problem_id=$(printf '%s\n' "$problem_json" | jq -er '.problemId')
elif [[ "$problem_json" =~ (maxcut-[0-9a-f]{16})\.json ]]; then
  problem_id=${BASH_REMATCH[1]}
  run_bb variaq problem-show "$problem_id" --json >/dev/null
else
  printf '%s\n' "$problem_json" >&2
  exit 1
fi
printf 'problem_id=%s\n' "$problem_id"

# Bounded generic-family smoke: assignment
assign_json=$(run_bb variaq problem-generate assignment --task-count 4 --resource-count 3 --seed 1 --json 2>&1)
if assign_id=$(printf '%s\n' "$assign_json" | jq -er '.problemId' 2>&1); then
  :
elif [[ "$assign_json" =~ (assignment-[0-9a-f]{16})\.json ]]; then
  assign_id=${BASH_REMATCH[1]}
else
  printf '%s\n' "$assign_json" >&2
  exit 1
fi
run_bb variaq solve "$assign_id" --solver exact --seed 1 --json | jq -er '.runId'
run_bb variaq benchmark "$assign_id" --solvers exact,heuristic --repeats 1 --seed 1 --json | jq '.comparison.aggregate_status'

first_run_id=""
supported=(exact heuristic qaoa)
if test "$(printf '%s\n' "$status_json" | jq -r '.solvers["cudaq-cpu"]')" = "available"; then
  supported+=(cudaq-cpu)
fi

for solver in "${supported[@]}"; do
  run_json=$(run_bb variaq solve "$problem_id" --solver "$solver" --seed 42 --json)
  run_id=$(printf '%s\n' "$run_json" | jq -er '.runId')
  if test -z "$first_run_id"; then first_run_id="$run_id"; fi
  printf '%s run_id=%s\n' "$solver" "$run_id"
done

if test "${VARIAQ_SMOKE_GPU:-0}" = "1" && \
   test "$(printf '%s\n' "$status_json" | jq -r '.solvers["cudaq-gpu"]')" = "available"; then
  gpu_json=$(run_bb variaq solve "$problem_id" --solver cudaq-gpu --seed 42 --json)
  printf 'cudaq-gpu run_id=%s\n' "$(printf '%s\n' "$gpu_json" | jq -er '.runId')"
fi

solver_csv=$(IFS=,; printf '%s' "${supported[*]}")
run_bb variaq benchmark "$problem_id" --solvers "$solver_csv" --repeats 1 --seed 42 --json | jq '.runs | map(.run_id)'
run_bb variaq runs --limit 10 --json | jq '.runs'
run_bb variaq run "$first_run_id" --json | jq '.run'
