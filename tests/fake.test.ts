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
 * these tests pin the plugin's contract on schema-v1 envelopes, exit codes,
 * timeouts, and lookup errors.
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
    expect(result.runId).toMatch(/^run-/);
    expect(result.run.objective).toBe(7);
  });

  it("REGRESSION: VariaQ exit code 1 (solver failure) must stay non-zero", async () => {
    const h = await setup();
    const cliResult = await cli(h, ["solve", "fail1", "--solver", "cudaq-cpu"]);
    expect(cliResult.exitCode).toBe(1);

    const toolResult = JSON.parse(String(
      await tool(h, "variaq_solve", { problemId: "fail1", solver: "cudaq-cpu" }),
    ));
    expect(toolResult.error?.type).toBe("MissingOptionalDependency");
    expect(toolResult.runId).toBeDefined();
    expect(typeof toolResult.runId).toBe("string");
  });

  it("VariaQ exit code 2 (lookup error) stays non-zero", async () => {
    const h = await setup();
    const cliResult = await cli(h, ["solve", "missing", "--solver", "exact", "--json"]);
    expect(cliResult.exitCode).toBe(2);
  });

  it("honors the timeout and reports it", async () => {
    const h = await setup({ timeoutMs: 1_000 });
    const cliResult = await cli(h, ["solve", "hang", "--solver", "exact"]);
    expect(cliResult.exitCode).toBe(1);
    expect(String(cliResult.stderr)).toContain("timed out");
  }, 20_000);
});

describe("schema-v1 boundary via fake CLI", () => {
  it("schema_version 1 is accepted and returned", async () => {
    const h = await setup();
    const result = JSON.parse(String(
      await tool(h, "variaq_solve", { problemId: "maxcut-fake000000001", solver: "exact" }),
    ));
    expect(result.run.status).toBe("success");
  });

  it("unknown schema version would be rejected (unit test covers error text)", async () => {
    // The fake CLI always emits schema 1; the schema rejection is exercised
    // directly in runner.test.ts against crafted envelopes.
    const h = await setup();
    const result = JSON.parse(String(await tool(h, "variaq_problem_show", { problemId: "maxcut-fake000000001" })));
    expect(result.problem.problem_type).toBe("maxcut");
  });
});

describe("read paths via fake CLI", () => {
  it("status consumes VariaQ capabilities --json", async () => {
    const h = await setup();
    const status = JSON.parse(String(await tool(h, "variaq_status", {})));
    expect(status.variaq.installed).toBe(true);
    expect(status.variaq.schema_version).toBe("1");
    expect(status.solvers.exact).toBe("available");
    expect(status.solvers["cudaq-cpu"]).toBe("unavailable");
    expect(status.physical_qpu.supported).toBe(false);
  });

  it("accepts supported VariaQ patch versions without a warning", async () => {
    vi.stubEnv("FAKE_VARIAQ_VERSION", "0.3.9");
    const h = await setup();
    const status = JSON.parse(String(await tool(h, "variaq_status", {})));
    expect(status.variaq.compatibility.supported).toBe(true);
    expect(status.variaq.compatibility.warning).toBeNull();
  });

  it("reports CUDA-Q CPU available only when the live probe supports qpp-cpu", async () => {
    vi.stubEnv("FAKE_CUDAQ", "available");
    const h = await setup();
    const status = JSON.parse(String(await tool(h, "variaq_status", {})));
    expect(status.frameworks.cudaq.version).toBe("0.16.0.post1");
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
    expect(second.frameworks.cudaq.nvidia_available).toBe(false);
    expect(second.solvers["cudaq-gpu"]).toBe("unavailable");
  });

  it("benchmark returns the structured envelope directly", async () => {
    const h = await setup();
    const result = JSON.parse(String(
      await tool(h, "variaq_benchmark", { problemId: "maxcut-fake000000001", solvers: ["exact", "heuristic"] }),
    ));
    expect(result.status).toBe("success");
    expect(result.runs).toHaveLength(2);
    expect(result.comparison.solver_count).toBe(2);
    expect(result.runIds).toHaveLength(2);
  });

  it("compare-quantum returns matched comparison structure", async () => {
    const h = await setup();
    const result = JSON.parse(String(
      await tool(h, "variaq_compare_quantum", { problemId: "maxcut-fake000000001" }),
    ));
    expect(result.status).toBe("success");
    expect(result.comparison.matched_qaoa).toBe(true);
    expect(result.comparison.candidate_parameter_digest).toBe("abc123");
    expect(result.runs).toHaveLength(2);
    expect(result.runIds).toHaveLength(2);
  });

  it("runs list/show/reproduce round-trip through the record store", async () => {
    const h = await setup();
    const listed = JSON.parse(String(await tool(h, "variaq_runs_list", { limit: 5 })));
    expect(listed.runs).toHaveLength(1);

    const shown = JSON.parse(String(
      await tool(h, "variaq_run_show", { runId: "run-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
    ));
    expect(shown.run.run_id).toBe("run-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

    const reproduced = JSON.parse(String(
      await tool(h, "variaq_run_reproduce", { runId: "run-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
    ));
    expect(reproduced.runId).toMatch(/^run-/);
    expect(reproduced.rerunOf).toBe("run-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(reproduced.environmentDifferences).toBeDefined();
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
    expect(result.data.node_count).toBe(6);
    expect(result.data.seed).toBe(42);
  });
});
