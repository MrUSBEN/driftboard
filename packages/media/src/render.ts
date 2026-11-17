import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { ffmpegPath } from './index.ts';

export interface RenderClip {
  kind: 'video' | 'image' | 'audio';
  file: string;
  /** timeline position and length, seconds */
  start: number;
  duration: number;
  /** where in the source this clip starts, seconds */
  trimStart: number;
  speed: number;
  /** audio gain, 1 = unchanged */
  volume: number;
  /** stacking order: higher is on top (video only) */
  layer: number;
  opacity?: number;
  reversed?: boolean;
  flipH?: boolean;
  flipV?: boolean;
  /** cross-dissolve at the start of this clip (it fades in over the clip before it), seconds */
  dissolveIn?: number;
  /** cross-dissolve at the end of this clip: its last frame is held this long so the next clip can fade in over it, seconds */
  dissolveOut?: number;
}
export interface RenderPlan {
  width: number; height: number; fps: number;
  /** total length, seconds */
  duration: number;
  clips: RenderClip[];
  /** short fade at the edges of every audio clip so cuts do not click or dip; seconds */
  audioFade?: number;
  crf?: number;
  /** x264 speed preset (slower = smaller file at the same quality) */
  preset?: string;
  /** audio bitrate, kbit/s */
  audioKbps?: number;
}

const f3 = (n: number) => n.toFixed(4);

/** atempo accepts 0.5-2 per stage; chain stages for other speeds. */
function atempoChain(speed: number): string[] {
  const out: string[] = []; let s = speed;
  while (s > 2) { out.push('atempo=2'); s /= 2; }
  while (s < 0.5) { out.push('atempo=0.5'); s /= 0.5; }
  if (Math.abs(s - 1) > 1e-6) out.push(`atempo=${s.toFixed(5)}`);
  return out;
}

/** Build the ffmpeg arguments and filter graph for a plan. Pure; tested separately from running ffmpeg. */
export function buildRenderArgs(plan: RenderPlan, out: string, graphFile: string): { args: string[]; graph: string } {
  const { width: W, height: H, fps: F } = plan;
  const T = Math.max(0.1, plan.duration);
  const args: string[] = ['-hide_banner', '-y', '-nostdin', '-progress', 'pipe:1', '-nostats'];
  const inputs: { idx: number; clip: RenderClip }[] = [];
  plan.clips.forEach((c) => {
    if (c.kind === 'image') args.push('-loop', '1', '-framerate', String(F), '-t', f3(c.duration), '-i', c.file);
    else args.push('-i', c.file);
    inputs.push({ idx: inputs.length, clip: c });
  });
  const g: string[] = [`color=c=black:s=${W}x${H}:r=${F}:d=${f3(T)},format=yuv420p[base]`];
  let cur = 'base';
  const videos = inputs.filter((i) => i.clip.kind !== 'audio').sort((a, b) => a.clip.layer - b.clip.layer || a.clip.start - b.clip.start);
  videos.forEach(({ idx, clip: c }, n) => {
    const src = c.speed || 1;
    const chain: string[] = [];
    if (c.kind === 'video') chain.push(`trim=start=${f3(c.trimStart)}:duration=${f3(c.duration * src)}`, 'setpts=PTS-STARTPTS');
    else chain.push('setpts=PTS-STARTPTS');
    if (c.reversed) chain.push('reverse', 'setpts=PTS-STARTPTS');
    if (src !== 1) chain.push(`setpts=PTS/${src}`);
    chain.push(`fps=${F}`);
    if (c.flipH) chain.push('hflip');
    if (c.flipV) chain.push('vflip');
    chain.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease`, `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black`, 'setsar=1');
    const dIn = Math.max(0, c.dissolveIn ?? 0), dOut = Math.max(0, c.dissolveOut ?? 0);
    if (dOut > 0) chain.push(`tpad=stop_mode=clone:stop_duration=${f3(dOut)}`);
    const op = c.opacity ?? 100;
    chain.push(op < 100 || dIn > 0 ? 'format=yuva420p' : 'format=yuv420p');
    if (dIn > 0) chain.push(`fade=t=in:st=0:d=${f3(Math.min(dIn, c.duration))}:alpha=1`);
    if (op < 100) chain.push(`colorchannelmixer=aa=${(op / 100).toFixed(3)}`);
    chain.push(`setpts=PTS+${f3(c.start)}/TB`);
    g.push(`[${idx}:v]${chain.join(',')}[v${n}]`);
    const next = `o${n}`;
    g.push(`[${cur}][v${n}]overlay=eof_action=pass:enable='between(t,${f3(c.start)},${f3(c.start + c.duration + dOut)})',format=yuv420p[${next}]`);
    cur = next;
  });
  g.push(`[${cur}]trim=duration=${f3(T)},setpts=PTS-STARTPTS[vout]`);

  const fade = Math.min(plan.audioFade ?? 0.04, 0.5);
  const audios = inputs.filter((i) => i.clip.kind === 'audio');
  const labels: string[] = [];
  audios.forEach(({ idx, clip: c }, n) => {
    const chain = [`atrim=start=${f3(c.trimStart)}:duration=${f3(c.duration * (c.speed || 1))}`, 'asetpts=PTS-STARTPTS', ...atempoChain(c.speed || 1)];
    if (c.reversed) chain.push('areverse');
    chain.push('aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo');
    if (c.volume !== 1) chain.push(`volume=${c.volume.toFixed(4)}`);
    if (fade > 0 && c.duration > fade * 2) chain.push(`afade=t=in:d=${f3(fade)}`, `afade=t=out:st=${f3(c.duration - fade)}:d=${f3(fade)}`);
    const ms = Math.round(c.start * 1000);
    chain.push(`adelay=${ms}|${ms}`);
    g.push(`[${idx}:a]${chain.join(',')}[a${n}]`);
    labels.push(`[a${n}]`);
  });
  if (labels.length) g.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=longest,apad,atrim=duration=${f3(T)}[aout]`);
  else g.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${f3(T)}[aout]`);

  const graph = g.join(';\n');
  args.push('-filter_complex_script', graphFile, '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', plan.preset ?? 'medium', '-crf', String(plan.crf ?? 18), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', `${plan.audioKbps ?? 192}k`, '-movflags', '+faststart', '-t', f3(T), out);
  return { args, graph };
}

/** Run the export. Writes to a temp name then renames, so a cancelled export never leaves a broken file. */
export async function renderTimeline(plan: RenderPlan, out: string, opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {}): Promise<void> {
  await fs.mkdir(path.dirname(out), { recursive: true });
  const tmpOut = `${out}.${process.pid}.part.mp4`;
  const graphFile = `${out}.${process.pid}.graph.txt`;
  const { args, graph } = buildRenderArgs(plan, tmpOut, graphFile);
  await fs.writeFile(graphFile, graph);
  try {
    await new Promise<void>((resolve, reject) => {
      const p = spawn(ffmpegPath(), args, { windowsHide: true });
      let err = '', buf = '';
      p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
      p.stdout.on('data', (d) => {
        buf += d; let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
          if (m) opts.onProgress?.(Math.min(1, Number(m[1]) / 1e6 / plan.duration));
        }
      });
      opts.signal?.addEventListener('abort', () => { p.kill(); reject(new Error('Export cancelled')); });
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${err.split(String.fromCharCode(10)).slice(-6).join(' ')}`))));
    });
    await fs.rename(tmpOut, out);
  } finally {
    await fs.rm(tmpOut, { force: true }); await fs.rm(graphFile, { force: true });
  }
}
