import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import {
  BB_PLUGIN_VARIAQ_VERSION,
  type EnvelopeStatus,
  type ParsedEnvelope,
  type ProblemFamily,
  type StructuredError,
  type StructuredWarning,
  SUPPORTED_SCHEMA_VERSION,
  SUPPORTED_VARIAQ_SERIES,
  VERIFIED_VARIAQ_VERSION,
  isProblemFamily,
  validateEnvelope,
} from "./schema.js";

/**
 * Configuration for reaching the standalone VariaQ install.
 * Empty strings mean "not configured — auto-discover".
 */
export interface VariaqSettings {
  pythonPath: string;
  projectDir: string;
  dbPath: string;
  problemsDir: string;
  timeoutMs: number;
}

export const VARIAQ_SOLVERS = [
  "exact",
  "heuristic",
  "qaoa",
  "cudaq-cpu",
  "cudaq-gpu",
] as const;

export type VariaqSolver = (typeof VARIAQ_SOLVERS)[number];

export interface ProblemGenerateInput {
  family: ProblemFamily;
  seed: number;
  output?: string;
}

export interface MaxCutGenerateInput extends ProblemGenerateInput {
  family: "maxcut";
  nodes: number;
  edgeProbability: number;
}

export interface AssignmentGenerateInput extends ProblemGenerateInput {
  family: "assignment";
  taskCount: number;
  resourceCount: number;
}

export interface SubsetSelectionGenerateInput extends ProblemGenerateInput {
  family: "subset-selection";
  candidateCount: number;
}

export interface GraphPartitionGenerateInput extends ProblemGenerateInput {
  family: "graph-partition";
  nodes: number;
  edgeProbability: number;
  partitionCount: number;
}

export type FamilyGenerateInput =
  | MaxCutGenerateInput
  | AssignmentGenerateInput
  | SubsetSelectionGenerateInput
  | GraphPartitionGenerateInput;

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export class PluginError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
    readonly exitCode?: number,
  ) {
    super(message);
    this.name = "PluginError";
  }
}

/** Distinguishes how the plugin located a usable VariaQ install. */
export type ResolvedSource =
  | "configured-python"   // explicit pythonPath setting won
  | "configured-project"  // projectDir's own .venv won
  | "discovered";         // found by scanning well-known locations

export interface ResolvedConfig {
  pythonPath: string;
  projectDir: string;
  dbPath: string | null;       // null → let VariaQ use its built-in default
  problemsDir: string | null;  // null → let VariaQ use its built-in default
  timeoutMs: number;
  source: ResolvedSource;
}

const OUTPUT_CAP_BYTES = 900_000; // below PLUGIN_CLI_OUTPUT_MAX_BYTES (1 MiB)

// Well-known locations probed, in order, when the user has not configured
// anything. The first VariaQ checkout with a usable venv wins.
const DISCOVERY_CANDIDATES = [
  "quantum-lab/variaq",
  "variaq",
  "quantum-lab/q-lab",
];

function cap(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= OUTPUT_CAP_BYTES) return text;
  const truncated = Buffer.from(text, "utf8").subarray(0, OUTPUT_CAP_BYTES);
  return `${truncated.toString("utf8")}\n[truncated: output exceeded ${OUTPUT_CAP_BYTES} bytes]`;
}

/** Split a comma-separated solver list, validating each entry. */
export function parseSolvers(raw: string): VariaqSolver[] {
  const solvers = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (solvers.length === 0) {
    throw new PluginError("Empty solver list.", "Use e.g. --solvers exact,heuristic,qaoa");
  }
  for (const s of solvers) {
    if (!VARIAQ_SOLVERS.includes(s as VariaqSolver)) {
      throw new PluginError(
        `Unknown solver: ${s}`,
        `Available solvers: ${VARIAQ_SOLVERS.join(", ")}`,
      );
    }
  }
  return solvers as VariaqSolver[];
}

/** Validate a KEY=VALUE list element, returning [key, value]. */
export function parseKeyValue(raw: string, optionName: string): [string, string] {
  const eq = raw.indexOf("=");
  if (eq <= 0) {
    throw new PluginError(
      `Invalid ${optionName} value: ${raw}`,
      `Expected KEY=VALUE, e.g. --param restarts=16`,
    );
  }
  return [raw.slice(0, eq), raw.slice(eq + 1)];
}

