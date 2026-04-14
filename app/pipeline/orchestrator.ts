import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import pg from "pg";

import type {
  PipelineInput,
  PipelineResult,
  MappingResult,
  MappingEntry,
  ReflectionEntry,
  TransformSpec,
  PreflightReport,
  EvalResult,
  Verdict,
  HumanFeedback,
  TransformValidationResult,
} from "./types";
import { callGemini } from "./gemini";
import { profileCSV, formatProfileForPrompt, formatSchemaForPrompt } from "./profiler";
import { evaluateMapping, dryRunInsert, validateTransformOutput, pickStratifiedSample } from "./evaluator";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RULES_DIR = join(__dirname, "..", "rules");
const LOGS_DIR = join(__dirname, "..", "logs");

function loadRule(name: string): string {
  try { return readFileSync(join(RULES_DIR, name), "utf8"); } catch { return ""; }
}

function saveReflectionLog(sessionId: string, log: ReflectionEntry[]): void {
  mkdirSync(LOGS_DIR, { recursive: true });
  const lines = [`# Reflection Log — ${sessionId}\n`, `Generated: ${new Date().toISOString()}\n`];
  for (const entry of log) {
    lines.push(`\n## Turn ${entry.turn} (${entry.phase})`);
    lines.push(`- Time: ${entry.timestamp}`);
    lines.push(`- Score: ${entry.evalScore.toFixed(3)}`);
    lines.push(`- Outcome: ${entry.outcome}`);
    if (entry.issues.length) {
      lines.push(`- Issues:`);
      entry.issues.forEach((i) => lines.push(`  - ${i}`));
    }
    if (entry.adjustments.length) {
      lines.push(`- Adjustments for next turn:`);
      entry.adjustments.forEach((a) => lines.push(`  - ${a}`));
    }
  }
  writeFileSync(join(LOGS_DIR, `reflection_${sessionId}.md`), lines.join("\n"), "utf8");
}

// ═══════════════════════════════════════════════════════════════
// PROMPT BUILDERS
// ═══════════════════════════════════════════════════════════════

