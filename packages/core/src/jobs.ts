import { createHash, randomUUID } from 'node:crypto';
import type { Db } from './db.ts';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export interface Job {
  id: string; kind: string; profile_id: string | null; profile_version: number | null; workflow_hash: string | null;
  params: string; status: JobStatus; external_id: string | null; error: string | null; progress: number | null;
  created_at: string; started_at: string | null; finished_at: string | null;
  /** board item id the job was started from */
  origin: string | null;
  /** shot the job was started for; results become its takes */
  shot_id: string | null;
}
export interface IoRef { assetId: string; role: string; idx?: number }
export interface NewJob {
  kind: string; profileId?: string; profileVersion?: number; workflowHash?: string;
  params?: Record<string, unknown>; inputs?: IoRef[]; origin?: string; shotId?: string;
}

const NEXT: Record<JobStatus, JobStatus[]> = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['done', 'failed', 'cancelled'],
  done: [], failed: [], cancelled: [],
};

export const hashJson = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');

export class JobStore {
  constructor(private db: Db) {}

  create(j: NewJob): Job {
    const id = randomUUID();
    this.db.transaction(() => {
      this.db.run(
        'INSERT INTO jobs (id, kind, profile_id, profile_version, workflow_hash, params, origin, shot_id) VALUES (?,?,?,?,?,?,?,?)',
        id, j.kind, j.profileId ?? null, j.profileVersion ?? null, j.workflowHash ?? null, JSON.stringify(j.params ?? {}), j.origin ?? null, j.shotId ?? null,
      );
      (j.inputs ?? []).forEach((r, i) =>
        this.db.run('INSERT INTO job_inputs (job_id, asset_id, role, idx) VALUES (?,?,?,?)', id, r.assetId, r.role, r.idx ?? i));
    });
    return this.get(id)!;
  }

  get(id: string): Job | undefined { return this.db.get<Job>('SELECT * FROM jobs WHERE id = ?', id); }
  list(status?: JobStatus): Job[] {
    return status ? this.db.all<Job>('SELECT * FROM jobs WHERE status = ? ORDER BY created_at, rowid', status)
                  : this.db.all<Job>('SELECT * FROM jobs ORDER BY created_at, rowid');
  }
  inputs(id: string): IoRef[] {
    return this.db.all<{ asset_id: string; role: string; idx: number }>('SELECT * FROM job_inputs WHERE job_id = ? ORDER BY role, idx', id)
      .map((r) => ({ assetId: r.asset_id, role: r.role, idx: r.idx }));
  }
  outputs(id: string): IoRef[] {
    return this.db.all<{ asset_id: string; role: string; idx: number }>('SELECT * FROM job_outputs WHERE job_id = ? ORDER BY role, idx', id)
      .map((r) => ({ assetId: r.asset_id, role: r.role, idx: r.idx }));
  }

  /** Move a job to a new status; illegal moves throw. */
  transition(id: string, to: JobStatus, patch: { error?: string; externalId?: string; outputs?: IoRef[] } = {}): Job {
    return this.db.transaction(() => {
      const job = this.get(id);
      if (!job) throw new Error(`No job ${id}`);
      if (!NEXT[job.status].includes(to)) throw new Error(`Job ${id}: cannot go ${job.status} -> ${to}`);
      const now = new Date().toISOString();
      this.db.run(
        `UPDATE jobs SET status = ?, error = COALESCE(?, error), external_id = COALESCE(?, external_id),
           started_at = CASE WHEN ? = 'running' THEN ? ELSE started_at END,
           finished_at = CASE WHEN ? IN ('done','failed','cancelled') THEN ? ELSE finished_at END,
           progress = CASE WHEN ? = 'done' THEN 1 ELSE progress END WHERE id = ?`,
        to, patch.error ?? null, patch.externalId ?? null, to, now, to, now, to, id,
      );
      (patch.outputs ?? []).forEach((r, i) =>
        this.db.run('INSERT INTO job_outputs (job_id, asset_id, role, idx) VALUES (?,?,?,?)', id, r.assetId, r.role, r.idx ?? i));
      return this.get(id)!;
    });
  }

