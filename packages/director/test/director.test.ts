import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LlmClient, loadGuides } from '@driftboard/adapter-llm';
import { parseScript, makeBible, makeScenes, makeShots, makePrompt, lintPrompt, chunkScene, sceneInputFromParsed, packBeats, shotNames, type Bible, type TargetProfile, type ShotBrief } from '../src/index.ts';

const SCRIPT = `Title: The Keeper
Author: Test

FADE IN:

INT. LIGHTHOUSE LAMP ROOM - NIGHT

A storm rattles the glass. MARA (70s, weathered) trims the wick of a huge lamp.

MARA
(whispering)
Not tonight, old friend.

She turns. TOM (20s, soaked) stands at the stair door.

TOM
There's a boat on the rocks.

CUT TO:

EXT. ROCKS - NIGHT

Waves slam the rocks. A small boat tilts, its lantern swinging.

MARA (V.O.)
Hold on.
`;

/** An LLM that answers from a script of replies and records what it was asked. */
function scripted(replies: (string | ((user: string) => string))[]) {
  const asked: { system: string; user: string }[] = []; let i = 0;
  const f: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit).body));
    asked.push({ system: body.messages[0].content, user: body.messages[1].content });
    const r = replies[Math.min(i++, replies.length - 1)]!;
    const content = typeof r === 'function' ? r(body.messages[1].content) : r;
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { llm: new LlmClient({ baseUrl: 'http://x/v1', model: 'm', fetch: f }), asked };
}

const TARGET: TargetProfile = { id: 't', title: 'Test Model', seconds: [3, 5, 8], maxRefs: 2, promptGuide: 'Write [Shot 1] then the description.' };
const BIBLE: Bible = { style: 'Moody film noir', characters: [{ id: 'mara', name: 'MARA', look: 'A weathered woman in her seventies in a yellow raincoat.' }, { id: 'tom', name: 'TOM', look: 'A soaked young man in a grey sweater.' }], places: [{ id: 'lamp-room', name: 'LIGHTHOUSE LAMP ROOM', look: 'A round glass room around a huge lamp.' }] };

test('parse: title, scene headings, cues, parentheticals, transitions ignored, characters collected', () => {
  const p = parseScript(SCRIPT);
  assert.equal(p.title, 'The Keeper'); assert.equal(p.mode, 'screenplay');
  assert.deepEqual(p.scenes.map((s) => [s.place, s.time]), [['LIGHTHOUSE LAMP ROOM', 'NIGHT'], ['ROCKS', 'NIGHT']]);
  assert.deepEqual(p.characters.sort(), ['MARA', 'TOM']);
  const s1 = p.scenes[0]!;
  assert.deepEqual(s1.elements.map((e) => e.type), ['action', 'parenthetical', 'dialogue', 'action', 'dialogue']);
  assert.equal(s1.elements[2]!.character, 'MARA'); assert.equal(s1.elements[2]!.text, 'Not tonight, old friend.');
  assert.ok(!p.scenes[1]!.text.includes('CUT TO'));
  assert.ok(p.scenes[1]!.characters.includes('MARA'));                       // "MARA (V.O.)" is Mara
});

test('parse: text without scene headings is loose; forced heading with a dot works', () => {
  assert.equal(parseScript('A lighthouse keeper finds a boat in a storm. She rescues the sailor.').mode, 'loose');
  const f = parseScript('.THE ROCKS - DAWN\n\nGulls wheel.'); assert.equal(f.mode, 'screenplay'); assert.equal(f.scenes[0]!.place, 'THE ROCKS');
});

test('bible: ids from names, missing character added with a warning, retries bad JSON, sends names and script', async () => {
  const good = JSON.stringify({ style: 'Moody noir', characters: [{ name: 'MARA', look: 'A weathered woman in a yellow raincoat with silver hair tied back and a deeply lined face, strong hands, steady eyes.' }], places: [{ name: 'LIGHTHOUSE LAMP ROOM', look: 'Round glass room.' }, { name: 'ROCKS', look: 'Black wet rocks.' }] });
  const { llm, asked } = scripted(['sorry, here you go: {"style": }', good]);
  const { bible, warnings } = await makeBible(llm, parseScript(SCRIPT));
  assert.equal(asked.length, 2); assert.match(asked[1]!.user, /could not be used/);
  assert.deepEqual(bible.characters.map((c) => c.id), ['mara', 'tom']);
  assert.ok(warnings.some((w) => /did not describe TOM/.test(w)));
  assert.match(asked[0]!.user, /Characters \(use these names\): MARA, TOM/); assert.match(asked[0]!.user, /Not tonight, old friend/);
  assert.equal(bible.places.length, 2);
});

