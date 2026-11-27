/**
 * node:sqlite のメモリ DB を D1 の口（prepare → bind → first / all / run / raw、batch、exec）で包んだ偽の D1。
 * SQL を文字列で見分ける偽物と違い、サーバが発行する SQL をそのまま SQLite が実行するので、
 * 行の保存と読み戻し（パスワードの入れ替え・セッションの有無）を本物の DB と同じ形で観測できる。
 * 外のプロセスも起動しない（Node 組み込みの SQLite）。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

export type { DatabaseSync }

type Param = string | number | bigint | null | Uint8Array

/** D1 が受ける値を node:sqlite が束ねられる値へ寄せる（真偽値は 0/1、undefined は null）。 */
const toParam = (value: unknown): Param => {
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || value instanceof Uint8Array) return value
  return String(value)
}

const meta = (db: DatabaseSync) => {
  const row = db.prepare('select changes() as changes, last_insert_rowid() as last_row_id').get() as { changes: number; last_row_id: number }
  return { changes: row.changes, last_row_id: row.last_row_id, duration: 0, rows_read: 0, rows_written: 0, size_after: 0, changed_db: row.changes > 0 }
}

class SqliteStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: Param[] = [],
  ) {}

  bind(...values: unknown[]) {
    return new SqliteStatement(this.db, this.sql, values.map(toParam))
  }

  private statement(): StatementSync {
    return this.db.prepare(this.sql)
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = (this.statement().get(...this.params) as Record<string, unknown> | undefined) ?? null
    if (row === null) return null
    if (column === undefined) return row as T
    return (row[column] as T) ?? null
  }

  async all<T = Record<string, unknown>>() {
    const results = this.statement().all(...this.params) as T[]
    return { results, success: true as const, meta: meta(this.db) }
  }

  async run<T = Record<string, unknown>>() {
    return this.all<T>()
  }

  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const statement = this.statement()
    statement.setReturnArrays(true)
    const rows = statement.all(...this.params) as unknown as T[]
    if (options?.columnNames) {
      const names = statement.columns().map((column) => column.name) as unknown as T
      return [names, ...rows]
    }
    return rows
  }
}

class SqliteD1 {
  constructor(readonly db: DatabaseSync) {}

  prepare(sql: string) {
    return new SqliteStatement(this.db, sql)
  }

  async batch(statements: SqliteStatement[]) {
    this.db.exec('BEGIN')
    try {
      const results = []
      for (const statement of statements) results.push(await statement.all())
      this.db.exec('COMMIT')
      return results
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  async exec(sql: string) {
    this.db.exec(sql)
    return { count: 0, duration: 0 }
  }

  async dump(): Promise<ArrayBuffer> {
    throw new Error('dump は偽の D1 では使えない')
  }
}

/** drizzle の migration ファイル群を番号順に読み、`--> statement-breakpoint` で割って順に流す。 */
const applyMigrations = (db: DatabaseSync, dir: URL) => {
  const files = readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()
  for (const file of files) {
    const statements = readFileSync(new URL(file, dir), 'utf8')
      .split(/-->\s*statement-breakpoint/)
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0)
    for (const statement of statements) db.exec(statement)
  }
}

const openD1 = async (migrationsDir: URL): Promise<D1Database> => {
  const db = new DatabaseSync(':memory:')
  applyMigrations(db, migrationsDir)
  return new SqliteD1(db) as unknown as D1Database
}

/** まなびばの DDL（portal/migrations）を流した空の D1。 */
export const portalD1 = () => openD1(new URL('../../portal/migrations/', import.meta.url))

/** 学び側の DDL（migrations）を流した空の D1。 */
export const learningD1 = () => openD1(new URL('../../migrations/', import.meta.url))

/** 偽の D1 の中の SQLite に直接触る（検査の仕込みにだけ使う）。 */
export const sqliteOf = (d1: D1Database): DatabaseSync => (d1 as unknown as SqliteD1).db
