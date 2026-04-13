import { describe, expect, it } from "vitest";
import { applyMappingAndCoercions } from "../../src/transform/applyMapping";
import type { MappingDecision, TableSchema } from "../../src/types";

describe("applyMappingAndCoercions", () => {
  it("keeps only mapped subset and coerces values", () => {
    const rows = [
      { external_id: "1", full_name: "Alice", throwaway: "x" },
      { external_id: "2", full_name: "Bob", throwaway: "y" },
    ] as Record<string, unknown>[];

    const mapping: MappingDecision = {
      selectedMappings: [
        { sourceColumn: "external_id", targetColumn: "id" },
        { sourceColumn: "full_name", targetColumn: "name" },
      ],
      droppedColumns: [{ column: "throwaway", reason: "not needed" }],
      warnings: [],
    };

    const tableSchema: TableSchema = {
      table: { schema: "public", name: "users", fullName: "public.users" },
      columns: [
        { name: "id", dataType: "integer", isNullable: false },
        { name: "name", dataType: "text", isNullable: false },
      ],
      keys: { primaryKey: ["id"], uniqueConstraints: [] },
    };

    const result = applyMappingAndCoercions(rows, mapping, tableSchema);

    expect(result.preparedRows).toHaveLength(2);
    expect(result.preparedRows[0].row).toEqual({ id: 1, name: "Alice" });
    expect(result.preparedRows[1].row).toEqual({ id: 2, name: "Bob" });
    expect(result.droppedSourceColumns).toContain("throwaway");
    expect(result.skippedRowIndexes).toEqual([]);
  });
});
