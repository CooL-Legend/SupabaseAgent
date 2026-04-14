import type { ColumnProfile, CSVProfile, InferredType, NumericStats, TopValue } from "./types";

const TYPE_PATTERNS: { type: InferredType; re: RegExp }[] = [
  { type: "uuid", re: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i },
  { type: "email", re: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
  { type: "url", re: /^https?:\/\/.+/i },
  { type: "timestamp", re: /^\d{4}[-/]\d{1,2}[-/]\d{1,2}[T ]\d{1,2}:\d{1,2}/ },
  { type: "date", re: /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/ },
  { type: "boolean", re: /^(true|false|yes|no|y|n|1|0|active|inactive)$/i },
  { type: "phone", re: /^[+\d][\d\s().-]{6,}$/ },
  { type: "currency", re: /^[$€£¥₹]\s?[\d,]+\.?\d*$/ },
  { type: "integer", re: /^-?\d{1,18}$/ },
  { type: "number", re: /^-?\d{0,18}\.\d+$/ },
];

const NULL_VARIANTS = new Set(["", "null", "none", "n/a", "na", "nil", "-", "undefined", "nan"]);

function isNullish(v: string): boolean {
  return NULL_VARIANTS.has(v.trim().toLowerCase());
}

function detectPatterns(values: string[]): string[] {
  const patterns: string[] = [];
  const live = values.filter((v) => !isNullish(v));
  if (live.length === 0) return ["all_null"];

  if (live.some((v) => /^\d{2}\/\d{2}\/\d{4}$/.test(v))) patterns.push("MM/DD/YYYY");
  if (live.some((v) => /^\d{2}-\d{2}-\d{4}$/.test(v))) patterns.push("DD-MM-YYYY");
  if (live.some((v) => /^\d{4}-\d{2}-\d{2}$/.test(v))) patterns.push("ISO-8601-date");
  if (live.some((v) => /^\d{10,13}$/.test(v))) patterns.push("unix-epoch");
  if (live.some((v) => /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(v))) patterns.push("comma-separated-number");
  if (live.some((v) => /^[$€£¥₹]/.test(v))) patterns.push("currency-prefixed");
  if (live.some((v) => /^0\d+$/.test(v))) patterns.push("leading-zeros");
  if (live.some((v) => v.length > 200)) patterns.push("long-text");
  if (live.some((v) => v.includes("\n"))) patterns.push("multiline");
  if (live.some((v) => { try { const p = JSON.parse(v); return typeof p === "object"; } catch { return false; } }))
    patterns.push("json-content");

  return patterns;
}

function inferType(values: string[]): InferredType {
  const live = values.filter((v) => !isNullish(v));
  if (live.length === 0) return "unknown";

  const jsonRate = live.filter((v) => {
    try { const p = JSON.parse(v); return typeof p === "object" && p !== null; } catch { return false; }
  }).length / live.length;
  if (jsonRate >= 0.8) return "json";

  for (const { type, re } of TYPE_PATTERNS) {
    const matchRate = live.filter((v) => re.test(v.trim())).length / live.length;
    if (matchRate >= 0.8) return type;
  }

  return "string";
}

// ─── Numeric Statistics ─────────────────────────────────────
function extractNumber(v: string): number | null {
  const cleaned = v.replace(/[$€£¥₹,\s]/g, "").trim();
  const n = Number(cleaned);
  return isNaN(n) ? null : n;
}

function computeNumericStats(values: string[]): NumericStats | undefined {
  const nums: number[] = [];
  for (const v of values) {
    if (isNullish(v)) continue;
    const n = extractNumber(v);
    if (n !== null) nums.push(n);
  }
  // Only compute if >60% of values are numeric
  if (nums.length < values.filter((v) => !isNullish(v)).length * 0.6) return undefined;
  if (nums.length === 0) return undefined;

  nums.sort((a, b) => a - b);
  const sum = nums.reduce((s, n) => s + n, 0);
  const len = nums.length;
  const median = len % 2 === 0 ? (nums[len / 2 - 1] + nums[len / 2]) / 2 : nums[Math.floor(len / 2)];
  const p95Idx = Math.min(Math.floor(len * 0.95), len - 1);

  return {
    min: nums[0],
    max: nums[len - 1],
    mean: Math.round((sum / len) * 100) / 100,
    median: Math.round(median * 100) / 100,
    p95: nums[p95Idx],
  };
}

// ─── Top Value Frequency ────────────────────────────────────
function computeTopValues(values: string[], maxEntries = 10): TopValue[] | undefined {
  const live = values.filter((v) => !isNullish(v));
  if (live.length === 0) return undefined;

  const freq = new Map<string, number>();
  for (const v of live) {
    const key = v.trim();
    freq.set(key, (freq.get(key) || 0) + 1);
  }

  // Only show top values for low-cardinality columns (< 50 distinct) or if top value dominates
  const distinct = freq.size;
  const topEntry = [...freq.entries()].sort((a, b) => b[1] - a[1])[0];
  const topPct = topEntry[1] / live.length;

  if (distinct > 50 && topPct < 0.1) return undefined;

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxEntries)
    .map(([value, count]) => ({
      value,
      count,
      pct: Math.round((count / live.length) * 1000) / 10,
    }));
}

