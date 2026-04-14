import type {
  CSVProfile,
  DryRunResult,
  EvalIssue,
  EvalResult,
  MappingEntry,
  MappingResult,
  TableSchema,
  TransformFailure,
  TransformSpec,
  TransformValidationResult,
} from "./types";
import pg from "pg";

// ─── Type Compatibility Check ───────────────────────────────
function testCast(value: string, transformation: string): boolean {
  if (!value || value.trim() === "") return true;
  try {
    switch (transformation) {
      case "to_integer": { const n = Number(value.replace(/,/g, "")); return Number.isInteger(n); }
      case "to_number": { const n = Number(value.replace(/[$€£¥₹,]/g, "")); return !isNaN(n); }
      case "to_boolean": return /^(true|false|yes|no|y|n|1|0|active|inactive)$/i.test(value.trim());
      case "to_date": return !isNaN(new Date(value).getTime());
      case "to_timestamp": return !isNaN(new Date(value).getTime());
      case "to_uuid": return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
      case "to_json": { JSON.parse(value); return true; }
      case "to_array": { try { JSON.parse(value); return true; } catch { return value.includes(","); } }
      case "none": return true;
      default: return true;
    }
  } catch {
    return false;
  }
}

function scoreTypeCast(mapping: MappingEntry, csvValues: string[]): number {
  if (mapping.transformation === "none") return 1.0;
  const sample = csvValues.filter((v) => v && v.trim() !== "").slice(0, 20);
  if (sample.length === 0) return 1.0;
  const passed = sample.filter((v) => testCast(v, mapping.transformation)).length;
  const rate = passed / sample.length;
  if (rate >= 0.95) return 1.0;
  if (rate >= 0.80) return 0.7;
  if (rate >= 0.50) return 0.3;
  return 0.0;
}

// ─── Evaluate Mapping ───────────────────────────────────────
export function evaluateMapping(
  mapping: MappingResult,
  csvProfile: CSVProfile,
  schema: TableSchema,
  csvRows: Record<string, string>[],
): EvalResult {
  const issues: EvalIssue[] = [];
  const suggestions: string[] = [];

  // 1. Type compatibility (weight 0.30)
  let typeScoreSum = 0;
  for (const m of mapping.columnMappings) {
    const values = csvRows.map((r) => String(r[m.csvColumn] ?? ""));
    const score = scoreTypeCast(m, values);
    typeScoreSum += score;

    if (score < 0.7) {
      const failSamples = values.filter((v) => v && !testCast(v, m.transformation)).slice(0, 3);
      issues.push({
        severity: score === 0 ? "critical" : "warning",
        column: m.csvColumn,
        issue: `Type cast "${m.transformation}" fails on ${((1 - score) * 100).toFixed(0)}% of values. Examples: ${failSamples.map((s) => `"${s}"`).join(", ")}`,
        suggestedFix: `Reconsider transformation for "${m.csvColumn}" → "${m.dbColumn}". Check if data needs cleaning first.`,
      });
      suggestions.push(`Fix type mismatch on ${m.csvColumn}: cast ${m.transformation} has high failure rate.`);
    }
  }
  const typeScore = mapping.columnMappings.length > 0 ? typeScoreSum / mapping.columnMappings.length : 1;

  // 2. Null coverage (weight 0.20)
  let nullScore = 1.0;
  const notNullCols = schema.columns.filter((c) => c.is_nullable === "NO" && !c.column_default);
  for (const dbCol of notNullCols) {
    const mapped = mapping.columnMappings.find((m) => m.dbColumn === dbCol.column_name);
    if (!mapped) continue;
    const csvCol = csvProfile.columns.find((c) => c.name === mapped.csvColumn);
    if (csvCol && csvCol.nullRate > 0.2) {
      nullScore -= 0.3;
      issues.push({
        severity: csvCol.nullRate > 0.5 ? "critical" : "warning",
        column: mapped.csvColumn,
        issue: `${(csvCol.nullRate * 100).toFixed(0)}% null rate on CSV column mapping to NOT NULL DB column "${dbCol.column_name}"`,
        suggestedFix: `Consider a default value or transformation to handle nulls in "${mapped.csvColumn}".`,
      });
    }
  }
  nullScore = Math.max(0, nullScore);

  // 3. Unique compliance (weight 0.15)
  let uniqueScore = 1.0;
  const allUniqueGroups = [schema.primaryKey, ...schema.uniqueConstraints].filter((g) => g.length > 0);
  for (const group of allUniqueGroups) {
    for (const uCol of group) {
      const mapped = mapping.columnMappings.find((m) => m.dbColumn === uCol);
      if (!mapped) continue;
      const csvCol = csvProfile.columns.find((c) => c.name === mapped.csvColumn);
      if (csvCol && csvCol.uniqueCount < csvCol.totalCount - csvCol.totalCount * csvCol.nullRate) {
        uniqueScore -= 0.4;
        issues.push({
          severity: "critical",
          column: mapped.csvColumn,
          issue: `CSV column "${mapped.csvColumn}" has ${csvCol.uniqueCount} unique values out of ${csvCol.totalCount} rows, but DB column "${uCol}" requires uniqueness.`,
          suggestedFix: `Deduplicate CSV data or choose a different conflict resolution strategy for "${uCol}".`,
        });
      }
    }
  }
  uniqueScore = Math.max(0, uniqueScore);

  // 4. Required coverage (weight 0.25)
  let requiredScore = 1.0;
  const requiredCols = schema.columns.filter((c) => c.is_nullable === "NO" && !c.column_default);
  for (const rc of requiredCols) {
    const mapped = mapping.columnMappings.find((m) => m.dbColumn === rc.column_name);
    if (!mapped) {
      requiredScore -= 1.0 / requiredCols.length;
      issues.push({
        severity: "critical",
        column: rc.column_name,
        issue: `Required column "${rc.column_name}" (NOT NULL, no default) has no CSV mapping.`,
        suggestedFix: `Find a CSV column that could map to "${rc.column_name}" or ensure the column has a default value in the DB.`,
      });
      suggestions.push(`Critical: required column "${rc.column_name}" is unmapped.`);
    }
  }
  requiredScore = Math.max(0, requiredScore);

  // 5. Confidence average (weight 0.10)
  const confAvg =
    mapping.columnMappings.length > 0
      ? mapping.columnMappings.reduce((sum, m) => sum + m.confidence, 0) / mapping.columnMappings.length
      : 0;

  for (const m of mapping.columnMappings) {
    if (m.confidence < 0.7) {
      issues.push({
        severity: "warning",
        column: m.csvColumn,
        issue: `Low confidence (${m.confidence.toFixed(2)}) mapping "${m.csvColumn}" → "${m.dbColumn}": ${m.reasoning}`,
        suggestedFix: `Review if "${m.csvColumn}" truly corresponds to "${m.dbColumn}". Check data samples.`,
      });
    }
  }

  // Check string truncation
  for (const m of mapping.columnMappings) {
    const dbCol = schema.columns.find((c) => c.column_name === m.dbColumn);
    const csvCol = csvProfile.columns.find((c) => c.name === m.csvColumn);
    if (dbCol?.character_maximum_length && csvCol && csvCol.maxLength > dbCol.character_maximum_length) {
      issues.push({
        severity: "warning",
        column: m.csvColumn,
        issue: `CSV values up to ${csvCol.maxLength} chars but DB column "${m.dbColumn}" max length is ${dbCol.character_maximum_length}.`,
        suggestedFix: `Add truncation transformation for "${m.csvColumn}".`,
      });
    }
  }

  const score =
    typeScore * 0.3 +
    nullScore * 0.2 +
    uniqueScore * 0.15 +
    requiredScore * 0.25 +
    confAvg * 0.1;

  return {
    score: Math.min(1, Math.max(0, score)),
    passed: score >= 0.8 && !issues.some((i) => i.severity === "critical"),
    breakdown: {
      typeCompatibility: typeScore,
      nullCoverage: nullScore,
      uniqueCompliance: uniqueScore,
      requiredCoverage: requiredScore,
      confidenceAvg: confAvg,
    },
    issues: issues.sort((a, b) => {
      const order = { critical: 0, warning: 1, info: 2 };
      return order[a.severity] - order[b.severity];
    }),
    suggestions,
  };
}

