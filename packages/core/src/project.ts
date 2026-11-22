import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDb, type Db } from './db.ts';
import { migrate, MIGRATIONS } from './migrations.ts';
import { writeFileAtomic, cleanTemps } from './atomic.ts';
import { AssetStore } from './assets.ts';
import { JobStore, type Job } from './jobs.ts';
import { DocStore } from './docs.ts';
import { BoardStore } from './board.ts';
import { StoryStore } from './story.ts';
import { ManualStore } from './manual.ts';

export const FORMAT_VERSION = 1;
export const PROJECT_FILE = 'project.driftboard.json';
export const LEGACY_PROJECT_FILE = 'project.meldreel.json';
/** Path of a folder's project file. A project made before the rename holds project.meldreel.json: it is renamed once, in place. */
export async function projectFile(dir: string): Promise<string> {
  const f = path.join(dir, PROJECT_FILE), old = path.join(dir, LEGACY_PROJECT_FILE);
  if (!(await exists(f)) && (await exists(old))) await fs.rename(old, f);
  return f;
}
export const DB_FILE = 'driftboard.db';
export const LEGACY_DB_FILE = 'meldreel.db';
/** Path of a folder's database. A project made before the rename holds meldreel.db (and maybe -wal/-shm): renamed once, in place. */
async function dbFileIn(dir: string): Promise<string> {
  const f = path.join(dir, DB_FILE);
  if (!(await exists(f))) for (const s of ['', '-wal', '-shm']) if (await exists(path.join(dir, LEGACY_DB_FILE + s))) await fs.rename(path.join(dir, LEGACY_DB_FILE + s), f + s);
  return f;
}
const SUBDIRS = ['assets', 'thumbs', 'proxies', 'workflows', 'profiles', 'exports', 'backups'];

export interface ProjectFile { formatVersion: number; id: string; name: string; created: string }

export class Project {
  readonly assets: AssetStore;
  readonly jobs: JobStore;
  readonly docs: DocStore;
  readonly board: BoardStore;
  readonly story: StoryStore;
  readonly manual: ManualStore;
  /** Jobs that were running when the app last stopped; now marked failed. */
  recovered: Job[] = [];
  private constructor(readonly dir: string, readonly info: ProjectFile, readonly db: Db) {
    this.assets = new AssetStore(db, path.join(dir, 'assets'));
    this.jobs = new JobStore(db);
    this.docs = new DocStore(db);
    this.board = new BoardStore(this.docs, db);
    this.story = new StoryStore(this.docs);
    this.manual = new ManualStore(this.docs);
  }

  static async create(dir: string, name: string): Promise<Project> {
    await fs.mkdir(dir, { recursive: true });
    if (await exists(path.join(dir, PROJECT_FILE)) || await exists(path.join(dir, LEGACY_PROJECT_FILE))) throw new Error(`A project already exists in ${dir}`);
    for (const s of SUBDIRS) await fs.mkdir(path.join(dir, s), { recursive: true });
    const info: ProjectFile = { formatVersion: FORMAT_VERSION, id: randomUUID(), name, created: new Date().toISOString() };
    const db = openDb(path.join(dir, DB_FILE));
    migrate(db);
    await writeFileAtomic(path.join(dir, PROJECT_FILE), JSON.stringify(info, null, 2));
    return new Project(dir, info, db);
  }

  static async open(dir: string): Promise<Project> {
    const raw = await fs.readFile(await projectFile(dir), 'utf8').catch(() => { throw new Error(`Not a Driftboard project: ${dir}`); });
    const info = JSON.parse(raw) as ProjectFile;
    if (info.formatVersion > FORMAT_VERSION) throw new Error(`Project format ${info.formatVersion} is newer than this app (${FORMAT_VERSION}). Update Driftboard.`);
    for (const s of SUBDIRS) await fs.mkdir(path.join(dir, s), { recursive: true });
    // leftovers from a crash mid-write
    await cleanTemps(dir);
    for (const d of ['assets', 'thumbs', 'proxies', 'workflows']) await cleanTempsDeep(path.join(dir, d));
    const dbFile = await dbFileIn(dir);
    let db: Db;
    try {
      db = openDb(dbFile);
      const res = db.get('PRAGMA quick_check');
      const verdict = res ? String(Object.values(res)[0]) : 'no result';
      if (verdict !== 'ok') throw new Error(`database check failed: ${verdict}`);
    } catch (e) {
      throw new Error(`Project database is damaged (${(e as Error).message}). Latest backups are in ${path.join(dir, 'backups')}.`);
    }
    migrate(db);
    const p = new Project(dir, info, db);
    p.recovered = p.jobs.recoverInterrupted();
    return p;
  }

  /** Rolling backup of the database into backups/, keeps the newest `keep`. */
  async backup(keep = 5): Promise<string> {
    const dir = path.join(this.dir, 'backups');
    const name = `driftboard-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
    const dest = path.join(dir, name);
    this.db.backupTo(dest);
    const stamp = (f: string) => f.replace(/^[a-z]+-/, '');    // old backups start with the pre-rename prefix: order by time, not by name
    const all = (await fs.readdir(dir)).filter((f) => f.endsWith('.db')).sort((a, b) => stamp(a).localeCompare(stamp(b)));
    for (const old of all.slice(0, Math.max(0, all.length - keep))) await fs.rm(path.join(dir, old), { force: true });
    return dest;
  }

  /** Store the exact workflow JSON a job submitted; deduplicated by hash. */
  async saveWorkflow(hash: string, json: string): Promise<void> {
    const f = path.join(this.dir, 'workflows', `${hash}.json`);
    if (!(await exists(f))) await writeFileAtomic(f, json);
  }

  /** Small JSON blobs kept in the project database (timeline model, director run state). No undo history. */
  saveBlob(key: string, json: string): void {
    this.db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, json);
  }
  loadBlob(key: string): string | null {
    return this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value ?? null;
  }
  saveTimeline(json: string): void { this.saveBlob('timeline_model', json); }
  loadTimeline(): string | null { return this.loadBlob('timeline_model'); }

  get schemaVersion() { return MIGRATIONS.length; }
  /** Rename the project (kept in project.json). */
  async rename(name: string) { this.info.name = name.trim() || this.info.name; await writeFileAtomic(path.join(this.dir, PROJECT_FILE), JSON.stringify(this.info, null, 2)); }
  close() { this.db.close(); }
}

const exists = (p: string) => fs.access(p).then(() => true, () => false);
async function cleanTempsDeep(dir: string): Promise<void> {
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await cleanTempsDeep(p);
    else if (e.name.endsWith('.tmp')) await fs.rm(p, { force: true });
  }
}
