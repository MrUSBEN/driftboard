import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Project, openDb, migrate, MIGRATIONS, writeFileAtomic, hashFile, hashJson } from '../src/index.ts';
import { tmpDir, sampleFile } from './helpers.ts';

test('a project folder made before the rename (project.meldreel.json, meldreel.db) opens and both are renamed in place', async () => {
  const dir = path.join(await tmpDir(), 'proj');
  const p = await Project.create(dir, 'old'); p.close();
  await fs.rename(path.join(dir, 'project.driftboard.json'), path.join(dir, 'project.meldreel.json'));
  await fs.rename(path.join(dir, 'driftboard.db'), path.join(dir, 'meldreel.db'));
  const q = await Project.open(dir); assert.equal(q.info.name, 'old'); q.close();
  assert.ok(await fs.access(path.join(dir, 'project.driftboard.json')).then(() => true, () => false)); assert.ok(!(await fs.access(path.join(dir, 'project.meldreel.json')).then(() => true, () => false)));
  assert.ok(await fs.access(path.join(dir, 'driftboard.db')).then(() => true, () => false)); assert.ok(!(await fs.access(path.join(dir, 'meldreel.db')).then(() => true, () => false)));
});

test('migrations: fresh db reaches latest, rerun is a no-op, newer db is refused', async () => {
  const d = await tmpDir();
  const db = openDb(path.join(d, 'x.db'));
  assert.deepEqual(migrate(db), { from: 0, to: MIGRATIONS.length });
  assert.deepEqual(migrate(db), { from: MIGRATIONS.length, to: MIGRATIONS.length });
  db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
  assert.throws(() => migrate(db), /Update Driftboard/);
  db.close();
});

test('db.transaction rolls back on throw and nested joins outer', async () => {
  const d = await tmpDir();
  const db = openDb(path.join(d, 'x.db'));
  migrate(db);
  assert.throws(() => db.transaction(() => {
    db.run("INSERT INTO meta VALUES ('a','1')");
    db.transaction(() => db.run("INSERT INTO meta VALUES ('b','2')"));
    throw new Error('boom');
  }), /boom/);
  assert.equal(db.all('SELECT * FROM meta').length, 0);
  db.close();
});

test('atomic write replaces file and leaves no temp', async () => {
  const d = await tmpDir();
  const f = path.join(d, 'a.json');
  await writeFileAtomic(f, '1'); await writeFileAtomic(f, '2');
  assert.equal(await fs.readFile(f, 'utf8'), '2');
  assert.deepEqual((await fs.readdir(d)).filter((n) => n.endsWith('.tmp')), []);
});

test('assets: content addressing dedups, verify finds damage, gc removes unreferenced only', async () => {
  const d = await tmpDir();
  const p = await Project.create(path.join(d, 'proj'), 'T');
  const f1 = await sampleFile(d, 'a.png', 'same bytes');
  const f2 = await sampleFile(d, 'b.png', 'same bytes');
  const f3 = await sampleFile(d, 'c.mp4', 'other bytes');
  const a1 = await p.assets.importFile(f1);
  const a2 = await p.assets.importFile(f2);
  const a3 = await p.assets.importFile(f3, { durationMs: 2000, hasAudio: true });
  assert.equal(a1.id, a2.id);
  assert.equal(a1.id, await hashFile(f1));
  assert.equal(a3.kind, 'video');
  assert.equal(p.db.all('SELECT * FROM assets').length, 2);
  assert.deepEqual(await p.assets.verify(true), []);
  // use a1 in a job, a3 unused
  p.jobs.create({ kind: 'generate', inputs: [{ assetId: a1.id, role: 'refs' }] });
  assert.equal(await p.assets.collectGarbage(), 1);
  assert.equal(p.assets.get(a3.id), undefined);
  await fs.writeFile(p.assets.pathFor(a1), 'tampered!!!');
  assert.deepEqual(await p.assets.verify(), [{ id: a1.id, problem: 'size' }]);
  await fs.writeFile(p.assets.pathFor(a1), 'same bytez');
  assert.deepEqual(await p.assets.verify(true), [{ id: a1.id, problem: 'hash' }]);
  await fs.rm(p.assets.pathFor(a1));
  assert.deepEqual(await p.assets.verify(), [{ id: a1.id, problem: 'missing' }]);
  p.close();
});

