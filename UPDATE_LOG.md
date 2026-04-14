# Update Log

---

## Update 2 — Gemini 3 Flash via Global Vertex AI Endpoint

### Problem
`gemini-3-flash-preview` and all Gemini 3.x text models returned `404 NOT_FOUND` when called via the regional Vertex AI endpoint (`us-central1-aiplatform.googleapis.com`). Google AI Studio (`generativelanguage.googleapis.com`), which does host these models, is regionally blocked in India and also had depleted prepayment credits — making it inaccessible entirely.

### Solution
Gemini 3.x models are only available on the **global Vertex AI endpoint** (`aiplatform.googleapis.com` with `locations/global`), not the regional one. The fix was to detect whether the selected model is Gemini 3.x and route it to the correct global endpoint automatically, while keeping Gemini 2.x models on the original regional endpoint. No Google AI Studio access is needed — all calls go through Vertex AI and draw from the existing GCP credits.

### Files Changed

**`app/pipeline/gemini.ts`**
- Changed default fallback model from `"gemini-2.5-pro"` to `"gemini-3-flash-preview"`
- Added `isGemini3` flag: detects if the selected model starts with `"gemini-3"`
- Added `VERTEX_BASE` constant: routes Gemini 3.x to `https://aiplatform.googleapis.com/v1/projects/.../locations/global`, and Gemini 2.x to `https://${GCP_REGION}-aiplatform.googleapis.com/v1/projects/.../locations/${GCP_REGION}`
- Updated `callGemini()` URL from hardcoded regional string to `${VERTEX_BASE}/publishers/google/models/${GEMINI_MODEL}:generateContent`

**`.env`**
- `GEMINI_MODEL` changed from `gemini-2.5-pro` → `gemini-3-flash-preview`

---

## Update 1 — Initial Commit

### Problem
No pipeline existed for ingesting CSV data into Supabase with AI-assisted column mapping.

### Solution
Built a full producer-critic agentic pipeline with Gemini as the mapping engine and Supabase as the target. Gemini generates column mappings, code evaluates them, reflects on failures, and retries up to 5 times before surfacing results to the user.

### Files Added

**`app/pipeline/gemini.ts`**
- `callGemini(prompt, jsonMode)` — calls Vertex AI Gemini with retry logic for 429/503 errors (up to 6 attempts, 8s incremental backoff)
- `getModelName()` — returns active model name for display

**`app/pipeline/profiler.ts`**
- Deep CSV analysis: infers types, detects date/currency/UUID patterns, calculates null rates and uniqueness per column

**`app/pipeline/evaluator.ts`**
- Code-based mapping scorer: checks type compatibility, null coverage, unique compliance, required field coverage, and confidence average
- Returns a score 0–1; scores below 0.8 trigger reflection

**`app/pipeline/orchestrator.ts`**
- Runs the full pipeline: Profile → Map → Evaluate → Reflect → Transform → Dry-Run → Human Confirm
- Reflection loop feeds evaluation failures back to Gemini for up to 5 retries
- Saves reflection logs to `app/logs/reflection_<sessionId>.md`

**`app/server.ts`**
- Express server on port 3456
- `POST /ingest` — accepts CSV file upload + target table name, runs the full pipeline, returns pre-flight report before writing any data