// ─── Transform Output Validation ────────────────────────────
// Runs transforms on ALL rows and checks outputs match DB types
export function validateTransformOutput(
  rows: Record<string, string>[],
  transforms: TransformSpec[],
  schema: TableSchema,
): TransformValidationResult {
  const failuresByColumn: Record<string, { count: number; rate: number; examples: TransformFailure[] }> = {};
  let totalPassed = 0;

  for (let i = 0; i < rows.length; i++) {
    let rowOk = true;

    for (const spec of transforms) {
      const raw = rows[i][spec.csvColumn];
      let output: unknown;

      // Execute transform
      try {
        const fn = new Function("value", spec.code) as (v: string) => unknown;
        output = fn(raw?.trim() ?? "");
      } catch (e: any) {
        addFailure(failuresByColumn, spec.dbColumn, {
          rowIndex: i, column: spec.dbColumn, inputValue: raw ?? "",
          outputValue: null, error: `Transform threw: ${e.message}`,
        });
        rowOk = false;
        continue;
      }

      // Find the DB column definition
      const dbCol = schema.columns.find((c) => c.column_name === spec.dbColumn);
      if (!dbCol) continue;

      // Check NULL on NOT NULL column
      if ((output === null || output === undefined) && dbCol.is_nullable === "NO" && !dbCol.column_default) {
        addFailure(failuresByColumn, spec.dbColumn, {
          rowIndex: i, column: spec.dbColumn, inputValue: raw ?? "",
          outputValue: output, error: `NULL output for NOT NULL column without default`,
        });
        rowOk = false;
        continue;
      }

      if (output === null || output === undefined) continue;

      // Type checks
      const dt = dbCol.data_type.toLowerCase();
      const udt = (dbCol.udt_name || "").toLowerCase();

      if (["integer", "bigint", "smallint"].includes(dt) || ["int4", "int8", "int2"].includes(udt)) {
        if (typeof output !== "number" || isNaN(output)) {
          addFailure(failuresByColumn, spec.dbColumn, {
            rowIndex: i, column: spec.dbColumn, inputValue: raw ?? "",
            outputValue: output, error: `Expected integer, got ${typeof output}: ${JSON.stringify(output)}`,
          });
          rowOk = false;
        }
      } else if (["numeric", "real", "double precision"].includes(dt) || ["numeric", "float4", "float8"].includes(udt)) {
        if (typeof output !== "number" || isNaN(output)) {
          addFailure(failuresByColumn, spec.dbColumn, {
            rowIndex: i, column: spec.dbColumn, inputValue: raw ?? "",
            outputValue: output, error: `Expected number, got ${typeof output}: ${JSON.stringify(output)}`,
          });
          rowOk = false;
        }
      } else if (dt === "boolean" || udt === "bool") {
        if (typeof output !== "boolean") {
          addFailure(failuresByColumn, spec.dbColumn, {
            rowIndex: i, column: spec.dbColumn, inputValue: raw ?? "",
            outputValue: output, error: `Expected boolean, got ${typeof output}: ${JSON.stringify(output)}`,
          });
          rowOk = false;
        }
      }

      // String length check
      if (dbCol.character_maximum_length && typeof output === "string" && output.length > dbCol.character_maximum_length) {
        addFailure(failuresByColumn, spec.dbColumn, {
          rowIndex: i, column: spec.dbColumn, inputValue: raw ?? "",
          outputValue: output, error: `String length ${output.length} exceeds max ${dbCol.character_maximum_length}`,
        });
        rowOk = false;
      }
    }

    if (rowOk) totalPassed++;
  }

  // Compute rates
  for (const col of Object.keys(failuresByColumn)) {
    failuresByColumn[col].rate = failuresByColumn[col].count / rows.length;
  }

  const hasFailures = Object.values(failuresByColumn).some((f) => f.rate > 0.05);

  return {
    success: !hasFailures,
    totalRows: rows.length,
    passedRows: totalPassed,
    failuresByColumn,
  };
}

