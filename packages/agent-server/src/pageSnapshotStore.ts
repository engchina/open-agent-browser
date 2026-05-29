import { sanitizePageSnapshot, type PageSnapshot } from "@open-agent-browser/shared";
import type { Database } from "./sqlite.js";

export class PageSnapshotStore {
  private latestSnapshot: PageSnapshot | undefined;
  private readonly snapshotsByTabId = new Map<number, PageSnapshot>();

  constructor(private readonly database?: Database) {
    this.database?.exec(`
      CREATE TABLE IF NOT EXISTS page_snapshots (
        key TEXT PRIMARY KEY,
        tab_id INTEGER,
        snapshot TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  upsert(snapshot: PageSnapshot): PageSnapshot {
    const sanitized = cloneSnapshot(sanitizePageSnapshot(snapshot));
    this.latestSnapshot = sanitized;

    if (typeof sanitized.tabId === "number") {
      this.snapshotsByTabId.set(sanitized.tabId, sanitized);
    }

    if (this.database) {
      this.upsertPersistedSnapshot("latest", sanitized);
      if (typeof sanitized.tabId === "number") {
        this.upsertPersistedSnapshot(`tab:${sanitized.tabId}`, sanitized);
      }
    }

    return cloneSnapshot(sanitized);
  }

  get(tabId?: number): PageSnapshot | undefined {
    const snapshot = this.database
      ? this.getPersistedSnapshot(typeof tabId === "number" ? `tab:${tabId}` : "latest")
      : typeof tabId === "number" ? this.snapshotsByTabId.get(tabId) : this.latestSnapshot;
    return snapshot ? cloneSnapshot(snapshot) : undefined;
  }

  clear(tabId?: number): number {
    if (typeof tabId === "number") {
      return this.clearTab(tabId);
    }

    const inMemoryCount = (this.latestSnapshot ? 1 : 0) + this.snapshotsByTabId.size;
    this.latestSnapshot = undefined;
    this.snapshotsByTabId.clear();

    if (!this.database) {
      return inMemoryCount;
    }

    const persistedCount = this.countPersistedSnapshots();
    this.database.prepare("DELETE FROM page_snapshots").run();
    return persistedCount;
  }

  private clearTab(tabId: number): number {
    const latestSnapshot = this.database ? this.getPersistedSnapshot("latest") : this.latestSnapshot;
    const keys = [`tab:${tabId}`];
    if (latestSnapshot?.tabId === tabId) {
      keys.push("latest");
    }

    let inMemoryCount = 0;
    if (this.snapshotsByTabId.delete(tabId)) {
      inMemoryCount += 1;
    }
    if (this.latestSnapshot?.tabId === tabId) {
      this.latestSnapshot = undefined;
      inMemoryCount += 1;
    }

    if (!this.database) {
      return inMemoryCount;
    }

    const persistedCount = this.countPersistedKeys(keys);
    for (const key of keys) {
      this.database.prepare("DELETE FROM page_snapshots WHERE key = ?").run(key);
    }
    return persistedCount;
  }

  private upsertPersistedSnapshot(key: string, snapshot: PageSnapshot): void {
    const now = new Date().toISOString();
    this.database
      ?.prepare("DELETE FROM page_snapshots WHERE key = ?")
      .run(key);
    this.database
      ?.prepare("INSERT INTO page_snapshots (key, tab_id, snapshot, captured_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(
        key,
        snapshot.tabId ?? null,
        JSON.stringify(snapshot),
        snapshot.capturedAt,
        now
      );
  }

  private getPersistedSnapshot(key: string): PageSnapshot | undefined {
    if (!this.database) {
      return undefined;
    }

    const rows = this.database
      .prepare("SELECT snapshot FROM page_snapshots WHERE key = ?")
      .all(key) as Array<{ snapshot: string }>;
    const row = rows[0];
    if (!row) {
      return undefined;
    }

    return JSON.parse(row.snapshot) as PageSnapshot;
  }

  private countPersistedKeys(keys: string[]): number {
    if (!this.database || keys.length === 0) {
      return 0;
    }

    let count = 0;
    for (const key of keys) {
      const rows = this.database
        .prepare("SELECT COUNT(*) AS count FROM page_snapshots WHERE key = ?")
        .all(key) as Array<{ count: number }>;
      count += rows[0]?.count ?? 0;
    }
    return count;
  }

  private countPersistedSnapshots(): number {
    if (!this.database) {
      return 0;
    }

    const rows = this.database
      .prepare("SELECT COUNT(*) AS count FROM page_snapshots")
      .all() as Array<{ count: number }>;
    return rows[0]?.count ?? 0;
  }
}

function cloneSnapshot(snapshot: PageSnapshot): PageSnapshot {
  const cloned: PageSnapshot = {
    ...snapshot,
    elements: snapshot.elements.map((element) => ({
      ...element,
      attributes: { ...element.attributes }
    })),
    links: snapshot.links.map((link) => ({ ...link }))
  };

  if (snapshot.headings) {
    cloned.headings = snapshot.headings.map((heading) => ({ ...heading }));
  }

  if (snapshot.tables) {
    cloned.tables = snapshot.tables.map((table) => ({
      ...table,
      headers: [...table.headers],
      rows: table.rows.map((row) => [...row])
    }));
  }

  return cloned;
}
