import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

// import.meta.url is empty when bundled to CJS (Electron main), so fall back to __filename there.
const require = createRequire(import.meta.url ?? __filename);

/** ffmpeg binary. In a packaged app the file lives in app.asar.unpacked. Override with DRIFTBOARD_FFMPEG. */
export function ffmpegPath(): string {
  if (process.env.DRIFTBOARD_FFMPEG) return process.env.DRIFTBOARD_FFMPEG;
  const p = require('ffmpeg-static') as string;
  return p.replace('app.asar', 'app.asar.unpacked');
}

function run(args: string[], timeoutMs = 60_000): Promise<{ code: number; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    execFile(ffmpegPath(), args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0, stdout, stderr }));
  });
}

export interface ProbeResult { width?: number; height?: number; durationMs?: number; fps?: number; hasAudio: boolean; hasVideo: boolean; videoCodec?: string }

/** Read basic facts from `ffmpeg -i` output. No separate ffprobe binary needed. */
export async function probe(file: string): Promise<ProbeResult> {
  const { stderr } = await run(['-hide_banner', '-i', file]);
  return parseProbe(stderr);
}

export function parseProbe(text: string): ProbeResult {
  const r: ProbeResult = { hasAudio: /Stream #\d+:\d+.*: Audio:/.test(text), hasVideo: false };
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  if (d) r.durationMs = Math.round((Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3])) * 1000);
  const v = /Stream #\d+:\d+.*: Video: (\w+)[^\n]*?, (\d{2,5})x(\d{2,5})[^\n]*/.exec(text);
  if (v) {
    r.hasVideo = true; r.videoCodec = v[1]; r.width = Number(v[2]); r.height = Number(v[3]);
    const f = /(\d+(?:\.\d+)?) fps/.exec(v[0]);
    if (f) r.fps = Number(f[1]);
  }
  // still images are reported as 1-frame video; treat zero/N.A. duration as undefined
  if (r.durationMs === 0) delete r.durationMs;
  return r;
}