function isExecutable(filePath: string): boolean {
  if (filePath.length === 0) return false;
  try {
    accessSync(filePath, constants.X_OK);
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function venvPython(projectDir: string): string | null {
  if (!projectDir) return null;
  const candidate = resolve(projectDir, ".venv", "bin", "python");
  return isExecutable(candidate) ? candidate : null;
}

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "";
}

function isDirectory(directory: string): boolean {
  try {
    return statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function configuredPath(raw: string, setting: string): string {
  const trimmed = raw.trim();
  const value = trimmed === "/" ? trimmed : trimmed.replace(/\/+$/, "");
  if (value === "") return "";
  if (value.includes("\0") || !isAbsolute(value)) {
    throw new PluginError(
      `Configured variaq.${setting} must be an absolute path.`,
      `Set variaq.${setting} to an absolute local filesystem path, or clear it to use VariaQ's default.`,
    );
  }
  return value;
}

/** Infer <checkout> from <checkout>/.venv/bin/python when possible. */
function projectFromVenvPython(pythonPath: string): string | null {
  const venvDir = dirname(dirname(pythonPath));
  if (basename(venvDir) !== ".venv") return null;
  const projectDir = dirname(venvDir);
  return isDirectory(projectDir) ? projectDir : null;
}

/**
 * Resolve the effective VariaQ configuration. Precedence:
 *  1. configured pythonPath        → configured-python
 *  2. configured projectDir (.venv)→ configured-project
 *  3. ~/ well-known scan           → discovered
 * Throws PluginError when nothing usable can be found.
 */
export function resolveConfig(raw: VariaqSettings): Omit<ResolvedConfig, never> {
  const timeoutMs = raw.timeoutMs;
  const pythonPath = configuredPath(raw.pythonPath, "pythonPath");
  const projectDir = configuredPath(raw.projectDir, "projectDir");
  const dbPath = configuredPath(raw.dbPath, "dbPath");
  const problemsDir = configuredPath(raw.problemsDir, "problemsDir");

  let resolvedPython = "";
  let resolvedProjectDir = "";
  let source: ResolvedSource;

  if (pythonPath) {
    if (!isExecutable(pythonPath)) {
      throw new PluginError(
        `Configured variaq.pythonPath does not exist or is not executable: ${pythonPath}`,
        "Point it at a Python interpreter with VariaQ installed (e.g. <checkout>/.venv/bin/python), or clear it to use auto-discovery.",
      );
    }
    resolvedPython = pythonPath;
    if (projectDir) {
      if (!isDirectory(projectDir)) {
        throw new PluginError(
          `Configured variaq.projectDir is not a directory: ${projectDir}`,
          "Point it at the standalone VariaQ checkout, or clear it when pythonPath is under <checkout>/.venv/bin/python.",
        );
      }
      resolvedProjectDir = projectDir;
    } else {
      const inferred = projectFromVenvPython(pythonPath);
      if (inferred === null) {
        throw new PluginError(
          "variaq.projectDir is required when pythonPath is not under <checkout>/.venv/bin/python.",
          "Set it with: bb plugin config variaq set projectDir <VariaQ-checkout>",
        );
      }
      resolvedProjectDir = inferred;
    }
    source = "configured-python";
  } else if (projectDir) {
    const vp = venvPython(projectDir);
    if (vp === null) {
      throw new PluginError(
        `Configured variaq.projectDir has no usable interpreter at ${projectDir}/.venv/bin/python`,
        "Create the venv and install VariaQ with: pip install -e \".[dev,quantum]\" inside the VariaQ checkout, or set variaq.pythonPath explicitly.",
      );
    }
    resolvedPython = vp;
    resolvedProjectDir = projectDir;
    source = "configured-project";
  } else {
    const home = homeDir();
    let found: { python: string; project: string } | null = null;
    for (const rel of DISCOVERY_CANDIDATES) {
      const project = resolve(home, rel);
      const vp = venvPython(project);
      if (vp !== null) {
        found = { python: vp, project };
        break;
      }
    }
    if (found === null) {
      throw new PluginError(
        "Could not locate a VariaQ installation.",
        "Set variaq.pythonPath to a Python interpreter with VariaQ installed (bb plugin config variaq set pythonPath <path>), or set variaq.projectDir to the VariaQ checkout.",
      );
    }
    resolvedPython = found.python;
    resolvedProjectDir = found.project;
    source = "discovered";
  }

  return {
    pythonPath: resolvedPython,
    projectDir: resolvedProjectDir,
    dbPath: dbPath === "" ? null : dbPath,
    problemsDir: problemsDir === "" ? null : problemsDir,
    timeoutMs,
    source,
  };
}

/** Build the base argv: global flags (which must precede the subcommand) only when configured. */
export function baseArgv(c: ResolvedConfig): string[] {
  const argv = ["-m", "variaq"];
  if (c.dbPath !== null) argv.push("--db", c.dbPath);
  if (c.problemsDir !== null) argv.push("--problems-dir", c.problemsDir);
  return argv;
}

/**
 * Run the VariaQ CLI. Global flags (--db, --problems-dir) precede the
 * subcommand when configured. Never uses a shell — args go verbatim to execve.
 */
export async function runVariaq(
  c: ResolvedConfig,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<CommandResult> {
  const argv = [...baseArgv(c), ...args];
  const timeoutMs = opts.timeoutMs ?? c.timeoutMs;

  return await new Promise<CommandResult>((resolvePromise, reject) => {
    let child;
    try {
      child = spawn(c.pythonPath, argv, {
        cwd: c.projectDir,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      reject(
        new PluginError(
          `Failed to start python: ${err instanceof Error ? err.message : String(err)}`,
          "Check the variaq.pythonPath plugin setting.",
        ),
      );
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }, 3000).unref();
      resolvePromise({
        code: -1,
        stdout: cap(Buffer.concat(stdoutChunks).toString("utf8")),
        stderr: cap(Buffer.concat(stderrChunks).toString("utf8")),
        timedOut: true,
      });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new PluginError(
          `Failed to execute ${c.pythonPath}: ${err.message}`,
          "Check the variaq.pythonPath plugin setting — it must point at a Python 3.12 interpreter with VariaQ installed.",
        ),
      );
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        code: code ?? -1,
        stdout: cap(Buffer.concat(stdoutChunks).toString("utf8")),
        stderr: cap(Buffer.concat(stderrChunks).toString("utf8")),
        timedOut: false,
      });
    });
  });
}