test('scenes (loose story): maps place and character names to ids', async () => {
  const { llm } = scripted([JSON.stringify({ scenes: [{ title: 'Storm', summary: 'A boat is in trouble.', place: 'rocks', characters: ['mara', 'Nobody'] }, { title: 'Rescue', summary: 'Mara helps.', characters: ['TOM'] }] })]);
  const b: Bible = { ...BIBLE, places: [...BIBLE.places, { id: 'rocks', name: 'ROCKS', look: 'x' }] };
  const { scenes } = await makeScenes(llm, parseScript('loose story'), b);
  assert.deepEqual(scenes.map((s) => [s.id, s.placeId, s.characterIds]), [['s1', 'rocks', ['mara']], ['s2', undefined, ['tom']]]);
});

test('shots: snaps framing, move and seconds; removes invented dialogue; lengthens for dialogue', async () => {
  const reply = JSON.stringify({ shots: [
    { framing: 'Wide establishing', move: 'slow dolly in', action: 'A storm rattles the glass of the lamp room.', seconds: '4', characters: ['mara'] },
    { framing: 'extreme close up', move: 'nothing', action: 'Mara trims the wick.', dialogue: [{ speaker: 'MARA', line: 'Not tonight, old friend.' }], seconds: 3, characters: ['MARA'] },
    { framing: 'medium', move: 'pan', action: 'Tom appears.', dialogue: [{ speaker: 'TOM', line: 'I have a completely different line here that nobody wrote.' }], seconds: 3, characters: ['Tom'] },
  ] });
  const { llm } = scripted([reply]);
  const parsed = parseScript(SCRIPT);
  const { shots, warnings } = await makeShots(llm, sceneInputFromParsed(parsed.scenes[0]!, BIBLE), BIBLE, TARGET);
  assert.deepEqual(shots.map((s) => [s.framing, s.move, s.seconds]), [['wide', 'push-in', 5], ['extreme-close', 'static', 3], ['medium', 'pan', 3]]);
  assert.deepEqual(shots.map((s) => s.characterIds), [['mara'], ['mara'], ['tom']]);
  assert.ok(warnings.some((w) => /Shot 3: the invented line/.test(w)));
  assert.deepEqual(shots[2]!.dialogue, []);                                  // invented lines are removed, not kept
  assert.ok(!warnings.some((w) => /Shot 2/.test(w)));                       // real line, no warning
});

test('shots: long scenes are split into several calls with the previous shot carried over', () => {
  const text = Array.from({ length: 30 }, (_, i) => `Line ${i} ${'x'.repeat(100)}`).join('\n');
  const chunks = chunkScene(text, 1000);
  assert.ok(chunks.length >= 3); assert.equal(chunks.join('\n'), text); assert.ok(chunks.every((c) => c.length <= 1100));
});

test('prompt: retries chatter, passes the guide and refs, warns about missing dialogue and unused pictures', async () => {
  const shot: ShotBrief = { framing: 'close', move: 'static', action: 'Mara trims the wick.', dialogue: [{ speaker: 'MARA', line: 'Not tonight, old friend.' }], seconds: 5, characterIds: ['mara'], placeId: 'lamp-room' };
  const { llm, asked } = scripted(["Sure! Here is your prompt: [Shot 1] ...", '[Shot 1] Close on <Picture 1>, a weathered woman in a yellow raincoat, trimming a wick in a round glass room. Warm light.']);
  const r = await makePrompt(llm, { shot, scene: { id: 's1', heading: 'LAMP ROOM', text: '' }, bible: BIBLE, target: TARGET, refs: [{ n: 1, name: 'MARA' }, { n: 2, name: 'TOM' }] });
  assert.match(r.prompt, /^\[Shot 1\]/);
  assert.match(asked[0]!.system, /Write \[Shot 1\] then the description/);            // the profile guide is in the system prompt
  assert.match(asked[0]!.user, /<Picture 1> = reference picture: MARA/);
  assert.match(asked[1]!.user, /chatter/);
  assert.ok(r.warnings.some((w) => /Not tonight/.test(w))); assert.ok(r.warnings.some((w) => /<Picture 2>/.test(w))); assert.ok(r.warnings.some((w) => /second try/.test(w)));
});

