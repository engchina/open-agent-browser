import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Statement {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}

export interface Database {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): Statement;
}

type DatabaseSyncConstructor = new (path: string) => Database;

export async function openSqliteDatabase(path = "data/open-agent-browser.sqlite"): Promise<Database> {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const sqlite = (await import("node:sqlite")) as unknown as {
    DatabaseSync: DatabaseSyncConstructor;
  };

  return new sqlite.DatabaseSync(path);
}
