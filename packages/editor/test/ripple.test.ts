import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDriftboardEditor, syncAssets, appendToTimeline, edit, getState, setSpeed, rippleAfter, replaceClip, placeInGap, selectClips, type EditorSourceAsset } from '../src/index.ts';

const mk = () => {
  const store = createDriftboardEditor();
  const src: EditorSourceAsset[] = ['a', 'b', 'c'].map((id) => ({ id, kind: 'video', width: 480, height: 270, duration_ms: 4000, fps: 24, has_audio: 1 }));
  syncAssets(store, src); appendToTimeline(store, ['a', 'b', 'c']);
  return store;
};
const vids = (store: ReturnType<typeof mk>) => selectClips(getState(store)).filter((c) => c.type === 'video').sort((x, y) => x.startTime - y.startTime);
const auds = (store: ReturnType<typeof mk>) => selectClips(getState(store)).filter((c) => c.type === 'audio').sort((x, y) => x.startTime - y.startTime);

test('speed up with ripple: clip shrinks, later clips close the gap, audio follows', () => {
  const store = mk(); const [a] = vids(store);
  edit(store, (s) => setSpeed(s, [a!.id, ...(a!.linkedClipIds ?? [])], 2, true));
  const v = vids(store), au = auds(store);
  assert.ok(Math.abs(v[0]!.duration - 2) < 1e-6);
  assert.ok(Math.abs(v[1]!.startTime - 2) < 1e-6 && Math.abs(v[2]!.startTime - 6) < 1e-6);
  assert.ok(Math.abs(au[1]!.startTime - 2) < 1e-6);
});

test('slow down with ripple: no overlap, later clips pushed right, nothing lost', () => {
  const store = mk(); const [a] = vids(store);
  edit(store, (s) => setSpeed(s, [a!.id, ...(a!.linkedClipIds ?? [])], 0.5, true));
  const v = vids(store);
  assert.ok(Math.abs(v[0]!.duration - 8) < 1e-6 && Math.abs(v[1]!.startTime - 8) < 1e-6 && Math.abs(v[2]!.startTime - 12) < 1e-6);
  assert.ok(Math.abs(v[1]!.duration - 4) < 1e-6);
});

test('ripple off leaves other clips alone; rippleAfter with zero delta is a no-op', () => {
  const store = mk(); const [a] = vids(store);
  edit(store, (s) => setSpeed(s, [a!.id], 2, false));
  assert.ok(Math.abs(vids(store)[1]!.startTime - 4) < 1e-6);
  const s0 = getState(store); assert.equal(rippleAfter(s0, [a!.id], 4, 0), s0);
});

test('replaceClip: same spot, audio goes with it, ripple follows the new length, old data untouched', () => {
  const store = mk();
  syncAssets(store, [{ id: 'n', kind: 'video', width: 480, height: 270, duration_ms: 6000, fps: 24, has_audio: 1 }]);
  const b = vids(store)[1]!;
  assert.ok(replaceClip(store, b.id, 'n', true));
  const v = vids(store);
  assert.equal(v[1]!.assetId, 'n'); assert.ok(Math.abs(v[1]!.startTime - 4) < 1e-6 && Math.abs(v[2]!.startTime - 10) < 1e-6);
  assert.equal(auds(store).filter((c) => c.assetId === 'n').length, 1); assert.equal(auds(store).filter((c) => c.assetId === 'b').length, 0);
  edit(store, (s) => s);   // history still works
  const store2 = mk(); syncAssets(store2, [{ id: 'n', kind: 'video', width: 480, height: 270, duration_ms: 6000, fps: 24, has_audio: 1 }]);
  replaceClip(store2, vids(store2)[1]!.id, 'n', false);
  const w = vids(store2); assert.ok(Math.abs(w[1]!.duration - 4) < 1e-6 && Math.abs(w[2]!.startTime - 8) < 1e-6);   // fitted, nothing moved
});

test('placeInGap: fills a gap, cuts to it, never overwrites', () => {
  const store = mk(); syncAssets(store, [{ id: 'n', kind: 'video', width: 480, height: 270, duration_ms: 6000, fps: 24, has_audio: 1 }]);
  const [a, b] = vids(store);
  edit(store, (s) => rippleAfter(s, [a!.id, ...(a!.linkedClipIds ?? [])], 4, 3));   // open a 3 s gap after the first clip
  assert.ok(placeInGap(store, 'n', 4, 3, 0));
  const n = vids(store).find((c) => c.assetId === 'n')!; assert.ok(Math.abs(n.startTime - 4) < 1e-6 && Math.abs(n.duration - 3) < 1e-6);
  assert.equal(vids(store).find((c) => c.id === b!.id)!.startTime, 7);   // untouched, full length
  assert.equal(placeInGap(store, 'n', 4, 3, 0), false);                    // now occupied: refuses
});
