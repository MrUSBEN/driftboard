import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { Project } from '../src/index.ts';

const mk = async () => Project.create(path.join(mkdtempSync(path.join(os.tmpdir(), 'mld-')), 'p'), 't');

test('manual story: shots, dividers, order, move a divider with its shots, one undo step each', async () => {
  const p = await mk(); const m = p.manual;
  const st = m.addStory('Detective');
  const a = m.addShot(st.id, 'Car'), b = m.addShot(st.id, 'Door');
  const d = m.addDivider(st.id, 'Inside', b.id);
  const c = m.addShot(st.id, 'Hall'), e = m.addShot(st.id, 'Table');
  assert.deepEqual(m.items(st.id).map((i) => i.name), ['Car', 'Door', 'Inside', 'Hall', 'Table']);
  m.moveItem(d.id, a.id);   // the divider carries Hall and Table
  assert.deepEqual(m.items(st.id).map((i) => i.name), ['Inside', 'Hall', 'Table', 'Car', 'Door']);
  p.docs.undo(); assert.deepEqual(m.items(st.id).map((i) => i.name), ['Car', 'Door', 'Inside', 'Hall', 'Table']);
  m.removeItem(c.id); assert.deepEqual(m.items(st.id).map((i) => i.order), [0, 1, 2, 3]);
  m.addDivider(st.id, 'Top', null); assert.equal(m.items(st.id)[0]!.name, 'Top');
  assert.ok(e.id);
});

test('manual story: inputs, picks, extras, seams and the shelf', async () => {
  const p = await mk(); const m = p.manual; const st = m.addStory();
  const sh = m.addShot(st.id, 'One');
  const ref = m.addRef(st.id, 'Detective', 'People', 'asset-1')!;
  assert.equal(m.addRef(st.id, 'Again', 'People', 'asset-1'), undefined);   // one entry per picture
  m.addInput(sh.id, { asset: 'asset-1', source: 'shelf', refId: ref.id, role: 'person' });
  m.addInput(sh.id, { asset: 'asset-1', source: 'once' });                    // the same picture is not added twice
  m.addInput(sh.id, { asset: 'asset-2', source: 'once' });
  let cur = m.shot(sh.id)!; assert.equal(cur.frame.inputs.length, 2);
  m.updateInput(sh.id, cur.frame.inputs[1]!.id, { on: false, role: 'place' });
  m.moveInput(sh.id, cur.frame.inputs[1]!.id, -1);
  cur = m.shot(sh.id)!; assert.equal(cur.frame.inputs[0]!.asset, 'asset-2'); assert.equal(cur.frame.inputs[0]!.on, false);
  m.setPick(sh.id, 'frame', 'f1'); m.addExtra(sh.id, 'clip', 'c1'); m.patchShot(sh.id, { seam: 'held', clip: { prompt: 'walks in' } });
  cur = m.shot(sh.id)!; assert.equal(cur.frame.pick, 'f1'); assert.equal(cur.seam, 'held'); assert.equal(cur.clip.prompt, 'walks in');
  m.setPick(sh.id, 'clip', 'c1'); m.removeExtra(sh.id, 'clip', 'c1'); assert.equal(m.shot(sh.id)!.clip.pick, undefined);
  m.renameGroup(st.id, 'People', 'Cast'); assert.equal(m.view().refs[0]!.group, 'Cast');
  m.removeStory(st.id); assert.equal(m.view().items.length, 0); assert.equal(m.view().refs.length, 0);
});

test('manual story: ensureStory moves the clip references into the one shared list of the shot', async () => {
  const p = await mk(); const m = p.manual;
  const st = m.addStory('S'); const sh = m.addShot(st.id, 'one');
  m.patchShot(sh.id, { frame: { inputs: [{ id: 'a', asset: 'A', source: 'once', role: 'other', on: true }] }, clip: { withRefs: false, inputs: [{ id: 'b', asset: 'B', source: 'once', role: 'other', on: true }] } });
  m.ensureStory();
  const s2 = m.shot(sh.id)!;
  assert.deepEqual(s2.clip.inputs, []);
  assert.deepEqual(s2.frame.inputs.map((i) => [i.asset, i.use]), [['A', 'frame'], ['B', 'clip']]);
});

test('manual story: a new shot starts with the models, sizes and length of the shot before it', async () => {
  const p = await mk(); const m = p.manual;
  const st = m.addStory('S'); const a = m.addShot(st.id, 'one');
  m.patchShot(a.id, { frame: { profileId: 'img', values: { __size: { w: 9 } } }, clip: { profileId: 'vid', values: { steps: 20 }, seconds: 6 } });
  const b = m.addShot(st.id, 'two');
  assert.equal(b.frame.profileId, 'img'); assert.deepEqual(b.frame.values, { __size: { w: 9 } });
  assert.equal(b.clip.profileId, 'vid'); assert.deepEqual(b.clip.values, { steps: 20 }); assert.equal(b.clip.seconds, 6);
  m.patchShot(b.id, { clip: { values: { steps: 5 } } });
  assert.deepEqual(m.shot(a.id)!.clip.values, { steps: 20 });   // a copy, not shared
});
