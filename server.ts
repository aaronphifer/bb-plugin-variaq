import { z } from "zod";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";
import { problemFamilySchema, type ProblemFamily } from "./lib/schema.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { PluginError, checkVariaqVersion, generateProblemArgv, parseJsonOutput, parseKeyValue, parseSolvers, probeCapabilities, quantumSupportNote, requireSuccess, resolveConfig, runVariaqJson, runVariaqStrict, solverSupportsFamily, statusFromCapabilities } from "./lib/runner.js";
import type { ResolvedConfig, VariaqSettings, CompareQuantumEnvelopeData, BenchmarkEnvelopeData, ReproduceEnvelopeData, ProblemGenerateData, SolveEnvelopeData, FamilyGenerateInput, VariaqSolver } from "./lib/runner.js";

const SOLVERS = ["exact", "heuristic", "qaoa", "cudaq-cpu", "cudaq-gpu"] as const;
const VARIAQ_SOLVERS = SOLVERS;
const solverEnum = z.enum(SOLVERS);

const USAGE = `bb variaq — Run VariaQ classical/quantum experiments from bb

  bb variaq status [--json]
  bb variaq version [--json]
  bb variaq problem-generate FAMILY [--nodes N] [--edge-probability P] [--task-count T] [--resource-count R] [--candidate-count C] [--partition-count K] --seed S [--json]
  bb variaq problem-import <json-content-or-path> [--output PATH] [--json]
  bb variaq problem-show <problem-id> [--json]
  bb variaq solve <problem-id> --solver <${SOLVERS.join("|")}> [--seed S] [--param KEY=VALUE ...] [--json]
  bb variaq benchmark <problem-id> [--solvers a,b] [--repeats N] [--seed S] [--json]
  bb variaq compare-quantum <problem-id> [--p N] [--repeats N] [--json]
  bb variaq runs [--limit N] [--json]
  bb variaq run <run-id> [--json]
  bb variaq reproduce <run-id> [--json]

Problem families: maxcut, assignment, subset-selection, graph-partition.

This plugin shells out to the standalone VariaQ CLI. Solver/quantum logic
lives in VariaQ — never here. Quantum solver availability and supported
problem families are reported dynamically by VariaQ capabilities. CUDA-Q
solvers require VariaQ's 'cudaq' extra; GPU backends additionally need a
working NVIDIA toolchain.`;

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

  async function detectProblemFamily(c: ResolvedConfig, problemId: string): Promise<ProblemFamily | null> {
    const showResult = await runVariaqJson(c, ["problem", "show", problemId], { timeoutMs: 15_000 });
    if (showResult.code !== 0) return null;
    const family = (showResult.envelope.data as Record<string, unknown> | null)?.family;
    if (typeof family === "string" && problemFamilySchema.safeParse(family).success) {
      return family as ProblemFamily;
    }
    return null;
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

  async function opProblemGenerate(input: FamilyGenerateInput) {
    const c = await cfg();
    const argv = generateProblemArgv(input);
    const result = await runVariaqJson(c, argv);
    const envelope = requireSuccess(result, ["problem", "generate", input.family]);
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

  async function opProblemImport(input: { content: string; output?: string }) {
    const c = await cfg();
    // Security boundary: we never read an arbitrary agent-supplied path. The
    // caller provides the artifact content as a string; we write it to a
    // temporary file in the configured problems directory (or OS temp) and pass
    // that controlled path to VariaQ.
    const workDir = c.problemsDir ?? tmpdir();
    await fs.mkdir(workDir, { recursive: true });
    const tempFile = join(workDir, `import-${crypto.randomUUID()}.json`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.content);
    } catch (err) {
      throw new PluginError(
        "Problem import content is not valid JSON.",
        err instanceof Error ? err.message : String(err),
      );
    }
    // Basic sanity check: imported artifact must declare a known family.
    const family = (parsed as Record<string, unknown>)?.family;
    if (typeof family !== "string" || !problemFamilySchema.safeParse(family).success) {
      throw new PluginError(
        `Problem import artifact must declare a valid family (one of maxcut, assignment, subset-selection, graph-partition).`,
        `Received family: ${String(family)}`,
      );
    }
    await fs.writeFile(tempFile, input.content, "utf8");
    const argv = ["problem", "import", tempFile];
    if (input.output !== undefined) argv.push("--output", input.output);
    try {
      const result = await runVariaqJson(c, argv, { timeoutMs: 15_000 });
      const envelope = requireSuccess(result, ["problem", "import"]);
      const { data, warnings } = successData<Record<string, unknown>>(envelope, "problem import");
      const importedId = data.problem_id as string | undefined;
      // Return the full problem document by re-reading it from VariaQ.
      if (importedId !== undefined) {
        const showResult = await runVariaqJson(c, ["problem", "show", importedId], { timeoutMs: 15_000 });
        if (showResult.code === 0) {
          const showData = successData<Record<string, unknown>>(showResult.envelope, "problem show");
          return { problem: showData.data, warnings: [...warnings, ...showData.warnings], tempFile };
        }
      }
      return { problem: data, warnings, tempFile };
    } finally {
      // Best-effort cleanup of the temporary import artifact.
      try {
        await fs.unlink(tempFile);
      } catch {
        /* ignore */
      }
    }
  }

  async function opSolve(input: {
    problemId: string;
    solver: string;
    seed: number;
    params: [string, string][];
  }) {
    const c = await cfg();
    // Capability-driven pre-check: VariaQ is authoritative about solver/family compatibility.
    if (SOLVERS.includes(input.solver as typeof SOLVERS[number])) {
      const family = await detectProblemFamily(c, input.problemId);
      if (family !== null) {
        const cap = await probeCapabilities(c);
        const solverSupportedFamilies = Object.fromEntries(
          (cap.solvers ?? []).map((s) => [s.name, s.supported_families ?? []] as const),
        );
        if (!solverSupportsFamily(input.solver as typeof SOLVERS[number], family, solverSupportedFamilies)) {
          return {
            exitCode: 2,
            timedOut: false,
            runId: undefined,
            run: undefined,
            error: {
              type: "ValidationError",
              message: `Solver '${input.solver}' does not support problem family '${family}'; supported families: ${(solverSupportedFamilies[input.solver] ?? []).join(", ")}.`,
            },
            warnings: [],
            stderr: null,
          };
        }
      }
    }
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
    const family = await detectProblemFamily(c, input.problemId);
    const cap = await probeCapabilities(c);
    const solverSupportedFamilies = Object.fromEntries(
      (cap.solvers ?? []).map((s) => [s.name, s.supported_families ?? []] as const),
    );
    const quantumSolvers = ["qaoa", "cudaq-cpu", "cudaq-gpu"] as const;
    if (family !== null) {
      const unsupported = quantumSolvers.filter((solver) => !solverSupportsFamily(solver, family, solverSupportedFamilies));
      if (unsupported.length === quantumSolvers.length) {
        throw new PluginError(
          `compare quantum has no available quantum solvers for problem family '${family}'.`,
          quantumSupportNote(family, solverSupportedFamilies),
        );
      }
      if (unsupported.length > 0) {
        throw new PluginError(
          `compare quantum cannot include every selected solver for problem family '${family}'.`,
          unsupported.map((s) => `'${s}' does not support '${family}'; supported families: ${(solverSupportedFamilies[s] ?? []).join(", ")}.`).join(" ") +
          " Select only solvers whose supported_families include this problem family, or use variaq_solve for individual solvers.",
        );
      }
    }
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
        summary: "Generate a deterministic problem in a generic family",
        usage: "bb variaq problem-generate FAMILY --seed S [family-specific options] [--json]",
      },
      {
        name: "problem-import",
        summary: "Import a problem artifact JSON string into VariaQ",
        usage: "bb variaq problem-import <json-content> [--output PATH] [--json]",
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
        summary: "Run matched Qiskit/CUDA-Q QAOA comparison on a family supported by the selected quantum solvers",
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
            const family = args[0];
            if (family === undefined || family.startsWith("--")) {
              throw new PluginError("Missing problem family.", "Usage: bb variaq problem-generate <maxcut|assignment|subset-selection|graph-partition> ...");
            }
            if (!problemFamilySchema.safeParse(family).success) {
              throw new PluginError(`Unknown problem family: ${family}`, "Valid families: maxcut, assignment, subset-selection, graph-partition");
            }
            const opts = readOptions(args.slice(1));
            const seed = requiredInt(opts, "seed");
            const familyTyped = family as ProblemFamily;
            switch (familyTyped) {
              case "maxcut": {
                const input: FamilyGenerateInput = {
                  family: "maxcut",
                  seed,
                  nodes: requiredInt(opts, "nodes"),
                  edgeProbability: requiredFloat(opts, "edge-probability"),
                };
                return opProblemGenerate(input);
              }
              case "assignment": {
                const input: FamilyGenerateInput = {
                  family: "assignment",
                  seed,
                  taskCount: requiredInt(opts, "task-count"),
                  resourceCount: requiredInt(opts, "resource-count"),
                };
                return opProblemGenerate(input);
              }
              case "subset-selection": {
                const input: FamilyGenerateInput = {
                  family: "subset-selection",
                  seed,
                  candidateCount: requiredInt(opts, "candidate-count"),
                };
                return opProblemGenerate(input);
              }
              case "graph-partition": {
                const input: FamilyGenerateInput = {
                  family: "graph-partition",
                  seed,
                  nodes: requiredInt(opts, "nodes"),
                  edgeProbability: requiredFloat(opts, "edge-probability"),
                  partitionCount: requiredInt(opts, "partition-count"),
                };
                return opProblemGenerate(input);
              }
            }
          }
          case "problem-import": {
            const content = requiredPositional(args, "json-content");
            const opts = readOptions(args);
            return opProblemImport({ content, output: opts.get("output") });
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
      "Generate a deterministic VariaQ problem in one of the generic problem families (maxcut, assignment, subset-selection, graph-partition) and return its problem id.",
    instructions:
      "Use variaq_problem_generate to create a problem before solving. Pick the family first; family-specific fields are required only for that family. Deterministic: same parameters/seed → same problem.",
    parameters: z.discriminatedUnion("family", [
      z.object({
        family: z.literal("maxcut"),
        nodes: z.number().int().min(2).max(64).describe("Number of graph nodes"),
        edgeProbability: z.number().gt(0).lte(1).describe("Erdos-Renyi edge probability (0,1]"),
        seed: z.number().int().min(0).describe("Deterministic generation seed"),
      }),
      z.object({
        family: z.literal("assignment"),
        taskCount: z.number().int().min(1).max(256).describe("Number of tasks to assign"),
        resourceCount: z.number().int().min(1).max(256).describe("Number of resources"),
        seed: z.number().int().min(0).describe("Deterministic generation seed"),
      }),
      z.object({
        family: z.literal("subset-selection"),
        candidateCount: z.number().int().min(1).max(512).describe("Number of candidates"),
        seed: z.number().int().min(0).describe("Deterministic generation seed"),
      }),
      z.object({
        family: z.literal("graph-partition"),
        nodes: z.number().int().min(2).max(64).describe("Number of graph nodes"),
        edgeProbability: z.number().gt(0).lte(1).describe("Erdos-Renyi edge probability (0,1]"),
        partitionCount: z.number().int().min(2).max(16).describe("Number of partitions"),
        seed: z.number().int().min(0).describe("Deterministic generation seed"),
      }),
    ]),
    async execute(input) {
      try {
        const result = await opProblemGenerate(input as FamilyGenerateInput);
        return JSON.stringify({ problemId: result.problemId, data: result.data, warnings: result.warnings }, null, 2);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  bb.agents.registerTool({
    name: "variaq_problem_show",
    description: "Show a saved VariaQ problem (id, family, objective sense, opaque IDs, and family-specific data) as JSON.",
    instructions: "Use variaq_problem_show to inspect a problem before solving it.",
    parameters: z.object({
      problemId: z.string().min(1).describe("Problem id or path, e.g. maxcut-bff76da580f66c21"),
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
    name: "variaq_problem_import",
    description: "Import a VariaQ problem artifact (JSON content) into the configured problems directory and return the persisted problem.",
    instructions: "Use variaq_problem_import to bring an externally prepared VariaQ problem artifact into the VariaQ store. Pass the full JSON document as content, not a filesystem path. The artifact must declare a valid family and schema_version.",
    parameters: z.object({
      content: z.string().min(1).describe("The problem artifact JSON document as a string"),
      output: z.string().min(1).optional().describe("Optional explicit output path inside the configured problems directory"),
    }),
    async execute({ content, output }) {
      try {
        const result = await opProblemImport({ content, output });
        return JSON.stringify({ problem: result.problem, warnings: result.warnings }, null, 2);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  bb.agents.registerTool({
    name: "variaq_solve",
    description:
      "Run one VariaQ solver on a generic problem and persist the run. Returns the run id plus the full run record (objective, gap, solution, backend metrics).",
    instructions:
      "Use variaq_solve for a single solver run on a VariaQ generic problem. Solvers: exact, heuristic (all families), qaoa, cudaq-cpu, cudaq-gpu. Solver/family compatibility is determined by VariaQ capabilities — check variaq_status before running optional quantum solvers. No physical QPU execution exists.",
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
    description: "Compare several VariaQ solvers on one generic problem. Returns run ids and the VariaQ comparison structure.",
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
      "Run VariaQ's matched Qiskit/CUDA-Q QAOA comparison on a problem family supported by the selected quantum solvers. Returns the per-solver run records and the matched comparison structure.",
    instructions:
      "Use variaq_compare_quantum to compare matched QAOA implementations on a problem supported by VariaQ's quantum solvers. Quantum solver availability and supported problem families are reported dynamically by VariaQ capabilities — check variaq_status before running. CUDA-Q solvers require VariaQ's 'cudaq' extra. The plugin consults VariaQ capabilities to decide eligibility.",
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
      problem_families: string[];
      solver_supported_families: Record<string, string[]>;
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
      `  families: ${(status.problem_families ?? []).join(", ")}`,
      ...(status.variaq.compatibility.warning === null
        ? []
        : [`  warning: ${status.variaq.compatibility.warning}`]),
      ``,
      `Solvers:`,
      ...Object.entries(status.solvers).map(([name, s]) => {
        const families = (status.solver_supported_families?.[name] ?? []).join(", ");
        return `  ${name}: ${s}${families ? ` (${families})` : ""}`;
      }),
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
  if ("problemId" in record) {
    const gen = record.data as Record<string, unknown> | undefined;
    const family = gen?.family ?? gen?.problem_type ?? "unknown";
    return `Generated ${family} problem\n  problem_id: ${String(record.problemId)}\n  family: ${String(family)}\n  seed: ${String(gen?.seed ?? "?")}`;
  }
  if ("problem" in record && record.problem !== null) {
    const p = record.problem as Record<string, unknown>;
    const family = p.family ?? p.problem_type ?? "unknown";
    const sense = p.sense ?? "unknown";
    const id = p.problem_id ?? "unknown";
    return `Problem ${String(id)}\n  family: ${String(family)}\n  sense: ${String(sense)}\n${JSON.stringify(p, null, 2)}`;
  }

  if ("runId" in record && "run" in record) {
    const run = record.run as Record<string, unknown> | undefined;
    const family = run?.problem_type ?? run?.family ?? "unknown";
    const solver = run?.solver ?? "unknown";
    const backend = run?.backend ?? "unknown";
    const status = run?.status ?? "unknown";
    const objective = run?.objective ?? "?";
    const expectation = run?.expectation ?? null;
    const feasible = run?.feasible ?? "?";
    const feasibleCount = run?.feasible_sample_count ?? null;
    const infeasibleCount = run?.infeasible_sample_count ?? null;
    const totalSamples = feasibleCount !== null && infeasibleCount !== null ? Number(feasibleCount) + Number(infeasibleCount) : null;
    const lines = [
      `Run ${String(record.runId)}`,
      `  family: ${String(family)}`,
      `  solver: ${String(solver)}`,
      `  backend: ${String(backend)}`,
      `  status: ${String(status)}`,
      `  objective: ${String(objective)}`,
      ...(expectation !== null ? [`  expectation: ${String(expectation)}`] : []),
      `  feasible: ${String(feasible)}${totalSamples !== null ? ` (${feasibleCount}/${totalSamples} samples)` : ""}`,
    ];
    lines.push("");
    lines.push(JSON.stringify(record, null, 2));
    return lines.join("\n");
  }

  if ("runIds" in record) {
    if ("comparison" in record && record.comparison !== null) {
      const comparison = record.comparison as Record<string, unknown>;
      const runs = record.runs as Record<string, unknown>[] | undefined;
      const firstRun = runs?.[0];
      const family = (firstRun as Record<string, unknown> | undefined)?.problem_type ?? "unknown";
      const lines = [
        `Benchmark family: ${String(family)}`,
        `  aggregate_status: ${String(comparison.aggregate_status ?? "?")}`,
        `  solvers: ${String(comparison.solver_count ?? "?")}`,
        `  successful: ${String(comparison.successful_count ?? "?")}, failed: ${String(comparison.failed_count ?? "?")}, unavailable: ${String(comparison.unavailable_count ?? "?")}`,
      ];
      for (const run of runs ?? []) {
        const r = run as Record<string, unknown>;
        const expectation = r.expectation ?? null;
        const feasible = r.feasible ?? "?";
        const feasibleCount = r.feasible_sample_count ?? null;
        const infeasibleCount = r.infeasible_sample_count ?? null;
        const totalSamples = feasibleCount !== null && infeasibleCount !== null ? Number(feasibleCount) + Number(infeasibleCount) : null;
        const feasibleText = totalSamples !== null ? ` (${feasibleCount}/${totalSamples} samples)` : "";
        const parts = [
          `  ${String(r.solver)}: status=${String(r.status)}, objective=${String(r.objective ?? "?")}`,
          ...(expectation !== null ? [`expectation=${String(expectation)}`] : []),
          `gap=${String(r.optimality_gap_percent ?? "?")}`,
          `feasible=${String(feasible)}${feasibleText}`,
          `time=${String(r.wall_time_seconds ?? "?")}s`,
        ];
        lines.push(parts.join(", "));
      }
      lines.push("");
      lines.push(JSON.stringify(record, null, 2));
      return lines.join("\n");
    }
    return JSON.stringify(value, null, 2);
  }
  if ("runs" in record) return JSON.stringify(record.runs, null, 2);

  return JSON.stringify(value, null, 2);
}