import { z } from "zod";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import crypto from "node:crypto";
import { problemFamilySchema, type ProblemFamily, campaignDefinitionSchema, campaignPlanDataSchema, campaignRunDataSchema, campaignListItemSchema, analyzeQuerySchema, reportFormatsSchema, type CampaignDefinition } from "./lib/schema.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { PluginError, checkVariaqVersion, generateProblemArgv, parseJsonOutput, parseKeyValue, parseSolvers, probeCapabilities, quantumSupportNote, requireSuccess, resolveConfig, runVariaqJson, runVariaqStrict, solverSupportsFamily, statusFromCapabilities } from "./lib/runner.js";
import type { ResolvedConfig, VariaqSettings, CompareQuantumEnvelopeData, BenchmarkEnvelopeData, ReproduceEnvelopeData, ProblemGenerateData, SolveEnvelopeData, FamilyGenerateInput, VariaqSolver, CampaignPlanEnvelopeData, CampaignRunEnvelopeData, CampaignListEnvelopeData, CampaignShowEnvelopeData, AnalyzeEnvelopeData, ReportCampaignEnvelopeData } from "./lib/runner.js";

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
  bb variaq campaign-plan <campaign-json-content> [--json]
  bb variaq campaign-run <campaign-json-content> [--max-runs N] [--override-max-runs] [--json]
  bb variaq campaigns [--limit N] [--json]
  bb variaq campaign <campaign-id> [--json]
  bb variaq analyze-runs [--run-id ID ...] [--group-by KEY ...] [--filter KEY=VALUE ...] [--scaling-x METRIC] [--include-failed] [--include-unavailable] [--compare COMPARISON] [--json]
  bb variaq analyze-campaign <campaign-id> [--group-by KEY ...] [--scaling-x METRIC] [--include-failed] [--include-unavailable] [--compare COMPARISON] [--json]
  bb variaq report-campaign <campaign-id> --output-dir DIR --formats f1,f2 [--group-by KEY ...] [--scaling-x METRIC] [--plots] [--overwrite] [--json]
  bb variaq runs [--limit N] [--json]
  bb variaq run <run-id> [--json]
  bb variaq reproduce <run-id> [--json]