test('jobs: legal transitions only, claim order, retry keeps recipe', async () => {
  const d = await tmpDir();
  const p = await Project.create(path.join(d, 'proj'), 'T');
  const img = await p.assets.importBuffer(Buffer.from('img'), 'png');
  const j1 = p.jobs.create({ kind: 'generate', profileId: 'h3', profileVersion: 2, workflowHash: hashJson({ w: 1 }), params: { seed: 5, prompt: 'x' }, inputs: [{ assetId: img.id, role: 'refs' }] });
  const j2 = p.jobs.create({ kind: 'generate' });
  assert.equal(p.jobs.claimNext()!.id, j1.id);
  assert.throws(() => p.jobs.transition(j1.id, 'queued' as never), /cannot go/);
  assert.throws(() => p.jobs.transition(j2.id, 'done'), /cannot go queued -> done/);
  const vid = await p.assets.importBuffer(Buffer.from('vid'), 'mp4');
  const done = p.jobs.transition(j1.id, 'done', { outputs: [{ assetId: vid.id, role: 'video' }] });
  assert.equal(done.status, 'done'); assert.equal(done.progress, 1); assert.ok(done.finished_at);
  assert.throws(() => p.jobs.transition(j1.id, 'failed'), /cannot go done -> failed/);
  const r = p.jobs.retry(j1.id, { seed: 6 });
  assert.deepEqual(JSON.parse(r.params), { seed: 6, prompt: 'x' });
  assert.equal(r.profile_version, 2);
  assert.deepEqual(p.jobs.inputs(r.id), [{ assetId: img.id, role: 'refs', idx: 0 }]);
  p.close();
});

test('lineage: ancestors and descendants across a chain', async () => {
  const d = await tmpDir();
  const p = await Project.create(path.join(d, 'proj'), 'T');
  const mk = (s: string, e: string) => p.assets.importBuffer(Buffer.from(s), e);
  const [ref, c1, f1, c2, f2] = [await mk('ref', 'png'), await mk('c1', 'mp4'), await mk('f1', 'png'), await mk('c2', 'mp4'), await mk('f2', 'png')];
  const run = (inp: string, out: string[]) => { const j = p.jobs.create({ kind: 'x', inputs: [{ assetId: inp, role: 'in' }] }); p.jobs.transition(j.id, 'running'); p.jobs.transition(j.id, 'done', { outputs: out.map((o) => ({ assetId: o, role: 'out' })) }); };
  run(ref.id, [c1.id]); run(c1.id, [f1.id]); run(f1.id, [c2.id]); run(c2.id, [f2.id]);
  assert.deepEqual(p.jobs.ancestors(f2.id).map((a) => [a.assetId, a.depth]), [[c2.id, 1], [f1.id, 2], [c1.id, 3], [ref.id, 4]]);
  assert.deepEqual(p.jobs.descendants(ref.id).map((a) => a.assetId), [c1.id, f1.id, c2.id, f2.id]);
  assert.equal(p.jobs.producedBy(c2.id)!.inputs[0]!.assetId, f1.id);
  p.close();
});

test('docs: undo/redo, batch is one step, new edit clears redo, failed batch rolls back', async () => {
  const d = await tmpDir();
  const p = await Project.create(path.join(d, 'proj'), 'T');
  const docs = p.docs;
  docs.set('board', 'a', { x: 1 }, 'Create');
  docs.set('board', 'a', { x: 2 }, 'Move');
  docs.batch('Move many', () => { docs.set('board', 'a', { x: 3 }); docs.set('board', 'b', { y: 1 }); });
  assert.equal(docs.undoLabel, 'Move many');
  docs.undo();
  assert.deepEqual(docs.get('board', 'a'), { x: 2 }); assert.equal(docs.get('board', 'b'), undefined);
  docs.redo();
  assert.deepEqual(docs.get('board', 'a'), { x: 3 }); assert.deepEqual(docs.get('board', 'b'), { y: 1 });
  docs.undo(); docs.undo(); docs.undo();
  assert.equal(docs.get('board', 'a'), undefined); assert.equal(docs.canUndo, false);
  docs.redo(); docs.set('board', 'a', { x: 9 }, 'New edit');
  assert.equal(docs.canRedo, false);
  assert.throws(() => docs.batch('bad', () => { docs.set('board', 'z', { n: 1 }); throw new Error('nope'); }), /nope/);
  assert.equal(docs.get('board', 'z'), undefined);
  docs.set('board', 'a', { x: 9 }, 'same value');   // no-op, no history entry
  assert.equal(docs.undoLabel, 'New edit');
  docs.set('board', 'a', undefined, 'Delete'); docs.undo();
  assert.deepEqual(docs.get('board', 'a'), { x: 9 });
  p.close();
});

test('project: reopen keeps data, backup rotates, newer format refused, unknown folder refused', async () => {
  const d = await tmpDir();
  const dir = path.join(d, 'proj');
  let p = await Project.create(dir, 'Film');
  p.docs.set('bible', 'main', { title: 'x' });
  for (let i = 0; i < 4; i++) await p.backup(2);
  assert.equal((await fs.readdir(path.join(dir, 'backups'))).length, 2);
  await p.saveWorkflow(hashJson({ w: 1 }), '{"w":1}'); await p.saveWorkflow(hashJson({ w: 1 }), '{"w":1}');
  p.close();
  p = await Project.open(dir);
  assert.equal(p.info.name, 'Film');
  assert.deepEqual(p.docs.get('bible', 'main'), { title: 'x' });
  // backup is a usable database
  const b = openDb(path.join(dir, 'backups', (await fs.readdir(path.join(dir, 'backups')))[0]!));
  assert.equal(b.all('SELECT * FROM docs').length, 1); b.close();
  p.close();
  await assert.rejects(Project.create(dir, 'again'), /already exists/);
  await assert.rejects(Project.open(d), /Not a Driftboard project/);
  const info = JSON.parse(await fs.readFile(path.join(dir, 'project.driftboard.json'), 'utf8'));
  await fs.writeFile(path.join(dir, 'project.driftboard.json'), JSON.stringify({ ...info, formatVersion: 99 }));
  await assert.rejects(Project.open(dir), /newer than this app/);
});

