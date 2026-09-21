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
 * timeouts, lookup errors, and multi-family awareness.
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
  const dir = mkdtempSync(join(tmpdir(), "variaq-fake-"));
  temps.push(dir);
  const fakePython = join(dir, "python");
  symlinkSync(FAKE, fakePython);

  const h = createFakePluginHost({ pluginId: "variaq" });
  hosts.push(h);
  await plugin(h.bb);
  await h.harness.behavior.setSettings({
    pythonPath: fakePython,
    projectDir: dir,
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

describe("status via fake CLI", () => {
  it("reports four problem families and solver supported_families", async () => {
    const h = await setup();
    const status = JSON.parse(String(await tool(h, "variaq_status", {})));
    expect(status.variaq.installed).toBe(true);
    expect(status.variaq.schema_version).toBe("1");
    expect(status.problem_families).toEqual(
      expect.arrayContaining(["maxcut", "assignment", "subset-selection", "graph-partition"]),
    );
    expect(status.solver_supported_families.exact).toEqual(
      expect.arrayContaining(["assignment", "graph-partition", "maxcut", "subset-selection"]),
    );
    expect(status.solver_supported_families.qaoa).toEqual(
      expect.arrayContaining(["maxcut", "assignment", "subset-selection"]),
    );
    expect(status.solvers.exact).toBe("available");
    expect(status.solvers["cudaq-cpu"]).toBe("unavailable");
  });

  it("accepts supported VariaQ 0.5 patch versions without a warning", async () => {
    vi.stubEnv("FAKE_VARIAQ_VERSION", "0.5.2");
    const h = await setup();
    const status = JSON.parse(String(await tool(h, "variaq_status", {})));
    expect(status.variaq.compatibility.supported).toBe(true);
    expect(status.variaq.compatibility.warning).toBeNull();
  });

  it("reports 0.4 series as unsupported", async () => {
    vi.stubEnv("FAKE_VARIAQ_VERSION", "0.4.2");
    const h = await setup();
    const status = JSON.parse(String(await tool(h, "variaq_status", {})));
    expect(status.variaq.compatibility.supported).toBe(false);
    expect(status.variaq.compatibility.warning).toMatch(/Unsupported VariaQ version 0\.4\.2/);
  });
});

describe("problem generation", () => {
  it("generates a maxcut problem", async () => {
    const h = await setup();
    const result = JSON.parse(String(
      await tool(h, "variaq_problem_generate", { family: "maxcut", nodes: 6, edgeProbability: 0.5, seed: 42 }),
    ));
    expect(result.problemId).toBe("maxcut-fake000000001");
    expect(result.data.family).toBe("maxcut");
    expect(result.data.node_count).toBe(6);
  });

  it("generates an assignment problem", async () => {
    const h = await setup();
    const result = JSON.parse(String(
      await tool(h, "variaq_problem_generate", { family: "assignment", taskCount: 4, resourceCount: 3, seed: 1 }),
    ));
    expect(result.problemId).toBe("assignment-fake000000001");
    expect(result.data.family).toBe("assignment");
    expect(result.data.task_count).toBe(4);
  });

  it("generates a subset-selection problem", async () => {
    const h = await setup();
    const result = JSON.parse(String(
      await tool(h, "variaq_problem_generate", { family: "subset-selection", candidateCount: 6, seed: 2 }),
    ));
    expect(result.problemId).toBe("subset-selection-fake000000001");
    expect(result.data.family).toBe("subset-selection");
    expect(result.data.candidate_count).toBe(6);
  });

  it("generates a graph-partition problem", async () => {
    const h = await setup();
    const result = JSON.parse(String(
      await tool(h, "variaq_problem_generate", { family: "graph-partition", nodes: 8, edgeProbability: 0.3, partitionCount: 3, seed: 3 }),
    ));
    expect(result.problemId).toBe("graph-partition-fake000000001");
    expect(result.data.family).toBe("graph-partition");
    expect(result.data.partition_count).toBe(3);
  });
});

describe("problem show", () => {
  it("shows generic problem metadata for every family", async () => {
    const h = await setup();
    for (const family of ["maxcut", "assignment", "subset-selection", "graph-partition"]) {
      const result = JSON.parse(String(await tool(h, "variaq_problem_show", { problemId: `${family}-fake000000001` })));
      expect(result.problem.family).toBe(family);
      expect(result.problem.sense).toMatch(/maximize|minimize/);
      expect(result.problem.problem_id).toBe(`${family}-fake000000001`);
    }
  });

  it("preserves opaque IDs", async () => {
    const h = await setup();
    const result = JSON.parse(String(await tool(h, "variaq_problem_show", { problemId: "assignment-fake000000001" })));
    expect(result.problem.task_ids).toContain("task-0");
    expect(result.problem.resource_ids).toContain("resource-0");
  });
});

describe("problem import", () => {
  it("imports a valid family artifact", async () => {
    const h = await setup();
    const artifact = JSON.stringify({
      family: "maxcut",
      schema_version: 1,
      sense: "maximize",
      node_ids: ["a", "b"],
      edges: [{ u: "a", v: "b", weight: 1 }],
    });
    const result = JSON.parse(String(await tool(h, "variaq_problem_import", { content: artifact })));
    expect(result.problem.problem_id).toBe("maxcut-import-fake0001");
    expect(result.problem.family).toBe("maxcut");
  });

  it("rejects an artifact with unknown family", async () => {
    const h = await setup();
    const artifact = JSON.stringify({ family: "triagewall", schema_version: 1 });
    const result = JSON.parse(String(await tool(h, "variaq_problem_import", { content: artifact })));
    expect(result.error).toMatch(/valid family/);
  });
});

describe("solve via fake CLI", () => {
  it("returns the run id and record on success", async () => {
    const h = await setup();
    const result = JSON.parse(String(
      await tool(h, "variaq_solve", { problemId: "maxcut-fake000000001", solver: "exact" }),
    ));
    expect(result.runId).toMatch(/^run-/);
    expect(result.run.objective).toBe(7);
  });

  it("solves assignment exactly", async () => {
    const h = await setup();
    const result = JSON.parse(String(
      await tool(h, "variaq_solve", { problemId: "assignment-fake000000001", solver: "exact" }),
    ));
    expect(result.run.status).toBe("success");
    expect(result.run.problem_type).toBe("assignment");
  });

  it("solves graph-partition heuristically", async () => {
    const h = await setup();
    const result = JSON.parse(String(
      await tool(h, "variaq_solve", { problemId: "graph-partition-fake000000001", solver: "heuristic" }),
    ));
    expect(result.run.status).toBe("success");
    expect(result.run.sense).toBe("minimize");
  });

  it("allows qaoa on assignment in VariaQ 0.5", async () => {
    const h = await setup();
    const result = JSON.parse(String(
      await tool(h, "variaq_solve", { problemId: "assignment-fake000000001", solver: "qaoa" }),
    ));
    expect(result.run.status).toBe("success");
    expect(result.run.problem_type).toBe("assignment");
    expect(result.run.expectation).toBeDefined();
    expect(result.run.feasible_sample_count).toBeGreaterThan(0);
    expect(result.run.infeasible_sample_count).toBeGreaterThan(0);
  });

  it("allows cudaq-cpu on subset-selection in VariaQ 0.5 when CUDA-Q is available", async () => {
    vi.stubEnv("FAKE_CUDAQ", "available");
    const h = await setup();
    const result = JSON.parse(String(
      await tool(h, "variaq_solve", { problemId: "subset-selection-fake000000001", solver: "cudaq-cpu" }),
    ));
    expect(result.run.status).toBe("success");
    expect(result.run.problem_type).toBe("subset-selection");
  });

  it("pre-rejects qaoa on graph-partition based on capabilities", async () => {
    const h = await setup();
    const result = JSON.parse(String(
      await tool(h, "variaq_solve", { problemId: "graph-partition-fake000000001", solver: "qaoa" }),
    ));
    expect(result.exitCode).not.toBe(0);
    expect(result.error?.message ?? String(result.error)).toMatch(/does not support problem family/);
  });

  it("pre-rejects cudaq-cpu on graph-partition based on capabilities", async () => {
    vi.stubEnv("FAKE_CUDAQ", "available");
    const h = await setup();
    const result = JSON.parse(String(
      await tool(h, "variaq_solve", { problemId: "graph-partition-fake000000001", solver: "cudaq-cpu" }),
    ));
    expect(result.exitCode).not.toBe(0);
    expect(result.error?.message ?? String(result.error)).toMatch(/does not support problem family/);
  });

  it("preserves expectation and objective as distinct fields", async () => {
    const h = await setup();
    const result = JSON.parse(String(
      await tool(h, "variaq_solve", { problemId: "assignment-fake000000001", solver: "qaoa" }),
    ));
    expect(result.run.status).toBe("success");
    expect(result.run.objective).toBe(7);
    expect(result.run.expectation).toBe(-42.135);
    expect(result.run.lowered_energy).toBe(-42.135);
  });

  it("preserves BQM and penalty metadata on quantum runs", async () => {
    const h = await setup();
    const result = JSON.parse(String(
      await tool(h, "variaq_solve", { problemId: "subset-selection-fake000000001", solver: "qaoa" }),
    ));
    expect(result.run.bqm.digest).toBe("sha256-deadbeef");
    expect(result.run.bqm.variable_count).toBe(6);
    expect(result.run.penalties).toHaveLength(1);
  });

  it("does not treat nonzero infeasible samples as failure", async () => {
    const h = await setup();
    const result = JSON.parse(String(
      await tool(h, "variaq_solve", { problemId: "maxcut-fake000000001", solver: "qaoa" }),
    ));
    expect(result.run.status).toBe("success");
    expect(result.run.feasible_sample_count).toBe(22);
    expect(result.run.infeasible_sample_count).toBe(234);
    expect(result.exitCode).toBe(0);
  });

  it("preserves no-feasible-sample failure from VariaQ", async () => {
    const h = await setup();
    const result = JSON.parse(String(
      await tool(h, "variaq_solve", { problemId: "fail1", solver: "qaoa" }),
    ));
    expect(result.exitCode).toBe(1);
    expect(result.run.feasible_sample_count).toBe(0);
    expect(result.run.infeasible_sample_count).toBe(256);
  });

  it("REGRESSION: VariaQ exit code 1 (solver failure) must stay non-zero", async () => {
    vi.stubEnv("FAKE_CUDAQ", "available");
    const h = await setup();
    const cliResult = await cli(h, ["solve", "fail1", "--solver", "cudaq-cpu"]);
    expect(cliResult.exitCode).toBe(1);

    const toolResult = JSON.parse(String(
      await tool(h, "variaq_solve", { problemId: "fail1", solver: "cudaq-cpu" }),
    ));
    expect(toolResult.error?.type).toBe("MissingOptionalDependency");
    expect(toolResult.runId).toBeDefined();
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

describe("benchmark", () => {
  it("returns partial when a solver/family combination is unsupported", async () => {
    const h = await setup();
    const result = JSON.parse(String(
      await tool(h, "variaq_benchmark", { problemId: "graph-partition-fake000000001", solvers: ["exact", "heuristic", "qaoa"] }),
    ));
    expect(result.status).toBe("partial");
    expect(result.comparison.failed_count).toBe(1);
    expect(result.comparison.unavailable_count).toBe(1);
  });

  it("returns success when assignment quantum solvers are supported", async () => {
    const h = await setup();
    const result = JSON.parse(String(
      await tool(h, "variaq_benchmark", { problemId: "assignment-fake000000001", solvers: ["exact", "heuristic", "qaoa"] }),
    ));
    expect(result.status).toBe("success");
    expect(result.comparison.successful_count).toBe(3);
  });
});

describe("compare quantum", () => {
  it("rejects graph-partition because no quantum solver supports it", async () => {
    const h = await setup();
    const result = JSON.parse(String(
      await tool(h, "variaq_compare_quantum", { problemId: "graph-partition-fake000000001" }),
    ));
    expect(result.error).toMatch(/compare quantum has no available quantum solvers for problem family 'graph-partition'/);
  });

  it("returns matched comparison for maxcut", async () => {
    const h = await setup();
    const result = JSON.parse(String(
      await tool(h, "variaq_compare_quantum", { problemId: "maxcut-fake000000001" }),
    ));
    expect(result.status).toBe("success");
    expect(result.comparison.matched_qaoa).toBe(true);
  });

  it("returns matched comparison for assignment", async () => {
    const h = await setup();
    const result = JSON.parse(String(
      await tool(h, "variaq_compare_quantum", { problemId: "assignment-fake000000001" }),
    ));
    expect(result.status).toBe("success");
    expect(result.comparison.matched_qaoa).toBe(true);
    expect(result.runs.length).toBeGreaterThanOrEqual(1);
  });

  it("returns matched comparison for subset-selection", async () => {
    const h = await setup();
    const result = JSON.parse(String(
      await tool(h, "variaq_compare_quantum", { problemId: "subset-selection-fake000000001" }),
    ));
    expect(result.status).toBe("success");
    expect(result.comparison.matched_qaoa).toBe(true);
  });
});

describe("runs", () => {
  it("list/show/reproduce round-trip", async () => {
    const h = await setup();
    const listed = JSON.parse(String(await tool(h, "variaq_runs_list", { limit: 5 })));
    expect(listed.runs).toHaveLength(1);

    const shown = JSON.parse(String(await tool(h, "variaq_run_show", { runId: "run-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })));
    expect(shown.run.run_id).toBe("run-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

    const reproduced = JSON.parse(String(
      await tool(h, "variaq_run_reproduce", { runId: "run-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
    ));
    expect(reproduced.runId).toMatch(/^run-/);
    expect(reproduced.rerunOf).toBe("run-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });
});

describe("schema-v1 boundary via fake CLI", () => {
  it("schema_version 1 is accepted and returned", async () => {
    const h = await setup();
    const result = JSON.parse(String(
      await tool(h, "variaq_solve", { problemId: "maxcut-fake000000001", solver: "exact" }),
    ));
    expect(result.run.status).toBe("success");
  });

  it("unknown problem on problem-show surfaces VariaQ's lookup error", async () => {
    const h = await setup();
    const result = JSON.parse(String(await tool(h, "variaq_problem_show", { problemId: "missing" })));
    expect(String(result.error)).toContain("Problem not found");
  });

  it("capabilities report qaoa and cudaq families from VariaQ, not from a plugin hardcoded matrix", async () => {
    const h = await setup();
    const result = JSON.parse(String(await tool(h, "variaq_status", {})));
    expect(result.solver_supported_families.qaoa).toContain("maxcut");
    expect(result.solver_supported_families.qaoa).toContain("assignment");
    expect(result.solver_supported_families.qaoa).toContain("subset-selection");
    expect(result.solver_supported_families.qaoa).not.toContain("graph-partition");
    expect(result.solver_supported_families["cudaq-cpu"]).toContain("maxcut");
    expect(result.solver_supported_families["cudaq-cpu"]).toContain("assignment");
    expect(result.solver_supported_families.exact).toContain("assignment");
  });

  it("qaoa + maxcut is allowed because capabilities says maxcut is supported", async () => {
    const h = await setup();
    const result = JSON.parse(String(await tool(h, "variaq_solve", { problemId: "maxcut-fake000000001", solver: "qaoa" })));
    expect(result.run.status).toBe("success");
  });

  it("qaoa + graph-partition is rejected before execution because capabilities says unsupported", async () => {
    const h = await setup();
    const result = JSON.parse(String(await tool(h, "variaq_solve", { problemId: "graph-partition-fake0000000001", solver: "qaoa" })));
    expect(result.exitCode).not.toBe(0);
    expect(result.error?.message ?? String(result.error)).toMatch(/does not support problem family/);
  });

  it("cudaq-cpu + subset-selection is accepted because capabilities says supported", async () => {
    vi.stubEnv("FAKE_CUDAQ", "available");
    const h = await setup();
    const result = JSON.parse(String(await tool(h, "variaq_solve", { problemId: "subset-selection-fake000000001", solver: "cudaq-cpu" })));
    expect(result.run.status).toBe("success");
  });

  it("cudaq backend unavailable is distinct from family unsupported", async () => {
    vi.stubEnv("FAKE_CUDAQ", "unavailable");
    const h = await setup();
    const status = JSON.parse(String(await tool(h, "variaq_status", {})));
    expect(status.solvers["cudaq-cpu"]).not.toBe("available");
    expect(status.solver_supported_families["cudaq-cpu"]).toContain("maxcut");
    const solve = JSON.parse(String(await tool(h, "variaq_solve", { problemId: "maxcut-fake000000001", solver: "cudaq-cpu" })));
    expect(solve.exitCode).not.toBe(0);
    expect(solve.error?.message ?? String(solve.error)).toMatch(/CUDA-Q|BackendUnavailable|backend unavailable/i);
    vi.unstubAllEnvs();
  });
});
