import { DatabaseSync } from 'node:sqlite';

export type SqlValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, SqlValue>;

/** The only place that touches node:sqlite, so it can be swapped for better-sqlite3 later. */
export interface Db {
  exec(sql: string): void;
  run(sql: string, ...params: SqlValue[]): { changes: number };
  get<T = Row>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T = Row>(sql: string, ...params: SqlValue[]): T[];
  /** Run fn in a transaction; rolls back if it throws. Nested calls join the outer one. */
  transaction<T>(fn: () => T): T;
  /** Consistent copy of the database to a file (used for rolling backups). */
  backupTo(file: string): void;
  close(): void;
}

export function openDb(file: string): Db {
  const d = new DatabaseSync(file);
  d.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  let depth = 0;
  return {
    exec: (sql) => d.exec(sql),
    run: (sql, ...p) => ({ changes: Number(d.prepare(sql).run(...p).changes) }),
    get: <T>(sql: string, ...p: SqlValue[]) => d.prepare(sql).get(...p) as T | undefined,
    all: <T>(sql: string, ...p: SqlValue[]) => d.prepare(sql).all(...p) as T[],
    transaction<T>(fn: () => T): T {
      if (depth > 0) return fn();
      d.exec('BEGIN IMMEDIATE');
      depth++;
      try {
        const r = fn();
        d.exec('COMMIT');
        return r;
      } catch (e) {
        d.exec('ROLLBACK');
        throw e;
      } finally {
        depth--;
      }
    },
    backupTo(dest) {
      d.exec('PRAGMA wal_checkpoint(PASSIVE)');
      d.prepare('VACUUM INTO ?').run(dest);
    },
    close: () => d.close(),
  };
}
