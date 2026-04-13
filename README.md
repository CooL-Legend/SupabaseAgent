# Existing-Table Supabase Ingestion Agent

TypeScript library for ingesting CSV/JSON files into an **existing** Supabase table with a 3-phase loop:

1. Analyze: profile source columns + introspect target table + ask Gemini for mapping
2. Ingest: transform rows and batch upsert
3. Debug: on failure, ask Gemini for a safe fix and retry row-level up to max retries

## Install

```bash
npm install
```

## Quick Usage

```ts
import { createClient } from "@supabase/supabase-js";
import { createIngestionAgent, type GeminiAdapter } from "supabase-existing-table-ingestion-agent";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const geminiAdapter: GeminiAdapter = {
  async completeJson({ systemPrompt, userPayload }) {
    // Implement Gemini API call and return parsed JSON object.
    // The agent enforces runtime schema validation on this response.
    throw new Error("Implement Gemini adapter");
  },
};

const agent = createIngestionAgent({
  supabaseClient: supabase,
  geminiAdapter,
  batchSize: 500,
  maxRetries: 3,
  safeMode: true,
});

const report = await agent.run({
  filePath: "./data/input.csv",
  tableName: "public.contacts",
  conflictKeys: ["id"],
});

console.log(report);
```

## Behavior Notes

- No DDL paths exist in v1. The agent never creates/alters tables.
- Extra source columns are dropped and reported.
- `safeMode: true` blocks schema-change suggestions and records them as manual actions.