function buildMappingPrompt(
  tableName: string,
  csvProfileText: string,
  schemaText: string,
  rules: string,
  priorReflections: ReflectionEntry[],
  humanFeedback?: HumanFeedback[],
): string {
  const tableKnowledge = loadRule(`${tableName.toUpperCase()}_SCHEMA.md`);

  let prompt = `You are a Senior Data Mapping Specialist with deep expertise in PostgreSQL, data cleaning, and ETL pipelines. Your task: map CSV columns to database columns with the precision of a staff engineer who has seen thousands of messy CSVs.

## STRICT RULES
${rules}
`;

  if (tableKnowledge) {
    prompt += `
## TABLE-SPECIFIC DEEP KNOWLEDGE (this is your expert reference — use it heavily)
${tableKnowledge}
`;
  }

  prompt += `
## DATABASE SCHEMA
${schemaText}

## CSV DATA PROFILE (machine-analyzed)
${csvProfileText}

## CHAIN-OF-THOUGHT INSTRUCTIONS
Think step by step for EVERY column:

STEP 1 — SCAN: Read every CSV column name and its sample values carefully.
STEP 2 — MATCH: For each CSV column, search the DB schema for the best match:
  a) Exact name match (case-insensitive) → confidence 0.95+
  b) Name variant match (e.g., "product_name" → "title", "img" → "image_url") → confidence 0.80-0.95
  c) Semantic match using sample values (e.g., values look like URLs → image_url/product_url) → confidence 0.65-0.80
  d) No match → add to unmappedCsvColumns
STEP 3 — TRANSFORM: For each match, determine the EXACT transformation:
  - Is the CSV value directly insertable into the DB column type?
  - Does it need type casting? Currency stripping? Format conversion?
  - Check for hidden types: Unix epochs, comma-numbers, currency symbols, boolean variants
  - Check for separator differences: CSV uses "," but DB expects " | "
STEP 4 — VALIDATE: For each match, check for risks:
  - Will this cause NOT NULL violations?
  - Will UNIQUE/PRIMARY KEY constraints fail?
  - Will values exceed VARCHAR max length?
  - Are there null rate concerns?
STEP 5 — SKIP: Identify DB columns that should NOT be imported from CSV:
  - Auto-generated columns (UUIDs with defaults, timestamps with now())
  - ML/computed columns (embeddings, vectors)
  - System columns

For EVERY mapping, the "reasoning" field must explain your FULL chain of thought — not just "exact match" but WHY this CSV column semantically corresponds to this DB column.
`;

  // ── Human Feedback (HIGHEST PRIORITY) ──────────────────────
  if (humanFeedback && humanFeedback.length > 0) {
    prompt += `\n## ⚠️ HUMAN FEEDBACK (HIGHEST PRIORITY — override everything else)\n`;
    prompt += `The human operator has reviewed your previous output and provided corrections. You MUST follow this feedback exactly:\n\n`;
    for (const fb of humanFeedback) {
      prompt += `> "${fb.text}"\n> (Turn ${fb.turn}, ${fb.timestamp})\n\n`;
    }
    prompt += `These corrections take ABSOLUTE priority over rules, knowledge, and your own judgment. Apply them.\n`;
  }

  // ── Prior Reflections ──────────────────────────────────────
  if (priorReflections.length > 0) {
    prompt += `\n## CRITICAL: PRIOR EVALUATION FEEDBACK (you MUST address these issues)\n`;
    prompt += `Previous attempts failed evaluation. Here is what went wrong:\n\n`;
    for (const r of priorReflections) {
      prompt += `### Turn ${r.turn} — Score: ${r.evalScore.toFixed(3)} — ${r.outcome}\n`;
      if (r.issues.length) {
        prompt += `Issues found:\n`;
        r.issues.forEach((i) => (prompt += `  - ${i}\n`));
      }
      if (r.adjustments.length) {
        prompt += `Required adjustments:\n`;
        r.adjustments.forEach((a) => (prompt += `  - ${a}\n`));
      }
      prompt += `\n`;
    }
    prompt += `You MUST fix ALL issues listed above in this attempt. Do not repeat the same mistakes.\n`;
  }

  prompt += `
## REQUIRED OUTPUT FORMAT (JSON only)
{
  "columnMappings": [
    {
      "csvColumn": "csv_col",
      "dbColumn": "db_col",
      "confidence": 0.95,
      "transformation": "none|to_number|to_integer|to_boolean|to_date|to_timestamp|to_uuid|to_json|to_array|custom",
      "reasoning": "WHY this match was chosen — be specific",
      "risks": ["list any risks with this mapping"]
    }
  ],
  "unmappedCsvColumns": [
    { "column": "col", "reason": "why no match" }
  ],
  "missingDbColumns": [
    { "column": "col", "type": "db_type", "nullable": true, "hasDefault": false, "severity": "critical|warning|info" }
  ],
  "warnings": ["general warnings about the ingestion"]
}`;

  return prompt;
}

function buildTransformPrompt(
  mapping: MappingResult,
  csvProfileText: string,
  schemaText: string,
  priorErrors?: string,
): string {
  const mappingsJson = JSON.stringify(mapping.columnMappings, null, 2);
  let prompt = `You are a Data Transformation Engineer. Given the column mapping below, generate specific TypeScript transformation code for each column.

## Column Mappings
${mappingsJson}

## CSV Profile
${csvProfileText}

## DB Schema
${schemaText}

For each mapped column, generate a transformation spec. The "code" field should be a valid TypeScript arrow function body that takes (value: string) and returns the transformed value.

Handle edge cases:
- Empty strings → null
- "N/A", "null", "None", "-" → null
- Currency symbols → strip then parse
- Comma-separated numbers → strip commas
- Date format differences → normalize to ISO
- Boolean variants → normalize to true/false
- Leading/trailing whitespace → trim

Return JSON array:
[
  {
    "csvColumn": "col",
    "dbColumn": "db_col",
    "code": "const v = value?.trim(); if (!v || v === 'N/A') return null; return v;",
    "description": "what this transform does"
  }
]`;

  if (priorErrors) {
    prompt += `

## ⚠️ CRITICAL: YOUR PREVIOUS TRANSFORMS HAD ERRORS
The transforms you generated last time failed validation. Here are the exact errors:

${priorErrors}

You MUST fix these errors. Study each failing input value and write transforms that handle them correctly. Do NOT repeat the same mistakes.`;
  }

  return prompt;
}

