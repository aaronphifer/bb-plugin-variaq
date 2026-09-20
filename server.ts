import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  PluginError,
  checkVariaqVersion,
  extractRunId,
  extractRunIds,
  extractSavedProblemId,
  parseJsonOutput,
  parseKeyValue,
  parseSolvers,
  probeCapabilities,
  resolveConfig,
  runVariaq,
  runVariaqStrict,
  type ResolvedConfig,
  type VariaqSettings,
} from "./lib/runner.js";

const SOLVERS = ["exact", "heuristic", "qaoa", "cudaq-cpu", "cudaq-gpu"] as const;
const solverEnum = z.enum(SOLVERS);

const runListRowSchema = z.object({
  run_id: z.string(),
  benchmark_id: z.string().nullable().optional(),
  created_at: z.string(),
  problem_id: z.string(),
  solver_name: z.string(),
  status: z.string(),
  objective: z.number().nullable(),
  feasible: z.union([z.boolean(), z.number()]).nullable().optional(),
  wall_time_seconds: z.number().nullable().optional(),
  backend_type: z.string().nullable().optional(),
  backend_name: z.string().nullable().optional(),
  seed: z.number().nullable().optional(),
});

const USAGE = `bb variaq — Run VariaQ classical/quantum experiments from bb

  bb variaq status [--json]
  bb variaq version [--json]
  bb variaq problem-generate --nodes N --edge-probability P --seed S [--json]
  bb variaq problem-show <problem-id> [--json]
  bb variaq solve <problem-id> --solver <${SOLVERS.join("|")}> [--seed S] [--param KEY=VALUE ...] [--json]
  bb variaq benchmark <problem-id> [--solvers a,b] [--repeats N] [--seed S] [--json]
  bb variaq compare-quantum <problem-id> [--p N] [--repeats N] [--json]
  bb variaq runs [--limit N] [--json]
  bb variaq run <run-id> [--json]
  bb variaq reproduce <run-id> [--json]

This plugin shells out to the standalone VariaQ CLI. Solver/quantum logic
lives in VariaQ — never here. CUDA-Q solvers require VariaQ's 'cudaq' extra;
GPU backends additionally need a working NVIDIA toolchain.`;

