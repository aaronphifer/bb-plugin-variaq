#!/usr/bin/env python3
"""
Deterministic stand-in for the VariaQ CLI used by bb-plugin-variaq tests.

Emulates VariaQ 0.6.0 schema-v1 envelopes so tests can verify the plugin's
JSON contract without touching a real VariaQ install or solver.

Recognized argv shape:
  python fake_variaq.py [--db P] [--problems-dir P] <command> <args...>
"""
import hashlib
import json
import os
import sys
import time
import uuid

OUTPUT_SCHEMA_VERSION = "1"
DEFAULT_MAX_RUNS = 500
FAKE_VARIAQ_VERSION = "0.6.0"

FAMILIES = ["maxcut", "assignment", "subset-selection", "graph-partition"]
CLASSICAL_FAMILIES = FAMILIES
# VariaQ 0.6 advertises these quantum families dynamically; the fake mirrors that.
QUANTUM_FAMILIES = ["maxcut", "assignment", "subset-selection"]

CAMPAIGNS = {}
CAMPAIGN_STATE_FILE = os.environ.get("FAKE_CAMPAIGN_STATE", ".fake_campaigns.json")


def _load_campaigns():
    global CAMPAIGNS
    try:
        with open(CAMPAIGN_STATE_FILE) as f:
            CAMPAIGNS = json.load(f)
    except Exception:
        CAMPAIGNS = {}


def _save_campaigns():
    with open(CAMPAIGN_STATE_FILE, "w") as f:
        json.dump(CAMPAIGNS, f)


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


def make_analysis_group(group_by, run_id, problem_size=4):
    group_key = {k: (run_id if k == "run_id" else ("exact" if k == "solver" else f"{k}-value")) for k in group_by}
    return {
        "count": 1,
        "environment_versions": {"variaq": [FAKE_VARIAQ_VERSION], "python": ["3.12.3"]},
        "feasibility": {
            "best_feasible_objective": 2.0,
            "best_infeasible_energy": None,
            "count": 1,
            "feasible_runs": 1,
            "feasible_sample_count": None,
            "infeasible_runs": 0,
            "infeasible_sample_count": None,
            "max_feasible_rate": None,
            "mean_feasible_rate": None,
            "median_feasible_rate": None,
            "min_feasible_rate": None,
            "zero_feasible_runs": 0,
        },
        "group_key": group_key,
        "problem_ids": ["maxcut-fake000000001"],
        "quality": {
            "approximation_ratio": 1.0,
            "best_objective": 2.0,
            "count": 1,
            "mean_gap_percent": 0.0,
            "mean_objective": 2.0,
            "median_objective": 2.0,
            "success_at_optimum_rate": 1.0,
            "worst_objective": 2.0,
        },
        "resource": {"auxiliary_variables": None, "binary_variables": None, "circuit_depth": None, "count": 1, "estimated_statevector_bytes": None, "gate_count": None, "logical_variables": problem_size, "qubits": None},
        "run_ids": [run_id],
        "timing": {"count": 1, "expectation_evaluation_seconds": None, "initialization_seconds": None, "parameter_search_seconds": None, "sampling_seconds": None, "solver_time_seconds": None, "total_wall_time_seconds": None, "warmup_seconds": None},
    }


def make_scaling_point(group_by, run_id, x_metric, x_value):
    point = make_analysis_group(group_by, run_id, problem_size=int(x_value))
    point["x_metric"] = x_metric
    point["x_value"] = float(x_value)
    return point


def supported_family(family):
    return family in FAMILIES


