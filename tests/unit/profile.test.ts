import { describe, expect, it } from "vitest";
import { buildColumnProfile } from "../../src/file/profile";

describe("buildColumnProfile", () => {
  it("computes null percentages and unique counts", () => {
    const rows = [
      { id: 1, email: "a@example.com", city: "LA" },
      { id: 2, email: "b@example.com", city: null },
      { id: 3, email: "a@example.com", city: "" },
    ] as Record<string, unknown>[];

    const profile = buildColumnProfile(rows);
    const city = profile.find((column) => column.name === "city");
    const email = profile.find((column) => column.name === "email");

    expect(city).toBeDefined();
    expect(city?.nullPct).toBeCloseTo(2 / 3);
    expect(city?.uniqueCount).toBe(3);

    expect(email).toBeDefined();
    expect(email?.uniqueCount).toBe(2);
    expect(email?.inferredType).toBe("string");
  });
});
