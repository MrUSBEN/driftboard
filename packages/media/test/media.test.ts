import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ffmpegPath, probe, makePoster, lastFrame, parseProbe, frameAt, makeProxy } from '../src/index.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'driftboard-media-'));
const vid = path.join(dir, 'v.mp4'), img = path.join(dir, 'i.png');
execFileSync(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-shortest', '-pix_fmt', 'yuv420p', vid]);
execFileSync(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360', '-frames:v', '1', img]);

test('probe video: size, fps, duration, audio', async () => {
  const p = await probe(vid);
  assert.deepEqual([p.width, p.height, p.fps, p.hasAudio, p.hasVideo], [320, 180, 24, true, true]);
  assert.ok(Math.abs(p.durationMs! - 2000) < 100);
});
test('probe image: size, no duration, no audio', async () => {
  const p = await probe(img);
  assert.deepEqual([p.width, p.height, p.hasAudio], [640, 360, false]);
});
test('probe garbage file does not throw', async () => {
  const p = await probe(path.join(dir, 'missing.bin'));
  assert.equal(p.hasVideo, false);
});
test('parseProbe handles the real H3 stream line', () => {
  const t = 'Duration: 00:00:02.33, start: 0.000000\n  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 736x416, 2371 kb/s, 24 fps, 24 tbr, 12288 tbn (default)\n  Stream #0:1[0x2](und): Audio: aac (LC), 32000 Hz, stereo, fltp, 126 kb/s';
  const p = parseProbe(t);
  assert.deepEqual([p.width, p.height, p.fps, p.hasAudio, p.durationMs], [736, 416, 24, true, 2330]);
});
test('poster is a small jpeg for both image and video', async () => {
  await makePoster(vid, path.join(dir, 'p1.jpg'), 160); await makePoster(img, path.join(dir, 'p2.jpg'), 160);
  const b = await probe(path.join(dir, 'p2.jpg'));
  assert.equal(b.width, 160); assert.ok(statSync(path.join(dir, 'p1.jpg')).size > 500);
  await assert.rejects(makePoster(path.join(dir, 'nope.mp4'), path.join(dir, 'p3.jpg')), /Poster failed/);
});
test('last frame png has the video size', async () => {
  await lastFrame(vid, path.join(dir, 'last.png'));
  const b = await probe(path.join(dir, 'last.png'));
  assert.deepEqual([b.width, b.height], [320, 180]);
});

test('frameAt returns the requested frame (burned-in frame counter differs per frame)', async () => {
  const a = path.join(dir, 'f10.png'), b = path.join(dir, 'f11.png'), c = path.join(dir, 'f10b.png');
  await frameAt(vid, a, 10, 24); await frameAt(vid, b, 11, 24); await frameAt(vid, c, 10, 24);
  const { readFileSync } = await import('node:fs');
  assert.notDeepEqual(readFileSync(a), readFileSync(b));      // neighbouring frames differ
  assert.deepEqual(readFileSync(a), readFileSync(c));         // same frame, same bytes
  await assert.rejects(frameAt(vid, path.join(dir, 'x.png'), 9999, 24), /Frame 9999 failed/);
});
test('proxy: short GOP, 480p max, keeps audio, same duration', async () => {
  const big = path.join(dir, 'big.mp4');
  execFileSync(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=24:duration=2', '-f', 'lavfi', '-i', 'sine=duration=2', '-shortest', '-pix_fmt', 'yuv420p', big]);
  await makeProxy(big, path.join(dir, 'proxy.mp4'));
  const p = await probe(path.join(dir, 'proxy.mp4'));
  assert.deepEqual([p.height, p.fps, p.hasAudio], [480, 24, true]); assert.ok(Math.abs(p.durationMs! - 2000) < 150);
});

test('poster of a sound file is its waveform, not a failure', async () => {
  const wav = path.join(dir, 'tone.wav'), out = path.join(dir, 'tone.jpg');
  execFileSync(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', wav]);
  await makePoster(wav, out);
  assert.ok(statSync(out).size > 1000);
});
