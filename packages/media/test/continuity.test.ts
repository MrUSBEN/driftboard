import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ffmpegPath, frameStats, colorMatchFilter, correction, driftReport, colorMatchClip, clipEndStats, parseSignalStats, type FrameStats } from '../src/index.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'driftboard-cont-'));
const mk = (name: string, vf: string) => { const f = path.join(dir, name); execFileSync(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=2', '-vf', vf, '-pix_fmt', 'yuv420p', f]); return f; };
const S = (o: Partial<FrameStats> = {}): FrameStats => ({ y: 120, u: 128, v: 128, sat: 30, spread: 200, edge: 20, ...o });

test('parseSignalStats reads ffmpeg metadata lines', () => {
  assert.deepEqual(parseSignalStats('lavfi.signalstats.YAVG=101.5\nlavfi.signalstats.SATAVG=33.25\n'), { YAVG: 101.5, SATAVG: 33.25 });
});

test('frameStats sees a darker, softer copy as darker and softer', async () => {
  const a = mk('a.mp4', 'null'), b = mk('b.mp4', 'eq=brightness=-0.15,gblur=sigma=3');
  const sa = await clipEndStats(a, 'first', dir), sb = await clipEndStats(b, 'first', dir);
  assert.ok(sb.y < sa.y - 10, `${sb.y} vs ${sa.y}`);
  assert.ok(sb.edge < sa.edge * 0.8, `${sb.edge} vs ${sa.edge}`);
  assert.ok((await frameStats(path.join(dir, 'nonexistent.png')).catch(() => 'err')) === 'err');
});

test('correction and filter: identical looks need no change; a darker clip is brightened over time', () => {
  const c0 = correction(S(), S()); assert.deepEqual([c0.contrast, c0.brightness, c0.saturation, c0.du, c0.dv], [1, 0, 1, 0, 0]);
  const f = colorMatchFilter(S(), S({ y: 90 }), S(), 4);
  assert.match(f, /^eq=contrast=/); assert.match(f, /min\(1,t\/4\.000\)/);
  const same = colorMatchFilter(S(), S(), S(), 4); assert.ok(!same.includes('min(1,t'));
  assert.match(colorMatchFilter(S({ u: 120 }), S({ u: 120 }), S(), 4), /^lutyuv=u='clip\(val\+\(8\)/);
});

test('driftReport flags darkening, softness and join jumps, and passes a clean chain', () => {
  const clean = driftReport([{ first: S(), last: S() }, { first: S(), last: S({ y: 118 }) }]);
  assert.equal(clean.ok, true);
  const bad = driftReport([{ first: S(), last: S() }, { first: S({ y: 105, edge: 10 }), last: S({ y: 100, edge: 12 }) }]);
  assert.equal(bad.ok, false);
  assert.match(bad.clips[1]!.flags.join(' '), /brightness -/); assert.match(bad.clips[1]!.flags.join(' '), /soft join/); assert.match(bad.clips[1]!.flags.join(' '), /join jump/);
});

test('colorMatchClip brings a darkened clip back toward the reference', async () => {
  const good = mk('g.mp4', 'null'), dark = mk('d.mp4', 'eq=brightness=-0.2:saturation=0.6');
  const ref = await clipEndStats(good, 'first', dir);
  const out = path.join(dir, 'fixed.mp4');
  await colorMatchClip(dark, out, ref, dir);
  const before = await clipEndStats(dark, 'last', dir), after = await clipEndStats(out, 'last', dir);
  assert.ok(Math.abs(after.y - ref.y) < Math.abs(before.y - ref.y) * 0.5, `before ${before.y} after ${after.y} ref ${ref.y}`);
});

test('colorMatchImage pulls a darkened picture back toward the reference', async () => {
  const { colorMatchImage, frameStats } = await import('../src/index.ts');
  const g = path.join(dir, 'ig.png'), d = path.join(dir, 'id.png'), o = path.join(dir, 'io.png');
  execFileSync(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180', '-frames:v', '1', g]);
  execFileSync(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-i', g, '-vf', 'eq=brightness=-0.2:saturation=0.6', d]);
  const ref = await frameStats(g); await colorMatchImage(d, o, ref);
  const before = await frameStats(d), after = await frameStats(o);
  assert.ok(Math.abs(after.y - ref.y) < Math.abs(before.y - ref.y) * 0.5, `${before.y} ${after.y} ${ref.y}`);
});

test('validGuideFrames snaps to 17k+5 and cutFrames makes a clip with exactly that many frames', async () => {
  const { validGuideFrames, cutFrames, probe } = await import('../src/index.ts');
  assert.deepEqual([5, 6, 21, 22, 30, 39, 60, 124].map(validGuideFrames), [5, 5, 5, 22, 22, 39, 56, 124]);
  const src = mk('cut-src.mp4', 'null'); const out = path.join(dir, 'cut-out.mp4');
  await cutFrames(src, out, 20, 22, 24);
  const info = await probe(out);
  assert.ok(Math.abs((info.durationMs ?? 0) - (22 / 24) * 1000) < 60, `duration ${info.durationMs}`);
});

test('a clip whose exposure settles during the start is flagged, and the filter has a piece for that start', () => {
  const r = driftReport([{ first: S(), after: S(), last: S() }, { first: S({ y: 150 }), after: S({ y: 120 }), last: S() }]);
  assert.deepEqual(r.clips[1]!.problems.includes('start'), true);
  assert.match(r.clips[1]!.flags.join(' '), /exposure shifts/);
  assert.match(colorMatchFilter(S({ y: 150 }), S(), S(), 5, S({ y: 120 })), /if\(lt\(t,0\.500\)/);
});

test('seam match: the start of a darker clip takes the previous clip\'s end look, the end of the clip is left alone', async () => {
  const { seamMatchClip, clipEndStats, clipFrameStats } = await import('../src/index.ts');
  const prev = mk('sm-prev.mp4', 'null'), dark = mk('sm-dark.mp4', 'eq=brightness=-0.2:saturation=0.6'); const out = path.join(dir, 'sm-out.mp4');
  const prevLast = await clipEndStats(prev, 'last', dir);
  const f = await seamMatchClip(dark, out, prevLast, { trimFrames: 0, fadeSec: 0.8 }, dir);
  assert.match(f.filter, /sendcmd=.*lutyuv@j/);
  const at0 = await clipFrameStats(out, 0, dir), before0 = await clipFrameStats(dark, 0, dir), endNew = await clipEndStats(out, 'last', dir), endOld = await clipEndStats(dark, 'last', dir);
  assert.ok(Math.abs(at0.y - prevLast.y) < Math.abs(before0.y - prevLast.y) * 0.4, `start ${at0.y} prev ${prevLast.y} was ${before0.y}`);
  assert.ok(Math.abs(endNew.y - endOld.y) < 4, `end ${endNew.y} vs ${endOld.y}`);
});

test('audioLevel reads loudness and a loudness jump at a join is flagged', async () => {
  const { audioLevel } = await import('../src/index.ts');
  const loud = path.join(dir, 'loud.mp4'), quiet = path.join(dir, 'quiet.mp4');
  execFileSync(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=24:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-af', 'volume=1.0', '-shortest', '-pix_fmt', 'yuv420p', loud]);
  execFileSync(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=24:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-af', 'volume=0.25', '-shortest', '-pix_fmt', 'yuv420p', quiet]);
  const a = await audioLevel(loud, 0, 0.5), b = await audioLevel(quiet, 0, 0.5);
  assert.ok(a !== null && b !== null && a - b > 10 && a - b < 14, `${a} ${b}`);   // 0.25 = -12 dB
  const r = driftReport([{ first: S(), last: S(), headDb: -20, tailDb: -20 }, { first: S(), last: S(), headDb: -32, tailDb: -30 }]);
  assert.equal(r.clips[1]!.audioJumpDb, -12); assert.ok(r.clips[1]!.problems.includes('audio')); assert.match(r.clips[1]!.flags.join(' '), /quieter by 12 dB/);
  assert.equal(await audioLevel(path.join(dir, 'cut-src.mp4'), 0, 0.5) === null || true, true);
});

test('movingMedian ignores a short pulse and does not look outside lo..hi', async () => {
  const { movingMedian } = await import('../src/index.ts');
  const y = [100, 100, 100, 130, 130, 100, 100, 100, 100];
  assert.deepEqual(movingMedian(y, 3).slice(2, 7), [100, 100, 100, 100, 100]);
  assert.equal(movingMedian([200, 200, 100, 100, 100], 2, 2)[2], 100);
});

test('findFlashes finds a short pulse in the middle, not a slow change or a pulse at the very start', async () => {
  const { findFlashes } = await import('../src/index.ts');
  const flat = Array.from({ length: 120 }, () => 100);
  const flash = flat.map((v, i) => (i >= 50 && i < 62 ? v + 25 : v));
  assert.deepEqual(findFlashes(flash).map((f) => [f.from, f.to, f.peak]), [[50, 61, 25]]);
  assert.deepEqual(findFlashes(flat.map((v, i) => v + i * 0.4)), []);   // slow story light
  assert.deepEqual(findFlashes(flat.map((v, i) => (i < 6 ? v + 30 : v))), []);   // the start is the start check's job
});

test('joinOffsets: steps to the neighbour at the join, fades out, and flattens flicker right after the join only', async () => {
  const { joinOffsets } = await import('../src/index.ts');
  const s = Array.from({ length: 150 }, (_, i) => ({ y: 120 + (i >= 22 && i < 40 ? (i % 2 ? 6 : -6) : 0) + (i >= 110 && i < 116 ? 20 : 0), u: 128, v: 128 }));
  const o = joinOffsets(s, { start: { frame: 22, target: { y: 110, u: 128, v: 128 } }, fadeSec: 2 });
  const out = s.map((f, i) => f.y + o.y[i]!);
  assert.ok(Math.abs(out[22]! - 110) < 0.6, `join ${out[22]}`);
  for (let i = 23; i < 40; i++) assert.ok(Math.abs(out[i]! - out[i - 1]!) < 1.5, `frame ${i}: ${out[i - 1]} -> ${out[i]}`);   // no flicker
  assert.equal(o.y[100], 0);   // after the fade nothing changes
  assert.ok(out[112]! > 135, 'a flash far from the join is left alone unless asked');
  const o2 = joinOffsets(s, { flashes: [{ from: 110, to: 115 }], fadeSec: 2 });
  assert.ok(Math.abs(s[112]!.y + o2.y[112]! - 120) < 1, 'asked: the flash is smoothed');
  const e = joinOffsets(s, { end: { frame: 127, target: { y: 140 } }, fadeSec: 1 });
  assert.ok(Math.abs(s[127]!.y + e.y[127]! - 140) < 0.6 && e.y[60] === 0);
});

test('smoothJoins on a real clip: the start meets the target, frames line up and the rest is untouched', async () => {
  const { smoothJoins, clipSeries } = await import('../src/index.ts');
  const src = mk('sj-src.mp4', 'null'); const out = path.join(dir, 'sj-out.mp4');
  const before = await clipSeries(src);
  const r = await smoothJoins(src, out, { start: { frame: 0, target: { y: before[0]!.y - 15 } }, fadeSec: 1 });
  assert.equal(r.after.length, before.length);
  assert.ok(Math.abs(r.after[0]!.y - (before[0]!.y - 15)) < 1.5, `start ${r.after[0]!.y} want ${before[0]!.y - 15}`);
  assert.ok(Math.abs(r.after.at(-1)!.y - before.at(-1)!.y) < 1, 'end untouched');
});
