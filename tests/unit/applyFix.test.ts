import { describe, expect, it } from "vitest";
import { applyDebugFix } from "../../src/debug/applyFix";
import type { DebugFix, TableSchema } from "../../src/types";

const tableSchema: TableSchema = {
  table: { schema: "public", name: "users", fullName: "public.users" },
  columns: [
    { name: "id", dataType: "integer", isNullable: false },
    { name: "name", dataType: "character varying", isNullable: false, maxLength: 5 },
  ],
  keys: { primaryKey: ["id"], uniqueConstraints: [] },
};

describe("applyDebugFix", () => {
  it("applies truncate fix", () => {
    const fix: DebugFix = {
      diagnosis: "name exceeds max length",
      fixType: "truncate",
      fix: { column: "name", maxLength: 5 },
    };

    const result = applyDebugFix({
      row: { id: 1, name: "VeryLongName" },
      fix,
      tableSchema,
      safeMode: true,
    });

    expect(result.outcome).toBe("updated");
    expect(result.row).toEqual({ id: 1, name: "VeryL" });
  });

  it("blocks alter_column in safe mode", () => {
    const fix: DebugFix = {
      diagnosis: "need wider column",
      fixType: "alter_column",
      sql: "alter table users alter column name type text",
    };

    const result = applyDebugFix({
      row: { id: 1, name: "VeryLongName" },
      fix,
      tableSchema,
      safeMode: true,
    });

    expect(result.outcome).toBe("manual_action");
    expect(result.manualAction).toContain("alter table");
  });
});
