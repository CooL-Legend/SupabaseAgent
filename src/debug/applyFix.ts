import type { CoercionType, DebugFix, TableSchema } from "../types";
import { coerceValue, postgresTypeToCoercion } from "../transform/coerce";

export type FixApplyOutcome = "updated" | "skip" | "manual_action";

export interface FixApplicationResult {
  outcome: FixApplyOutcome;
  row: Record<string, unknown>;
  touchedColumns: string[];
  manualAction?: string;
}

export function applyDebugFix(input: {
  row: Record<string, unknown>;
  fix: DebugFix;
  tableSchema: TableSchema;
  safeMode: boolean;
}): FixApplicationResult {
  const { row, fix, tableSchema, safeMode } = input;
  const nextRow = { ...row };
  const tableColumns = new Map(tableSchema.columns.map((column) => [column.name, column]));
  const tableColumnNames = new Set(tableSchema.columns.map((column) => column.name));

  if (fix.fixType === "skip") {
    return {
      outcome: "skip",
      row: nextRow,
      touchedColumns: [],
    };
  }

  if (fix.fixType === "alter_column") {
    if (safeMode) {
      return {
        outcome: "manual_action",
        row: nextRow,
        touchedColumns: [],
        manualAction:
          fix.sql ??
          `Gemini requested schema change for row but safeMode is enabled: ${fix.diagnosis}`,
      };
    }

    return {
      outcome: "manual_action",
      row: nextRow,
      touchedColumns: [],
      manualAction: fix.sql ?? `Schema change requested: ${fix.diagnosis}`,
    };
  }

  if (fix.fixType === "cast") {
    const column = readStringField(fix.fix, ["column", "field", "targetColumn"]);
    if (!column) {
      throw new Error("Debug fix cast is missing column");
    }

    if (!tableColumns.has(column)) {
      return {
        outcome: "manual_action",
        row: nextRow,
        touchedColumns: [],
        manualAction: `Gemini requested cast for unknown target column \"${column}\".`,
      };
    }

    const columnMeta = tableColumns.get(column);
    const requestedType = readStringField(fix.fix, ["targetType", "type", "coerceTo"]);
    const coercion =
      requestedType && isCoercionType(requestedType)
        ? requestedType
        : postgresTypeToCoercion(columnMeta!);

    nextRow[column] = coerceValue(nextRow[column], coercion);

    return {
      outcome: "updated",
      row: retainTargetColumns(nextRow, tableColumnNames),
      touchedColumns: [column],
    };
  }

  if (fix.fixType === "nullify") {
    const columns = readColumns(fix.fix);
    if (columns.length === 0) {
      throw new Error("Debug fix nullify is missing column");
    }

    for (const column of columns) {
      if (tableColumnNames.has(column)) {
        nextRow[column] = null;
      }
    }

    return {
      outcome: "updated",
      row: retainTargetColumns(nextRow, tableColumnNames),
      touchedColumns: columns,
    };
  }

  if (fix.fixType === "truncate") {
    const column = readStringField(fix.fix, ["column", "field", "targetColumn"]);
    if (!column) {
      throw new Error("Debug fix truncate is missing column");
    }

    const maxLengthFromFix = readNumberField(fix.fix, ["maxLength", "length"]);
    const maxLength = maxLengthFromFix ?? tableColumns.get(column)?.maxLength;

    if (!maxLength || maxLength <= 0) {
      return {
        outcome: "manual_action",
        row: nextRow,
        touchedColumns: [],
        manualAction: `Cannot truncate column \"${column}\" without a max length constraint.`,
      };
    }

    if (nextRow[column] !== null && nextRow[column] !== undefined) {
      nextRow[column] = String(nextRow[column]).slice(0, maxLength);
    }

    return {
      outcome: "updated",
      row: retainTargetColumns(nextRow, tableColumnNames),
      touchedColumns: [column],
    };
  }

  if (fix.fixType === "rename") {
    const from = readStringField(fix.fix, ["from", "sourceColumn", "old", "column"]);
    const to = readStringField(fix.fix, ["to", "targetColumn", "new"]);

    if (!from || !to) {
      throw new Error("Debug fix rename requires both from and to");
    }

    if (safeMode && !tableColumnNames.has(to)) {
      return {
        outcome: "manual_action",
        row: nextRow,
        touchedColumns: [],
        manualAction: `Gemini requested rename to unknown target column \"${to}\".`,
      };
    }

    if (from in nextRow) {
      nextRow[to] = nextRow[from];
      delete nextRow[from];
    }

    return {
      outcome: "updated",
      row: retainTargetColumns(nextRow, tableColumnNames),
      touchedColumns: [from, to],
    };
  }

  throw new Error(`Unsupported debug fix type: ${fix.fixType}`);
}

function readStringField(
  data: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  if (!data) {
    return undefined;
  }

  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}

function readNumberField(
  data: Record<string, unknown> | undefined,
  keys: string[],
): number | undefined {
  if (!data) {
    return undefined;
  }

  for (const key of keys) {
    const value = data[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === "string") {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }

  return undefined;
}

function readColumns(data: Record<string, unknown> | undefined): string[] {
  if (!data) {
    return [];
  }

  if (Array.isArray(data.columns)) {
    return data.columns.filter((value): value is string => typeof value === "string");
  }

  const single = readStringField(data, ["column", "field", "targetColumn"]);
  return single ? [single] : [];
}

function retainTargetColumns(
  row: Record<string, unknown>,
  targetColumns: Set<string>,
): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(row)) {
    if (targetColumns.has(key)) {
      filtered[key] = value;
    }
  }

  return filtered;
}

function isCoercionType(value: string): value is CoercionType {
  return [
    "string",
    "number",
    "integer",
    "boolean",
    "date",
    "timestamp",
    "json",
    "uuid",
  ].includes(value);
}
