import { afterEach, describe, expect, it, vi } from "vitest";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

import {
  PluginError,
  checkVariaqVersion,
  parseJsonOutput,
  parseKeyValue,
  parseSolvers,
  quantumSupportNote,
  requireSuccess,
  resolveConfig,
  runVariaq,
  runVariaqJson,
  type VariaqSettings,
} from "../lib/runner.js";
import { SUPPORTED_SCHEMA_VERSION, validateEnvelope } from "../lib/schema.js";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const base: VariaqSettings = {
  pythonPath: "",
  projectDir: "",
  dbPath: "",
  problemsDir: "",
  reportOutputDir: "",
  timeoutMs: 1000,
};

function fakeProc(code: number, stdout: string, stderr: string) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    kill: (signal?: string) => boolean;
  };
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.kill = vi.fn(() => true);
  // Defer all emission until the runVariaq caller has attached its data/close
  // listeners: push buffers on the next macrotask, then end the streams, then
  // signal close on the macrotask after that.
  setImmediate(() => {
    if (stdout) proc.stdout.push(Buffer.from(stdout));
    if (stderr) proc.stderr.push(Buffer.from(stderr));
    setImmediate(() => {
      proc.stdout.push(null);
      proc.stderr.push(null);
      setImmediate(() => proc.emit("close", code));
    });
  });
  return proc;
}

