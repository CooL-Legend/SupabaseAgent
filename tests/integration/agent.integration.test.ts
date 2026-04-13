import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIngestionAgent } from "../../src";
import type { GeminiAdapter, TableSchema } from "../../src/types";
import { createMockSupabaseClient } from "../helpers/mockSupabase";

describe("createIngestionAgent integration", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map(async (dir) => {
        await rm(dir, { recursive: true, force: true });
      }),
    );

    tempDirs.length = 0;
  });

  it("uploads subset columns to existing table", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ingest-agent-"));
    tempDirs.push(dir);

    const filePath = path.join(dir, "contacts.csv");
    await writeFile(filePath, "id,name,extra\n1,Alice,foo\n2,Bob,bar\n", "utf8");

    const tableSchema = makeContactSchema();
    const upsertedRows: Record<string, unknown>[] = [];

    const supabaseClient = createMockSupabaseClient({
      tableSchema,
      upsertHandler: async (_tableName, rows) => {
        upsertedRows.push(...rows);
        return { error: null };
      },
    });

    const geminiAdapter: GeminiAdapter = {
      completeJson: vi.fn(async ({ responseSchemaName }) => {
        if (responseSchemaName === "mappingDecision") {
          return {
            selectedMappings: [
              { sourceColumn: "id", targetColumn: "id" },
              { sourceColumn: "name", targetColumn: "name" },
            ],
            droppedColumns: [{ column: "extra", reason: "not in target table" }],
            warnings: [],
          };
        }

        return {
          diagnosis: "skip",
          fixType: "skip",
          fix: {},
        };
      }),
    };

    const agent = createIngestionAgent({
      supabaseClient: supabaseClient as any,
      geminiAdapter,
    });

    const report = await agent.run({
      filePath,
      tableName: "public.contacts",
      conflictKeys: ["id"],
    });

    expect(report.rowsUpserted).toBe(2);
    expect(report.rowsSkipped).toBe(0);
    expect(report.droppedSourceColumns).toContain("extra");
    expect(upsertedRows).toEqual([
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ]);
  });

  it("recovers a bad row through debug fix retry", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ingest-agent-"));
    tempDirs.push(dir);

    const filePath = path.join(dir, "contacts.csv");
    await writeFile(filePath, "id,name,age\n1,Alice,30\n2,Bob,N/A\n", "utf8");

    const tableSchema = makeContactSchemaWithAge();
    const persistedRows: Record<string, unknown>[] = [];

    const supabaseClient = createMockSupabaseClient({
      tableSchema,
      upsertHandler: async (_tableName, rows) => {
        const failingRow = rows.find(
          (row) => row.age !== null && row.age !== undefined && typeof row.age !== "number",
        );

        if (failingRow) {
          return {
            error: {
              message: "invalid input syntax for type integer: \"N/A\"",
              code: "22P02",
              details: "Bad integer format",
            },
          };
        }

        persistedRows.push(...rows);
        return { error: null };
      },
    });

    const geminiAdapter: GeminiAdapter = {
      completeJson: vi.fn(async ({ responseSchemaName }) => {
        if (responseSchemaName === "mappingDecision") {
          return {
            selectedMappings: [
              { sourceColumn: "id", targetColumn: "id" },
              { sourceColumn: "name", targetColumn: "name" },
              { sourceColumn: "age", targetColumn: "age" },
            ],
            droppedColumns: [],
            warnings: [],
          };
        }

        return {
          diagnosis: "age is non-numeric; nullify it",
          fixType: "nullify",
          fix: { column: "age" },
        };
      }),
    };

    const agent = createIngestionAgent({
      supabaseClient: supabaseClient as any,
      geminiAdapter,
      maxRetries: 3,
    });

    const report = await agent.run({
      filePath,
      tableName: "public.contacts",
      conflictKeys: ["id"],
    });

    expect(report.rowsUpserted).toBe(2);
    expect(report.rowsSkipped).toBe(0);
    expect(report.appliedFixes.length).toBeGreaterThanOrEqual(1);

    expect(persistedRows).toEqual(
      expect.arrayContaining([
        { id: 1, name: "Alice", age: 30 },
        { id: 2, name: "Bob", age: null },
      ]),
    );
  });
});

function makeContactSchema(): TableSchema {
  return {
    table: {
      schema: "public",
      name: "contacts",
      fullName: "public.contacts",
    },
    columns: [
      { name: "id", dataType: "integer", isNullable: false },
      { name: "name", dataType: "text", isNullable: false },
    ],
    keys: {
      primaryKey: ["id"],
      uniqueConstraints: [],
    },
  };
}

function makeContactSchemaWithAge(): TableSchema {
  return {
    table: {
      schema: "public",
      name: "contacts",
      fullName: "public.contacts",
    },
    columns: [
      { name: "id", dataType: "integer", isNullable: false },
      { name: "name", dataType: "text", isNullable: false },
      { name: "age", dataType: "integer", isNullable: true },
    ],
    keys: {
      primaryKey: ["id"],
      uniqueConstraints: [],
    },
  };
}
