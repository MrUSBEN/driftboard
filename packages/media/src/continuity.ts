import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { ffmpegPath, probe, frameAt, lastFrame } from './index.ts';

/** What the drift check measures about one picture. y/u/v/sat are 0-255 averages, spread = bright minus dark level (contrast), edge = mean edge strength (a sharpness proxy). */
export interface FrameStats { y: number; u: number; v: number; sat: number; spread: number; edge: number }

function ff(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => execFile(ffmpegPath(), args, { timeout: 120_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
    resolve({ code: err ? 1 : 0, stdout, stderr })));
}

/** Read `key=value` metadata lines that ffmpeg's metadata=print writes. */
export function parseSignalStats(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of text.matchAll(/lavfi\.signalstats\.([A-Z]+)=([-\d.]+)/g)) out[m[1]!] = Number(m[2]);
  return out;
}

const statsOf = async (img: string, vf: string): Promise<Record<string, number>> => {
  const r = await ff(['-hide_banner', '-i', img, '-vf', `${vf},signalstats,metadata=print:file=-`, '-frames:v', '1', '-f', 'null', '-']);
  const s = parseSignalStats(r.stdout);
  if (r.code !== 0 || s.YAVG === undefined) throw new Error('Could not measure the picture: ' + r.stderr.split('\n').slice(-3).join(' ').trim());
  return s;
};

/** Brightness, colour, contrast and sharpness of a still picture. */
export async function frameStats(img: string): Promise<FrameStats> {
  const a = await statsOf(img, 'scale=640:-2');
  const e = await statsOf(img, 'scale=640:-2,format=gray,edgedetect=low=0.05:high=0.15');
  return { y: a.YAVG!, u: a.UAVG!, v: a.VAVG!, sat: a.SATAVG!, spread: (a.YHIGH ?? 235) - (a.YLOW ?? 16), edge: e.YAVG! };
}

/** The first or last frame of a clip, measured. */
export async function clipEndStats(clip: string, which: 'first' | 'last', tmpDir: string): Promise<FrameStats> {
  await fs.mkdir(tmpDir, { recursive: true });
  const png = path.join(tmpDir, `stat-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.png`);
  try {
    if (which === 'last') await lastFrame(clip, png); else await frameAt(clip, png, 0, 24);
    return await frameStats(png);
  } finally { await fs.rm(png, { force: true }); }
}

/** A frame some way into a clip, measured. Used to catch brightness or colour that settles during the first moments. */
export async function clipFrameStats(clip: string, frame: number, tmpDir: string): Promise<FrameStats> {
  await fs.mkdir(tmpDir, { recursive: true });
  const png = path.join(tmpDir, `stat-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.png`);
  try { await frameAt(clip, png, frame, 24); return await frameStats(png); } finally { await fs.rm(png, { force: true }); }
}
/** How many frames into a clip the "after the start" sample is taken. */
export const START_SAMPLE_FRAME = 12;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const r4 = (n: number) => Math.round(n * 10000) / 10000;

/** The brightness/contrast/saturation/chroma correction that takes a picture measured as `from` to look like `to`. */
export function correction(from: FrameStats, to: FrameStats) {
  const gain = clamp(to.spread / Math.max(1, from.spread), 0.75, 1.35);
  const bright = to.y / 255 - ((from.y / 255 - 0.5) * gain + 0.5);
  return { contrast: r4(gain), brightness: r4(clamp(bright, -0.3, 0.3)), saturation: r4(clamp(to.sat / Math.max(0.5, from.sat), 0.6, 1.7)), du: Math.round(clamp(to.u - from.u, -20, 20)), dv: Math.round(clamp(to.v - from.v, -20, 20)) };
}

/**
 * The ffmpeg filter that pulls a clip toward a reference look. The clip's start is corrected by what its first frame needs and its end
 * by what its last frame needs, blended over the clip's length, so drift that builds up inside a clip is undone too. Pure, so it is testable.
 */
