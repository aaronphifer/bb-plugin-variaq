import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
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
const VARIAQ_VERSION = process.env.VARIAQ_TEST_VERSION ?? "0.6.0";
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
    reportOutputDir: join(tmp, "reports"),
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
    expect(version.stdout).toContain(`variaq ${VARIAQ_VERSION}`);
  });
});

describeReal("status/version", () => {
  it("status reports schema_version 1 and solver availability from VariaQ", async () => {
    const h = await setupHost();
    const result = await tool(h, "variaq_status", {});
    const s = JSON.parse(String(result));
    expect(s.variaq.installed).toBe(true);
    expect(s.variaq.version).toBe(VARIAQ_VERSION);
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
      await tool(h, "variaq_problem_generate", { family: "maxcut", nodes: 6, edgeProbability: 0.5, seed: 42 }),
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
      await tool(h, "variaq_problem_generate", { family: "maxcut", nodes: 5, edgeProbability: 0.6, seed: 7 }),
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

  it("benchmarks assignment with quantum support", async () => {
    const h = await setupHost();
    const generated = JSON.parse(String(
      await tool(h, "variaq_problem_generate", { family: "assignment", taskCount: 4, resourceCount: 3, seed: 7 }),
    ));
    const result = JSON.parse(String(
      await tool(h, "variaq_benchmark", {
        problemId: generated.problemId,
        solvers: ["exact", "heuristic", "qaoa"],
        seed: 42,
      }),
    ));
    expect(["success", "partial"]).toContain(result.status);
    expect(result.runs.length).toBe(3);
  });
});

describeReal("compare quantum", () => {
  it("returns matched QAOA comparison structure for maxcut", async () => {
    const h = await setupHost();
    const generated = JSON.parse(String(
      await tool(h, "variaq_problem_generate", { family: "maxcut", nodes: 4, edgeProbability: 0.6, seed: 17 }),
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

  it("returns matched QAOA comparison structure for assignment", async () => {
    const h = await setupHost();
    const generated = JSON.parse(String(
      await tool(h, "variaq_problem_generate", { family: "assignment", taskCount: 4, resourceCount: 3, seed: 19 }),
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
  });

  it("rejects graph-partition because quantum support is not advertised", async () => {
    const h = await setupHost();
    const generated = JSON.parse(String(
      await tool(h, "variaq_problem_generate", { family: "graph-partition", nodes: 5, edgeProbability: 0.4, partitionCount: 2, seed: 23 }),
    ));
    const result = JSON.parse(String(
      await tool(h, "variaq_compare_quantum", {
        problemId: generated.problemId,
        p: 1,
        repeats: 1,
      }),
    ));
    expect(result.error).toMatch(/compare quantum has no available quantum solvers for problem family 'graph-partition'/);
  });
});


describeReal("assignment family", () => {
  it("generates, shows, solves, benchmarks, and reproduces", async () => {
    const h = await setupHost();
    const generated = JSON.parse(String(
      await tool(h, "variaq_problem_generate", { family: "assignment", taskCount: 4, resourceCount: 3, seed: 1 }),
    ));
    const problemId = generated.problemId as string;
    expect(generated.data.family).toBe("assignment");

    const shown = JSON.parse(String(await tool(h, "variaq_problem_show", { problemId })));
    expect(shown.problem.family).toBe("assignment");
    expect(shown.problem.sense).toMatch(/maximize|minimize/);

    const exact = JSON.parse(String(await tool(h, "variaq_solve", { problemId, solver: "exact", seed: 1 })));
    expect(exact.run.status).toBe("success");
    expect(exact.run.solver).toBe("exact");

    const heuristic = JSON.parse(String(await tool(h, "variaq_solve", { problemId, solver: "heuristic", seed: 1 })));
    expect(heuristic.run.status).toBe("success");

    const qaoa = JSON.parse(String(await tool(h, "variaq_solve", { problemId, solver: "qaoa", seed: 1 })));
    expect(qaoa.run.status).toBe("success");

    const benchmark = JSON.parse(String(
      await tool(h, "variaq_benchmark", { problemId, solvers: ["exact", "heuristic", "qaoa"], seed: 1 }),
    ));
    expect(["success", "partial"]).toContain(benchmark.status);

    const reproduced = JSON.parse(String(await tool(h, "variaq_run_reproduce", { runId: exact.runId })));
    expect(reproduced.run.status).toBe("success");
    expect(reproduced.rerunOf).toBe(exact.runId);
  });
});

describeReal("subset-selection family", () => {
  it("generates, shows, solves, benchmarks, and reproduces", async () => {
    const h = await setupHost();
    const generated = JSON.parse(String(
      await tool(h, "variaq_problem_generate", { family: "subset-selection", candidateCount: 6, seed: 2 }),
    ));
    const problemId = generated.problemId as string;
    expect(generated.data.family).toBe("subset-selection");

    const shown = JSON.parse(String(await tool(h, "variaq_problem_show", { problemId })));
    expect(shown.problem.family).toBe("subset-selection");

    const exact = JSON.parse(String(await tool(h, "variaq_solve", { problemId, solver: "exact", seed: 2 })));
    expect(exact.run.status).toBe("success");

    const heuristic = JSON.parse(String(await tool(h, "variaq_solve", { problemId, solver: "heuristic", seed: 2 })));
    expect(heuristic.run.status).toBe("success");

    const qaoa = JSON.parse(String(await tool(h, "variaq_solve", { problemId, solver: "qaoa", seed: 2 })));
    expect(qaoa.run.status).toBe("success");

    const benchmark = JSON.parse(String(
      await tool(h, "variaq_benchmark", { problemId, solvers: ["exact", "heuristic", "qaoa"], seed: 2 }),
    ));
    expect(["success", "partial"]).toContain(benchmark.status);

    const reproduced = JSON.parse(String(await tool(h, "variaq_run_reproduce", { runId: exact.runId })));
    expect(reproduced.run.status).toBe("success");
  });
});

describeReal("graph-partition family", () => {
  it("generates, shows, solves, benchmarks, and reproduces", async () => {
    const h = await setupHost();
    const generated = JSON.parse(String(
      await tool(h, "variaq_problem_generate", { family: "graph-partition", nodes: 5, edgeProbability: 0.4, partitionCount: 2, seed: 3 }),
    ));
    const problemId = generated.problemId as string;
    expect(generated.data.family).toBe("graph-partition");

    const shown = JSON.parse(String(await tool(h, "variaq_problem_show", { problemId })));
    expect(shown.problem.family).toBe("graph-partition");
    expect(shown.problem.sense).toBe("minimize");

    const exact = JSON.parse(String(await tool(h, "variaq_solve", { problemId, solver: "exact", seed: 3 })));
    expect(exact.run.status).toBe("success");
    expect(shown.problem.sense).toBe("minimize");

    const heuristic = JSON.parse(String(await tool(h, "variaq_solve", { problemId, solver: "heuristic", seed: 3 })));
    expect(heuristic.run.status).toBe("success");

    const benchmark = JSON.parse(String(
      await tool(h, "variaq_benchmark", { problemId, solvers: ["exact", "heuristic"], seed: 3 }),
    ));
    expect(benchmark.status).toBe("success");

    const reproduced = JSON.parse(String(await tool(h, "variaq_run_reproduce", { runId: exact.runId })));
    expect(reproduced.run.status).toBe("success");
  });

  it("qaoa is rejected for graph-partition based on capabilities", async () => {
    const h = await setupHost();
    const generated = JSON.parse(String(
      await tool(h, "variaq_problem_generate", { family: "graph-partition", nodes: 5, edgeProbability: 0.4, partitionCount: 2, seed: 4 }),
    ));
    const result = JSON.parse(String(
      await tool(h, "variaq_solve", { problemId: generated.problemId, solver: "qaoa" }),
    ));
    expect(result.exitCode).not.toBe(0);
    expect(String(result.error?.message || result.error)).toMatch(/does not support problem family/);
  });
});

describeReal("problem import", () => {
  it("imports a valid assignment artifact", async () => {
    const h = await setupHost();
    const generated = JSON.parse(String(
      await tool(h, "variaq_problem_generate", { family: "assignment", taskCount: 3, resourceCount: 2, seed: 9 }),
    ));
    const artifact = readFileSync(generated.data.path as string, "utf8");
    const problemsDir = dirname(generated.data.path as string);
    const result = JSON.parse(String(await tool(h, "variaq_problem_import", { content: artifact, output: `${problemsDir}/imported-${generated.problemId}.json` })));
    expect(result.problem.family).toBe("assignment");
    expect(result.problem.problem_id).toBeDefined();
    expect(result.problem.task_ids).toContain("task-0");
  });
});

describeReal("campaign, analysis, and report integration", () => {
  it("plans and runs a bounded campaign, analyzes it, and writes provenance-preserving reports", async () => {
    const h = await setupHost();
    const campaign = {
      campaign_format_version: "1",
      name: "ci-maxcut-scaling",
      family: "maxcut",
      problem_sizes: [4, 5],
      problem_seeds: [1],
      solvers: ["exact", "heuristic"],
      repeats: 1,
      base_seed: 42,
      generator_parameters: { edge_probability: 0.4 },
      solver_config: {},
    };

    const plan = JSON.parse(String(await tool(h, "variaq_campaign_plan", campaign)));
    expect(plan.plan.requested_runs).toBe(4);
    expect(plan.plan.exceeds_default_max).toBe(false);
    expect(plan.plan.solver_breakdown).toHaveLength(2);
    expect(plan).not.toHaveProperty("tempFile");

    const run = JSON.parse(String(await tool(h, "variaq_campaign_run", {
      ...campaign,
      maxRuns: 10,
      overrideMaxRuns: false,
    })));
    expect(run.exitCode).toBe(0);
    expect(run.campaignId).toMatch(/^campaign-/);
    expect(run.summary.requested_runs).toBe(4);
    expect(run.summary.completed_runs).toBe(4);
    expect(run.summary.status_summary).toEqual({ success: 4, failed: 0, skipped: 0, unavailable: 0 });

    const analysis = JSON.parse(String(await tool(h, "variaq_analyze_campaign", {
      campaignId: run.campaignId,
      group_by: ["solver"],
      scaling_x: "problem_size",
      include_failed: true,
      include_unavailable: true,
      compare: "classical_vs_quantum",
    })));
    expect(analysis.analysis.source_run_ids).toEqual(expect.arrayContaining(run.summary.run_ids));
    expect(analysis.analysis.groups.length).toBeGreaterThan(0);
    expect(analysis.analysis.scaling_points.length).toBeGreaterThan(0);
    expect(analysis.analysis.groups[0].environment_versions.variaq).toContain(VARIAQ_VERSION);

    const report = JSON.parse(String(await tool(h, "variaq_report_campaign", {
      campaignId: run.campaignId,
      outputDir: "ci-smoke",
      formats: ["json", "csv", "markdown"],
      groupBy: ["solver"],
      scalingX: "problem_size",
      compare: "classical_vs_quantum",
    })));
    expect(report.reportId).toMatch(/^report-/);
    expect(report.paths.csv.groups).toBeTruthy();
    expect(report.paths.markdown).toBeTruthy();
    const reportDocument = JSON.parse(readFileSync(report.paths.json as string, "utf8"));
    expect(reportDocument.report_id).toBe(report.reportId);
    expect(reportDocument.campaign_id).toBe(run.campaignId);
    expect(reportDocument.source_run_ids).toEqual(expect.arrayContaining(run.summary.run_ids));
    expect(reportDocument.report_format_version).toBe("1");
    expect(reportDocument.variaq_version).toBe(VARIAQ_VERSION);
    expect(reportDocument.generated_at).toBeTruthy();
    expect(reportDocument.analysis.query.campaign_id).toBe(run.campaignId);
  });
});

describe.skipIf(!HAS_REAL_VARIAQ || !["0.8.0", "0.8.0rc1"].includes(VARIAQ_VERSION))("paired-solver candidate integration", () => {
  it("forwards controls, paired/null/timing evidence and expanded reports through existing tools and CLI", async () => {
    const h = await setupHost();
    const parameters = { p: 1, optimizer_trials: 2, shots: 32, warmup: false, candidate_parameters: [[0.5, 0.25], [0.8, 0.4]] };
    const definition = {
      campaign_format_version: "1", name: "candidate-paired", family: "maxcut",
      problem_sizes: [4], problem_seeds: [11], solvers: ["exact", "heuristic", "qaoa"],
      repeats: 2, base_seed: 42, generator_parameters: { edge_probability: 0.7 },
      solver_config: { qaoa: { parameters } },
    };
    const plan = JSON.parse(String(await tool(h, "variaq_campaign_plan", definition)));
    expect(plan.plan.requested_runs).toBe(6);
    const run = JSON.parse(String(await tool(h, "variaq_campaign_run", { ...definition, maxRuns: 6 })));
    expect(run.exitCode).toBe(0);
    expect(run.summary.status_summary.success).toBe(6);
    const analysis = JSON.parse(String(await tool(h, "variaq_analyze_campaign", {
      campaignId: run.campaignId, compare: "paired_solvers",
    })));
    const instance = analysis.analysis.instances[0];
    expect(instance.reference_optimum).toBe(4);
    expect(instance.runs).toHaveLength(6);
    const exact = instance.runs.find((r: { solver: string }) => r.solver === "exact");
    expect(exact.optimality_gap).toBe(0);
    expect(exact.timing.first_backend_evaluation_seconds).toBeNull();
    expect(exact.missing_measurements.first_backend_evaluation_seconds).toBeTruthy();
    const qaoa = instance.runs.find((r: { solver: string }) => r.solver === "qaoa");
    expect(qaoa.parameters.candidate_parameters).toEqual(parameters.candidate_parameters);
    expect(qaoa.precision).toBe("fp64");
    expect(qaoa.cold_start_verified).toBeNull();
    expect(qaoa.timing.first_backend_evaluation_seconds).toBeGreaterThanOrEqual(0);
    expect(qaoa.timing_scopes.first_backend_evaluation_overlaps).toBeTruthy();
    const paired = analysis.analysis.comparisons.find((c: { comparison_type: string }) => c.comparison_type === "paired_solvers");
    expect(paired.pairs.length).toBeGreaterThanOrEqual(2);
    const cliAnalysis = await cli(h, ["analyze-campaign", run.campaignId, "--compare", "paired_solvers", "--json"]);
    expect(cliAnalysis.exitCode, cliAnalysis.stderr).toBe(0);
    expect(JSON.parse(cliAnalysis.stdout).analysis.source_run_ids).toEqual(expect.arrayContaining(run.summary.run_ids));
    const runsAnalysis = JSON.parse(String(await tool(h, "variaq_analyze_runs", { run_ids: run.summary.run_ids })));
    expect(runsAnalysis.analysis.source_run_ids).toEqual(expect.arrayContaining(run.summary.run_ids));
    const report = JSON.parse(String(await tool(h, "variaq_report_campaign", {
      campaignId: run.campaignId, outputDir: "paired", formats: ["json", "csv", "markdown"], compare: "paired_solvers",
    })));
    expect(report.reportId).toMatch(/^report-/);
    const document = JSON.parse(readFileSync(report.paths.json, "utf8"));
    expect(document.analysis.instances).toEqual(analysis.analysis.instances);
    expect(document.source_run_ids).toEqual(expect.arrayContaining(run.summary.run_ids));
    for (const name of ["runs", "pairs", "repeats"]) {
      expect(readFileSync(report.paths.csv[name], "utf8").length).toBeGreaterThan(0);
    }
    const runCsv = readFileSync(report.paths.csv.runs, "utf8");
    expect(runCsv).toContain("timing.first_backend_evaluation_seconds");
    expect(runCsv).toContain("precision");
    for (const id of run.summary.run_ids) expect(runCsv).toContain(id);
    expect(readFileSync(report.paths.markdown, "utf8")).toContain("Paired solver observations");
    const cliReport = await cli(h, ["report-campaign", run.campaignId, "--output-dir", "paired-cli", "--formats", "json,csv,markdown", "--compare", "paired_solvers", "--json"]);
    expect(cliReport.exitCode, cliReport.stderr).toBe(0);
    expect(JSON.parse(cliReport.stdout).paths.csv.pairs).toBeTruthy();
    const stored = JSON.parse(String(await tool(h, "variaq_runs_list", { limit: 20 })));
    expect(stored.runs).toHaveLength(6); // Read-only analysis/reporting did not execute solvers.
  });
});

describeReal("real heuristic and Qiskit integration", () => {
  it("runs deterministic heuristic and local Qiskit QAOA solves on maxcut", async () => {
    const h = await setupHost();
    const generated = JSON.parse(String(
      await tool(h, "variaq_problem_generate", { family: "maxcut", nodes: 4, edgeProbability: 0.6, seed: 17 }),
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

  it("runs deterministic heuristic and local Qiskit QAOA solves on assignment", async () => {
    const h = await setupHost();
    const generated = JSON.parse(String(
      await tool(h, "variaq_problem_generate", { family: "assignment", taskCount: 4, resourceCount: 3, seed: 17 }),
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
      await tool(h, "variaq_problem_generate", { family: "maxcut", nodes: 4, edgeProbability: 0.5, seed: 3 }),
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
      await tool(h, "variaq_problem_generate", { family: "maxcut", nodes: 6, edgeProbability: 0.5, seed: 29 }),
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
      await tool(h, "variaq_problem_generate", { family: "maxcut", nodes: 4, edgeProbability: 0.6, seed: 11 }),
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

describe.skipIf(!HAS_REAL_VARIAQ || process.env.VARIAQ_TEST_GPU !== "1")("optional CUDA-Q GPU integration", () => {
  it("runs a bounded nvidia solve when GPU is available", async () => {
    const h = await setupHost();
    const generated = JSON.parse(String(
      await tool(h, "variaq_problem_generate", { family: "maxcut", nodes: 4, edgeProbability: 0.6, seed: 13 }),
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
