import type { TableReference } from "../types";

export function parseTableName(
  tableName: string,
  defaultSchema = "public",
): TableReference {
  const cleaned = tableName.trim();
  if (!cleaned) {
    throw new Error("tableName is required");
  }

  const [maybeSchema, maybeName, extra] = cleaned.split(".");
  if (extra) {
    throw new Error(
      `Invalid tableName \"${tableName}\". Use \"table\" or \"schema.table\".`,
    );
  }

  if (!maybeName) {
    return {
      schema: defaultSchema,
      name: maybeSchema,
      fullName: `${defaultSchema}.${maybeSchema}`,
    };
  }

  return {
    schema: maybeSchema,
    name: maybeName,
    fullName: `${maybeSchema}.${maybeName}`,
  };
}