export function colorMatchFilter(first: FrameStats, last: FrameStats, ref: FrameStats, durationSec: number, after?: FrameStats): string {
  const a = correction(first, ref), b = correction(last, ref), m = after ? correction(after, ref) : undefined;
  const d = Math.max(0.1, durationSec);
  const t1 = START_SAMPLE_FRAME / 24;
  // two straight pieces when a sample after the start is given (start -> that sample -> end), one piece otherwise
  const mix = (x: number, y: number, mid?: number) => {
    if (mid === undefined || d <= t1 + 0.2) return x === y ? String(x) : `${x}+(${r4(y - x)})*min(1,t/${d.toFixed(3)})`;
    return `if(lt(t,${t1.toFixed(3)}),${x}+(${r4(mid - x)})*t/${t1.toFixed(3)},${mid}+(${r4(y - mid)})*min(1,(t-${t1.toFixed(3)})/${(d - t1).toFixed(3)}))`;
  };
  const du = Math.round((a.du + b.du + (m?.du ?? 0)) / (m ? 3 : 2)), dv = Math.round((a.dv + b.dv + (m?.dv ?? 0)) / (m ? 3 : 2));
  const eq = `eq=contrast='${mix(a.contrast, b.contrast, m?.contrast)}':brightness='${mix(a.brightness, b.brightness, m?.brightness)}':saturation='${mix(a.saturation, b.saturation, m?.saturation)}':eval=frame`;
  return du || dv ? `lutyuv=u='clip(val+(${du}),0,255)':v='clip(val+(${dv}),0,255)',${eq}` : eq;
}

