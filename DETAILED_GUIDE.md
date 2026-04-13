# Existing-Table Supabase Ingestion Agent: Detailed Guide

## 1. Purpose

This project is a TypeScript ingestion library that loads CSV/JSON data into an **already-existing Supabase table**.

The core goals are:

- Ingest semi-structured files without manually writing one-off mapping code for each dataset.
- Use an LLM (Gemini) to decide how source columns map to target table columns.
- Keep ingestion safe and deterministic by validating all LLM responses with strict schemas.
- Automatically recover from common row-level data issues through a retry loop.
- Avoid schema mutation in v1 (no `CREATE TABLE`, no `ALTER TABLE` execution).

In short: it is a safe, production-friendly ingestion pipeline that combines deterministic DB writes with LLM-assisted mapping and debugging.

---

## 2. Architecture and Flow Diagram

### Architecture Overview

The system is organized into modular layers:

1. **Agent Orchestrator** (`createIngestionAgent`)
- Coordinates the full `Analyze -> Ingest -> Debug` lifecycle.
- Exposes public methods `analyze()` and `run()`.

2. **File Layer** (`parseFile`, `buildColumnProfile`)
- Reads CSV/JSON input and generates a compact statistical profile per column.

3. **Schema Introspection Layer** (`introspectTableSchema`)
- Reads target table metadata from Supabase `information_schema`.

4. **LLM Decision Layer** (`requestMappingDecision`, `requestDebugFix`)
- Sends structured prompts to Gemini.
- Validates responses with `zod` schemas before use.

5. **Mapping/Transform Layer** (`finalizeMappingDecision`, `applyMappingAndCoercions`, `coerceValue`)
- Sanitizes LLM mapping output.
- Applies selected column subset, rename rules, and type coercions.

6. **Ingestion Layer** (`ingestRowsWithIsolation`, `upsertSingleRow`)
- Performs batch upserts with conflict keys.
- Uses recursive batch splitting to isolate failing rows.

7. **Debug-Fix Layer** (`applyDebugFix`)
- Applies LLM-proposed row-level fixes in safe mode.
- Retries failed rows up to configured max retries.

8. **Reporting Layer** (`IngestionReport`)
- Produces totals, dropped columns, applied fixes, manual actions, and unresolved errors.

### End-to-End Flow Diagram

```mermaid
flowchart TD
    A[Input: filePath + tableName + conflictKeys] --> B[parseFile]
    B --> C[buildColumnProfile]
    C --> D[introspectTableSchema]
    D --> E[requestMappingDecision (Gemini)]
    E --> F[finalizeMappingDecision]
    F --> G[applyMappingAndCoercions]
    G --> H[ingestRowsWithIsolation batch upsert]

    H -->|Batch succeeds| I[Accumulate upsert count]
    H -->|Batch fails| J[Recursive split to isolate bad row]
    J --> K[requestDebugFix (Gemini)]
    K --> L[applyDebugFix]

    L -->|updated row| M[upsertSingleRow retry]
    M -->|success| I
    M -->|fails + retries left| K

    L -->|skip| N[Mark row skipped]
    L -->|manual_action safeMode| O[Record manual action]

    N --> P[Finalize report]
    O --> P
    I --> P
    P --> Q[Return IngestionReport]
```

### Design Constraints Enforced in Code

- Existing table only; no DDL execution path.
- Conflict keys are mandatory for deterministic upsert behavior.
- LLM output must pass schema validation (`zod`) before being applied.
- Safe mode blocks schema-changing debug actions (`alter_column`) and logs them as manual actions.

---

## 3. How to Run the App

This repo is a **library**, not a CLI app. You run it by importing and calling it from your Node/TypeScript service.

### Prerequisites

- Node.js 18+
- A Supabase project/table that already exists
- A key that can:
  - upsert into the target table
  - read `information_schema` metadata
- A Gemini API key (for your custom `GeminiAdapter` implementation)

### Install and build

```bash
npm install
npm run build
```

### Basic usage (inside your app)

```ts
import { createClient } from "@supabase/supabase-js";
import {
  createIngestionAgent,
  type GeminiAdapter,
} from "./dist/index.js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const geminiAdapter: GeminiAdapter = {
  async completeJson({ systemPrompt, userPayload, responseSchemaName }) {
    // Implement your Gemini call here and return parsed JSON object.
    // Must return plain JSON, not markdown/text.
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
  filePath: "./data/contacts.csv",
  tableName: "public.contacts",
  conflictKeys: ["id"],
  mappingHints: {
    excludeSourceColumns: ["debug_notes"],
  },
});

console.log(report);
```

### Optional: analyze without writing data

```ts
const analysis = await agent.analyze({
  filePath: "./data/contacts.csv",
  tableName: "public.contacts",
  conflictKeys: ["id"],
});

console.log(analysis.mapping);
```

---

## 4. High-Level Function Details (Input/Output)

### Public API

| Function | Input | Output | What it does |
|---|---|---|---|
| `createIngestionAgent(config)` | `AgentConfig` | `{ analyze, run }` | Builds the orchestrator with runtime config (Supabase, Gemini adapter, retries, batching, safe mode). |
| `analyze(input)` | `IngestionInput` | `Promise<AnalysisResult>` | Executes analysis only (parse, profile, introspect, LLM mapping). No writes. |
| `run(input)` | `IngestionInput` | `Promise<IngestionReport>` | Full pipeline: analyze, transform, batch upsert, debug retries, and reporting. |

