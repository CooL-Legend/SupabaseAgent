import type { SupabaseClient } from "@supabase/supabase-js";

export type PrimitiveType =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "array"
  | "object"
  | "unknown";

export type CoercionType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "date"
  | "timestamp"
  | "json"
  | "uuid";

export interface ColumnProfile {
  name: string;
  inferredType: PrimitiveType;
  nullPct: number;
  uniqueCount: number;
  sample: unknown[];
}

export interface TableReference {
  schema: string;
  name: string;
  fullName: string;
}

export interface TableColumn {
  name: string;
  dataType: string;
  udtName?: string | null;
  isNullable: boolean;
  defaultValue?: string | null;
  maxLength?: number | null;
}

export interface TableKeySet {
  primaryKey: string[];
  uniqueConstraints: string[][];
}

export interface TableSchema {
  table: TableReference;
  columns: TableColumn[];
  keys: TableKeySet;
}

export interface ColumnMappingRule {
  sourceColumn: string;
  targetColumn: string;
  coerceTo?: CoercionType;
  reason?: string;
}

export interface DroppedColumn {
  column: string;
  reason: string;
}

export interface MappingDecision {
  selectedMappings: ColumnMappingRule[];
  droppedColumns: DroppedColumn[];
  warnings: string[];
}

export interface MappingHints {
  includeSourceColumns?: string[];
  excludeSourceColumns?: string[];
  renameOverrides?: Record<string, string>;
  forceCoercions?: Record<string, CoercionType>;
}

export interface AnalysisResult {
  table: TableReference;
  sourceRowCount: number;
  sourceColumns: ColumnProfile[];
  tableSchema: TableSchema;
  mapping: MappingDecision;
}

export interface GeminiJsonRequest {
  systemPrompt: string;
  userPayload: unknown;
  responseSchemaName?: string;
}

export interface GeminiAdapter {
  completeJson(request: GeminiJsonRequest): Promise<unknown>;
}

export interface IngestionInput {
  filePath: string;
  tableName: string;
  conflictKeys: string[];
  mappingHints?: MappingHints;
}

export type DebugFixType =
  | "cast"
  | "nullify"
  | "truncate"
  | "rename"
  | "skip"
  | "alter_column";

export interface DebugFix {
  diagnosis: string;
  fixType: DebugFixType;
  fix?: Record<string, unknown>;
  sql?: string;
}

export interface AppliedFix {
  rowIndex: number;
  fixType: DebugFixType;
  diagnosis: string;
  columns: string[];
}

export interface DatabaseError {
  message: string;
  code?: string;
  details?: string;
  hint?: string;
}

export interface UnresolvedError {
  rowIndex: number;
  row: Record<string, unknown>;
  message: string;
  code?: string;
  details?: string;
}

export interface IngestionReport {
  tableName: string;
  rowsTotal: number;
  rowsPrepared: number;
  rowsUpserted: number;
  rowsSkipped: number;
  droppedSourceColumns: string[];
  appliedFixes: AppliedFix[];
  manualActions: string[];
  unresolvedErrors: UnresolvedError[];
  analysis: AnalysisResult;
}

export interface PreparedRow {
  sourceRowIndex: number;
  row: Record<string, unknown>;
}

export interface RowFailure {
  sourceRowIndex: number;
  row: Record<string, unknown>;
  error: DatabaseError;
}

export interface AgentConfig {
  supabaseClient: SupabaseClient;
  geminiAdapter: GeminiAdapter;
  batchSize?: number;
  maxRetries?: number;
  safeMode?: boolean;
  defaultSchema?: string;
  logger?: (message: string, context?: Record<string, unknown>) => void;
  introspectTableSchema?: (table: TableReference) => Promise<TableSchema>;
}
