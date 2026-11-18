import { createContext, useEffect, useState } from 'react';
import { Icon } from './ui/Icon.tsx';
import type { AppApi, Asset, JobView, Manifest, BoardView, StoryView, Shot } from '../main/api.ts';
import { inheritUse, type BlockUse, type PromptBlock, type PromptRecipe } from '@driftboard/director/src/blocks.ts';
export type { BlockUse, PromptBlock, PromptRecipe };

declare global { interface Window { driftboard: AppApi } }
export const api = window.driftboard;
export const assetUrl = (id: string) => `driftboard-asset://${id}`;
export const thumbUrl = (id: string) => `driftboard-thumb://${id}`;
export const proxyUrl = (id: string) => `driftboard-proxy://${id}`;
/** A manifest slot as the form sees it: wfDefault = the value the workflow itself has, customMultiple = the step custom sizes snap to. */
export type Slot = Manifest['slots'][number] & { wfDefault?: string | number; customMultiple?: number };
export type { Asset, JobView, Manifest, BoardView, StoryView, Shot };
/** Ask the preview to play (or pause) an asset: used by the play button inside a canvas node. */
let pendingPlay: string | null = null;
export const takePendingPlay = (id: string) => { if (pendingPlay === id) { pendingPlay = null; return true; } return false; };
export const requestPlay = (assetId: string) => { pendingPlay = assetId; window.dispatchEvent(new CustomEvent('driftboard-play', { detail: assetId })); };
export const EMPTY_STORY: StoryView = { tree: [], all: [], stories: [], activeId: null, meta: {}, tags: [], bible: undefined };

