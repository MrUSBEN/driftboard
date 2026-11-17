import { randomUUID } from 'node:crypto';
import type { Db } from './db.ts';
import type { DocStore } from './docs.ts';
import type { StoryStore } from './story.ts';

export type BoardKind = 'asset' | 'note' | 'group';
export interface BoardItem {
  id: string; kind: BoardKind; x: number; y: number; w?: number; h?: number;
  /** asset items: the asset id. group items made by Arrange: the scene id (or 'unsorted') */
  ref?: string;
  /** note items: the text. group items: the title. */
  text?: string;
}
export interface BoardEdge { id: string; from: string; to: string; /** gen input slot (handle id) */ slot?: string; /** creation order; decides Picture 1, 2, ... */ order: number }
export interface LineageEdge { from: string; to: string; jobId: string }

const ITEM = 'board_item', EDGE = 'board_edge', VIEW = 'board_view';
export interface BoardViewPos { id: string; name: string; x: number; y: number; zoom: number }
const uid = () => randomUUID().slice(0, 12);

/** The canvas data. Our own tables, not React Flow's JSON. Lineage edges are derived, never stored. */
export class BoardStore {
  constructor(private docs: DocStore, private db: Db) {}

  items(): BoardItem[] { return this.docs.list<BoardItem>(ITEM).map((r) => r.value); }
  edges(): BoardEdge[] { return this.docs.list<BoardEdge>(EDGE).map((r) => r.value).sort((a, b) => a.order - b.order); }
  item(id: string) { return this.docs.get<BoardItem>(ITEM, id); }

  addItem(it: Omit<BoardItem, 'id'> & { id?: string }, label = 'Add'): BoardItem {
    const item = { ...it, id: it.id ?? uid() } as BoardItem;
    this.docs.set(ITEM, item.id, item, label);
    return item;
  }

  /** Nearest free spot at or below (x, y) where a new asset node does not overlap any existing item (groups do not count: things may sit in them). */
  freeSpot(x: number, y: number): { x: number; y: number } {
    const W = 180, H = 130, G = 20;
    const taken = this.items().filter((i) => i.kind !== 'group').map((i) => ({ x: i.x, y: i.y, w: i.w ?? (i.kind === 'asset' ? 180 : 220), h: i.h ?? (i.kind === 'asset' ? 130 : 120) }));
    const hit = (px: number, py: number) => taken.some((t) => px < t.x + t.w + G && px + W + G > t.x && py < t.y + t.h + G && py + H + G > t.y);
    let py = y;
    for (let i = 0; i < 300 && hit(x, py); i++) py += 30;
    return { x, y: py };
  }

  /** Add an asset to the board unless it is already there (returns the existing item). New nodes never land on top of existing ones. */
  addAsset(assetId: string, x: number, y: number): BoardItem {
    const have = this.items().find((i) => i.kind === 'asset' && i.ref === assetId);
    if (have) return have;
    const p = this.freeSpot(x, y);
    return this.addItem({ kind: 'asset', ref: assetId, x: p.x, y: p.y }, 'Add asset');
  }

  update(id: string, patch: Partial<Omit<BoardItem, 'id' | 'kind'>>, label = 'Edit'): void {
    const cur = this.item(id);
    if (cur) this.docs.set(ITEM, id, { ...cur, ...patch }, label);
  }

  /** One undo step for any number of moves/resizes. */
  place(changes: { id: string; x: number; y: number; w?: number; h?: number }[], label = 'Move'): void {
    this.docs.batch(label, () => {
      for (const c of changes) {
        const cur = this.item(c.id);
        if (cur) this.docs.set(ITEM, c.id, { ...cur, x: c.x, y: c.y, ...(c.w !== undefined ? { w: c.w, h: c.h } : {}) });
      }
    });
  }

  /** Remove items and every edge touching them, as one undo step. Assets themselves are untouched. */
  remove(ids: string[]): void {
    const set = new Set(ids);
    this.docs.batch('Delete', () => {
      for (const e of this.edges()) if (set.has(e.from) || set.has(e.to)) this.docs.set(EDGE, e.id, undefined);
      for (const id of ids) this.docs.set(ITEM, id, undefined);
    });
  }

  connect(from: string, to: string, slot?: string): BoardEdge | undefined {
    if (from === to || !this.item(from) || !this.item(to)) return undefined;
    const dup = this.edges().find((e) => e.from === from && e.to === to && e.slot === slot);
    if (dup) return dup;
    const order = this.edges().reduce((m, x) => Math.max(m, x.order), 0) + 1;
    const e: BoardEdge = { id: uid(), from, to, order, ...(slot ? { slot } : {}) };
    this.docs.set(EDGE, e.id, e, 'Connect');
    return e;
  }
  disconnect(id: string): void { this.docs.set(EDGE, id, undefined, 'Disconnect'); }

  /**
   * Put job outputs on the board to the right of the item the job started from. Existing items are reused.
   * Returns the items, in order.
   */
  placeResults(originId: string, assetIds: string[]): BoardItem[] {
    const gen = this.item(originId);
    if (!gen) return [];
    const gw = gen.w ?? (gen.kind === 'asset' ? 180 : 320);
    return this.docs.batch('Add results', () => {
      const existing = this.items();
      const out: BoardItem[] = [];
      for (const a of assetIds) {
        const have = existing.find((i) => i.kind === 'asset' && i.ref === a);
        if (have) { out.push(have); continue; }
        const p = this.freeSpot(gen.x + gw + 60, gen.y);
        out.push(this.addItem({ kind: 'asset', ref: a, x: p.x, y: p.y }));
      }
      return out;
    });
  }

