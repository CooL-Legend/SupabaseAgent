import type {
  ColumnMappingRule,
  MappingDecision,
  MappingHints,
  TableSchema,
} from "../types";

const VALID_COERCIONS = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "date",
  "timestamp",
  "json",
  "uuid",
]);

export function finalizeMappingDecision(input: {
  mappingDecision: MappingDecision;
  sourceColumnNames: string[];
  tableSchema: TableSchema;
  mappingHints?: MappingHints;
}): MappingDecision {
  const { mappingDecision, sourceColumnNames, tableSchema, mappingHints } = input;

  const sourceColumnSet = new Set(sourceColumnNames);
  const targetColumnSet = new Set(tableSchema.columns.map((column) => column.name));

  const includeSet = mappingHints?.includeSourceColumns
    ? new Set(mappingHints.includeSourceColumns)
    : null;

  const excludeSet = new Set(mappingHints?.excludeSourceColumns ?? []);
  const warnings = [...mappingDecision.warnings];

  const candidateMappings: ColumnMappingRule[] = [];

  for (const mapping of mappingDecision.selectedMappings) {
    if (!sourceColumnSet.has(mapping.sourceColumn)) {
      warnings.push(`Ignoring mapping for unknown source column: ${mapping.sourceColumn}`);
      continue;
    }

    if (!targetColumnSet.has(mapping.targetColumn)) {
      warnings.push(`Ignoring mapping to unknown target column: ${mapping.targetColumn}`);
      continue;
    }

    if (includeSet && !includeSet.has(mapping.sourceColumn)) {
      continue;
    }

    if (excludeSet.has(mapping.sourceColumn)) {
      continue;
    }

    candidateMappings.push({ ...mapping });
  }

  if (mappingHints?.renameOverrides) {
    for (const [sourceColumn, targetColumn] of Object.entries(
      mappingHints.renameOverrides,
    )) {
      if (!sourceColumnSet.has(sourceColumn)) {
        warnings.push(`renameOverrides ignored unknown source: ${sourceColumn}`);
        continue;
      }

      if (!targetColumnSet.has(targetColumn)) {
        warnings.push(`renameOverrides ignored unknown target: ${targetColumn}`);
        continue;
      }

      if (includeSet && !includeSet.has(sourceColumn)) {
        continue;
      }

      if (excludeSet.has(sourceColumn)) {
        continue;
      }

      const existing = candidateMappings.find(
        (mapping) => mapping.sourceColumn === sourceColumn,
      );

      if (existing) {
        existing.targetColumn = targetColumn;
      } else {
        candidateMappings.push({
          sourceColumn,
          targetColumn,
          reason: "Added by mapping hint renameOverrides",
        });
      }
    }
  }

  if (mappingHints?.forceCoercions) {
    for (const mapping of candidateMappings) {
      const forced = mappingHints.forceCoercions[mapping.sourceColumn];
      if (forced && VALID_COERCIONS.has(forced)) {
        mapping.coerceTo = forced;
      }
    }
  }

  const uniqueMappings: ColumnMappingRule[] = [];
  const seenSource = new Set<string>();
  const seenTarget = new Set<string>();

  for (const mapping of candidateMappings) {
    if (seenSource.has(mapping.sourceColumn)) {
      warnings.push(`Duplicate source mapping kept first: ${mapping.sourceColumn}`);
      continue;
    }

    if (seenTarget.has(mapping.targetColumn)) {
      warnings.push(`Duplicate target mapping kept first: ${mapping.targetColumn}`);
      continue;
    }

    uniqueMappings.push(mapping);
    seenSource.add(mapping.sourceColumn);
    seenTarget.add(mapping.targetColumn);
  }

  const droppedColumns = sourceColumnNames
    .filter((columnName) => !seenSource.has(columnName))
    .map((columnName) => ({
      column: columnName,
      reason: "Not required for target table ingestion",
    }));

  for (const dropped of mappingDecision.droppedColumns) {
    if (!sourceColumnSet.has(dropped.column)) {
      continue;
    }

    if (droppedColumns.some((existing) => existing.column === dropped.column)) {
      continue;
    }

    droppedColumns.push(dropped);
  }

  return {
    selectedMappings: uniqueMappings,
    droppedColumns,
    warnings,
  };
}
