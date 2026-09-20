import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import plugin from "../server.js";

/**
 * Deterministic failure-mode matrix driven by tests/fake_variaq.py standing in
 * as the VariaQ CLI. No real VariaQ, solver, or network is involved here —
 * these tests pin the plugin's contract on exit codes, timeouts, and lookup
 * errors, including the regression where a human-readable CLI run had
 * flattened VariaQ's non-zero exit code to 0.
 */

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fake_variaq.py");

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
const temps: string[] = [];

afterEach(async () => {
  for (const h of hosts.splice(0)) await h.harness.lifecycle.dispose();
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function setup(tools: { timeoutMs?: number } = {}) {
  // Build a "python" that is actually our fake CLI script executable directly.
  const dir = mkdtempSync(join(tmpdir(), "variaq-fake-"));
  temps.push(dir);
  const fakePython = join(dir, "python");
  symlinkSync(FAKE, fakePython);

  const h = createFakePluginHost({ pluginId: "variaq" });
  hosts.push(h);
  await plugin(h.bb);
  await h.harness.behavior.setSettings({
    pythonPath: fakePython,
    projectDir: dir,            // not used by fake; exists so resolve passes
    dbPath: null,
    problemsDir: null,
    timeoutMs: tools.timeoutMs ?? 120_000,
  });
  return h;
}

const cli = (h: ReturnType<typeof createFakePluginHost>, argv: string[]) =>
  h.harness.behavior.runCli(argv);
const tool = (
  h: ReturnType<typeof createFakePluginHost>,
  name: string,
  input: Record<string, unknown>,
) => h.harness.behavior.callAgentTool(name, input);

describe("solve via fake CLI", () => {
  it("returns the run id and record on success", async () => {
    const h = await setup();
    const result = JSON.parse(String(
      await tool(h, "variaq_solve", { problemId: "maxcut-fake000000001", solver: "exact" }),
    ));
    expect(result.runId).toBe("run-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(result.run.result.objective).toBe(7);
  });

  it("REGRESSION: VariaQ exit code 1 (solver failure) must stay non-zero", async () => {
    const h = await setup();
    const cliResult = await cli(h, ["solve", "fail1", "--solver", "cudaq-cpu"]);
    expect(cliResult.exitCode).toBe(1);
    expect(String(cliResult.stderr)).toContain("MissingOptionalDependency");

    const toolResult = JSON.parse(String(
      await tool(h, "variaq_solve", { problemId: "fail1", solver: "cudaq-cpu" }),
    ));
    expect(String(toolResult.error)).toContain("MissingOptionalDependency");
    expect(toolResult.runId).toBe("run-11111111-1111-4111-8111-111111111111");
  });

  it("VariaQ exit code 2 (lookup error) stays non-zero", async () => {
    const h = await setup();
    const cliResult = await cli(h, ["solve", "missing", "--solver", "exact"]);
    expect(cliResult.exitCode).toBe(2);
    expect(String(cliResult.stderr)).toContain("Problem not found");
  });

  it("honors the timeout and reports it", async () => {
    const h = await setup({ timeoutMs: 1_000 });
    const cliResult = await cli(h, ["solve", "hang", "--solver", "exact"]);
    expect(cliResult.exitCode).toBe(1);
    expect(String(cliResult.stderr)).toContain("timed out");
  }, 20_000);
});

describe("read paths via fake CLI", () => {
  it("reports optional CUDA-Q unavailable without disabling core solvers", async () => {
    const h = await setup();
    const status = JSON.parse(String(await tool(h, "variaq_status", {})));
    expect(status.solvers.exact).toBe("available");
    expect(status.solvers["cudaq-cpu"]).toBe("unavailable");
    expect(status.cudaq.installed).toBe(false);
    expect(status.variaq.compatibility.supported).toBe(false);
    expect(status.variaq.compatibility.warning).toMatch(/9\.9\.9/);
  });

  it("accepts supported VariaQ patch versions without a warning", async () => {
    vi.stubEnv("FAKE_VARIAQ_VERSION", "0.2.9");
    const h = await setup();
    const status = JSON.parse(String(await tool(h, "variaq_status", {})));
    expect(status.variaq.compatibility.supported).toBe(true);
    expect(status.variaq.compatibility.warning).toBeNull();
  });

  it("reports CUDA-Q CPU available only when the live probe supports qpp-cpu", async () => {
    vi.stubEnv("FAKE_CUDAQ", "available");
    const h = await setup();
    const status = JSON.parse(String(await tool(h, "variaq_status", {})));
    expect(status.cudaq.version).toBe("0.16.0.post1");
    expect(status.solvers["cudaq-cpu"]).toBe("available");
    expect(status.solvers["cudaq-gpu"]).toBe("available");
  });

  it("re-probes a temporarily unavailable NVIDIA driver", async () => {
    vi.stubEnv("FAKE_CUDAQ", "available");
    const h = await setup();
    const first = JSON.parse(String(await tool(h, "variaq_status", {})));
    expect(first.solvers["cudaq-gpu"]).toBe("available");

    vi.stubEnv("FAKE_CUDAQ", "driver-down");
    const second = JSON.parse(String(await tool(h, "variaq_status", {})));
    expect(second.cudaq.nvidiaTarget).toBe("available");
    expect(second.cudaq.nvidiaDriver).toBe("unavailable");
    expect(second.solvers["cudaq-gpu"]).toBe("unavailable");
  });

  it("benchmark returns the run ids and table", async () => {
    const h = await setup();
    const result = JSON.parse(String(
      await tool(h, "variaq_benchmark", { problemId: "maxcut-fake000000001", solvers: ["exact", "heuristic"] }),
    ));
    expect(result.exitCode).toBe(0);
    expect(result.runIds).toHaveLength(2);
    expect(result.table).toContain("exact");
  });

  it("compare-quantum surfaces the matched detail and run ids", async () => {
    const h = await setup();
    const result = JSON.parse(String(
      await tool(h, "variaq_compare_quantum", { problemId: "maxcut-fake000000001" }),
    ));
    expect(result.runIds).toHaveLength(2);
    expect(result.runs).toHaveLength(2);
    expect(String(result.output)).toContain("Matched quantum detail");
  });

  it("runs list/show/reproduce round-trip through the record store", async () => {
    const h = await setup();
    const listed = JSON.parse(String(await tool(h, "variaq_runs_list", { limit: 5 })));
    expect(listed.runs).toHaveLength(1);

    const shown = JSON.parse(String(
      await tool(h, "variaq_run_show", { runId: "run-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
    ));
    expect(shown.run_id).toBe("run-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

    const reproduced = JSON.parse(String(
      await tool(h, "variaq_run_reproduce", { runId: "run-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
    ));
    expect(reproduced.runId).toBe("run-dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  });

  it("unknown problem on problem-show surfaces VariaQ's lookup error", async () => {
    const h = await setup();
    const result = JSON.parse(String(await tool(h, "variaq_problem_show", { problemId: "missing" })));
    expect(String(result.error)).toContain("Problem not found");
  });
});

describe("argv correctness", () => {
  it("problem-generate issues the deterministic MaxCut arg form", async () => {
    const h = await setup();
    const result = JSON.parse(String(
      await tool(h, "variaq_problem_generate", { nodes: 6, edgeProbability: 0.5, seed: 42 }),
    ));
    expect(result.problemId).toBe("maxcut-fake000000001");
    expect(String(result.output)).toContain("nodes=6");
    expect(String(result.output)).toContain("edge_probability=0.5");
    expect(String(result.output)).toContain("seed=42");
  });
});
