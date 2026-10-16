import type {
  CarrierSql,
  CarrierSqlParam,
  CarrierSqlRow,
  CarrierSqlStatement,
} from "@archival/carrier";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    role TEXT NOT NULL DEFAULT 'reader',
    created_at TEXT NOT NULL,
    budget_hour TEXT,
    budget_used INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS users_by_created ON users (created_at)`,
  `CREATE TABLE IF NOT EXISTS passkeys (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    public_key BLOB NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT,
    created_at TEXT NOT NULL,
    used_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS passkeys_by_user ON passkeys (user_id)`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`,
  // A WebAuthn challenge between its options and the response that answers
  // it. Each is used once.
  `CREATE TABLE IF NOT EXISTS challenges (
    id TEXT PRIMARY KEY,
    challenge TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT,
    role TEXT,
    expires_at TEXT NOT NULL
  )`,
  // parent_id is a thread id of any source: "l:<id>", "ap:<id>" or "wm:<url>".
  `CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL,
    parent_id TEXT,
    user_id INTEGER NOT NULL,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS comments_by_slug ON comments (slug, id)`,
  `CREATE INDEX IF NOT EXISTS comments_by_user ON comments (user_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS comments_by_created ON comments (created_at)`,
];

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

  transaction(statements: CarrierSqlStatement[]): Promise<CarrierSqlRow[][]> {
    return this.#sql.transaction(statements);
  }
}

export const now = () => new Date().toISOString();

export const randomToken = (bytes = 16) => {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

export const sameSecret = (a: string, b: string) => {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let difference = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    difference |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return difference === 0;
};
