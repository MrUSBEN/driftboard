import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { Project, matches } from '../src/index.ts';
import { tmpDir } from './helpers.ts';

const mk = async () => Project.create(path.join(await tmpDir(), 'p'), 'T');

test('scenes and shots: add, order, move between scenes, delete scene keeps its shots', async () => {
  const p = await mk(); const st = p.story;
  const s1 = st.addScene('Opening'), s2 = st.addScene('Chase'), s3 = st.addScene('End');
  const a = st.addShot(s1.id)!, b = st.addShot(s1.id)!, c = st.addShot(s2.id)!;
  assert.deepEqual(st.tree().map((t) => [t.scene.name, t.shots.length]), [['Opening', 2], ['Chase', 1], ['End', 0]]);
  assert.equal(a.name, 'Shot 1'); assert.equal(b.name, 'Shot 2');
  st.moveShot(b.id, s2.id, 0);
  assert.deepEqual(st.tree()[1]!.shots.map((s) => s.id), [b.id, c.id]);
  st.moveScene(s3.id, -1);
  assert.deepEqual(st.scenes().map((s) => s.name), ['Opening', 'End', 'Chase']);
  st.removeScene(s2.id);                                // shots move to the previous scene
  assert.deepEqual(st.tree().find((t) => t.scene.id === s3.id)!.shots.map((s) => s.id).sort(), [b.id, c.id].sort());
  p.docs.undo(); assert.equal(st.scenes().length, 3);
  p.close();
});

test('takes: an asset belongs to one shot; status, pick rules, rejected pick is cleared', async () => {
  const p = await mk(); const st = p.story;
  const sc = st.addScene(); const a = st.addShot(sc.id)!, b = st.addShot(sc.id)!;
  st.addTake(a.id, 'x'); st.addTake(a.id, 'y'); st.addTake(a.id, 'x');
  assert.equal(st.shot(a.id)!.takes.length, 2);
  assert.equal(st.shot(a.id)!.pick, 'x');                     // the first take is the pick until another is chosen
  assert.equal(st.status(st.shot(a.id)!), 'approved');
  st.setPick(a.id, 'y');
  assert.equal(st.shot(a.id)!.takes.find((t) => t.assetId === 'y')!.status, 'approved');
  assert.equal(st.status(st.shot(a.id)!), 'approved');
  st.setPick(a.id, 'nope');                                   // not a take: ignored
  assert.equal(st.shot(a.id)!.pick, 'y');
  st.setTakeStatus(a.id, 'y', 'rejected');
  assert.equal(st.shot(a.id)!.pick, undefined);
  st.addTake(b.id, 'x');                                      // moves from shot a to shot b
  assert.deepEqual(st.shot(a.id)!.takes.map((t) => t.assetId), ['y']); assert.equal(st.shotOfAsset('x')!.id, b.id);
  st.setTakeStatus(a.id, 'y', 'rejected'); assert.equal(st.status(st.shot(a.id)!), 'rejected');
  assert.equal(st.status(st.addShot(sc.id)!), 'empty');
  p.close();
});

test('picks come out in story order', async () => {
  const p = await mk(); const st = p.story;
  const s1 = st.addScene(), s2 = st.addScene();
  const late = st.addShot(s2.id)!, early = st.addShot(s1.id)!, early2 = st.addShot(s1.id)!;
  for (const [sh, a] of [[late, 'L'], [early, 'E1'], [early2, 'E2']] as const) { st.addTake(sh.id, a); st.setPick(sh.id, a); }
  assert.deepEqual(st.picks().map((x) => x.assetId), ['E1', 'E2', 'L']);
  st.moveScene(s2.id, -1);
  assert.deepEqual(st.picks().map((x) => x.assetId), ['L', 'E1', 'E2']);
  p.close();
});

test('tags: normalised, de-duplicated, counted across assets and shots; empty meta is removed', async () => {
  const p = await mk(); const st = p.story;
  st.addTag('a1', ' Keeper '); st.addTag('a1', 'keeper'); st.addTag('a2', 'Keeper'); st.addTag('a2', 'sea view');
  assert.deepEqual(st.meta('a1').tags, ['keeper']);
  const sc = st.addScene(); const sh = st.addShot(sc.id)!; st.updateShot(sh.id, { tags: ['Sea View', 'sea view'] });
  assert.deepEqual(st.allTags(), [{ tag: 'keeper', count: 2 }, { tag: 'sea-view', count: 2 }]);
  st.removeTag('a1', 'keeper'); assert.equal(st.allMeta().has('a1'), false);
  st.setMeta('a2', { name: 'Lighthouse wide' }); assert.equal(st.meta('a2').name, 'Lighthouse wide');
  p.close();
});

test('search matches every word across fields', () => {
  assert.ok(matches('keeper sea', 'The keeper', 'sea view')); assert.ok(!matches('keeper moon', 'The keeper', 'sea view')); assert.ok(matches('', 'x'));
});

test('bible round trip and undo', async () => {
  const p = await mk(); const st = p.story;
  assert.equal(st.bible(), undefined);
  st.setBible({ style: 'noir', characters: [{ id: 'a', name: 'A', look: 'x' }], places: [] });
  st.setBible({ style: 'noir', characters: [{ id: 'a', name: 'A', look: 'x', refAsset: 'r1' }], places: [] });
  assert.equal(st.bible()!.characters[0]!.refAsset, 'r1');
  p.docs.undo(); assert.equal(st.bible()!.characters[0]!.refAsset, undefined);
  p.saveBlob('director', '{"a":1}'); assert.equal(p.loadBlob('director'), '{"a":1}'); assert.equal(p.loadBlob('nope'), null);
  p.close();
});

test('importPlan: creates scenes and shots; re-import updates briefs but keeps takes, picks and edited prompts', async () => {
  const p = await mk(); const st = p.story;
  const brief = { framing: 'wide', move: 'static', action: 'A', dialogue: [], seconds: 5, characterIds: [] };
  const plan = (prompt: string) => [{ sourceId: 's1', name: 'Kitchen', shots: [{ sourceId: 'k1', name: 'Wide', brief, prompt }, { sourceId: 'k2', name: 'Close', brief: { ...brief, framing: 'close' }, prompt }] }];
  assert.deepEqual(st.importPlan(plan('v1')), { scenesAdded: 1, shotsAdded: 2, shotsUpdated: 0 });
  const k1 = st.shots().find((s) => s.sourceId === 'k1')!;
  st.addTake(k1.id, 'asset1'); st.setPick(k1.id, 'asset1');
  st.updateShot(k1.id, { prompt: 'my hand-edited prompt' });
  assert.deepEqual(st.importPlan(plan('v2'), { keepEditedPrompts: true }), { scenesAdded: 0, shotsAdded: 0, shotsUpdated: 2 });
  const after = st.shots().find((s) => s.sourceId === 'k1')!;
  assert.equal(after.pick, 'asset1'); assert.equal(after.prompt, 'my hand-edited prompt');       // kept
  assert.equal(st.shots().find((s) => s.sourceId === 'k2')!.prompt, 'v2');                         // untouched by the user: updated
  assert.equal(st.scenes().length, 1); assert.equal(st.shots().length, 2);
  p.docs.undo(); assert.equal(st.shots().find((s) => s.sourceId === 'k2')!.prompt, 'v1');         // one undo step
  p.close();
});