test('lint: placeholders and stray picture tags are hard errors', () => {
  const shot: ShotBrief = { framing: 'wide', move: 'static', action: 'x', dialogue: [], seconds: 3, characterIds: [] };
  assert.match(lintPrompt('[Shot 1] At 00:00.000 ... a woman walks along the shore at dusk with her bag.', shot, []).errors.join(), /placeholder/);
  assert.match(lintPrompt('<Picture 1> walks along the shore at dusk carrying a heavy canvas bag.', shot, []).errors.join(), /no input pictures/);
  assert.deepEqual(lintPrompt('<Picture 1> walks along the shore at dusk carrying a heavy canvas bag.', shot, [{ n: 1, name: 'E' }]).errors, []);
});

test('lint: errors vs warnings', () => {
  const shot: ShotBrief = { framing: 'wide', move: 'static', action: 'x', dialogue: [], seconds: 3, characterIds: [] };
  assert.equal(lintPrompt('short', shot, []).errors.length, 1);
  assert.equal(lintPrompt('```a long enough prompt that has a fence in it, definitely.```', shot, []).errors.length, 1);
  assert.deepEqual(lintPrompt('A perfectly good prompt that is long enough to pass the checks.', shot, []), { errors: [], warnings: [] });
});

import { enhancePrompt, cleanPrompt, setDurationLine } from '../src/index.ts';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

test('enhance: the shot length goes to the model and the final duration line is written by the app', async () => {
  const { llm, asked } = scripted(['integrated_multimodal_description: [Shot 1] A woman walks along a quay in rain, steady and slow.\n\noverall_soundscape: rain\n\nnon_diegetic_music: N/A\n\nrecommended_duration: 10 seconds']);
  const r = await enhancePrompt(llm, { idea: 'woman on a quay in the rain', guide: { body: 'GUIDE TEXT', durationLine: 'recommended_duration' }, seconds: 7 });
  assert.match(asked[0]!.system, /GUIDE TEXT/); assert.match(asked[0]!.system, /target duration is 7 seconds/);
  assert.match(asked[0]!.user, /Target duration: 7 seconds/); assert.match(asked[0]!.user, /Input pictures: none/);
  assert.equal(r.prompt.match(/recommended_duration/g)!.length, 1);                 // the model's 10 s line was replaced, not doubled
  assert.match(r.prompt, /recommended_duration: 7 seconds$/);
  assert.equal(setDurationLine('text', 'recommended_duration', 5), 'text\n\nrecommended_duration: 5 seconds');
});

test('enhance: input pictures keep their roles, a first-frame target allows <Picture 1>, chatter is cleaned, bad answers retry', async () => {
  const { llm, asked } = scripted(['Here is the prompt: <Picture 1> sits.', '```\nFor the target video, <Picture 1> is the first frame; the woman turns and smiles at the camera slowly.\n```']);
  const r = await enhancePrompt(llm, { idea: 'she turns', guide: { body: 'G' }, inputs: [{ n: 1, role: 'the literal first frame' }], addon: 'ADDON TEXT' });
  assert.match(asked[0]!.user, /<Picture 1> = the literal first frame/); assert.match(asked[0]!.system, /ADDON TEXT/);
  assert.match(asked[1]!.user, /could not be used/);
  assert.match(r.prompt, /^For the target video, <Picture 1>/); assert.ok(r.warnings.some((w) => /second try/.test(w)));
  assert.equal(cleanPrompt('```text\nabc\n```'), 'abc'); assert.equal(cleanPrompt('Sure, here it is:\n\nThe prompt'), 'The prompt');
  assert.equal(cleanPrompt('"quoted whole"'), 'quoted whole');
});

test('enhance: thinking level of the call is passed on', async () => {
  let effort = '';
  const f: typeof fetch = async (_u, init) => { effort = JSON.parse(String((init as RequestInit).body)).reasoning_effort; return new Response(JSON.stringify({ choices: [{ message: { content: 'A long enough prompt about a lighthouse keeper at dusk.' } }] })); };
  await enhancePrompt(new LlmClient({ baseUrl: 'http://x/v1', model: 'm', fetch: f }), { idea: 'x', guide: { body: 'G' }, thinking: 'medium' });
  assert.equal(effort, 'medium');
});