/** Write a colour-matched copy of a clip (the original stays). `ref` is the look to match, normally the first clip's first frame. */
export async function colorMatchClip(src: string, dest: string, ref: FrameStats, tmpDir: string): Promise<{ filter: string }> {
  const info = await probe(src);
  const last = await clipEndStats(src, 'last', tmpDir);
  const secs = (info.durationMs ?? 5000) / 1000;
  const after = secs > START_SAMPLE_FRAME / 24 + 0.5 ? await clipFrameStats(src, START_SAMPLE_FRAME, tmpDir) : undefined;
  // the first frame is often a flicker or a held frame: the start is judged half a second in
  const first = after ?? await clipEndStats(src, 'first', tmpDir);
  const filter = colorMatchFilter(first, last, ref, secs);
  const tmp = `${dest}.${process.pid}.tmp${path.extname(dest)}`;
  const r = await ff(['-hide_banner', '-y', '-i', src, '-vf', filter, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', tmp]);
  if (r.code !== 0) { await fs.rm(tmp, { force: true }); throw new Error('Colour match failed: ' + r.stderr.split('\n').slice(-3).join(' ').trim()); }
  await fs.rename(tmp, dest);
  return { filter };
}

/** Mean loudness in dB of a stretch of a clip's sound (start and length in seconds), or null when it has none or is silent. */
export async function audioLevel(clip: string, startSec: number, lenSec: number): Promise<number | null> {
  const r = await ff(['-hide_banner', '-ss', String(Math.max(0, startSec)), '-t', String(lenSec), '-i', clip, '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(r.stderr);
  return m ? Number(m[1]) : null;
}
/** Length of the stretch compared at a join, seconds. */
export const AUDIO_PROBE_S = 0.5;

export interface ClipDrift { index: number; first: FrameStats; last: FrameStats; brightnessPct: number; saturationPct: number; sharpnessPct: number; seamBrightness?: number; seamColor?: number; /** seamSharpness: edge strength of this clip's first frame against the previous clip's last frame, in percent (a soft join shows as a big negative) */ seamSharpness?: number; /** brightness change from the first frame to a frame a moment later, in percent: exposure that settles during the start */ startShiftPct?: number; /** what is wrong, for choosing a fix */ /** loudness change at the join (this clip's start minus the previous clip's end), dB */ audioJumpDb?: number; /** short brightness pulses inside the clip (frame numbers) */ flashes?: { from: number; to: number; peak: number }[]; problems: ('drift' | 'start' | 'join' | 'soft' | 'audio' | 'flash')[]; flags: string[] }
export interface DriftReport { clips: ClipDrift[]; worst: string; ok: boolean }

/** Thresholds for "visible": brightness and saturation off by more than 8 % of the first clip, a seam jump above 6 levels of 255, a join that loses more than 35 % of the edge strength. Sharpness is only judged at joins, never against clip 1: different scenes and camera moves have different edge content, so that comparison would flag everything. */
export const DRIFT_LIMITS = { audioJumpDb: 3, startShiftPct: 8, brightnessPct: 8, saturationPct: 8, seamSharpnessPct: 35, seamLevels: 6, seamChroma: 5 };

/** Compare every clip with the first one and every join with its neighbour. Pure: takes measured stats. */
export function driftReport(ends: { first: FrameStats; after?: FrameStats; last: FrameStats; headDb?: number | null; tailDb?: number | null; flashes?: { from: number; to: number; peak: number }[] }[]): DriftReport {
  // clip 1's look half a second in: its very first frame can be a flicker or still settling
  const ref = ends[0]?.after ?? ends[0]?.first;
  const clips: ClipDrift[] = ends.map((e, i) => {
    const pct = (v: number, base: number) => Math.round(((v - base) / Math.max(1e-6, base)) * 1000) / 10;
    const c: ClipDrift = { index: i + 1, first: e.first, last: e.last, brightnessPct: ref ? pct(e.last.y, ref.y) : 0, saturationPct: ref ? pct(e.last.sat, ref.sat) : 0, sharpnessPct: ref ? pct(e.last.edge, ref.edge) : 0, problems: [], flags: [] };
    if (e.after) c.startShiftPct = pct(e.after.y, e.first.y);
    const pv = ends[i - 1];
    if (pv && typeof e.headDb === 'number' && typeof pv.tailDb === 'number') {
      c.audioJumpDb = Math.round((e.headDb - pv.tailDb) * 10) / 10;
      if (Math.abs(c.audioJumpDb) > DRIFT_LIMITS.audioJumpDb) { c.flags.push(`sound ${c.audioJumpDb > 0 ? 'louder' : 'quieter'} by ${Math.abs(c.audioJumpDb)} dB at the join`); c.problems.push('audio'); }
    }
    const prev = ends[i - 1];
    if (prev) { c.seamSharpness = pct(e.first.edge, prev.last.edge); c.seamBrightness = Math.round((e.first.y - prev.last.y) * 10) / 10; c.seamColor = Math.round(Math.hypot(e.first.u - prev.last.u, e.first.v - prev.last.v) * 10) / 10; }
    if (c.startShiftPct !== undefined && Math.abs(c.startShiftPct) > DRIFT_LIMITS.startShiftPct) { c.flags.push(`exposure shifts ${c.startShiftPct > 0 ? '+' : ''}${c.startShiftPct}% during the first half second`); c.problems.push('start'); }
    if (e.flashes?.length) { c.flashes = e.flashes; c.flags.push(`${e.flashes.length === 1 ? 'a flash' : e.flashes.length + ' flashes'} inside the clip (${e.flashes.map((f) => `${(f.from / 24).toFixed(1)} s, ${f.peak > 0 ? '+' : ''}${f.peak}`).join('; ')})`); c.problems.push('flash'); }
    if (i > 0) {   // clip 1 is the reference: its own light changes are not drift
      if (Math.abs(c.brightnessPct) > DRIFT_LIMITS.brightnessPct) c.flags.push(`brightness ${c.brightnessPct > 0 ? '+' : ''}${c.brightnessPct}%`);
      if (Math.abs(c.saturationPct) > DRIFT_LIMITS.saturationPct) c.flags.push(`colour saturation ${c.saturationPct > 0 ? '+' : ''}${c.saturationPct}%`);
      if (Math.abs(c.brightnessPct) > DRIFT_LIMITS.brightnessPct || Math.abs(c.saturationPct) > DRIFT_LIMITS.saturationPct) c.problems.push('drift');
    }
    if (c.seamSharpness !== undefined && c.seamSharpness < -DRIFT_LIMITS.seamSharpnessPct) { c.flags.push(`soft join (${c.seamSharpness}% edge strength)`); c.problems.push('soft'); }
    if (c.seamBrightness !== undefined && Math.abs(c.seamBrightness) > DRIFT_LIMITS.seamLevels) { c.flags.push(`join jump in brightness ${c.seamBrightness}`); c.problems.push('join'); }
    if (c.seamColor !== undefined && c.seamColor > DRIFT_LIMITS.seamChroma) { c.flags.push(`join jump in colour ${c.seamColor}`); if (!c.problems.includes('join')) c.problems.push('join'); }
    return c;
  });
  const bad = clips.filter((c) => c.flags.length);
  return { clips, ok: !bad.length, worst: bad.length ? `clip ${bad[0]!.index}: ${bad[0]!.flags.join(', ')}` : 'no visible drift' };
}

/** Measure every clip's first and last frame, then build the report. */
export async function analyzeChain(clips: string[], tmpDir: string): Promise<DriftReport> {
  const ends: { first: FrameStats; after?: FrameStats; last: FrameStats; headDb?: number | null; tailDb?: number | null; flashes?: { from: number; to: number; peak: number }[] }[] = [];
  for (const c of clips) {
    const secs = ((await probe(c)).durationMs ?? 0) / 1000;
    const flashes = findFlashes((await clipSeries(c)).map((f) => f.y));
    ends.push({ flashes, first: await clipEndStats(c, 'first', tmpDir), after: secs > START_SAMPLE_FRAME / 24 + 0.5 ? await clipFrameStats(c, START_SAMPLE_FRAME, tmpDir) : undefined, last: await clipEndStats(c, 'last', tmpDir), headDb: await audioLevel(c, 0, AUDIO_PROBE_S), tailDb: await audioLevel(c, Math.max(0, secs - AUDIO_PROBE_S), AUDIO_PROBE_S) });
  }
  return driftReport(ends);
}

/** A colour-matched copy of a still picture (used on the frame a clip continues from, so drift does not compound). The original stays. */
export async function colorMatchImage(src: string, dest: string, ref: FrameStats): Promise<{ filter: string }> {
  const now = await frameStats(src);
  const c = correction(now, ref);
  const eq = `eq=contrast=${c.contrast}:brightness=${c.brightness}:saturation=${c.saturation}`;
  const filter = c.du || c.dv ? `lutyuv=u='clip(val+(${c.du}),0,255)':v='clip(val+(${c.dv}),0,255)',${eq}` : eq;
  const r = await ff(['-hide_banner', '-y', '-i', src, '-vf', filter, '-frames:v', '1', '-update', '1', dest]);
  if (r.code !== 0) throw new Error('Colour match failed: ' + r.stderr.split('\n').slice(-3).join(' ').trim());
  return { filter };
}

/** The frame counts the H3 model accepts for an anchored clip: 5, 22, 39, ... (17k + 5). Snaps a wish down to the nearest valid count (at least 5). */
export const validGuideFrames = (n: number) => Math.max(5, 5 + Math.floor((Math.max(5, n) - 5) / 17) * 17);

/** Cut exactly `frames` frames (and their sound) out of a clip, starting at frame `start`, into a new file. Frame accurate. */
export async function cutFrames(src: string, dest: string, start: number, frames: number, fps = 24): Promise<void> {
  const t0 = start / fps, d = frames / fps;
  const tmp = `${dest}.${process.pid}.tmp${path.extname(dest)}`;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const info = await probe(src);
  const args = ['-hide_banner', '-y', '-i', src, '-vf', `select='between(n,${start},${start + frames - 1})',setpts=N/${fps}/TB`, '-frames:v', String(frames), '-r', String(fps),
    ...(info.hasAudio ? ['-af', `atrim=start=${t0.toFixed(5)}:duration=${d.toFixed(5)},asetpts=PTS-STARTPTS`] : ['-an']),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '12', '-pix_fmt', 'yuv420p', ...(info.hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : []), '-movflags', '+faststart', tmp];
  const r = await ff(args);
  if (r.code !== 0) { await fs.rm(tmp, { force: true }); throw new Error('Cutting frames failed: ' + r.stderr.split('\n').slice(-3).join(' ').trim()); }
  await fs.rename(tmp, dest);
}

/**
 * Seam match: the filter that makes a clip START where the previous clip ENDED. `clipAt` is the clip measured at the frame where it begins in the film
 * (after the repeated held frames), `prevLast` the previous clip's last frame. The correction is full until `trimSec` and fades to nothing over `fadeSec`,
 * so the rest of the clip is untouched and free to follow the story (darker, lighter) while the join shows no step. Pure.
 */
export function seamFilter(clipAt: FrameStats, prevLast: FrameStats, trimSec: number, fadeSec: number): string {
  const c = correction(clipAt, prevLast);
  const f = Math.max(0.2, fadeSec);
  const w = (v: string) => `if(lt(${v},${trimSec.toFixed(3)}),1,max(0,1-(${v}-${trimSec.toFixed(3)})/${f.toFixed(3)}))`;
  const eq = `eq=contrast='1+(${c.contrast - 1})*${w('t')}':brightness='${c.brightness}*${w('t')}':saturation='1+(${c.saturation - 1})*${w('t')}':eval=frame`;
  const chroma = c.du || c.dv ? `,geq=lum='lum(X,Y)':cb='cb(X,Y)+${c.du}*${w('T')}':cr='cr(X,Y)+${c.dv}*${w('T')}'` : '';
  return eq + chroma + ',format=yuv420p';
}

/** A copy of a clip whose start is matched to the end of the previous clip. The original stays. Now per frame (see smoothJoins): it also takes out the exposure flicker right after the join. */
export async function seamMatchClip(src: string, dest: string, prevLast: FrameStats, opts: { trimFrames: number; fadeSec: number }, _tmpDir?: string): Promise<{ filter: string }> {
  return smoothJoins(src, dest, { start: { frame: opts.trimFrames, target: prevLast }, fadeSec: opts.fadeSec });
}

/* ---------- per-frame join smoothing ---------- */

/** Average brightness (y) and colour (u, v) of one frame, 0-255. */
export interface FrameLevel { y: number; u: number; v: number }

/** Every frame of a clip measured (small scale, one ffmpeg pass). */
export async function clipSeries(clip: string): Promise<FrameLevel[]> {
  const r = await ff(['-hide_banner', '-i', clip, '-an', '-vf', 'scale=320:-2,signalstats,metadata=print:file=-', '-f', 'null', '-']);
  const out: FrameLevel[] = [];
  let cur: Partial<FrameLevel> = {};
  for (const m of r.stdout.matchAll(/lavfi\.signalstats\.(YAVG|UAVG|VAVG)=([-\d.]+)/g)) {
    const k = m[1] === 'YAVG' ? 'y' : m[1] === 'UAVG' ? 'u' : 'v';
    cur[k] = Number(m[2]);
    if (cur.y !== undefined && cur.u !== undefined && cur.v !== undefined) { out.push(cur as FrameLevel); cur = {}; }
  }
  if (!out.length) throw new Error('Could not measure the clip: ' + r.stderr.split('\n').slice(-3).join(' ').trim());
  return out;
}

/** Moving median of `a` (window 2*half+1), only looking at indices lo..hi so frames outside (held frames) do not leak in. Pure. */
export function movingMedian(a: number[], half: number, lo = 0, hi = a.length - 1): number[] {
  // near lo/hi the window slides inward instead of shrinking, so a join is judged on as many frames as the middle of the clip
  return a.map((_, i) => {
    let from = i - half, to = i + half;
    if (from < lo) { to = Math.min(hi, to + (lo - from)); from = lo; }
    if (to > hi) { from = Math.max(lo, from - (to - hi)); to = hi; }
    const w = a.slice(from, to + 1).sort((x, y) => x - y);
    return w.length ? w[w.length >> 1]! : a[i]!;
  });
}

/** Window of the median used to tell flicker and flashes from real light changes: changes slower than ~1.3 s pass through untouched. */
export const SMOOTH_HALF = 15;
export const FLASH_LIMITS = { levels: 10, edge: 5, maxFrames: 30 };

/** Short brightness pulses inside a clip (a flash or a flicker), found against the moving median. Runs that touch the clip's ends are left to the start/join checks. Pure. */
export function findFlashes(y: number[], lo = 0, hi = y.length - 1): { from: number; to: number; peak: number }[] {
  const m = movingMedian(y, SMOOTH_HALF, lo, hi);
  const out: { from: number; to: number; peak: number }[] = [];
  let i = lo;
  while (i <= hi) {
    if (Math.abs(y[i]! - m[i]!) <= FLASH_LIMITS.edge) { i++; continue; }
    let j = i, peak = 0;
    while (j <= hi && Math.abs(y[j]! - m[j]!) > FLASH_LIMITS.edge) { const d = y[j]! - m[j]!; if (Math.abs(d) > Math.abs(peak)) peak = d; j++; }
    const len = j - i;
    if (i > lo + 1 && j <= hi - 1 && len <= FLASH_LIMITS.maxFrames && Math.abs(peak) >= FLASH_LIMITS.levels) out.push({ from: i, to: j - 1, peak: Math.round(peak * 10) / 10 });
    i = j;
  }
  return out;
}

export interface JoinPlan {
  /** the first frame the film shows (after held frames) and the look it must start with (the previous clip's last frame) */
  start?: { frame: number; target: Pick<FrameLevel, 'y'> & Partial<FrameLevel> };
  /** the last frame the film shows (before held frames at the end) and the look it must arrive at (the next clip's first frame) */
  end?: { frame: number; target: Pick<FrameLevel, 'y'> & Partial<FrameLevel> };
  /** how long the correction takes to fade out after the join, seconds */
  fadeSec: number;
  /** also smooth these frame ranges (flashes the user chose to remove) */
  flashes?: { from: number; to: number }[];
  fps?: number;
}

/**
 * Per-frame corrections (added levels, 0-255 scale) for a clip. Near a join: the level steps to the neighbour's and fades to nothing,
 * and fast swings (flicker) are pulled onto the moving median, so the first second after a cut is steady while slower story light stays. Pure.
 */
export function joinOffsets(s: FrameLevel[], plan: JoinPlan): { y: number[]; u: number[]; v: number[] } {
  const n = s.length, fps = plan.fps ?? 24, F = Math.max(6, Math.round(plan.fadeSec * fps));
  const lo = Math.min(n - 1, Math.max(0, plan.start?.frame ?? 0)), hi = Math.max(lo, Math.min(n - 1, plan.end?.frame ?? n - 1));
  const ys = s.map((f) => f.y), us = s.map((f) => f.u), vs = s.map((f) => f.v);
  const m = movingMedian(ys, SMOOTH_HALF, lo, hi), mu = movingMedian(us, SMOOTH_HALF, lo, hi), mv = movingMedian(vs, SMOOTH_HALF, lo, hi);
  const oy = new Array<number>(n).fill(0), ou = new Array<number>(n).fill(0), ov = new Array<number>(n).fill(0);
  const steady = new Array<number>(n).fill(0);   // 0..1: how strongly a frame is pulled onto the median
  const lin = (x: number) => Math.min(1, Math.max(0, x));
  if (plan.start) {
    const t = plan.start.target, dy = t.y - m[lo]!, du = t.u !== undefined ? t.u - mu[lo]! : 0, dv = t.v !== undefined ? t.v - mv[lo]! : 0;
    for (let i = 0; i < n; i++) {
      const w = lin(1 - (Math.max(i, lo) - lo) / F);
      oy[i]! += dy * w; ou[i]! += du * w; ov[i]! += dv * w;
      steady[i] = Math.max(steady[i]!, i <= lo + F / 2 ? 1 : lin(1 - (i - lo - F / 2) / (F / 2)));
    }
  }
  if (plan.end) {
    const t = plan.end.target, dy = t.y - m[hi]!, du = t.u !== undefined ? t.u - mu[hi]! : 0, dv = t.v !== undefined ? t.v - mv[hi]! : 0;
    for (let i = 0; i < n; i++) {
      const w = lin(1 - (hi - Math.min(i, hi)) / F);
      oy[i]! += dy * w; ou[i]! += du * w; ov[i]! += dv * w;
      steady[i] = Math.max(steady[i]!, i >= hi - F / 2 ? 1 : lin(1 - (hi - F / 2 - i) / (F / 2)));
    }
  }
  for (const f of plan.flashes ?? []) for (let i = Math.max(lo, f.from - 3); i <= Math.min(hi, f.to + 3); i++) steady[i] = Math.max(steady[i]!, i < f.from ? (i - f.from + 4) / 4 : i > f.to ? (f.to + 4 - i) / 4 : 1);
  const cl = (x: number, lim: number) => Math.round(Math.min(lim, Math.max(-lim, x)) * 10) / 10;
  return {
    y: oy.map((o, i) => cl(o + steady[i]! * (m[Math.min(hi, Math.max(lo, i))]! - ys[i]!) * (i >= lo && i <= hi ? 1 : 0), 60)),
    u: ou.map((o) => cl(o, 20)), v: ov.map((o) => cl(o, 20)),
  };
}

/**
 * The ffmpeg filter that adds per-frame levels: sendcmd sets lutyuv's expressions frame by frame (lutyuv is exact; eq's brightness is not
 * linear). Frames are renumbered first: generated clips can have uneven timestamps, and the commands must land on frame numbers. Pure.
 */
export function offsetsFilter(off: { y: number[]; u: number[]; v: number[] }, fps = 24): string {
  const cmds: string[] = [];
  const lastV = { y: NaN, u: NaN, v: NaN };
  const ex = (x: number) => (x === 0 ? 'val' : x > 0 ? `val+${x}` : `val${x}`);
  for (let i = 0; i < off.y.length; i++) {
    const at = Math.max(0, (i - 0.25) / fps).toFixed(4);
    for (const k of ['y', 'u', 'v'] as const) {
      const x = Math.round((off[k][i] ?? 0) * 10) / 10;
      if (x !== lastV[k]) { cmds.push(`${at} lutyuv@j ${k} ${ex(x)}`); lastV[k] = x; }
    }
  }
  return `setpts=N/(${fps}*TB),sendcmd=c='${cmds.join(';')}',lutyuv@j=y=val:u=val:v=val,format=yuv420p`;
}

async function encodeWith(src: string, dest: string, filter: string): Promise<void> {
  const tmp = `${dest}.${process.pid}.tmp${path.extname(dest)}`;
  const r = await ff(['-hide_banner', '-y', '-i', src, '-vf', filter, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', tmp]);
  if (r.code !== 0) { await fs.rm(tmp, { force: true }); throw new Error('Smoothing the join failed: ' + r.stderr.split('\n').slice(-3).join(' ').trim()); }
  await fs.rename(tmp, dest);
}

/**
 * A copy of a clip with its joins smoothed (see joinOffsets). ffmpeg's brightness is not exactly linear (bright areas clip), so the result is
 * measured and the remaining error corrected in a second pass. The original stays.
 */
export async function smoothJoins(src: string, dest: string, plan: JoinPlan): Promise<{ filter: string; before: FrameLevel[]; after: FrameLevel[] }> {
  const fps = plan.fps ?? 24;
  const before = await clipSeries(src);
  const off = joinOffsets(before, plan);
  const want = before.map((f, i) => f.y + off.y[i]!);
  let filter = offsetsFilter(off, fps);
  await encodeWith(src, dest, filter);
  let after = await clipSeries(dest);
  const err = want.map((w, i) => w - (after[i]?.y ?? w));
  if (err.some((e) => Math.abs(e) > 1.5)) {
    const off2 = { ...off, y: off.y.map((o, i) => Math.round(Math.min(80, Math.max(-80, o + err[i]! * 1.1)) * 10) / 10) };
    filter = offsetsFilter(off2, fps);
    await encodeWith(src, dest, filter);
    after = await clipSeries(dest);
  }
  return { filter, before, after };
}
