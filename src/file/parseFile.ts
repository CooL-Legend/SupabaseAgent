import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseCsv } from "csv-parse/sync";

export async function parseFile(filePath: string): Promise<Record<string, unknown>[]> {
  const extension = path.extname(filePath).toLowerCase();
  const raw = await readFile(filePath, "utf8");

  if (extension === ".csv") {
    return parseCsvFile(raw);
  }

  if (extension === ".json") {
    return parseJsonFile(raw, filePath);
  }

  throw new Error(
    `Unsupported file extension \"${extension}\". Use .csv or .json (array of objects).`,
  );
}

function parseCsvFile(raw: string): Record<string, unknown>[] {
  const rows = parseCsv(raw, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    trim: true,
  });

  if (!Array.isArray(rows)) {
    throw new Error("Failed to parse CSV file.");
  }

  return rows as Record<string, unknown>[];
}

function parseJsonFile(raw: string, filePath: string): Record<string, unknown>[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(
      `Expected JSON array in ${filePath}. v1 supports only array-of-object JSON.`,
    );
  }

  const rows = parsed.filter(
    (row): row is Record<string, unknown> =>
      typeof row === "object" && row !== null && !Array.isArray(row),
  );

  if (rows.length !== parsed.length) {
    throw new Error(
      `Expected JSON array of objects in ${filePath}. Found non-object rows.`,
    );
  }

  return rows;
}