Campaign tools are read-only (plan/analyze) or execute solver runs (run).
Reports create files under the configured report output directory.

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
    reportOutputDir: {
      type: "string",
      label: "Report output directory",
      description: "Directory for generated campaign reports. Leave empty to use a safe default under the project workspace.",
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
      reportOutputDir: values.reportOutputDir,
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

  // Helpers for safe temporary file handling and report path containment.

  async function writeCampaignTemp(c: ResolvedConfig, definition: CampaignDefinition): Promise<string> {
    const workDir = c.problemsDir ?? tmpdir();
    await fs.mkdir(workDir, { recursive: true });
    const tempFile = join(workDir, `campaign-${crypto.randomUUID()}.json`);
    await fs.writeFile(tempFile, JSON.stringify(definition, null, 2), "utf8");
    return tempFile;
  }

  function resolveReportOutputDir(c: ResolvedConfig): string {
    if (c.reportOutputDir !== null) return c.reportOutputDir;
    // Keep the default stable so reports remain discoverable and VariaQ's
    // overwrite protection applies across separate plugin calls.
    return join(c.projectDir, "reports");
  }

  /**
   * Ensure `outputDir` is contained within `root`. Rejects traversal attempts,
   * absolute paths outside root, and symlinks that escape root.
   */
  async function resolveContainedReportDir(root: string, outputDir: string): Promise<string> {
    await fs.mkdir(root, { recursive: true });
    const absRoot = await fs.realpath(resolve(root));
    const candidate = resolve(absRoot, outputDir);
    const relativeCandidate = relative(absRoot, candidate);
    if (
      relativeCandidate === ".." ||
      relativeCandidate.startsWith(`..${sep}`) ||
      isAbsolute(relativeCandidate)
    ) {
      throw new PluginError(
        `Report output directory '${outputDir}' is outside the allowed report root.`,
        "Use a relative path beneath the configured report output directory, or ask the user to change the reportOutputDir setting.",
      );
    }

    // Walk one component at a time and reject symlinks. Resolving only the
    // complete candidate is unsafe when its final component does not yet
    // exist but an existing parent symlink escapes the root.
    let current = absRoot;
    for (const part of relativeCandidate.split(sep).filter(Boolean)) {
      current = join(current, part);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) {
          throw new PluginError(
            `Report output directory '${outputDir}' contains a symbolic link.`,
            "Use a real directory beneath the configured report output directory.",
          );
        }
        if (!stat.isDirectory()) {
          throw new PluginError(`Report output directory '${outputDir}' is not a directory.`);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        await fs.mkdir(current);
      }
    }
    return current;
  }

  // ------------------------------------------------------------------ campaigns --

  async function opCampaignPlan(definition: CampaignDefinition) {
    const c = await cfg();
    const validated = campaignDefinitionSchema.parse(definition);
    const tempFile = await writeCampaignTemp(c, validated);
    try {
      const result = await runVariaqJson(c, ["campaign", "plan", tempFile], { timeoutMs: 30_000 });
      const envelope = requireSuccess(result, ["campaign", "plan"]);
      const { data, warnings } = successData<CampaignPlanEnvelopeData>(envelope, "campaign plan");
      return { plan: campaignPlanDataSchema.parse(data), warnings };
    } finally {
      try {
        await fs.unlink(tempFile);
      } catch {
        /* ignore */
      }
    }
  }

  async function opCampaignRun(definition: CampaignDefinition, maxRuns: number, overrideMaxRuns: boolean) {
    const c = await cfg();
    const validated = campaignDefinitionSchema.parse(definition);
    const tempFile = await writeCampaignTemp(c, validated);
    try {
      const argv = ["campaign", "run", tempFile, "--max-runs", String(maxRuns)];
      if (overrideMaxRuns) argv.push("--override-max-runs");
      const result = await runVariaqJson(c, argv);
      if (result.code !== 0) {
        return {
          exitCode: result.code,
          timedOut: result.timedOut,
          campaignId: undefined,
          summary: undefined,
          error: result.envelope.error,
          warnings: result.envelope.warnings,
          stderr: null,
        };
      }
      const envelope = result.envelope;
      const { data, warnings } = successData<CampaignRunEnvelopeData>(envelope, "campaign run");
      return {
        exitCode: result.code,
        timedOut: result.timedOut,
        campaignId: data.campaign_id,
        summary: campaignRunDataSchema.parse(data),
        error: undefined,
        warnings,
        stderr: null,
      };
    } finally {
      try {
        await fs.unlink(tempFile);
      } catch {
        /* ignore */
      }
    }
  }

  async function opCampaignList(limit: number) {
    const c = await cfg();
    const result = await runVariaqJson(c, ["campaign", "list", "--limit", String(limit)], { timeoutMs: 15_000 });
    const envelope = requireSuccess(result, ["campaign", "list"]);
    const { data, warnings } = successData<unknown[]>(envelope, "campaign list");
    const campaigns = (data as Record<string, unknown>[]).map((item) => campaignListItemSchema.parse(item));
    return { campaigns, warnings };
  }

  async function opCampaignShow(campaignId: string) {
    const c = await cfg();
    const result = await runVariaqJson(c, ["campaign", "show", campaignId], { timeoutMs: 15_000 });
    const envelope = requireSuccess(result, ["campaign", "show", campaignId]);
    const { data, warnings } = successData<CampaignShowEnvelopeData>(envelope, "campaign show");
    return { campaignId, campaign: data, warnings };
  }

  // ------------------------------------------------------------------ analysis --

  function buildAnalyzeArgv(kind: "runs" | "campaign", query: import("./lib/schema.js").AnalyzeQuery): string[] {
    const argv: string[] = ["analyze", kind];
    if (kind === "runs" && query.run_ids !== undefined && query.run_ids.length > 0) {
      for (const id of query.run_ids) argv.push("--run-id", id);
    }
    if (kind === "campaign" && query.campaign_id !== undefined) {
      argv.push(query.campaign_id);
    }
    if (query.group_by !== undefined) {
      for (const key of query.group_by) argv.push("--group-by", key);
    }
    if (query.filters !== undefined) {
      for (const [k, v] of Object.entries(query.filters)) argv.push("--filter", `${k}=${v}`);
    }
    if (query.scaling_x !== undefined) argv.push("--scaling-x", query.scaling_x);
    if (query.include_failed) argv.push("--include-failed");
    if (query.include_unavailable) argv.push("--include-unavailable");
    if (query.compare !== undefined) argv.push("--compare", query.compare);
    return argv;
  }

  async function opAnalyzeRuns(query: import("./lib/schema.js").AnalyzeQuery) {
    const c = await cfg();
    const validated = analyzeQuerySchema.parse(query);
    const argv = buildAnalyzeArgv("runs", validated);
    const result = await runVariaqJson(c, argv, { timeoutMs: 60_000 });
    const envelope = requireSuccess(result, ["analyze", "runs"]);
    const { data, warnings } = successData<AnalyzeEnvelopeData>(envelope, "analyze runs");
    return { analysis: data, warnings };
  }

  async function opAnalyzeCampaign(campaignId: string, query: Omit<import("./lib/schema.js").AnalyzeQuery, "campaign_id">) {
    const c = await cfg();
    const fullQuery = analyzeQuerySchema.parse({ ...query, campaign_id: campaignId });
    const argv = buildAnalyzeArgv("campaign", fullQuery);
    const result = await runVariaqJson(c, argv, { timeoutMs: 60_000 });
    const envelope = requireSuccess(result, ["analyze", "campaign"]);
    const { data, warnings } = successData<AnalyzeEnvelopeData>(envelope, "analyze campaign");
    return { analysis: data, warnings };
  }

  // ------------------------------------------------------------------ reports --

  /**
   * Canonicalize the requested report formats. `formats` is the canonical set;
   * `plots: true` is a compatibility alias that ensures "plots" appears once.
   * The result is deterministic, de-duplicated, and ordered.
   */
  function canonicalizeReportFormats(
    formats: ("json" | "csv" | "markdown" | "plots")[],
    plots?: boolean,
  ): ("json" | "csv" | "markdown" | "plots")[] {
    const unique = new Set(formats);
    if (plots) unique.add("plots");
    // Preserve a stable, predictable order regardless of input order.
    const order: ("json" | "csv" | "markdown" | "plots")[] = ["json", "csv", "markdown", "plots"];
    return order.filter((f) => unique.has(f));
  }

  async function opReportCampaign(
    campaignId: string,
    options: {
      outputDir: string;
      formats: ["json" | "csv" | "markdown" | "plots", ...("json" | "csv" | "markdown" | "plots")[]];
      groupBy?: string[];
      scalingX?: string;
      compare?: "classical_vs_quantum" | "qiskit_vs_cudaq" | "gpu_vs_cpu";
      plots?: boolean;
      overwrite?: boolean;
    },
  ) {
    const c = await cfg();
    const root = resolveReportOutputDir(c);
    const containedDir = await resolveContainedReportDir(root, options.outputDir);

    const formats = canonicalizeReportFormats(options.formats, options.plots);

    const argv = ["report", "campaign", campaignId, "--output-dir", containedDir, "--formats", formats.join(",")];
    if (options.groupBy !== undefined) {
      for (const key of options.groupBy) argv.push("--group-by", key);
    }
    if (options.scalingX !== undefined) argv.push("--scaling-x", options.scalingX);
    if (options.compare !== undefined) argv.push("--compare", options.compare);
    // `--plots` is conveyed only through the canonical formats list.
    if (options.overwrite) argv.push("--overwrite");

    const result = await runVariaqJson(c, argv, { timeoutMs: 60_000 });
    const envelope = requireSuccess(result, ["report", "campaign"]);
    const { data, warnings } = successData<ReportCampaignEnvelopeData>(envelope, "report campaign");
    return {
      reportId: data.report_id,
      paths: data.paths,
      outputDir: containedDir,
      warnings,
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
      {
        name: "campaign-plan",
        summary: "Preview a campaign without executing any solver runs",
        usage: "bb variaq campaign-plan <campaign-json-content> [--json]",
      },
      {
        name: "campaign-run",
        summary: "Execute a campaign: generates problems and runs all configured solvers",
        usage: "bb variaq campaign-run <campaign-json-content> [--max-runs N] [--override-max-runs] [--json]",
      },
      { name: "campaigns", summary: "List stored campaigns", usage: "bb variaq campaigns [--limit N] [--json]" },
      { name: "campaign", summary: "Show a stored campaign definition", usage: "bb variaq campaign <campaign-id> [--json]" },
      {
        name: "analyze-runs",
        summary: "Analyze a bounded set of stored experiment runs",
        usage: "bb variaq analyze-runs [--run-id ID ...] [--group-by KEY ...] [--filter KEY=VALUE ...] [--scaling-x METRIC] [--include-failed] [--include-unavailable] [--compare COMPARISON] [--json]",
      },
      {
        name: "analyze-campaign",
        summary: "Analyze all runs belonging to a campaign",
        usage: "bb variaq analyze-campaign <campaign-id> [--group-by KEY ...] [--scaling-x METRIC] [--include-failed] [--include-unavailable] [--compare COMPARISON] [--json]",
      },
      {
        name: "report-campaign",
        summary: "Generate JSON/CSV/Markdown (optionally plots) report files for a campaign",
        usage: "bb variaq report-campaign <campaign-id> --output-dir DIR --formats f1,f2 [--group-by KEY ...] [--scaling-x METRIC] [--plots] [--overwrite] [--json]",
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
          case "campaign-plan": {
            const content = requiredPositional(args, "campaign-json-content");
            const definition = parseCampaignJson(content);
            return opCampaignPlan(definition);
          }
          case "campaign-run": {
            const content = requiredPositional(args, "campaign-json-content");
            const definition = parseCampaignJson(content);
            const opts = readOptions(args);
            const maxRuns = optionalInt(opts, "max-runs", 500);
            const overrideMaxRuns = opts.has("override-max-runs");
            return opCampaignRun(definition, maxRuns, overrideMaxRuns);
          }
          case "campaigns": {
            const opts = readOptions(args);
            return opCampaignList(optionalInt(opts, "limit", 20));
          }
          case "campaign":
            return opCampaignShow(requiredPositional(args, "campaign-id"));
          case "analyze-runs": {
            const runIds = collectRepeated(args, "--run-id");
            const groupBy = collectRepeated(args, "--group-by");
            const filters = collectRepeated(args, "--filter").map((kv) => parseKeyValue(kv, "--filter"));
            const opts = readOptions(args);
            return opAnalyzeRuns({
              run_ids: runIds.length > 0 ? runIds : undefined,
              group_by: groupBy.length > 0 ? groupBy : undefined,
              filters: filters.length > 0 ? Object.fromEntries(filters) : undefined,
              scaling_x: opts.get("scaling-x"),
              include_failed: args.includes("--include-failed"),
              include_unavailable: args.includes("--include-unavailable"),
              compare: opts.get("compare") as import("./lib/schema.js").AnalyzeQuery["compare"],
            });
          }
          case "analyze-campaign": {
            const campaignId = requiredPositional(args, "campaign-id");
            const groupBy = collectRepeated(args, "--group-by");
            const opts = readOptions(args);
            return opAnalyzeCampaign(campaignId, {
              group_by: groupBy.length > 0 ? groupBy : undefined,
              scaling_x: opts.get("scaling-x"),
              include_failed: args.includes("--include-failed"),
              include_unavailable: args.includes("--include-unavailable"),
              compare: opts.get("compare") as import("./lib/schema.js").AnalyzeQuery["compare"],
            });
          }
          case "report-campaign": {
            const campaignId = requiredPositional(args, "campaign-id");
            const opts = readOptions(args);
            const outputDir = requiredOption(opts, "output-dir");
            const formats = requiredOption(opts, "formats").split(",").map((s) => s.trim()).filter(Boolean);
            const groupBy = collectRepeated(args, "--group-by");
            return opReportCampaign(campaignId, {
              outputDir,
              formats: formats as ["json" | "csv" | "markdown" | "plots", ...("json" | "csv" | "markdown" | "plots")[]],
              groupBy: groupBy.length > 0 ? groupBy : undefined,
              scalingX: opts.get("scaling-x"),
              compare: opts.get("compare") as "classical_vs_quantum" | "qiskit_vs_cudaq" | "gpu_vs_cpu" | undefined,
              plots: args.includes("--plots"),
              overwrite: args.includes("--overwrite"),
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
    name: "variaq_campaign_plan",
    description: "Plan a VariaQ campaign without executing any solver runs. Returns requested run counts, solver breakdown, and max-run warnings.",
    instructions: "Use variaq_campaign_plan to preview a campaign before running it. Campaign plan is non-executing and safe. If the plan warns about exceeding the default run maximum, decide whether to reduce the campaign or explicitly pass maxRuns + overrideMaxRuns to variaq_campaign_run.",
    parameters: campaignDefinitionSchema,
    async execute(definition) {
      try {
        const result = await opCampaignPlan(definition);
        return JSON.stringify(result, null, 2);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  bb.agents.registerTool({
    name: "variaq_campaign_run",
    description: "Execute a VariaQ campaign: generate problem instances and run the configured solvers. This can run many solver invocations.",
    instructions: "Use variaq_campaign_run after planning. Always prefer to call variaq_campaign_plan first. The tool respects VariaQ's max-run guard; campaigns that exceed the default maximum require an explicit maxRuns value and overrideMaxRuns=true. The plugin does not orchestrate solvers or bypass VariaQ's safety guard.",
    parameters: campaignDefinitionSchema.extend({
      maxRuns: z.number().int().min(1).max(10_000).optional().describe("Maximum runs allowed (default 500, matching VariaQ's safe default)"),
      overrideMaxRuns: z.boolean().optional().describe("Set true to allow running a campaign whose requested_runs exceed maxRuns"),
    }),
    async execute(definition) {
      try {
        const { maxRuns, overrideMaxRuns, ...campaign } = definition as CampaignDefinition & { maxRuns?: number; overrideMaxRuns?: boolean };
        const result = await opCampaignRun(campaign, maxRuns ?? 500, overrideMaxRuns ?? false);
        return JSON.stringify(result, null, 2);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  bb.agents.registerTool({
    name: "variaq_campaign_list",
    description: "List stored VariaQ campaigns (campaign_id, name, family, created_at).",
    instructions: "Use variaq_campaign_list to discover campaigns before analyzing or reporting on one.",
    parameters: z.object({
      limit: z.number().int().min(1).max(500).optional().describe("Max campaigns to return (default 20)"),
    }),
    async execute({ limit }) {
      try {
        const result = await opCampaignList(limit ?? 20);
        return JSON.stringify(result, null, 2);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  bb.agents.registerTool({
    name: "variaq_campaign_show",
    description: "Show a stored VariaQ campaign definition by id.",
    instructions: "Use variaq_campaign_show to inspect the full definition of a stored campaign before analyzing or reproducing it.",
    parameters: z.object({
      campaignId: z.string().min(1).describe("Campaign id"),
    }),
    async execute({ campaignId }) {
      try {
        const result = await opCampaignShow(campaignId);
        return JSON.stringify(result, null, 2);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  bb.agents.registerTool({
    name: "variaq_analyze_runs",
    description: "Analyze a bounded set of stored VariaQ experiment runs. Read-only; does not execute solvers or modify runs.",
    instructions: "Use variaq_analyze_runs to compute VariaQ-derived quality, feasibility, timing, resource, and scaling summaries over run IDs. Analysis is read-only and returns VariaQ's AnalysisResult directly.",
    parameters: analyzeQuerySchema.omit({ campaign_id: true }),
    async execute(query) {
      try {
        const result = await opAnalyzeRuns(query);
        return JSON.stringify(result, null, 2);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  bb.agents.registerTool({
    name: "variaq_analyze_campaign",
    description: "Analyze all runs belonging to a VariaQ campaign. Read-only; does not execute solvers or modify runs.",
    instructions: "Use variaq_analyze_campaign to compute VariaQ-derived quality, feasibility, timing, resource, and scaling summaries for a stored campaign. Analysis is read-only.",
    parameters: z.object({
      campaignId: z.string().min(1).describe("Campaign id"),
    }).merge(analyzeQuerySchema.omit({ campaign_id: true, run_ids: true })),
    async execute({ campaignId, ...query }) {
      try {
        const result = await opAnalyzeCampaign(campaignId, query);
        return JSON.stringify(result, null, 2);
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  bb.agents.registerTool({
    name: "variaq_report_campaign",
    description: "Generate JSON/CSV/Markdown (and optional plots) report files for a VariaQ campaign. This tool writes files under the configured report output directory.",
    instructions: "Use variaq_report_campaign to produce persistent report artifacts from a stored campaign. Reports derive from stored runs, preserve source_run_ids, and are written under the configured reportOutputDir. The outputDir argument is resolved relative to that root and cannot escape it.",
    parameters: z.object({
      campaignId: z.string().min(1).describe("Campaign id"),
      outputDir: z.string().min(1).describe("Relative output directory beneath the configured report output root"),
      formats: reportFormatsSchema.describe("Report formats, e.g. ['json', 'csv', 'markdown']"),
      groupBy: z.array(z.string()).max(8).optional().describe("Group-by keys"),
      scalingX: z.string().optional().describe("Scaling x-axis metric, e.g. problem_size"),
      compare: z.enum(["classical_vs_quantum", "qiskit_vs_cudaq", "gpu_vs_cpu"]).optional(),
      plots: z.boolean().optional().describe("Request matplotlib plots if available"),
      overwrite: z.boolean().optional(),
    }),
    async execute({ campaignId, outputDir, formats, groupBy, scalingX, compare, plots, overwrite }) {
      try {
        const result = await opReportCampaign(campaignId, {
          outputDir,
          formats: formats as ["json" | "csv" | "markdown" | "plots", ...("json" | "csv" | "markdown" | "plots")[]],
          groupBy,
          scalingX,
          compare,
          plots,
          overwrite,
        });
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
        // Boolean flag: store it with the empty string sentinel so it is still
        // discoverable via has().
        map.set(a.slice(2), "");
      } else {
        map.set(a.slice(2), next);
        i++;
      }
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

function parseCampaignJson(content: string): CampaignDefinition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new PluginError(
      "Campaign content is not valid JSON.",
      err instanceof Error ? err.message : String(err),
    );
  }
  const result = campaignDefinitionSchema.safeParse(parsed);
  if (!result.success) {
    throw new PluginError(
      `Invalid campaign definition: ${result.error.message}`,
      "Campaign must declare campaign_format_version '1', a valid family, problem_sizes, problem_seeds, and solvers.",
    );
  }
  return result.data;
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

  const warningLines = (...sources: unknown[]): string[] => {
    const messages = sources
      .flatMap((source) => Array.isArray(source) ? source : [])
      .map((warning) => {
        if (typeof warning === "string") return warning;
        if (typeof warning === "object" && warning !== null && "message" in warning) {
          return String((warning as { message: unknown }).message);
        }
        return JSON.stringify(warning);
      });
    return [...new Set(messages)].map((message) => `  warning: ${message}`);
  };

  if ("plan" in record && typeof record.plan === "object" && record.plan !== null) {
    const plan = record.plan as Record<string, unknown>;
    const solvers = (plan.solver_breakdown as Array<Record<string, unknown>> | undefined) ?? [];
    return [
      `Campaign plan: ${String(plan.name ?? "unnamed")}`,
      `  family: ${String(plan.family ?? "unknown")}`,
      `  requested runs: ${String(plan.requested_runs ?? "?")}`,
      `  problem instances: ${String(plan.problem_instance_count ?? "?")}`,
      `  exceeds default maximum: ${plan.exceeds_default_max === true ? "yes" : "no"}`,
      `  solvers: ${solvers.map((solver) => `${String(solver.solver)}=${String(solver.requested_runs)}`).join(", ") || "none"}`,
      ...warningLines(plan.warnings, record.warnings),
    ].join("\n");
  }

  if ("campaignId" in record && "summary" in record && typeof record.summary === "object" && record.summary !== null) {
    const summary = record.summary as Record<string, unknown>;
    const statuses = (summary.status_summary as Record<string, unknown> | undefined) ?? {};
    return [
      `Campaign run: ${String(record.campaignId)}`,
      `  name: ${String(summary.name ?? "unnamed")}`,
      `  family: ${String(summary.family ?? "unknown")}`,
      `  runs: ${String(summary.completed_runs ?? "?")}/${String(summary.requested_runs ?? "?")} completed`,
      `  success: ${String(statuses.success ?? 0)}, failed: ${String(statuses.failed ?? 0)}, skipped: ${String(statuses.skipped ?? 0)}, unavailable: ${String(statuses.unavailable ?? 0)}`,
      ...warningLines(record.warnings),
    ].join("\n");
  }

  if ("campaigns" in record && Array.isArray(record.campaigns)) {
    const campaigns = record.campaigns as Array<Record<string, unknown>>;
    return [
      `Campaigns: ${campaigns.length}`,
      ...campaigns.map((campaign) =>
        `  ${String(campaign.campaign_id)}  ${String(campaign.name)}  ${String(campaign.family)}  ${String(campaign.created_at)}`),
      ...warningLines(record.warnings),
    ].join("\n");
  }

  if ("campaign" in record && typeof record.campaign === "object" && record.campaign !== null) {
    const campaign = record.campaign as Record<string, unknown>;
    return [
      `Campaign: ${String(record.campaignId ?? "unknown")}`,
      `  name: ${String(campaign.name ?? "unnamed")}`,
      `  family: ${String(campaign.family ?? "unknown")}`,
      `  sizes: ${((campaign.problem_sizes as unknown[] | undefined) ?? []).join(", ")}`,
      `  seeds: ${((campaign.problem_seeds as unknown[] | undefined) ?? []).join(", ")}`,
      `  solvers: ${((campaign.solvers as unknown[] | undefined) ?? []).join(", ")}`,
      `  repeats: ${String(campaign.repeats ?? "?")}`,
      `  created: ${String(campaign.created_at ?? "unknown")}`,
      ...warningLines(record.warnings),
    ].join("\n");
  }

  if ("analysis" in record && typeof record.analysis === "object" && record.analysis !== null) {
    const analysis = record.analysis as Record<string, unknown>;
    const groups = (analysis.groups as Array<Record<string, unknown>> | undefined) ?? [];
    const sourceRunIds = (analysis.source_run_ids as unknown[] | undefined) ?? [];
    const scalingPoints = (analysis.scaling_points as unknown[] | undefined) ?? [];
    const lines = [
      "Analysis",
      `  source runs: ${sourceRunIds.length}`,
      `  groups: ${groups.length}`,
      `  scaling points: ${scalingPoints.length}`,
    ];
    for (const group of groups.slice(0, 8)) {
      const key = JSON.stringify(group.group_key ?? {});
      const quality = (group.quality as Record<string, unknown> | undefined) ?? {};
      const feasibility = (group.feasibility as Record<string, unknown> | undefined) ?? {};
      lines.push(
        `  ${key}: count=${String(group.count ?? "?")}, mean_objective=${String(quality.mean_objective ?? "null")}, feasible_runs=${String(feasibility.feasible_runs ?? "?")}`,
      );
    }
    if (groups.length > 8) lines.push(`  … ${groups.length - 8} more groups`);
    lines.push(...warningLines(analysis.warnings, record.warnings));
    return lines.join("\n");
  }

  if ("reportId" in record && "paths" in record) {
    const paths = record.paths as Record<string, unknown>;
    const files: string[] = [];
    for (const value of Object.values(paths)) {
      if (typeof value === "string") files.push(value);
      if (typeof value === "object" && value !== null) {
        files.push(...Object.values(value as Record<string, unknown>).filter((entry): entry is string => typeof entry === "string"));
      }
    }
    return [
      `Report: ${String(record.reportId)}`,
      `  generated files: ${files.length}`,
      ...files.map((file) => `  ${file}`),
      ...warningLines(record.warnings),
    ].join("\n");
  }

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
