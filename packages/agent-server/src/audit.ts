import type { Database } from "./sqlite.js";

export interface AuditEvent {
  createdAt: string;
  id: string;
  payload: unknown;
  type: string;
}

export class AuditLog {
  private readonly events: AuditEvent[] = [];

  constructor(private readonly database?: Database) {
    this.database?.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  append(type: string, payload: unknown): AuditEvent {
    const event: AuditEvent = {
      createdAt: new Date().toISOString(),
      id: crypto.randomUUID(),
      payload,
      type
    };
    if (this.database) {
      this.database
        .prepare("INSERT INTO audit_events (id, type, payload, created_at) VALUES (?, ?, ?, ?)")
        .run(event.id, event.type, JSON.stringify(event.payload), event.createdAt);
    } else {
      this.events.push(event);
    }
    return event;
  }

  list(): AuditEvent[] {
    if (!this.database) {
      return [...this.events];
    }

    return this.database
      .prepare("SELECT id, type, payload, created_at FROM audit_events ORDER BY created_at ASC")
      .all()
      .map((row) => {
        const typed = row as {
          created_at: string;
          id: string;
          payload: string;
          type: string;
        };

        return {
          createdAt: typed.created_at,
          id: typed.id,
          payload: JSON.parse(typed.payload) as unknown,
          type: typed.type
        };
      });
  }
}