function buildDryRunFixPrompt(
  transforms: TransformSpec[],
  dryRunErrors: { rowIndex: number; error: string; row: Record<string, unknown> }[],
  schemaText: string,
): string {
  const errorExamples = dryRunErrors.slice(0, 5).map((e) => ({
    row: e.rowIndex,
    sqlError: e.error,
    data: e.row,
  }));

  return `You are a Data Transformation Engineer fixing failed database INSERTs.

## Current Transforms
${JSON.stringify(transforms, null, 2)}

## DB Schema
${schemaText}

## INSERT ERRORS (these rows failed when inserted into the real database)
${JSON.stringify(errorExamples, null, 2)}

Study each SQL error carefully. The errors come from the REAL database — they are authoritative.
Common causes:
- Wrong data type (string where number expected)
- Value too long for VARCHAR column
- NULL in NOT NULL column
- Invalid format for UUID/date/timestamp

Fix the transforms so these rows would succeed. Return the COMPLETE updated transforms array (all transforms, not just the fixed ones):
[
  {
    "csvColumn": "col",
    "dbColumn": "db_col",
    "code": "fixed transform code here",
    "description": "what this transform does"
  }
]`;
}

// ═══════════════════════════════════════════════════════════════
// TRANSFORM ENGINE
// ═══════════════════════════════════════════════════════════════

function applyTransform(value: string | null | undefined, spec: TransformSpec): unknown {
  if (value === null || value === undefined) return null;
  const v = value.trim();
  if (!v || ["", "null", "none", "n/a", "na", "nil", "-", "undefined"].includes(v.toLowerCase()))
    return null;

  try {
    const fn = new Function("value", spec.code) as (v: string) => unknown;
    return fn(v);
  } catch {
    return v;
  }
}

export function transformRows(
  rows: Record<string, string>[],
  specs: TransformSpec[],
): Record<string, unknown>[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const spec of specs) {
      out[spec.dbColumn] = applyTransform(row[spec.csvColumn], spec);
    }
    return out;
  });
}

// ═══════════════════════════════════════════════════════════════
// AUTO-VERDICT
// ═══════════════════════════════════════════════════════════════

function computeVerdict(
  evalResult: EvalResult,
  transformValidation: TransformValidationResult | null,
  dryRun: import("./types").DryRunResult | null,
  totalRows: number,
  mappedColumns: number,
): Verdict {
  const problems: string[] = [];

  // Mapping quality
  if (evalResult.score < 0.5) {
    problems.push("Mapping quality is very low — many columns could not be matched");
  }
  const criticalIssues = evalResult.issues.filter((i) => i.severity === "critical");
  if (criticalIssues.length > 0) {
    for (const ci of criticalIssues.slice(0, 3)) {
      problems.push(`${ci.column}: ${ci.issue}`);
    }
  }

  // Transform validation
  if (transformValidation && !transformValidation.success) {
    const badCols = Object.entries(transformValidation.failuresByColumn)
      .filter(([, f]) => f.rate > 0.05);
    for (const [col, f] of badCols.slice(0, 3)) {
      problems.push(`Column "${col}": ${(f.rate * 100).toFixed(0)}% of rows have transform errors (e.g. ${f.examples[0]?.error})`);
    }
  }

  // Dry-run
  if (dryRun && !dryRun.success) {
    const failRate = dryRun.errors.length / dryRun.rowsTested;
    problems.push(`${dryRun.errors.length}/${dryRun.rowsTested} sample rows failed database INSERT (${(failRate * 100).toFixed(0)}% failure)`);
  }

  // Determine status
  const hasCritical = criticalIssues.length > 0;
  const dryRunOk = !dryRun || dryRun.success;
  const transformOk = !transformValidation || transformValidation.success;

  let status: Verdict["status"];
  if (problems.length === 0 && evalResult.score >= 0.8 && dryRunOk && transformOk) {
    status = "safe";
  } else if (hasCritical || evalResult.score < 0.5 || (dryRun && dryRun.rowsPassed < dryRun.rowsTested * 0.5)) {
    status = "blocked";
  } else {
    status = "review";
  }

  // Plain English summary
  let summary: string;
  if (status === "safe") {
    summary = `All ${totalRows} rows mapped correctly to ${mappedColumns} columns. Safe to ingest.`;
  } else if (status === "review") {
    summary = `Mostly good but ${problems.length} issue${problems.length !== 1 ? "s" : ""} found. Review the details below before ingesting.`;
  } else {
    summary = `Cannot ingest safely. ${problems[0]}`;
  }

  return { status, summary, problems, confidence: evalResult.score };
}

