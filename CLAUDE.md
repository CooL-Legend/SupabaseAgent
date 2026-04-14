# CSV-to-Supabase Agentic Ingestion Pipeline

## Architecture
- **Producer-Critic loop**: Gemini generates mappings, code evaluates them, reflects on failures, retries up to 5x
- **Vertex AI**: Uses `gemini-2.5-pro` via Vertex AI with GCP $300 trial credits (project: `project-5def41da-b693-4500-a0c`)
- **Direct PG**: Schema introspection uses `pg` pool against `information_schema` (not PostgREST)
- **Supabase Client**: Data upserts use `@supabase/supabase-js` with table name only (no schema prefix)

## Pipeline Stages
1. **Profile** — Deep CSV analysis: infer types, detect patterns (dates, currency, UUIDs), null rates, uniqueness
2. **Map** — Gemini generates column mappings with confidence scores and reasoning, guided by `app/rules/MAPPING_RULES.md`
3. **Evaluate** — Code-based scoring: type compatibility, null coverage, unique compliance, required coverage, confidence avg
4. **Reflect** — If eval fails (score < 0.8), log issues to reflection log, feed them back to Gemini for next turn
5. **Transform** — Gemini generates TypeScript transform functions per column
6. **Dry-Run** — Test INSERT with ROLLBACK against real table to catch constraint violations
7. **Human Confirm** — Pre-flight report shown to user before any data is written

## Critical Rules
- PostgREST `.from()` takes table name WITHOUT schema prefix (`users` not `public.users`)
- Never write directly to production without dry-run + human confirmation
- Reflection logs saved to `app/logs/reflection_<sessionId>.md`
- All Gemini prompts include the full rules from `app/rules/MAPPING_RULES.md`

## Run
```bash
npm run app   # starts server at http://localhost:3456
```