test('the shipped guides exist, the H3 one has the duration line and no fixed 4-15 second rule', async () => {
  const dir = nodePath.resolve(import.meta.dirname, '../../../guides');
  const all = await loadGuides([dir]);
  for (const id of ['h3-video', 'h3-image-edit', 'moss-image', 'director-bible', 'director-scenes', 'director-shots', 'continue-shot', 'bridge-shot', 'assistant', 'script-from-idea', 'dialogue-polish']) assert.ok(all.get(id)?.body.length, id);
  const h3 = all.get('h3-video')!;
  assert.equal(h3.durationLine, 'recommended_duration');
  assert.ok(!/4 to 15 seconds|\(4-15s\)/.test(h3.body)); assert.match(h3.body, /target duration/i);
  assert.match(all.get('director-shots')!.body, /\{\{maxShots\}\}/);
  void nodeFs;
});

test('interpret: dialogue written as "name: line" is found, and lines missing from the interpreted script are listed', async () => {
  const { spokenLines, missingDialogue } = await import('../src/parse.ts');
  const src = ['a cafe.', 'man 1: hey dude i saw a van today.', 'man 2: and?'].join('\n');
  assert.deepEqual(spokenLines(src).map((d) => d.speaker), ['man 1', 'man 2']);
  assert.equal(missingDialogue(src, ['INT. CAFE - DAY', '', 'MAN 1', 'Hey dude, I saw a van today.', '', 'MAN 2', 'And?'].join('\n')).length, 0);
  assert.deepEqual(missingDialogue(src, ['INT. CAFE - DAY', '', 'MAN 1', 'Hey dude, I saw a van today.'].join('\n')).map((d) => d.line), ['and?']);
});