def quantum_supported_family(family):
    return family in QUANTUM_FAMILIES


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
        version = os.environ.get("FAKE_VARIAQ_VERSION", FAKE_VARIAQ_VERSION)
        print(f"variaq {version}")
        return 0

    if cmd == "hang":
        time.sleep(30)
        return 0

    if cmd == "campaign" and len(args) > 1 and args[1] == "plan":
        path = args[2] if len(args) > 2 else "missing"
        try:
            with open(path) as f:
                definition = json.load(f)
        except Exception as e:
            print(json.dumps(envelope("campaign plan", "error", None, error={
                "type": "ValidationError",
                "message": f"Cannot read campaign file: {e}",
            })))
            return 2
        sizes = definition.get("problem_sizes", [])
        seeds = definition.get("problem_seeds", [])
        solvers = definition.get("solvers", [])
        repeats = definition.get("repeats", 1)
        requested = len(sizes) * len(seeds) * len(solvers) * repeats
        instance_count = len(sizes) * len(seeds)
        max_binary = max(sizes) if sizes else 0
        quantum_runs = requested if any(s in ("qaoa", "cudaq-cpu", "cudaq-gpu") for s in solvers) else 0
        breakdown = []
        for s in solvers:
            sup = s in ("exact", "heuristic") or (s in ("qaoa", "cudaq-cpu", "cudaq-gpu") and quantum_supported_family(definition.get("family", "maxcut")))
            breakdown.append({
                "solver": s,
                "supported": sup,
                "installed": sup,
                "available": sup,
                "requested_runs": instance_count * repeats,
            })
        warnings = []
        if requested > DEFAULT_MAX_RUNS:
            warnings.append(f"Campaign requests {requested} runs; default maximum is {DEFAULT_MAX_RUNS}. Use --override-max-runs to execute.")
        print(json.dumps(envelope("campaign plan", "success", {
            "campaign_id": "not-yet-executed",
            "default_max_runs": DEFAULT_MAX_RUNS,
            "estimated_quantum_runs": quantum_runs,
            "exceeds_default_max": requested > DEFAULT_MAX_RUNS,
            "family": definition.get("family", "maxcut"),
            "max_binary_variables": max_binary,
            "name": definition.get("name", "fake-campaign"),
            "problem_instance_count": instance_count,
            "repeats": repeats,
            "requested_runs": requested,
            "solver_breakdown": breakdown,
            "unavailable": [],
            "warnings": warnings,
        })))
        return 0

    if cmd == "campaign" and len(args) > 1 and args[1] == "run":
        path = args[2] if len(args) > 2 else "missing"
        max_runs = DEFAULT_MAX_RUNS
        override = False
        for i, a in enumerate(args):
            if a == "--max-runs" and i + 1 < len(args):
                max_runs = int(args[i + 1])
            if a == "--override-max-runs":
                override = True
        try:
            with open(path) as f:
                definition = json.load(f)
        except Exception as e:
            print(json.dumps(envelope("campaign run", "error", None, error={
                "type": "ValidationError",
                "message": f"Cannot read campaign file: {e}",
            })))
            return 2
        sizes = definition.get("problem_sizes", [])
        seeds = definition.get("problem_seeds", [])
        solvers = definition.get("solvers", [])
        repeats = definition.get("repeats", 1)
        requested = len(sizes) * len(seeds) * len(solvers) * repeats
        if requested > max_runs and not override:
            print(json.dumps(envelope("campaign run", "error", None, error={
                "type": "ValidationError",
                "message": f"Campaign requests {requested} runs, exceeding maximum {max_runs}. Use --override-max-runs to execute.",
            })))
            return 2
        # Deterministic campaign id based on canonical content.
        campaign_id = f"campaign-{abs(hash(json.dumps(definition, sort_keys=True))) & 0xffffffffffffffff:016x}"
        run_ids = [fake_run_id() for _ in range(min(requested, max_runs))]
        problem_ids = [f"{definition.get('family', 'maxcut')}-fake{campaign_id[-8:]}" for _ in sizes]
        # Simulate mixed results: first run fails, second skipped, rest success.
        summary = {"success": 0, "failed": 0, "skipped": 0, "unavailable": 0}
        for i, _ in enumerate(run_ids):
            if i == 0:
                summary["failed"] += 1
            elif i == 1:
                summary["skipped"] += 1
            else:
                summary["success"] += 1
        CAMPAIGNS[campaign_id] = definition
        _save_campaigns()
        print(json.dumps(envelope("campaign run", "success", {
            "campaign_id": campaign_id,
            "completed_runs": len(run_ids),
            "family": definition.get("family", "maxcut"),
            "name": definition.get("name", "fake-campaign"),
            "problem_ids": problem_ids[:len(sizes)],
            "requested_runs": requested,
            "run_ids": run_ids,
            "status_summary": summary,
        })))
        return 0

    if cmd == "campaign" and len(args) > 1 and args[1] == "list":
        _load_campaigns()
        limit = 20
        for i, a in enumerate(args):
            if a == "--limit" and i + 1 < len(args):
                limit = int(args[i + 1])
        campaigns = [
            {"campaign_id": cid, "name": defn.get("name", "fake"), "family": defn.get("family", "maxcut"), "created_at": "2026-01-01T00:00:00+00:00"}
            for cid, defn in CAMPAIGNS.items()
        ]
        print(json.dumps(envelope("campaign list", "success", campaigns[:limit])))
        return 0

    if cmd == "campaign" and len(args) > 1 and args[1] == "show":
        _load_campaigns()
        cid = args[2] if len(args) > 2 else "missing"
        definition = CAMPAIGNS.get(cid)
        if definition is None:
            print(json.dumps(envelope("campaign show", "error", None, error={
                "type": "ValidationError",
                "message": f"no such campaign {cid}",
            })))
            return 2
        show = dict(definition)
        show["campaign_format_version"] = definition.get("campaign_format_version", "1")
        show["created_at"] = "2026-01-01T00:00:00+00:00"
        show.setdefault("notes", "")
        show.setdefault("tags", [])
        print(json.dumps(envelope("campaign show", "success", show)))
        return 0

    if cmd == "analyze" and len(args) > 1 and args[1] == "runs":
        run_ids = []
        group_by = []
        scaling_x = None
        for i, a in enumerate(args):
            if a == "--run-id" and i + 1 < len(args):
                run_ids.append(args[i + 1])
            if a == "--group-by" and i + 1 < len(args):
                group_by.append(args[i + 1])
            if a == "--scaling-x" and i + 1 < len(args):
                scaling_x = args[i + 1]
        groups = []
        scaling_points = []
        for rid in run_ids:
            groups.append(make_analysis_group(group_by or ["solver"], rid, problem_size=4))
            if scaling_x:
                scaling_points.append(make_scaling_point(group_by or ["solver"], rid, scaling_x, 4))
        print(json.dumps(envelope("analyze runs", "success", {
            "groups": groups,
            "comparisons": [],
            "query": {"run_ids": run_ids, "group_by": group_by or ["solver"], "filters": {}, "scaling_x": scaling_x, "include_failed": False, "include_unavailable": False, "campaign_id": None},
            "scaling_points": scaling_points,
            "source_run_ids": run_ids,
            "warnings": [],
        })))
        return 0

    if cmd == "analyze" and len(args) > 1 and args[1] == "campaign":
        _load_campaigns()
        cid = args[2] if len(args) > 2 else "missing"
        definition = CAMPAIGNS.get(cid)
        if definition is None:
            print(json.dumps(envelope("analyze campaign", "error", None, error={
                "type": "ValidationError",
                "message": f"no such campaign {cid}",
            })))
            return 2
        group_by = []
        scaling_x = None
        for i, a in enumerate(args):
            if a == "--group-by" and i + 1 < len(args):
                group_by.append(args[i + 1])
            if a == "--scaling-x" and i + 1 < len(args):
                scaling_x = args[i + 1]
        run_ids = [fake_run_id() for _ in range(3)]
        groups = [make_analysis_group(group_by or ["solver"], rid, problem_size=4) for rid in run_ids]
        scaling_points = [make_scaling_point(group_by or ["solver"], rid, scaling_x, 4) for rid in run_ids] if scaling_x else []
        print(json.dumps(envelope("analyze campaign", "success", {
            "groups": groups,
            "comparisons": [],
            "query": {"campaign_id": cid, "group_by": group_by or ["solver"], "filters": {}, "scaling_x": scaling_x, "include_failed": False, "include_unavailable": False},
            "scaling_points": scaling_points,
            "source_run_ids": run_ids,
            "warnings": [{"type": "fake_warning", "message": "simulated analysis warning"}],
        })))
        return 0

    if cmd == "report" and len(args) > 1 and args[1] == "campaign":
        cid = args[2] if len(args) > 2 else "missing"
        output_dir = "."
        formats = ["json"]
        group_by = []
        scaling_x = None
        plots = False
        overwrite = False
        for i, a in enumerate(args):
            if a == "--output-dir" and i + 1 < len(args):
                output_dir = args[i + 1]
            if a == "--formats" and i + 1 < len(args):
                formats = [s.strip() for s in args[i + 1].split(",") if s.strip()]
            if a == "--group-by" and i + 1 < len(args):
                group_by.append(args[i + 1])
            if a == "--scaling-x" and i + 1 < len(args):
                scaling_x = args[i + 1]
            if a == "--plots":
                plots = True
            if a == "--overwrite":
                overwrite = True
        os.makedirs(output_dir, exist_ok=True)
        report_key = cid + json.dumps(formats, sort_keys=True)
        report_id = f"report-{hashlib.sha256(report_key.encode()).hexdigest()[:16]}"
        prospective_paths = []
        if "json" in formats:
            prospective_paths.append(os.path.join(output_dir, f"{report_id}.json"))
        if "csv" in formats:
            prospective_paths.extend([
                os.path.join(output_dir, f"{report_id}_groups.csv"),
                os.path.join(output_dir, f"{report_id}_scaling.csv"),
            ])
        if "markdown" in formats:
            prospective_paths.append(os.path.join(output_dir, f"{report_id}.md"))
        if "plots" in formats:
            prospective_paths.append(os.path.join(output_dir, f"{report_id}_plot.png"))
        if not overwrite and any(os.path.exists(p) for p in prospective_paths):
            print(json.dumps(envelope("report campaign", "error", None, error={
                "type": "ValidationError",
                "message": "Report output already exists; pass --overwrite to replace it.",
            })))
            return 2
        paths = {}
        if "json" in formats:
            json_path = os.path.join(output_dir, f"{report_id}.json")
            with open(json_path, "w") as f:
                json.dump({
                    "report_format_version": "1",
                    "report_id": report_id,
                    "campaign_id": cid,
                    "generated_at": "2026-01-01T00:00:00+00:00",
                    "variaq_version": os.environ.get("FAKE_VARIAQ_VERSION", FAKE_VARIAQ_VERSION),
                    "source_run_ids": [fake_run_id()],
                    "analysis": {"groups": []},
                }, f)
            paths["json"] = json_path
        if "csv" in formats:
            groups_path = os.path.join(output_dir, f"{report_id}_groups.csv")
            scaling_path = os.path.join(output_dir, f"{report_id}_scaling.csv")
            for p in (groups_path, scaling_path):
                with open(p, "w") as f:
                    f.write("group,count\n")
            paths["csv"] = {"groups": groups_path, "scaling": scaling_path}
        if "markdown" in formats:
            md_path = os.path.join(output_dir, f"{report_id}.md")
            with open(md_path, "w") as f:
                f.write(f"# Report {report_id}\n")
            paths["markdown"] = md_path
        if "plots" in formats:
            plot_path = os.path.join(output_dir, f"{report_id}_plot.png")
            with open(plot_path, "wb") as f:
                f.write(b"PNG")
            paths["plots"] = {"summary": plot_path}
        print(json.dumps(envelope("report campaign", "success", {"report_id": report_id, "paths": paths})))
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
        version = os.environ.get("FAKE_VARIAQ_VERSION", FAKE_VARIAQ_VERSION)
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
                "reason": "Physical QPU execution is not supported in this release",
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

    def detect_family_from_problem_id(problem):
        family = "maxcut"
        for f in FAMILIES:
            if problem.startswith(f"{f}-"):
                family = f
                break
        return family

    def make_run(problem, solver, seed, family=None):
        if family is None:
            family = detect_family_from_problem_id(problem)
        sense = "minimize" if family == "graph-partition" else "maximize"
        objective = 7.0 if sense == "maximize" else 3.0
        is_quantum = solver in ("qaoa", "cudaq-cpu", "cudaq-gpu")
        run_id = fake_run_id()
        run = {
            "run_id": run_id,
            "problem_id": problem,
            "problem_type": family,
            "family": family,
            "solver": solver,
            "backend": "fake" if solver in ("exact", "heuristic", "qaoa") else ("qpp-cpu" if solver == "cudaq-cpu" else "nvidia"),
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
            "qaoa_depth": 1 if is_quantum else None,
            "shots": 64 if is_quantum else None,
            "optimizer_trials": 4 if is_quantum else None,
            "candidate_parameter_digest": "abc123" if is_quantum else None,
            "selected_parameter_index": 0 if is_quantum else None,
            "selected_parameters": ({"beta": [0.1], "gamma": [0.2]} if is_quantum else None),
            "expectation": -42.135 if is_quantum else None,
            "lowered_energy": -42.135 if is_quantum else None,
            "qubit_count": 6 if is_quantum else None,
            "binary_variable_count": 6 if is_quantum else None,
            "logical_variable_count": 6 if is_quantum else None,
            "auxiliary_variable_count": 0 if is_quantum else None,
            "circuit_depth": 12 if is_quantum else None,
            "gate_count": 24 if is_quantum else None,
            "logical_gate_count": 24 if is_quantum else None,
            "precision": "fp64" if solver.startswith("cudaq") else None,
            "backend_metadata": {"name": "fake", "backend_type": "classical_cpu" if solver in ("exact", "heuristic") else "quantum_simulator", "is_local": True},
            "environment": {"packages": {"variaq": os.environ.get("FAKE_VARIAQ_VERSION", "9.9.9")}},
            "created_at": "2026-01-01T00:00:00+00:00",
            "sense": sense,
        }
        if is_quantum:
            run["feasible_sample_count"] = 22
            run["infeasible_sample_count"] = 234
            run["bqm"] = {
                "digest": "sha256-deadbeef",
                "variable_count": 6,
                "linear_term_count": 6,
                "quadratic_term_count": 8,
            }
            run["penalties"] = [
                {"name": "capacity", "weight": 2.0, "violated": False, "contribution": 0.0},
            ]
            run["timing"] = {"compile": 0.01, "execute": 0.05, "optimize": 0.02}
        return run

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
        family = detect_family_from_problem_id(problem)
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
        if solver in ("qaoa", "cudaq-cpu", "cudaq-gpu") and not quantum_supported_family(family):
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
                "message": f"Solver '{solver}' does not support problem family '{family}'; supported families: {', '.join(QUANTUM_FAMILIES)}.",
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
                "feasible_sample_count": 0,
                "infeasible_sample_count": 256,
            }, error={
                "type": "MissingOptionalDependency",
                "message": "simulated solver failure",
                "run_id": run_id,
            })))
            return 1
        run = make_run(problem, solver, seed, family)
        print(json.dumps(envelope("solve", "success", run)))
        return 0

    if cmd == "benchmark":
        solvers = ["exact", "heuristic"]
        for i, a in enumerate(args):
            if a == "--solvers" and i + 1 < len(args):
                solvers = [s.strip() for s in args[i + 1].split(",") if s.strip()]
        problem = args[1] if len(args) > 1 else "maxcut-fake000000001"
        seed = int(value("--seed", "0"))
        family = detect_family_from_problem_id(problem)
        sense = "minimize" if family == "graph-partition" else "maximize"
        objective = 7.0 if sense == "maximize" else 3.0
        runs = []
        failed = 0
        unavailable = 0
        cudaq_mode = os.environ.get("FAKE_CUDAQ", "unavailable")
        cudaq_available = cudaq_mode in ("available", "driver-down")
        nvidia_available = cudaq_available and cudaq_mode == "available"
        for solver in solvers:
            if solver in ("qaoa", "cudaq-cpu", "cudaq-gpu") and not quantum_supported_family(family):
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
                    "seed": seed,
                    "parameters": {},
                })
                failed += 1
                unavailable += 1
            elif solver in ("cudaq-cpu", "cudaq-gpu") and not cudaq_available:
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
                    "seed": seed,
                    "parameters": {},
                })
                failed += 1
                unavailable += 1
            elif solver == "cudaq-gpu" and not nvidia_available:
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
                    "seed": seed,
                    "parameters": {},
                })
                failed += 1
                unavailable += 1
            else:
                run = make_run(problem, solver, seed, family)
                runs.append(run)
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
        family = detect_family_from_problem_id(problem)
        sense = "maximize" if family != "graph-partition" else "minimize"
        objective = 7.0 if sense == "maximize" else 3.0
        p = int(value("--p", "1"))
        repeats = int(value("--repeats", "1"))
        if not quantum_supported_family(family):
            print(json.dumps(envelope("compare quantum", "error", None, error={
                "type": "ValidationError",
                "message": f"compare quantum has no available quantum solvers for problem family '{family}'",
            })))
            return 1
        solvers = ["qaoa", "cudaq-cpu"]
        for i, a in enumerate(args):
            if a == "--solvers" and i + 1 < len(args):
                solvers = [s.strip() for s in args[i + 1].split(",") if s.strip()]
        # If a selected solver does not support the family, reject cleanly.
        for solver in solvers:
            if solver in ("qaoa", "cudaq-cpu", "cudaq-gpu") and not quantum_supported_family(family):
                print(json.dumps(envelope("compare quantum", "error", None, error={
                    "type": "ValidationError",
                    "message": f"compare quantum cannot include solver '{solver}': does not support problem family '{family}'; supported families: {', '.join(QUANTUM_FAMILIES)}",
                })))
                return 1
        runs = []
        for solver in solvers:
            run = make_run(problem, solver, 42, family)
            run["parameters"] = {"p": p, "optimizer_trials": 4, "shots": 64, "precision": "fp64" if solver.startswith("cudaq") else None}
            run["backend_metadata"] = {
                "name": "fake" if solver == "qaoa" else "qpp-cpu",
                "backend_type": "quantum_simulator",
                "is_local": True,
                "metrics": {
                    "candidate_parameter_digest": "abc123",
                    "candidate_expectations": [3.8, 3.8],
                    "best_parameter_index": 0,
                },
            }
            runs.append(run)
        print(json.dumps(envelope("compare quantum", "success", {
            "problem": {
                "problem_id": problem,
                "problem_type": family,
                "node_count": 6,
                "edge_count": 8,
                "family": family,
                "sense": "maximize" if family != "graph-partition" else "minimize",
            },
            "runs": runs,
            "comparison": {
                "aggregate_status": "success",
                "best_known_objective": objective,
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
        version = os.environ.get("FAKE_VARIAQ_VERSION", FAKE_VARIAQ_VERSION)
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
                "environment": {"python_version": "3.12.3", "variaq_version": version},
                "result": {"status": "success", "objective": 7.0, "backend": "fake"},
            },
            "new": {
                "run_id": new_id,
                "solver": "exact",
                "problem_id": "maxcut-fake000000001",
                "seed": 42,
                "parameters": {},
                "environment": {"python_version": "3.12.3", "variaq_version": version},
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
