import express from "express";
import multer from "multer";
import { parse } from "csv-parse/sync";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { runPipeline, transformRows } from "./pipeline/orchestrator";
import { getModelName } from "./pipeline/gemini";
import type { PipelineResult, TransformSpec, HumanFeedback, TableSchema } from "./pipeline/types";

// ─── .env ───────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, "..", ".env");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 1) continue;
  const k = t.slice(0, eq).trim();
  let v = t.slice(eq + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
    v = v.slice(1, -1);
  if (!process.env[k]) process.env[k] = v;
}

// ─── Services ───────────────────────────────────────────────
const { Pool } = pg;

function cleanDbUrl(raw: string): string {
  const u = new URL(raw);
  u.searchParams.delete("pgbouncer");
  u.searchParams.delete("statement_cache_mode");
  return u.toString();
}

export const pool = new Pool({
  connectionString: cleanDbUrl(process.env.DATABASE_URL!),
  ssl: { rejectUnauthorized: false },
});

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// ─── Schema Introspection ───────────────────────────────────
async function getTablesList(): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
  );
  return rows.map((r: any) => r.table_name);
}

async function getTableSchema(tableName: string): Promise<TableSchema> {
  const [colRes, pkRes, uqRes] = await Promise.all([
    pool.query(
      `SELECT column_name, data_type, udt_name, is_nullable, column_default, character_maximum_length
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [tableName],
    ),
    pool.query(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY'
         AND tc.table_schema = 'public' AND tc.table_name = $1
       ORDER BY kcu.ordinal_position`,
      [tableName],
    ),
    pool.query(
      `SELECT tc.constraint_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'UNIQUE'
         AND tc.table_schema = 'public' AND tc.table_name = $1
       ORDER BY tc.constraint_name, kcu.ordinal_position`,
      [tableName],
    ),
  ]);

  const uqMap = new Map<string, string[]>();
  for (const r of uqRes.rows as any[]) {
    const cols = uqMap.get(r.constraint_name) || [];
    cols.push(r.column_name);
    uqMap.set(r.constraint_name, cols);
  }

  return {
    columns: colRes.rows,
    primaryKey: (pkRes.rows as any[]).map((r) => r.column_name),
    uniqueConstraints: [...uqMap.values()],
  };
}

// ─── CSV Parsing ────────────────────────────────────────────
function parseCSV(buffer: Buffer) {
  const rows = parse(buffer, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_quotes: true,
    relax_column_count: true,
  }) as Record<string, string>[];
  if (rows.length === 0) throw new Error("CSV is empty or has no data rows");
  return { headers: Object.keys(rows[0]), rows };
}

// ─── Batch Upsert ───────────────────────────────────────────
async function batchUpsert(
  tableName: string,
  rows: Record<string, unknown>[],
  conflictKeys: string[],
  batchSize = 500,
) {
  let upserted = 0;
  const errors: string[] = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await supabase
      .from(tableName)
      .upsert(batch, { onConflict: conflictKeys.join(",") });
    if (error) errors.push(`Batch ${Math.floor(i / batchSize) + 1}: ${error.message}`);
    else upserted += batch.length;
  }
  return { upserted, errors };
}

// ─── Session Store ──────────────────────────────────────────
interface Session {
  rows: Record<string, string>[];
  headers: string[];
  tableName: string;
  tableSchema: TableSchema;
  pipeline: PipelineResult;
  humanFeedback: HumanFeedback[];
  ts: number;
}
const sessions = new Map<string, Session>();
setInterval(() => {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [id, s] of sessions) if (s.ts < cutoff) sessions.delete(id);
}, 10 * 60_000);

// ─── Express ────────────────────────────────────────────────
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
app.use(express.json({ limit: "50mb" }));
app.use(express.static(join(__dirname, "public")));