### Analyze Layer

| Function | Input | Output | What it does |
|---|---|---|---|
| `parseFile(filePath)` | file path (`.csv` or `.json`) | `Promise<Record<string, unknown>[]>` | Loads source data in memory and validates expected shape (JSON array of objects). |
| `buildColumnProfile(rows)` | source rows | `ColumnProfile[]` | Computes column fingerprint: inferred type, null %, unique count, sample values. |
| `introspectTableSchema(supabase, table)` | Supabase client + `TableReference` | `Promise<TableSchema>` | Reads target columns and key metadata from `information_schema`. |
| `requestMappingDecision(adapter, payload)` | Gemini adapter + source/table profile payload | `Promise<MappingDecision>` | Gets LLM mapping decision and validates strict JSON schema. |
| `finalizeMappingDecision(input)` | raw mapping + source column names + table schema + hints | `MappingDecision` | Sanitizes mappings, applies hints, removes invalid mappings, deduplicates, emits warnings. |

### Transform Layer

| Function | Input | Output | What it does |
|---|---|---|---|
| `applyMappingAndCoercions(sourceRows, mapping, tableSchema)` | source rows + mapping + target schema | `MappingApplicationResult` | Produces prepared rows restricted to target-compatible columns and coercions. |
| `postgresTypeToCoercion(column)` | `TableColumn` | `CoercionType` | Maps PostgreSQL type metadata to an internal coercion strategy. |
| `coerceValue(value, coercion)` | raw value + coercion enum | `unknown` | Converts input value into target-compatible shape or throws conversion error. |

### Ingestion Layer

| Function | Input | Output | What it does |
|---|---|---|---|
| `ingestRowsWithIsolation(input)` | Supabase client + table + conflict keys + prepared rows + batch size | `Promise<{ upsertedCount, failures }>` | Upserts by batch and recursively splits failing batches to isolate exact bad rows. |
| `upsertSingleRow(input)` | single prepared row | `Promise<DatabaseError \| null>` | Retries one row after a debug fix. |

### Debug Layer

| Function | Input | Output | What it does |
|---|---|---|---|
| `requestDebugFix(adapter, payload)` | table schema + db error + row + prior fixes | `Promise<DebugFix>` | Asks Gemini to diagnose and propose one structured fix action. |
| `applyDebugFix(input)` | row + `DebugFix` + table schema + `safeMode` | `FixApplicationResult` | Applies cast/nullify/truncate/rename/skip; blocks schema mutation in safe mode. |

### Utility Layer

| Function | Input | Output | What it does |
|---|---|---|---|
| `parseTableName(tableName, defaultSchema)` | `table` or `schema.table` | `TableReference` | Normalizes table identifier for introspection and upsert calls. |

### Key Data Contracts

- `IngestionInput`: file path, target table, conflict keys, optional mapping hints.
- `AnalysisResult`: source profile + target schema + normalized mapping decision.
- `IngestionReport`: totals, dropped columns, applied fixes, manual actions, unresolved errors.
- `GeminiAdapter`: one method `completeJson(request)` returning parsed JSON.

---

## 5. How to Integrate LLMs

The app integrates LLMs through a single adapter interface:

```ts
export interface GeminiAdapter {
  completeJson(request: {
    systemPrompt: string;
    userPayload: unknown;
    responseSchemaName?: string;
  }): Promise<unknown>;
}
```

### Integration Strategy

1. Implement `GeminiAdapter.completeJson(...)`.
2. Send `systemPrompt` and serialized `userPayload` to your Gemini model.
3. Force JSON-only output in your LLM request settings.
4. Parse JSON and return plain object.
5. Let built-in `zod` validators enforce schema safety.

### Recommended Gemini Request Settings

- `temperature`: low (e.g., `0` to `0.2`) for deterministic structure.
- Response format: JSON only.
- Include schema name (`responseSchemaName`) in your logging/tracing.
- Add timeout and retry logic around model API calls.

### Example Adapter (HTTP style pseudocode)

```ts
const geminiAdapter: GeminiAdapter = {
  async completeJson({ systemPrompt, userPayload }) {
    const prompt = [
      { role: "system", content: systemPrompt },
      { role: "user", content: JSON.stringify(userPayload) },
    ];

    const res = await fetch("<gemini-endpoint>", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GEMINI_API_KEY}`,
      },
      body: JSON.stringify({
        model: process.env.GEMINI_MODEL,
        messages: prompt,
        response_format: { type: "json_object" },
        temperature: 0.1,
      }),
    });

    if (!res.ok) {
      throw new Error(`Gemini request failed: ${res.status}`);
    }

    const data = await res.json();

    // Adapt this extraction to your chosen Gemini SDK/endpoint response shape.
    const jsonText = data.output_text;
    return JSON.parse(jsonText);
  },
};
```

### LLM Safety Notes

- LLM output is advisory; DB is still source of truth.
- Invalid JSON or wrong schema is rejected before execution.
- In safe mode, schema-changing suggestions become `manualActions` and are not executed.
- Keep prompts versioned so behavior remains stable across model updates.

---

## Operational Notes

- Best for small/medium files loaded in memory.
- Conflict keys are required and validated against target table columns.
- Extra file columns are dropped unless mapped.
- Common recoverable errors: bad casts, nullification, string truncation, renaming mistakes.
- Always inspect `report.manualActions` and `report.unresolvedErrors` in production workflows.