/** Every word of the query must appear somewhere in the given text (case-insensitive). */
export function matches(query: string, ...parts: (string | undefined)[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = parts.filter(Boolean).join(' ').toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** What the Generate tab is about to run. */
export interface Draft {
  profileId: string;
  values: Record<string, unknown>;
  /** image slot id -> asset ids, in order (Picture 1, 2, ...) */
  inputs: Record<string, string[]>;
  /** board item the job starts from; results land beside it */
  origin?: string;
  /** shot the results become takes of */
  shotId?: string;
  title: string;
  /** what the draft continues from, so Enhance can write the right kind of prompt */
  kind?: 'continue' | 'bridge';
  /** earlier versions of the prompt (what the user wrote, each Enhance / Assemble, edits in between) and which one is shown, so any of them can be gone back to */
  promptVersions?: { text: string; label: string; action?: string }[];
  promptAt?: number;
  /** a gap on the timeline this clip is meant to fill: when the job is done it is placed there */
  place?: { start: number; gap: number; track: number };
  /** how this shot uses the story's film blocks (switched off, changed for this shot) */
  blockUse?: BlockUse;
  /** the prompt of the clip this one continues or bridges from: the LLM keeps it consistent */
  previous?: string;
}

/**
 * Continue / Bridge from a clip: what that clip was made with. Follows edits (colour match, trim, the held-frames
 * copy) back to the generation, then returns its prompt and, when it recorded them, the film blocks it used.
 */
export function inheritFrom(assetId: string, jobs: JobView[], storyBlocks: PromptBlock[]): { previous?: string; blockUse?: BlockUse } {
  let id = assetId;
  for (let i = 0; i < 6; i++) {
    const j = jobs.find((x) => x.outputs.some((o) => o.assetId === id));
    if (!j) return {};
    if (j.kind === 'edit') { const src = j.inputs[0]?.assetId; if (!src) return {}; id = src; continue; }
    let p: { prompt?: unknown; __prompt?: PromptRecipe } = {};
    try { p = JSON.parse(j.params); } catch { return {}; }
    const previous = typeof p.prompt === 'string' && p.prompt.trim() ? p.prompt : undefined;
    return { previous, blockUse: p.__prompt?.blocks ? inheritUse(storyBlocks, p.__prompt.blocks) : undefined };
  }
  return {};
}

/** The pictures a clip was made from (its first/last frame and reference pictures, following edits back to the generation),
 *  so a Continue or Bridge keeps the same characters, clothing and place. Order: the clips as given, each one's own order. */
export function sourcePictures(clipIds: string[], jobs: JobView[], assets: Map<string, Asset>): string[] {
  const out: string[] = [];
  for (const clip of clipIds) {
    let id = clip;
    for (let i = 0; i < 8; i++) {
      const j = jobs.find((x) => x.outputs.some((o) => o.assetId === id)); if (!j) break;
      if (j.kind === 'edit') { const src = j.inputs[0]?.assetId; if (!src) break; id = src; continue; }
      for (const inp of j.inputs) if (assets.get(inp.assetId)?.kind === 'image' && !out.includes(inp.assetId)) out.push(inp.assetId);
      break;
    }
  }
  return out;
}

export interface Ctx {
  assets: Map<string, Asset>;
  jobs: JobView[];
  jobsById: Map<string, JobView>;
  progress: Record<string, number>;
  profiles: Manifest[];
  board: BoardView;
  /** asset id -> number of timeline clips using it */
  usage: Map<string, number>;
  story: StoryView;
  /** asset id -> its shot and take status */
  takeOf: Map<string, { shot: Shot; status: string; picked: boolean }>;
  /** Film properties (what the size choosers preselect) */
  film: import('./size.tsx').Film;
  setFilm: (f: import('./size.tsx').Film) => void;
}
export const C = createContext<Ctx>(null as unknown as Ctx);

export const imageSlots = (p: Manifest) => p.slots.filter((s) => s.type === 'image' || s.type === 'image_list');
/** Video and audio inputs (held frames, reference videos, voice samples): single clip or a list, filled from the assets selected on the canvas. */
export const mediaSlots = (p: Manifest) => p.slots.filter((s) => s.type === 'video' || s.type === 'video_list' || s.type === 'audio_list');
export const mediaSlotKind = (s: { type: string }): 'video' | 'audio' => (s.type === 'audio_list' ? 'audio' : 'video');
export const slotWithRole = (p: Manifest, role: string) => p.slots.find((s) => (s.type === 'image') && s.role === role);
export const profilesWithRoles = (ps: Manifest[], roles: string[]) => ps.filter((p) => roles.every((r) => slotWithRole(p, r)));

/** Spread an ordered list of assets over a profile's image slots: lists take all, single slots take one each. */
export function autoAssign(p: Manifest, refs: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let i = 0;
  for (const s of imageSlots(p)) {
    if (i >= refs.length) break;
    if (s.type === 'image_list') { out[s.id] = refs.slice(i, i + s.max); i += s.max; }
    else { out[s.id] = [refs[i]!]; i++; }
  }
  return out;
}

export function draftFromJob(job: JobView, profiles: Manifest[], newSeed: boolean): Draft | null {
  const p = profiles.find((x) => x.id === job.profile_id);
  if (!p) return null;
  const params = JSON.parse(job.params) as Record<string, unknown>;
  const inputs: Record<string, string[]> = {};
  for (const i of job.inputs) (inputs[i.role] ??= [])[i.idx ?? 0] = i.assetId;
  const values: Record<string, unknown> = {};
  const known = new Set([...p.slots.map((x) => x.id), 'custom_width', 'custom_height']);   // a recipe from an older profile version may name settings that are gone (e.g. the old upscale switch)
  for (const [k, v] of Object.entries(params)) if (!(k in inputs) && (known.has(k) || k.startsWith('__'))) values[k] = v;
  if (newSeed) delete values.seed;
  return { profileId: p.id, values, inputs, origin: job.origin ?? undefined, shotId: job.shot_id ?? undefined, title: 'Run again' };
}

export const fmtTime = (sec: number) => { const m = Math.floor(sec / 60), s = sec - m * 60; return `${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`; };

/** What a shot shows that the bible has a picture for: its characters, then its place, then its props. */
export interface ShotElement { name: string; role: 'character' | 'place' | 'prop'; asset: string }
export function elementsOfShot(shot: Shot, bible: StoryView['bible']): ShotElement[] {
  if (!bible) return [];
  const out: ShotElement[] = [];
  for (const id of shot.brief?.characterIds ?? []) { const c = bible.characters.find((x) => x.id === id); if (c?.refAsset) out.push({ name: c.name, role: 'character', asset: c.refAsset }); }
  const pl = bible.places.find((x) => x.id === shot.brief?.placeId); if (pl?.refAsset) out.push({ name: pl.name, role: 'place', asset: pl.refAsset });
  for (const id of shot.brief?.propIds ?? []) { const c = bible.props?.find((x) => x.id === id); if (c?.refAsset) out.push({ name: c.name, role: 'prop', asset: c.refAsset }); }
  return out.filter((e, i, a) => a.findIndex((x) => x.asset === e.asset) === i);
}

/** Voice samples (from the bible's characters in the shot) and the video / audio references added to the shot, in the order they are sent. */
export function mediaOfShot(shot: Shot, bible: StoryView['bible'], kinds: Map<string, string>): { voices: { asset: string; name: string }[]; videos: string[]; audios: string[] } {
  const voices: { asset: string; name: string }[] = [];
  for (const id of shot.brief?.characterIds ?? []) { const c = bible?.characters.find((x) => x.id === id); if (c?.voiceAsset && !voices.some((v) => v.asset === c.voiceAsset)) voices.push({ asset: c.voiceAsset, name: c.name }); }
  const own = shot.media ?? [];
  return { voices, videos: own.filter((a) => kinds.get(a) === 'video'), audios: own.filter((a) => kinds.get(a) === 'audio' && !voices.some((v) => v.asset === a)) };
}

/** The reference pictures a shot is generated with, in <Picture n> order: what is attached to the shot, else what the bible has for it. */
export const refsOfShot = (shot: Shot, bible: StoryView['bible']): string[] => shot.refs ?? elementsOfShot(shot, bible).map((e) => e.asset);

/** The draft for generating a take of a story shot: its prompt, length and the reference pictures of its characters (in <Picture n> order). */
export function draftForShot(shot: Shot, story: StoryView, profiles: Manifest[], profileId?: string, assetKinds?: Map<string, string>): Draft | null {
  const refs: string[] = refsOfShot(shot, story.bible);
  const videos = profiles.filter((x) => x.kind === 'video');
  const needsImage = (x: Manifest) => x.slots.some((s) => s.type === 'image' && s.required);
  const hasFirst = (x: Manifest) => !!slotWithRole(x, 'first_frame');
  const frames = shot.frames;
  // a shot with a first frame needs a model that takes one; a plain shot prefers a model that needs no inputs
  const wanted = profiles.find((x) => x.id === profileId);
  const p = frames?.first ? (wanted && hasFirst(wanted) ? wanted : videos.find(hasFirst)) ?? wanted ?? videos[0] ?? profiles[0]
    : (wanted && !needsImage(wanted) ? wanted : undefined) ?? (refs.length ? videos.find((x) => (x.director?.maxRefs ?? 0) > 0) : videos.find((x) => !needsImage(x) && !imageSlots(x).length)) ?? videos.find((x) => !needsImage(x)) ?? videos[0] ?? profiles[0];
  if (!p) return null;
  const values: Record<string, unknown> = {};
  if (shot.prompt) values.prompt = shot.prompt;
  if (shot.brief?.seconds) values.seconds = shot.brief.seconds;
  const max = p.director?.maxRefs ?? 0;
  const inputs: Record<string, string[]> = frames?.first ? { [slotWithRole(p, 'first_frame')?.id ?? 'first_frame']: [frames.first] } : max && !hasFirst(p) ? autoAssign(p, refs.slice(0, max)) : {};
  if (frames?.last && slotWithRole(p, 'last_frame')) inputs[slotWithRole(p, 'last_frame')!.id] = [frames.last];
  const audioSlot = p.slots.find((s) => s.type === 'audio_list');
  if (audioSlot && audioSlot.type === 'audio_list') {
    const voices = [...(shot.brief?.characterIds ?? []).map((id) => story.bible?.characters.find((c) => c.id === id)?.voiceAsset).filter((v): v is string => !!v), ...(shot.media ?? []).filter((a) => assetKinds?.get(a) === 'audio')];
    const uniq = voices.filter((v, i) => voices.indexOf(v) === i).slice(0, audioSlot.max);
    if (uniq.length) inputs[audioSlot.id] = uniq;
  }
  const vidSlot = p.slots.find((s) => s.type === 'video_list' || s.type === 'video');
  if (vidSlot) { const vs = (shot.media ?? []).filter((a) => assetKinds?.get(a) === 'video'); if (vs.length) inputs[vidSlot.id] = vidSlot.type === 'video_list' ? vs.slice(0, (vidSlot as { max?: number }).max ?? 3) : vs.slice(0, 1); }
  return { profileId: p.id, values, inputs, shotId: shot.id, title: `Generate for ${shot.name}` };
}

/** Seconds of held frames in a clip these values make (0 without held-frames inputs): at the start (Continue, Bridge) plus, for a bridge, at the end. */
export function heldStartSeconds(p: Manifest, values: Record<string, unknown>): number {
  const fps = (p as { frameGrid?: { fps?: number } }).frameGrid?.fps ?? 24;
  let sec = 0;
  for (const role of ['guide_start', 'guide_end']) {
    const g = p.slots.find((s) => s.role === role); if (!g || !values[g.id] || (Array.isArray(values[g.id]) && !(values[g.id] as unknown[]).length)) continue;
    const fr = p.slots.find((s) => s.id === g.id + '_frames') as (Slot & { default?: number }) | undefined;
    const frames = Number(values[fr?.id ?? ''] ?? values[role + '_frames'] ?? fr?.default ?? 22);
    if (frames > 0) sec += frames / fps;
  }
  return sec;
}

/** The values to send to generate(): the draft's values plus its image inputs (single slot = one id, list = ids). */
export function valuesOfDraft(p: Manifest, d: Draft): Record<string, unknown> {
  const values: Record<string, unknown> = { ...d.values };
  // nothing is left to a hidden default: whatever the form shows (the workflow's own value unless the user changed it) is sent
  // (advanced settings are left out: the runner fills them from Settings → ComfyUI, else the workflow, and records them with the job)
  for (const s of p.slots as Slot[]) if (s.wfDefault !== undefined && s.role !== 'seed' && !s.advanced && values[s.id] === undefined && !(values.custom_width !== undefined && s.type !== 'text' && 'bind' in s && (p.slots as Slot[]).some((e) => e.type === 'enum' && e.customSize && e.bind?.[0]?.node === s.bind?.[0]?.node))) values[s.id] = s.wfDefault;
  for (const s of imageSlots(p)) { const ids = d.inputs[s.id] ?? []; if (ids.length) values[s.id] = s.type === 'image' ? ids[0] : ids; }
  for (const s of mediaSlots(p)) { const ids = d.inputs[s.id] ?? []; if (ids.length) values[s.id] = s.type === 'video' ? ids[0] : ids; }
  // held frames (start, and a bridge's end) are part of the generated length: add them, so the new part is as long as asked (they are trimmed off on the timeline)
  const held = heldStartSeconds(p, values);
  const dur = p.slots.find((s) => s.type === 'number' && s.role === 'duration') as (Slot & { max?: number }) | undefined;
  if (held > 0 && dur && values.__heldSec === undefined) {
    const sec = Number(values[dur.id] ?? dur.wfDefault ?? 0);
    if (sec > 0) { values[dur.id] = Math.min(dur.max ?? Infinity, Math.round((sec + held) * 100) / 100); values.__heldSec = held; }
  }
  return values;
}

/* ---- one volume for every preview (asset preview and timeline preview), remembered between sessions ---- */
let masterVolume = (() => { try { const v = Number(localStorage.getItem('driftboard.volume')); return Number.isFinite(v) && localStorage.getItem('driftboard.volume') !== null ? Math.min(1, Math.max(0, v)) : 1; } catch { return 1; } })();
export const getVolume = () => masterVolume;
export const setVolume = (v: number) => { masterVolume = Math.min(1, Math.max(0, v)); try { localStorage.setItem('driftboard.volume', String(masterVolume)); } catch { /* ignore */ } window.dispatchEvent(new Event('driftboard-volume')); };

export function VolumeSlider() {
  const [v, setV] = useState(getVolume());
  useEffect(() => { const f = () => setV(getVolume()); window.addEventListener('driftboard-volume', f); return () => window.removeEventListener('driftboard-volume', f); }, []);
  return <label className="vol" title="Preview volume"><button type="button" className="btn sm icon quiet" aria-label={v === 0 ? 'Unmute the preview' : 'Mute the preview'} onClick={(e) => { e.preventDefault(); setVolume(v === 0 ? 1 : 0); }}><Icon name={v === 0 ? 'mute' : 'vol'} size="s" /></button><input type="range" aria-label="Preview volume" min={0} max={1} step={0.02} value={v} style={{ width: 70, padding: 0 }} onChange={(e) => setVolume(Number(e.target.value))} /></label>;
}

/** Tell the activity bar that something without its own progress events is running (label) or finished (null). */
export const activity = (id: string, label: string | null) => window.dispatchEvent(new CustomEvent('driftboard-activity', { detail: { id, label } }));