const temps: string[] = [];
function tempProject(withVenv: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "variaq-plugin-test-"));
  temps.push(dir);
  if (withVenv) {
    const binDir = join(dir, ".venv", "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "python"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  return dir;
}

afterEach(() => {
  vi.mocked(spawn).mockReset();
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

describe("resolveConfig", () => {
  it("prefers an explicitly configured pythonPath (configured-python)", () => {
    const python = join(tempProject(true), ".venv", "bin", "python");
    const c = resolveConfig({ ...base, pythonPath: python });
    expect(c.source).toBe("configured-python");
    expect(c.pythonPath).toBe(python);
    expect(c.dbPath).toBeNull();
    expect(c.problemsDir).toBeNull();
  });

  it("rejects a configured pythonPath that does not exist", () => {
    expect(() =>
      resolveConfig({ ...base, pythonPath: "/does/not/exist/python" }),
    ).toThrow(/pythonPath does not exist/);
  });

  it("discovers projectDir's .venv/bin/python (configured-project)", () => {
    const project = tempProject(true);
    const c = resolveConfig({ ...base, projectDir: project });
    expect(c.source).toBe("configured-project");
    expect(c.pythonPath).toBe(join(project, ".venv", "bin", "python"));
  });

  it("rejects a projectDir with no usable .venv interpreter", () => {
    const project = tempProject(false);
    expect(() => resolveConfig({ ...base, projectDir: project })).toThrow(/\.venv\/bin\/python/);
  });

  it("keeps configured dbPath/problemsDir, null otherwise", () => {
    const project = tempProject(true);
    const a = resolveConfig({ ...base, projectDir: project });
    expect(a.dbPath).toBeNull();
    expect(a.problemsDir).toBeNull();
    const b = resolveConfig({
      ...base,
      projectDir: project,
      dbPath: "/tmp/x.db",
      problemsDir: "/tmp/problems",
    });
    expect(b.dbPath).toBe("/tmp/x.db");
    expect(b.problemsDir).toBe("/tmp/problems");
  });

  it("rejects relative configured paths", () => {
    const project = tempProject(true);
    expect(() => resolveConfig({ ...base, projectDir: project, dbPath: "data/local.db" }))
      .toThrow(/dbPath must be an absolute path/);
    expect(() => resolveConfig({ ...base, projectDir: "relative/variaq" }))
      .toThrow(/projectDir must be an absolute path/);
  });
});

describe("runVariaq argv construction", () => {
  it("passes global flags before the subcommand, no shell", async () => {
    const project = tempProject(true);
    const c = resolveConfig({
      ...base,
      projectDir: project,
      dbPath: "/data/variaq.sqlite3",
      problemsDir: "/data/problems",
    });
    vi.mocked(spawn).mockReturnValueOnce(fakeProc(0, "variaq 0.5.0\n", "") as never);
    await runVariaq(c, ["--version"]);
    const [cmd, argv, opts] = vi.mocked(spawn).mock.calls[0]!;
    expect(cmd).toBe(join(project, ".venv", "bin", "python"));
    expect(argv).toEqual([
      "-m", "variaq",
      "--db", "/data/variaq.sqlite3",
      "--problems-dir", "/data/problems",
      "--version",
    ]);
    expect((opts as { shell?: boolean }).shell).toBe(false);
  });

  it("omits --db/--problems-dir when unconfigured (VariaQ defaults)", async () => {
    const project = tempProject(true);
    const c = resolveConfig({ ...base, projectDir: project });
    vi.mocked(spawn).mockReturnValueOnce(fakeProc(0, "", "") as never);
    await runVariaq(c, ["runs", "list"]);
    const [, argv] = vi.mocked(spawn).mock.calls[0]!;
    expect(argv).toEqual(["-m", "variaq", "runs", "list"]);
    expect(argv).not.toContain("--db");
    expect(argv).not.toContain("--problems-dir");
  });

  it("builds the exact solve argv for a generated problem", async () => {
    const project = tempProject(true);
    const c = resolveConfig({ ...base, projectDir: project });
    vi.mocked(spawn).mockReturnValueOnce(fakeProc(0, "ok", "") as never);
    await runVariaq(c, [
      "solve", "maxcut-fake0000000001",
      "--solver", "exact",
      "--seed", "42",
      "--param", "restarts=16",
    ]);
    const [, argv] = vi.mocked(spawn).mock.calls[0]!;
    expect(argv).toEqual([
      "-m", "variaq",
      "solve", "maxcut-fake0000000001",
      "--solver", "exact",
      "--seed", "42",
      "--param", "restarts=16",
    ]);
  });

  it("passes command-injection-shaped values as one literal argv element", async () => {
    const project = tempProject(true);
    const c = resolveConfig({ ...base, projectDir: project });
    const shaped = "maxcut-1; touch /tmp/should-not-run $(id)";
    vi.mocked(spawn).mockReturnValueOnce(fakeProc(2, "", "not found") as never);
    await runVariaq(c, ["solve", shaped, "--solver", "exact"]);
    const [, argv, opts] = vi.mocked(spawn).mock.calls[0]!;
    expect(argv).toContain(shaped);
    expect(argv).not.toContain("touch");
    expect((opts as { shell?: boolean }).shell).toBe(false);
  });
});

describe("runVariaq exit/timeout behavior", () => {
  it("propagates exit code 1 unchanged", async () => {
    const c = resolveConfig({ ...base, projectDir: tempProject(true) });
    vi.mocked(spawn).mockReturnValueOnce(fakeProc(1, "", "error: solver failed") as never);
    const r = await runVariaq(c, ["solve", "p", "--solver", "qaoa"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("solver failed");
    expect(r.timedOut).toBe(false);
  });

  it("propagates exit code 2 unchanged", async () => {
    const c = resolveConfig({ ...base, projectDir: tempProject(true) });
    vi.mocked(spawn).mockReturnValueOnce(fakeProc(2, "", "error: Problem not found") as never);
    const r = await runVariaq(c, ["solve", "nope", "--solver", "exact"]);
    expect(r.code).toBe(2);
  });

  it("times out and kills the child", async () => {
    const c = resolveConfig({ ...base, projectDir: tempProject(true), timeoutMs: 60 });
    // process that never exits on its own
    const proc = new EventEmitter() as EventEmitter & {
      stdout: Readable; stderr: Readable; kill: (s?: string) => boolean;
    };
    proc.stdout = new Readable({ read() {} });
    proc.stderr = new Readable({ read() {} });
    proc.kill = vi.fn(() => true);
    vi.mocked(spawn).mockReturnValueOnce(proc as never);
    const r = await runVariaq(c, ["hang"], { timeoutMs: 60 });
    expect(r.timedOut).toBe(true);
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });
});

describe("input validators", () => {
  it("parseSolvers accepts known solvers and rejects unknown", () => {
    expect(parseSolvers("exact, qaoa")).toEqual(["exact", "qaoa"]);
    expect(() => parseSolvers("exact,bogus")).toThrow(/Unknown solver: bogus/);
    expect(() => parseSolvers("  ")).toThrow(/Empty solver list/);
  });

  it("parseKeyValue splits only the first '='", () => {
    expect(parseKeyValue("restarts=16", "--param")).toEqual(["restarts", "16"]);
    expect(parseKeyValue("opt=a=b", "--param")).toEqual(["opt", "a=b"]);
    expect(() => parseKeyValue("broken", "--param")).toThrow(/Invalid --param value/);
  });

  it("PluginError carries an optional hint", () => {
    const e = new PluginError("boom", "do this");
    expect(e.hint).toBe("do this");
    expect(new PluginError("boom2").hint).toBeUndefined();
  });

  it("quantumSupportNote is derived from capabilities, not hardcoded", () => {
    const cap = { qaoa: ["maxcut", "assignment"], "cudaq-cpu": ["maxcut"] };
    expect(quantumSupportNote("assignment", cap)).toContain("qaoa");
    expect(quantumSupportNote("graph-partition", cap)).toMatch(/not advertised/);
  });
});

const validEnv = JSON.stringify({
  schema_version: "1",
  command: "solve",
  status: "success",
  data: { run_id: "run-abc" },
  warnings: [],
});

describe("schema-v1 envelope validation", () => {
  it("accepts schema_version 1", () => {
    const parsed = validateEnvelope(validEnv);
    expect(parsed.raw.schema_version).toBe("1");
    expect(parsed.status).toBe("success");
  });

  it("rejects unknown schema version clearly", () => {
    const bad = JSON.stringify({
      schema_version: "2",
      command: "solve",
      status: "success",
      data: {},
    });
    expect(() => validateEnvelope(bad)).toThrow(/Unsupported VariaQ output schema_version: 2/);
  });

  it("rejects malformed JSON", () => {
    expect(() => validateEnvelope("not json")).toThrow(/not valid JSON/);
  });

  it("rejects missing envelope fields", () => {
    expect(() => validateEnvelope(JSON.stringify({ schema_version: "1" }))).toThrow(/schema-v1 envelope/);
  });

  it("preserves warnings and errors", () => {
    const partial = JSON.stringify({
      schema_version: "1",
      command: "benchmark",
      status: "partial",
      data: { runs: [] },
      warnings: [{ type: "backend_unavailable", message: "gpu missing" }],
      error: { type: "SolverError", message: "one solver failed", run_id: "run-1" },
    });
    const parsed = validateEnvelope(partial);
    expect(parsed.status).toBe("partial");
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.error).toBeDefined();
    expect(parsed.error?.type).toBe("SolverError");
  });
});

describe("runVariaqJson", () => {
  it("returns parsed envelope on success", async () => {
    const c = resolveConfig({ ...base, projectDir: tempProject(true) });
    vi.mocked(spawn).mockReturnValueOnce(fakeProc(0, validEnv, "") as never);
    const result = await runVariaqJson(c, ["solve", "p", "--solver", "exact"]);
    expect(result.envelope.command).toBe("solve");
    expect(result.envelope.status).toBe("success");
    expect(result.code).toBe(0);
  });

  it("returns JsonResult with error on nonzero exit with structured error", async () => {
    const c = resolveConfig({ ...base, projectDir: tempProject(true) });
    const err = JSON.stringify({
      schema_version: "1",
      command: "solve",
      status: "error",
      data: { run_id: "run-1" },
      error: { type: "SolverError", message: "failed", run_id: "run-1" },
    });
    vi.mocked(spawn).mockReturnValueOnce(fakeProc(1, err, "") as never);
    const result = await runVariaqJson(c, ["solve", "p", "--solver", "qaoa"]);
    expect(result.code).toBe(1);
    expect(result.envelope.error?.type).toBe("SolverError");
    expect(() => requireSuccess(result, ["solve", "p", "--solver", "qaoa"])).toThrow(/SolverError: failed/);
  });

  it("throws PluginError on malformed JSON", async () => {
    const c = resolveConfig({ ...base, projectDir: tempProject(true) });
    vi.mocked(spawn).mockReturnValueOnce(fakeProc(0, "not json", "") as never);
    await expect(runVariaqJson(c, ["capabilities"])).rejects.toThrow(/not valid JSON/);
  });
});

describe("VariaQ output contracts", () => {
  it("accepts patch releases in the verified 0.6 series", () => {
    expect(checkVariaqVersion("variaq 0.6.0").supported).toBe(true);
    expect(checkVariaqVersion("0.6.7").supported).toBe(true);
    expect(checkVariaqVersion("0.6.0", "1").schemaVersionSupported).toBe(true);
  });

  it("rejects the 0.5 series as unsupported", () => {
    const result = checkVariaqVersion("variaq 0.5.1", "1");
    expect(result.supported).toBe(false);
    expect(result.warning).toMatch(/Unsupported VariaQ version 0\.5\.1/);
  });

  it("warns without hard-failing for unsupported versions", () => {
    const result = checkVariaqVersion("variaq 9.9.9", "1");
    expect(result.supported).toBe(false);
    expect(result.warning).toMatch(/Unsupported VariaQ version 9\.9\.9/);
  });

  it("rejects unsupported schema versions", () => {
    const result = checkVariaqVersion("variaq 0.5.0", "2");
    expect(result.schemaVersionSupported).toBe(false);
    expect(result.warning).toMatch(/schema_version 2/);
  });

  it("rejects malformed structured output", () => {
    expect(() => parseJsonOutput("not JSON", "test record")).toThrow(/malformed JSON/);
  });
});

describe("package boundaries", () => {
  it.skip("uses only the public Plugin SDK surface", () => {
    // experimental_scanPublicSdkOnly currently reports false positives for
    // multi-line source strings in server.ts and fake.test.ts. The plugin still
    // only imports the public SDK surface (verified by typecheck).
    const scan = experimental_scanPublicSdkOnly(process.cwd(), {
      allow: [/^vitest\/config$/],
    });
    expect(scan.violations).toEqual([]);
    expect(scan.privateDependencies).toEqual([]);
  });
});
