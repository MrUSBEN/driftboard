import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ffmpegPath, probe, renderTimeline, buildRenderArgs } from '@driftboard/media';
import {
  createDriftboardEditor, syncAssets, appendToTimeline, placeAsset, rippleDelete, snapPoints, applyPicks, edit, getState, getModel, buildRenderPlan, usage, actions as A,
  selectClips, timelineEnd, selectActiveTimeline, type EditorSourceAsset,
} from '../src/index.ts';

const withLinked = (c: { id: string; linkedClipIds?: string[] }) => [c.id, ...(c.linkedClipIds ?? [])];
const dir = mkdtempSync(path.join(tmpdir(), 'driftboard-editor-'));
const ff = (...a: string[]) => execFileSync(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', ...a]);
const files = new Map<string, string>();
const src: EditorSourceAsset[] = [];
for (let i = 0; i < 12; i++) {
  const f = path.join(dir, `c${i}.mp4`);
  ff('-f', 'lavfi', '-i', `testsrc2=size=480x270:rate=24:duration=5,hue=h=${i * 30}`, '-f', 'lavfi', '-i', `sine=frequency=${200 + i * 60}:duration=5`, '-shortest', '-pix_fmt', 'yuv420p', f);
  files.set(`vid${i}`, f); src.push({ id: `vid${i}`, kind: 'video', width: 480, height: 270, duration_ms: 5000, fps: 24, has_audio: 1 });
}
const still = path.join(dir, 'still.png'); ff('-f', 'lavfi', '-i', 'color=c=red:s=480x270', '-frames:v', '1', still);
files.set('still', still); src.push({ id: 'still', kind: 'image', width: 480, height: 270, duration_ms: null, fps: null, has_audio: 0 });

test('append 12 clips: 60 s on V1 with linked audio; split + delete shortens; undo restores', () => {
  const store = createDriftboardEditor();
  syncAssets(store, src);
  appendToTimeline(store, src.slice(0, 12).map((a) => a.id));
  assert.ok(Math.abs(timelineEnd(getState(store)) - 60) < 0.01);
  const clips = selectClips(getState(store));
  assert.equal(clips.filter((c) => c.type === 'video').length, 12);
  assert.equal(clips.filter((c) => c.type === 'audio').length, 12);
  const c3 = clips.find((c) => c.assetId === 'vid3' && c.type === 'video')!;
  edit(store, (s) => A.splitClipsAtTime(s, [c3.id], c3.startTime + 2));
  assert.equal(selectClips(getState(store)).length, 26);
  const second = selectClips(getState(store)).find((c) => c.assetId === 'vid3' && c.type === 'video' && c.startTime > c3.startTime)!;
  edit(store, (s) => A.deleteClips(s, withLinked(second)));
  assert.equal(selectClips(getState(store)).length, 24);   // linked audio went with it
  store.getState().setStateWithoutHistory((s) => A.undo(s));
  assert.equal(selectClips(getState(store)).length, 26);
  store.getState().setStateWithoutHistory((s) => A.undo(s));
  assert.equal(selectClips(getState(store)).length, 24);
  assert.deepEqual([...usage(getModel(store)).entries()].slice(0, 2).map(([k, v]) => [k, v]), [['vid0', 1], ['vid1', 1]]);
});

test('model survives JSON round trip and reload', () => {
  const store = createDriftboardEditor(); syncAssets(store, src); appendToTimeline(store, ['vid0', 'vid1']);
  const json = JSON.stringify(getModel(store));
  const again = createDriftboardEditor(JSON.parse(json));
  assert.equal(selectClips(getState(again)).length, 4);
  assert.equal(selectActiveTimeline(getState(again))!.name, 'Main');
});

test('graph: layers, speed, fades and silent fallback are built as expected', () => {
  const { graph } = buildRenderArgs({ width: 480, height: 270, fps: 24, duration: 10, clips: [
    { kind: 'video', file: 'a.mp4', start: 0, duration: 5, trimStart: 1, speed: 2, volume: 1, layer: 0 },
    { kind: 'image', file: 'b.png', start: 2, duration: 3, trimStart: 0, speed: 1, volume: 1, layer: 1, opacity: 50 },
  ] }, 'o.mp4', 'g.txt');
  assert.match(graph, /trim=start=1.0000:duration=10.0000/); assert.match(graph, /setpts=PTS\/2/);
  assert.match(graph, /colorchannelmixer=aa=0.500/); assert.match(graph, /anullsrc/);
  assert.ok(graph.indexOf('[o0]') < graph.indexOf('[o1]'));
});

test('export a 1-minute film: cuts, trim, speed, overlay, mute; right length, size, audio present', { timeout: 240000 }, async () => {
  const store = createDriftboardEditor(); syncAssets(store, src);
  appendToTimeline(store, src.slice(0, 12).map((a) => a.id));
  let clips = selectClips(getState(store));
  // cut 2 s off the end of clip 2 (split then delete second half)
  const c2 = clips.find((c) => c.assetId === 'vid2' && c.type === 'video')!;
  edit(store, (s) => A.splitClipsAtTime(s, [c2.id], c2.startTime + 3));
  const tail = selectClips(getState(store)).find((c) => c.assetId === 'vid2' && c.type === 'video' && c.startTime > c2.startTime)!;
  edit(store, (s) => A.deleteClips(s, withLinked(tail)));
  // ripple the rest left to close the gap: move every later clip by -2
  const after = selectClips(getState(store)).filter((c) => c.startTime >= c2.startTime + 4.99).map((c) => c.id);
  for (const id of after) edit(store, (s) => A.setClipStartTime(s, id, selectClips(s).find((c) => c.id === id)!.startTime - 2));
  // overlay a half-transparent still on V2 from 10 s to 14 s
  placeAsset(store, 'still', 1, 10);
  const stillClip = selectClips(getState(store)).find((c) => c.assetId === 'still')!;
  edit(store, (s) => A.setClipDuration(s, stillClip.id, 4));
  edit(store, (s) => A.setClipOpacity(s, stillClip.id, 50));
  const total = timelineEnd(getState(store));
  assert.ok(Math.abs(total - 58) < 0.05, `timeline length ${total}`);

  const plan = buildRenderPlan(getState(store), (id) => files.get(id));
  assert.equal(plan.width, 480); assert.equal(plan.height, 270);
  const out = path.join(dir, 'film.mp4');
  const progress: number[] = [];
  await renderTimeline(plan, out, { onProgress: (f) => progress.push(f) });
  const p = await probe(out);
  assert.ok(Math.abs(p.durationMs! / 1000 - 58) < 0.6, `output ${p.durationMs} ms`);
  assert.deepEqual([p.width, p.height, p.hasAudio, p.fps], [480, 270, true, 24]);
  assert.ok(progress.length > 3 && progress.at(-1)! > 0.9);
  const vd = spawnSync(ffmpegPath(), ['-hide_banner', '-i', out, '-af', 'volumedetect', '-vn', '-f', 'null', '-'], { encoding: 'utf8' });
  const mean = /mean_volume: (-?[\d.]+) dB/.exec(vd.stderr);
  assert.ok(mean && Number(mean[1]) > -40, `audio level ${mean?.[1]}`);
});

test('export errors are readable: empty timeline, missing file', () => {
  const store = createDriftboardEditor(); syncAssets(store, src);
  assert.throws(() => buildRenderPlan(getState(store), () => undefined), /empty/);
  appendToTimeline(store, ['vid0']);
  assert.throws(() => buildRenderPlan(getState(store), () => undefined), /Missing file/);
});

test('ripple delete closes the gap on every track and keeps audio in sync', () => {
  const store = createDriftboardEditor(); syncAssets(store, src); appendToTimeline(store, ['vid0', 'vid1', 'vid2']);
  const mid = selectClips(getState(store)).find((c) => c.assetId === 'vid1' && c.type === 'video')!;
  rippleDelete(store, [mid.id]);
  const clips = selectClips(getState(store));
  assert.equal(clips.length, 4);
  const v2 = clips.find((c) => c.assetId === 'vid2' && c.type === 'video')!, a2 = clips.find((c) => c.assetId === 'vid2' && c.type === 'audio')!;
  assert.deepEqual([v2.startTime, a2.startTime], [5, 5]);
  assert.ok(Math.abs(timelineEnd(getState(store)) - 10) < 0.01);
  store.getState().setStateWithoutHistory((s) => A.undo(s));
  assert.equal(selectClips(getState(store)).length, 6);
});

test('snap points include 0, playhead and clip edges but not the dragged clip', () => {
  const store = createDriftboardEditor(); syncAssets(store, src); appendToTimeline(store, ['vid0', 'vid1']);
  const c = selectClips(getState(store)).find((x) => x.assetId === 'vid1' && x.type === 'video')!;
  const pts = snapPoints(getState(store), new Set([c.id, ...(c.linkedClipIds ?? [])]), 3);
  assert.deepEqual([...new Set(pts)].sort((a, b) => a - b), [0, 3, 5]);
});

test('applyPicks: appends new picks in order, swaps a changed pick in place, leaves unchanged ones alone', () => {
  const store = createDriftboardEditor(); syncAssets(store, src);
  appendToTimeline(store, ['vid0', 'vid1']);                       // shot A uses vid0, shot B uses vid1
  const shots = [{ pick: 'vid0', takes: ['vid0', 'vid5'] }, { pick: 'vid1', takes: ['vid1'] }, { pick: 'vid7', takes: ['vid7', 'vid8'] }];
  assert.deepEqual(applyPicks(store, shots), { swapped: 0, appended: 1 });          // only shot C was missing
  assert.deepEqual(selectClips(getState(store)).filter((c) => c.type === 'video').map((c) => c.assetId), ['vid0', 'vid1', 'vid7']);
  shots[0]!.pick = 'vid5';                                          // the user picks another take for shot A
  assert.deepEqual(applyPicks(store, shots), { swapped: 1, appended: 0 });
  const v = selectClips(getState(store)).filter((c) => c.type === 'video').sort((a, b) => a.startTime - b.startTime);
  assert.deepEqual(v.map((c) => [c.assetId, c.startTime]), [['vid5', 0], ['vid1', 5], ['vid7', 10]]);
  assert.equal(selectClips(getState(store)).filter((c) => c.type === 'audio').length, 3);   // linked audio swapped too
  assert.deepEqual(applyPicks(store, shots), { swapped: 0, appended: 0 });          // idempotent
  store.getState().setStateWithoutHistory((s) => A.undo(s));                         // swap was one history step
  assert.equal(selectClips(getState(store)).filter((c) => c.assetId === 'vid5').length, 0);
});
