import type {
  AnalysisResult,
  DebugFix,
  GeminiAdapter,
  MappingDecision,
} from "../types";
import { DEBUG_SYSTEM_PROMPT, SCHEMA_MAPPING_SYSTEM_PROMPT } from "./prompts";
import { debugFixResponseSchema, mappingDecisionResponseSchema } from "./schemas";

export async function requestMappingDecision(
  adapter: GeminiAdapter,
  payload: {
    sourceColumns: AnalysisResult["sourceColumns"];
    tableSchema: AnalysisResult["tableSchema"];
    mappingHints: unknown;
  },
): Promise<MappingDecision> {
  const raw = await adapter.completeJson({
    systemPrompt: SCHEMA_MAPPING_SYSTEM_PROMPT,
    userPayload: payload,
    responseSchemaName: "mappingDecision",
  });

  const parsed = mappingDecisionResponseSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid mapping decision JSON from Gemini: ${issues}`);
  }

  return parsed.data;
}

export async function requestDebugFix(
  adapter: GeminiAdapter,
  payload: {
    tableSchema: AnalysisResult["tableSchema"];
    error: {
      message: string;
      code?: string;
      details?: string;
    };
    row: Record<string, unknown>;
    priorFixes: DebugFix[];
  },
): Promise<DebugFix> {
  const raw = await adapter.completeJson({
    systemPrompt: DEBUG_SYSTEM_PROMPT,
    userPayload: payload,
    responseSchemaName: "debugFix",
  });

  const parsed = debugFixResponseSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid debug fix JSON from Gemini: ${issues}`);
  }

  return parsed.data;
}
