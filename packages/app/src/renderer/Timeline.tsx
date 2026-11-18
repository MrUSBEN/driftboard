import { hit, combo, bindOf } from './keys.ts';
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  actions as A, edit, getState, rippleDelete, rippleAfter, setSpeed, replaceClip, snapPoints, buildRenderPlan, timelineEnd,
  selectOrderedTracks, selectClips, selectCurrentTime, selectIsPlaying, selectSelectedClipIds, selectSnapEnabled, selectClipMaxDuration, selectActiveTimeline,
  type TimelineClip,
} from '@driftboard/editor';
import { C, api, thumbUrl, VolumeSlider, profilesWithRoles, slotWithRole, sourcePictures } from './shared.tsx';
import { useEditorState, useStore, joinForTimeline, syncEditorAssets } from './editorBridge.tsx';
import { openContinuity } from './Continuity.tsx';
import { confirmUser } from './Ask.tsx';
import { ContextMenu, ParamDialog, type Field, type MenuItem } from './CanvasMenu.tsx';
import { registerUndo, undoChanged } from './undoRouter.ts';
import { RegenerateDialog, jobOfAsset } from './Regenerate.tsx';
import type { Draft, JobView } from './shared.tsx';
import { Icon } from './ui/Icon.tsx';
import { Button, Field as FieldBox, IconButton, Menu, Notice, Popover, Progress, Spinner, type MenuItem as UiMenuItem } from './ui/ui.tsx';
import { assetName } from './Canvas.tsx';

const ROW = 46, LABEL = 76;
/** Chain on a clip: closed = linked to its audio/video, broken = on its own. */
/** Something outside the timeline (the Film inspector) asked for the export popover; the timeline may mount only after that. */
let exportPending = false;
export const requestExport = () => { exportPending = true; window.dispatchEvent(new Event('driftboard-export-open')); };
const takeExportRequest = () => { const v = exportPending; exportPending = false; return v; };

/** A short name for an undo step of the timeline (its snapshots carry no label): what changed between it and now. */
type Snap = { timelines: { clips: unknown[] }[] } | undefined;
function describeStep(snap: Snap, cur: { timelines: { clips: unknown[] }[] }): string {
  if (!snap) return '';
  const n = (x: { timelines: { clips: unknown[] }[] }) => x.timelines.reduce((k, t) => k + t.clips.length, 0);
  const len = (x: { timelines: { clips: unknown[] }[] }) => x.timelines.reduce((k, t) => k + t.clips.reduce((a: number, c) => a + ((c as { duration?: number }).duration ?? 0), 0), 0);
  const d = n(cur) - n(snap);
  if (d > 0 && Math.abs(len(cur) - len(snap)) < 0.01) return 'Split';
  return d > 0 ? `Add ${d} clip${d === 1 ? '' : 's'}` : d < 0 ? `Remove ${-d} clip${d === -1 ? '' : 's'}` : 'Edit clips';
}

function LinkIcon({ on }: { on: boolean }) {
  return on
    ? <svg className="linkIcon on" viewBox="0 0 16 16" width="14" height="14"><title>Linked: moves, splits and deletes together with its audio or video (right-click to unlink)</title><rect x="1.5" y="5.5" width="8" height="5" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.6" /><rect x="6.5" y="5.5" width="8" height="5" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
    : <svg className="linkIcon" viewBox="0 0 16 16" width="14" height="14"><title>Not linked: this clip moves on its own (right-click to link)</title><rect x="0.8" y="5.5" width="5.6" height="5" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.6" /><rect x="9.6" y="5.5" width="5.6" height="5" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M7 3.5 L9 12.5" stroke="currentColor" strokeWidth="1.4" /></svg>;
}
const XQ = { draft: { label: 'Draft (small, fast)', crf: 28, preset: 'veryfast' }, standard: { label: 'Standard', crf: 23, preset: 'medium' }, high: { label: 'High', crf: 18, preset: 'medium' }, master: { label: 'Master (largest, slow)', crf: 14, preset: 'slow' } } as const;
const XDEF = { quality: 'high' as const, res: 'timeline', fps: 'timeline', audio: 192, name: '', ask: false };
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;

interface DragState { kind: 'move' | 'start' | 'end'; ids: string[]; anchor: number; dt: number; row: number | null; baseTrack: number }

