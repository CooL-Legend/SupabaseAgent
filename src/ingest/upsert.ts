import type { SupabaseClient } from "@supabase/supabase-js";
import type { DatabaseError, PreparedRow, RowFailure } from "../types";

export interface IngestRowsResult {
  upsertedCount: number;
  failures: RowFailure[];
}

export async function ingestRowsWithIsolation(input: {
  supabaseClient: SupabaseClient;
  tableName: string;
  conflictKeys: string[];
  rows: PreparedRow[];
  batchSize: number;
}): Promise<IngestRowsResult> {
  const { supabaseClient, tableName, conflictKeys, rows, batchSize } = input;

  let upsertedCount = 0;
  const failures: RowFailure[] = [];

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const result = await ingestSegment({
      supabaseClient,
      tableName,
      conflictKeys,
      rows: batch,
    });

    upsertedCount += result.upsertedCount;
    failures.push(...result.failures);
  }

  return {
    upsertedCount,
    failures,
  };
}

export async function upsertSingleRow(input: {
  supabaseClient: SupabaseClient;
  tableName: string;
  conflictKeys: string[];
  row: Record<string, unknown>;
}): Promise<DatabaseError | null> {
  const { supabaseClient, tableName, conflictKeys, row } = input;

  return executeUpsert({
    supabaseClient,
    tableName,
    conflictKeys,
    payload: [row],
  });
}

async function ingestSegment(input: {
  supabaseClient: SupabaseClient;
  tableName: string;
  conflictKeys: string[];
  rows: PreparedRow[];
}): Promise<IngestRowsResult> {
  const { supabaseClient, tableName, conflictKeys, rows } = input;

  if (rows.length === 0) {
    return {
      upsertedCount: 0,
      failures: [],
    };
  }

  const payload = rows.map((row) => row.row);
  const error = await executeUpsert({
    supabaseClient,
    tableName,
    conflictKeys,
    payload,
  });

  if (!error) {
    return {
      upsertedCount: rows.length,
      failures: [],
    };
  }

  if (rows.length === 1) {
    return {
      upsertedCount: 0,
      failures: [
        {
          sourceRowIndex: rows[0].sourceRowIndex,
          row: rows[0].row,
          error,
        },
      ],
    };
  }

  const midpoint = Math.ceil(rows.length / 2);
  const left = rows.slice(0, midpoint);
  const right = rows.slice(midpoint);

  const [leftResult, rightResult] = await Promise.all([
    ingestSegment({
      supabaseClient,
      tableName,
      conflictKeys,
      rows: left,
    }),
    ingestSegment({
      supabaseClient,
      tableName,
      conflictKeys,
      rows: right,
    }),
  ]);

  return {
    upsertedCount: leftResult.upsertedCount + rightResult.upsertedCount,
    failures: [...leftResult.failures, ...rightResult.failures],
  };
}

async function executeUpsert(input: {
  supabaseClient: SupabaseClient;
  tableName: string;
  conflictKeys: string[];
  payload: Record<string, unknown>[];
}): Promise<DatabaseError | null> {
  const { supabaseClient, tableName, conflictKeys, payload } = input;

  const options =
    conflictKeys.length > 0 ? { onConflict: conflictKeys.join(",") } : undefined;

  const { error } = await (supabaseClient as any).from(tableName).upsert(payload, options);

  if (!error) {
    return null;
  }

  return normalizeDatabaseError(error);
}

function normalizeDatabaseError(raw: any): DatabaseError {
  return {
    message: String(raw?.message ?? "Unknown database error"),
    code: raw?.code ? String(raw.code) : undefined,
    details: raw?.details ? String(raw.details) : undefined,
    hint: raw?.hint ? String(raw.hint) : undefined,
  };
}
