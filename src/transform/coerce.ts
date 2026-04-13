import type { CoercionType, TableColumn } from "../types";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function postgresTypeToCoercion(column: TableColumn): CoercionType {
  const dataType = column.dataType.toLowerCase();
  const udtName = (column.udtName ?? "").toLowerCase();

  if (
    ["smallint", "integer", "bigint"].includes(dataType) ||
    ["int2", "int4", "int8"].includes(udtName)
  ) {
    return "integer";
  }

  if (
    ["numeric", "decimal", "real", "double precision"].includes(dataType) ||
    ["float4", "float8", "money"].includes(udtName)
  ) {
    return "number";
  }

  if (dataType === "boolean" || udtName === "bool") {
    return "boolean";
  }

  if (dataType === "date") {
    return "date";
  }

  if (dataType.includes("timestamp") || udtName.includes("timestamp")) {
    return "timestamp";
  }

  if (["json", "jsonb"].includes(dataType) || ["json", "jsonb"].includes(udtName)) {
    return "json";
  }

  if (dataType === "uuid" || udtName === "uuid") {
    return "uuid";
  }

  return "string";
}

export function coerceValue(value: unknown, coercion: CoercionType): unknown {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  switch (coercion) {
    case "string":
      return String(value);

    case "integer":
      return toInteger(value);

    case "number":
      return toNumber(value);

    case "boolean":
      return toBoolean(value);

    case "date":
      return toDate(value);

    case "timestamp":
      return toTimestamp(value);

    case "json":
      return toJson(value);

    case "uuid":
      return toUuid(value);

    default:
      return value;
  }
}

function toInteger(value: unknown): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot cast ${String(value)} to integer`);
    }

    return Math.trunc(value);
  }

  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isNaN(parsed)) {
      throw new Error(`Cannot cast ${value} to integer`);
    }

    return parsed;
  }

  throw new Error(`Cannot cast ${String(value)} to integer`);
}

function toNumber(value: unknown): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot cast ${String(value)} to number`);
    }

    return value;
  }

  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.trim());
    if (Number.isNaN(parsed)) {
      throw new Error(`Cannot cast ${value} to number`);
    }

    return parsed;
  }

  throw new Error(`Cannot cast ${String(value)} to number`);
}

function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (value === 1) {
      return true;
    }

    if (value === 0) {
      return false;
    }
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y"].includes(normalized)) {
      return true;
    }

    if (["false", "0", "no", "n"].includes(normalized)) {
      return false;
    }
  }

  throw new Error(`Cannot cast ${String(value)} to boolean`);
}

function toDate(value: unknown): string {
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Cannot cast ${String(value)} to date`);
  }

  return parsed.toISOString().slice(0, 10);
}

function toTimestamp(value: unknown): string {
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Cannot cast ${String(value)} to timestamp`);
  }

  return parsed.toISOString();
}

function toJson(value: unknown): unknown {
  if (typeof value === "string") {
    return JSON.parse(value);
  }

  if (typeof value === "object") {
    return value;
  }

  throw new Error(`Cannot cast ${String(value)} to json`);
}

function toUuid(value: unknown): string {
  const normalized = String(value).trim();
  if (!UUID_RE.test(normalized)) {
    throw new Error(`Cannot cast ${normalized} to uuid`);
  }

  return normalized;
}
