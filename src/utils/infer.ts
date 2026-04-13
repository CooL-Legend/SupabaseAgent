import type { PrimitiveType } from "../types";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function inferPrimitiveType(value: unknown): PrimitiveType {
  if (value === null || value === undefined) {
    return "null";
  }

  if (Array.isArray(value)) {
    return "array";
  }

  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    default:
      return "unknown";
  }
}

export function isEmptyLike(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

export function isDateLikeString(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }

  if (ISO_DATE_RE.test(value)) {
    return true;
  }

  return !Number.isNaN(Date.parse(value));
}

export function normalizeForUniqueness(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (value === undefined) {
    return "undefined";
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}
