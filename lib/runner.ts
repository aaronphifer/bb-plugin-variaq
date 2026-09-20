import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";

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

export const VERIFIED_VARIAQ_VERSION = "0.2.0";
export const SUPPORTED_VARIAQ_SERIES = "0.2.x";

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

/**
 * Run VariaQ and throw PluginError with the CLI's own error text on non-zero
 * exit. VariaQ 0.2.0 conventions (verified live):
 *   exit 0 success · exit 1 solver failure (run persisted) · exit 2 usage/lookup.
 */
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
 * Probe the resolved VariaQ environment for capability information without
 * running any circuit. Emits one JSON line from the probe script.
 */
export async function probeCapabilities(c: ResolvedConfig): Promise<Record<string, unknown>> {
  const script = [
    "import importlib.metadata, importlib.util, json, shutil, subprocess",
    "out = {}",
    'spec = importlib.util.find_spec("variaq")',
    "out['variaq_installed'] = spec is not None",
    "try:",
    "    out['variaq_version'] = importlib.metadata.version('variaq')",
    "except Exception:",
    "    out['variaq_version'] = None",
    'out["qiskit_installed"] = importlib.util.find_spec("qiskit") is not None',
    'out["cudaq_installed"] = importlib.util.find_spec("cudaq") is not None',
    "try:",
    "    import cudaq as _c",
    "    out['cudaq_version'] = importlib.metadata.version('cudaq')",
    "    out['qpp_cpu_target'] = bool(_c.has_target('qpp-cpu'))",
    "    out['nvidia_target'] = bool(_c.has_target('nvidia'))",
    "    out['gpu_count'] = int(_c.num_available_gpus())",
    "except Exception:",
    "    out['cudaq_version'] = None",
    "    out['qpp_cpu_target'] = False",
    "    out['nvidia_target'] = False",
    "    out['gpu_count'] = 0",
    "try:",
    "    smi = shutil.which('nvidia-smi')",
    "    out['nvidia_driver_usable'] = bool(smi) and subprocess.run([smi, '-L'], capture_output=True, timeout=5).returncode == 0",
    "except Exception:",
    "    out['nvidia_driver_usable'] = False",
    "print(json.dumps(out))",
  ].join("\n");
  const result = await runPython(c, script, { timeoutMs: 30_000 });
  if (result.timedOut) throw new PluginError("Capability probe timed out.");
  const line = result.stdout.trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new PluginError(
      "Could not read VariaQ capability probe output.",
      result.stderr.trim() || "The configured python may not have VariaQ installed correctly.",
    );
  }
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
}

/**
 * The 0.1.0 adapter is verified against VariaQ 0.2.0 and accepts harmless
 * patch updates in the 0.2 series. Other CLI grammars are reported, not
 * blocked, so status/version still help diagnose a mismatched environment.
 */
export function checkVariaqVersion(raw: string | null): VariaqVersionCompatibility {
  const match = raw?.match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\b|$)/);
  const version = match ? `${match[1]}.${match[2]}.${match[3]}` : null;
  const supported = match?.[1] === "0" && match?.[2] === "2";
  return {
    version,
    supported,
    supportedSeries: SUPPORTED_VARIAQ_SERIES,
    verifiedVersion: VERIFIED_VARIAQ_VERSION,
    warning: supported
      ? null
      : `Unsupported VariaQ version ${version ?? "unknown"}; bb-plugin-variaq 0.1.0 is verified with ${VERIFIED_VARIAQ_VERSION} and supports ${SUPPORTED_VARIAQ_SERIES}.`,
  };
}

/** Extract all stable `run-<uuid>` tokens, independent of surrounding prose. */
export function extractRunIds(stdout: string): string[] {
  const matches = stdout.match(
    /\brun-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  );
  return [...new Set(matches ?? [])];
}

/** Extract the first `run-<uuid>` token from VariaQ table output. */
export function extractRunId(stdout: string): string | null {
  return extractRunIds(stdout)[0] ?? null;
}

/** Extract `Saved <problem-id>` from `variaq problem generate` output. */
export function extractSavedProblemId(stdout: string): string | null {
  const match = stdout.match(/^Saved\s+(\S+)\s+to\s+/m);
  return match?.[1] ?? null;
}