// ═══════════════════════════════════════════════════════════════
// FORMAT TRANSFORM ERRORS FOR GEMINI
// ═══════════════════════════════════════════════════════════════

function formatTransformErrors(validation: TransformValidationResult, transforms: TransformSpec[]): string {
  let out = "";
  for (const [col, info] of Object.entries(validation.failuresByColumn)) {
    if (info.rate <= 0.02) continue; // skip trivially low failure rates
    const spec = transforms.find((t) => t.dbColumn === col);
    out += `\n### Column "${col}" — ${(info.rate * 100).toFixed(1)}% failure rate (${info.count}/${validation.totalRows} rows)\n`;
    if (spec) out += `Current transform code: \`${spec.code}\`\n`;
    out += `Failing examples:\n`;
    for (const ex of info.examples.slice(0, 3)) {
      out += `  - Input: "${ex.inputValue}" → Error: ${ex.error}\n`;
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
// MAIN PIPELINE — 3 SELF-HEALING LOOPS
// ═══════════════════════════════════════════════════════════════

export async function runPipeline(
  input: PipelineInput,
  pool: pg.Pool,
  sessionId: string,
  onProgress?: (stage: string, detail: string) => void,
): Promise<PipelineResult> {
  const log = (stage: string, detail: string) => {
    console.log(`  [pipeline:${stage}] ${detail}`);
    onProgress?.(stage, detail);
  };

  const reflectionLog: ReflectionEntry[] = [];
  const mappingRules = loadRule("MAPPING_RULES.md");

  // ═══ Phase 1: Deep Profiling ═══════════════════════════════
  log("profile", "Analyzing CSV data patterns...");
  const csvProfile = profileCSV(input.csvHeaders, input.csvRows);
  const csvProfileText = formatProfileForPrompt(csvProfile);
  const schemaText = formatSchemaForPrompt(input.tableName, input.tableSchema);
  log("profile", `${csvProfile.columns.length} columns profiled, types inferred`);

  // ═══ LOOP 1: Map → Evaluate → Reflect (×5) ════════════════
  let bestMapping: MappingResult | null = null;
  let bestEval: EvalResult | null = null;
  let bestScore = -1;
  const MAX_MAP_TURNS = 5;

  for (let turn = 1; turn <= MAX_MAP_TURNS; turn++) {
    log("mapping", `Turn ${turn}/${MAX_MAP_TURNS} — generating mapping...`);

    const prompt = buildMappingPrompt(
      input.tableName, csvProfileText, schemaText, mappingRules,
      reflectionLog, input.humanFeedback,
    );
    const rawMapping = (await callGemini(prompt)) as MappingResult;

    const mapping: MappingResult = {
      columnMappings: (rawMapping.columnMappings || []).map((m) => ({
        csvColumn: m.csvColumn || "",
        dbColumn: m.dbColumn || "",
        confidence: typeof m.confidence === "number" ? m.confidence : 0.5,
        transformation: m.transformation || "none",
        reasoning: m.reasoning || "",
        risks: Array.isArray(m.risks) ? m.risks : [],
      })),
      unmappedCsvColumns: rawMapping.unmappedCsvColumns || [],
      missingDbColumns: rawMapping.missingDbColumns || [],
      warnings: rawMapping.warnings || [],
    };

    log("mapping", `${mapping.columnMappings.length} mappings generated`);

    log("eval", `Evaluating mapping (turn ${turn})...`);
    const evalResult = evaluateMapping(mapping, csvProfile, input.tableSchema, input.csvRows);

    log("eval", `Score: ${evalResult.score.toFixed(3)} | Pass: ${evalResult.passed} | Issues: ${evalResult.issues.length}`);
    log("eval", `  Type: ${evalResult.breakdown.typeCompatibility.toFixed(2)} | Null: ${evalResult.breakdown.nullCoverage.toFixed(2)} | Unique: ${evalResult.breakdown.uniqueCompliance.toFixed(2)} | Required: ${evalResult.breakdown.requiredCoverage.toFixed(2)} | Conf: ${evalResult.breakdown.confidenceAvg.toFixed(2)}`);

    if (evalResult.score > bestScore) {
      bestScore = evalResult.score;
      bestMapping = mapping;
      bestEval = evalResult;
    }

    const entry: ReflectionEntry = {
      turn,
      timestamp: new Date().toISOString(),
      phase: turn === 1 ? "initial_mapping" : "refined_mapping",
      evalScore: evalResult.score,
      issues: evalResult.issues.map((i) => `[${i.severity}] ${i.column}: ${i.issue}`),
      adjustments: evalResult.suggestions,
      outcome: evalResult.passed ? "PASSED" : `FAILED (${evalResult.issues.filter((i) => i.severity === "critical").length} critical)`,
    };
    reflectionLog.push(entry);

    if (evalResult.passed) {
      log("eval", `✓ Mapping passed evaluation on turn ${turn}`);
      break;
    }

    if (turn === MAX_MAP_TURNS) {
      log("eval", `✗ Max mapping turns reached. Using best mapping (score: ${bestScore.toFixed(3)})`);
    } else {
      log("reflect", `Reflecting on ${evalResult.issues.length} issues for turn ${turn + 1}...`);
    }
  }

  if (!bestMapping || !bestEval) throw new Error("Pipeline failed to produce any mapping");

  // ═══ LOOP 2: Transform → Validate → Reflect (×5) ══════════
  log("transform", "Generating transformation scripts...");
  let transforms: TransformSpec[] = [];
  let transformValidation: TransformValidationResult | null = null;
  const MAX_TRANSFORM_TURNS = 5;

  for (let tTurn = 1; tTurn <= MAX_TRANSFORM_TURNS; tTurn++) {
    if (tTurn > 1) log("transform", `Transform retry ${tTurn}/${MAX_TRANSFORM_TURNS} — fixing errors...`);

    // Build error context from prior validation
    const priorErrors = transformValidation ? formatTransformErrors(transformValidation, transforms) : undefined;

    const transformPrompt = buildTransformPrompt(bestMapping, csvProfileText, schemaText, priorErrors);
    try {
      const result = (await callGemini(transformPrompt)) as TransformSpec[];
      if (Array.isArray(result) && result.length > 0) {
        transforms = result;
      } else if (tTurn === 1) {
        // First turn fallback
        transforms = bestMapping.columnMappings.map((m) => ({
          csvColumn: m.csvColumn,
          dbColumn: m.dbColumn,
          code: generateFallbackTransform(m),
          description: `${m.transformation} transform for ${m.csvColumn}`,
        }));
      }
    } catch {
      if (tTurn === 1) {
        transforms = bestMapping.columnMappings.map((m) => ({
          csvColumn: m.csvColumn,
          dbColumn: m.dbColumn,
          code: generateFallbackTransform(m),
          description: `${m.transformation} transform for ${m.csvColumn}`,
        }));
      }
    }

    log("transform", `${transforms.length} transformation specs generated`);

    // Validate transforms against ALL rows
    log("transform-validate", `Validating transforms against all ${input.csvRows.length} rows...`);
    transformValidation = validateTransformOutput(input.csvRows, transforms, input.tableSchema);
    const passRate = (transformValidation.passedRows / transformValidation.totalRows * 100).toFixed(1);
    log("transform-validate", `${transformValidation.passedRows}/${transformValidation.totalRows} rows passed (${passRate}%)`);

    if (transformValidation.success) {
      log("transform-validate", `✓ Transforms passed validation on turn ${tTurn}`);
      break;
    }

    const badCols = Object.entries(transformValidation.failuresByColumn).filter(([, f]) => f.rate > 0.05);
    log("transform-validate", `✗ ${badCols.length} columns have >5% failure rate`);
    for (const [col, f] of badCols) {
      log("transform-validate", `  ${col}: ${(f.rate * 100).toFixed(1)}% failures — ${f.examples[0]?.error}`);
    }

    if (tTurn === MAX_TRANSFORM_TURNS) {
      log("transform-validate", `✗ Max transform turns reached. Using best transforms.`);
    }

    // Add to reflection log
    reflectionLog.push({
      turn: reflectionLog.length + 1,
      timestamp: new Date().toISOString(),
      phase: "transform_validation",
      evalScore: transformValidation.passedRows / transformValidation.totalRows,
      issues: badCols.map(([col, f]) => `[critical] ${col}: ${(f.rate * 100).toFixed(1)}% failure — ${f.examples[0]?.error}`),
      adjustments: badCols.map(([col]) => `Fix transform for ${col}`),
      outcome: `FAILED (${badCols.length} columns with high failure rate)`,
    });
  }

  // ═══ LOOP 3: DryRun → Fix (×3) ════════════════════════════
  log("dryrun", "Running dry-run INSERT validation...");
  let dryRun: import("./types").DryRunResult | null = null;
  const MAX_DRYRUN_TURNS = 3;

  for (let dTurn = 1; dTurn <= MAX_DRYRUN_TURNS; dTurn++) {
    if (dTurn > 1) log("dryrun", `Dry-run retry ${dTurn}/${MAX_DRYRUN_TURNS} — applying fixes...`);

    try {
      const sampleTransformed = transformRows(input.csvRows, transforms);
      const stratifiedSample = pickStratifiedSample(sampleTransformed);
      dryRun = await dryRunInsert(pool, input.tableName, stratifiedSample, input.tableSchema.primaryKey);
      log("dryrun", `${dryRun.rowsPassed}/${dryRun.rowsTested} rows passed dry-run`);

      if (dryRun.success) {
        log("dryrun", `✓ All dry-run rows passed on turn ${dTurn}`);
        break;
      }

      log("dryrun", `✗ ${dryRun.errors.length} dry-run errors`);
      for (const e of dryRun.errors.slice(0, 3)) {
        log("dryrun", `  Row ${e.rowIndex}: ${e.error}`);
      }

      if (dTurn === MAX_DRYRUN_TURNS) {
        log("dryrun", `✗ Max dry-run turns reached.`);
        break;
      }

      // Feed SQL errors to Gemini to fix transforms
      log("dryrun-fix", "Feeding SQL errors to Gemini for transform fixes...");
      const fixPrompt = buildDryRunFixPrompt(transforms, dryRun.errors, schemaText);
      try {
        const fixedTransforms = (await callGemini(fixPrompt)) as TransformSpec[];
        if (Array.isArray(fixedTransforms) && fixedTransforms.length > 0) {
          transforms = fixedTransforms;
          log("dryrun-fix", `Got ${fixedTransforms.length} fixed transforms from Gemini`);
        }
      } catch (err: any) {
        log("dryrun-fix", `Gemini fix failed: ${err.message}`);
        break;
      }

      // Add to reflection log
      reflectionLog.push({
        turn: reflectionLog.length + 1,
        timestamp: new Date().toISOString(),
        phase: "dryrun_fix",
        evalScore: dryRun.rowsPassed / dryRun.rowsTested,
        issues: dryRun.errors.slice(0, 5).map((e) => `[critical] Row ${e.rowIndex}: ${e.error}`),
        adjustments: ["Fix transforms based on SQL errors"],
        outcome: `FAILED (${dryRun.errors.length}/${dryRun.rowsTested} rows failed INSERT)`,
      });
    } catch (err: any) {
      log("dryrun", `Dry-run error: ${err.message}`);
      break;
    }
  }

  // ═══ Auto-Verdict ══════════════════════════════════════════
  const verdict = computeVerdict(
    bestEval, transformValidation, dryRun,
    input.csvRows.length, bestMapping.columnMappings.length,
  );
  log("verdict", `${verdict.status.toUpperCase()}: ${verdict.summary}`);

  // ═══ Pre-flight Report ═════════════════════════════════════
  const preflight = buildPreflightReport(
    bestMapping, bestEval, transforms, reflectionLog, input, dryRun, transformValidation, verdict,
  );

  saveReflectionLog(sessionId, reflectionLog);
  log("done", `Pipeline complete. Score: ${bestScore.toFixed(3)}, Turns: ${reflectionLog.length}, Verdict: ${verdict.status}`);

  return { sessionId, mapping: bestMapping, preflight };
}

// ═══════════════════════════════════════════════════════════════
// PRE-FLIGHT REPORT
// ═══════════════════════════════════════════════════════════════

function buildPreflightReport(
  mapping: MappingResult,
  eval_: EvalResult,
  transforms: TransformSpec[],
  reflectionLog: ReflectionEntry[],
  input: PipelineInput,
  dryRun: import("./types").DryRunResult | null,
  transformValidation: TransformValidationResult | null,
  verdict: Verdict,
): PreflightReport {
  const successes = mapping.columnMappings
    .filter((m) => m.confidence >= 0.85)
    .map((m) => ({ csvCol: m.csvColumn, dbCol: m.dbColumn, note: m.reasoning }));

  const warnings = mapping.columnMappings
    .filter((m) => m.confidence >= 0.5 && m.confidence < 0.85)
    .map((m) => ({ csvCol: m.csvColumn, dbCol: m.dbColumn, note: `Confidence: ${m.confidence.toFixed(2)} — ${m.reasoning}` }));

  const alerts = mapping.unmappedCsvColumns.map((u) => ({ column: u.column, note: u.reason }));

  const missingRequired = mapping.missingDbColumns
    .filter((m) => m.severity === "critical")
    .map((m) => ({ column: m.column, note: `${m.type}, NOT NULL, no default` }));

  return {
    status: verdict.status === "safe" ? "ready" : verdict.status === "review" ? "needs_review" : "blocked",
    totalRows: input.csvRows.length,
    mappedColumns: mapping.columnMappings.length,
    evalScore: eval_.score,
    turns: reflectionLog.length,
    successes,
    warnings,
    alerts,
    missingRequired,
    transformations: transforms,
    reflectionLog,
    dryRun,
    transformValidation,
    verdict,
  };
}

function generateFallbackTransform(m: MappingEntry): string {
  switch (m.transformation) {
    case "to_integer":
      return `const v = value?.trim(); if (!v || ['', 'null', 'none', 'n/a', '-'].includes(v.toLowerCase())) return null; const n = parseInt(v.replace(/,/g, ''), 10); return isNaN(n) ? null : n;`;
    case "to_number":
      return `const v = value?.trim(); if (!v || ['', 'null', 'none', 'n/a', '-'].includes(v.toLowerCase())) return null; const n = parseFloat(v.replace(/[$€£¥₹,]/g, '')); return isNaN(n) ? null : n;`;
    case "to_boolean":
      return `const v = value?.trim()?.toLowerCase(); if (!v || ['', 'null', 'none', 'n/a'].includes(v)) return null; return ['true', '1', 'yes', 'y', 'active'].includes(v);`;
    case "to_date":
      return `const v = value?.trim(); if (!v || ['', 'null', 'none', 'n/a', '-'].includes(v.toLowerCase())) return null; const d = new Date(v); return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];`;
    case "to_timestamp":
      return `const v = value?.trim(); if (!v || ['', 'null', 'none', 'n/a', '-'].includes(v.toLowerCase())) return null; const d = new Date(v); return isNaN(d.getTime()) ? null : d.toISOString();`;
    case "to_uuid":
      return `const v = value?.trim(); return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v || '') ? v : null;`;
    case "to_json":
      return `const v = value?.trim(); if (!v) return null; try { return JSON.parse(v); } catch { return null; }`;
    case "to_array":
      return `const v = value?.trim(); if (!v) return null; try { return JSON.parse(v); } catch { return v.split(',').map(s => s.trim()); }`;
    default:
      return `const v = value?.trim(); if (!v || ['', 'null', 'none', 'n/a', '-'].includes(v.toLowerCase())) return null; return v;`;
  }
}
