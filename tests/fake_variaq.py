#!/usr/bin/env python3
"""
Deterministic stand-in for the VariaQ CLI used by bb-plugin-variaq tests.

Behavior is driven entirely by argv so tests never touch a real VariaQ install,
a real solver, or the network. Recognizes the plugin's argv shape:

  python fake_variaq.py [--db P] [--problems-dir P] <command> <args...>

Commands:
  --version                                   -> exit 0, "variaq 9.9.9"
  probe  (not a real variaq command; the plugin's capability probe invokes
         `python -c <script>` — that path is exercised via env, not here)
  problem generate maxcut --nodes N --edge-probability P --seed S
                                              -> exit 0, prints a Saved line
  problem show <id>                           -> prints {"problem_id": id, ...} JSON
  solve <id> --solver S ...                   -> table with a run-uuid; specific
                                               solver names force exit codes:
      solver "fail1"  -> exit 1 with stderr (simulates persisted FAILED run)
      solver "lookup" -> exit 2 with stderr (simulates problem-not-found)
  benchmark ...                               -> table with run-ids
  runs list --limit N                         -> JSON list
  runs show <id>                              -> JSON object; id "run-missing" -> exit 2
  runs reproduce <id>                         -> table with a new run-uuid;
                                               id "run-missing" -> exit 2
  hang                                        -> sleep long enough to trigger
                                                 the plugin timeout
"""
import json
import os
import sys
import time

def main(argv):
    args = list(argv)
    # The plugin invokes an interpreter as: python -m variaq ... . This file is
    # symlinked as that interpreter in tests, so discard the interpreter prefix.
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
        print("variaq 9.9.9")
        return 0

    if cmd == "hang":
        time.sleep(30)
        return 0

    if cmd == "problem" and len(args) > 1 and args[1] == "generate":
        def value(flag, default):
            return args[args.index(flag) + 1] if flag in args else default
        print("Saved maxcut-fake000000001 to data/problems/maxcut-fake000000001.json")
        print(f"nodes={value('--nodes', '?')} edge_probability={value('--edge-probability', '?')} seed={value('--seed', '?')}")
        return 0

    if cmd == "problem" and len(args) > 1 and args[1] == "show":
        pid = args[2] if len(args) > 2 else "unknown"
        if pid == "missing":
            print("error: Problem not found: missing", file=sys.stderr)
            return 2
        print(json.dumps({
            "problem_id": pid, "problem_type": "maxcut", "schema_version": 1,
            "node_count": 6, "edges": [{"u": 0, "v": 1, "weight": 1.0}],
            "sense": "maximize",
        }))
        return 0

    if cmd == "solve":
        problem = args[1] if len(args) > 1 else "missing"
        solver = "exact"
        for i, a in enumerate(args):
            if a == "--solver" and i + 1 < len(args):
                solver = args[i + 1]
        if problem == "hang":
            time.sleep(30)
            return 0
        if problem == "missing":
            print(f"error: Problem not found: {problem}", file=sys.stderr)
            return 2
        if problem == "fail1":
            print("error: MissingOptionalDependency: simulated", file=sys.stderr)
            print("solver    status   objective  best  gap %  wall s  backend       run id")
            print("--------  -------  ---------  ----  -----  ------  ------------  ----------------------------------------")
            print(f"{solver}  failed   -          -     -      0.0     not-executed  run-11111111-1111-4111-8111-111111111111")
            return 1
        print("solver    status   objective  best  gap %  wall s  backend  run id")
        print("--------  -------  ---------  ----  -----  ------  -------  ----------------------------------------")
        print(f"{solver}  success  7          7     0      0.0     fake     run-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        return 0

    if cmd == "benchmark":
        print("solver     status   objective  best  gap %  wall s  backend  run id")
        print("---------  -------  ---------  ----  -----  ------  -------  ----------------------------------------")
        print("exact      success  7          7     0      0.0     fake     run-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        print("heuristic  success  7          7     0      0.0     fake     run-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
        return 0

    if cmd == "compare":
        print("solver     status   objective  best  gap %  wall s  backend  run id")
        print("---------  -------  ---------  ----  -----  ------  -------  ----------------------------------------")
        print("qaoa       success  7          7     0      0.0     fake     run-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        print("cudaq-cpu  success  7          7     0      0.0     fake     run-cccccccc-cccc-4ccc-8ccc-cccccccccccc")
        print("")
        print("Matched quantum detail:")
        print("  seed=42: identical_candidates=yes")
        return 0

    if cmd == "runs" and len(args) > 1 and args[1] == "list":
        print(json.dumps([{
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
        }]))
        return 0

    if cmd == "runs" and len(args) > 1 and args[1] == "show":
        rid = args[2] if len(args) > 2 else "run-missing"
        if rid == "run-missing":
            print(f"error: no such run {rid}", file=sys.stderr)
            return 2
        print(json.dumps({
            "run_id": rid, "problem_id": "maxcut-fake000000001",
            "solver_config": {"name": "exact", "seed": 42, "parameters": {}},
            "result": {"solver_name": "exact", "status": "success", "objective": 7.0},
        }))
        return 0

    if cmd == "runs" and len(args) > 1 and args[1] == "reproduce":
        rid = args[2] if len(args) > 2 else "run-missing"
        if rid == "run-missing":
            print(f"error: no such run {rid}", file=sys.stderr)
            return 2
        print("solver  status   objective  best  gap %  wall s  backend  run id")
        print("------  -------  ---------  ----  -----  ------  -------  ----------------------------------------")
        print("exact   success  7          7     0      0.0     fake     run-dddddddd-dddd-4ddd-8ddd-dddddddddddd")
        print(f"reproduced_from={rid}")
        return 0

    print(f"fake_variaq: unrecognized argv {args}", file=sys.stderr)
    return 2

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
