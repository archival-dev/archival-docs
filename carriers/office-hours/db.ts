import type {
  CarrierSql,
  CarrierSqlParam,
  CarrierSqlRow,
  CarrierSqlStatement,
} from "@archival/carrier";

const SCHEMA = [
  // One row per person per event. A cancelled row is kept, so an RSVP made
  // again for the same event revives it rather than adding a second line to
  // the Notion page.
  `CREATE TABLE IF NOT EXISTS rsvps (
    id INTEGER PRIMARY KEY,
    event_id TEXT NOT NULL,
    event_name TEXT NOT NULL,
    event_start TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL COLLATE NOCASE,
    plan TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    notion_block_id TEXT,
    created_at TEXT NOT NULL,
    cancelled_at TEXT,
    reminded_at TEXT,
    UNIQUE (event_id, email)
  )`,
  `CREATE INDEX IF NOT EXISTS rsvps_by_event ON rsvps (event_id, cancelled_at)`,
  `CREATE INDEX IF NOT EXISTS rsvps_by_created ON rsvps (created_at)`,
];

export interface RsvpRow extends CarrierSqlRow {
  id: number;
  event_id: string;
  event_name: string;
  event_start: string;
  name: string;
  email: string;
  plan: string;
  token_hash: string;
  notion_block_id: string | null;
  created_at: string;
  cancelled_at: string | null;
  reminded_at: string | null;
}

export class Database {
  #sql: CarrierSql;
  static #ready: Promise<unknown> | null = null;

  constructor(sql: CarrierSql) {
    this.#sql = sql;
  }

  // Once per isolate. Every statement is idempotent, and a fresh isolate may
  // be the first to see the database.
  migrate(): Promise<unknown> {
    Database.#ready ??= this.#sql
      .transaction(SCHEMA.map((statement): CarrierSqlStatement => [statement]))
      .catch((error) => {
        Database.#ready = null;
        throw error;
      });
    return Database.#ready;
  }

  all<T extends CarrierSqlRow>(
    sql: string,
    ...params: CarrierSqlParam[]
  ): Promise<T[]> {
    return this.#sql.exec<T>(sql, ...params);
  }

  async one<T extends CarrierSqlRow>(
    sql: string,
    ...params: CarrierSqlParam[]
  ): Promise<T | undefined> {
    return (await this.#sql.exec<T>(sql, ...params))[0];
  }
}

export const now = () => new Date().toISOString();

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export const randomToken = (bytes = 24) =>
  base64url(crypto.getRandomValues(new Uint8Array(bytes)));

export const hashToken = async (token: string) =>
  base64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    ),
  );