export default async function plugin(bb: BbPluginApi) {
  // All four path settings default to "" = auto-discover. Resolved per call and
  // never persisted, so this source stays environment-agnostic and reusable.
  const settings = bb.settings.define({
    pythonPath: {
      type: "string",
      label: "Python interpreter",
      description: "Path to a Python interpreter with VariaQ installed. Leave empty to auto-discover from the VariaQ checkout directory.",
      default: "",
    },
    projectDir: {
      type: "string",
      label: "VariaQ checkout directory",
      description: "Path to the VariaQ repository checkout. Leave empty to auto-discover from well-known locations (~/quantum-lab/variaq, etc.).",
      default: "",
    },
    dbPath: {
      type: "string",
      label: "Experiment database path",
      description: "SQLite experiment DB. Leave empty to use VariaQ's built-in default (<checkout>/data/variaq.sqlite3).",
      default: "",
    },
    problemsDir: {
      type: "string",
      label: "Problems directory",
      description: "Directory for saved problem JSON. Leave empty to use VariaQ's built-in default (<checkout>/data/problems).",
      default: "",
    },
    timeoutMs: {
      type: "number",
      label: "Command timeout (ms)",
      description: "Per-command timeout in milliseconds (integer).",
      experimental_schema: z.number().int().min(1_000).max(3_600_000),
      default: 120_000,
    },
  });

  async function cfg(): Promise<ResolvedConfig> {
    const values = await settings.get();
    const raw: VariaqSettings = {
      pythonPath: values.pythonPath,
      projectDir: values.projectDir,
      dbPath: values.dbPath,
      problemsDir: values.problemsDir,
      timeoutMs: values.timeoutMs,
    };
    return resolveConfig(raw);
  }

  // ------------------------------------------------------------------ ops --

  async function opStatus() {
    const c = await cfg();
    const [probe, versionResult] = await Promise.all([
      probeCapabilities(c),
      runVariaq(c, ["--version"], { timeoutMs: 15_000 }),
    ]);

    const variaqInstalled = probe.variaq_installed === true && versionResult.code === 0;
    const qiskitInstalled = probe.qiskit_installed === true;
    const cudaqInstalled = probe.cudaq_installed === true;
    const qppCpu = cudaqInstalled && probe.qpp_cpu_target === true;
    const gpuCount = typeof probe.gpu_count === "number" ? probe.gpu_count : 0;
    const nvidiaTarget = cudaqInstalled && probe.nvidia_target === true;
    const nvidiaDriver = probe.nvidia_driver_usable === true;
    const nvidiaAvailable = nvidiaTarget && nvidiaDriver && gpuCount > 0;

    const solvers: Record<string, "available" | "unavailable"> = {
      exact: variaqInstalled ? "available" : "unavailable",
      heuristic: variaqInstalled ? "available" : "unavailable",
      qaoa: variaqInstalled && qiskitInstalled ? "available" : "unavailable",
      "cudaq-cpu": variaqInstalled && qppCpu ? "available" : "unavailable",
      "cudaq-gpu": variaqInstalled && nvidiaAvailable ? "available" : "unavailable",
    };

    const version =
      (typeof probe.variaq_version === "string" ? probe.variaq_version : null) ??
      (versionResult.code === 0 ? versionResult.stdout.trim().replace(/^variaq\s+/, "") : null);
    const compatibility = checkVariaqVersion(version);

    return {
      variaq: {
        installed: variaqInstalled,
        version,
        python: c.pythonPath,
        projectDir: c.projectDir,
        resolvedFrom: c.source,
        compatibility,
      },
      solvers,
      cudaq: {
        installed: cudaqInstalled,
        version: typeof probe.cudaq_version === "string" ? probe.cudaq_version : null,
        qppCpu: qppCpu ? "available" : "unavailable",
        nvidiaTarget: nvidiaTarget ? "available" : "unavailable",
        nvidiaDriver: nvidiaDriver ? "available" : "unavailable",
        gpuCount,
        nvidia: nvidiaAvailable ? "available" : "unavailable",
      },
      store: {
        dbPath: c.dbPath ?? "<variaq default: data/variaq.sqlite3>",
        problemsDir: c.problemsDir ?? "<variaq default: data/problems>",
      },
    };
  }

  async function opVersion() {
    const c = await cfg();
    const result = await runVariaqStrict(c, ["--version"], { timeoutMs: 15_000 });
    return {
      version: result.stdout.trim(),
      python: c.pythonPath,
      stdout: result.stdout,
      compatibility: checkVariaqVersion(result.stdout),
    };
  }

  async function opProblemGenerate(input: { nodes: number; edgeProbability: number; seed: number }) {
    const c = await cfg();
    const result = await runVariaqStrict(c, [
      "problem", "generate", "maxcut",
      "--nodes", String(input.nodes),
      "--edge-probability", String(input.edgeProbability),
      "--seed", String(input.seed),
    ]);
    return { problemId: extractSavedProblemId(result.stdout), stdout: result.stdout };
  }

  async function opProblemShow(problemId: string) {
    const c = await cfg();
    const result = await runVariaqStrict(c, ["problem", "show", problemId], { timeoutMs: 15_000 });
    return { problem: parseJsonOutput(result.stdout, "problem show") };
  }

  async function opSolve(input: {
    problemId: string;
    solver: string;
    seed: number;
    params: [string, string][];
  }) {
    const c = await cfg();
    const args = ["solve", input.problemId, "--solver", input.solver, "--seed", String(input.seed)];
    for (const [k, v] of input.params) args.push("--param", `${k}=${v}`);
    const result = await runVariaq(c, args);
    const runId = extractRunId(result.stdout);
    const { run } = runId !== null ? await opRun(runId) : { run: null };
    return {
      exitCode: result.timedOut ? -1 : result.code,
      timedOut: result.timedOut,
      runId,
      run,
      stderr: result.stderr.trim() || null,
      stdout: result.stdout,
    };
  }

  async function opBenchmark(input: {
    problemId: string;
    solvers: string[];
    seed: number;
    repeats: number;
  }) {
    const c = await cfg();
    const result = await runVariaq(c, [
      "benchmark", input.problemId,
      "--solvers", input.solvers.join(","),
      "--seed", String(input.seed),
      "--repeats", String(input.repeats),
    ]);
    const runIds = extractRunIds(result.stdout);
    const runs = await Promise.all(runIds.map(async (runId) => (await opRun(runId)).run));
    return {
      exitCode: result.timedOut ? -1 : result.code,
      timedOut: result.timedOut,
      runIds,
      runs,
      stderr: result.stderr.trim() || null,
      stdout: result.stdout,
    };
  }

  async function opCompareQuantum(input: { problemId: string; p: number; repeats: number }) {
    const c = await cfg();
    const result = await runVariaq(c, [
      "compare", "quantum", input.problemId,
      "--p", String(input.p),
      "--repeats", String(input.repeats),
    ]);
    const runIds = extractRunIds(result.stdout);
    const runs = await Promise.all(runIds.map(async (runId) => (await opRun(runId)).run));
    // The human "Matched quantum detail" block is a presentation summary of the
    // persisted per-solver runs; do not parse that presentation text. Return
    // the persisted records resolved from the stable run-id tokens instead.
    return {
      exitCode: result.timedOut ? -1 : result.code,
      timedOut: result.timedOut,
      runIds,
      runs,
      stderr: result.stderr.trim() || null,
      stdout: result.stdout,
    };
  }

  async function opRuns(limit: number) {
    const c = await cfg();
    const result = await runVariaqStrict(c, ["runs", "list", "--limit", String(limit)], {
      timeoutMs: 15_000,
    });
    if (result.stdout.trim() === "No experiment runs recorded.") {
      return { runs: [] as z.infer<typeof runListRowSchema>[] };
    }
    return {
      runs: z.array(runListRowSchema).parse(parseJsonOutput(result.stdout, "runs list")),
    };
  }

  async function opRun(runId: string) {
    const c = await cfg();
    const result = await runVariaqStrict(c, ["runs", "show", runId], { timeoutMs: 15_000 });
    return { run: parseJsonOutput(result.stdout, "runs show") };
  }

  async function opReproduce(runId: string) {
    const c = await cfg();
    const result = await runVariaq(c, ["runs", "reproduce", runId]);
    const newRunId = extractRunId(result.stdout);
    const { run } = newRunId !== null ? await opRun(newRunId) : { run: null };
    return {
      exitCode: result.timedOut ? -1 : result.code,
      timedOut: result.timedOut,
      runId: newRunId,
      run,
      stderr: result.stderr.trim() || null,
      stdout: result.stdout,
    };
  }

  const errorResult = (err: unknown): string => {
    if (err instanceof PluginError) {
      return JSON.stringify(
        { error: err.message, ...(err.hint !== undefined ? { hint: err.hint } : {}) },
        null,
        2,
      );
    }
    throw err;
  };

  // ----------------------------------------------------------------- CLI --

  bb.cli.register({
    name: "variaq",
    summary: "Run VariaQ classical/quantum experiments from bb",
    commands: [
      { name: "status", summary: "Show VariaQ install, solver, and CUDA-Q capabilities", usage: "bb variaq status [--json]" },
      { name: "version", summary: "Show the VariaQ CLI version", usage: "bb variaq version [--json]" },
      {
        name: "problem-generate",
        summary: "Generate a deterministic MaxCut problem",
        usage: "bb variaq problem-generate --nodes N --edge-probability P --seed S [--json]",
      },
      { name: "problem-show", summary: "Show a saved problem as JSON", usage: "bb variaq problem-show <problem-id> [--json]" },
      {
        name: "solve",
        summary: "Run one solver on a problem and persist the run",
        usage: `bb variaq solve <problem-id> --solver <${SOLVERS.join("|")}> [--seed S] [--param KEY=VALUE ...] [--json]`,
      },
      {
        name: "benchmark",
        summary: "Compare solvers on one problem",
        usage: "bb variaq benchmark <problem-id> [--solvers a,b] [--repeats N] [--seed S] [--json]",
      },
      {
        name: "compare-quantum",
        summary: "Run matched Qiskit/CUDA-Q QAOA comparison",
        usage: "bb variaq compare-quantum <problem-id> [--p N] [--repeats N] [--json]",
      },
      { name: "runs", summary: "List recent experiment runs", usage: "bb variaq runs [--limit N] [--json]" },
      { name: "run", summary: "Show one experiment run as JSON", usage: "bb variaq run <run-id> [--json]" },
      { name: "reproduce", summary: "Reproduce a durable experiment run", usage: "bb variaq reproduce <run-id> [--json]" },
    ],

    async run(argv) {
      const json = argv.includes("--json");
      const clean = argv.filter((a) => a !== "--json");

      async function dispatch(command: string, args: string[]): Promise<unknown> {
        switch (command) {
          case "status":
            return opStatus();
          case "version":
            return opVersion();
          case "problem-generate": {
            const opts = readOptions(args);
            return opProblemGenerate({
              nodes: requiredInt(opts, "nodes"),
              edgeProbability: requiredFloat(opts, "edge-probability"),
              seed: requiredInt(opts, "seed"),
            });
          }
          case "problem-show":
            return opProblemShow(requiredPositional(args, "problem-id"));
          case "solve": {
            const problem = args[0];
            if (problem === undefined || problem.startsWith("--")) {
              throw new PluginError("Missing problem id.", "Usage: bb variaq solve <problem-id> --solver <solver>");
            }
            const opts = readOptions(args.slice(1));
            const params = collectRepeated(args.slice(1), "--param").map((kv) => parseKeyValue(kv, "--param"));
            return opSolve({
              problemId: problem,
              solver: requiredOption(opts, "solver"),
              seed: optionalInt(opts, "seed", 0),
              params,
            });
          }
          case "benchmark": {
            const problem = args[0];
            if (problem === undefined || problem.startsWith("--")) {
              throw new PluginError("Missing problem id.", "Usage: bb variaq benchmark <problem-id>");
            }
            const opts = readOptions(args.slice(1));
            return opBenchmark({
              problemId: problem,
              solvers: parseSolvers(opts.get("solvers") ?? "exact,heuristic,qaoa"),
              seed: optionalInt(opts, "seed", 0),
              repeats: optionalInt(opts, "repeats", 1),
            });
          }
          case "compare-quantum": {
            const problem = args[0];
            if (problem === undefined || problem.startsWith("--")) {
              throw new PluginError("Missing problem id.", "Usage: bb variaq compare-quantum <problem-id>");
            }
            const opts = readOptions(args.slice(1));
            return opCompareQuantum({
              problemId: problem,
              p: optionalInt(opts, "p", 1),
              repeats: optionalInt(opts, "repeats", 1),
            });
          }
          case "runs": {
            const opts = readOptions(args);
            return opRuns(optionalInt(opts, "limit", 20));
          }
          case "run":
            return opRun(requiredPositional(args, "run-id"));
          case "reproduce":
            return opReproduce(requiredPositional(args, "run-id"));
          default:
            throw new PluginError(`Unknown command: ${command}`, "Run `bb variaq` for usage.");
        }
      }

      const command = clean[0];
      if (command === undefined || command === "help" || command === "--help" || command === "-h") {
        return { exitCode: 0, stdout: USAGE };
      }

      try {
        const value = await dispatch(command, clean.slice(1));
        // Propagate VariaQ's own non-zero exit (solver failure, timeout, lookup
        // error) as a non-zero bb exit even on the human-readable path.
        if (
          typeof value === "object" &&
          value !== null &&
          "exitCode" in value &&
          typeof (value as { exitCode: unknown }).exitCode === "number" &&
          (value as { exitCode: number }).exitCode !== 0
        ) {
          const failure = value as {
            exitCode: number;
            timedOut?: boolean;
            stderr?: string | null;
            stdout?: string;
          };
          return {
            exitCode: failure.exitCode > 0 ? failure.exitCode : 1,
            stdout: json
              ? JSON.stringify(value, null, 2)
              : (typeof failure.stdout === "string" ? failure.stdout : undefined),
            stderr: failure.timedOut
              ? "VariaQ command timed out."
              : ((failure.stderr ?? "").trim() || undefined),
          };
        }
        return { exitCode: 0, stdout: formatCliOutput(value, json) };
      } catch (err) {
        if (err instanceof PluginError) {
          return {
            exitCode: err.exitCode ?? 1,
            stderr: err.hint !== undefined ? `${err.message}\nHint: ${err.hint}` : err.message,
          };
        }
        throw err;
      }
    },
  });

  // ----------------------------------------------------------- agent tools --

  bb.agents.registerTool({
    name: "variaq_status",
    description:
      "Report the detected VariaQ installation, per-solver availability, and CUDA-Q capability (version, qpp-cpu, nvidia) from the live environment.",
    instructions:
      "Use variaq_status before planning runs — it reports which of exact/heuristic/qaoa/cudaq-cpu/cudaq-gpu are actually available in the detected environment.",
    parameters: z.object({}),
    async execute() {
      try {
        return JSON.stringify(await opStatus(), null, 2);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  bb.agents.registerTool({
    name: "variaq_version",
    description: "Show the installed VariaQ CLI version and verify the plugin can reach VariaQ.",
    instructions: "Use variaq_version to confirm which VariaQ and python the plugin resolved.",
    parameters: z.object({}),
    async execute() {
      try {
        const v = await opVersion();
        return JSON.stringify(
          { version: v.version, python: v.python, compatibility: v.compatibility },
          null,
          2,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  bb.agents.registerTool({
    name: "variaq_problem_generate",
    description:
      "Generate a deterministic MaxCut problem in the standalone VariaQ install and return its problem id.",
    instructions:
      "Use variaq_problem_generate to create a MaxCut problem before solving. Deterministic: same nodes/edgeProbability/seed → same problem.",
    parameters: z.object({
      nodes: z.number().int().min(2).max(64).describe("Number of graph nodes"),
      edgeProbability: z.number().gt(0).lte(1).describe("Erdos-Renyi edge probability (0,1]"),
      seed: z.number().int().min(0).describe("Deterministic generation seed"),
    }),
    async execute({ nodes, edgeProbability, seed }) {
      try {
        const result = await opProblemGenerate({ nodes, edgeProbability, seed });
        return JSON.stringify({ problemId: result.problemId, output: result.stdout.trim() }, null, 2);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  bb.agents.registerTool({
    name: "variaq_problem_show",
    description: "Show a saved VariaQ problem (id, type, nodes, edges, generation metadata) as JSON.",
    instructions: "Use variaq_problem_show to inspect a problem before solving it.",
    parameters: z.object({
      problemId: z.string().min(1).describe("Problem id, e.g. maxcut-bff76da580f66c21"),
    }),
    async execute({ problemId }) {
      try {
        const { problem } = await opProblemShow(problemId);
        return JSON.stringify(problem, null, 2);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  bb.agents.registerTool({
    name: "variaq_solve",
    description:
      "Run one VariaQ solver on a problem and persist the run. Returns the run id plus the full run record (objective, gap, solution, backend metrics).",
    instructions:
      "Use variaq_solve for a single solver run. Solvers: exact, heuristic, qaoa (Qiskit statevector), cudaq-cpu, cudaq-gpu. CUDA-Q solvers fail unless VariaQ was installed with the 'cudaq' extra; cudaq-gpu additionally needs a working NVIDIA toolchain. No physical QPU execution exists.",
    parameters: z.object({
      problemId: z.string().min(1).describe("Problem id from variaq_problem_generate or the VariaQ CLI"),
      solver: solverEnum.describe("Solver name"),
      seed: z.number().int().min(0).optional().describe("Solver seed (default 0)"),
      params: z
        .record(z.string(), z.union([z.string(), z.number()]))
        .optional()
        .describe("Optional solver parameters as KEY=VALUE pairs, e.g. {\"restarts\": 16}"),
    }),
    async execute({ problemId, solver, seed, params }) {
      try {
        const result = await opSolve({
          problemId,
          solver,
          seed: seed ?? 0,
          params: Object.entries(params ?? {}).map(([k, v]) => [k, String(v)] as [string, string]),
        });
        if (result.exitCode !== 0 || result.timedOut) {
          return JSON.stringify(
            {
              error: result.timedOut
                ? "timeout"
                : (result.stderr ?? `variaq solve exited ${result.exitCode}`),
              runId: result.runId,
              run: result.run,
            },
            null,
            2,
          );
        }
        return JSON.stringify({ runId: result.runId, run: result.run }, null, 2);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  bb.agents.registerTool({
    name: "variaq_benchmark",
    description: "Compare several VariaQ solvers on one problem. Returns run ids and the VariaQ comparison table.",
    instructions: "Use variaq_benchmark to compare exact vs heuristic vs qaoa (and cudaq-* when available) on the same problem.",
    parameters: z.object({
      problemId: z.string().min(1).describe("Problem id"),
      solvers: z.array(solverEnum).min(1).optional().describe("Solvers (default: exact,heuristic,qaoa)"),
      seed: z.number().int().min(0).optional().describe("Benchmark seed (default 0)"),
      repeats: z.number().int().min(1).max(10).optional().describe("Repeat count per solver (default 1)"),
    }),
    async execute({ problemId, solvers, seed, repeats }) {
      try {
        const result = await opBenchmark({
          problemId,
          solvers: solvers ?? ["exact", "heuristic", "qaoa"],
          seed: seed ?? 0,
          repeats: repeats ?? 1,
        });
        return JSON.stringify(
          {
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            runIds: result.runIds,
            runs: result.runs,
            stderr: result.stderr,
            table: result.stdout,
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  bb.agents.registerTool({
    name: "variaq_compare_quantum",
    description:
      "Run VariaQ's matched Qiskit/CUDA-Q QAOA comparison on one problem. Returns the per-solver run ids (resolvable via variaq_run_show) plus VariaQ's comparison output.",
    instructions:
      "Use variaq_compare_quantum to compare matched QAOA implementations. CUDA-Q solvers require VariaQ's 'cudaq' extra.",
    parameters: z.object({
      problemId: z.string().min(1).describe("Problem id"),
      p: z.number().int().min(1).max(4).optional().describe("QAOA depth p (default 1)"),
      repeats: z.number().int().min(1).max(10).optional().describe("Repeat count (default 1)"),
    }),
    async execute({ problemId, p, repeats }) {
      try {
        const result = await opCompareQuantum({ problemId, p: p ?? 1, repeats: repeats ?? 1 });
        if (result.exitCode !== 0 || result.timedOut) {
          return JSON.stringify(
            {
              error: result.timedOut ? "timeout" : (result.stderr ?? `compare exited ${result.exitCode}`),
              runIds: result.runIds,
              runs: result.runs,
              output: result.stdout,
            },
            null,
            2,
          );
        }
        return JSON.stringify({ runIds: result.runIds, runs: result.runs, output: result.stdout }, null, 2);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  bb.agents.registerTool({
    name: "variaq_runs_list",
    description: "List recent VariaQ experiment runs (run_id, problem, solver, status, objective, timing).",
    instructions: "Use variaq_runs_list to see recent experiment runs before inspecting one in detail.",
    parameters: z.object({
      limit: z.number().int().min(1).max(100).optional().describe("Max runs to return (default 20)"),
    }),
    async execute({ limit }) {
      try {
        return JSON.stringify(await opRuns(limit ?? 20), null, 2);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  bb.agents.registerTool({
    name: "variaq_run_show",
    description: "Show one VariaQ experiment run by id, including result, solution, environment, and solver config.",
    instructions: "Use variaq_run_show with a run_id from variaq_solve/variaq_benchmark/variaq_runs_list to get the full run record.",
    parameters: z.object({
      runId: z.string().min(1).describe("Run id, e.g. run-f3d8edf3-25f2-4a50-9d3b-ec7c7c064560"),
    }),
    async execute({ runId }) {
      try {
        const { run } = await opRun(runId);
        return JSON.stringify(run, null, 2);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  bb.agents.registerTool({
    name: "variaq_run_reproduce",
    description: "Reproduce a durable VariaQ experiment run by id and return the new run record.",
    instructions: "Use variaq_run_reproduce to re-execute a recorded run with its stored configuration.",
    parameters: z.object({
      runId: z.string().min(1).describe("Run id to reproduce"),
    }),
    async execute({ runId }) {
      try {
        const result = await opReproduce(runId);
        if (result.exitCode !== 0 || result.timedOut) {
          return JSON.stringify(
            {
              error: result.timedOut ? "timeout" : (result.stderr ?? `reproduce exited ${result.exitCode}`),
              runId: result.runId,
              run: result.run,
            },
            null,
            2,
          );
        }
        return JSON.stringify({ runId: result.runId, run: result.run }, null, 2);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  bb.log.info("VariaQ plugin loaded.");
}

// ------------------------------------------------------------ CLI helpers --

function readOptions(args: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a !== undefined && a.startsWith("--") && a !== "--param") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new PluginError(`Missing value for ${a}`);
      }
      map.set(a.slice(2), next);
      i++;
    }
  }
  return map;
}

function collectRepeated(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) {
      const next = args[i + 1];
      if (next === undefined) throw new PluginError(`Missing value after ${flag}`);
      values.push(next);
      i++;
    }
  }
  return values;
}

function requiredPositional(args: string[], name: string): string {
  const value = args.find((a) => !a.startsWith("--"));
  if (value === undefined) throw new PluginError(`Missing <${name}>.`);
  return value;
}

function requiredOption(opts: Map<string, string>, name: string): string {
  const value = opts.get(name);
  if (value === undefined || value === "") {
    throw new PluginError(`Missing required option --${name}`);
  }
  return value;
}

function requiredInt(opts: Map<string, string>, name: string): number {
  return parseInteger(requiredOption(opts, name), name);
}

function optionalInt(opts: Map<string, string>, name: string, fallback: number): number {
  const value = opts.get(name);
  return value === undefined ? fallback : parseInteger(value, name);
}

function requiredFloat(opts: Map<string, string>, name: string): number {
  const raw = requiredOption(opts, name);
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new PluginError(`--${name} must be a number, got '${raw}'`);
  }
  return value;
}

function parseInteger(raw: string, name: string): number {
  if (!/^-?\d+$/.test(raw)) {
    throw new PluginError(`--${name} must be an integer, got '${raw}'`);
  }
  return Number.parseInt(raw, 10);
}

/** Human-readable default for the CLI; full JSON under --json. */
function formatCliOutput(value: unknown, json: boolean): string {
  if (json) return JSON.stringify(value, null, 2);
  if (typeof value !== "object" || value === null) return String(value);
  const record = value as Record<string, unknown>;

  if ("variaq" in record && "solvers" in record) {
    const status = value as {
      variaq: {
        installed: boolean;
        version: string | null;
        python: string;
        resolvedFrom: string;
        compatibility: { warning: string | null };
      };
      solvers: Record<string, string>;
      cudaq: Record<string, string | boolean>;
    };
    const lines: string[] = [
      `VariaQ:`,
      `  installed: ${status.variaq.installed ? "yes" : "no"}`,
      `  version: ${status.variaq.version ?? "unknown"}`,
      `  python: ${status.variaq.python}`,
      `  resolved from: ${status.variaq.resolvedFrom}`,
      ...(status.variaq.compatibility.warning === null
        ? []
        : [`  warning: ${status.variaq.compatibility.warning}`]),
      ``,
      `Solvers:`,
      ...Object.entries(status.solvers).map(([name, s]) => `  ${name}: ${s}`),
      ``,
      `CUDA-Q:`,
      ...Object.entries(status.cudaq).map(([k, v]) => `  ${k}: ${String(v)}`),
    ];
    return lines.join("\n");
  }

  if ("version" in record && "stdout" in record) {
    const compatibility = record.compatibility as { warning?: string | null } | undefined;
    const warning = compatibility?.warning;
    return warning
      ? `${String(record.stdout).trimEnd()}\nWarning: ${warning}`
      : String(record.stdout).trimEnd();
  }
  if ("problemId" in record && "stdout" in record) return String(record.stdout).trimEnd();
  if ("problem" in record) return JSON.stringify(record.problem, null, 2);

  if ("runId" in record && "run" in record) {
    const parts: string[] = [];
    if (record.runId !== null) parts.push(`run_id=${String(record.runId)}`);
    const run = record.run as Record<string, unknown> | null;
    const result = run?.result as Record<string, unknown> | undefined;
    if (result !== undefined) {
      parts.push(
        `solver=${String(result.solver_name)} status=${String(result.status)} objective=${String(result.objective)}`,
      );
    }
    if (typeof record.stderr === "string" && record.stderr) parts.push(`stderr: ${record.stderr}`);
    return parts.length > 0 ? parts.join("\n") : JSON.stringify(value, null, 2);
  }

  if ("runIds" in record && "stdout" in record) return String(record.stdout).trimEnd();
  if ("runs" in record) return JSON.stringify(record.runs, null, 2);

  return JSON.stringify(value, null, 2);
}