// ─── Outlier Detection ──────────────────────────────────────
function detectOutliers(values: string[], stats?: NumericStats): string[] {
  if (!stats) return [];
  const outliers: string[] = [];
  const iqr = stats.p95 - stats.min;
  const upperBound = stats.p95 + iqr * 1.5;
  const lowerBound = stats.min - iqr * 0.5;

  for (const v of values) {
    if (isNullish(v)) continue;
    const n = extractNumber(v);
    if (n !== null && (n > upperBound || n < lowerBound)) {
      if (outliers.length < 5) outliers.push(v);
    }
  }
  return outliers;
}

// ─── Profile Column ─────────────────────────────────────────
function profileColumn(name: string, values: string[]): ColumnProfile {
  const total = values.length;
  const nullCount = values.filter(isNullish).length;
  const live = values.filter((v) => !isNullish(v));
  const lengths = live.map((v) => v.length);

  const numericStats = computeNumericStats(values);
  const topValues = computeTopValues(values);
  const outliers = detectOutliers(values, numericStats);

  return {
    name,
    inferredType: inferType(values),
    nullRate: total > 0 ? nullCount / total : 1,
    uniqueCount: new Set(live).size,
    totalCount: total,
    samples: live.slice(0, 5),
    patterns: detectPatterns(values),
    minLength: lengths.length > 0 ? Math.min(...lengths) : 0,
    maxLength: lengths.length > 0 ? Math.max(...lengths) : 0,
    hasLeadingZeros: live.some((v) => /^0\d+$/.test(v)),
    hasSpecialChars: live.some((v) => /[^\w\s.,@_\-/]/.test(v)),
    numericStats,
    topValues,
    outliers: outliers.length > 0 ? outliers : undefined,
  };
}

export function profileCSV(headers: string[], rows: Record<string, string>[]): CSVProfile {
  const columns = headers.map((header) => {
    const values = rows.map((r) => String(r[header] ?? ""));
    return profileColumn(header, values);
  });
  return { headers, rowCount: rows.length, columns };
}

export function formatProfileForPrompt(profile: CSVProfile): string {
  let out = `CSV: ${profile.rowCount} rows, ${profile.columns.length} columns\n\n`;

  for (const col of profile.columns) {
    out += `Column: "${col.name}"\n`;
    out += `  Inferred type: ${col.inferredType}\n`;
    out += `  Null rate: ${(col.nullRate * 100).toFixed(1)}%\n`;
    out += `  Unique values: ${col.uniqueCount}/${col.totalCount}\n`;
    out += `  Length range: ${col.minLength}-${col.maxLength}\n`;
    if (col.patterns.length) out += `  Patterns: ${col.patterns.join(", ")}\n`;
    if (col.hasLeadingZeros) out += `  ⚠ Has leading zeros\n`;
    out += `  Samples: ${col.samples.map((s) => `"${s}"`).join(", ")}\n`;

    // Numeric stats
    if (col.numericStats) {
      const s = col.numericStats;
      out += `  Numeric range: ${s.min} → ${s.max} (mean: ${s.mean}, median: ${s.median}, p95: ${s.p95})\n`;
    }

    // Top values (categorical distribution)
    if (col.topValues && col.topValues.length > 0) {
      out += `  Value distribution:\n`;
      for (const tv of col.topValues.slice(0, 8)) {
        out += `    "${tv.value}": ${tv.count} (${tv.pct}%)\n`;
      }
      if (col.topValues.length > 8) out += `    ... and ${col.topValues.length - 8} more\n`;
    }

    // Outliers
    if (col.outliers && col.outliers.length > 0) {
      out += `  ⚠ Outliers detected: ${col.outliers.map((o) => `"${o}"`).join(", ")}\n`;
    }

    out += "\n";
  }

  return out;
}

export function formatSchemaForPrompt(tableName: string, schema: import("./types").TableSchema): string {
  let out = `Table: "${tableName}"\n`;
  out += `Primary Key: [${schema.primaryKey.join(", ")}]\n`;
  if (schema.uniqueConstraints.length)
    out += `Unique Constraints: ${schema.uniqueConstraints.map((u) => `[${u.join(", ")}]`).join(", ")}\n`;
  out += `\nColumns:\n`;

  for (const c of schema.columns) {
    let line = `  - ${c.column_name}: ${c.data_type}`;
    if (c.udt_name && c.udt_name !== c.data_type) line += ` (${c.udt_name})`;
    if (c.is_nullable === "NO") line += " NOT NULL";
    if (c.column_default) line += ` DEFAULT ${c.column_default}`;
    if (c.character_maximum_length) line += ` max_len=${c.character_maximum_length}`;
    if (schema.primaryKey.includes(c.column_name)) line += " [PK]";
    if (schema.uniqueConstraints.some((u) => u.includes(c.column_name))) line += " [UNIQUE]";
    out += line + "\n";
  }

  return out;
}
