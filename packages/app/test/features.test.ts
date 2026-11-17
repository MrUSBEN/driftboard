import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSize, withSize, DEFAULT_FILM } from '../src/renderer/sizeCalc.ts';
import { dragBox } from '../src/renderer/cropMath.ts';
import { splitPrompts } from '../src/renderer/sbUtil.ts';
import { splitProposal } from '../src/main/llmApi.ts';
import { detectPromptKind, checkPrompt, providedOf } from '../src/renderer/promptKind.ts';
import { combo } from '../src/renderer/keys.ts';

test('sizes are explicit, snapped, and follow the purpose', () => {
  const film = { ...DEFAULT_FILM, aspect: '16:9', mp: 0.1 };
  const a = resolveSize({ purpose: 'film' }, film, null, 32);
  assert.equal(a.w % 32, 0); assert.equal(a.h % 32, 0); assert.ok(Math.abs(a.w / a.h - 16 / 9) < 0.1); assert.ok(a.mp > 0.07 && a.mp < 0.14);
  const c = resolveSize({ purpose: 'character', mp: 0.25 }, film, null, 8); assert.ok(c.h > c.w);
  const same = resolveSize({ purpose: 'same' }, film, { width: 650, height: 370 }, 32); assert.deepEqual([same.w, same.h], [640, 384]);
  const match = resolveSize({ purpose: 'match', mp: 0.25 }, film, { width: 500, height: 1000 }, 8); assert.ok(match.h > match.w * 1.9);
  assert.deepEqual(resolveSize({ purpose: 'custom', w: 1000, h: 500 }, film, null, 32), { w: 992, h: 512, mp: (992 * 512) / 1e6 });
  const v = withSize({ prompt: 'x', aspect: '9:16', out_megapixels: 1, seconds: 5, __size: {} }, { w: 640, h: 384 });
  assert.deepEqual(v, { prompt: 'x', seconds: 5, custom_width: 640, custom_height: 384 });
});

test('crop box: move stays inside, resize keeps the ratio', () => {
  const b = { x: 100, y: 100, w: 400, h: 225 };
  const m = dragBox(b, 'move', 5000, -5000, 1920, 1080, null); assert.equal(m.x, 1920 - 400); assert.equal(m.y, 0);
  const r = dragBox(b, 'se', 100, 0, 1920, 1080, 16 / 9); assert.ok(Math.abs(r.w / r.h - 16 / 9) < 0.01); assert.ok(r.w > 400);
  const f = dragBox(b, 'nw', -5000, -5000, 1920, 1080, null); assert.equal(f.x, 0); assert.equal(f.y, 0);
});

test('pasted prompts split by blank lines or numbers', () => {
  assert.deepEqual(splitPrompts('1. A girl runs.\n2. She stops.\n3) The end.'), ['A girl runs.', 'She stops.', 'The end.']);
  assert.deepEqual(splitPrompts('First one\nline two\n\nSecond one'), ['First one\nline two', 'Second one']);
  assert.deepEqual(splitPrompts('Shot 1: a\n\nShot 2: b'), ['a', 'b']);
});

test('assistant proposal block is split off the reply', () => {
  const r = splitProposal('Sure, here you go.\n```driftboard\n{"kind":"video","prompt":"A cat walks.","seconds":5}\n```');
  assert.equal(r.text, 'Sure, here you go.'); assert.deepEqual(r.proposal, { kind: 'video', prompt: 'A cat walks.', seconds: 5 });
  assert.equal(splitProposal('just chatting').proposal, undefined);
  assert.equal(splitProposal('x ```driftboard\nnot json```').proposal, undefined);
});

test('key combos are written the same way they are stored', () => {
  const ev = (o: object) => o as KeyboardEvent;
  assert.equal(combo(ev({ key: 'z', ctrlKey: true, shiftKey: false, altKey: false })), 'Ctrl+Z');
  assert.equal(combo(ev({ key: 'ArrowLeft', shiftKey: true, ctrlKey: false, altKey: false })), 'Shift+Left');
  assert.equal(combo(ev({ key: ' ', ctrlKey: false, shiftKey: false, altKey: false })), 'Space');
  assert.equal(combo(ev({ key: 'Shift', shiftKey: true })), null);
});

test('prompt kinds are read from the wording and checked against the inputs', () => {
  const slots = [{ id: 'first_frame', type: 'image', role: 'first_frame' }, { id: 'last_frame', type: 'image', role: 'last_frame' }];
  assert.equal(detectPromptKind('A cat walks across a roof.').kind, 'text');
  assert.equal(detectPromptKind('For the target video, <Picture 1> is the first frame; it ends on <Picture 2>, the last frame.').kind, 'first-last');
  assert.equal(detectPromptKind('The scene begins exactly as depicted in <Picture 1>.').kind, 'first');
  const none = providedOf(slots, {});
  assert.equal(checkPrompt('The scene begins exactly as depicted in <Picture 1>.', none, slots).length, 1);
  assert.deepEqual(checkPrompt('A cat walks.', none, slots), []);
  const one = providedOf(slots, { first_frame: ['a'] });
  assert.deepEqual(checkPrompt('The scene begins exactly as depicted in <Picture 1>.', one, slots), []);
  assert.equal(checkPrompt('<Picture 1> first frame, ends on <Picture 2> last frame', one, slots).length > 0, true);
});

test('lineage: each source keeps its own derivatives together', async () => {
  const { arrangeLineage } = await import('../src/renderer/CanvasMenu.tsx');
  const b = (id: string, y: number) => ({ id, x: 0, y, w: 180, h: 130 });
  // two sources (man above, girl below), each with two derivatives, one clip made from one of each
  const boxes = [b('man', 0), b('girl', 400), b('m1', 10), b('m2', 20), b('g1', 410), b('g2', 420), b('both', 430)];
  const edges = [{ from: 'man', to: 'm1' }, { from: 'man', to: 'm2' }, { from: 'girl', to: 'g1' }, { from: 'girl', to: 'g2' }, { from: 'm2', to: 'both' }, { from: 'g1', to: 'both' }];
  const m = new Map(arrangeLineage(boxes, edges).map((x) => [x.id, x]));
  assert.ok(m.get('m1')!.y < m.get('g1')!.y && m.get('m2')!.y < m.get('g1')!.y, 'the man\'s derivatives stay above the girl\'s');
  assert.ok(m.get('man')!.y < m.get('girl')!.y);
});

test('resolveSize: an explicit aspect and a resolution (short side) decide the size, in either orientation', () => {
  const film = { ...DEFAULT_FILM };
  const a = resolveSize({ purpose: 'aspect', aspect: '16:9', res: 720 }, film, null, 8); assert.deepEqual([a.w, a.h], [1280, 720]);
  const b = resolveSize({ purpose: 'aspect', aspect: '9:16', res: 720 }, film, null, 8); assert.deepEqual([b.w, b.h], [720, 1280]);
  const c = resolveSize({ purpose: 'aspect', aspect: '4:3', mp: 0.25 }, film, null, 8); assert.ok(Math.abs(c.w / c.h - 4 / 3) < 0.02 && Math.abs(c.mp - 0.25) < 0.02);
  const d = resolveSize({ purpose: 'match', res: 540 }, film, { width: 1000, height: 1000 }, 8); assert.deepEqual([d.w, d.h], [544, 544]);
});
