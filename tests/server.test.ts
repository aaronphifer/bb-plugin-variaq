import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import plugin from "../server.js";

/**
 * Integration tests against the REAL standalone VariaQ install on this
 * machine. No Qiskit/CUDA-Q math is duplicated here — the tests invoke the
 * plugin (which shells out to `python -m variaq --json`) and assert the
 * schema-v1 contract.
 *
 * State isolation: each run gets its own temporary dbPath/problemsDir so it
 * does not touch the developer's experiment history.
 */

const VARIAQ_PROJECT = process.env.VARIAQ_TEST_PROJECT ?? "";
const VARIAQ_PYTHON = process.env.VARIAQ_TEST_PYTHON ??
  (VARIAQ_PROJECT === "" ? "" : join(VARIAQ_PROJECT, ".venv", "bin", "python"));
const HAS_REAL_VARIAQ = VARIAQ_PROJECT !== "" && VARIAQ_PYTHON !== "";
const RUN_CUDAQ = process.env.VARIAQ_TEST_CUDAQ === "1";
const describeReal = describe.skipIf(!HAS_REAL_VARIAQ);

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
const temps: string[] = [];

afterEach(async () => {
  for (const h of hosts.splice(0)) await h.harness.lifecycle.dispose();
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

async function setupHost() {
  const h = createFakePluginHost({ pluginId: "variaq" });
  hosts.push(h);
  await plugin(h.bb);
  const tmp = mkdtempSync(join(tmpdir(), "variaq-plugin-it-"));
  temps.push(tmp);
  await h.harness.behavior.setSettings({
    pythonPath: VARIAQ_PYTHON,
    projectDir: VARIAQ_PROJECT,
    dbPath: join(tmp, "exp.db"),
    problemsDir: join(tmp, "problems"),
    timeoutMs: 180_000,
  });
  return h;
}

const cli = async (h: ReturnType<typeof createFakePluginHost>, argv: string[]) =>
  await h.harness.behavior.runCli(argv);
const tool = async (
  h: ReturnType<typeof createFakePluginHost>,
  name: string,
  input: Record<string, unknown>,
) => await h.harness.behavior.callAgentTool(name, input);

describeReal("plugin registration", () => {
  it("registers the variaq CLI and expected agent tools", async () => {
    const h = await setupHost();
    const version = await cli(h, ["version"]);
    expect(version.exitCode).toBe(0);
    expect(version.stdout).toContain("variaq 0.3.0");
  });
});

describeReal("status/version", () => {
  it("status reports schema_version 1 and solver availability from VariaQ", async () => {
    const h = await setupHost();
    const result = await tool(h, "variaq_status", {});
    const s = JSON.parse(String(result));
    expect(s.variaq.installed).toBe(true);
    expect(s.variaq.version).toBe("0.3.0");
    expect(s.variaq.schema_version).toBe("1");
    expect(s.variaq.python).toBe(VARIAQ_PYTHON);
    expect(s.solvers.exact).toBe("available");
    expect(s.solvers.heuristic).toBe("available");
    expect(s.solvers.qaoa).toBe("available");
    expect(s.variaq.compatibility.supported).toBe(true);
    expect(s.physical_qpu.supported).toBe(false);
  });
});

describeReal("failure: misconfiguration", () => {
  it("clear error when configured pythonPath does not exist", async () => {
    const h = createFakePluginHost({ pluginId: "variaq" });
    hosts.push(h);
    await plugin(h.bb);
    await h.harness.behavior.setSettings({ pythonPath: "/no/such/python" });
    const result = await tool(h, "variaq_version", {});
    const parsed = JSON.parse(String(result));
    expect(parsed.error).toMatch(/pythonPath does not exist/);
    expect(parsed.hint).toBeTruthy();
  });

  it("clear error when no VariaQ can be discovered", async () => {
    const h = createFakePluginHost({ pluginId: "variaq" });
    hosts.push(h);
    await plugin(h.bb);
    await h.harness.behavior.setSettings({ projectDir: "/no/such/dir" });
    const result = await tool(h, "variaq_version", {});
    const parsed = JSON.parse(String(result));
    expect(parsed.error).toBeTruthy();
    expect(String(parsed.error).length).toBeGreaterThan(0);
  });
});

describeReal("solve + run-record flow", () => {
  it("solves exactly, lists runs, shows and reproduces", async () => {
    const h = await setupHost();
    const generated = JSON.parse(String(
      await tool(h, "variaq_problem_generate", { nodes: 6, edgeProbability: 0.5, seed: 42 }),
    ));
    expect(generated.problemId).toMatch(/^maxcut-[0-9a-f]{16}$/);
    const problemId = generated.problemId as string;

    const solved = JSON.parse(String(
      await tool(h, "variaq_solve", { problemId, solver: "exact", seed: 42 }),
    ));
    expect(solved.runId).toMatch(/^run-/);
    expect(solved.run.status).toBe("success");
    expect(typeof solved.run.objective).toBe("number");

    const listed = JSON.parse(String(await tool(h, "variaq_runs_list", { limit: 5 })));
    expect(listed.runs.map((r: { run_id: string }) => r.run_id)).toContain(solved.runId);

    const shown = JSON.parse(String(await tool(h, "variaq_run_show", { runId: solved.runId })));
    expect(shown.run.result.problem_id).toBe(problemId);

    const reproduced = JSON.parse(String(
      await tool(h, "variaq_run_reproduce", { runId: solved.runId }),
    ));
    expect(reproduced.runId).toMatch(/^run-/);
    expect(reproduced.runId).not.toBe(solved.runId);
    expect(reproduced.rerunOf).toBe(solved.runId);
    expect(reproduced.run.status).toBe("success");
  });
});

describeReal("benchmark", () => {
  it("compares solvers and returns structured comparison", async () => {
    const h = await setupHost();
    const generated = JSON.parse(String(
      await tool(h, "variaq_problem_generate", { nodes: 5, edgeProbability: 0.6, seed: 7 }),
    ));
    const result = JSON.parse(String(
      await tool(h, "variaq_benchmark", {
        problemId: generated.problemId,
        solvers: ["exact", "heuristic", "qaoa"],
        seed: 42,
      }),
    ));
    expect(result.exitCode).toBe(0);
    expect(result.status).toBe("success");
    expect(result.runs.length).toBe(3);
    expect(result.comparison.solver_count).toBe(3);
  });
});

describeReal("compare quantum", () => {
  it("returns matched QAOA comparison structure", async () => {
    const h = await setupHost();
    const generated = JSON.parse(String(
      await tool(h, "variaq_problem_generate", { nodes: 4, edgeProbability: 0.6, seed: 17 }),
    ));
    const result = JSON.parse(String(
      await tool(h, "variaq_compare_quantum", {
        problemId: generated.problemId,
        p: 1,
        repeats: 1,
      }),
    ));
    expect(["success", "partial"]).toContain(result.status);
    expect(result.comparison.matched_qaoa).toBe(true);
    expect(result.runs.length).toBeGreaterThanOrEqual(1);
  });
});

describeReal("real heuristic and Qiskit integration", () => {
  it("runs deterministic heuristic and local Qiskit QAOA solves", async () => {
    const h = await setupHost();
    const generated = JSON.parse(String(
      await tool(h, "variaq_problem_generate", { nodes: 4, edgeProbability: 0.6, seed: 17 }),
    ));
    for (const solver of ["heuristic", "qaoa"] as const) {
      const solved = JSON.parse(String(
        await tool(h, "variaq_solve", {
          problemId: generated.problemId,
          solver,
          seed: 17,
          ...(solver === "qaoa" ? { params: { p: 1, optimizer_trials: 4, shots: 64 } } : {}),
        }),
      ));
      expect(solved.run.status).toBe("success");
      expect(solved.run.solver).toBe(solver);
    }
  });
});

describeReal("failure paths", () => {
  it("VariaQ exit 2 (unknown problem) stays non-zero via CLI and tool", async () => {
    const h = await setupHost();
    const fromCli = await cli(h, ["solve", "missing-problem", "--solver", "exact", "--json"]);
    expect(fromCli.exitCode).toBe(2);
    const fromTool = JSON.parse(String(
      await tool(h, "variaq_solve", { problemId: "missing-problem", solver: "exact" }),
    ));
    expect(String(fromTool.error?.message)).toContain("Problem not found");
  });

  it("unknown solver surfaces the CLI usage error (argparse exit 2)", async () => {
    const h = await setupHost();
    const generated = JSON.parse(String(
      await tool(h, "variaq_problem_generate", { nodes: 4, edgeProbability: 0.5, seed: 3 }),
    ));
    const cliResult = await cli(h, ["solve", generated.problemId as string, "--solver", "not-a-solver"]);
    expect(cliResult.exitCode).toBe(2);
    expect(String(cliResult.stderr)).toContain("invalid choice");
  });

  it("unknown run id on show surfaces VariaQ's lookup failure", async () => {
    const h = await setupHost();
    const result = JSON.parse(String(await tool(h, "variaq_run_show", { runId: "run-00000000-0000-0000-0000-000000000000" })));
    expect(String(result.error)).toMatch(/run|not found|exist/i);
  });

  it("persisted solver failure preserves exit 1 and structured run", async () => {
    const h = await setupHost();
    const generated = JSON.parse(String(
      await tool(h, "variaq_problem_generate", { nodes: 6, edgeProbability: 0.5, seed: 29 }),
    ));
    const result = await cli(h, [
      "solve",
      generated.problemId as string,
      "--solver",
      "exact",
      "--param",
      "max_variables=2",
      "--seed",
      "29",
      "--json",
    ]);
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(String(result.stdout));
    expect(parsed.error).toBeDefined();
    expect(parsed.runId).toMatch(/^run-/);
  });
});

describe.skipIf(!HAS_REAL_VARIAQ || !RUN_CUDAQ)("optional CUDA-Q CPU integration", () => {
  it("runs a bounded qpp-cpu solve when CUDA-Q is installed", async () => {
    const h = await setupHost();
    const generated = JSON.parse(String(
      await tool(h, "variaq_problem_generate", { nodes: 4, edgeProbability: 0.6, seed: 11 }),
    ));
    const solved = JSON.parse(String(
      await tool(h, "variaq_solve", {
        problemId: generated.problemId,
        solver: "cudaq-cpu",
        seed: 11,
        params: { p: 1, optimizer_trials: 4, shots: 64 },
      }),
    ));
    expect(solved.run.status).toBe("success");
    expect(solved.run.backend).toMatch(/qpp-cpu/);
  });
});

describe.skipIf(!HAS_REAL_VARIAQ || !RUN_CUDAQ)("optional CUDA-Q GPU integration", () => {
  it("runs a bounded nvidia solve when GPU is available", async () => {
    const h = await setupHost();
    const generated = JSON.parse(String(
      await tool(h, "variaq_problem_generate", { nodes: 4, edgeProbability: 0.6, seed: 13 }),
    ));
    const solved = JSON.parse(String(
      await tool(h, "variaq_solve", {
        problemId: generated.problemId,
        solver: "cudaq-gpu",
        seed: 13,
        params: { p: 1, optimizer_trials: 4, shots: 64 },
      }),
    ));
    expect(solved.run.status).toBe("success");
    expect(solved.run.backend).toMatch(/nvidia/);
  });
});
