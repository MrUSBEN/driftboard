import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { Project } from '../src/index.ts';
import { tmpDir } from './helpers.ts';

async function mk() { const d = await tmpDir(); return Project.create(path.join(d, 'p'), 'T'); }

test('add, move many as one undo step, delete removes edges, undo restores both', async () => {
  const p = await mk(); const b = p.board;
  const a1 = b.addItem({ kind: 'asset', ref: 'x', x: 0, y: 0 }), a2 = b.addItem({ kind: 'note', text: 'hi', x: 10, y: 10 }), g = b.addItem({ kind: 'group', x: 300, y: 0, text: 'G' });
  b.connect(a1.id, g.id, 'refs'); b.connect(a2.id, g.id);
  b.place([{ id: a1.id, x: 5, y: 5 }, { id: a2.id, x: 6, y: 6 }]);
  assert.equal(p.docs.undoLabel, 'Move');
  p.docs.undo();
  assert.deepEqual([b.item(a1.id)!.x, b.item(a2.id)!.x], [0, 10]);
  b.remove([a1.id]);
  assert.equal(b.edges().length, 1); assert.equal(b.item(a1.id), undefined);
  p.docs.undo();
  assert.equal(b.edges().length, 2); assert.ok(b.item(a1.id));
  p.close();
});

test('connect: no self loops, no duplicates, no dangling ends', async () => {
  const p = await mk(); const b = p.board;
  const a = b.addItem({ kind: 'note', x: 0, y: 0 }), c = b.addItem({ kind: 'note', x: 0, y: 0 });
  assert.equal(b.connect(a.id, a.id), undefined); assert.equal(b.connect(a.id, 'nope'), undefined);
  const e1 = b.connect(a.id, c.id, 's'), e2 = b.connect(a.id, c.id, 's');
  assert.equal(e1!.id, e2!.id); assert.equal(b.edges().length, 1);
  p.close();
});

test('lineage edges come from jobs and only between items on the board', async () => {
  const p = await mk(); const b = p.board;
  const mkA = (s: string, e: string) => p.assets.importBuffer(Buffer.from(s), e);
  const [r, v, w] = [await mkA('r', 'png'), await mkA('v', 'mp4'), await mkA('w', 'mp4')];
  const run = (i: string, o: string) => { const j = p.jobs.create({ kind: 'x', inputs: [{ assetId: i, role: 'in' }] }); p.jobs.transition(j.id, 'running'); p.jobs.transition(j.id, 'done', { outputs: [{ assetId: o, role: 'out' }] }); return j.id; };
  const j1 = run(r.id, v.id); run(v.id, w.id);
  const ir = b.addAsset(r.id, 0, 0), iv = b.addAsset(v.id, 200, 0);
  assert.deepEqual(b.lineage(), [{ from: ir.id, to: iv.id, jobId: j1 }]);   // w is not on the board
  assert.equal(b.addAsset(r.id, 9, 9).id, ir.id);                            // no duplicate item
  const iw = b.addAsset(w.id, 400, 0);
  assert.equal(b.lineage().length, 2); assert.ok(b.lineage().some((e) => e.from === iv.id && e.to === iw.id));
  p.close();
});

test('placeResults stacks new assets right of the origin item and reuses existing items', async () => {
  const p = await mk(); const b = p.board;
  const o = b.addItem({ kind: 'asset', ref: 'src', x: 100, y: 50 });
  const items = b.placeResults(o.id, ['a1', 'a2']);
  assert.deepEqual(items.map((i) => [i.x, i.y]), [[340, 50], [340, 200]]);
  const dup = b.addAsset('far', 340, 60);   // a new node never lands on an existing one
  assert.ok(dup.y >= 200 + 130 - 1 || dup.y !== 60);
  assert.equal(b.placeResults(o.id, ['a1']).length, 1); assert.equal(b.items().filter((i) => i.ref === 'a1').length, 1);
  p.close();
});

test('arrange by scene: frames per scene, rows per shot, unsorted below, idempotent, one undo step', async () => {
  const p = await mk(); const b = p.board, st = p.story;
  const s1 = st.addScene('Opening'), s2 = st.addScene('Chase');
  const a = st.addShot(s1.id)!, c = st.addShot(s1.id)!, d = st.addShot(s2.id)!;
  const ids = ['a1', 'a2', 'a3', 'c1', 'd1', 'loose'];
  ids.forEach((id, i) => b.addAsset(id, 5000 + i, 5000));
  st.addTake(a.id, 'a1'); st.addTake(a.id, 'a2'); st.addTake(a.id, 'a3'); st.addTake(c.id, 'c1'); st.addTake(d.id, 'd1'); st.addTake(d.id, 'not-on-board');
  const r = b.arrangeScenes(st);
  assert.equal(r.scenes, 2); assert.ok(r.moved >= 6);
  const pos = (ref: string) => { const i = b.items().find((x) => x.kind === 'asset' && x.ref === ref)!; return [i.x, i.y]; };
  assert.deepEqual([pos('a1'), pos('a2'), pos('a3')], [[24, 44], [228, 44], [432, 44]]);   // one row, left to right
  assert.deepEqual(pos('c1'), [24, 174]);                                                   // next shot, next row
  const frames = b.items().filter((x) => x.kind === 'group');
  assert.deepEqual(frames.map((f) => f.text).sort(), ['Chase', 'Opening', 'Unsorted']);
  const open = frames.find((f) => f.text === 'Opening')!, chase = frames.find((f) => f.text === 'Chase')!, uns = frames.find((f) => f.text === 'Unsorted')!;
  assert.ok(chase.y >= open.y + open.h!); assert.ok(uns.y >= chase.y + chase.h!);           // stacked, no overlap
  assert.ok(pos('d1')[1]! >= chase.y && pos('loose')[1]! >= uns.y);
  const again = b.arrangeScenes(st);
  assert.equal(again.moved, 0); assert.equal(b.items().filter((x) => x.kind === 'group').length, 3);   // nothing new
  p.docs.undo(); p.docs.undo();                                                              // undo the (empty) re-run is a no-op, then the arrange
  assert.deepEqual(pos('a1'), [5000, 5000]); assert.equal(b.items().filter((x) => x.kind === 'group').length, 0);
  p.close();
});

test('saved views round trip and undo', async () => {
  const p = await mk(); const b = p.board;
  const v = b.saveView('Chase scene', -400, 120, 0.5); b.saveView('Alpha', 0, 0, 1);
  assert.deepEqual(b.views().map((x) => x.name), ['Alpha', 'Chase scene']);
  b.deleteView(v.id); assert.equal(b.views().length, 1);
  p.docs.undo(); assert.equal(b.views().length, 2);
  p.close();
});
