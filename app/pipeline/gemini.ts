import { execSync } from "child_process";
import { GoogleAuth } from "google-auth-library";

const GCP_PROJECT = process.env.GOOGLE_PROJECT_ID || "project-5def41da-b693-4500-a0c";

// Primary: gemini-3.1-pro-preview — highest accuracy on CSV-mapping benchmarks
// Fallback: gemini-3.1-flash-lite-preview — faster + 8× cheaper, used if primary
// returns 429/5xx persistently or any non-retryable error after one round.
const GEMINI_MODEL          = process.env.GEMINI_MODEL          || "gemini-3.1-pro-preview";
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-3.1-flash-lite-preview";

function urlForModel(model: string): string {
  const isGemini3 = model.startsWith("gemini-3");
  const region = isGemini3 ? "global" : (process.env.GCP_REGION || "us-central1");
  const base = isGemini3
    ? `https://aiplatform.googleapis.com/v1/projects/${GCP_PROJECT}/locations/global`
    : `https://${region}-aiplatform.googleapis.com/v1/projects/${GCP_PROJECT}/locations/${region}`;
  return `${base}/publishers/google/models/${model}:generateContent`;
}

// Prefer a service account JSON in env (for Cloud Run/Railway); fall back to
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

  // Try ADC first — works on Cloud Run (metadata server), with a service
  // account JSON (GOOGLE_SERVICE_ACCOUNT_JSON / GOOGLE_APPLICATION_CREDENTIALS),
  // or locally if the developer has run `gcloud auth application-default login`.
  try {
    const client = await getAuth().getClient();
    const res = await client.getAccessToken();
    if (res.token) {
      cachedToken = { token: res.token, expiresAt: Date.now() + 45 * 60_000 };
      return res.token;
    }
  } catch {
    // Fall through to gcloud CLI fallback below.
  }

  // Last resort for local dev without ADC set up: shell out to the gcloud CLI.
  const token = execSync("gcloud auth print-access-token", { encoding: "utf8" }).trim();
  cachedToken = { token, expiresAt: Date.now() + 45 * 60_000 };
  return token;
}

/**
 * Single-model call with 429/503 retry-with-backoff. Throws on persistent
 * failure (callGemini wraps this with a fallback-model attempt).
 */
async function callOneModel(model: string, body: string, jsonMode: boolean): Promise<unknown> {
  const url = urlForModel(model);

  for (let attempt = 0; attempt < 6; attempt++) {
    const token = await getAccessToken();
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body,
    });

    if (res.status === 429 || res.status === 503) {
      const delay = (attempt + 1) * 8000;
      console.log(`  [gemini:${model}] ${res.status} — retry in ${delay / 1000}s (${attempt + 1}/6)`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    if (!res.ok) throw new Error(`Gemini ${model} ${res.status}: ${await res.text()}`);

    const data = (await res.json()) as any;
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error(`Empty Gemini response from ${model}`);

    if (!jsonMode) return text;
    return JSON.parse(text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim());
  }

  throw new Error(`Gemini ${model} unavailable after 6 retries`);
}

export async function callGemini(prompt: string, jsonMode = true): Promise<unknown> {
  const generationConfig: Record<string, unknown> = { temperature: 0.1 };
  if (jsonMode) generationConfig.responseMimeType = "application/json";

  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig,
  });

  try {
    return await callOneModel(GEMINI_MODEL, body, jsonMode);
  } catch (primaryErr) {
    // Don't retry on the same model — switch to fallback (different quota pool,
    // smaller model often available when Pro is rate-limited).
    if (!GEMINI_FALLBACK_MODEL || GEMINI_FALLBACK_MODEL === GEMINI_MODEL) {
      throw primaryErr;
    }
    const msg = (primaryErr as Error).message || String(primaryErr);
    console.warn(
      `  [gemini] primary ${GEMINI_MODEL} failed (${msg.slice(0, 140)}). ` +
        `Falling back to ${GEMINI_FALLBACK_MODEL}.`,
    );
    try {
      return await callOneModel(GEMINI_FALLBACK_MODEL, body, jsonMode);
    } catch (fallbackErr) {
      const fmsg = (fallbackErr as Error).message || String(fallbackErr);
      throw new Error(
        `Both Gemini models failed. Primary (${GEMINI_MODEL}): ${msg}. ` +
          `Fallback (${GEMINI_FALLBACK_MODEL}): ${fmsg}`,
      );
    }
  }
}

export function getModelName(): string {
  return GEMINI_MODEL;
}

export function getFallbackModelName(): string {
  return GEMINI_FALLBACK_MODEL;
}
