import initSqlJs, { type Database, type SqlValue } from "sql.js";

export const SQLITE_ONLINE_FILE_LIMIT_BYTES = 50 * 1024 * 1024;
export const SQLITE_TABLE_ROW_LIMIT = 50_000;

export type SQLiteTableData = {
  columns: string[];
  rows: Record<string, string>[];
  totalRowCount: number;
  loadedRowCount: number;
  truncated: boolean;
};

let sqlModulePromise: ReturnType<typeof initSqlJs> | null = null;

function getSqlModule() {
  if (!sqlModulePromise) {
    sqlModulePromise = initSqlJs({
      locateFile: () => "/sql-wasm.wasm",
    });
  }
  return sqlModulePromise;
}

function quoteIdentifier(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function normalizeSqlValue(value: SqlValue) {
  if (value === null) return "";
  if (value instanceof Uint8Array) return `[BLOB ${value.byteLength} bytes]`;
  return String(value);
}

export async function openSQLiteFile(file: File) {
  if (file.size > SQLITE_ONLINE_FILE_LIMIT_BYTES) {
    throw new Error(
      `Online SQLite mode supports files up to ${Math.round(
        SQLITE_ONLINE_FILE_LIMIT_BYTES / 1024 / 1024
      )} MB. This file is ${(file.size / 1024 / 1024).toFixed(1)} MB.`
    );
  }

  const SQL = await getSqlModule();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const database = new SQL.Database(bytes);
  const result = database.exec(
    "SELECT name FROM sqlite_master " +
      "WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );
  const tables = result[0]?.values.map((row) => String(row[0])) ?? [];

  if (tables.length === 0) {
    database.close();
    throw new Error("No user tables were found in this SQLite database.");
  }

  return { database, tables };
}

export function readSQLiteTable(
  database: Database,
  tableName: string,
  rowLimit = SQLITE_TABLE_ROW_LIMIT
): SQLiteTableData {
  const quotedTable = quoteIdentifier(tableName);
  const tableExists = database.exec(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = $name LIMIT 1",
    { $name: tableName }
  );

  if (!tableExists[0]?.values.length) {
    throw new Error(`SQLite table not found: ${tableName}`);
  }

  const countResult = database.exec(
    `SELECT COUNT(*) AS row_count FROM ${quotedTable}`
  );
  const totalRowCount = Number(countResult[0]?.values[0]?.[0] ?? 0);
  const columnResult = database.exec(`PRAGMA table_info(${quotedTable})`);
  const columns =
    columnResult[0]?.values.map((row) => String(row[1])) ?? [];

  if (columns.length === 0 || totalRowCount === 0) {
    return {
      columns,
      rows: [],
      totalRowCount,
      loadedRowCount: 0,
      truncated: false,
    };
  }

  const result = database.exec(
    `SELECT * FROM ${quotedTable} LIMIT ${Math.max(1, Math.floor(rowLimit))}`
  );
  const resultColumns = result[0]?.columns ?? columns;
  const rows =
    result[0]?.values.map((values) =>
      Object.fromEntries(
        resultColumns.map((column, index) => [
          column,
          normalizeSqlValue(values[index]),
        ])
      )
    ) ?? [];

  return {
    columns: resultColumns,
    rows,
    totalRowCount,
    loadedRowCount: rows.length,
    truncated: totalRowCount > rows.length,
  };
}
