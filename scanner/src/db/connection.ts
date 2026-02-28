import { createClient, ClickHouseClient } from "@clickhouse/client";
import { SCHEMA_DDL } from "./schema";

// ─── Config ──────────────────────────────────────────────────────

export interface ClickHouseConfig {
  url: string; // e.g. "http://localhost:8123"
  database: string; // e.g. "scanner"
  enabled: boolean;
}

// ─── ClickHouseDb ────────────────────────────────────────────────

export class ClickHouseDb {
  private client: ClickHouseClient | null = null;
  private _ready = false;
  private config: ClickHouseConfig;

  constructor(config: ClickHouseConfig) {
    this.config = config;
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  async init(): Promise<void> {
    if (!this.config.enabled) return;

    this.client = createClient({
      url: this.config.url,
      // connect to 'default' first to create the database
      database: "default",
      clickhouse_settings: {
        wait_end_of_query: 1,
      },
    });

    await this.initWithRetry(5, 3000);
  }

  private async initWithRetry(maxRetries: number, delayMs: number) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.ensureSchema();
        // Reconnect with the target database
        await this.client!.close();
        this.client = createClient({
          url: this.config.url,
          database: this.config.database,
          clickhouse_settings: {
            wait_end_of_query: 1,
          },
        });
        this._ready = true;
        console.log(`[clickhouse] ready (${this.config.url}/${this.config.database})`);
        return;
      } catch (err: any) {
        const isConnErr =
          err.message?.includes("ECONNREFUSED") ||
          err.message?.includes("ETIMEDOUT") ||
          err.message?.includes("fetch failed");
        if (isConnErr && attempt < maxRetries) {
          console.log(
            `[clickhouse] not ready, retry ${attempt}/${maxRetries} in ${delayMs / 1000}s...`,
          );
          await new Promise((r) => setTimeout(r, delayMs));
        } else {
          console.error(`[clickhouse] init error after ${attempt} attempts: ${err.message}`);
          return;
        }
      }
    }
  }

  private async ensureSchema() {
    for (const ddl of SCHEMA_DDL) {
      await this.client!.command({ query: ddl });
    }
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this._ready = false;
    }
  }

  get ready(): boolean {
    return this._ready;
  }

  // ── Query helpers ──────────────────────────────────────────────

  /** Execute a command (DDL, INSERT without return) */
  async command(query: string): Promise<void> {
    if (!this._ready || !this.client) throw new Error("ClickHouse not ready");
    await this.client.command({ query });
  }

  /** Run a SELECT and return typed rows */
  async query<T = Record<string, unknown>>(query: string): Promise<T[]> {
    if (!this._ready || !this.client) throw new Error("ClickHouse not ready");
    const result = await this.client.query({
      query,
      format: "JSONEachRow",
    });
    return (await result.json()) as T[];
  }

  /** Insert rows into a table using JSONEachRow format */
  async insert<T extends Record<string, unknown>>(
    table: string,
    values: T[],
  ): Promise<void> {
    if (!this._ready || !this.client) throw new Error("ClickHouse not ready");
    if (values.length === 0) return;

    await this.client.insert({
      table,
      values,
      format: "JSONEachRow",
    });
  }

  /** Get the raw client for advanced use */
  getClient(): ClickHouseClient | null {
    return this.client;
  }
}
