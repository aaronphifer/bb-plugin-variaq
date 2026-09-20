import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  PluginError,
  checkVariaqVersion,
  parseJsonOutput,
  parseKeyValue,
  parseSolvers,
  probeCapabilities,
  requireSuccess,
  resolveConfig,
  runVariaqJson,
  runVariaqStrict,
  statusFromCapabilities,
  type ResolvedConfig,
  type VariaqSettings,
  type CompareQuantumEnvelopeData,
  type BenchmarkEnvelopeData,
  type ReproduceEnvelopeData,
  type ProblemGenerateData,
  type SolveEnvelopeData,
} from "./lib/runner.js";

const SOLVERS = ["exact", "heuristic", "qaoa", "cudaq-cpu", "cudaq-gpu"] as const;
const solverEnum = z.enum(SOLVERS);

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
    const versionResult = await runVariaqStrict(c, ["--version"], { timeoutMs: 15_000 });
    const version = versionResult.stdout.trim().replace(/^variaq\s+/, "");
    const cap = await probeCapabilities(c);
    const status = await statusFromCapabilities(c, cap);
    return status;
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
    const result = await runVariaqJson(c, [
      "problem", "generate", "maxcut",
      "--nodes", String(input.nodes),
      "--edge-probability", String(input.edgeProbability),
      "--seed", String(input.seed),
    ]);
    const envelope = requireSuccess(result, ["problem", "generate", "maxcut"]);
    const { data, warnings } = successData<ProblemGenerateData>(envelope, "problem generate");
    return { problemId: data.problem_id, data, warnings };
  }

  async function opProblemShow(problemId: string) {
    const c = await cfg();
    const result = await runVariaqJson(c, ["problem", "show", problemId], { timeoutMs: 15_000 });
    const envelope = requireSuccess(result, ["problem", "show", problemId]);
    const { data, warnings } = successData<Record<string, unknown>>(envelope, "problem show");
    return { problem: data, warnings };
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
    const result = await runVariaqJson(c, args);
    const envelope = result.envelope;
    if (result.code !== 0) {
      return {
        exitCode: result.code,
        timedOut: result.timedOut,
        runId: envelope.error?.run_id ?? (typeof envelope.data === "object" && envelope.data !== null ? (envelope.data as { run_id?: string }).run_id : undefined),
        run: typeof envelope.data === "object" && envelope.data !== null ? envelope.data : undefined,
        error: envelope.error,
        warnings: envelope.warnings,
        stderr: null,
      };
    }
    const { data, warnings } = successData<SolveEnvelopeData>(envelope, "solve");
    return {
      exitCode: result.code,
      timedOut: result.timedOut,
      runId: data.run_id,
      run: data,
      warnings,
      stderr: null,
    };
  }

  async function opBenchmark(input: {
    problemId: string;
    solvers: string[];
    seed: number;
    repeats: number;
  }) {
    const c = await cfg();
    const args = [
      "benchmark", input.problemId,
      "--solvers", input.solvers.join(","),
      "--seed", String(input.seed),
      "--repeats", String(input.repeats),
    ];
    const result = await runVariaqJson(c, args);
    const envelope = result.envelope;
    const { data, warnings } = successData<BenchmarkEnvelopeData>(envelope, "benchmark");
    const runIds = data.runs.map((run) => run.run_id);
    return {
      exitCode: result.code,
      timedOut: result.timedOut,
      status: envelope.status,
      runIds,
      runs: data.runs,
      comparison: data.comparison,
      error: result.code !== 0 ? envelope.error : undefined,
      warnings,
      stderr: null,
    };
  }

  async function opCompareQuantum(input: { problemId: string; p: number; repeats: number }) {
    const c = await cfg();
    const args = [
      "compare", "quantum", input.problemId,
      "--p", String(input.p),
      "--repeats", String(input.repeats),
    ];
    const result = await runVariaqJson(c, args);
    const envelope = result.envelope;
    const { data, warnings } = successData<CompareQuantumEnvelopeData>(envelope, "compare quantum");
    const runIds = data.runs.map((run) => run.run_id);
    return {
      exitCode: result.code,
      timedOut: result.timedOut,
      status: envelope.status,
      runIds,
      runs: data.runs,
      comparison: data.comparison,
      error: result.code !== 0 ? envelope.error : undefined,
      warnings,
      stderr: null,
    };
  }

  async function opRuns(limit: number) {
    const c = await cfg();
    const result = await runVariaqJson(c, ["runs", "list", "--limit", String(limit)], {
      timeoutMs: 15_000,
    });
    const envelope = requireSuccess(result, ["runs", "list"]);
    const { data, warnings } = successData<unknown[]>(envelope, "runs list");
    return {
      runs: data as Record<string, unknown>[],
      warnings,
    };
  }

  async function opRun(runId: string) {
    const c = await cfg();
    const result = await runVariaqJson(c, ["runs", "show", runId], { timeoutMs: 15_000 });
    const envelope = requireSuccess(result, ["runs", "show", runId]);
    const { data, warnings } = successData<Record<string, unknown>>(envelope, "runs show");
    return { run: data, warnings };
  }

  async function opReproduce(runId: string) {
    const c = await cfg();
    const result = await runVariaqJson(c, ["runs", "reproduce", runId]);
    const envelope = result.envelope;
    const { data, warnings } = successData<ReproduceEnvelopeData>(envelope, "runs reproduce");
    return {
      exitCode: result.code,
      timedOut: result.timedOut,
      runId: data.new_run_id,
      originalRunId: data.original_run_id,
      rerunOf: data.rerun_of,
      lineage: data.lineage,
      environmentDifferences: data.environment_differences,
      run: data.new.result,
      error: result.code !== 0 ? envelope.error : undefined,
      warnings,
      stderr: null,
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
        return JSON.stringify({ problemId: result.problemId, data: result.data, warnings: result.warnings }, null, 2);
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
        const { problem, warnings } = await opProblemShow(problemId);
        return JSON.stringify({ problem, warnings }, null, 2);
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
        return JSON.stringify(result, null, 2);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  bb.agents.registerTool({
    name: "variaq_benchmark",
    description: "Compare several VariaQ solvers on one problem. Returns run ids and the VariaQ comparison structure.",
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
        return JSON.stringify(result, null, 2);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  bb.agents.registerTool({
    name: "variaq_compare_quantum",
    description:
      "Run VariaQ's matched Qiskit/CUDA-Q QAOA comparison on one problem. Returns the per-solver run records and the matched comparison structure.",
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
        return JSON.stringify(result, null, 2);
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
        const { runs, warnings } = await opRuns(limit ?? 20);
        return JSON.stringify({ runs, warnings }, null, 2);
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
        const { run, warnings } = await opRun(runId);
        return JSON.stringify({ run, warnings }, null, 2);
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
        return JSON.stringify(result, null, 2);
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

function successData<T>(
  envelope: import("./lib/schema.js").ParsedEnvelope,
  command: string,
): { data: T; warnings: import("./lib/schema.js").StructuredWarning[] } {
  const unwrapped = unwrapEnvelope<T>(envelope, command);
  return { data: unwrapped.data, warnings: unwrapped.warnings };
}

function unwrapEnvelope<T = unknown>(
  envelope: import("./lib/schema.js").ParsedEnvelope,
  command: string,
): {
  status: import("./lib/schema.js").EnvelopeStatus;
  data: T;
  error: import("./lib/schema.js").StructuredError | undefined;
  warnings: import("./lib/schema.js").StructuredWarning[];
} {
  if (envelope.command !== command && envelope.command !== `${command} json`) {
    // Future VariaQ releases may append qualifiers; warn, do not hard-fail.
  }
  return {
    status: envelope.status,
    data: envelope.data as T,
    error: envelope.error,
    warnings: envelope.warnings,
  };
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
        schema_version: string | null;
        python: string;
        resolvedFrom: string;
        compatibility: { warning: string | null };
      };
      solvers: Record<string, string>;
      frameworks: Record<string, unknown>;
      physical_qpu: Record<string, unknown>;
    };
    const lines: string[] = [
      `VariaQ:`,
      `  installed: ${status.variaq.installed ? "yes" : "no"}`,
      `  version: ${status.variaq.version ?? "unknown"}`,
      `  schema_version: ${status.variaq.schema_version ?? "unknown"}`,
      `  python: ${status.variaq.python}`,
      `  resolved from: ${status.variaq.resolvedFrom}`,
      ...(status.variaq.compatibility.warning === null
        ? []
        : [`  warning: ${status.variaq.compatibility.warning}`]),
      ``,
      `Solvers:`,
      ...Object.entries(status.solvers).map(([name, s]) => `  ${name}: ${s}`),
      ``,
      `Frameworks:`,
      ...Object.entries(status.frameworks).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`),
      ``,
      `Physical QPU:`,
      ...Object.entries(status.physical_qpu).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`),
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
  if ("problemId" in record) return JSON.stringify(record, null, 2);
  if ("problem" in record) return JSON.stringify(record.problem, null, 2);

  if ("runId" in record && "run" in record) {
    return JSON.stringify(value, null, 2);
  }

  if ("runIds" in record) return JSON.stringify(value, null, 2);
  if ("runs" in record) return JSON.stringify(record.runs, null, 2);

  return JSON.stringify(value, null, 2);
}
