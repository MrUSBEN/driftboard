import { createEditorStore, type EditorStoreApi } from './ltx/frontend/views/editor/editor-store.tsx';
import { createInitialEditorState, type EditorModel, type EditorState } from './ltx/frontend/views/editor/editor-state.ts';
import * as A from './ltx/frontend/views/editor/editor-actions.ts';
import { selectActiveTimeline, selectAssets, selectClips } from './ltx/frontend/views/editor/editor-selectors.ts';
import type { Asset as LtxAsset, TimelineClip } from './ltx/frontend/types/project-model.ts';
import type { RenderPlan, RenderClip } from '@driftboard/media';

/** The fields of a Driftboard asset row the editor needs. */
export interface EditorSourceAsset {
  id: string; kind: 'image' | 'video' | 'audio' | 'other';
  width: number | null; height: number | null; duration_ms: number | null; fps: number | null; has_audio: number | null;
}

export const assetUri = (id: string) => `driftboard-asset://${id}`;
export const idFromUri = (uri: string) => uri.replace(/^driftboard-asset:\/\//, '');

export function toEditorAsset(a: EditorSourceAsset, prompt = ''): LtxAsset | null {
  if (a.kind === 'other') return null;
  return {
    id: a.id, type: a.kind, path: assetUri(a.id), prompt, resolution: a.width && a.height ? `${a.width}x${a.height}` : '',
    width: a.width ?? undefined, height: a.height ?? undefined, duration: a.duration_ms ? a.duration_ms / 1000 : undefined, createdAt: 0,
  };
}

export function emptyModel(): EditorModel { return { assets: [], bins: {}, timelines: [], activeTimelineId: null }; }

/** Editor store with one timeline ("Main") ready to use. */
export function createDriftboardEditor(model?: EditorModel): EditorStoreApi {
  const store = createEditorStore(createInitialEditorState(model ?? emptyModel()));
  if (!selectActiveTimeline(store.getState().state)) store.getState().setStateWithoutHistory((s) => A.createTimeline(s, 'Main'));
  return store;
}

export const getModel = (store: EditorStoreApi): EditorModel => store.getState().state.editorModel;
export const getState = (store: EditorStoreApi): EditorState => store.getState().state;
export const edit = (store: EditorStoreApi, f: (s: EditorState) => EditorState) => store.getState().setStateWithHistory(f);

/** Make sure the editor knows these assets (adds missing ones, refreshes sizes/durations). */
export function syncAssets(store: EditorStoreApi, assets: EditorSourceAsset[]) {
  const have = new Map(selectAssets(getState(store)).map((a) => [a.id, a]));
  const add: LtxAsset[] = [];
  let changed = false;
  for (const a of assets) {
    const e = toEditorAsset(a); if (!e) continue;
    const cur = have.get(a.id);
    if (!cur) add.push(e);
    else if (cur.duration !== e.duration || cur.width !== e.width) { changed = true; have.set(a.id, { ...cur, width: e.width, height: e.height, duration: e.duration, resolution: e.resolution }); }
  }
  if (!add.length && !changed) return;
  store.getState().setStateWithoutHistory((s) => ({ ...s, editorModel: { ...s.editorModel, assets: [...add, ...s.editorModel.assets.map((x) => have.get(x.id) ?? x)] } }));
}

/** End of the last clip (the editor's own total never goes below 30 s). */
export const timelineEnd = (s: EditorState) => selectClips(s).reduce((m, c) => Math.max(m, c.startTime + c.duration), 0);

/** Append assets one after another on V1 (and their audio on A1), at the end of the timeline. */
export function appendToTimeline(store: EditorStoreApi, assetIds: string[]) {
  const all = new Map(selectAssets(getState(store)).map((a) => [a.id, a]));
  const assets = assetIds.map((id) => all.get(id)).filter((a): a is LtxAsset => !!a);
  if (!assets.length) return;
  const end = timelineEnd(getState(store));
  edit(store, (s) => A.insertAssetsToTimeline(s, { assets, trackIndex: 0, startTime: end }));
}

/** Drop one asset onto a specific track at a time (patches the track on if it was off). */
export function placeAsset(store: EditorStoreApi, assetId: string, trackIndex: number, time: number) {
  const a = selectAssets(getState(store)).find((x) => x.id === assetId);
  if (!a) return;
  edit(store, (s) => {
    const track = selectActiveTimeline(s)?.tracks[trackIndex];
    const base = track && track.sourcePatched === false ? A.toggleTrackSourcePatched(s, track.id) : s;
    return A.insertAssetsToTimeline(base, { assets: [a], trackIndex, startTime: time });
  });
}

/**
 * Delete clips (with their linked audio/video) and close the gap they leave: everything that starts at or after
 * the removed clips' end moves left by the removed length, on every track so sync is kept.
 */
export function rippleDelete(store: EditorStoreApi, clipIds: string[]) {
  edit(store, (s) => {
    const clips = selectClips(s);
    const ids = new Set<string>();
    for (const id of clipIds) { const c = clips.find((x) => x.id === id); if (c) { ids.add(c.id); for (const l of c.linkedClipIds ?? []) ids.add(l); } }
    const gone = clips.filter((c) => ids.has(c.id));
    if (!gone.length) return s;
    const from = Math.min(...gone.map((c) => c.startTime)), to = Math.max(...gone.map((c) => c.startTime + c.duration));
    const shift = to - from;
    let next = A.deleteClips(s, [...ids]);
    for (const c of selectClips(next)) if (c.startTime >= to - 0.001) next = A.setClipStartTime(next, c.id, Math.max(0, c.startTime - shift));
    return next;
  });
}

/**
 * Ripple: after the clips in `ids` changed length (or start) so their old end `oldEnd` is now `oldEnd + delta`,
 * every other clip that began at or after `oldEnd` on the same tracks moves by `delta`. No gaps, no overlaps, nothing cut.
 */
export function rippleAfter(s: EditorState, ids: string[], oldEnd: number, delta: number): EditorState {
  if (Math.abs(delta) < 1e-6) return s;
  const clips = selectClips(s), set = new Set(ids);
  const tracks = new Set(clips.filter((c) => set.has(c.id)).map((c) => c.trackIndex));
  const move = clips.filter((c) => !set.has(c.id) && tracks.has(c.trackIndex) && c.startTime >= oldEnd - 0.001).map((c) => c.id);
  return move.length ? A.moveClips(s, { clipIds: move, deltaTime: delta }) : s;
}

/** Change the speed of clips (each with its linked group); the clip gets shorter or longer, and with `ripple` the clips after it follow. */
export function setSpeed(s: EditorState, clipIds: string[], speed: number, ripple: boolean): EditorState {
  let next = s; const done = new Set<string>();
  const order = clipIds.map((id) => selectClips(s).find((c) => c.id === id)).filter((c): c is TimelineClip => !!c).sort((a, b) => a.startTime - b.startTime);
  for (const first of order) {
    if (done.has(first.id)) continue;
    const grp = [first.id, ...(first.linkedClipIds ?? []).filter((i) => clipIds.includes(i))];
    const cur = selectClips(next).filter((c) => grp.includes(c.id)); if (!cur.length) continue;
    const oldEnd = Math.max(...cur.map((c) => c.startTime + c.duration));
    for (const c of cur) { done.add(c.id); const old = c.speed || 1; next = A.setClipDuration(A.setClipSpeed(next, c.id, speed), c.id, (c.duration * old) / speed); }
    const newEnd = Math.max(...selectClips(next).filter((c) => grp.includes(c.id)).map((c) => c.startTime + c.duration));
    if (ripple) next = rippleAfter(next, grp, oldEnd, newEnd - oldEnd);
  }
  return next;
}

/** Times worth snapping to: 0, the playhead and every clip edge (excluding the clips being dragged). */
export function snapPoints(s: EditorState, excludeIds: Set<string>, playhead: number): number[] {
  const pts = [0, playhead];
  for (const c of selectClips(s)) if (!excludeIds.has(c.id)) pts.push(c.startTime, c.startTime + c.duration);
  return pts;
}

/**
 * Make the timeline follow the story's picks. For every shot: if one of its takes is already on the timeline
 * but is not the pick, the pick takes its place (same start and track, linked audio goes with it); if none of its
 * takes is on the timeline yet, the pick is appended at the end, in story order. One undo step.
 */
export function applyPicks(store: EditorStoreApi, shots: { pick?: string; takes: string[] }[]): { swapped: number; appended: number } {
  let swapped = 0, appended = 0;
  const known = new Map(selectAssets(getState(store)).map((a) => [a.id, a]));
  edit(store, (s0) => {
    let s = s0;
    for (const sh of shots) {
      if (!sh.pick) continue;
      const pick = known.get(sh.pick); if (!pick) continue;
      const takes = new Set(sh.takes);
      const clips = selectClips(s);
      if (clips.some((c) => c.assetId === sh.pick && c.type !== 'audio')) continue;                     // already there
      const old = clips.filter((c) => c.assetId && takes.has(c.assetId) && c.type !== 'audio');
      if (old.length) {
        for (const c of old) {
          const ids = [c.id, ...(c.linkedClipIds ?? [])];
          s = A.deleteClips(s, ids);
          const base = selectActiveTimeline(s)?.tracks[c.trackIndex]?.sourcePatched === false ? A.toggleTrackSourcePatched(s, selectActiveTimeline(s)!.tracks[c.trackIndex]!.id) : s;
          s = A.insertAssetsToTimeline(base, { assets: [pick], trackIndex: c.trackIndex, startTime: c.startTime });
          swapped++;
        }
      } else {
        const end = selectClips(s).reduce((m, c) => Math.max(m, c.startTime + c.duration), 0);
        s = A.insertAssetsToTimeline(s, { assets: [pick], trackIndex: 0, startTime: end });
        appended++;
      }
    }
    return s;
  });
  return { swapped, appended };
}

/**
 * Put another asset in place of a timeline clip (same track and start; its linked audio goes with it). With `ripple` the new clip
 * has its own full length and the clips after it follow; without, it is fitted to the old clip's length so nothing else moves.
 * Returns false when the clip or the asset is unknown. One undo step.
 */
export function replaceClip(store: EditorStoreApi, clipId: string, assetId: string, ripple: boolean): boolean {
  const s0 = getState(store);
  const old = selectClips(s0).find((c) => c.id === clipId), pick = selectAssets(s0).find((a) => a.id === assetId);
  if (!old || !pick || old.type === 'audio') return false;
  edit(store, (s) => {
    const group = [old.id, ...(old.linkedClipIds ?? [])];
    const oldEnd = Math.max(...selectClips(s).filter((c) => group.includes(c.id)).map((c) => c.startTime + c.duration));
    const before = new Set(selectClips(s).map((c) => c.id));
    let next = A.deleteClips(s, group);
    const tr = selectActiveTimeline(next)?.tracks[old.trackIndex];
    if (tr && tr.sourcePatched === false) next = A.toggleTrackSourcePatched(next, tr.id);
    // insert past the end first (inserting on top of other clips would cut them), then move the new clip into place
    const farEnd = Math.max(0, ...selectClips(next).map((c) => c.startTime + c.duration));
    next = A.insertAssetsToTimeline(next, { assets: [pick], trackIndex: old.trackIndex, startTime: farEnd });
    const fresh = selectClips(next).filter((c) => !before.has(c.id)).map((c) => c.id);
    const natural = Math.max(...selectClips(next).filter((c) => fresh.includes(c.id)).map((c) => c.duration));
    const len = ripple ? natural : Math.min(natural, old.duration);   // without ripple the new clip is fitted to the old length, so nothing else moves
    for (const id of fresh) next = A.setClipDuration(next, id, len);
    if (ripple) next = rippleAfter(next, fresh, oldEnd, len - (oldEnd - old.startTime));   // the clips after the old one follow
    return A.moveClips(next, { clipIds: fresh, deltaTime: old.startTime - farEnd });
  });
  return true;
}

/**
 * Put a finished clip into a gap on the timeline (same track, from `start`, at most `gap` long; shorter than the gap it leaves a small rest,
 * longer it is cut to the gap but its handles keep the rest). Never overwrites: returns false when something else is already in that span.
 */
export function placeInGap(store: EditorStoreApi, assetId: string, start: number, gap: number, trackIndex: number): boolean {
  const s0 = getState(store); const pick = selectAssets(s0).find((a) => a.id === assetId);
  if (!pick) return false;
  const busy = selectClips(s0).some((c) => c.trackIndex === trackIndex && c.startTime < start + gap - 0.01 && c.startTime + c.duration > start + 0.01);
  if (busy) return false;
  edit(store, (s) => {
    const before = new Set(selectClips(s).map((c) => c.id));
    const farEnd = Math.max(0, ...selectClips(s).map((c) => c.startTime + c.duration));
    let next = A.insertAssetsToTimeline(s, { assets: [pick], trackIndex, startTime: farEnd });
    const fresh = selectClips(next).filter((c) => !before.has(c.id)).map((c) => c.id);
    const natural = Math.max(...selectClips(next).filter((c) => fresh.includes(c.id)).map((c) => c.duration));
    for (const id of fresh) next = A.setClipDuration(next, id, Math.min(natural, gap));
    return A.moveClips(next, { clipIds: fresh, deltaTime: start - farEnd });
  });
  return true;
}

/** Where on the timeline each asset is used, for the canvas "used in timeline" badge. */
export function usage(model: EditorModel): Map<string, number> {
  const m = new Map<string, number>();
  const type = new Map(model.assets.map((a) => [a.id, a.type]));
  // a video's linked audio clip is not a second use
  for (const t of model.timelines) for (const c of t.clips) if (c.assetId && (c.type !== 'audio' || type.get(c.assetId) === 'audio')) m.set(c.assetId, (m.get(c.assetId) ?? 0) + 1);
  return m;
}

/** Turn the active timeline into something ffmpeg can render. `fileOf` maps an asset id to a path on disk. */
export function buildRenderPlan(state: EditorState, fileOf: (assetId: string) => string | undefined, opts: { width?: number; height?: number; fps?: number } = {}): RenderPlan {
  const tl = selectActiveTimeline(state);
  if (!tl) throw new Error('No timeline');
  const assets = new Map(selectAssets(state).map((a) => [a.id, a]));
  const clips: RenderClip[] = [];
  let first: LtxAsset | undefined;
  for (const c of tl.clips as TimelineClip[]) {
    if (!c.assetId || (c.type !== 'video' && c.type !== 'image' && c.type !== 'audio')) continue;
    const track = tl.tracks[c.trackIndex];
    if (!track || track.enabled === false) continue;
    const isAudio = c.type === 'audio' || track.kind === 'audio';
    if (isAudio && (track.muted || c.muted)) continue;
    const file = fileOf(c.assetId); if (!file) throw new Error(`Missing file for asset ${c.assetId.slice(0, 8)}`);
    const a = assets.get(c.assetId);
    if (!isAudio && !first && a?.width) first = a;
    clips.push({
      kind: isAudio ? 'audio' : c.type === 'image' ? 'image' : 'video', file,
      start: c.startTime, duration: c.duration, trimStart: c.trimStart, speed: c.speed || 1,
      volume: Math.max(0, c.volume === undefined ? 1 : c.volume > 1 ? c.volume / 100 : c.volume), layer: c.trackIndex, opacity: c.opacity, reversed: c.reversed, flipH: c.flipH, flipV: c.flipV,
      ...(!isAudio && c.transitionIn?.type === 'dissolve' ? { dissolveIn: c.transitionIn.duration } : {}),
      ...(!isAudio && c.transitionOut?.type === 'dissolve' ? { dissolveOut: c.transitionOut.duration } : {}),
    });
  }
  if (!clips.length) throw new Error('The timeline is empty');
  const duration = Math.max(...clips.map((c) => c.start + c.duration));
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(opts.width ?? first?.width ?? 1280), height: even(opts.height ?? first?.height ?? 720), fps: opts.fps ?? 24, duration, clips };
}

export { A as actions };
export * from './ltx/frontend/views/editor/editor-selectors.ts';
export { createEditorStore, type EditorStoreApi } from './ltx/frontend/views/editor/editor-store.tsx';
export type { EditorModel, EditorState } from './ltx/frontend/views/editor/editor-state.ts';
export type { TimelineClip, Track, Timeline } from './ltx/frontend/types/project-model.ts';