app.get("/api/tables", async (_req, res) => {
  try {
    res.json({ tables: await getTablesList() });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/schema/:table", async (req, res) => {
  try {
    const schema = await getTableSchema(req.params.table);
    if (schema.columns.length === 0)
      return res.status(404).json({ error: `Table "${req.params.table}" not found` });
    res.json(schema);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Agentic Analyze (full pipeline) ─────────────────────────
app.post("/api/analyze", upload.single("csv"), async (req, res) => {
  try {
    const tableName = req.body.tableName;
    if (!tableName) return res.status(400).json({ error: "tableName is required" });
    if (!req.file) return res.status(400).json({ error: "CSV file is required" });

    console.log(`\n[pipeline] ${req.file.originalname} (${(req.file.size / 1024).toFixed(1)} KB) -> ${tableName}`);

    const { headers, rows } = parseCSV(req.file.buffer);
    console.log(`  parsed: ${rows.length} rows, ${headers.length} columns`);

    const schema = await getTableSchema(tableName);
    console.log(`  schema: ${schema.columns.length} cols, PK: [${schema.primaryKey.join(", ")}]`);

    const sessionId = randomUUID();

    const pipelineResult = await runPipeline(
      { csvHeaders: headers, csvRows: rows, tableName, tableSchema: schema },
      pool,
      sessionId,
    );

    sessions.set(sessionId, {
      rows, headers, tableName, tableSchema: schema,
      pipeline: pipelineResult, humanFeedback: [], ts: Date.now(),
    });

    res.json({
      sessionId,
      totalRows: rows.length,
      csvHeaders: headers,
      csvPreview: rows.slice(0, 5),
      schema,
      preflight: pipelineResult.preflight,
      mapping: pipelineResult.mapping,
    });
  } catch (e: any) {
    console.error("[pipeline] Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Human Feedback → Re-run Pipeline ────────────────────────
app.post("/api/feedback", async (req, res) => {
  try {
    const { sessionId, feedback } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });
    if (!feedback || !feedback.trim()) return res.status(400).json({ error: "feedback text required" });

    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ error: "Session expired. Re-analyze." });

    console.log(`\n[feedback] Session ${sessionId.slice(0, 8)}...`);
    console.log(`  Human says: "${feedback}"`);

    // Accumulate feedback
    const fb: HumanFeedback = {
      text: feedback.trim(),
      timestamp: new Date().toISOString(),
      turn: session.humanFeedback.length + 1,
    };
    session.humanFeedback.push(fb);

    // Re-run pipeline with human feedback injected
    console.log(`  Re-running pipeline with ${session.humanFeedback.length} feedback message(s)...`);

    const pipelineResult = await runPipeline(
      {
        csvHeaders: session.headers,
        csvRows: session.rows,
        tableName: session.tableName,
        tableSchema: session.tableSchema,
        humanFeedback: session.humanFeedback,
      },
      pool,
      sessionId,
    );

    session.pipeline = pipelineResult;
    session.ts = Date.now();

    res.json({
      sessionId,
      totalRows: session.rows.length,
      csvHeaders: session.headers,
      schema: session.tableSchema,
      preflight: pipelineResult.preflight,
      mapping: pipelineResult.mapping,
      feedbackCount: session.humanFeedback.length,
    });
  } catch (e: any) {
    console.error("[feedback] Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Execute Ingestion ───────────────────────────────────────
app.post("/api/ingest", async (req, res) => {
  try {
    const { sessionId, enabledMappings, conflictKeys } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });

    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ error: "Session expired. Re-analyze." });
    if (!conflictKeys?.length) return res.status(400).json({ error: "conflictKeys required" });

    const allTransforms = session.pipeline.preflight.transformations;
    const transforms: TransformSpec[] = enabledMappings
      ? enabledMappings
          .map((m: any) =>
            allTransforms.find(
              (t) => t.csvColumn === m.csvColumn && t.dbColumn === m.dbColumn,
            ),
          )
          .filter((t: TransformSpec | undefined): t is TransformSpec => Boolean(t))
      : allTransforms;

    console.log(`[ingest] ${session.rows.length} rows, ${transforms.length} transforms -> ${session.tableName}`);

    const transformed = transformRows(session.rows, transforms);
    const result = await batchUpsert(session.tableName, transformed, conflictKeys);

    console.log(`  done: ${result.upserted} upserted, ${result.errors.length} errors`);
    sessions.delete(sessionId);

    res.json({ totalRows: session.rows.length, upserted: result.upserted, errors: result.errors });
  } catch (e: any) {
    console.error("[ingest] Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/{*path}", (_req, res) => res.sendFile(join(__dirname, "public", "index.html")));

const PORT = 3456;
app.listen(PORT, () => {
  console.log(`\n  CSV -> Supabase Agentic Pipeline v2`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Model: ${getModelName()}`);
  console.log(`  Pipeline: Profile → [Map→Eval→Reflect]×5 → [Transform→Validate]×5 → [DryRun→Fix]×3 → Verdict`);
  console.log(`  Human Feedback: POST /api/feedback → re-runs pipeline with corrections\n`);
});