test('kill -9 mid-work: committed data survives, uncommitted gone, temps cleaned, running job marked failed', async () => {
  const d = await tmpDir();
  const dir = path.join(d, 'proj');
  (await Project.create(dir, 'Crash')).close();
  const r = spawnSync(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, 'crash-child.ts'), dir], { encoding: 'utf8' });
  assert.match(r.stdout, /READY/, r.stderr);
  assert.notEqual(r.status, 0);   // killed, not a clean exit
  assert.ok((await fs.readdir(path.join(dir, 'assets'))).includes('zz.partial.tmp'));
  const p = await Project.open(dir);
  assert.equal((await fs.readdir(path.join(dir, 'assets'))).includes('zz.partial.tmp'), false);
  assert.equal(p.docs.get('board', 'uncommitted'), undefined);
  assert.equal((p.docs.get<{ nodes: unknown[] }>('board', 'main'))!.nodes.length, 1);
  assert.equal(p.recovered.length, 1);
  assert.equal(p.recovered[0]!.status, 'failed');
  assert.match(p.recovered[0]!.error!, /Interrupted/);
  assert.deepEqual(await p.assets.verify(true), []);
  assert.equal(p.jobs.list('running').length, 0);
  p.close();
});

test('job origin is stored and kept on retry; recordDone gives lineage for derived files', async () => {
  const d = await tmpDir();
  const p = await Project.create(path.join(d, 'proj'), 'T');
  const clip = await p.assets.importBuffer(Buffer.from('clip'), 'mp4');
  const frame = await p.assets.importBuffer(Buffer.from('frame'), 'png');
  const j = p.jobs.recordDone('extract', [{ assetId: clip.id, role: 'clip' }], [{ assetId: frame.id, role: 'frame' }], { which: 'last' });
  assert.equal(j.status, 'done'); assert.equal(p.jobs.producedBy(frame.id)!.inputs[0]!.assetId, clip.id);
  const g = p.jobs.create({ kind: 'generate', origin: 'item-1', inputs: [{ assetId: frame.id, role: 'first_frame' }] });
  assert.equal(g.origin, 'item-1'); assert.equal(p.jobs.retry(g.id).origin, 'item-1');
  assert.deepEqual(p.jobs.ancestors(frame.id).map((a) => a.assetId), [clip.id]);
  p.close();
});

test('timeline model is saved in the project and survives reopen', async () => {
  const d = await tmpDir(); const dir = path.join(d, 'proj');
  let p = await Project.create(dir, 'T');
  assert.equal(p.loadTimeline(), null);
  p.saveTimeline('{"a":1}'); p.saveTimeline('{"a":2}');
  p.close(); p = await Project.open(dir);
  assert.equal(p.loadTimeline(), '{"a":2}');
  p.close();
});

test('film blocks: starter set, project default, a story\'s own set, back to the default; undo works', async () => {
  const d = await tmpDir();
  const p = await Project.create(path.join(d, 'proj'), 'T');
  const st = p.story;
  const a = st.addStory('A'), b = st.addStory('B');
  assert.equal(st.blocks(a.id).source, 'starter'); assert.ok(st.blocks(a.id).blocks.some((x) => x.id === 'music'));
  st.setBlocks('project', [{ id: 'look', name: 'Film look', text: '16mm, grainy' }, { id: '', name: 'Narrator voice', text: 'calm, low' }]);
  assert.equal(st.blocks(a.id).source, 'project'); assert.deepEqual(st.blocks(b.id).blocks.map((x) => x.id), ['look', 'narrator-voice']);
  st.setBlocks(a.id, [{ id: 'look', name: 'Film look', text: 'IMAX, crisp' }]);
  assert.equal(st.blocks(a.id).source, 'story'); assert.equal(st.blocks(a.id).blocks[0]!.text, 'IMAX, crisp');
  assert.equal(st.blocks(b.id).blocks[0]!.text, '16mm, grainy');                     // the other story still follows the project
  p.docs.undo(); assert.equal(st.blocks(a.id).source, 'project');
  p.docs.redo(); st.clearBlocks(a.id); assert.equal(st.blocks(a.id).source, 'project');
  st.setBlocks(b.id, [{ id: 'look', name: 'Film look', text: 'x' }]); st.removeStory(b.id); assert.equal(st.blocks(b.id).source, 'project');
  p.close();
});
