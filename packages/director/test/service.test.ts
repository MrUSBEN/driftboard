import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LlmClient } from '@driftboard/adapter-llm';
import { DirectorService, type Progress, type TargetProfile } from '../src/index.ts';

const SCRIPT = `INT. KITCHEN - NIGHT

ELSA (60s) sets a bag on the table. JONAH (10) watches.

JONAH
You came back.

EXT. CLIFF - DAWN

Elsa climbs a path.
`;
const TARGET: TargetProfile = { id: 'h3', title: 'H3', seconds: [3, 5, 8], maxRefs: 2, promptGuide: 'guide' };

function mk(handler: (system: string, user: string, n: number) => string) {
  const calls: string[] = []; let n = 0;
  const f: typeof fetch = async (_u, init) => {
    const b = JSON.parse(String((init as RequestInit).body));
    const sys = b.messages[0].content as string, user = b.messages[1].content as string;
    if ((init as RequestInit).signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const kind = /APP RULES/.test(sys) ? 'prompt' : /story bible/.test(sys) ? 'bible' : /Break the scene|planning shots/.test(sys) ? 'shots' : 'other';
    calls.push(kind);
    return new Response(JSON.stringify({ choices: [{ message: { content: handler(kind, user, ++n) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const store = { json: null as string | null }; const progress: Progress[] = [];
  const svc = new DirectorService({ llm: new LlmClient({ baseUrl: 'http://x/v1', model: 'm', fetch: f }), load: () => store.json, save: (j) => { store.json = j; }, target: () => TARGET, emit: (p) => progress.push(p) });
  return { svc, calls, store, progress };
}
const replies = (kind: string, user: string) => kind === 'bible'
  ? JSON.stringify({ style: 'warm', characters: [{ name: 'ELSA', look: 'a sturdy woman in her sixties with a grey braid' }, { name: 'JONAH', look: 'a thin boy in a big wool sweater' }], places: [{ name: 'KITCHEN', look: 'stone room' }, { name: 'CLIFF', look: 'windy cliff' }] })
  : kind === 'shots' ? JSON.stringify({ shots: [{ framing: 'wide', move: 'static', action: 'Elsa sets the bag down.', seconds: 5, characters: ['ELSA'] }, { framing: 'close', move: 'push-in', action: 'Jonah watches.', dialogue: [{ speaker: 'JONAH', line: 'You came back.' }], seconds: 3, characters: ['JONAH'] }] })
  : `[Shot 1] ${user.includes('Jonah') ? 'A boy in a wool sweater says: You came back.' : 'A sturdy grey-braided woman sets a bag on a stone table in a warm kitchen.'}`;

test('full pipeline: bible, shots for every scene, prompts; progress events; state saved after each call', async () => {
  const { svc, calls, store, progress } = mk(replies);
  svc.setScript(SCRIPT);
  assert.equal(svc.state.parsed!.scenes.length, 2);
  await svc.run('bible'); assert.deepEqual(svc.state.bible!.characters.map((c) => c.id), ['elsa', 'jonah']);
  await svc.run('shots'); assert.equal(Object.keys(svc.state.shots).length, 2);
  await svc.run('prompts');
  assert.equal(Object.keys(svc.state.prompts).length, 4);
  assert.deepEqual(calls.filter((c) => c === 'prompt').length, 4);
  assert.ok(progress.some((p) => p.step === 'prompts' && p.total === 4)); assert.equal(progress.at(-1)!.running, false);
  assert.ok(JSON.parse(store.json!).prompts['s1:1']);                              // persisted
  const reload = new DirectorService({ ...(svc as unknown as { d: ConstructorParameters<typeof DirectorService>[0] }).d, load: () => store.json });
  assert.equal(Object.keys(reload.state.prompts).length, 4);
});

test('only a missing script blocks a step; the rest runs on what exists', async () => {
  const { svc } = mk(replies);
  await assert.rejects(svc.run('bible'), /Paste or import a script/);
  svc.setScript(SCRIPT);
  await svc.run('shots');   // no bible yet: runs with an empty one
  assert.ok(svc.state.shots.s1!.shots.length > 0);
});

test('edited prompts survive a re-run unless forced; refs follow character reference pictures', async () => {
  const { svc } = mk(replies);
  svc.setScript(SCRIPT); await svc.run('bible');
  svc.update({ bible: { ...svc.state.bible!, characters: svc.state.bible!.characters.map((c) => (c.id === 'elsa' ? { ...c, refAsset: 'asset-elsa' } : c)) } });
  await svc.run('shots'); await svc.run('prompts');
  assert.deepEqual(svc.refsOf('s1', 0), ['asset-elsa']); assert.deepEqual(svc.refsOf('s1', 1), []);   // Jonah has no picture
  svc.update({ prompts: { ...svc.state.prompts, 's1:0': { ...svc.state.prompts['s1:0']!, prompt: 'MY OWN WORDS' } } });
  await svc.run('prompts');
  assert.equal(svc.state.prompts['s1:0']!.prompt, 'MY OWN WORDS');
  await svc.run('prompts', { force: true });
  assert.notEqual(svc.state.prompts['s1:0']!.prompt, 'MY OWN WORDS');
  svc.update({ prompts: { ...svc.state.prompts } });
  await svc.run('bible');                                                       // re-running the bible keeps attached pictures
  assert.equal(svc.state.bible!.characters.find((c) => c.id === 'elsa')!.refAsset, 'asset-elsa');
});

test('re-planning a scene clears only that scene\'s prompts; one prompt can be rewritten alone', async () => {
  const { svc, calls } = mk(replies);
  svc.setScript(SCRIPT); await svc.run('bible'); await svc.run('shots'); await svc.run('prompts');
  await svc.run('shots', { only: 's2' });
  assert.ok(svc.state.prompts['s1:0'] && !svc.state.prompts['s2:0']);
  const before = calls.length; await svc.run('prompts', { only: 's1:1', force: true });
  assert.equal(calls.length - before, 1);
});

test('plan for the story: scenes, shots, briefs, prompts, warnings', async () => {
  const { svc } = mk(replies);
  svc.setScript(SCRIPT); await svc.run('bible'); await svc.run('shots'); await svc.run('prompts');
  const plan = svc.buildPlan();
  assert.deepEqual(plan.map((p) => [p.sourceId, p.shots.length]), [['s1', 2], ['s2', 2]]);
  assert.equal(plan[0]!.shots[1]!.brief.dialogue[0]!.line, 'You came back.'); assert.match(plan[0]!.shots[0]!.prompt!, /\[Shot 1\]/);
});

test('a failed prompt does not stop the run; cancel stops it cleanly', async () => {
  const { svc } = mk((kind, user, n) => (kind === 'prompt' && n % 2 === 0 ? 'not json at all' : replies(kind, user)));
  svc.setScript(SCRIPT); await svc.run('bible'); await svc.run('shots'); await svc.run('prompts');
  const bad = Object.values(svc.state.prompts).filter((p) => !p.prompt);
  assert.ok(Object.keys(svc.state.prompts).length === 4);
  assert.ok(bad.every((p) => p.warnings.length));
  const slow = mk(replies); slow.svc.setScript(SCRIPT); await slow.svc.run('bible');
  const p = slow.svc.run('shots'); slow.svc.cancel();
  await assert.rejects(p, /Cancelled/); assert.equal(slow.svc.running, false);
});

test('loose story: shots work on the whole text, the scenes step splits it', async () => {
  const { svc } = mk((k, u) => (k === 'other' ? JSON.stringify({ scenes: [{ title: 'Arrival', summary: 'Elsa arrives.' }] }) : replies(k, u)));
  svc.setScript('Elsa climbs to the lighthouse and finds her grandson.');
  await svc.run('bible');
  assert.equal(svc.state.parsed!.mode, 'loose');
  await svc.run('shots'); assert.ok(svc.state.shots.s1);   // no split yet: one scene with the whole text
  await svc.run('scenes'); assert.equal(svc.state.scenes!.length, 1);
  await svc.run('shots'); assert.equal(svc.buildPlan()[0]!.name, 'Arrival');
});
