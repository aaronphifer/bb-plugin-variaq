#!/usr/bin/env python3
"""
Deterministic stand-in for the VariaQ CLI used by bb-plugin-variaq tests.

Emulates VariaQ 0.4.0 schema-v1 envelopes so tests can verify the plugin's
JSON contract without touching a real VariaQ install or solver.

Recognized argv shape:
  python fake_variaq.py [--db P] [--problems-dir P] <command> <args...>
"""
import json
import os
import sys
import time
import uuid

OUTPUT_SCHEMA_VERSION = "1"

FAMILIES = ["maxcut", "assignment", "subset-selection", "graph-partition"]
CLASSICAL_FAMILIES = FAMILIES
QUANTUM_FAMILIES = ["maxcut"]


def envelope(command, status, data, warnings=None, error=None):
    out = {
        "schema_version": OUTPUT_SCHEMA_VERSION,
        "command": command,
        "status": status,
        "data": data,
    }
    if warnings:
        out["warnings"] = warnings
    if error:
        out["error"] = error
    return out


def fake_run_id():
    return f"run-{uuid.uuid4()}"


def main(argv):
    args = list(argv)
    if args[:2] == ["-m", "variaq"]:
        args = args[2:]

    if args and args[0] == "-c":
        mode = os.environ.get("FAKE_CUDAQ", "unavailable")
        available = mode in ("available", "driver-down")
        print(json.dumps({
            "variaq_installed": True,
            "variaq_version": os.environ.get("FAKE_VARIAQ_VERSION", "9.9.9"),
            "qiskit_installed": True,
            "cudaq_installed": available,
            "cudaq_version": "0.16.0.post1" if available else None,
            "qpp_cpu_target": available,
            "nvidia_target": available,
            "gpu_count": 1 if available else 0,
            "nvidia_driver_usable": mode == "available",
        }))
        return 0

    # Strip global flags the plugin prepends.
    while args and args[0] in ("--db", "--problems-dir"):
        args = args[2:]

    if not args:
        print("usage", file=sys.stderr)
        return 2
    cmd = args[0]

    if cmd == "--version":
        version = os.environ.get("FAKE_VARIAQ_VERSION", "9.9.9")
        print(f"variaq {version}")
        return 0

    if cmd == "hang":
        time.sleep(30)
        return 0

    if cmd == "capabilities":
        mode = os.environ.get("FAKE_CUDAQ", "unavailable")
        available = mode in ("available", "driver-down")
        nvidia_available = available and mode == "available"
        warnings = []
        if not available:
            warnings.append({
                "type": "optional_dependency_missing",
                "message": "CUDA-Q is not installed; cudaq-cpu and cudaq-gpu are unavailable",
            })
        elif mode == "driver-down":
            warnings.append({
                "type": "backend_availability",
                "message": "CUDA-Q NVIDIA target present but reports no compatible GPU",
            })
        version = os.environ.get("FAKE_VARIAQ_VERSION", "9.9.9")
        solvers = [
            {"name": "exact", "supported": True, "installed": True, "available": True,
             "supported_families": list(CLASSICAL_FAMILIES)},
            {"name": "heuristic", "supported": True, "installed": True, "available": True,
             "supported_families": list(CLASSICAL_FAMILIES)},
            {"name": "qaoa", "supported": True, "installed": True, "available": True,
             "supported_families": list(QUANTUM_FAMILIES)},
            {"name": "cudaq-cpu", "supported": True, "installed": available, "available": available,
             "supported_families": list(QUANTUM_FAMILIES),
             "reason": "CUDA-Q not installed" if not available else None},
            {"name": "cudaq-gpu", "supported": True, "installed": available, "available": nvidia_available,
             "supported_families": list(QUANTUM_FAMILIES),
             "reason": "No compatible GPU" if available and not nvidia_available else
                      "CUDA-Q not installed" if not available else None},
        ]
        print(json.dumps(envelope("capabilities", "success", {
            "variaq": {
                "version": version,
                "output_schema_version": OUTPUT_SCHEMA_VERSION,
                "python_version": "3.12.3",
                "python_implementation": "cpython",
            },
            "problem_families": [{"name": f, "supported": True} for f in FAMILIES],
            "solvers": solvers,
            "frameworks": [
                {"name": "qiskit", "version": "2.5.2", "installed": True},
                {"name": "cudaq", "version": "0.16.0.post1" if available else None, "installed": available,
                 "targets": {
                     "qpp_cpu": {"installed": available, "available": available},
                     "nvidia": {"installed": available, "available": nvidia_available,
                                "gpu_count": 1 if nvidia_available else 0},
                 }},
            ],
            "physical_qpu": {
                "supported": False,
                "installed": False,
                "available": False,
                "reason": "Physical QPU execution is not supported in VariaQ 0.4.0",
            },
            "warnings": warnings,
        })))
        return 0

    def value(flag, default):
        return args[args.index(flag) + 1] if flag in args else default

    if cmd == "problem" and len(args) > 1 and args[1] == "generate":
        family = args[2] if len(args) > 2 else "maxcut"
        seed = int(value("--seed", "0"))
        problem_id = f"{family}-fake000000001"
        data = {
            "problem_id": problem_id,
            "problem_type": family,
            "family": family,
            "seed": seed,
            "path": f"data/problems/{problem_id}.json",
        }
        if family in ("maxcut", "graph-partition"):
            data["node_count"] = int(value("--nodes", "6"))
            data["edge_count"] = 8 if family == "maxcut" else 6
        if family == "assignment":
            data["task_count"] = int(value("--task-count", "4"))
            data["resource_count"] = int(value("--resource-count", "3"))
        if family == "subset-selection":
            data["candidate_count"] = int(value("--candidate-count", "6"))
        if family == "graph-partition":
            data["partition_count"] = int(value("--partition-count", "3"))
        print(json.dumps(envelope("problem generate", "success", data)))
        return 0

    if cmd == "problem" and len(args) > 1 and args[1] == "import":
        input_path = args[2] if len(args) > 2 else "missing"
        try:
            with open(input_path) as f:
                artifact = json.load(f)
        except Exception as e:
            print(json.dumps(envelope("problem import", "error", None, error={
                "type": "ValidationError",
                "message": f"Cannot read import artifact: {e}",
            })))
            return 2
        family = artifact.get("family")
        if family not in FAMILIES:
            print(json.dumps(envelope("problem import", "error", None, error={
                "type": "ValidationError",
                "message": f"Unsupported problem family: {family}",
            })))
            return 2
        problem_id = f"{family}-import-fake0001"
        artifact["problem_id"] = problem_id
        artifact["problem_type"] = family
        print(json.dumps(envelope("problem import", "success", artifact)))
        return 0

    if cmd == "problem" and len(args) > 1 and args[1] == "show":
        pid = args[2] if len(args) > 2 else "unknown"
        if pid == "missing":
            print(json.dumps(envelope("problem show", "error", None, error={
                "type": "ValidationError",
                "message": f"Problem not found: {pid}",
            })))
            return 2
        family = "maxcut"
        for f in FAMILIES:
            if pid.startswith(f"{f}-"):
                family = f
                break
        sense = "minimize" if family == "graph-partition" else "maximize"
        data = {
            "problem_id": pid,
            "problem_type": family,
            "family": family,
            "schema_version": 1,
            "sense": sense,
        }
        if family == "maxcut":
            data.update({
                "node_count": 6,
                "edge_count": 8,
                "node_ids": ["node-0", "node-1", "node-2", "node-3", "node-4", "node-5"],
                "edges": [{"u": "node-0", "v": "node-1", "weight": 1.0}],
            })
        elif family == "assignment":
            data.update({
                "task_ids": ["task-0", "task-1", "task-2", "task-3"],
                "resource_ids": ["resource-0", "resource-1", "resource-2"],
                "score": [{"task": "task-0", "resource": "resource-0", "value": 1.0}],
                "demand": {"task-0": 1},
                "capacity": {"resource-0": None},
            })
        elif family == "subset-selection":
            data.update({
                "candidate_ids": ["candidate-0", "candidate-1", "candidate-2"],
                "value": {"candidate-0": 1.0},
                "cost": {"candidate-0": 0.5},
            })
        elif family == "graph-partition":
            data.update({
                "node_count": 8,
                "edge_count": 6,
                "node_ids": [f"node-{i}" for i in range(8)],
                "edges": [{"u": "node-0", "v": "node-1", "weight": 1.0}],
                "partition_count": 3,
            })
        print(json.dumps(envelope("problem show", "success", data)))
        return 0

    if cmd == "solve":
        problem = args[1] if len(args) > 1 else "missing"
        solver = "exact"
        for i, a in enumerate(args):
            if a == "--solver" and i + 1 < len(args):
                solver = args[i + 1]
        seed = 0
        for i, a in enumerate(args):
            if a == "--seed" and i + 1 < len(args):
                seed = int(args[i + 1])
        if problem == "hang":
            time.sleep(30)
            return 0
        if problem == "missing":
            print(json.dumps(envelope("solve", "error", None, error={
                "type": "ValidationError",
                "message": f"Problem not found: {problem}",
            })))
            return 2
        family = "maxcut"
        for f in FAMILIES:
            if problem.startswith(f"{f}-"):
                family = f
                break
        cudaq_mode = os.environ.get("FAKE_CUDAQ", "unavailable")
        cudaq_available = cudaq_mode in ("available", "driver-down")
        nvidia_available = cudaq_available and cudaq_mode == "available"
        if solver in ("cudaq-cpu", "cudaq-gpu") and not cudaq_available:
            run_id = fake_run_id()
            print(json.dumps(envelope("solve", "error", {
                "run_id": run_id,
                "problem_id": problem,
                "problem_type": family,
                "solver": solver,
                "backend": "not-executed",
                "backend_type": "unavailable",
                "status": "failed",
                "objective": None,
            }, error={
                "type": "BackendUnavailableError",
                "message": "CUDA-Q is not installed on this host",
                "run_id": run_id,
            })))
            return 1
        if solver == "cudaq-gpu" and not nvidia_available:
            run_id = fake_run_id()
            print(json.dumps(envelope("solve", "error", {
                "run_id": run_id,
                "problem_id": problem,
                "problem_type": family,
                "solver": solver,
                "backend": "not-executed",
                "backend_type": "unavailable",
                "status": "failed",
                "objective": None,
            }, error={
                "type": "BackendUnavailableError",
                "message": "CUDA-Q NVIDIA target reports no compatible GPU",
                "run_id": run_id,
            })))
            return 1
        if solver in ("qaoa", "cudaq-cpu", "cudaq-gpu") and family != "maxcut":
            run_id = fake_run_id()
            print(json.dumps(envelope("solve", "error", {
                "run_id": run_id,
                "problem_id": problem,
                "problem_type": family,
                "solver": solver,
                "backend": "not-executed",
                "backend_type": "unavailable",
                "status": "failed",
                "objective": None,
            }, error={
                "type": "ValidationError",
                "message": f"The {solver} solver supports MaxCut only",
                "run_id": run_id,
            })))
            return 1
        if problem == "fail1":
            run_id = fake_run_id()
            print(json.dumps(envelope("solve", "error", {
                "run_id": run_id,
                "problem_id": problem,
                "problem_type": family,
                "solver": solver,
                "backend": "not-executed",
                "backend_type": "unavailable",
                "status": "failed",
                "objective": None,
            }, error={
                "type": "MissingOptionalDependency",
                "message": "simulated solver failure",
                "run_id": run_id,
            })))
            return 1
        run_id = fake_run_id()
        sense = "minimize" if family == "graph-partition" else "maximize"
        objective = 7.0 if sense == "maximize" else 3.0
        print(json.dumps(envelope("solve", "success", {
            "run_id": run_id,
            "problem_id": problem,
            "problem_type": family,
            "family": family,
            "solver": solver,
            "backend": "fake",
            "backend_type": "classical_cpu" if solver in ("exact", "heuristic") else "quantum_simulator",
            "status": "success",
            "solution": [0, 0, 1, 1, 1, 1],
            "objective": objective,
            "best_known_objective": objective,
            "best_known_source": "exact_optimum",
            "optimality_gap_percent": 0.0,
            "approximation_ratio": 1.0,
            "feasible": True,
            "constraint_violations": [],
            "wall_time_seconds": 0.001,
            "solver_time_seconds": 0.001,
            "seed": seed,
            "parameters": {},
            "qaoa_depth": None,
            "shots": None,
            "optimizer_trials": None,
            "candidate_parameter_digest": None,
            "selected_parameter_index": None,
            "selected_parameters": None,
            "expectation": None,
            "qubit_count": None,
            "circuit_depth": None,
            "gate_count": None,
            "logical_gate_count": None,
            "backend_metadata": {"name": "fake", "backend_type": "classical_cpu", "is_local": True},
            "environment": {"packages": {"variaq": os.environ.get("FAKE_VARIAQ_VERSION", "9.9.9")}},
            "created_at": "2026-01-01T00:00:00+00:00",
            "sense": sense,
        })))
        return 0

    if cmd == "benchmark":
        solvers = ["exact", "heuristic"]
        for i, a in enumerate(args):
            if a == "--solvers" and i + 1 < len(args):
                solvers = [s.strip() for s in args[i + 1].split(",") if s.strip()]
        problem = args[1] if len(args) > 1 else "maxcut-fake000000001"
        family = "maxcut"
        for f in FAMILIES:
            if problem.startswith(f"{f}-"):
                family = f
                break
        sense = "minimize" if family == "graph-partition" else "maximize"
        objective = 7.0 if sense == "maximize" else 3.0
        runs = []
        failed = 0
        unavailable = 0
        for solver in solvers:
            if solver in ("qaoa", "cudaq-cpu", "cudaq-gpu") and family != "maxcut":
                runs.append({
                    "run_id": fake_run_id(),
                    "problem_id": problem,
                    "problem_type": family,
                    "solver": solver,
                    "backend": "not-executed",
                    "backend_type": "unavailable",
                    "status": "failed",
                    "solution": None,
                    "objective": None,
                    "best_known_objective": objective,
                    "best_known_source": "stored_exact_optimum",
                    "optimality_gap_percent": None,
                    "approximation_ratio": None,
                    "feasible": False,
                    "constraint_violations": [],
                    "wall_time_seconds": 0.0,
                    "solver_time_seconds": 0.0,
                    "seed": 0,
                    "parameters": {},
                })
                failed += 1
                unavailable += 1
            else:
                runs.append({
                    "run_id": fake_run_id(),
                    "problem_id": problem,
                    "problem_type": family,
                    "solver": solver,
                    "backend": "fake",
                    "backend_type": "classical_cpu",
                    "status": "success",
                    "solution": [0, 0, 1, 1, 1, 1],
                    "objective": objective,
                    "best_known_objective": objective,
                    "best_known_source": "exact_optimum",
                    "optimality_gap_percent": 0.0,
                    "approximation_ratio": 1.0,
                    "feasible": True,
                    "constraint_violations": [],
                    "wall_time_seconds": 0.001,
                    "solver_time_seconds": 0.001,
                    "seed": 0,
                    "parameters": {},
                    "backend_metadata": {"name": "fake", "backend_type": "classical_cpu", "is_local": True},
                    "environment": {},
                    "created_at": "2026-01-01T00:00:00+00:00",
                })
        aggregate = "success" if failed == 0 else "partial"
        print(json.dumps(envelope("benchmark", aggregate, {
            "problem": {
                "problem_id": problem,
                "problem_type": family,
                "node_count": 6,
                "edge_count": 8,
                "family": family,
                "sense": sense,
            },
            "runs": runs,
            "comparison": {
                "aggregate_status": aggregate,
                "best_known_objective": objective,
                "best_known_source": "exact_optimum" if failed == 0 else "stored_exact_optimum",
                "solver_count": len(runs),
                "successful_count": len(runs) - failed,
                "failed_count": failed,
                "unavailable_count": unavailable,
            },
        })))
        return 0 if aggregate == "success" else 1

    if cmd == "compare":
        problem = args[2] if len(args) > 2 else "maxcut-fake000000001"
        family = "maxcut"
        for f in FAMILIES:
            if problem.startswith(f"{f}-"):
                family = f
                break
        if family != "maxcut":
            print(json.dumps(envelope("compare quantum", "error", None, error={
                "type": "ValidationError",
                "message": f"compare quantum supports MaxCut only; got {family}",
            })))
            return 1
        solvers = ["qaoa", "cudaq-cpu"]
        for i, a in enumerate(args):
            if a == "--solvers" and i + 1 < len(args):
                solvers = [s.strip() for s in args[i + 1].split(",") if s.strip()]
        p = 1
        for i, a in enumerate(args):
            if a == "--p" and i + 1 < len(args):
                p = int(args[i + 1])
        repeats = 1
        for i, a in enumerate(args):
            if a == "--repeats" and i + 1 < len(args):
                repeats = int(args[i + 1])
        runs = []
        for solver in solvers:
            runs.append({
                "run_id": fake_run_id(),
                "problem_id": problem,
                "problem_type": "maxcut",
                "solver": solver,
                "backend": "fake" if solver == "qaoa" else "qpp-cpu",
                "backend_type": "quantum_simulator",
                "status": "success",
                "solution": [0, 0, 1, 1, 1, 1],
                "objective": 7.0,
                "best_known_objective": 7.0,
                "best_known_source": "stored_exact_optimum",
                "optimality_gap_percent": 0.0,
                "approximation_ratio": 1.0,
                "feasible": True,
                "constraint_violations": [],
                "wall_time_seconds": 0.001,
                "solver_time_seconds": 0.001,
                "seed": 42,
                "parameters": {"p": p, "optimizer_trials": 4, "shots": 64, "precision": "fp64" if solver.startswith("cudaq") else None},
                "backend_metadata": {
                    "name": "fake" if solver == "qaoa" else "qpp-cpu",
                    "backend_type": "quantum_simulator",
                    "is_local": True,
                    "metrics": {
                        "candidate_parameter_digest": "abc123",
                        "candidate_expectations": [3.8, 3.8],
                        "best_parameter_index": 0,
                    },
                },
                "environment": {},
                "created_at": "2026-01-01T00:00:00+00:00",
            })
        print(json.dumps(envelope("compare quantum", "success", {
            "problem": {
                "problem_id": problem,
                "problem_type": "maxcut",
                "node_count": 6,
                "edge_count": 8,
                "family": "maxcut",
                "sense": "maximize",
            },
            "runs": runs,
            "comparison": {
                "aggregate_status": "success",
                "best_known_objective": 7.0,
                "best_known_source": "stored_exact_optimum",
                "solver_count": len(runs),
                "successful_count": len(runs),
                "failed_count": 0,
                "unavailable_count": 0,
                "matched_qaoa": True,
                "qaoa_depth_p": p,
                "optimizer_trials": 4,
                "shots": 64,
                "seed": 42,
                "candidate_parameter_digest": "abc123",
                "identical_candidate_parameters": True,
                "max_expectation_delta": 0.0,
                "best_parameter_indices": {solver: 0 for solver in solvers},
                "precision": {solver: "fp64" if solver.startswith("cudaq") else None for solver in solvers},
                "backend_target": {solver: ("fake" if solver == "qaoa" else "qpp-cpu") for solver in solvers},
                "unavailable": [],
            },
        })))
        return 0

    if cmd == "runs" and len(args) > 1 and args[1] == "list":
        limit = 20
        for i, a in enumerate(args):
            if a == "--limit" and i + 1 < len(args):
                limit = int(args[i + 1])
        rows = [{
            "run_id": "run-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "benchmark_id": None,
            "created_at": "2026-01-01T00:00:00+00:00",
            "problem_id": "maxcut-fake000000001",
            "solver_name": "exact",
            "status": "success",
            "objective": 7.0,
            "feasible": 1,
            "wall_time_seconds": 0.0,
            "backend_type": "classical_cpu",
            "backend_name": "fake",
            "seed": 42,
        }]
        print(json.dumps(envelope("runs list", "success", rows[:limit])))
        return 0

    if cmd == "runs" and len(args) > 1 and args[1] == "show":
        rid = args[2] if len(args) > 2 else "run-missing"
        if rid == "run-missing":
            print(json.dumps(envelope("runs show", "error", None, error={
                "type": "ValidationError",
                "message": f"no such run {rid}",
            })))
            return 2
        print(json.dumps(envelope("runs show", "success", {
            "run_id": rid,
            "problem_id": "maxcut-fake000000001",
            "solver_config": {"name": "exact", "seed": 42, "parameters": {}},
            "result": {"solver_name": "exact", "status": "success", "objective": 7.0},
        })))
        return 0

    if cmd == "runs" and len(args) > 1 and args[1] == "reproduce":
        rid = args[2] if len(args) > 2 else "run-missing"
        if rid == "run-missing":
            print(json.dumps(envelope("runs reproduce", "error", None, error={
                "type": "ValidationError",
                "message": f"no such run {rid}",
            })))
            return 2
        new_id = fake_run_id()
        print(json.dumps(envelope("runs reproduce", "success", {
            "original_run_id": rid,
            "new_run_id": new_id,
            "rerun_of": rid,
            "lineage": f"{new_id} -> rerun_of {rid}",
            "original": {
                "run_id": rid,
                "solver": "exact",
                "problem_id": "maxcut-fake000000001",
                "seed": 42,
                "parameters": {},
                "environment": {"python_version": "3.12.3", "variaq_version": "0.4.0"},
                "result": {"status": "success", "objective": 7.0, "backend": "fake"},
            },
            "new": {
                "run_id": new_id,
                "solver": "exact",
                "problem_id": "maxcut-fake000000001",
                "seed": 42,
                "parameters": {},
                "environment": {"python_version": "3.12.3", "variaq_version": "0.4.0"},
                "result": {
                    "run_id": new_id,
                    "problem_id": "maxcut-fake000000001",
                    "problem_type": "maxcut",
                    "solver": "exact",
                    "backend": "fake",
                    "backend_type": "classical_cpu",
                    "status": "success",
                    "objective": 7.0,
                    "seed": 42,
                },
            },
            "environment_differences": {},
        })))
        return 0

    print(f"fake_variaq: unrecognized argv {args}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