export interface JsonResult {
  envelope: ParsedEnvelope;
  code: number;
  timedOut: boolean;
}

/**
 * Run VariaQ expecting a schema-v1 JSON envelope on stdout.
 *
 * - On timeout: throws PluginError.
 * - On invalid/unsupported schema: throws PluginError.
 * - On non-zero exit: returns a JsonResult instead of throwing so callers can
 *   preserve VariaQ's structured failure (run id, status, warnings, error).
 */
export async function runVariaqJson(
  c: ResolvedConfig,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<JsonResult> {
  const jsonArgs = [...args, "--json"];
  const result = await runVariaq(c, jsonArgs, opts);

  if (result.timedOut) {
    throw new PluginError(
      `VariaQ timed out after ${Math.round((opts.timeoutMs ?? c.timeoutMs) / 1000)}s.`,
      "Increase the variaq.timeoutMs plugin setting or use a smaller problem.",
    );
  }

  let envelope: ParsedEnvelope;
  try {
    envelope = validateEnvelope(result.stdout);
  } catch (err) {
    throw new PluginError(
      `VariaQ structured output error: ${err instanceof Error ? err.message : String(err)}`,
      `Command: variaq ${args.join(" ")} --json. Exit code: ${result.code}. ` +
        `stderr: ${result.stderr.trim() || "(empty)"}`,
      result.code,
    );
  }

  return { envelope, code: result.code, timedOut: false };
}

/**
 * Throw a PluginError for a non-zero JsonResult.
 * Callers that want to preserve structured failures should inspect the result
 * directly instead of calling this helper.
 */
export function requireSuccess(result: JsonResult, args: string[]): ParsedEnvelope {
  if (result.code !== 0) {
    const { envelope, code } = result;
    const errorDetail = envelope.error
      ? `${envelope.error.type}: ${envelope.error.message}`
      : `exit code ${code}`;
    throw new PluginError(
      `variaq ${args.join(" ")} failed: ${errorDetail}`,
      envelope.error?.run_id !== undefined
        ? `Run id: ${envelope.error.run_id}`
        : undefined,
      code,
    );
  }
  return result.envelope;
}

/** Legacy wrapper used only by --version, which VariaQ does not emit as JSON. */
export async function runVariaqStrict(
  c: ResolvedConfig,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<CommandResult> {
  const result = await runVariaq(c, args, opts);
  if (result.timedOut) {
    throw new PluginError(
      `VariaQ timed out after ${Math.round((opts.timeoutMs ?? c.timeoutMs) / 1000)}s.`,
      "Increase the variaq.timeoutMs plugin setting or use a smaller problem.",
    );
  }
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
    throw new PluginError(`variaq ${args.join(" ")} failed: ${detail}`, undefined, result.code);
  }
  return result;
}

/**
 * Build an integration error describing malformed/unsupported JSON output.
 * Public so tests can assert the exact shape.
 */
export function integrationError(
  command: string,
  exitCode: number,
  stdout: string,
  stderr: string,
  cause: string,
): PluginError {
  return new PluginError(
    `VariaQ structured output error: ${cause}`,
    `Command: variaq ${command} --json. Exit code: ${exitCode}. ` +
      `stdout (first 800 chars): ${stdout.slice(0, 800)}. ` +
      `stderr (first 800 chars): ${stderr.slice(0, 800)}.`,
    exitCode,
  );
}

/** Run a short Python snippet inside the VariaQ environment. */
export async function runPython(
  c: ResolvedConfig,
  code: string,
  opts: { timeoutMs?: number } = {},
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolvePromise, reject) => {
    let child;
    try {
      child = spawn(c.pythonPath, ["-c", code], {
        cwd: c.projectDir,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      reject(new PluginError(`Failed to start python: ${String(err)}`));
      return;
    }
    const out: Buffer[] = [];
    const errB: Buffer[] = [];
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolvePromise({ code: -1, stdout: "", stderr: "timeout", timedOut: true });
    }, opts.timeoutMs ?? 30_000);
    child.stdout?.on("data", (b: Buffer) => out.push(b));
    child.stderr?.on("data", (b: Buffer) => errB.push(b));
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      reject(new PluginError(`Failed to execute python: ${e.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolvePromise({
        code: code ?? -1,
        stdout: cap(Buffer.concat(out).toString("utf8")),
        stderr: cap(Buffer.concat(errB).toString("utf8")),
        timedOut: false,
      });
    });
  });
}

/**
 * VariaQ 0.5.x capabilities --json data shape. We only model the pieces the
 * plugin reads; everything else is forwarded as unknown. Quantum solver
 * supported families are reported dynamically by VariaQ and must not be
 * hardcoded in the plugin.
 */
export interface CapabilitiesData {
  variaq: {
    version: string;
    output_schema_version: string;
    python_version?: string;
    python_implementation?: string;
  };
  problem_families?: Array<{ name: string; supported?: boolean }>;
  solvers?: Array<{
    name: string;
    supported?: boolean;
    installed?: boolean;
    available?: boolean;
    reason?: string | null;
    supported_families?: string[];
  }>;
  frameworks?: Array<{
    name: string;
    version?: string | null;
    installed?: boolean;
    targets?: Record<string, unknown>;
  }>;
  solver_supported_families?: Record<string, string[]>;
  physical_qpu?: {
    supported?: boolean;
    installed?: boolean;
    available?: boolean;
    reason?: string;
  };
  warnings?: unknown[];
}

/**
 * Fetch VariaQ's own capabilities via `variaq capabilities --json`.
 * This is the authoritative source of solver/framework availability.
 */
export async function probeCapabilities(c: ResolvedConfig): Promise<CapabilitiesData> {
  const result = await runVariaqJson(c, ["capabilities"], { timeoutMs: 30_000 });
  const envelope = requireSuccess(result, ["capabilities"]);
  if (envelope.status !== "success" || typeof envelope.data !== "object" || envelope.data === null) {
    throw new PluginError(
      "VariaQ capabilities returned an invalid result.",
      `status=${envelope.status}; data=${JSON.stringify(envelope.data).slice(0, 200)}`,
    );
  }
  return envelope.data as CapabilitiesData;
}

/** Parse stdout as JSON with a PluginError on malformed output. */
export function parseJsonOutput<T>(raw: string, what: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new PluginError(
      `VariaQ returned malformed JSON for ${what}.`,
      "This is a VariaQ/plugin contract drift — re-inspect the CLI output contract.",
    );
  }
}

export interface VariaqVersionCompatibility {
  version: string | null;
  supported: boolean;
  supportedSeries: typeof SUPPORTED_VARIAQ_SERIES;
  verifiedVersion: typeof VERIFIED_VARIAQ_VERSION;
  warning: string | null;
  schemaVersion?: string;
  schemaVersionSupported: boolean;
}

/**
 * bb-plugin-variaq 0.4.0 is verified against VariaQ 0.5.0 / schema_version 1.
 * Patch releases in the 0.5 series are accepted. Other series are reported as
 * unsupported so users can still inspect a mismatched environment.
 */
export function checkVariaqVersion(raw: string | null, schemaVersion?: string): VariaqVersionCompatibility {
  const match = raw?.match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\b|$)/);
  const version = match ? `${match[1]}.${match[2]}.${match[3]}` : null;
  const supported = match?.[1] === "0" && match?.[2] === "5";
  const schemaVersionSupported = schemaVersion === undefined || schemaVersion === SUPPORTED_SCHEMA_VERSION;

  const parts: string[] = [];
  if (!supported) {
    parts.push(
      `Unsupported VariaQ version ${version ?? "unknown"}; bb-plugin-variaq ${BB_PLUGIN_VARIAQ_VERSION} is verified with VariaQ ${VERIFIED_VARIAQ_VERSION} and supports ${SUPPORTED_VARIAQ_SERIES}.`,
    );
  }
  if (!schemaVersionSupported) {
    parts.push(
      `Unsupported VariaQ output schema_version ${schemaVersion}; this plugin supports schema_version ${SUPPORTED_SCHEMA_VERSION}.`,
    );
  }

  return {
    version,
    supported,
    supportedSeries: SUPPORTED_VARIAQ_SERIES,
    verifiedVersion: VERIFIED_VARIAQ_VERSION,
    warning: parts.length > 0 ? parts.join(" ") : null,
    schemaVersion,
    schemaVersionSupported,
  };
}

/**
 * Map a solver capability entry to a simple "available" / "unavailable" status.
 * A solver is available only when VariaQ says it is supported, installed,
 * and available on this host.
 */
function solverAvailability(
  solver: NonNullable<CapabilitiesData["solvers"]>[number],
): "available" | "unavailable" {
  if (solver.supported && solver.installed && solver.available) return "available";
  return "unavailable";
}

/**
 * Combine VariaQ's authoritative capabilities with plugin-side resolved
 * configuration into the status tool result.
 */
export async function statusFromCapabilities(
  c: ResolvedConfig,
  cap: CapabilitiesData,
): Promise<Record<string, unknown>> {
  const version = cap.variaq?.version ?? null;
  const schemaVersion = cap.variaq?.output_schema_version;
  const compatibility = checkVariaqVersion(version, schemaVersion);

  const solverMap = new Map(
    (cap.solvers ?? []).map((s) => [s.name, solverAvailability(s)] as const),
  );
  const solverSupportedFamilies = new Map(
    (cap.solvers ?? []).map((s) => [s.name, s.supported_families ?? []] as const),
  );
  const solvers: Record<string, "available" | "unavailable"> = {
    exact: solverMap.get("exact") ?? "unavailable",
    heuristic: solverMap.get("heuristic") ?? "unavailable",
    qaoa: solverMap.get("qaoa") ?? "unavailable",
    "cudaq-cpu": solverMap.get("cudaq-cpu") ?? "unavailable",
    "cudaq-gpu": solverMap.get("cudaq-gpu") ?? "unavailable",
  };
  const families = (cap.problem_families ?? []).map((f) => f.name).filter(isProblemFamily) as ProblemFamily[];

  const qiskit = (cap.frameworks ?? []).find((f) => f.name === "qiskit");
  const cudaq = (cap.frameworks ?? []).find((f) => f.name === "cudaq");
  const cudaqTargets = cudaq?.targets ?? {};
  const qpp = cudaqTargets["qpp_cpu"] as { available?: boolean } | undefined;
  const nvidia = cudaqTargets["nvidia"] as { available?: boolean; gpu_count?: number | null } | undefined;

  return {
    variaq: {
      installed: version !== null && cap.variaq?.version !== undefined,
      version,
      schema_version: schemaVersion ?? null,
      python: c.pythonPath,
      projectDir: c.projectDir,
      resolvedFrom: c.source,
      compatibility,
    },
    solvers,
    solver_supported_families: Object.fromEntries(solverSupportedFamilies),
    problem_families: families,
    frameworks: {
      qiskit: {
        installed: qiskit?.installed ?? false,
        version: qiskit?.version ?? null,
      },
      cudaq: {
        installed: cudaq?.installed ?? false,
        version: cudaq?.version ?? null,
        qpp_cpu_available: qpp?.available ?? false,
        nvidia_available: nvidia?.available ?? false,
        gpu_count: nvidia?.gpu_count ?? 0,
      },
    },
    physical_qpu: {
      supported: cap.physical_qpu?.supported ?? false,
      installed: cap.physical_qpu?.installed ?? false,
      available: cap.physical_qpu?.available ?? false,
      reason: cap.physical_qpu?.reason ?? null,
    },
    store: {
      dbPath: c.dbPath ?? "<variaq default: data/variaq.sqlite3>",
      problemsDir: c.problemsDir ?? "<variaq default: data/problems>",
    },
    warnings: cap.warnings ?? [],
  };
}

/**
 * Build a human-readable note about quantum support for a problem family from
 * the live capabilities. Used by compare-quantum and CLI formatting; it never
 * hardcodes family names.
 */
export function quantumSupportNote(
  family: ProblemFamily,
  solverSupportedFamilies: Record<string, string[]>,
): string {
  const quantumSolvers = ["qaoa", "cudaq-cpu", "cudaq-gpu"] as const;
  const supported = quantumSolvers.filter((s) => solverSupportsFamily(s, family, solverSupportedFamilies));
  if (supported.length === 0) {
    return `Quantum solver support for '${family}' is not advertised by this VariaQ release.`;
  }
  return `Quantum solvers available for '${family}': ${supported.join(", ")}.`;
}

/**
 * Extract data from a schema-v1 envelope, preserving status, warnings and error.
 * On a non-success status the result still includes `data` and `error` so callers
 * can choose whether to surface VariaQ's structured failure as an error.
 */
export function unwrapEnvelope<T = unknown>(
  envelope: ParsedEnvelope,
  command: string,
): {
  status: EnvelopeStatus;
  data: T;
  error: StructuredError | undefined;
  warnings: StructuredWarning[];
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

export interface SolveEnvelopeData {
  run_id: string;
  problem_id: string;
  problem_type: string;
  solver: string;
  backend: string;
  backend_type: string;
  status: string;
  solution: number[] | null;
  objective: number | null;
  best_known_objective: number | null;
  best_known_source: string | null;
  optimality_gap_percent: number | null;
  approximation_ratio: number | null;
  feasible: boolean | null;
  feasible_sample_count: number | null;
  infeasible_sample_count: number | null;
  constraint_violations: unknown[];
  wall_time_seconds: number | null;
  solver_time_seconds: number | null;
  seed: number;
  parameters: Record<string, unknown>;
  qaoa_depth: number | null;
  shots: number | null;
  optimizer_trials: number | null;
  candidate_parameter_digest: string | null;
  selected_parameter_index: number | null;
  selected_parameters: unknown;
  expectation: number | null;
  lowered_energy: number | null;
  qubit_count: number | null;
  binary_variable_count: number | null;
  logical_variable_count: number | null;
  auxiliary_variable_count: number | null;
  circuit_depth: number | null;
  gate_count: number | null;
  logical_gate_count: number | null;
  backend_metadata: Record<string, unknown>;
  environment: Record<string, unknown>;
  created_at: string;
  // Optional BQM / penalty metadata; preserve when present.
  bqm?: {
    digest?: string;
    variable_count?: number;
    linear_term_count?: number;
    quadratic_term_count?: number;
  };
  penalties?: Array<{
    name?: string;
    weight?: number;
    violated?: boolean;
    contribution?: number;
  }>;
  precision?: string;
  timing?: Record<string, number | null>;
}

export interface BenchmarkEnvelopeData {
  problem: Record<string, unknown>;
  runs: SolveEnvelopeData[];
  comparison: {
    aggregate_status: string;
    best_known_objective: number | null;
    best_known_source: string | null;
    solver_count: number;
    successful_count: number;
    failed_count: number;
    unavailable_count: number;
  };
}

export interface CompareQuantumEnvelopeData extends BenchmarkEnvelopeData {
  comparison: BenchmarkEnvelopeData["comparison"] & {
    matched_qaoa: boolean;
    qaoa_depth_p: number | null;
    optimizer_trials: number | null;
    shots: number | null;
    seed: number | null;
    candidate_parameter_digest: string | null;
    identical_candidate_parameters: boolean;
    max_expectation_delta: number;
    best_parameter_indices: Record<string, number | null>;
    precision: Record<string, string>;
    backend_target: Record<string, string>;
    unavailable: Array<{ solver: string; reason: string }>;
  };
}

export interface ReproduceEnvelopeData {
  original_run_id: string;
  new_run_id: string;
  rerun_of: string;
  lineage: string;
  original: {
    run_id: string;
    solver: string;
    problem_id: string;
    seed: number;
    parameters: Record<string, unknown>;
    environment: Record<string, unknown>;
    result: { status: string; objective: number | null; backend: string };
  };
  new: {
    run_id: string;
    solver: string;
    problem_id: string;
    seed: number;
    parameters: Record<string, unknown>;
    environment: Record<string, unknown>;
    result: SolveEnvelopeData;
  };
  environment_differences: Record<string, { original: unknown; new: unknown }>;
}


/** Build argv for `variaq problem generate` from a family-aware input. */
export function generateProblemArgv(input: FamilyGenerateInput): string[] {
  const argv: string[] = ["problem", "generate", input.family, "--seed", String(input.seed)];
  if (input.output !== undefined) argv.push("--output", input.output);
  switch (input.family) {
    case "maxcut":
      argv.push("--nodes", String(input.nodes), "--edge-probability", String(input.edgeProbability));
      return argv;
    case "assignment":
      argv.push("--task-count", String(input.taskCount), "--resource-count", String(input.resourceCount));
      return argv;
    case "subset-selection":
      argv.push("--candidate-count", String(input.candidateCount));
      return argv;
    case "graph-partition":
      argv.push(
        "--nodes", String(input.nodes),
        "--edge-probability", String(input.edgeProbability),
        "--partition-count", String(input.partitionCount),
      );
      return argv;
  }
}

/** Return true when VariaQ capabilities list the solver as supporting the family. */
export function solverSupportsFamily(
  solver: VariaqSolver,
  family: ProblemFamily,
  supportedFamilies: Record<string, string[]>,
): boolean {
  const families = supportedFamilies[solver];
  if (!Array.isArray(families)) return false;
  return families.includes(family);
}

export interface ProblemGenerateData {
  problem_id: string;
  problem_type: string;
  family: ProblemFamily;
  seed: number;
  path: string;
  node_count?: number;
  edge_count?: number;
  task_count?: number;
  resource_count?: number;
  candidate_count?: number;
  partition_count?: number;
}

/** Extract the data payload from a successful envelope, preserving warnings. */
export function successData<T>(
  envelope: ParsedEnvelope,
  command: string,
): { data: T; warnings: StructuredWarning[] } {
  const unwrapped = unwrapEnvelope<T>(envelope, command);
  return { data: unwrapped.data, warnings: unwrapped.warnings };
}

/** Bound a string excerpt for error messages. */
export function excerpt(text: string, max = 800): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}... [truncated ${text.length - max} chars]`;
}

export function exitCodeFromEnvelope(envelope: ParsedEnvelope, processCode: number): number {
  if (processCode !== 0) return processCode;
  if (envelope.status === "error") return 1;
  return 0;
}

/** Re-export schema constants for convenience. */
export { SUPPORTED_SCHEMA_VERSION, SUPPORTED_VARIAQ_SERIES, VERIFIED_VARIAQ_VERSION };
