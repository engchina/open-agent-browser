import { providerConfigSchema, type ProviderConfig } from "@open-agent-browser/shared";
import type { Database } from "./sqlite.js";

export class ProviderConfigStore {
  constructor(private readonly database: Database) {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS provider_config (
        id TEXT PRIMARY KEY CHECK (id = 'default'),
        config TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  get(): ProviderConfig | undefined {
    const rows = this.database
      .prepare("SELECT config FROM provider_config WHERE id = 'default'")
      .all();
    const row = rows[0] as { config: string } | undefined;

    if (!row) {
      return undefined;
    }

    return providerConfigSchema.parse(JSON.parse(row.config));
  }

  save(config: ProviderConfig): ProviderConfig {
    const parsed = providerConfigSchema.parse(config);
    this.database
      .prepare(`
        INSERT INTO provider_config (id, config, updated_at)
        VALUES ('default', ?, ?)
        ON CONFLICT(id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at
      `)
      .run(JSON.stringify(parsed), new Date().toISOString());

    return parsed;
  }
}
