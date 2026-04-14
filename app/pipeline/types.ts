// ─── CSV Profiling ──────────────────────────────────────────
export type InferredType =
  | "string" | "integer" | "number" | "boolean" | "date" | "timestamp"
  | "uuid" | "email" | "phone" | "url" | "currency" | "json" | "array" | "unknown";

export interface NumericStats {
  min: number;
  max: number;
  mean: number;
  median: number;
  p95: number;
}

export interface TopValue {
  value: string;
  count: number;
  pct: number;
}

export interface ColumnProfile {
  name: string;
  inferredType: InferredType;
  nullRate: number;
  uniqueCount: number;
  totalCount: number;
  samples: string[];
  patterns: string[];
  minLength: number;
  maxLength: number;
  hasLeadingZeros: boolean;
  hasSpecialChars: boolean;
  numericStats?: NumericStats;
  topValues?: TopValue[];
  outliers?: string[];
}

export interface CSVProfile {
  headers: string[];
  rowCount: number;
  columns: ColumnProfile[];
}

// ─── DB Schema ──────────────────────────────────────────────
export interface DBColumn {
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: string;
  column_default: string | null;
  character_maximum_length: number | null;
}

export interface TableSchema {
  columns: DBColumn[];
  primaryKey: string[];
  uniqueConstraints: string[][];
}

// ─── Mapping ────────────────────────────────────────────────
export interface MappingEntry {
  csvColumn: string;
  dbColumn: string;
  confidence: number;
  transformation: string;
  reasoning: string;
  risks: string[];
}

export interface MappingResult {
  columnMappings: MappingEntry[];
  unmappedCsvColumns: { column: string; reason: string }[];
  missingDbColumns: {
    column: string;
    type: string;
    nullable: boolean;
    hasDefault: boolean;
    severity: "critical" | "warning" | "info";
  }[];
  warnings: string[];
}

// ─── Evaluation ─────────────────────────────────────────────
export interface EvalIssue {
  severity: "critical" | "warning" | "info";
  column: string;
  issue: string;
  suggestedFix: string;
}

export interface EvalResult {
  score: number;
  passed: boolean;
  breakdown: {
    typeCompatibility: number;
    nullCoverage: number;
    uniqueCompliance: number;
    requiredCoverage: number;
    confidenceAvg: number;
  };
  issues: EvalIssue[];
  suggestions: string[];
}

// ─── Transform Validation ───────────────────────────────────
export interface TransformFailure {
  rowIndex: number;
  column: string;
  inputValue: string;
  outputValue: unknown;
  error: string;
}

export interface TransformValidationResult {
  success: boolean;
  totalRows: number;
  passedRows: number;
  failuresByColumn: Record<string, { count: number; rate: number; examples: TransformFailure[] }>;
}

// ─── Dry Run ────────────────────────────────────────────────
export interface DryRunResult {
  success: boolean;
  rowsTested: number;
  rowsPassed: number;
  errors: { rowIndex: number; error: string; row: Record<string, unknown> }[];
}

// ─── Reflection ─────────────────────────────────────────────
export interface ReflectionEntry {
  turn: number;
  timestamp: string;
  phase: string;
  evalScore: number;
  issues: string[];
  adjustments: string[];
  outcome: string;
}

// ─── Human Feedback ─────────────────────────────────────────
export interface HumanFeedback {
  text: string;
  timestamp: string;
  turn: number;
}

// ─── Verdict ────────────────────────────────────────────────
export interface Verdict {
  status: "safe" | "review" | "blocked";
  summary: string;
  problems: string[];
  confidence: number;
}

// ─── Pipeline ───────────────────────────────────────────────
export interface PipelineInput {
  csvHeaders: string[];
  csvRows: Record<string, string>[];
  tableName: string;
  tableSchema: TableSchema;
  humanFeedback?: HumanFeedback[];
}

export interface TransformSpec {
  csvColumn: string;
  dbColumn: string;
  code: string;
  description: string;
}

export interface PreflightReport {
  status: "ready" | "needs_review" | "blocked";
  totalRows: number;
  mappedColumns: number;
  evalScore: number;
  turns: number;
  successes: { csvCol: string; dbCol: string; note: string }[];
  warnings: { csvCol: string; dbCol: string; note: string }[];
  alerts: { column: string; note: string }[];
  missingRequired: { column: string; note: string }[];
  transformations: TransformSpec[];
  reflectionLog: ReflectionEntry[];
  dryRun: DryRunResult | null;
  transformValidation: TransformValidationResult | null;
  verdict: Verdict;
}

export interface PipelineResult {
  sessionId: string;
  mapping: MappingResult;
  preflight: PreflightReport;
}
