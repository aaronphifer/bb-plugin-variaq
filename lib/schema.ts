import { z } from "zod";

/**
 * VariaQ schema-v1 envelope types.
 *
 * See VariaQ docs/structured-output.md and variaq/serialization.py.
 * This module deliberately over-models only the envelope and a few shared
 * cross-command fields. Inner `data` shapes are command-specific and are left
 * as `z.unknown()` so the plugin can forward them without becoming coupled to
 * every VariaQ run field.
 */

export const jsonValueSchema: z.ZodTypeAny = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ])
);

export type JsonValue = z.infer<typeof jsonValueSchema>;

export const structuredErrorSchema = z.object({
  type: z.string(),
  message: z.string(),
  run_id: z.string().optional(),
  context: z.record(z.string(), jsonValueSchema).optional(),
  retryable: z.boolean().optional(),
});

export const structuredWarningSchema = z.object({
  type: z.string(),
  message: z.string(),
  context: z.record(z.string(), jsonValueSchema).optional(),
});

/**
 * Common statuses. VariaQ also uses "partial" for mixed benchmark outcomes.
 */
export const envelopeStatusSchema = z.enum(["success", "partial", "error"]);

export const envelopeSchema = z.object({
  schema_version: z.string(),
  command: z.string(),
  status: envelopeStatusSchema,
  data: z.unknown(),
  warnings: z.array(structuredWarningSchema).optional(),
  error: structuredErrorSchema.optional(),
});

export type StructuredError = z.infer<typeof structuredErrorSchema>;
export type StructuredWarning = z.infer<typeof structuredWarningSchema>;
export type Envelope = z.infer<typeof envelopeSchema>;
export type EnvelopeStatus = z.infer<typeof envelopeStatusSchema>;

export const PROBLEM_FAMILIES = [
  "maxcut",
  "assignment",
  "subset-selection",
  "graph-partition",
] as const;

export type ProblemFamily = (typeof PROBLEM_FAMILIES)[number];

export const problemFamilySchema = z.enum(PROBLEM_FAMILIES);

/** Validate a problem family name against VariaQ 0.6 generic families. */
export function isProblemFamily(value: string): value is ProblemFamily {
  return PROBLEM_FAMILIES.includes(value as ProblemFamily);
}

// ---------------------------------------------------------------------------
// Campaign / analysis / report schemas (VariaQ 0.6.0)
// The plugin validates only the envelope and a few shared fields; inner data
// is forwarded as-is so the plugin does not become coupled to VariaQ analytics.
// ---------------------------------------------------------------------------

export const campaignSolverOverrideSchema = z.record(
  z.string(),
  z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))])),
);

export const campaignDefinitionSchema = z.object({
  campaign_format_version: z.literal("1"),
  name: z.string().min(1).max(256),
  family: problemFamilySchema,
  problem_sizes: z.array(z.number().int().min(1)).min(1).max(64),
  problem_seeds: z.array(z.number().int().min(0)).min(1).max(64),
  solvers: z.array(z.enum(["exact", "heuristic", "qaoa", "cudaq-cpu", "cudaq-gpu"])).min(1),
  repeats: z.number().int().min(1).max(100).default(1),
  base_seed: z.number().int().min(0).default(0),
  solver_config: campaignSolverOverrideSchema.default({}),
  generator_parameters: z.record(z.string(), z.unknown()).default({}),
  tags: z.array(z.string().max(64)).max(32).default([]),
  notes: z.string().max(4096).default(""),
});

export type CampaignDefinition = z.infer<typeof campaignDefinitionSchema>;

export const campaignPlanDataSchema = z.object({
  campaign_id: z.string(),
  name: z.string(),
  family: problemFamilySchema,
  requested_runs: z.number().int(),
  problem_instance_count: z.number().int(),
  repeats: z.number().int(),
  default_max_runs: z.number().int(),
  exceeds_default_max: z.boolean(),
  estimated_quantum_runs: z.number().int(),
  max_binary_variables: z.number().int(),
  solver_breakdown: z.array(z.object({
    solver: z.string(),
    supported: z.boolean(),
    installed: z.boolean(),
    available: z.boolean(),
    requested_runs: z.number().int(),
  })),
  unavailable: z.array(z.object({
    solver: z.string(),
    reason: z.string(),
  })),
  warnings: z.array(z.string()),
});

export const campaignRunDataSchema = z.object({
  campaign_id: z.string(),
  name: z.string(),
  family: problemFamilySchema,
  requested_runs: z.number().int(),
  completed_runs: z.number().int(),
  problem_ids: z.array(z.string()),
  run_ids: z.array(z.string()),
  status_summary: z.object({
    success: z.number().int(),
    failed: z.number().int(),
    skipped: z.number().int(),
    unavailable: z.number().int(),
  }),
});

export const campaignListItemSchema = z.object({
  campaign_id: z.string(),
  name: z.string(),
  family: problemFamilySchema,
  created_at: z.string(),
});

export const analyzeQuerySchema = z.object({
  run_ids: z.array(z.string()).optional(),
  campaign_id: z.string().optional(),
  group_by: z.array(z.string()).min(1).max(8).optional(),
  filters: z.record(z.string(), z.string()).optional(),
  scaling_x: z.string().optional(),
  include_failed: z.boolean().optional(),
  include_unavailable: z.boolean().optional(),
  compare: z.enum(["classical_vs_quantum", "qiskit_vs_cudaq", "gpu_vs_cpu"]).optional(),
});

export type AnalyzeQuery = z.infer<typeof analyzeQuerySchema>;

export const reportFormatsSchema = z.array(z.enum(["json", "csv", "markdown", "plots"])).min(1);

export interface ParsedEnvelope {
  command: string;
  status: EnvelopeStatus;
  data: unknown;
  warnings: StructuredWarning[];
  error: StructuredError | undefined;
  raw: Envelope;
}

/** The only schema version this plugin accepts. */
export const SUPPORTED_SCHEMA_VERSION = "1";

/** Compatibility metadata, mirrored here for the schema module. */
export const BB_PLUGIN_VARIAQ_VERSION = "0.5.1";
export const VERIFIED_VARIAQ_VERSION = "0.6.0";
export const SUPPORTED_VARIAQ_SERIES = "0.6.x";

/**
 * Validate a VariaQ JSON envelope.
 *
 * - Rejects non-JSON, non-object, or missing required fields.
 * - Rejects unsupported schema versions (including future versions) with a
 *   clear compatibility error rather than silently parsing them.
 * - Returns a normalized ParsedEnvelope where `warnings` is always an array.
 */
export function validateEnvelope(raw: string): ParsedEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `VariaQ output is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const envelope = envelopeSchema.safeParse(parsed);
  if (!envelope.success) {
    throw new Error(
      `VariaQ output is not a valid schema-v1 envelope: ${envelope.error.message}`,
    );
  }

  if (envelope.data.schema_version !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported VariaQ output schema_version: ${envelope.data.schema_version}; ` +
        `bb-plugin-variaq ${BB_PLUGIN_VARIAQ_VERSION} supports schema_version ${SUPPORTED_SCHEMA_VERSION}.`,
    );
  }

  return {
    command: envelope.data.command,
    status: envelope.data.status,
    data: envelope.data.data,
    warnings: envelope.data.warnings ?? [],
    error: envelope.data.error,
    raw: envelope.data,
  };
}
