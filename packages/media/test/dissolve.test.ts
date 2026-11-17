import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ffmpegPath, renderTimeline, buildRenderArgs, frameStats, type RenderPlan } from '../src/index.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'driftboard-dis-'));
const mk = (name: string, color: string) => { const f = path.join(dir, name); execFileSync(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=24:d=2`, '-pix_fmt', 'yuv420p', f]); return f; };
const red = mk('r.mp4', 'red'), blue = mk('b.mp4', 'blue');
const plan = (d?: number): RenderPlan => ({ width: 320, height: 180, fps: 24, duration: 4, clips: [
  { kind: 'video', file: red, start: 0, duration: 2, trimStart: 0, speed: 1, volume: 1, layer: 0, ...(d ? { dissolveOut: d } : {}) },
  { kind: 'video', file: blue, start: 2, duration: 2, trimStart: 0, speed: 1, volume: 1, layer: 0, ...(d ? { dissolveIn: d } : {}) },
] });
const frameAtT = async (mp4: string, t: number) => { const png = path.join(dir, `f${t}.png`); execFileSync(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(t), '-i', mp4, '-frames:v', '1', png]); return frameStats(png); };

test('a cross-dissolve blends the two clips across the cut; a plain cut does not', async () => {
  assert.match(buildRenderArgs(plan(0.5), 'o.mp4', 'g.txt').graph, /tpad=stop_mode=clone:stop_duration=0\.5000/);
  assert.match(buildRenderArgs(plan(0.5), 'o.mp4', 'g.txt').graph, /fade=t=in:st=0:d=0\.5000:alpha=1/);
  const cut = path.join(dir, 'cut.mp4'), dis = path.join(dir, 'dis.mp4');
  await renderTimeline(plan(), cut); await renderTimeline(plan(0.5), dis);
  const redLook = await frameAtT(dis, 1.5), blueLook = await frameAtT(dis, 3), mid = await frameAtT(dis, 2.25);
  // mid-fade the frame is neither pure red nor pure blue: its blue chroma (U) lies between the two
  assert.ok(mid.u > redLook.u + 20 && mid.u < blueLook.u - 20, `u red ${redLook.u} mid ${mid.u} blue ${blueLook.u}`);
  const cutMid = await frameAtT(cut, 2.25);
  assert.ok(Math.abs(cutMid.u - blueLook.u) < 5, 'a plain cut is already pure blue after the cut');
});
