import { openSqliteDatabase, type Database } from "./sqlite.js";
import type { MemoryRecord, PendingMemoryWrite } from "@open-agent-browser/shared";

export class SqliteMemoryStore {
  private readonly pending = new Map<string, PendingMemoryWrite>();

  constructor(private readonly database: Database, private readonly ownsDatabase = false) {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        tags TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  static async open(path = "data/open-agent-browser.sqlite"): Promise<SqliteMemoryStore> {
    return new SqliteMemoryStore(await openSqliteDatabase(path), true);
  }

  createPendingWrite(content: string, tags: string[] = []): PendingMemoryWrite {
    const pending: PendingMemoryWrite = {
      content,
      id: crypto.randomUUID(),
      tags,
      token: crypto.randomUUID()
    };
    this.pending.set(pending.token, pending);
    return pending;
  }

  confirmWrite(token: string): MemoryRecord | undefined {
    const pending = this.pending.get(token);
    if (!pending) {
      return undefined;
    }

    this.pending.delete(token);
    const record: MemoryRecord = {
      content: pending.content,
      createdAt: new Date().toISOString(),
      id: pending.id,
      tags: pending.tags
    };

    this.database
      .prepare("INSERT INTO memories (id, content, tags, created_at) VALUES (?, ?, ?, ?)")
      .run(record.id, record.content, JSON.stringify(record.tags), record.createdAt);

    return record;
  }

  list(): MemoryRecord[] {
    return this.database
      .prepare("SELECT id, content, tags, created_at FROM memories ORDER BY created_at DESC")
      .all()
      .map((row) => {
        const typed = row as {
          content: string;
          created_at: string;
          id: string;
          tags: string;
        };

        return {
          content: typed.content,
          createdAt: typed.created_at,
          id: typed.id,
          tags: JSON.parse(typed.tags) as string[]
        };
      });
  }

  delete(memoryId: string): MemoryRecord | undefined {
    const record = this.get(memoryId);
    if (!record) {
      return undefined;
    }

    this.database
      .prepare("DELETE FROM memories WHERE id = ?")
      .run(memoryId);
    return record;
  }

  close(): void {
    if (this.ownsDatabase) {
      this.database.close();
    }
  }

  private get(memoryId: string): MemoryRecord | undefined {
    const rows = this.database
      .prepare("SELECT id, content, tags, created_at FROM memories WHERE id = ?")
      .all(memoryId) as Array<{
        content: string;
        created_at: string;
        id: string;
        tags: string;
      }>;
    const row = rows[0];
    if (!row) {
      return undefined;
    }

    return {
      content: row.content,
      createdAt: row.created_at,
      id: row.id,
      tags: JSON.parse(row.tags) as string[]
    };
  }
}
