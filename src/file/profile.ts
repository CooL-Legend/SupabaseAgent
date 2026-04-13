import type { ColumnProfile } from "../types";
import {
  inferPrimitiveType,
  isDateLikeString,
  isEmptyLike,
  normalizeForUniqueness,
} from "../utils/infer";

export function buildColumnProfile(rows: Record<string, unknown>[]): ColumnProfile[] {
  if (rows.length === 0) {
    return [];
  }

  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));

  return columns.map((columnName) => {
    const values = rows.map((row) => row[columnName]);
    const nonNull = values.filter((value) => !isEmptyLike(value));
    const sample = nonNull.slice(0, 3);

    return {
      name: columnName,
      inferredType: inferColumnType(nonNull),
      nullPct: countNullLike(values) / rows.length,
      uniqueCount: new Set(values.map(normalizeForUniqueness)).size,
      sample,
    };
  });
}

function inferColumnType(values: unknown[]): ColumnProfile["inferredType"] {
  if (values.length === 0) {
    return "null";
  }

  const typeSet = new Set(values.map((value) => inferPrimitiveType(value)));

  if (typeSet.size === 1) {
    const [onlyType] = [...typeSet];
    if (onlyType === "string" && values.every((value) => isDateLikeString(value))) {
      return "string";
    }

    return onlyType;
  }

  if (typeSet.has("string")) {
    return "string";
  }

  if (typeSet.has("number")) {
    return "number";
  }

  return "unknown";
}

function countNullLike(values: unknown[]): number {
  return values.filter((value) => value === null || value === undefined || value === "")
    .length;
}
