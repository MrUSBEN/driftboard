import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrangeLineage } from '../src/renderer/CanvasMenu.tsx';

const b = (id: string) => ({ id, x: 0, y: 0, w: 180, h: 130 });
const segHitsBox = (p: { x: number; y: number }, q: { x: number; y: number }, r: { x: number; y: number; w: number; h: number }) => {
  for (let t = 0.05; t < 0.96; t += 0.01) { const x = p.x + (q.x - p.x) * t, y = p.y + (q.y - p.y) * t; if (x > r.x + 4 && x < r.x + r.w - 4 && y > r.y + 4 && y < r.y + r.h - 4) return true; }
  return false;
};

test('arrangeLineage: no box overlaps, no link runs through another box (long links get a lane)', () => {
  // like the user's picture: img -> v1 -> frame -> v2 -> v3, plus ref -> v2 skipping columns, plus a second root
  const ids = ['img', 'v1', 'frame', 'v2', 'v3', 'ref', 'other', 'edit'];
  const edges = [{ from: 'img', to: 'v1' }, { from: 'v1', to: 'frame' }, { from: 'frame', to: 'v2' }, { from: 'v2', to: 'v3' }, { from: 'ref', to: 'v2' }, { from: 'ref', to: 'edit' }, { from: 'other', to: 'edit' }];
  const moves = arrangeLineage(ids.map(b), edges);
  const pos = new Map(moves.map((m) => [m.id, { ...m, w: 180, h: 130 }]));
  assert.equal(pos.size, ids.length);
  for (const p of pos.values()) for (const q of pos.values()) if (p !== q) assert.ok(Math.abs(p.x - q.x) >= 180 || Math.abs(p.y - q.y) >= 130, `${p.id} overlaps ${q.id}`);
  for (const e of edges) {
    const a = pos.get(e.from)!, c = pos.get(e.to)!; assert.ok(c.x > a.x, `${e.to} right of ${e.from}`);
    const pa = { x: a.x + 180, y: a.y + 65 }, pc = { x: c.x, y: c.y + 65 };
    for (const r of pos.values()) if (r.id !== e.from && r.id !== e.to) assert.ok(!segHitsBox(pa, pc, r), `link ${e.from}->${e.to} crosses ${r.id}`);
  }
});

test('arrangeLineage: a parent with two children fans them out so both links are visible', () => {
  const ids = ['man', 'coat', 'v1', 'v2'];
  const edges = [{ from: 'man', to: 'coat' }, { from: 'man', to: 'v1' }, { from: 'v1', to: 'v2' }];
  const m = new Map(arrangeLineage(ids.map(b), edges).map((p) => [p.id, p]));
  assert.ok(Math.abs(m.get('coat')!.y - m.get('v1')!.y) >= 130, 'siblings must not share a row');
  assert.ok(m.get('coat')!.y !== m.get('man')!.y || m.get('v1')!.y !== m.get('man')!.y, 'at least one child leaves the parent row');
});