  setProgress(id: string, p: number): void { this.db.run('UPDATE jobs SET progress = ? WHERE id = ? AND status = ?', p, id, 'running'); }

  /** Oldest queued job, marked running. Returns undefined when the queue is empty. */
  claimNext(): Job | undefined {
    return this.db.transaction(() => {
      const j = this.db.get<Job>("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at, rowid LIMIT 1");
      return j ? this.transition(j.id, 'running') : undefined;
    });
  }

  /** After a crash, jobs left 'running' did not finish. Mark them failed so the UI can offer retry. */
  recoverInterrupted(): Job[] {
    return this.db.transaction(() =>
      this.db.all<Job>("SELECT * FROM jobs WHERE status = 'running'").map((j) => this.transition(j.id, 'failed', { error: 'Interrupted: app closed or crashed while running' })));
  }

  /** New queued job with the same recipe (same profile, params, inputs). Pass params to nudge e.g. the seed. */
  retry(id: string, override: Record<string, unknown> = {}): Job {
    const j = this.get(id);
    if (!j) throw new Error(`No job ${id}`);
    return this.create({
      kind: j.kind, profileId: j.profile_id ?? undefined, profileVersion: j.profile_version ?? undefined,
      workflowHash: j.workflow_hash ?? undefined, params: { ...JSON.parse(j.params), ...override }, inputs: this.inputs(id), origin: j.origin ?? undefined, shotId: j.shot_id ?? undefined,
    });
  }

  /** Record work that already happened (e.g. a frame cut from a clip) so lineage covers it. */
  recordDone(kind: string, inputs: IoRef[], outputs: IoRef[], params: Record<string, unknown> = {}): Job {
    return this.db.transaction(() => {
      const j = this.create({ kind, params, inputs });
      this.transition(j.id, 'running');
      return this.transition(j.id, 'done', { outputs });
    });
  }

  /** Where an asset came from: the job that made it and that job's inputs. */
  producedBy(assetId: string): { job: Job; inputs: IoRef[] } | undefined {
    const j = this.db.get<Job>('SELECT j.* FROM jobs j JOIN job_outputs o ON o.job_id = j.id WHERE o.asset_id = ? ORDER BY j.created_at LIMIT 1', assetId);
    return j ? { job: j, inputs: this.inputs(j.id) } : undefined;
  }

  /** All assets an asset was derived from, nearest first, with depth. */
  ancestors(assetId: string): { assetId: string; depth: number }[] {
    return this.db.all<{ asset_id: string; depth: number }>(
      `WITH RECURSIVE anc(asset_id, depth) AS (
         SELECT i.asset_id, 1 FROM job_outputs o JOIN job_inputs i ON i.job_id = o.job_id WHERE o.asset_id = ?
         UNION
         SELECT i.asset_id, a.depth + 1 FROM anc a JOIN job_outputs o ON o.asset_id = a.asset_id JOIN job_inputs i ON i.job_id = o.job_id WHERE a.depth < 100
       ) SELECT asset_id, MIN(depth) AS depth FROM anc GROUP BY asset_id ORDER BY depth`, assetId,
    ).map((r) => ({ assetId: r.asset_id, depth: r.depth }));
  }

  /** Assets made from this asset, any depth. */
  descendants(assetId: string): { assetId: string; depth: number }[] {
    return this.db.all<{ asset_id: string; depth: number }>(
      `WITH RECURSIVE d(asset_id, depth) AS (
         SELECT o.asset_id, 1 FROM job_inputs i JOIN job_outputs o ON o.job_id = i.job_id WHERE i.asset_id = ?
         UNION
         SELECT o.asset_id, d.depth + 1 FROM d JOIN job_inputs i ON i.asset_id = d.asset_id JOIN job_outputs o ON o.job_id = i.job_id WHERE d.depth < 100
       ) SELECT asset_id, MIN(depth) AS depth FROM d GROUP BY asset_id ORDER BY depth`, assetId,
    ).map((r) => ({ assetId: r.asset_id, depth: r.depth }));
  }
}
