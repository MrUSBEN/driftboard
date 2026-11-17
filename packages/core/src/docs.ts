import type { Db } from './db.ts';

type Json = unknown;
interface Change { collection: string; id: string; before: string | null; after: string | null }
interface Step { label: string; changes: Change[] }

/**
 * JSON documents (board, timelines, bible, notes) with project-level undo/redo.
 * Every write is committed to SQLite immediately (that is the autosave); history lives in memory.
 * Group edits that belong together with `batch(label, fn)`: one undo step.
 */
export class DocStore {
  private undoStack: Step[] = [];
  private redoStack: Step[] = [];
  private open: Step | null = null;
  private listeners = new Set<() => void>();

  constructor(private db: Db, private limit = 200) {}

  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit() { for (const l of this.listeners) l(); }

  get<T = Json>(collection: string, id: string): T | undefined {
    const r = this.db.get<{ json: string }>('SELECT json FROM docs WHERE collection = ? AND id = ?', collection, id);
    return r ? (JSON.parse(r.json) as T) : undefined;
  }
  list<T = Json>(collection: string): { id: string; value: T }[] {
    return this.db.all<{ id: string; json: string }>('SELECT id, json FROM docs WHERE collection = ? ORDER BY id', collection)
      .map((r) => ({ id: r.id, value: JSON.parse(r.json) as T }));
  }

  /** Write (value) or delete (undefined). Recorded in history. */
  set(collection: string, id: string, value: Json | undefined, label = 'Edit'): void {
    const own = !this.open;
    const step = this.open ?? { label, changes: [] };
    this.db.transaction(() => {
      const before = this.raw(collection, id);
      const after = value === undefined ? null : JSON.stringify(value);
      if (before === after) return;
      this.write(collection, id, after);
      step.changes.push({ collection, id, before, after });
    });
    if (own) this.commit(step);
  }

  /** Several writes as one undo step, one DB transaction. If fn throws, everything is rolled back. */
  batch<T>(label: string, fn: () => T): T {
    if (this.open) return fn();
    const step: Step = { label, changes: [] };
    this.open = step;
    try {
      const r = this.db.transaction(fn);
      this.commit(step);
      return r;
    } catch (e) {
      this.open = null;
      throw e;
    } finally {
      this.open = null;
    }
  }

  private commit(step: Step) {
    if (!step.changes.length) return;
    this.undoStack.push(step);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    this.emit();
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get undoLabel() { return this.undoStack.at(-1)?.label; }
  get redoLabel() { return this.redoStack.at(-1)?.label; }

  undo(): boolean {
    const s = this.undoStack.pop();
    if (!s) return false;
    this.db.transaction(() => { for (const c of [...s.changes].reverse()) this.write(c.collection, c.id, c.before); });
    this.redoStack.push(s);
    this.emit();
    return true;
  }
  redo(): boolean {
    const s = this.redoStack.pop();
    if (!s) return false;
    this.db.transaction(() => { for (const c of s.changes) this.write(c.collection, c.id, c.after); });
    this.undoStack.push(s);
    this.emit();
    return true;
  }
  clearHistory() { this.undoStack = []; this.redoStack = []; this.emit(); }

  private raw(collection: string, id: string): string | null {
    return this.db.get<{ json: string }>('SELECT json FROM docs WHERE collection = ? AND id = ?', collection, id)?.json ?? null;
  }
  private write(collection: string, id: string, json: string | null) {
    if (json === null) this.db.run('DELETE FROM docs WHERE collection = ? AND id = ?', collection, id);
    else this.db.run(
      `INSERT INTO docs (collection, id, json) VALUES (?,?,?)
       ON CONFLICT(collection, id) DO UPDATE SET json = excluded.json, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      collection, id, json);
  }
}
