import { promises as fs, readFileSync } from 'node:fs';
import * as path from 'node:path';

/** What the user set once in Settings → ComfyUI for one profile. */
export interface ProfilePrefs { enabled?: boolean; /** slot id -> value used for every generation unless the form sets it */ defaults?: Record<string, unknown> }
export interface ComfyPrefsData { url?: string; profiles: Record<string, ProfilePrefs> }

/** Settings → ComfyUI, kept in the user data folder (never in a project, never in the repo). */
export class ComfyPrefs {
  s: ComfyPrefsData = { profiles: {} };
  constructor(private file: string) {}

  load() {
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<ComfyPrefsData>;
      this.s = { url: typeof j.url === 'string' && j.url ? j.url : undefined, profiles: j.profiles && typeof j.profiles === 'object' ? j.profiles : {} };
    } catch { this.s = { profiles: {} }; }
    return this;
  }
  private async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(this.s, null, 2));
    await fs.rename(tmp, this.file);
  }

  defaults = (id: string): Record<string, unknown> => ({ ...(this.s.profiles[id]?.defaults ?? {}) });
  enabled = (id: string) => this.s.profiles[id]?.enabled !== false;

  /** An empty value removes the default (the workflow's own value applies again). */
  async setDefault(id: string, key: string, value: unknown) {
    const p = (this.s.profiles[id] ??= {}); const d = (p.defaults ??= {});
    if (value === undefined || value === null || value === '') delete d[key]; else d[key] = value;
    await this.save();
  }
  async setEnabled(id: string, on: boolean) { const p = (this.s.profiles[id] ??= {}); if (on) delete p.enabled; else p.enabled = false; await this.save(); }
  async reset(id: string) { delete this.s.profiles[id]; await this.save(); }
  async setUrl(url: string) { this.s.url = url || undefined; await this.save(); }
}