test('film blocks: overrides and switches resolve per shot; the LLM gets them as fixed decisions plus the previous shot; assembling works without the LLM', async () => {
  const { activeBlocks, assemblePrompt, inheritUse, STARTER_BLOCKS } = await import('../src/blocks.ts');
  const story = STARTER_BLOCKS.map((b) => ({ ...b, text: b.id === 'look' ? '35mm, warm dusk light' : b.id === 'music' ? 'slow piano' : b.id === 'sound' ? 'rain on tin roofs' : '' }));
  assert.deepEqual(activeBlocks(story).map((b) => b.id), ['look', 'sound', 'music']);                      // empty blocks are not used
  const shot = activeBlocks(story, { off: ['music'], override: { sound: 'thunder, then silence' } });
  assert.deepEqual(shot.map((b) => [b.id, b.text]), [['look', '35mm, warm dusk light'], ['sound', 'thunder, then silence']]);
  assert.equal(assemblePrompt('She opens the door.', shot), 'She opens the door.\n\nFilm look: 35mm, warm dusk light\n\nSound and ambience: thunder, then silence');
  // a shot that continues another keeps exactly what that one used, even after the story's blocks changed
  const changed = story.map((b) => (b.id === 'look' ? { ...b, text: 'cold blue night' } : b));
  assert.deepEqual(activeBlocks(changed, inheritUse(changed, shot)).map((b) => [b.id, b.text]), [['look', '35mm, warm dusk light'], ['sound', 'thunder, then silence']]);

  let seen: { system: string; user: string } | undefined;
  const llm = { chat: async (r: { system: string; user: string }) => { seen = r; return 'A woman opens a wooden door in warm dusk light on 35mm film while thunder rolls, then silence.'; } } as never;
  await enhancePrompt(llm, { idea: 'She opens the door.', guide: { body: 'GUIDE' }, blocks: shot, previousPrompt: 'She walks up the path in the rain.' });
  assert.match(seen!.system, /Only the IDEA is new/);
  assert.match(seen!.user, /FILM BLOCKS[^\n]*\n- Film look: 35mm, warm dusk light\n- Sound and ambience: thunder, then silence/);
  assert.match(seen!.user, /PREVIOUS SHOT'S PROMPT[^\n]*\nShe walks up the path in the rain\./);
  await enhancePrompt(llm, { idea: 'x is a long enough idea for the test', guide: { body: 'GUIDE' } });
  assert.doesNotMatch(seen!.system, /Only the IDEA is new/); assert.doesNotMatch(seen!.user, /FILM BLOCKS/);  // no blocks: nothing changes
});

test('packBeats: whole beats, at most the limit, later parts leave room for the held frames', () => {
  const b = (s: number) => ({ seconds: s });
  assert.deepEqual(packBeats([b(3), b(4), b(2), b(5), b(4)], 10, 9).map((p) => p.map((x) => x.seconds)), [[3, 4, 2], [5, 4]]);
  assert.deepEqual(packBeats([b(12), b(3)], 10).map((p) => p.length), [1, 1]);   // a beat longer than the limit stays whole, alone
  assert.deepEqual(packBeats([b(4), b(4), b(2)], 10).length, 1);
});

test('shots: beats of one shot are packed into parts that continue the same take; the end state goes with the last part', async () => {
  const reply = JSON.stringify({ shots: [
    { framing: 'medium', move: 'tracking', characters: ['MARA'], endState: 'Mara stands at the window holding the lamp.', beats: [
      { action: 'Mara trims the wick.', dialogue: [{ speaker: 'MARA', line: 'Not tonight, old friend.' }], seconds: 4 },
      { action: 'She lifts the lamp.', seconds: 4 }, { action: 'She walks to the window.', seconds: 4 }, { action: 'She looks out at the sea.', seconds: 4 }] },
    { framing: 'close', move: 'static', characters: ['TOM'], endState: 'Tom in the doorway.', beats: [{ action: 'Tom appears at the door.', seconds: 3 }] },
  ] });
  const { llm, asked } = scripted([reply]);
  const parsed = parseScript(SCRIPT);
  const target: TargetProfile = { ...TARGET, seconds: [3, 5, 8, 10, 12, 15], freeSeconds: true, heldSec: 22 / 24 };
  const { shots } = await makeShots(llm, sceneInputFromParsed(parsed.scenes[0]!, BIBLE), BIBLE, target, undefined, { maxPart: 10 });
  assert.match(asked[0]!.user, /Longest clip the video model makes: 10 seconds/);
  assert.deepEqual(shots.map((s) => [s.seconds, s.continues ?? false, s.part?.index ?? 0]), [[8, false, 1], [8, true, 2], [3, false, 0]]);
  assert.equal(shots[0]!.endState, undefined); assert.match(shots[1]!.endState ?? '', /window/);
  assert.match(shots[0]!.action, /^0-4 s: Mara trims the wick\. 4-8 s: She lifts the lamp\./);
  assert.deepEqual(shotNames(shots).map((x) => x.name), ['Shot 1 · part 1/2', 'Shot 1 · part 2/2', 'Shot 2']);
});

test('prompt: a continuing part gets the previous prompt and the continue add-on; a cut gets only the end state', async () => {
  const prevPrompt = '[Shot 1] Medium tracking on Mara in a yellow raincoat lifting a brass lamp in the round glass room.';
  const part: ShotBrief = { framing: 'medium', move: 'tracking', action: 'x', beats: [{ action: 'She walks to the window.', dialogue: [], seconds: 4 }, { action: 'She looks out.', dialogue: [], seconds: 4 }], dialogue: [], seconds: 8, characterIds: ['mara'], continues: true, part: { index: 2, count: 2, shot: 1 } };
  const prev: ShotBrief = { framing: 'medium', move: 'tracking', action: 'Mara lifts the lamp.', dialogue: [], seconds: 8, characterIds: ['mara'], endState: 'Mara holds the lamp at the window.' };
  const ok = '[Shot 1] Medium tracking: the weathered woman keeps walking to the window with the brass lamp, then looks out at the storm.';
  const { llm, asked } = scripted([ok, ok]);
  await makePrompt(llm, { shot: part, scene: { id: 's1', heading: 'LAMP ROOM', text: '' }, bible: BIBLE, target: { ...TARGET, heldSec: 0.9 }, previous: prev, previousPrompt: prevPrompt });
  assert.match(asked[0]!.system, /one unbroken camera take/);
  assert.match(asked[0]!.user, /PREVIOUS SHOT'S PROMPT[\s\S]*brass lamp/);
  assert.match(asked[0]!.user, /0-4 s: She walks to the window\.\n4-8 s: She looks out\./);
  assert.doesNotMatch(asked[0]!.user, /How things stand now/);
  const cut: ShotBrief = { ...part, continues: false, part: undefined, framing: 'close' };
  await makePrompt(llm, { shot: cut, scene: { id: 's1', heading: 'LAMP ROOM', text: '' }, bible: BIBLE, target: TARGET, previous: prev, previousPrompt: prevPrompt });
  assert.doesNotMatch(asked[1]!.system, /unbroken camera take/);
  assert.doesNotMatch(asked[1]!.user, /PREVIOUS SHOT'S PROMPT/);
  assert.match(asked[1]!.user, /How things stand now[^\n]*holds the lamp at the window/);
});
