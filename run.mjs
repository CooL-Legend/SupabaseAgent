import { createClient } from "@supabase/supabase-js";
import { createIngestionAgent } from "./dist/src/index.js";
import { readFileSync } from "fs";
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

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3-flash-preview";

console.log("Supabase URL:", SUPABASE_URL);
console.log("Gemini model:", GEMINI_MODEL);

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Gemini adapter using native fetch (no SDK needed)
const geminiAdapter = {
  async completeJson({ systemPrompt, userPayload }) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    const fullPrompt = `${systemPrompt}\n\nUser payload:\n${JSON.stringify(userPayload, null, 2)}\n\nRespond with valid JSON only. No markdown, no explanation.`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: fullPrompt }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json",
        },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Gemini API error ${res.status}: ${err}`);
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Empty response from Gemini");

    // Strip markdown code fences if present
    const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    return JSON.parse(cleaned);
  },
};

const agent = createIngestionAgent({
  supabaseClient: supabase,
  geminiAdapter,
  batchSize: 500,
  maxRetries: 3,
  safeMode: true,
  logger: (msg, ctx) => console.log(`[agent] ${msg}`, ctx),
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
