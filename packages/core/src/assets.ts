import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Db } from './db.ts';

export type AssetKind = 'image' | 'video' | 'audio' | 'other';
export interface Asset {
  id: string; ext: string; kind: AssetKind; bytes: number;
  width: number | null; height: number | null; duration_ms: number | null; fps: number | null;
  has_audio: number | null; original_name: string | null; meta: string; created_at: string;
}
export interface AssetInfo {
  width?: number; height?: number; durationMs?: number; fps?: number; hasAudio?: boolean; meta?: Record<string, unknown>;
}

const KINDS: Record<string, AssetKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', bmp: 'image', gif: 'image',
  mp4: 'video', mov: 'video', webm: 'video', mkv: 'video',
  wav: 'audio', mp3: 'audio', flac: 'audio', m4a: 'audio', ogg: 'audio', aac: 'audio',
};
export const kindOf = (ext: string): AssetKind => KINDS[ext.toLowerCase()] ?? 'other';

export function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/** Content-addressed, immutable files: assets/<first 2 hex>/<hash>.<ext>. */
export class AssetStore {
  constructor(private db: Db, readonly root: string) {}

  pathFor(a: { id: string; ext: string }): string {
    return path.join(this.root, a.id.slice(0, 2), `${a.id}.${a.ext}`);
  }

  get(id: string): Asset | undefined {
    return this.db.get<Asset>('SELECT * FROM assets WHERE id = ?', id);
  }

  /** Copy a file in (or reuse it if the same content exists). Safe to call twice with the same file. */
  async importFile(src: string, info: AssetInfo = {}): Promise<Asset> {
    const id = await hashFile(src);
    const ext = path.extname(src).slice(1).toLowerCase() || 'bin';
    const dest = this.pathFor({ id, ext });
    const existing = this.get(id);
    if (existing && (await exists(dest))) return existing;
    await fs.mkdir(path.dirname(dest), { recursive: true });
    if (!(await exists(dest))) {
      const tmp = `${dest}.${randomUUID().slice(0, 8)}.tmp`;
      await fs.copyFile(src, tmp);
      const fh = await fs.open(tmp, 'r+');
      await fh.sync();
      await fh.close();
      await fs.rename(tmp, dest);
    }
    const bytes = (await fs.stat(dest)).size;
    this.db.run(
      `INSERT INTO assets (id, ext, kind, bytes, width, height, duration_ms, fps, has_audio, original_name, meta)
       VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
      id, ext, kindOf(ext), bytes, info.width ?? null, info.height ?? null, info.durationMs ?? null, info.fps ?? null,
      info.hasAudio === undefined ? null : info.hasAudio ? 1 : 0, /^(\.in-|edit-|frame-)/.test(path.basename(src)) ? null : path.basename(src), JSON.stringify(info.meta ?? {}),
    );
    return this.get(id)!;
  }

  async importBuffer(data: Uint8Array, ext: string, info: AssetInfo = {}): Promise<Asset> {
    const tmp = path.join(this.root, `.in-${randomUUID().slice(0, 8)}.${ext}`);
    await fs.mkdir(this.root, { recursive: true });
    await fs.writeFile(tmp, data);
    try { return await this.importFile(tmp, info); } finally { await fs.rm(tmp, { force: true }); }
  }

  /** Assets used by no job input/output and no document text. Returns what would be removed. */
  unreferenced(): Asset[] {
    return this.db.all<Asset>(
      `SELECT * FROM assets a WHERE NOT EXISTS (SELECT 1 FROM job_inputs WHERE asset_id = a.id)
         AND NOT EXISTS (SELECT 1 FROM job_outputs WHERE asset_id = a.id)
         AND NOT EXISTS (SELECT 1 FROM docs WHERE instr(json, a.id) > 0)`);
  }

  async collectGarbage(): Promise<number> {
    const list = this.unreferenced();
    for (const a of list) {
      await fs.rm(this.pathFor(a), { force: true });
      this.db.run('DELETE FROM assets WHERE id = ?', a.id);
    }
    return list.length;
  }

  /** Check every asset row has its file with the right hash. Returns problems. */
  async verify(deep = false): Promise<{ id: string; problem: 'missing' | 'size' | 'hash' }[]> {
    const bad: { id: string; problem: 'missing' | 'size' | 'hash' }[] = [];
    for (const a of this.db.all<Asset>('SELECT * FROM assets')) {
      const p = this.pathFor(a);
      const st = await fs.stat(p).catch(() => null);
      if (!st) bad.push({ id: a.id, problem: 'missing' });
      else if (st.size !== a.bytes) bad.push({ id: a.id, problem: 'size' });
      else if (deep && (await hashFile(p)) !== a.id) bad.push({ id: a.id, problem: 'hash' });
    }
    return bad;
  }
}

const exists = (p: string) => fs.access(p).then(() => true, () => false);
