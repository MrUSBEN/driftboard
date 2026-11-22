import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ffmpegPath, probe, cutMedia, atempoChain } from '../src/index.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'driftboard-cut-'));
const src = path.join(dir, 'src.mp4');
execFileSync(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-pix_fmt', 'yuv420p', '-shortest', src]);

test('atempoChain splits speeds outside 0.5-2 into stages', () => {
  assert.equal(atempoChain(1.5), 'atempo=1.5000');
  assert.equal(atempoChain(4), 'atempo=2.0000,atempo=2.0000');
  assert.equal(atempoChain(0.25), 'atempo=0.5000,atempo=0.5000');
});

test('cutMedia: picture + sound, picture only, sound only, and speed changes the length', async () => {
  const both = path.join(dir, 'both.mp4'), vid = path.join(dir, 'vid.mp4'), aud = path.join(dir, 'aud.wav'), fast = path.join(dir, 'fast.mp4');
  await cutMedia(src, both, { start: 1, end: 3, mode: 'both' });
  await cutMedia(src, vid, { start: 1, end: 3, mode: 'video' });
  await cutMedia(src, aud, { start: 1, end: 3, mode: 'audio' });
  await cutMedia(src, fast, { start: 0, end: 4, speed: 2, mode: 'both' });
  const [b, v, a, f] = await Promise.all([probe(both), probe(vid), probe(aud), probe(fast)]);
  assert.ok(Math.abs((b.durationMs ?? 0) - 2000) < 150 && b.hasAudio);
  assert.ok(!v.hasAudio && Math.abs((v.durationMs ?? 0) - 2000) < 150);
  assert.ok(Math.abs((a.durationMs ?? 0) - 2000) < 150);
  assert.ok(Math.abs((f.durationMs ?? 0) - 2000) < 200, `fast ${f.durationMs}`);
});
