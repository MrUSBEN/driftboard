import type { Db } from './db.ts';

/** Append only. Never edit a shipped migration. Version = index + 1, stored in PRAGMA user_version. */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE assets (
    id TEXT PRIMARY KEY,                 -- sha256 hex of the file content
    ext TEXT NOT NULL,                   -- without dot, lowercase
    kind TEXT NOT NULL,                  -- image | video | audio | other
    bytes INTEGER NOT NULL,
    width INTEGER, height INTEGER,
    duration_ms INTEGER, fps REAL,
    has_audio INTEGER,
    original_name TEXT,
    meta TEXT NOT NULL DEFAULT '{}',     -- JSON, free-form (probe output etc.)
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,                  -- generate | continue | bridge | extract | export | ...
    profile_id TEXT,
    profile_version INTEGER,
    workflow_hash TEXT,                  -- sha256 of the exact submitted workflow JSON
    params TEXT NOT NULL DEFAULT '{}',   -- JSON: slot values (prompt, seed, seconds, ...)
    status TEXT NOT NULL DEFAULT 'queued',  -- queued | running | done | failed | cancelled
    external_id TEXT,                    -- ComfyUI prompt_id
    error TEXT,
    progress REAL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    started_at TEXT,
    finished_at TEXT
  );
  CREATE INDEX jobs_status ON jobs(status);

  CREATE TABLE job_inputs (
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    asset_id TEXT NOT NULL REFERENCES assets(id),
    role TEXT NOT NULL,                  -- slot id, e.g. refs, first_frame
    idx INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (job_id, role, idx)
  );
  CREATE INDEX job_inputs_asset ON job_inputs(asset_id);

  CREATE TABLE job_outputs (
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    asset_id TEXT NOT NULL REFERENCES assets(id),
    role TEXT NOT NULL,
    idx INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (job_id, role, idx)
  );
  CREATE INDEX job_outputs_asset ON job_outputs(asset_id);

  -- Editable documents (board, timelines, story bible, notes). One JSON per id.
  CREATE TABLE docs (
    collection TEXT NOT NULL,
    id TEXT NOT NULL,
    json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (collection, id)
  );
  `,
  // 2: where on the canvas a job was started from (board item id), so results land beside it
  `ALTER TABLE jobs ADD COLUMN origin TEXT;`,
  // 3: the shot a job was started for, so results become takes of that shot
  `ALTER TABLE jobs ADD COLUMN shot_id TEXT;`,
];

export function migrate(db: Db): { from: number; to: number } {
  const from = Number(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0);
  if (from > MIGRATIONS.length) {
    throw new Error(`Project database is version ${from}, this app only knows ${MIGRATIONS.length}. Update Driftboard.`);
  }
  for (let v = from; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
  return { from, to: MIGRATIONS.length };
}