/** Small JPEG poster (max width) of an image or the first frame of a video. Written atomically. */
export async function makePoster(src: string, dest: string, maxWidth = 480): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp.jpg`;
  const info = await probe(src);
  // a sound file has no picture: its poster is the waveform
  const { code, stderr } = !info.hasVideo && info.hasAudio
    ? await run(['-hide_banner', '-y', '-i', src, '-filter_complex', `aformat=channel_layouts=mono,showwavespic=s=${maxWidth}x${Math.round(maxWidth * 0.5625)}:colors=0x7fd1a0,format=yuvj420p`, '-frames:v', '1', '-q:v', '4', tmp], 120_000)
    : await run(['-hide_banner', '-y', '-i', src, '-frames:v', '1', '-vf', `scale='min(${maxWidth},iw)':-2`, '-q:v', '4', tmp]);
  if (code !== 0) { await fs.rm(tmp, { force: true }); throw new Error(`Poster failed: ${stderr.split('\n').slice(-3).join(' ').trim()}`); }
  await fs.rename(tmp, dest);
}

/** Last frame as PNG (for Continue). Uses -sseof as proven in the join spike. */
export async function lastFrame(src: string, dest: string): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const { code, stderr } = await run(['-hide_banner', '-y', '-sseof', '-1', '-i', src, '-map', '0:v:0', '-update', '1', '-c:v', 'png', dest]);
  if (code !== 0) throw new Error(`Last frame failed: ${stderr.split('\n').slice(-3).join(' ').trim()}`);
}

/** Exact frame as PNG: frame number at a known fps (seeks to the middle of the frame, as the preview does). */
export async function frameAt(src: string, dest: string, frame: number, fps: number): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const t = ((frame + 0.5) / fps).toFixed(4);
  const { code, stderr } = await run(['-hide_banner', '-y', '-i', src, '-ss', t, '-frames:v', '1', '-c:v', 'png', dest]);
  const ok = code === 0 && (await fs.stat(dest).then((s) => s.size > 0, () => false));
  if (!ok) throw new Error(`Frame ${frame} failed: ${stderr.split('\n').slice(-3).join(' ').trim()}`);
}

/** Small short-GOP copy for smooth scrubbing (see spike 4: GOP 12, about 480p). Written atomically. */
export async function makeProxy(src: string, dest: string, height = 480): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp.mp4`;
  const { code, stderr } = await run(['-hide_banner', '-y', '-i', src, '-map', '0:v:0', '-map', '0:a:0?', '-vf', `scale=-2:'min(${height},ih)'`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-g', '12', '-keyint_min', '12', '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', tmp], 10 * 60_000);
  if (code !== 0) { await fs.rm(tmp, { force: true }); throw new Error(`Proxy failed: ${stderr.split('\n').slice(-3).join(' ').trim()}`); }
  await fs.rename(tmp, dest);
}

export type MediaOp =
  | { op: 'resize'; width?: number; height?: number; scale?: number }          // image or video; one of width/height keeps the ratio, scale is a factor
  | { op: 'crop'; aspect?: string; x?: number; y?: number; w?: number; h?: number }   // aspect "16:9" = centred crop, or an exact box in pixels
  | { op: 'trim'; start: number; end: number }                                   // video, seconds
  | { op: 'upscale'; factor?: number; toMp?: number };                            // image or video, Lanczos: by a factor (2 by default) or up to a size in megapixels (ratio kept)

/** The ffmpeg video filter (and extra arguments) for an edit. Pure, so it can be tested without ffmpeg. */
export function mediaOpArgs(o: MediaOp, kind: 'image' | 'video', src: { width?: number; height?: number }): { vf?: string; pre: string[]; post: string[] } {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  switch (o.op) {
    case 'resize': {
      if (o.scale) { const s = o.scale; return { vf: `scale=${even((src.width ?? 0) * s) || 'iw*' + s}:${even((src.height ?? 0) * s) || 'ih*' + s}:flags=lanczos`, pre: [], post: [] }; }
      if (!o.width && !o.height) throw new Error('Give a width, a height or a scale.');
      return { vf: `scale=${o.width ? even(o.width) : -2}:${o.height ? even(o.height) : -2}:flags=lanczos`, pre: [], post: [] };
    }
    case 'crop': {
      if (o.aspect) {
        const m = /^(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)$/.exec(o.aspect.trim());
        if (!m) throw new Error(`Aspect "${o.aspect}" is not like 16:9`);
        const r = Number(m[1]) / Number(m[2]);
        return { vf: `crop='trunc(min(iw,ih*${r})/2)*2':'trunc(min(ih,iw/${r})/2)*2'`, pre: [], post: [] };
      }
      if (!o.w || !o.h) throw new Error('Give an aspect or a box (x, y, w, h).');
      return { vf: `crop=${even(o.w)}:${even(o.h)}:${Math.max(0, Math.round(o.x ?? 0))}:${Math.max(0, Math.round(o.y ?? 0))}`, pre: [], post: [] };
    }
    case 'trim': {
      if (kind !== 'video') throw new Error('Trim works on videos.');
      if (!(o.end > o.start) || o.start < 0) throw new Error('Trim needs 0 <= start < end.');
      return { pre: ['-ss', String(o.start), '-to', String(o.end)], post: [] };
    }
    case 'upscale': {
      if (o.toMp !== undefined) {
        if (!(o.toMp > 0 && o.toMp <= 16)) throw new Error('Target size must be between 0 and 16 MP.');
        if (!src.width || !src.height) throw new Error('The size of the picture is not known.');
        const k = Math.sqrt((o.toMp * 1e6) / (src.width * src.height));
        if (k <= 1.001) throw new Error(`The picture is already ${((src.width * src.height) / 1e6).toFixed(2)} MP, not smaller than ${o.toMp} MP.`);
        return { vf: `scale=${even(src.width * k)}:${even(src.height * k)}:flags=lanczos`, pre: [], post: [] };
      }
      const f = o.factor ?? 2; if (!(f > 1 && f <= 4)) throw new Error('Upscale factor must be between 1 and 4.');
      return { vf: `scale=iw*${f}:ih*${f}:flags=lanczos`, pre: [], post: [] };
    }
  }
}

/** Write an edited copy of an image or video. The original is never touched. Videos keep their audio. */
export async function transformMedia(src: string, dest: string, o: MediaOp, kind: 'image' | 'video', info: { width?: number; height?: number } = {}): Promise<void> {
  const a = mediaOpArgs(o, kind, info);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp${path.extname(dest)}`;
  const args = ['-hide_banner', '-y', ...a.pre, '-i', src, ...(a.vf ? ['-vf', a.vf] : [])];
  if (kind === 'video') args.push('-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart');
  else args.push('-frames:v', '1');
  args.push(...a.post, tmp);
  const { code, stderr } = await run(args, 20 * 60_000);
  if (code !== 0) { await fs.rm(tmp, { force: true }); throw new Error(`${o.op} failed: ${stderr.split('\n').slice(-3).join(' ').trim()}`); }
  await fs.rename(tmp, dest);
}

export * from './continuity.ts';
export { renderTimeline, buildRenderArgs, type RenderPlan, type RenderClip } from './render.ts';
