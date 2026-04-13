import type { TableReference, TableSchema } from "../../src/types";

type UpsertResult = {
  error: null | {
    message: string;
    code?: string;
    details?: string;
    hint?: string;
  };
};

type UpsertHandler = (
  tableName: string,
  rows: Record<string, unknown>[],
  options?: { onConflict?: string },
) => Promise<UpsertResult> | UpsertResult;

export function createMockSupabaseClient(input: {
  tableSchema: TableSchema;
  upsertHandler?: UpsertHandler;
}) {
  const { tableSchema } = input;
  const upsertHandler =
    input.upsertHandler ?? (async () => ({ error: null as UpsertResult["error"] }));

  return {
    schema(schemaName: string) {
      if (schemaName !== "information_schema") {
        throw new Error(`Mock supports only information_schema, got ${schemaName}`);
      }

      return {
        from(table: string) {
          return new InformationSchemaQueryBuilder(tableSchema, table);
        },
      };
    },

    from(tableName: string) {
      return {
        upsert: async (
          rows: Record<string, unknown>[],
          options?: { onConflict?: string },
        ) => upsertHandler(tableName, rows, options),
      };
    },
  };
}

class InformationSchemaQueryBuilder {
  private readonly filters = new Map<string, unknown>();
  private inFilter?: { key: string; values: string[] };

  constructor(
    private readonly tableSchema: TableSchema,
    private readonly tableName: string,
  ) {}

  select(_columns: string): this {
    return this;
  }

  eq(key: string, value: unknown): this {
    this.filters.set(key, value);
    return this;
  }

  in(key: string, values: string[]): this {
    this.inFilter = { key, values };
    return this;
  }

  order(_column: string, _options?: { ascending?: boolean }): this {
    return this;
  }

  then<TResult1 = any, TResult2 = never>(
    onfulfilled?: ((value: any) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled ?? undefined, onrejected ?? undefined);
  }

  private async execute(): Promise<{ data: any[]; error: null }> {
    const tableSchema = this.filters.get("table_schema");
    const tableName = this.filters.get("table_name");

    if (
      tableSchema !== this.tableSchema.table.schema ||
      tableName !== this.tableSchema.table.name
    ) {
      return { data: [], error: null };
    }

    if (this.tableName === "columns") {
      return {
        data: this.tableSchema.columns.map((column, index) => ({
          ordinal_position: index + 1,
          column_name: column.name,
          data_type: column.dataType,
          udt_name: column.udtName ?? null,
          is_nullable: column.isNullable ? "YES" : "NO",
          column_default: column.defaultValue ?? null,
          character_maximum_length: column.maxLength ?? null,
        })),
        error: null,
      };
    }

    const constraints = buildConstraints(this.tableSchema.table, this.tableSchema);

    if (this.tableName === "table_constraints") {
      let rows = constraints.map((constraint) => ({
        constraint_name: constraint.name,
        constraint_type: constraint.type,
      }));

      if (this.inFilter?.key === "constraint_type") {
        const allowed = new Set(this.inFilter.values);
        rows = rows.filter((row) => allowed.has(row.constraint_type));
      }

      return {
        data: rows,
        error: null,
      };
    }

    if (this.tableName === "key_column_usage") {
      return {
        data: constraints.flatMap((constraint) =>
          constraint.columns.map((column, index) => ({
            constraint_name: constraint.name,
            column_name: column,
            ordinal_position: index + 1,
          })),
        ),
        error: null,
      };
    }

    return {
      data: [],
      error: null,
    };
  }
}

function buildConstraints(table: TableReference, schema: TableSchema) {
  const constraints: Array<{ name: string; type: string; columns: string[] }> = [];

  if (schema.keys.primaryKey.length > 0) {
    constraints.push({
      name: `${table.name}_pkey`,
      type: "PRIMARY KEY",
      columns: schema.keys.primaryKey,
    });
  }

  schema.keys.uniqueConstraints.forEach((columns, index) => {
    constraints.push({
      name: `${table.name}_unique_${index + 1}`,
      type: "UNIQUE",
      columns,
    });
  });

  return constraints;
}
