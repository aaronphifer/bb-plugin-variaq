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

/** Validate a problem family name against VariaQ 0.4 generic families. */
export function isProblemFamily(value: string): value is ProblemFamily {
  return PROBLEM_FAMILIES.includes(value as ProblemFamily);
}

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
export const BB_PLUGIN_VARIAQ_VERSION = "0.3.0";
export const VERIFIED_VARIAQ_VERSION = "0.4.1";
export const SUPPORTED_VARIAQ_SERIES = "0.4.x";

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
