import { createClient } from "@supabase/supabase-js";
import { createIngestionAgent } from "./src/agent/createIngestionAgent";
import { readFileSync } from "fs";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

// Load .env manually
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, ".env");
const envLines = readFileSync(envPath, "utf8").split("\n");
for (const line of envLines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eqIdx = trimmed.indexOf("=");
  if (eqIdx === -1) continue;
  const key = trimmed.slice(0, eqIdx).trim();
  const value = trimmed.slice(eqIdx + 1).trim().replace(/^"|"$/g, "");
  if (!process.env[key]) process.env[key] = value;
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const GCP_PROJECT = process.env.GOOGLE_PROJECT_ID || "project-5def41da-b693-4500-a0c";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3-flash-preview";

let cachedToken: { token: string; expiresAt: number } | null = null;
function getAccessToken(): string {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;
  const token = execSync("gcloud auth print-access-token", { encoding: "utf8" }).trim();
  cachedToken = { token, expiresAt: Date.now() + 45 * 60_000 };
  return token;
}

console.log("Supabase URL:", SUPABASE_URL);
console.log("Gemini model:", GEMINI_MODEL);

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function stripNulls(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(stripNulls);
  if (obj !== null && typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => [k, stripNulls(v)])
    );
  }
  return obj;
}

// Gemini adapter using native fetch (no SDK needed)
const geminiAdapter = {
  async completeJson({ systemPrompt, userPayload }: { systemPrompt: string; userPayload: unknown }) {
    const isGemini3 = GEMINI_MODEL.startsWith("gemini-3");
    const base = isGemini3
      ? `https://aiplatform.googleapis.com/v1/projects/${GCP_PROJECT}/locations/global`
      : `https://us-central1-aiplatform.googleapis.com/v1/projects/${GCP_PROJECT}/locations/us-central1`;
    const url = `${base}/publishers/google/models/${GEMINI_MODEL}:generateContent`;

    const fullPrompt = `${systemPrompt}\n\nUser payload:\n${JSON.stringify(userPayload, null, 2)}\n\nRespond with valid JSON only. No markdown, no explanation.`;

    const body = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
      generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
    });

    // Retry up to 4 times on 429/503 with exponential backoff
    for (let attempt = 0; attempt < 4; attempt++) {
      const token = getAccessToken();
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body,
      });

      if (res.status === 429 || res.status === 503) {
        const delay = (attempt + 1) * 5000;
        console.log(`[gemini] ${res.status} — retrying in ${delay / 1000}s (attempt ${attempt + 1}/4)`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Gemini API error ${res.status}: ${err}`);
      }

      const data = await res.json() as any;
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error("Empty response from Gemini");

      // Strip markdown code fences if present
      const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
      const parsed = JSON.parse(cleaned);

      // Gemini sometimes returns null for optional fields instead of omitting them.
      // Strip nulls recursively so zod optional() validation passes.
      return stripNulls(parsed);
    }

    throw new Error("Gemini API unavailable after 4 retries");
  },
};

// Manual schema for public.users (introspection via information_schema is blocked by PostgREST)
const usersSchema = {
  table: { schema: "public", name: "users", fullName: "users" },
  columns: [
    { name: "user_id",              dataType: "text",                    udtName: "text",        isNullable: false, defaultValue: null, maxLength: null },
    { name: "first_name",           dataType: "text",                    udtName: "text",        isNullable: true,  defaultValue: null, maxLength: null },
    { name: "last_name",            dataType: "text",                    udtName: "text",        isNullable: true,  defaultValue: null, maxLength: null },
    { name: "username",             dataType: "text",                    udtName: "text",        isNullable: true,  defaultValue: null, maxLength: null },
    { name: "bio",                  dataType: "text",                    udtName: "text",        isNullable: true,  defaultValue: null, maxLength: null },
    { name: "email_id",             dataType: "text",                    udtName: "text",        isNullable: true,  defaultValue: null, maxLength: null },
    { name: "phone_number",         dataType: "text",                    udtName: "text",        isNullable: true,  defaultValue: null, maxLength: null },
    { name: "location",             dataType: "text",                    udtName: "text",        isNullable: true,  defaultValue: null, maxLength: null },
    { name: "sex",                  dataType: "text",                    udtName: "text",        isNullable: true,  defaultValue: null, maxLength: null },
    { name: "images",               dataType: "ARRAY",                   udtName: "_text",       isNullable: true,  defaultValue: "'{}'::text[]", maxLength: null },
    { name: "front_image",          dataType: "text",                    udtName: "text",        isNullable: true,  defaultValue: null, maxLength: null },
    { name: "back_image",           dataType: "text",                    udtName: "text",        isNullable: true,  defaultValue: null, maxLength: null },
    { name: "height",               dataType: "numeric",                 udtName: "numeric",     isNullable: true,  defaultValue: null, maxLength: null },
    { name: "created_at",           dataType: "timestamp with time zone",udtName: "timestamptz", isNullable: true,  defaultValue: "now()", maxLength: null },
    { name: "updated_at",           dataType: "timestamp with time zone",udtName: "timestamptz", isNullable: true,  defaultValue: "now()", maxLength: null },
    { name: "onboarding_completed", dataType: "boolean",                 udtName: "bool",        isNullable: true,  defaultValue: "false", maxLength: null },
  ],
  keys: {
    primaryKey: ["user_id"],
    uniqueConstraints: [["username"]],
  },
};

const agent = createIngestionAgent({
  supabaseClient: supabase,
  geminiAdapter,
  batchSize: 500,
  maxRetries: 3,
  safeMode: true,
  logger: (msg: string, ctx?: Record<string, unknown>) => console.log(`[agent] ${msg}`, ctx),
  introspectTableSchema: async () => usersSchema,
});

console.log("\nRunning ingestion agent...\n");

const report = await agent.run({
  filePath: "./data/users.csv",
  tableName: "public.users",
  conflictKeys: ["user_id"],
});

console.log("\n========== INGESTION REPORT ==========");
console.log("Table:        ", report.tableName);
console.log("Rows total:   ", report.rowsTotal);
console.log("Rows prepared:", report.rowsPrepared);
console.log("Rows upserted:", report.rowsUpserted);
console.log("Rows skipped: ", report.rowsSkipped);
console.log("Dropped cols: ", report.droppedSourceColumns);
if (report.appliedFixes.length) console.log("Applied fixes:", report.appliedFixes);
if (report.manualActions.length) console.log("Manual actions:", report.manualActions);
if (report.unresolvedErrors.length) console.log("Unresolved errors:", report.unresolvedErrors);
console.log("======================================\n");
