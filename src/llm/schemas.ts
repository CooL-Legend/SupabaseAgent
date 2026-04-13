import { z } from "zod";

export const coercionTypeSchema = z.enum([
  "string",
  "number",
  "integer",
  "boolean",
  "date",
  "timestamp",
  "json",
  "uuid",
]);

export const mappingDecisionResponseSchema = z.object({
  selectedMappings: z
    .array(
      z.object({
        sourceColumn: z.string().min(1),
        targetColumn: z.string().min(1),
        coerceTo: coercionTypeSchema.optional(),
        reason: z.string().optional(),
      }),
    )
    .default([]),
  droppedColumns: z
    .array(
      z.object({
        column: z.string().min(1),
        reason: z.string().min(1),
      }),
    )
    .default([]),
  warnings: z.array(z.string()).default([]),
});

export const debugFixResponseSchema = z.object({
  diagnosis: z.string().min(1),
  fixType: z.enum([
    "cast",
    "nullify",
    "truncate",
    "rename",
    "skip",
    "alter_column",
  ]),
  fix: z.record(z.unknown()).optional(),
  sql: z.string().optional(),
});

export type MappingDecisionResponse = z.infer<typeof mappingDecisionResponseSchema>;
export type DebugFixResponse = z.infer<typeof debugFixResponseSchema>;
