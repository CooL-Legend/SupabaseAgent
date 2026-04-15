import { execSync } from "child_process";
import { GoogleAuth } from "google-auth-library";

const GCP_PROJECT = process.env.GOOGLE_PROJECT_ID || "project-5def41da-b693-4500-a0c";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3-flash-preview";

const isGemini3 = GEMINI_MODEL.startsWith("gemini-3");
const GCP_REGION = isGemini3 ? "global" : (process.env.GCP_REGION || "us-central1");
const VERTEX_BASE = isGemini3
  ? `https://aiplatform.googleapis.com/v1/projects/${GCP_PROJECT}/locations/global`
  : `https://${GCP_REGION}-aiplatform.googleapis.com/v1/projects/${GCP_PROJECT}/locations/${GCP_REGION}`;

// Prefer a service account JSON in env (for Railway/production); fall back to
// gcloud CLI locally. GOOGLE_SERVICE_ACCOUNT_JSON should contain the raw key JSON.
let authClient: GoogleAuth | null = null;
function getAuth(): GoogleAuth {
  if (authClient) return authClient;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const credentials = raw ? JSON.parse(raw) : undefined;
  authClient = new GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  return authClient;
}

let cachedToken: { token: string; expiresAt: number } | null = null;
async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;

  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const client = await getAuth().getClient();
    const res = await client.getAccessToken();
    if (!res.token) throw new Error("GoogleAuth returned no token");
    cachedToken = { token: res.token, expiresAt: Date.now() + 45 * 60_000 };
    return res.token;
  }

  const token = execSync("gcloud auth print-access-token", { encoding: "utf8" }).trim();
  cachedToken = { token, expiresAt: Date.now() + 45 * 60_000 };
  return token;
}

export async function callGemini(prompt: string, jsonMode = true): Promise<unknown> {
  const url = `${VERTEX_BASE}/publishers/google/models/${GEMINI_MODEL}:generateContent`;

  const generationConfig: Record<string, unknown> = { temperature: 0.1 };
  if (jsonMode) generationConfig.responseMimeType = "application/json";

  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig,
  });

  for (let attempt = 0; attempt < 6; attempt++) {
    const token = await getAccessToken();
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body,
    });

    if (res.status === 429 || res.status === 503) {
      const delay = (attempt + 1) * 8000;
      console.log(`  [gemini] ${res.status} — retry in ${delay / 1000}s (${attempt + 1}/6)`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);

    const data = (await res.json()) as any;
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Empty Gemini response");

    if (!jsonMode) return text;
    return JSON.parse(text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim());
  }

  throw new Error("Gemini unavailable after 6 retries");
}

export function getModelName(): string {
  return GEMINI_MODEL;
}
