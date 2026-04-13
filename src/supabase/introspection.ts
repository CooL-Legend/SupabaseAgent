import type { SupabaseClient } from "@supabase/supabase-js";
import type { TableReference, TableSchema } from "../types";

type InfoColumnRow = {
  column_name: string;
  data_type: string;
  udt_name: string | null;
  is_nullable: "YES" | "NO";
  column_default: string | null;
  character_maximum_length: number | null;
};

type ConstraintRow = {
  constraint_name: string;
  constraint_type: string;
};

type KeyUsageRow = {
  constraint_name: string;
  column_name: string;
  ordinal_position: number;
};

export async function introspectTableSchema(
  supabase: SupabaseClient,
  table: TableReference,
): Promise<TableSchema> {
  const infoSchema = (supabase as any).schema("information_schema");

  const { data: columns, error: columnsError } = await infoSchema
    .from("columns")
    .select(
      "column_name,data_type,udt_name,is_nullable,column_default,character_maximum_length",
    )
    .eq("table_schema", table.schema)
    .eq("table_name", table.name)
    .order("ordinal_position", { ascending: true });

  if (columnsError) {
    throw new Error(
      `Failed to introspect columns for ${table.fullName}: ${columnsError.message}`,
    );
  }

  const columnRows = (columns as InfoColumnRow[] | null) ?? [];
  if (columnRows.length === 0) {
    throw new Error(
      `No columns found for ${table.fullName}. Confirm table exists and service role can read information_schema.`,
    );
  }

  const { data: constraints, error: constraintsError } = await infoSchema
    .from("table_constraints")
    .select("constraint_name,constraint_type")
    .eq("table_schema", table.schema)
    .eq("table_name", table.name)
    .in("constraint_type", ["PRIMARY KEY", "UNIQUE"]);

  if (constraintsError) {
    throw new Error(
      `Failed to introspect constraints for ${table.fullName}: ${constraintsError.message}`,
    );
  }

  const { data: keyUsage, error: keyUsageError } = await infoSchema
    .from("key_column_usage")
    .select("constraint_name,column_name,ordinal_position")
    .eq("table_schema", table.schema)
    .eq("table_name", table.name)
    .order("ordinal_position", { ascending: true });

  if (keyUsageError) {
    throw new Error(
      `Failed to introspect key usage for ${table.fullName}: ${keyUsageError.message}`,
    );
  }

  const normalizedConstraints = (constraints as ConstraintRow[] | null) ?? [];
  const normalizedUsage = (keyUsage as KeyUsageRow[] | null) ?? [];

  const constraintTypeByName = new Map<string, string>();
  for (const row of normalizedConstraints) {
    constraintTypeByName.set(row.constraint_name, row.constraint_type);
  }

  const columnsByConstraint = new Map<string, string[]>();
  for (const usageRow of normalizedUsage) {
    if (!constraintTypeByName.has(usageRow.constraint_name)) {
      continue;
    }

    const existing = columnsByConstraint.get(usageRow.constraint_name) ?? [];
    existing.push(usageRow.column_name);
    columnsByConstraint.set(usageRow.constraint_name, existing);
  }

  const primaryKeyConstraint = [...constraintTypeByName.entries()].find(
    ([, type]) => type === "PRIMARY KEY",
  );

  const primaryKey = primaryKeyConstraint
    ? columnsByConstraint.get(primaryKeyConstraint[0]) ?? []
    : [];

  const uniqueConstraints = [...constraintTypeByName.entries()]
    .filter(([, type]) => type === "UNIQUE")
    .map(([constraintName]) => columnsByConstraint.get(constraintName) ?? [])
    .filter((columnsForConstraint) => columnsForConstraint.length > 0);

  return {
    table,
    columns: columnRows.map((column) => ({
      name: column.column_name,
      dataType: column.data_type,
      udtName: column.udt_name,
      isNullable: column.is_nullable === "YES",
      defaultValue: column.column_default,
      maxLength: column.character_maximum_length,
    })),
    keys: {
      primaryKey,
      uniqueConstraints,
    },
  };
}