  /** Lineage between items on the board: parent asset item -> child asset item, via the job that made it. */
  lineage(): LineageEdge[] {
    const byAsset = new Map<string, string[]>();
    for (const i of this.items()) if (i.kind === 'asset' && i.ref) (byAsset.get(i.ref) ?? byAsset.set(i.ref, []).get(i.ref)!).push(i.id);
    if (!byAsset.size) return [];
    const rows = this.db.all<{ parent: string; child: string; job_id: string }>(
      `SELECT DISTINCT i.asset_id AS parent, o.asset_id AS child, o.job_id FROM job_outputs o JOIN job_inputs i ON i.job_id = o.job_id`);
    const out: LineageEdge[] = [];
    for (const r of rows) {
      const ps = byAsset.get(r.parent), cs = byAsset.get(r.child);
      if (ps && cs) for (const p of ps) for (const c of cs) out.push({ from: p, to: c, jobId: r.job_id });
    }
    return out;
  }

  // ---- saved views (named viewport positions) ----
  views(): BoardViewPos[] { return this.docs.list<BoardViewPos>(VIEW).map((r) => r.value).sort((a, b) => a.name.localeCompare(b.name)); }
  saveView(name: string, x: number, y: number, zoom: number): BoardViewPos {
    const v: BoardViewPos = { id: uid(), name, x, y, zoom };
    this.docs.set(VIEW, v.id, v, 'Save view');
    return v;
  }
  deleteView(id: string) { this.docs.set(VIEW, id, undefined, 'Delete view'); }

  /**
   * Lay the board out by story: one framed group per scene (in order), one row per shot, its takes left to right.
   * Only items already on the board move. Assets that belong to no shot go in an "Unsorted" frame below.
   * Safe to run again: frames are found by scene id and updated in place. One undo step.
   */
  arrangeScenes(story: StoryStore, opts: { cellW?: number; rowH?: number; gap?: number } = {}): { moved: number; scenes: number } {
    const W = opts.cellW ?? 180, H = opts.rowH ?? 130, GAP = opts.gap ?? 24, PAD = 24, TOP = 44, BAND = 70;
    const items = this.items();
    // groups the user made (no scene id) are protected: what sits inside one stays exactly where it is
    const mine = items.filter((i) => i.kind === 'group' && !i.ref);
    const kept = new Set(items.filter((i) => i.kind === 'asset' && mine.some((g) => { const cx = i.x + W / 2, cy = i.y + H / 2; return cx >= g.x && cx <= g.x + (g.w ?? 520) && cy >= g.y && cy <= g.y + (g.h ?? 360); })).map((i) => i.id));
    const byAsset = new Map<string, BoardItem>();
    for (const i of items) if (i.kind === 'asset' && i.ref && !byAsset.has(i.ref) && !kept.has(i.id)) byAsset.set(i.ref, i);
    const frames = new Map<string, BoardItem>();
    for (const i of items) if (i.kind === 'group' && i.ref) frames.set(i.ref, i);
    const placed = new Set<string>();
    let moved = 0, y = 0, scenes = 0;
    this.docs.batch('Arrange by scene', () => {
      const frame = (key: string, name: string, x0: number, y0: number, w: number, h: number) => {
        const cur = frames.get(key);
        if (cur) this.docs.set(ITEM, cur.id, { ...cur, x: x0, y: y0, w, h, text: name });
        else this.addItem({ kind: 'group', ref: key, text: name, x: x0, y: y0, w, h });
      };
      for (const { scene, shots } of story.tree()) {
        const rows: BoardItem[][] = [];
        for (const sh of shots) {
          const row = sh.takes.map((t) => byAsset.get(t.assetId)).filter((i): i is BoardItem => !!i);
          if (row.length) rows.push(row);
        }
        if (!rows.length) continue;
        scenes++;
        rows.forEach((row, r) => row.forEach((it, c) => {
          const nx = PAD + c * (W + GAP), ny = y + TOP + r * H;
          if (it.x !== nx || it.y !== ny) { this.docs.set(ITEM, it.id, { ...it, x: nx, y: ny }); moved++; }
          placed.add(it.id);
        }));
        const cols = Math.max(...rows.map((r) => r.length));
        frame(scene.id, scene.name, 0, y, PAD * 2 + cols * W + (cols - 1) * GAP, TOP + rows.length * H + PAD / 2);
        y += TOP + rows.length * H + PAD / 2 + BAND;
      }
      const rest = items.filter((i) => i.kind === 'asset' && !placed.has(i.id) && !kept.has(i.id));
      if (rest.length) {
        const perRow = 8;
        rest.forEach((it, k) => {
          const nx = PAD + (k % perRow) * (W + GAP), ny = y + TOP + Math.floor(k / perRow) * H;
          if (it.x !== nx || it.y !== ny) { this.docs.set(ITEM, it.id, { ...it, x: nx, y: ny }); moved++; }
        });
        const rows = Math.ceil(rest.length / perRow);
        frame('unsorted', 'Unsorted', 0, y, PAD * 2 + Math.min(perRow, rest.length) * W + (Math.min(perRow, rest.length) - 1) * GAP, TOP + rows * H + PAD / 2);
      }
    });
    return { moved, scenes };
  }
}