function addFailure(
  map: Record<string, { count: number; rate: number; examples: TransformFailure[] }>,
  column: string,
  failure: TransformFailure,
) {
  if (!map[column]) map[column] = { count: 0, rate: 0, examples: [] };
  map[column].count++;
  if (map[column].examples.length < 5) map[column].examples.push(failure);
}

// ─── Stratified Sample Picker ───────────────────────────────
// Picks rows from start, middle, end, plus outlier rows
export function pickStratifiedSample(
  rows: Record<string, unknown>[],
  maxSample = 50,
): Record<string, unknown>[] {
  if (rows.length <= maxSample) return rows;

  const indices = new Set<number>();
  const len = rows.length;

  // First 10
  for (let i = 0; i < Math.min(10, len); i++) indices.add(i);
  // Last 10
  for (let i = Math.max(0, len - 10); i < len; i++) indices.add(i);
  // Evenly spaced from middle
  const remaining = maxSample - indices.size;
  if (remaining > 0) {
    const step = Math.floor(len / remaining);
    for (let i = 0; i < len && indices.size < maxSample; i += step) {
      indices.add(i);
    }
  }
  // Random fill if still short
  while (indices.size < maxSample && indices.size < len) {
    indices.add(Math.floor(Math.random() * len));
  }

  return [...indices].sort((a, b) => a - b).map((i) => rows[i]);
}

// ─── Dry Run (test INSERT with ROLLBACK) ────────────────────
export async function dryRunInsert(
  pool: pg.Pool,
  tableName: string,
  transformedRows: Record<string, unknown>[],
  conflictKeys: string[],
): Promise<DryRunResult> {
  const sample = pickStratifiedSample(transformedRows);
  const errors: DryRunResult["errors"] = [];
  let passed = 0;

  const client = await pool.connect();
  try {
    for (let i = 0; i < sample.length; i++) {
      const row = sample[i];
      const cols = Object.keys(row);
      const vals = Object.values(row);
      const placeholders = vals.map((_, idx) => `$${idx + 1}`);

      const onConflict = conflictKeys.length
        ? ` ON CONFLICT (${conflictKeys.join(",")}) DO UPDATE SET ${cols.filter((c) => !conflictKeys.includes(c)).map((c) => `"${c}" = EXCLUDED."${c}"`).join(", ")}`
        : "";

      try {
        await client.query("BEGIN");
        await client.query("SAVEPOINT dry_run");
        await client.query(
          `INSERT INTO "${tableName}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${placeholders.join(",")})${onConflict}`,
          vals,
        );
        await client.query("ROLLBACK TO SAVEPOINT dry_run");
        await client.query("COMMIT");
        passed++;
      } catch (err: any) {
        try { await client.query("ROLLBACK"); } catch {}
        errors.push({ rowIndex: i, error: err.message || String(err), row });
      }
    }
  } finally {
    client.release();
  }

  return {
    success: errors.length === 0,
    rowsTested: sample.length,
    rowsPassed: passed,
    errors,
  };
}
