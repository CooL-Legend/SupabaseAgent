import { describe, expect, it } from "vitest";
import {
  debugFixResponseSchema,
  mappingDecisionResponseSchema,
} from "../../src/llm/schemas";

describe("LLM response schemas", () => {
  it("accepts valid mapping decision JSON", () => {
    const parsed = mappingDecisionResponseSchema.parse({
      selectedMappings: [
        {
          sourceColumn: "email",
          targetColumn: "email",
          coerceTo: "string",
        },
      ],
      droppedColumns: [{ column: "ip", reason: "PII" }],
      warnings: [],
    });

    expect(parsed.selectedMappings).toHaveLength(1);
  });

  it("rejects invalid mapping decision JSON", () => {
    const badPayload = {
      selectedMappings: [
        {
          sourceColumn: "email",
          targetColumn: 123,
        },
      ],
    };

    const result = mappingDecisionResponseSchema.safeParse(badPayload);
    expect(result.success).toBe(false);
  });

  it("rejects unknown debug fix type", () => {
    const result = debugFixResponseSchema.safeParse({
      diagnosis: "bad",
      fixType: "rewrite_table",
      fix: {},
    });

    expect(result.success).toBe(false);
  });
});