export function Timeline({ onFocus, openDraft, notify, canvasAssets, onCollapse }: { onFocus: () => void; openDraft: (d: Draft) => void; notify: (m: string) => void; canvasAssets: string[]; onCollapse: () => void }) {
  const store = useStore();
  const state = useEditorState();
  const { assets, jobs, profiles, board, story, takeOf } = useContext(C);
  const [more, setMore] = useState<{ x: number; y: number } | null>(null);
  const [regen, setRegen] = useState<{ job: JobView; origin?: string } | null>(null);
  const [pps, setPps] = useState(40);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [exporting, setExporting] = useState<number | null>(null);
  const [msg, setMsg] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const xBtn = useRef<HTMLButtonElement>(null);
  const [ripple, setRippleOn] = useState(() => { try { return localStorage.getItem('driftboard.ripple') !== '0'; } catch { return true; } });
  const setRipple = (v: boolean) => { setRippleOn(v); try { localStorage.setItem('driftboard.ripple', v ? '1' : '0'); } catch { /* ignore */ } };
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [dlg, setDlg] = useState<{ title: string; fields: Field[]; ok: (v: Record<string, string>) => void } | null>(null);
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);   // rubber band, in timeline pixels

  const tracks = selectOrderedTracks(state);
  const clips = selectClips(state);
  const selected = selectSelectedClipIds(state);
  const t = selectCurrentTime(state);
  const playing = selectIsPlaying(state);
  const snap = selectSnapEnabled(state);
  const end = timelineEnd(state);
  const width = Math.max((end + 20) * pps, 800);
  const rowOf = useMemo(() => new Map(tracks.map((e) => [e.realIndex, e.displayRow])), [tracks]);

  useEffect(() => registerUndo('timeline', {
    undo: () => store.getState().setStateWithoutHistory((x) => A.undo(x)), redo: () => store.getState().setStateWithoutHistory((x) => A.redo(x)),
    info: () => { const h = store.getState().state.history; const cur = store.getState().state; return { canUndo: h.undoStack.length > 0, canRedo: h.redoStack.length > 0, undo: describeStep(h.undoStack.at(-1), cur.editorModel), redo: describeStep(h.redoStack.at(-1), cur.editorModel) }; },
  }), [store]);
  /** Zoom keeping the moment under `anchorX` (pixels from the left edge of the scroll area) where it is. */
  const pendingScroll = useRef<number | null>(null);
  const zoomTo = (next: number, anchorX?: number) => {
    const el = scroller.current; const np = clamp(next, 2, 400);
    if (el) { const ax = anchorX ?? (el.clientWidth - LABEL) / 2 + LABEL; const tm = (el.scrollLeft + ax - LABEL) / pps; pendingScroll.current = Math.max(0, tm * np - (ax - LABEL)); }
    setPps(np);
  };
  useLayoutEffect(() => { if (pendingScroll.current !== null && scroller.current) { scroller.current.scrollLeft = pendingScroll.current; pendingScroll.current = null; } }, [pps]);
  const fitAll = () => { const el = scroller.current; if (!el) return; const span = Math.max(end, 1); pendingScroll.current = 0; setPps(clamp((el.clientWidth - LABEL - 40) / span, 2, 400)); };
  const fitSelection = () => {
    const el = scroller.current; const sel = clips.filter((c) => selected.has(c.id)); if (!el || !sel.length) return fitAll();
    const a = Math.min(...sel.map((c) => c.startTime)), b = Math.max(...sel.map((c) => c.startTime + c.duration));
    const np = clamp((el.clientWidth - LABEL - 40) / Math.max(0.5, b - a), 2, 400); pendingScroll.current = Math.max(0, a * np - 20); setPps(np);
  };
  const centerPlayhead = () => { const el = scroller.current; if (!el) return; el.scrollLeft = Math.max(0, LABEL + t * pps - el.clientWidth / 2); };
  // Ctrl + mouse wheel zooms around the pointer
  useEffect(() => {
    const el = scroller.current; if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomTo(pps * (e.deltaY < 0 ? 1.2 : 1 / 1.2), e.clientX - rect.left);
    };
    el.addEventListener('wheel', wheel, { passive: false }); return () => el.removeEventListener('wheel', wheel);
  });
  /** Bridge: a new clip that runs from where the first selected clip ends to where the second begins (as the timeline shows them, trims included). */
  const bridge = async (a: TimelineClip, b: TimelineClip) => {
    const p = profilesWithRoles(profiles.filter((x) => x.kind === 'video'), ['first_frame', 'last_frame'])[0];
    if (!p) return setMsg('No video profile has first-frame and last-frame slots.');
    const aa = assets.get(a.assetId!), ab = assets.get(b.assetId!);
    const fa = aa?.fps ?? 24, fb = ab?.fps ?? 24, durA = (aa?.duration_ms ?? 0) / 1000;
    const endA = a.trimStart + a.duration * (a.speed || 1);
    const whichA = durA && endA >= durA - 0.05 ? 'last' as const : { frame: Math.max(0, Math.round(endA * fa) - 1) };
    const whichB = b.trimStart > 0.01 ? { frame: Math.round(b.trimStart * fb) } : 'first' as const;
    const origin = board.items.find((i) => i.kind === 'asset' && i.ref === a.assetId)?.id;
    const gap = Math.round((b.startTime - (a.startTime + a.duration)) * 100) / 100;   // the empty space between the two clips on the timeline
    const dur = p.slots.find((x) => x.role === 'duration') as { id: string; min?: number; max?: number } | undefined;
    const values: Record<string, unknown> = {};
    if (gap > 0.05 && dur) values[dur.id] = Math.min(dur.max ?? 15, Math.max(dur.min ?? 1, Math.round(gap * 10) / 10));
    const place = gap > 0.05 && a.trackIndex === b.trackIndex ? { start: a.startTime + a.duration, gap, track: a.trackIndex } : undefined;
    setMsg('Bridge: taking the two frames…');
    const r1 = await api.frameExtract(a.assetId!, whichA, origin); if (!r1.ok) return setMsg(r1.error);
    const r2 = await api.frameExtract(b.assetId!, whichB, origin); if (!r2.ok) return setMsg(r2.error);
    setMsg(place ? `Gap on the timeline: ${gap.toFixed(2)} s. The result is placed in it when it is done.` : gap > 0.05 ? `Gap: ${gap.toFixed(2)} s (the clips are on different tracks, so the result is not placed automatically).` : 'The two clips touch: there is no gap to fill.');
    openDraft({ profileId: p.id, values, place, inputs: { [slotWithRole(p, 'first_frame')!.id]: [r1.assetId], [slotWithRole(p, 'last_frame')!.id]: [r2.assetId] }, origin, title: 'Bridge', kind: 'bridge' });
  };
  /** Bridge with held frames: the end of the first clip and the start of the second anchor both ends of the new clip (only where the clips are not trimmed at the join). */
  const bridgeHeld = async (a: TimelineClip, b: TimelineClip) => {
    const p = profiles.find((x) => x.kind === 'video' && x.slots.some((s) => s.role === 'guide_start') && x.slots.some((s) => s.role === 'guide_end'));
    if (!p) return setMsg('No video profile takes held frames.');
    const aa = assets.get(a.assetId!); const durA = (aa?.duration_ms ?? 0) / 1000;
    const endA = a.trimStart + a.duration * (a.speed || 1);
    if (!(durA && endA >= durA - 0.05) || b.trimStart > 0.05) return setMsg('Held frames need the clips to be whole at the join (not trimmed there). Use the first/last-frame bridge instead, or restore the trim.');
    const origin = board.items.find((i) => i.kind === 'asset' && i.ref === a.assetId)?.id;
    const gap = Math.round((b.startTime - (a.startTime + a.duration)) * 100) / 100;
    const dur = p.slots.find((x) => x.role === 'duration') as { id: string; min?: number; max?: number } | undefined;
    const values: Record<string, unknown> = {};
    if (gap > 0.05 && dur) values[dur.id] = Math.min(dur.max ?? 15, Math.max(dur.min ?? 1, Math.round(gap * 10) / 10));
    const place = gap > 0.05 && a.trackIndex === b.trackIndex ? { start: a.startTime + a.duration, gap, track: a.trackIndex } : undefined;
    setMsg('Bridge: preparing the held frames…');
    const g = await api.guideClip(a.assetId!, { side: 'tail', frames: 22, matchColor: true }); if (!g.ok) return setMsg(g.error);
    const e = await api.guideClip(b.assetId!, { side: 'head', frames: 22, matchColor: true }); if (!e.ok) return setMsg(e.error);
    values.guide_start_frames = g.frames; values.guide_end_frames = e.frames;
    const inputs: Record<string, string[]> = { [p.slots.find((s) => s.role === 'guide_start')!.id]: [g.assetId], [p.slots.find((s) => s.role === 'guide_end')!.id]: [e.assetId] };
    const refSlot = p.slots.find((s) => s.type === 'image_list'); if (refSlot) { const pics = [...new Set([...sourcePictures([a.assetId!, b.assetId!], jobs, assets), ...(g.keystone ? [g.keystone] : [])])].slice(0, (refSlot as { max?: number }).max ?? 9); if (pics.length) inputs[refSlot.id] = pics; }
    setMsg(place ? `Gap on the timeline: ${gap.toFixed(2)} s. The result is placed in it when it is done.` : 'Bridge ready in the Generate tab.');
    openDraft({ profileId: p.id, values, place, inputs, origin, title: 'Bridge (held frames)', kind: 'bridge' });
  };
  /** Continue a timeline clip: a new clip that carries on from its end, placed right after it when that space is free. held = the last 22 frames anchor the start, otherwise just the last frame. */
  const continueClip = async (c: TimelineClip, held: boolean) => {
    const a = assets.get(c.assetId!); const durA = (a?.duration_ms ?? 0) / 1000;
    const endSrc = c.trimStart + c.duration * (c.speed || 1);
    if (held && !(durA && endSrc >= durA - 0.05)) return setMsg('Held frames come from the end of the clip, which is trimmed here. Restore the trim, or use "Continue from last frame only".');
    const origin = board.items.find((i) => i.kind === 'asset' && i.ref === c.assetId)?.id;
    const end = c.startTime + c.duration;
    const next = clips.filter((x) => x.trackIndex === c.trackIndex && x.startTime >= end - 0.01 && x.id !== c.id && x.type === c.type).sort((x, y) => x.startTime - y.startTime)[0];
    const free = next ? Math.round((next.startTime - end) * 100) / 100 : 5;
    const place = free >= 1 ? { start: end, gap: free, track: c.trackIndex } : undefined;
    const p = held ? profiles.find((x) => x.kind === 'video' && x.slots.some((s) => s.role === 'guide_start')) : profilesWithRoles(profiles.filter((x) => x.kind === 'video'), ['first_frame'])[0];
    if (!p) return setMsg(held ? 'No video profile takes held frames.' : 'No video profile has a first-frame slot.');
    const dur = p.slots.find((x) => x.role === 'duration') as { id: string; min?: number; max?: number } | undefined;
    const values: Record<string, unknown> = {};
    if (dur) values[dur.id] = Math.min(dur.max ?? 15, Math.max(dur.min ?? 1, Math.min(5, free >= 1 ? free : 5)));
    setMsg(held ? 'Continue: preparing the held frames…' : 'Continue: taking the last frame…');
    const inputs: Record<string, string[]> = {};
    if (held) {
      const g = await api.guideClip(c.assetId!, { side: 'tail', frames: 22, matchColor: true }); if (!g.ok) return setMsg(g.error);
      inputs[p.slots.find((s) => s.role === 'guide_start')!.id] = [g.assetId]; values.guide_start_frames = g.frames;
      const refSlot = p.slots.find((s) => s.type === 'image_list'); if (refSlot) { const pics = [...new Set([...sourcePictures([c.assetId!], jobs, assets), ...(g.keystone ? [g.keystone] : [])])].slice(0, (refSlot as { max?: number }).max ?? 9); if (pics.length) inputs[refSlot.id] = pics; }
    } else {
      const r = await api.frameExtract(c.assetId!, 'last', origin); if (!r.ok) return setMsg(r.error);
      inputs[slotWithRole(p, 'first_frame')!.id] = [r.assetId];
    }
    setMsg(place ? `The result is placed after the clip (${free.toFixed(1)} s free) when it is done.` : 'No free space after the clip: the result lands on the canvas.');
    openDraft({ profileId: p.id, values, place, inputs, origin, title: held ? 'Continue (held frames)' : 'Continue', kind: 'continue' });
  };
  const setTime = (time: number) => store.getState().setStateWithoutHistory((s) => A.setCurrentTime(s, Math.max(0, time)));
  const group = (c: TimelineClip) => [c.id, ...(c.linkedClipIds ?? [])];
  const selectedGroup = () => { const ids = new Set<string>(); for (const c of clips) if (selected.has(c.id)) for (const i of group(c)) ids.add(i); return [...ids]; };

  const snapTo = (time: number, exclude: Set<string>) => {
    if (!snap) return time;
    const pts = snapPoints(getState(store), exclude, t), tol = 14 / pps;
    let best = time, bd = tol;
    for (const p of pts) { const d = Math.abs(p - time); if (d < bd) { bd = d; best = p; } }
    return best;
  };

  // ---------- pointer interactions on clips ----------
  const startDrag = (e: React.PointerEvent, c: TimelineClip, kind: DragState['kind']) => {
    e.stopPropagation(); onFocus();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const solo = e.altKey;   // Alt+click picks just this clip, ignoring the link to its audio or video
    const ids = selected.has(c.id) && kind === 'move' && !solo ? selectedGroup() : solo ? [c.id] : group(c);
    if (!selected.has(c.id) || kind !== 'move' || solo) {
      store.getState().setStateWithoutHistory((s) => A.selectClipsById(s, solo ? [c.id] : group(c), { mode: e.shiftKey ? 'add' : 'replace' }));
    }
    setDrag({ kind, ids, anchor: e.clientX, dt: 0, row: null, baseTrack: c.trackIndex });
  };
  const onMove = (e: React.PointerEvent, c: TimelineClip) => {
    if (!drag) return;
    let dt = (e.clientX - drag.anchor) / pps;
    const lead = clips.find((x) => x.id === drag.ids[0]) ?? c;
    const ex = new Set(drag.ids);
    if (drag.kind === 'move') {
      const s = snapTo(lead.startTime + dt, ex), e2 = snapTo(lead.startTime + lead.duration + dt, ex);
      dt = Math.abs(s - (lead.startTime + dt)) <= Math.abs(e2 - (lead.startTime + lead.duration + dt)) ? s - lead.startTime : e2 - lead.startTime - lead.duration;
      dt = Math.max(dt, -Math.min(...clips.filter((x) => ex.has(x.id)).map((x) => x.startTime)));
      const el = scroller.current!; const y = e.clientY - el.getBoundingClientRect().top + el.scrollTop - 24;
      const row = clamp(Math.floor(y / ROW), 0, tracks.length - 1);
      // Clips do not slide over each other: when the dragged clip would land on a neighbour (same track), it sticks to the nearest edge.
      if (row === rowOf.get(lead.trackIndex)) {
        let ns = lead.startTime + dt;
        for (const o of clips) {
          if (ex.has(o.id) || o.trackIndex !== lead.trackIndex) continue;
          const os = o.startTime, oe = o.startTime + o.duration;
          if (ns < oe - 0.001 && ns + lead.duration > os + 0.001) {
            const before = os - lead.duration;
            ns = before >= 0 && Math.abs(before - ns) <= Math.abs(oe - ns) ? before : oe;
          }
        }
        dt = ns - lead.startTime;
      }
      setDrag({ ...drag, dt, row });
    } else if (drag.kind === 'start') {
      const lim = lead.startTime + lead.duration - 0.1;
      dt = clamp(snapTo(lead.startTime + dt, ex) - lead.startTime, -lead.trimStart / (lead.speed || 1), lim - lead.startTime);
      dt = Math.max(dt, -lead.startTime);
      setDrag({ ...drag, dt });
    } else {
      const max = selectClipMaxDuration(getState(store), lead);
      dt = clamp(snapTo(lead.startTime + lead.duration + dt, ex) - (lead.startTime + lead.duration), 0.1 - lead.duration, max - lead.duration);
      setDrag({ ...drag, dt });
    }
  };
  const onUp = (c: TimelineClip) => {
    if (!drag) return;
    const d = drag; setDrag(null);
    if (Math.abs(d.dt) < 0.001 && d.row === null) return;
    if (d.kind === 'move') {
      let target: number | undefined;
      let audioTarget: number | undefined;
      if (d.row !== null && d.ids.length <= 2) {
        const entry = tracks.find((x) => x.displayRow === d.row);
        const lead = clips.find((x) => x.id === d.ids[0])!;
        const sameKind = entry && (entry.track.kind === tracks.find((x) => x.realIndex === lead.trackIndex)?.track.kind);
        if (entry && sameKind && entry.realIndex !== lead.trackIndex) target = entry.realIndex;
        if (target !== undefined && entry!.track.kind !== 'audio') {   // the picture moves up or down: its audio goes the other way (V2 with A2, V1 with A1), so both can be moved around freely
          const vt = tracks.filter((x) => x.track.kind !== 'audio').map((x) => x.realIndex).sort((p, q) => p - q), at = tracks.filter((x) => x.track.kind === 'audio').map((x) => x.realIndex).sort((p, q) => p - q);
          const rank = vt.indexOf(target); if (rank >= 0 && at.length) audioTarget = at[Math.min(rank, at.length - 1)];
        }
      }
      edit(store, (s) => {
        let next = s;
        const [first, ...rest] = d.ids;
        next = A.moveClips(next, { clipIds: [first!], deltaTime: d.dt, targetTrackIndex: target });
        if (rest.length) next = A.moveClips(next, { clipIds: rest, deltaTime: d.dt, targetTrackIndex: audioTarget });
        return next;
      });
    } else {
      edit(store, (s) => {
        const before = selectClips(s).filter((c) => d.ids.includes(c.id));
        const oldEnd = Math.max(...before.map((c) => c.startTime + c.duration));
        let next = s;
        for (const id of d.ids) next = A.resizeClip(next, { clipId: id, edge: d.kind as 'start' | 'end', deltaTime: d.dt });
        if (!ripple) return next;
        if (d.kind === 'start') {   // the clip keeps its place; what it gained or lost moves the clips after it
          const shift = before[0]!.startTime - selectClips(next).find((c) => c.id === before[0]!.id)!.startTime;
          next = A.moveClips(next, { clipIds: d.ids, deltaTime: shift });
        }
        const newEnd = Math.max(...selectClips(next).filter((c) => d.ids.includes(c.id)).map((c) => c.startTime + c.duration));
        return rippleAfter(next, d.ids, oldEnd, newEnd - oldEnd);
      });
    }
    void c;
  };

  /** Drag on an empty part of a track to rubber-band select clips (Shift adds to the selection). A plain click clears the selection. */
  const startBox = (e: React.PointerEvent) => {
    onFocus(); if (e.button !== 0) return;
    const el = inner.current!; const add = e.shiftKey;
    const pos = (ev: { clientX: number; clientY: number }) => { const r = el.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
    const a = pos(e); let moved = false;
    if (!add) store.getState().setStateWithoutHistory((x) => A.clearClipSelection(x));
    const hitClips = (b: { x0: number; y0: number; x1: number; y1: number }) => {
      const xa = Math.min(b.x0, b.x1), xb = Math.max(b.x0, b.x1), ya = Math.min(b.y0, b.y1), yb = Math.max(b.y0, b.y1);
      const ids = new Set<string>();
      for (const c of clips) {
        const row = rowOf.get(c.trackIndex); if (row === undefined) continue;
        const cx0 = LABEL + c.startTime * pps, cx1 = cx0 + c.duration * pps, cy0 = 24 + row * ROW, cy1 = cy0 + ROW;
        if (cx1 >= xa && cx0 <= xb && cy1 >= ya && cy0 <= yb) for (const i of group(c)) ids.add(i);
      }
      return [...ids];
    };
    const mv = (ev: PointerEvent) => { const p = pos(ev); if (!moved && Math.hypot(p.x - a.x, p.y - a.y) < 4) return; moved = true; setBox({ x0: a.x, y0: a.y, x1: p.x, y1: p.y }); };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
      if (!moved && !add) setTime((a.x - LABEL) / pps);   // a click on empty track moves the playhead there, also while playing
      if (moved) { const p = pos(ev); const ids = hitClips({ x0: a.x, y0: a.y, x1: p.x, y1: p.y }); store.getState().setStateWithoutHistory((x) => A.selectClipsById(x, ids, { mode: add ? 'add' : 'replace' })); }
      setBox(null);
    };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };
  const selectAll = () => store.getState().setStateWithoutHistory((x) => A.selectClipsById(x, clips.map((c) => c.id), { mode: 'replace' }));
  const clearAll = async () => {
    if (!clips.length) return;
    if (await confirmUser(`Clear the whole timeline?`, `All ${clips.length} clips are removed from the timeline. The media stays in the Library, and Undo brings the clips back.`, 'Clear timeline', true)) edit(store, (x) => A.deleteClips(x, clips.map((c) => c.id)));
  };

  /* ---------- right-click menu: what can be done to the selected clips ---------- */
  const openMenu = (e: React.MouseEvent, c?: TimelineClip) => {
    e.preventDefault(); e.stopPropagation(); onFocus();
    if (c && !selected.has(c.id)) store.getState().setStateWithoutHistory((x) => A.selectClipsById(x, e.altKey ? [c.id] : group(c), { mode: 'replace' }));
    setMenu({ x: e.clientX, y: e.clientY });
  };
  const menuItems = (): MenuItem[] => {
    const sel = clips.filter((c) => selected.has(c.id));
    if (!sel.length) return [{ label: 'Select all', icon: 'grid', hint: 'Ctrl+A', onClick: selectAll }, { label: 'Clear all…', icon: 'trash', danger: true, disabled: !clips.length, onClick: () => void clearAll() }];
    const byId = new Map(clips.map((c) => [c.id, c]));
    const audioOf = (c: TimelineClip) => (c.linkedClipIds ?? []).map((i) => byId.get(i)).filter((x): x is TimelineClip => !!x && x.type === 'audio');
    const vids = sel.filter((c) => c.type !== 'audio');
    const audios = [...new Map([...sel.filter((c) => c.type === 'audio'), ...vids.flatMap(audioOf)].map((c) => [c.id, c])).values()];
    const gids = selectedGroup(), gclips = gids.map((i) => byId.get(i)).filter((x): x is TimelineClip => !!x);
    const linked = sel.some((c) => c.linkedClipIds?.length);
    const allMuted = audios.length > 0 && audios.every((c) => c.muted);
    const run = (f: (s: ReturnType<typeof getState>, id: string) => ReturnType<typeof getState>, ids: string[]) => edit(store, (x) => ids.reduce((acc, id) => f(acc, id), x));
    const items: MenuItem[] = [
      { header: 'Edit' },
      { label: 'Split at the playhead', icon: 'split', hint: bindOf('timeline.split'), onClick: () => edit(store, (x) => A.splitClipsAtTime(x, gids, t)) },
      { label: 'Delete', icon: 'trash', hint: bindOf('timeline.delete'), onClick: () => edit(store, (x) => A.deleteClips(x, gids)) },
      { label: 'Ripple delete (close the gap)', icon: 'ripple', hint: bindOf('timeline.rippleDelete'), onClick: () => rippleDelete(store, gids) },
      { label: 'Duplicate', icon: 'copy', onClick: () => edit(store, (x) => A.duplicateClips(x, gids)) },
      { header: 'Link and sound' },
    ];
    if (linked) items.push({ icon: 'unlink', label: 'Unlink audio and video', title: 'Then each can be selected, moved and deleted on its own', onClick: () => run((x, id) => A.unlinkClipGroup(x, id), sel.map((c) => c.id)) });
    if (sel.length >= 2 && !sel.every((c) => (c.linkedClipIds ?? []).some((i) => sel.some((o) => o.id === i)))) items.push({ icon: 'link', label: 'Link selected clips', title: 'They then move, split and delete together', onClick: () => edit(store, (x) => A.linkClips(x, sel.map((c) => c.id))) });
    if (vids.some((c) => audioOf(c).length)) {
      items.push({ icon: 'trash', label: 'Delete the audio only', onClick: () => edit(store, (x) => A.deleteClips(x, vids.flatMap(audioOf).map((c) => c.id))) });
      items.push({ icon: 'trash', label: 'Delete the video only (keep the audio)', onClick: () => edit(store, (x) => A.deleteClips(x, vids.filter((c) => audioOf(c).length).map((c) => c.id))) });
    }
    if (audios.length) {
      items.push({ icon: allMuted ? 'vol' : 'mute', label: allMuted ? 'Unmute the audio' : 'Mute the audio', onClick: () => run((x, id) => A.setClipAudioMuted(x, id, !allMuted), audios.map((c) => c.id)) });
      items.push({ icon: 'vol', label: 'Audio volume…', onClick: () => setDlg({ title: 'Audio volume', fields: [{ key: 'v', label: 'Volume (%)', type: 'number', value: Math.round((audios[0]!.volume === undefined ? 1 : audios[0]!.volume > 1 ? audios[0]!.volume / 100 : audios[0]!.volume) * 100) }], ok: (v) => { setDlg(null); run((x, id) => A.setClipAudioLevel(x, id, Math.max(0, Math.min(100, Number(v.v) || 0)) / 100), audios.map((c) => c.id)); } }) });
    }
    items.push({ header: 'Change' });
    items.push({ icon: 'clock', label: 'Speed…', title: 'Changes the speed of the clip and its linked audio; the clip gets shorter or longer to match', onClick: () => setDlg({ title: 'Clip speed', fields: [{ key: 'v', label: 'Speed (1 = normal, 2 = twice as fast, 0.5 = half)', type: 'number', value: gclips[0]?.speed ?? 1 }], ok: (v) => {
      setDlg(null); const sp = Math.max(0.1, Math.min(8, Number(v.v) || 1));
      edit(store, (x) => setSpeed(x, gclips.map((c) => c.id), sp, ripple));
    } }) });
    const assetIds = [...new Set(vids.map((c) => c.assetId).filter((x): x is string => !!x))];
    const rj = assetIds.length === 1 ? jobOfAsset(jobs, assetIds[0]!) : undefined;
    if (rj) items.push({ icon: 'regen', label: 'Regenerate…', title: 'Make new results with the same settings: a quick batch, or open the whole form to change things. They land on the canvas.', onClick: () => setRegen({ job: rj, origin: board.items.find((i) => i.kind === 'asset' && i.ref === assetIds[0])?.id }) });
    const pair = [...new Map(vids.filter((c) => c.type === 'video' && c.assetId).map((c) => [c.assetId, c])).values()].sort((x, y) => x.startTime - y.startTime);
    const oneClip = [...new Map(vids.filter((c) => c.type === 'video' && c.assetId).map((c) => [c.assetId, c])).values()];
    items.push({ header: 'Chain' });
    if (oneClip.length === 1) {
      if (profiles.some((x) => x.slots.some((s) => s.role === 'guide_start'))) items.push({ icon: 'cont', recommended: true, label: 'Continue with held frames', title: 'A new clip that carries on from the end of this one: its last 22 frames anchor the start, so motion, light and place carry over. Placed after the clip when the space is free.', onClick: () => void continueClip(oneClip[0]!, true) });
      items.push({ icon: 'cont', label: 'Continue from last frame only', title: 'A new clip that starts from the last frame of this one', onClick: () => void continueClip(oneClip[0]!, false) });
    }
    items.push({ icon: 'chart', label: 'Check continuity of the whole timeline…', title: 'Measures every video clip and join in playing order, lists what looks irregular and offers a fix for each', onClick: () => {
      const clips = selectClips(getState(store)).filter((c) => c.type === 'video' && c.assetId).sort((x, y) => x.startTime - y.startTime);
      if (!clips.length) return notify('No video clips on the timeline.');
      openContinuity({ title: `Continuity of the timeline (${clips.length} clips)`, items: clips.map((c) => ({ assetId: c.assetId!, clipId: c.id })),
        // ripple: a remade bridge is shorter (its repeated end is gone), so later clips move up instead of leaving a gap; same-length fixes move nothing
        replace: async (clipId, assetId) => { await syncEditorAssets(store); return replaceClip(store, clipId, assetId, true); },
        dissolve: (l, r) => edit(store, (x) => A.addCrossDissolve(x, l, r)),
        setAudio: (clipId, prevId, deltaDb) => {
          // louder clip: lower it; quieter clip: raise it if its level has room, otherwise lower the clip before it
          const lvl = (c: TimelineClip) => (c.volume === undefined ? 1 : c.volume > 1 ? c.volume / 100 : c.volume);
          edit(store, (x) => {
            const all = selectClips(x);
            const audioOf = (id: string) => { const v = all.find((c) => c.id === id); return all.filter((c) => c.type === 'audio' && (v?.linkedClipIds ?? []).includes(c.id)); };
            const apply = (s: typeof x, id: string, g: number) => audioOf(id).reduce((st, a) => A.setClipAudioLevel(st, a.id, Math.max(0, Math.min(1, lvl(a) * g))), s);
            const g = 10 ** (-deltaDb / 20);
            const cur = Math.min(...audioOf(clipId).map(lvl), 1);
            return g <= 1 || cur * g <= 1 ? apply(x, clipId, g) : apply(x, prevId, 1 / g);
          });
        } });
    } });
    if (pair.length === 2 && profiles.some((x) => x.slots.some((s) => s.role === 'guide_end'))) items.push({ icon: 'bridge', recommended: true, label: 'Bridge with held frames', title: 'The end of the first clip and the start of the second anchor both ends of the new clip, so motion and light carry over.', onClick: () => void bridgeHeld(pair[0]!, pair[1]!) });
    if (pair.length === 2) items.push({ icon: 'bridge', label: 'Bridge with first/last frame only', title: 'Make a new clip that connects the end of the first to the start of the second (opens the Generate form)', onClick: () => void bridge(pair[0]!, pair[1]!) });
    const canvasPick = canvasAssets.length === 1 ? assets.get(canvasAssets[0]!) : undefined;
    const oneVid = vids.length === 1 || (vids.length > 0 && vids.every((c) => c.assetId === vids[0]!.assetId)) ? vids[0] : undefined;
    if (oneVid && canvasPick && canvasPick.kind !== 'audio' && canvasPick.id !== oneVid.assetId) items.push({ icon: 'restore', label: 'Replace with the canvas selection', title: 'Puts the clip selected on the canvas in the place of this clip (same spot on the timeline, its audio too). The old one stays on the canvas and in the Library.', onClick: () => { void joinForTimeline(store, [canvasPick.id]).then(([jid]) => { for (const c of vids) replaceClip(store, c.id, jid!, ripple); notify('Replaced on the timeline'); }); } });
    items.push({ header: 'Picture' });
    items.push({ icon: 'loop', label: 'Reverse', onClick: () => run((x, id) => A.toggleClipReverse(x, id), gids) });
    if (vids.length) items.push({ icon: 'resize', label: 'Flip horizontally', onClick: () => run((x, id) => A.setClipFlipH(x, id, !byId.get(id)?.flipH), vids.map((c) => c.id)) });
    items.push({ sep: true }, { label: 'Select all', icon: 'grid', hint: 'Ctrl+A', onClick: selectAll }, { label: 'Clear all…', icon: 'trash', danger: true, onClick: () => void clearAll() });
    return items;
  };

  // ---------- keys ----------
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement; if (['TEXTAREA', 'INPUT', 'SELECT'].includes(el.tagName)) return;
      if (!document.querySelector('.timelineWrap:hover, .timelineWrap:focus-within') && !document.fullscreenElement) return;
      const s = getState(store);
      if (hit(e, 'timeline.split')) {
        const ids = selected.size ? selectedGroup() : selectClips(s).filter((c) => c.startTime < t && c.startTime + c.duration > t).map((c) => c.id);
        edit(store, (x) => A.splitClipsAtTime(x, ids, t)); e.preventDefault();
      } else if (hit(e, 'timeline.delete') || hit(e, 'timeline.rippleDelete') || e.key === 'Backspace') {
        const ids = selectedGroup(); if (!ids.length) return;
        e.preventDefault(); if (hit(e, 'timeline.rippleDelete')) rippleDelete(store, ids); else edit(store, (x) => A.deleteClips(x, ids));
      } else if (e.shiftKey && !e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); fitAll();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAll();
      } else if (hit(e, 'timeline.grab')) { void grabFrame();
      } else if (hit(e, 'timeline.play')) { e.preventDefault(); store.getState().setStateWithoutHistory((x) => A.togglePlayPause(x)); }
      else if (hit(e, 'timeline.prevFrame')) { e.preventDefault(); setTime(t - 1 / 24); }
      else if (hit(e, 'timeline.nextFrame')) { e.preventDefault(); setTime(t + 1 / 24); }
      else if (hit(e, 'timeline.prevSecond')) { e.preventDefault(); setTime(t - 1); }
      else if (hit(e, 'timeline.nextSecond')) { e.preventDefault(); setTime(t + 1); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  });

  /* ---- export: options are remembered; the file goes straight into the project's exports folder unless "ask where" is on ---- */
  type XSet = { quality: keyof typeof XQ; res: string; fps: string; audio: number; name: string; ask: boolean };
  const [xs, setXs] = useState<XSet>(() => { try { return { ...XDEF, ...JSON.parse(localStorage.getItem('driftboard.export') ?? '{}') } as XSet; } catch { return XDEF; } });
  const setX = (p: Partial<XSet>) => setXs((c) => { const n = { ...c, ...p }; try { localStorage.setItem('driftboard.export', JSON.stringify(n)); } catch { /* ignore */ } return n; });
  const [xOpen, setXOpen] = useState(() => takeExportRequest());
  useEffect(() => { const f = () => { exportPending = false; setXOpen(true); }; window.addEventListener('driftboard-export-open', f); return () => window.removeEventListener('driftboard-export-open', f); }, []);
  const [xDir, setXDir] = useState('');
  useEffect(() => { if (xOpen) void api.exportsDir().then(setXDir); }, [xOpen]);
  const basePlan = xOpen || exporting !== null ? buildRenderPlan(getState(store), (id) => id) : null;
  const finalSize = (bp: { width: number; height: number }) => { if (xs.res === 'timeline') return { w: bp.width, h: bp.height }; const h = Number(xs.res); const w = Math.round((bp.width * h) / bp.height / 2) * 2; return { w, h: Math.round(h / 2) * 2 }; };
  const doExport = async () => {
    setMsg('');
    try {
      const plan = buildRenderPlan(getState(store), (id) => id);
      const fz = finalSize(plan);
      const q = XQ[xs.quality];
      const full = { ...plan, width: fz.w, height: fz.h, fps: xs.fps === 'timeline' ? plan.fps : Number(xs.fps), crf: q.crf, preset: q.preset, audioKbps: xs.audio };
      setXOpen(false); setExporting(0);
      const off = api.onExportProgress((f) => setExporting(f));
      const r = await api.exportTimeline(full, { name: xs.name || undefined, ask: xs.ask });
      off(); setExporting(null);
      if (r.ok) setMsg(`Exported to ${r.path}`); else if (!r.cancelled) setMsg(`Export failed: ${r.error}`);
      if (r.ok) setLast(r.path);
    } catch (e) { setExporting(null); setMsg((e as Error).message); }
  };
  const [last, setLast] = useState('');

  const ticks = useMemo(() => { const step = pps >= 80 ? 1 : pps >= 30 ? 5 : pps >= 12 ? 10 : 30; return Array.from({ length: Math.ceil(width / pps / step) + 1 }, (_, i) => i * step); }, [pps, width]);
  const canUndo = state.history.undoStack.length > 0, canRedo = state.history.redoStack.length > 0;
  useEffect(() => { undoChanged(); }, [state.history.undoStack.length, state.history.redoStack.length]);
  const tl = selectActiveTimeline(state);

  const scrub = (e: React.PointerEvent) => {
    onFocus();
    const el = scroller.current!; const rect = el.getBoundingClientRect();
    const at = (x: number) => setTime((x - rect.left + el.scrollLeft - LABEL) / pps);
    at(e.clientX); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const mv = (ev: PointerEvent) => at(ev.clientX), up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };

  /** Save the frame under the playhead (the selected clip, else the top video clip there) as an image on the canvas. */
  const grabFrame = async () => {
    const here = clips.filter((c) => c.type === 'video' && c.assetId && c.startTime <= t && t < c.startTime + c.duration);
    const c = here.find((x) => selected.has(x.id)) ?? here.sort((a, b) => b.trackIndex - a.trackIndex)[0];
    if (!c) { setMsg('Move the playhead over a video clip first.'); return; }
    const fps = assets.get(c.assetId!)?.fps ?? 24;
    const r = await api.frameExtract(c.assetId!, { frame: Math.max(0, Math.round((c.trimStart + (t - c.startTime) * (c.speed || 1)) * fps)) });
    setMsg(r.ok ? 'Frame saved to the canvas' : r.error);
  };

  const split = () => { const ids = selected.size ? selectedGroup() : clips.filter((c) => c.startTime < t && c.startTime + c.duration > t).map((c) => c.id); edit(store, (x) => A.splitClipsAtTime(x, ids, t)); };
  const moreItems: UiMenuItem[] = [
    { label: 'Select all', icon: 'grid', hint: 'Ctrl+A', disabled: !clips.length, onClick: selectAll },
    { label: 'Clear all…', icon: 'trash', danger: true, disabled: !clips.length, sub: 'Undo brings the clips back', onClick: () => void clearAll() },
  ];
  const clipName = (c: TimelineClip, asset?: ReturnType<typeof assets.get>) => (asset ? assetName(asset, story.meta, takeOf.get(asset.id)?.shot.name) : c.type);
  return (
    <div className="tlWrap" onPointerDown={onFocus}>
      <div className="tlbar" role="toolbar" aria-label="Timeline">
        <div className="grp">
          <IconButton size="sm" kind="secondary" icon={playing ? 'pause' : 'play'} label={`${playing ? 'Pause' : 'Play'} the film (${bindOf('timeline.play')})`} onClick={() => store.getState().setStateWithoutHistory((x) => A.togglePlayPause(x))} />
          <span className="tc mono" title={`${tl?.name ?? 'Timeline'} · ${clips.length} clips`}><b>{fmt(t)}</b> <span>/ {fmt(end)}</span></span>
        </div>
        <span className="vsep" />
        <div className="grp">
          <Button size="sm" kind="quiet" icon="split" title={`Split at the playhead (${bindOf('timeline.split')})`} onClick={split}><span className="t">Split</span></Button>
          <Button size="sm" kind="quiet" icon="trash" title={`Delete (${bindOf('timeline.delete')})`} disabled={!selected.size} onClick={() => edit(store, (x) => A.deleteClips(x, selectedGroup()))}><span className="t">Delete</span></Button>
          <Button size="sm" kind="quiet" icon="ripple" title={`Delete and close the gap (${bindOf('timeline.rippleDelete')})`} disabled={!selected.size} onClick={() => rippleDelete(store, selectedGroup())}><span className="t">Ripple delete</span></Button>
        </div>
        <span className="vsep" />
        <Button size="sm" kind="quiet" icon="grab" title={`Save the frame under the playhead as a picture on the canvas (${bindOf('timeline.grab')})`} onClick={() => void grabFrame()}><span className="t">Grab frame</span></Button>
        <span className="vsep" />
        <div className="grp">
          <Button size="sm" kind="quiet" icon="snap" on={snap} title="Clips stick to neighbours and the playhead" onClick={() => store.getState().setStateWithoutHistory((x) => A.toggleSnap(x))}><span className="t">Snap</span></Button>
          <Button size="sm" kind="quiet" icon="ripple" on={ripple} title="Ripple: when a clip gets shorter or longer (speed change or dragging its edge), the clips after it move along, so no gaps or overlaps appear and nothing is cut." onClick={() => setRipple(!ripple)}><span className="t">Ripple</span></Button>
        </div>
        <span className="sp" />
        <VolumeSlider />
        <span className="vsep" />
        <div className="grp">
          <IconButton size="sm" icon="minus" label="Zoom out (Ctrl+wheel zooms around the pointer)" onClick={() => zoomTo(pps / 1.4)} />
          <span className="mono xs dim zoomv">{Math.round(pps)} px/s</span>
          <IconButton size="sm" icon="plus" label="Zoom in" onClick={() => zoomTo(pps * 1.4)} />
          <Button size="sm" kind="quiet" title="Fit the whole film (Shift+Z)" onClick={fitAll}>Fit</Button>
          <Button size="sm" kind="quiet" title="Fit the selected clips" disabled={!selected.size} onClick={fitSelection}>Selection</Button>
          <Button size="sm" kind="quiet" title="Scroll so the playhead is in the middle" onClick={centerPlayhead}>Playhead</Button>
        </div>
        <span className="vsep" />
        <IconButton size="sm" icon="more" label="More: select all, clear all" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMore({ x: r.right - 240, y: r.top - 110 }); }} />
        {more && <Menu x={more.x} y={more.y} items={moreItems} onClose={() => setMore(null)} />}
        {exporting === null
          ? <button ref={xBtn} type="button" className="btn sm pri" aria-haspopup="dialog" aria-expanded={xOpen} onClick={() => setXOpen(!xOpen)}><Icon name="export" size="s" /><span className="t2">Export…</span></button>
          : <span className="row exportRun"><Spinner /><span className="mono xs">Exporting {Math.round(exporting * 100)}%</span><Progress value={exporting} label="Export" style={{ width: 70 }} /><Button size="sm" onClick={() => void api.exportCancel()}>Cancel</Button></span>}
        <IconButton size="sm" icon="chev" label="Hide the timeline" onClick={onCollapse} />
      </div>
      {xOpen && basePlan && xBtn.current && (() => { const fz = finalSize(basePlan); return (
        <Popover anchor={xBtn.current} align="end" onClose={() => setXOpen(false)} title="Export the film" width={360} style={{ top: Math.max(60, xBtn.current.getBoundingClientRect().top - 470) }}>
          <FieldBox label="File name"><input className="inp" value={xs.name} placeholder={tl?.name && tl.name !== 'Main' ? tl.name : "(the project's name)"} onChange={(e) => setX({ name: e.target.value })} /></FieldBox>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <FieldBox label="Quality" style={{ flex: 1 }}><select className="selc" value={xs.quality} onChange={(e) => setX({ quality: e.target.value as XSet['quality'] })}>{Object.entries(XQ).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></FieldBox>
            <FieldBox label="Resolution" style={{ flex: 1 }}><select className="selc" value={xs.res} onChange={(e) => setX({ res: e.target.value })}><option value="timeline">As the timeline ({basePlan.width}×{basePlan.height})</option><option value="720">720p</option><option value="1080">1080p</option><option value="1440">1440p</option><option value="2160">4K (2160p)</option></select></FieldBox>
          </div>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <FieldBox label="Frame rate" style={{ flex: 1 }}><select className="selc" value={xs.fps} onChange={(e) => setX({ fps: e.target.value })}><option value="timeline">As the timeline ({basePlan.fps} fps)</option><option value="24">24</option><option value="25">25</option><option value="30">30</option><option value="60">60</option></select></FieldBox>
            <FieldBox label="Audio" style={{ flex: 1 }}><select className="selc" value={xs.audio} onChange={(e) => setX({ audio: Number(e.target.value) })}>{[128, 192, 256, 320].map((n) => <option key={n} value={n}>{n} kbit/s</option>)}</select></FieldBox>
          </div>
          <div className="mono xs" style={{ color: 'var(--text)' }}>→ {fz.w}×{fz.h} · {xs.fps === 'timeline' ? basePlan.fps : xs.fps} fps · H.264 + AAC (MP4) · {fmt(basePlan.duration)}</div>
          {fz.h > basePlan.height && <Notice tone="warn">That is larger than the timeline's own size: clips are scaled up, not sharper.</Notice>}
          <label className="check"><input type="checkbox" checked={xs.ask} onChange={(e) => setX({ ask: e.target.checked })} />Ask where to save each time</label>
          {!xs.ask && <span className="xs faint">Saved in <span className="mono pathText">{xDir}</span>, never over an earlier export. <button type="button" className="linkBtn" onClick={() => void api.reveal(xDir)}>Open folder</button></span>}
          {!clips.length && <Notice>Add clips to the timeline first.</Notice>}
          <div className="row"><span className="sp" /><Button kind="quiet" onClick={() => setXOpen(false)}>Close</Button><Button kind="primary" icon="export" disabled={!clips.length} onClick={() => void doExport()}>Export</Button></div>
        </Popover>); })()}
      {msg && <div className="tlMsg row"><Icon name={msg.startsWith('Export failed') ? 'warn' : 'info'} size="s" /><span className="small" style={{ flex: 1 }}>{msg}</span>{last && msg.startsWith('Exported') && <Button size="sm" kind="quiet" onClick={() => void api.reveal(last)}>Show in folder</Button>}<IconButton size="sm" icon="x" label="Dismiss" onClick={() => setMsg('')} /></div>}
      <div className="tlScroll" ref={scroller}>
        <div className="tlInner" ref={inner} style={{ width: width + LABEL }}>
          <div className="ruler" onPointerDown={scrub} style={{ paddingLeft: LABEL }}>
            {ticks.map((s) => <div key={s} className="tick" style={{ left: LABEL + s * pps }}><span>{fmt(s)}</span></div>)}
          </div>
          {tracks.map((entry) => (
            <div className="trackRow" key={entry.track.id} style={{ height: entry.track.kind === 'audio' ? ROW - 12 : ROW }}>
              <div className="trackLabel" style={{ width: LABEL }}>
                <b>{entry.track.name}</b><span className="sp" />
                {entry.track.kind === 'audio' && <IconButton size="sm" icon={entry.track.muted ? 'mute' : 'vol'} on={entry.track.muted} label={entry.track.muted ? `Unmute ${entry.track.name}` : `Mute ${entry.track.name} (preview and export)`} onClick={() => edit(store, (x) => A.toggleTrackMute(x, entry.track.id))} />}
                {entry.track.kind === 'video' && <IconButton size="sm" icon={entry.track.enabled === false ? 'eyeoff' : 'eye'} on={entry.track.enabled === false} label={entry.track.enabled === false ? `Show ${entry.track.name}` : `Hide ${entry.track.name}`} onClick={() => edit(store, (x) => A.toggleTrackEnabled(x, entry.track.id))} />}
              </div>
              <div className={'trackBody' + (drag?.row === entry.displayRow ? ' dropTarget' : '')} onPointerDown={startBox} onContextMenu={(e) => { store.getState().setStateWithoutHistory((x) => A.clearClipSelection(x)); openMenu(e); }}>
                {clips.filter((c) => c.trackIndex === entry.realIndex).map((c) => {
                  const asset = c.assetId ? assets.get(c.assetId) : undefined;
                  const dragging = drag && drag.ids.includes(c.id);
                  let left = c.startTime, w = c.duration;
                  if (dragging) { if (drag.kind === 'move') left += drag.dt; else if (drag.kind === 'start') { left += drag.dt; w -= drag.dt; } else w += drag.dt; }
                  const vol = c.volume === undefined ? 1 : c.volume > 1 ? c.volume / 100 : c.volume;
                  return (
                    <div key={c.id} className={`clip ${c.type}${selected.has(c.id) ? ' sel' : ''}${dragging ? ' dragging' : ''}${c.muted ? ' muted' : ''}`}
                      style={{ left: left * pps, width: Math.max(4, w * pps), backgroundImage: c.type !== 'audio' && asset ? `url(${thumbUrl(asset.id)})` : undefined }}
                      onPointerDown={(e) => { if (e.button === 0) startDrag(e, c, 'move'); else e.stopPropagation(); }} onContextMenu={(e) => openMenu(e, c)} onPointerMove={(e) => onMove(e, c)} onPointerUp={() => onUp(c)}>
                      {c.transitionIn?.type === 'dissolve' && <span className="dissolve in" style={{ width: Math.max(6, c.transitionIn.duration * pps) }} title={`Dissolve in (${c.transitionIn.duration.toFixed(1)} s)`} />}
                      {c.transitionOut?.type === 'dissolve' && <span className="dissolve out" style={{ width: Math.max(6, c.transitionOut.duration * pps) }} title={`Dissolve out (${c.transitionOut.duration.toFixed(1)} s)`} />}
                      <div className="handle l" onPointerDown={(e) => startDrag(e, c, 'start')} onPointerMove={(e) => onMove(e, c)} onPointerUp={() => onUp(c)} />
                      <span className="clipLabel">{c.type === 'audio' && <Icon name="sound" size={11} />}{clipName(c, asset)}</span>
                      <span className="fx">
                        {c.speed !== 1 && <i title="Speed">×{c.speed}</i>}
                        {c.type === 'audio' && vol !== 1 && <i title="Audio volume">{Math.round(vol * 100)}%</i>}
                        {c.reversed && <i title="Reversed"><Icon name="loop" size={10} /></i>}
                        {c.flipH && <i title="Flipped horizontally">flip</i>}
                        {(c.type === 'video' || c.type === 'audio') && <i className="lk"><LinkIcon on={!!c.linkedClipIds?.length} /></i>}
                      </span>
                      <div className="handle r" onPointerDown={(e) => startDrag(e, c, 'end')} onPointerMove={(e) => onMove(e, c)} onPointerUp={() => onUp(c)} />
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {box && <div className="marquee" style={{ left: Math.min(box.x0, box.x1), top: Math.min(box.y0, box.y1), width: Math.abs(box.x1 - box.x0), height: Math.abs(box.y1 - box.y0) }} />}
          <div className="playhead" style={{ left: LABEL + t * pps }}><i /></div>
          {!clips.length && <div className="tlEmpty">Select clips on the canvas and choose Add to timeline.</div>}
        </div>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems()} onClose={() => setMenu(null)} />}
      {regen && <RegenerateDialog job={regen.job} profiles={profiles} origin={regen.origin} openDraft={openDraft} notify={notify} onClose={() => setRegen(null)} />}
      {dlg && <ParamDialog title={dlg.title} fields={dlg.fields} onOk={dlg.ok} onCancel={() => setDlg(null)} />}
    </div>
  );
}
