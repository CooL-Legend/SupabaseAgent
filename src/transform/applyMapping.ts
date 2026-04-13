import type {
  MappingDecision,
  PreparedRow,
  TableSchema,
} from "../types";
import { coerceValue, postgresTypeToCoercion } from "./coerce";

export interface MappingApplicationResult {
  preparedRows: PreparedRow[];
  droppedSourceColumns: string[];
  skippedRowIndexes: number[];
  coercionWarnings: string[];
}

export function applyMappingAndCoercions(
  sourceRows: Record<string, unknown>[],
  mapping: MappingDecision,
  tableSchema: TableSchema,
): MappingApplicationResult {
  const tableColumns = new Map(tableSchema.columns.map((column) => [column.name, column]));

  const selectedMappings = mapping.selectedMappings.filter(
    (rule) => tableColumns.has(rule.targetColumn),
  );

  const allSourceColumns = new Set(sourceRows.flatMap((row) => Object.keys(row)));
  const selectedSourceColumns = new Set(selectedMappings.map((rule) => rule.sourceColumn));

  const droppedFromMapping = new Set(mapping.droppedColumns.map((dropped) => dropped.column));
  const droppedSourceColumns = [...allSourceColumns].filter(
    (columnName) => !selectedSourceColumns.has(columnName) || droppedFromMapping.has(columnName),
  );

  const preparedRows: PreparedRow[] = [];
  const skippedRowIndexes: number[] = [];
  const coercionWarnings: string[] = [];

  sourceRows.forEach((sourceRow, index) => {
    const transformedRow: Record<string, unknown> = {};

    for (const rule of selectedMappings) {
      if (!(rule.sourceColumn in sourceRow)) {
        continue;
      }

      const column = tableColumns.get(rule.targetColumn);
      if (!column) {
        continue;
      }

      const inputValue = sourceRow[rule.sourceColumn];
      const coercion = rule.coerceTo ?? postgresTypeToCoercion(column);

      try {
        transformedRow[rule.targetColumn] = coerceValue(inputValue, coercion);
      } catch (error) {
        coercionWarnings.push(
          `Row ${index + 1}, column ${rule.targetColumn}: ${(error as Error).message}`,
        );

        transformedRow[rule.targetColumn] = inputValue;
      }
    }

    if (Object.keys(transformedRow).length === 0) {
      skippedRowIndexes.push(index + 1);
      return;
    }

    preparedRows.push({
      sourceRowIndex: index + 1,
      row: transformedRow,
    });
  });

  return {
    preparedRows,
    droppedSourceColumns,
    skippedRowIndexes,
    coercionWarnings,
  };
}
