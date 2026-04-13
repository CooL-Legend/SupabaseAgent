import { applyDebugFix } from "../debug/applyFix";
import { parseFile } from "../file/parseFile";
import { buildColumnProfile } from "../file/profile";
import { ingestRowsWithIsolation, upsertSingleRow } from "../ingest/upsert";
import { requestDebugFix, requestMappingDecision } from "../llm/decisions";
import { introspectTableSchema } from "../supabase/introspection";
import { applyMappingAndCoercions } from "../transform/applyMapping";
import { parseTableName } from "../utils/table";
import type {
  AgentConfig,
  AnalysisResult,
  DebugFix,
  IngestionInput,
  IngestionReport,
  TableReference,
  TableSchema,
  UnresolvedError,
} from "../types";
import { finalizeMappingDecision } from "./mapping";

interface InternalAnalysis {
  analysis: AnalysisResult;
  sourceRows: Record<string, unknown>[];
}

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_MAX_RETRIES = 3;

export function createIngestionAgent(config: AgentConfig) {
  const settings = {
    batchSize: config.batchSize ?? DEFAULT_BATCH_SIZE,
    maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
    safeMode: config.safeMode ?? true,
    defaultSchema: config.defaultSchema ?? "public",
  };

  async function analyze(input: IngestionInput): Promise<AnalysisResult> {
    return (await analyzeInternal(input)).analysis;
  }

  async function run(input: IngestionInput): Promise<IngestionReport> {
    const { analysis, sourceRows } = await analyzeInternal(input);

    log(config, "analysis.complete", {
      tableName: analysis.table.fullName,
      sourceRowCount: analysis.sourceRowCount,
      selectedMappings: analysis.mapping.selectedMappings.length,
    });

    const mapped = applyMappingAndCoercions(
      sourceRows,
      analysis.mapping,
      analysis.tableSchema,
    );

    const manualActions: string[] = [
      ...analysis.mapping.warnings,
      ...mapped.coercionWarnings,
    ];

    const reportSkippedRows = new Set<number>(mapped.skippedRowIndexes);

    const ingestResult = await ingestRowsWithIsolation({
      supabaseClient: config.supabaseClient,
      tableName: analysis.table.fullName,
      conflictKeys: input.conflictKeys,
      rows: mapped.preparedRows,
      batchSize: settings.batchSize,
    });

    let rowsUpserted = ingestResult.upsertedCount;
    const appliedFixes: IngestionReport["appliedFixes"] = [];
    const unresolvedErrors: UnresolvedError[] = [];

    for (const failure of ingestResult.failures) {
      let currentRow = { ...failure.row };
      let currentError = { ...failure.error };
      const priorFixes: DebugFix[] = [];
      let resolved = false;

      for (let attempt = 0; attempt < settings.maxRetries; attempt += 1) {
        const suggestedFix = await requestDebugFix(config.geminiAdapter, {
          tableSchema: analysis.tableSchema,
          error: {
            message: currentError.message,
            code: currentError.code,
            details: currentError.details,
          },
          row: currentRow,
          priorFixes,
        });

        priorFixes.push(suggestedFix);

        let applied;
        try {
          applied = applyDebugFix({
            row: currentRow,
            fix: suggestedFix,
            tableSchema: analysis.tableSchema,
            safeMode: settings.safeMode,
          });
        } catch (error) {
          currentError = {
            message: `Failed to apply suggested fix: ${(error as Error).message}`,
          };
          continue;
        }

        if (applied.outcome === "manual_action") {
          reportSkippedRows.add(failure.sourceRowIndex);
          manualActions.push(
            `Row ${failure.sourceRowIndex}: ${
              applied.manualAction ?? "manual intervention required"
            }`,
          );
          resolved = true;
          break;
        }

        if (applied.outcome === "skip") {
          reportSkippedRows.add(failure.sourceRowIndex);
          appliedFixes.push({
            rowIndex: failure.sourceRowIndex,
            fixType: suggestedFix.fixType,
            diagnosis: suggestedFix.diagnosis,
            columns: applied.touchedColumns,
          });
          resolved = true;
          break;
        }

        currentRow = applied.row;
        const retryError = await upsertSingleRow({
          supabaseClient: config.supabaseClient,
          tableName: analysis.table.fullName,
          conflictKeys: input.conflictKeys,
          row: currentRow,
        });

        appliedFixes.push({
          rowIndex: failure.sourceRowIndex,
          fixType: suggestedFix.fixType,
          diagnosis: suggestedFix.diagnosis,
          columns: applied.touchedColumns,
        });

        if (!retryError) {
          rowsUpserted += 1;
          resolved = true;
          break;
        }

        currentError = retryError;
      }

      if (!resolved) {
        reportSkippedRows.add(failure.sourceRowIndex);
        unresolvedErrors.push({
          rowIndex: failure.sourceRowIndex,
          row: currentRow,
          message: currentError.message,
          code: currentError.code,
          details: currentError.details,
        });
      }
    }

    return {
      tableName: analysis.table.fullName,
      rowsTotal: sourceRows.length,
      rowsPrepared: mapped.preparedRows.length,
      rowsUpserted,
      rowsSkipped: reportSkippedRows.size,
      droppedSourceColumns: mapped.droppedSourceColumns,
      appliedFixes,
      manualActions,
      unresolvedErrors,
      analysis,
    };
  }

  async function analyzeInternal(input: IngestionInput): Promise<InternalAnalysis> {
    if (!input.conflictKeys || input.conflictKeys.length === 0) {
      throw new Error("conflictKeys is required for deterministic upsert behavior");
    }

    const table = parseTableName(input.tableName, settings.defaultSchema);
    const sourceRows = await parseFile(input.filePath);

    if (sourceRows.length === 0) {
      throw new Error(`No rows found in file: ${input.filePath}`);
    }

    const sourceProfiles = buildColumnProfile(sourceRows);
    const tableSchema = await resolveTableSchema(config, table);
    validateConflictKeys(input.conflictKeys, tableSchema, table);

    const rawMappingDecision = await requestMappingDecision(config.geminiAdapter, {
      sourceColumns: sourceProfiles,
      tableSchema,
      mappingHints: input.mappingHints ?? {},
    });

    const normalizedMappingDecision = finalizeMappingDecision({
      mappingDecision: rawMappingDecision,
      sourceColumnNames: sourceProfiles.map((profile) => profile.name),
      tableSchema,
      mappingHints: input.mappingHints,
    });

    const analysis: AnalysisResult = {
      table,
      sourceRowCount: sourceRows.length,
      sourceColumns: sourceProfiles,
      tableSchema,
      mapping: normalizedMappingDecision,
    };

    return {
      analysis,
      sourceRows,
    };
  }

  return {
    analyze,
    run,
  };
}

async function resolveTableSchema(
  config: AgentConfig,
  table: TableReference,
): Promise<TableSchema> {
  if (config.introspectTableSchema) {
    return config.introspectTableSchema(table);
  }

  return introspectTableSchema(config.supabaseClient, table);
}

function validateConflictKeys(
  conflictKeys: string[],
  tableSchema: TableSchema,
  table: TableReference,
): void {
  const columnNames = new Set(tableSchema.columns.map((column) => column.name));

  for (const key of conflictKeys) {
    if (!columnNames.has(key)) {
      throw new Error(
        `Conflict key \"${key}\" does not exist on ${table.fullName}.`,
      );
    }
  }
}

function log(
  config: AgentConfig,
  message: string,
  context: Record<string, unknown>,
): void {
  if (config.logger) {
    config.logger(message, context);
  }
}
