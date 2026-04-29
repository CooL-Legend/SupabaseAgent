# Update Log

---

## Update 5 — brand / title / SUBTITLE split + GCS column exclusions

### Problem
The user reshaped the `products` table:
```sql
ALTER TABLE public.products ADD COLUMN "SUBTITLE" text;
UPDATE public.products SET "SUBTITLE" = title;     -- old title preserved as subtitle
UPDATE public.products SET title = brand;          -- title now holds brand value
```
After the migration, the new column semantics are: `brand` = brand token (`PUMA`), `title` = product line / family name (`GRAPHICS TRAIN CONCEPT`), `SUBTITLE` = descriptor tail (`Women's Training Tee`). The old ingest mapped CSV `product_name → title` 1:1 (because [MAPPING_RULES.md](app/rules/MAPPING_RULES.md) forbade splitting one CSV column into multiple DB columns), so under the new schema `title` and `SUBTITLE` would end up identical or `SUBTITLE` would stay null. Separately, the user wanted `gcs_front_url`, `gcs_back_url`, `garment_features`, and `product_embedding` to be untouchable from CSV ingest — they're filled by other backend pipelines.

### Solution
The pipeline already supported two `TransformSpec` entries with the same `csvColumn` and different `dbColumn` (the `transformRows` loop at [orchestrator.ts](app/pipeline/orchestrator.ts) just iterates over specs). The blockers were the explicit "NEVER" rule in the mapping prompt and Gemini's lack of awareness of the new column. Three narrow doc/prompt changes plus a defensive code filter:

### Files Changed

**`app/rules/MAPPING_RULES.md`**
- Replaced the blanket `NEVER map one CSV column to multiple DB columns` rule with: default 1:1, but allow splitting when the table-specific schema doc explicitly documents a split source.

**`app/rules/PRODUCTS_SCHEMA.md`**
- Rewrote the `title` section with the new "product line / family name" semantics and a SPLIT RULE that tells Gemini to emit two mapping entries for combined `product_name` CSVs, splitting on the first gender/garment descriptor token (`Men's | Women's | Unisex | Kids' | Boys' | Girls' | Baby`).
- Added a new `SUBTITLE` section documenting the case-sensitive quoted-uppercase column name and the descriptor-tail extraction, with example transform bodies for both halves of the split.
- Updated the `brand` section to clarify it's the brand token only (no garment description).
- Added a new top-level `## Columns that CSV ingest MUST SKIP (HARD RULE)` section listing `gcs_front_url`, `gcs_back_url`, `garment_features`, `product_embedding`, `created_at` — replacing the old per-column "Currently empty" stubs.

**`app/pipeline/orchestrator.ts`**
- Added an `EXCLUDED_BY_TABLE` map (only `products` populated for now).
- `buildMappingPrompt` now appends a `## DB COLUMNS TO EXCLUDE FROM CSV INGEST (HARD RULE)` section to the prompt for any table in the map.
- After Gemini returns, the mapping loop drops any `columnMappings` entry whose `dbColumn` is in the exclusion list and logs `[mapping] dropped excluded dbColumn=X` — defensive belt-and-braces in case Gemini ignores the prompt.

### Files NOT changed
- `app/pipeline/types.ts` — `TransformSpec` shape was already sufficient for splits.
- `app/pipeline/orchestrator.ts:transformRows` — already supports duplicate `csvColumn` with distinct `dbColumn`.
- `app/server.ts` — no API surface change; ingest still looks up real LLM transforms by `(csvColumn, dbColumn)` tuple.

---

## Update 4 — Railway Deployment

### Problem
The app ran only on the developer's laptop. Needed a persistent public URL so others could upload CSVs. Vercel was ruled out because the pipeline routinely exceeds serverless timeouts (5×map + 5×transform + 3×dry-run LLM turns = several minutes). Render was ruled out because free-tier instances sleep on inactivity.

### Solution
Deployed to Railway, which keeps long-running Node processes awake and has no request timeout. Swapped the Gemini auth path from `gcloud auth print-access-token` (which requires the gcloud CLI binary — absent in Railway containers) to `google-auth-library` reading a service account JSON from an env var. The gcloud shell-out is preserved as a local-dev fallback.

### Files Changed

**`app/pipeline/gemini.ts`**
- Added `google-auth-library` import and a lazy `GoogleAuth` client.
- `getAccessToken()` is now async. When `GOOGLE_SERVICE_ACCOUNT_JSON` (or `GOOGLE_APPLICATION_CREDENTIALS`) is set, it mints a token via `GoogleAuth`; otherwise it falls back to `gcloud auth print-access-token` for local development.
- Token cache logic unchanged (45 min TTL).

**`app/server.ts`**
- `PORT` now reads `process.env.PORT` (Railway injects this) and falls back to 3456 locally.
- `.env` loader wrapped in try/catch so a missing `.env` file doesn't crash the container.

**`package.json`**
- Added `start` script pointing at `tsx app/server.ts`.
- Moved `tsx` from devDependencies to dependencies (Railway prunes devDeps in production builds).
- Added `google-auth-library` dependency.

### Env Vars Set on Railway
- `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — from existing `.env`.
- `GOOGLE_PROJECT_ID`, `GEMINI_MODEL` — from existing `.env`.
- `GOOGLE_SERVICE_ACCOUNT_JSON` — new; the raw JSON of a GCP service account key with the `aiplatform.user` role. Replaces `gcloud` CLI auth.

---

## Update 3 — Currency & Ingest Transform Fixes

### Problem
User uploaded a PUMA products CSV where the `pricing` column contained values like `"INR 1379"`. Ingestion crashed on every row with `invalid input syntax for type numeric: "INR 1379"`, reporting 0/200 upserted.

### Root Causes
1. **Ingest route discarded the LLM transforms.** [app/server.ts:285-292](app/server.ts) rebuilt transforms as trivial `return v` passthroughs whenever the user submitted `enabledMappings`. Every currency-stripping transform Gemini produced was thrown away right before insert.
2. **Currency detection was symbol-only.** Profiler, evaluator `testCast`, and fallback `to_number`/`to_integer` transforms only stripped `$€£¥₹`. ISO alpha codes (`INR`, `USD`, `EUR`, …) were left on the string, so `parseFloat("INR 1379")` → `NaN` → SQL numeric rejection.

### Solution
**`app/server.ts`** — ingest now looks up the real LLM-generated `TransformSpec` for each `enabledMapping` and passes it through, instead of rebuilding.
**`app/pipeline/profiler.ts`** — regex and pattern detection extended to recognise `^(INR|USD|EUR|GBP|JPY|CNY|AUD|CAD|CHF|SGD|HKD|AED|SAR|ZAR|BRL|MXN|RUB|KRW|TRY|NZD)\s+` prefixes; `extractNumber` strips them before `Number(...)`.
**`app/pipeline/evaluator.ts`** — `testCast` for `to_integer`/`to_number` strips the alpha code, symbols, commas, and whitespace before parsing.
**`app/pipeline/orchestrator.ts`** — fallback `to_number` and `to_integer` transform code strings include the same strip.
**`app/rules/MAPPING_RULES.md`** — added a rule so Gemini handles alpha currency prefixes on the first pass instead of only after a dry-run failure.

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
