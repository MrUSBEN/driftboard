import { useContext, useEffect, useRef, useState } from 'react';
import { actions as A, selectClips, selectCurrentTime, selectIsPlaying, selectActiveTimeline, timelineEnd, getState, type TimelineClip } from '@driftboard/editor';
import { C, proxyUrl, assetUrl, getVolume } from './shared.tsx';
import { useEditorState, useStore } from './editorBridge.tsx';

/**
 * Plays the timeline in the preview: the top-most visual clip at the playhead, taken from its proxy.
 * Two video elements take turns so the next clip is ready before the cut. Audio comes from that video
 * (separate audio-only clips are not heard in the preview yet; the export does mix them).
 */
const volOf = (c?: TimelineClip) => (c?.volume === undefined ? 1 : c.volume > 1 ? c.volume / 100 : c.volume);

export function TimelinePlayer() {
  const store = useStore();
  const state = useEditorState();
  const { assets } = useContext(C);
  const els = [useRef<HTMLVideoElement>(null), useRef<HTMLVideoElement>(null)];
  const holds = useRef<(string | null)[]>([null, null]);   // clip id loaded in each element
  const activeEl = useRef(0);
  const repaint = useRef(new Set<number>());   // elements that were hidden and need a fresh frame
  const lastTime = useRef(-1);
  const [preparing, setPreparing] = useState(0);
  const t = selectCurrentTime(state), playing = selectIsPlaying(state);
  const clock = useRef({ wall: 0, time: 0 });
  const tl = selectActiveTimeline(state);

  const visual = (time: number): { clip: TimelineClip; kind: 'video' | 'image' } | null => {
    const s = getState(store); const tr = selectActiveTimeline(s)?.tracks ?? [];
    let best: TimelineClip | null = null;
    for (const c of selectClips(s)) {
      if (c.type !== 'video' && c.type !== 'image') continue;
      const track = tr[c.trackIndex]; if (!track || track.kind === 'audio' || track.enabled === false) continue;
      if (time >= c.startTime && time < c.startTime + c.duration && (!best || c.trackIndex > best.trackIndex || (c.trackIndex === best.trackIndex && c.startTime > best.startTime))) best = c;
    }
    return best ? { clip: best, kind: best.type === 'image' ? 'image' : 'video' } : null;
  };
  const nextVideo = (time: number): TimelineClip | null => {
    let best: TimelineClip | null = null;
    for (const c of selectClips(getState(store))) if (c.type === 'video' && c.startTime > time && c.startTime - time < 1.5 && (!best || c.startTime < best.startTime)) best = c;
    return best;
  };

  /** Audio-only clips with no video (music, voice) play from their own elements. */
  const auds = useRef(new Map<string, HTMLAudioElement>());
  const syncAudio = (time: number, play: boolean) => {
    const s = getState(store); const tr = selectActiveTimeline(s)?.tracks ?? []; const active = new Set<string>();
    for (const c of selectClips(s)) {
      if (c.type !== 'audio' || !c.assetId || c.linkedClipIds?.length) continue;
      const track = tr[c.trackIndex]; if (!track || track.muted || c.muted || track.enabled === false) continue;
      if (time < c.startTime || time >= c.startTime + c.duration) continue;
      active.add(c.id);
      let el = auds.current.get(c.id); if (!el) { el = new Audio(); el.src = assetUrl(c.assetId); auds.current.set(c.id, el); }
      const want = c.trimStart + (time - c.startTime) * (c.speed || 1);
      if (Math.abs(el.currentTime - want) > (play ? 0.3 : 0.05)) el.currentTime = want;
      el.playbackRate = c.speed || 1; el.volume = Math.min(1, volOf(c) * getVolume());
      if (play && el.paused) void el.play().catch(() => {}); else if (!play && !el.paused) el.pause();
    }
    for (const [id, el] of auds.current) if (!active.has(id) && !el.paused) el.pause();
  };
  useEffect(() => () => { for (const el of auds.current.values()) el.pause(); }, []);

  const place = (idx: number, c: TimelineClip, time: number, play: boolean) => {
    const el = els[idx].current; if (!el || !c.assetId) return;
    const want = c.trimStart + Math.max(0, time - c.startTime) * (c.speed || 1);
    el.dataset.want = String(want);   // always the latest wanted time: a clip that is still loading seeks to where the playhead is NOW, not where it was
    const now = Date.now();
    const reload = () => { holds.current[idx] = null; el.dataset.retryAt = '0'; el.removeAttribute('src'); el.load(); };
    if (holds.current[idx] !== c.id) {
      if (el.dataset.retryAt && now < Number(el.dataset.retryAt)) return;
      holds.current[idx] = c.id; el.dataset.loadAt = String(now); el.dataset.stuck = '0';
      const src = proxyUrl(c.assetId); el.src = src;
      const seekNow = () => { if (el.src === src || el.currentSrc === src) el.currentTime = Number(el.dataset.want); };
      el.onloadedmetadata = seekNow;
      el.onloadeddata = () => { if (Math.abs(el.currentTime - Number(el.dataset.want)) > 0.05) seekNow(); };   // metadata alone is sometimes not enough to land the seek
      el.onerror = () => { if (holds.current[idx] === c.id) { holds.current[idx] = null; el.dataset.retryAt = String(Date.now() + 1500); } };   // the preview copy was not ready: ask again shortly
    } else if (el.readyState >= 1) {
      if (repaint.current.has(idx)) { repaint.current.delete(idx); el.currentTime = want + 0.0001; }   // shown again after being hidden: a seek makes the browser draw the frame
      else if (Math.abs(el.currentTime - want) > (play ? 0.25 : 0.02)) el.currentTime = want;
      // watchdog: a clip that has been shown but has no picture (a seek that never landed) is loaded again from scratch
      if (el.readyState < 2 && !el.seeking) { const since = Number(el.dataset.stuck || 0); if (!since) el.dataset.stuck = String(now); else if (now - since > 2000) reload(); } else el.dataset.stuck = '0';
    } else {
      const since = Number(el.dataset.loadAt || now);
      if (now - since > 6000) reload();   // nothing arrived: try again
    }
    el.playbackRate = c.speed || 1;
    // what is heard is what the export mixes: the clip's linked audio clip (unless it is muted, deleted or on a muted track)
    const st = getState(store), trs = selectActiveTimeline(st)?.tracks ?? [], all = selectClips(st);
    const au = (c.linkedClipIds ?? []).map((id) => all.find((x) => x.id === id)).find((x) => x?.type === 'audio');
    const at = au ? trs[au.trackIndex] : undefined;
    el.muted = !au || !!au.muted || !!at?.muted || at?.enabled === false;
    el.volume = Math.min(1, volOf(au) * getVolume());
    if (play && el.paused) void el.play().catch(() => {}); else if (!play && !el.paused) el.pause();
  };

  // frame loop
  useEffect(() => {
    let raf = 0;
    clock.current = { wall: performance.now(), time: getState(store).session.transport.currentTime };
    const tick = () => {
      const s = getState(store);
      let time = s.session.transport.currentTime;
      if (s.session.transport.isPlaying) {
        // the playhead was moved (click on the ruler or the track) while playing: continue from there
        if (Math.abs(time - lastTime.current) > 0.001) clock.current = { wall: performance.now(), time };
        time = clock.current.time + (performance.now() - clock.current.wall) / 1000;
        const end = timelineEnd(s);
        if (time >= end) { store.getState().setStateWithoutHistory((x) => A.pause(A.setCurrentTime(x, end))); return; }
        store.getState().setStateWithoutHistory((x) => A.setCurrentTime(x, time)); lastTime.current = time;
      } else { clock.current = { wall: performance.now(), time }; lastTime.current = time; }
      render(time, s.session.transport.isPlaying);
      raf = requestAnimationFrame(tick);
    };
    const render = (time: number, play: boolean) => {
      syncAudio(time, play);
      const cur = visual(time);
      const stage = document.querySelector<HTMLElement>('.tlStage');
      const img = stage?.querySelector<HTMLImageElement>('img');
      if (cur?.kind === 'image' && cur.clip.assetId) { if (img) { img.style.display = 'block'; if (img.dataset.id !== cur.clip.assetId) { img.dataset.id = cur.clip.assetId; img.src = assetUrl(cur.clip.assetId); } } els.forEach((e) => { if (e.current) e.current.style.visibility = 'hidden'; }); els.forEach((e, i) => { if (e.current && !e.current.paused) e.current.pause(); holds.current[i] = holds.current[i]; }); return; }
      if (img) img.style.display = 'none';
      if (!cur) { els.forEach((e, i) => { if (e.current) { e.current.style.opacity = '0'; e.current.pause(); repaint.current.add(i); } }); return; }
      let a = holds.current.indexOf(cur.clip.id);
      if (a < 0) a = 1 - activeEl.current;
      activeEl.current = a;
      place(a, cur.clip, time, play);
      els.forEach((e, i) => { if (e.current) e.current.style.opacity = i === a ? '1' : '0'; });
      const nx = nextVideo(time);   // warm the other element
      if (nx && holds.current.indexOf(nx.id) < 0) place(1 - a, nx, nx.startTime, false);
      const other = els[1 - a].current; if (other && !other.paused && holds.current[1 - a] !== cur.clip.id) other.pause();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [store, playing]);

  // clock restarts whenever play starts or the playhead is moved while playing
  useEffect(() => { clock.current = { wall: performance.now(), time: getState(store).session.transport.currentTime }; }, [playing, store]);

  // make every preview copy before it is needed (the first request builds it), one after the other
  const warmed = useRef(new Set<string>());
  const ids = [...new Set(selectClips(state).filter((c) => c.type === 'video' && c.assetId).map((c) => c.assetId!))].join(',');
  useEffect(() => {
    let dead = false;
    const todo = ids.split(',').filter((id) => id && !warmed.current.has(id));
    setPreparing(todo.length);
    void (async () => {
      for (const [i, id] of todo.entries()) {
        if (dead) return;
        try { await fetch(proxyUrl(id), { headers: { Range: 'bytes=0-0' } }); warmed.current.add(id); } catch { /* retried when needed */ }
        if (!dead) setPreparing(todo.length - i - 1);
      }
    })();
    return () => { dead = true; };
  }, [ids]);
  void t; void tl;
  const first = selectClips(state).filter((c) => c.type === 'video' || c.type === 'image').map((c) => (c.assetId ? assets.get(c.assetId) : undefined)).find((a) => a?.width);
  const aspect = first?.width && first.height ? `${first.width} / ${first.height}` : '16 / 9';
  return (
    <div className="previewCol">
      <div className="stage tlStage">
        <button className="fsBtn" title="Full screen (P)" onClick={(e) => { const st = (e.currentTarget.closest('.stage') as HTMLElement); void (document.fullscreenElement ? document.exitFullscreen() : st.requestFullscreen()); }}>⛶</button>
        <div className="frame" style={{ aspectRatio: aspect }}>
          <video ref={els[0]} preload="auto" playsInline style={{ opacity: 0 }} />
          <video ref={els[1]} preload="auto" playsInline style={{ opacity: 0 }} />
          <img style={{ display: 'none' }} />
        </div>
      </div>
      <div className="note">Timeline preview (proxy quality). Space plays, click the ruler or an empty part of a track to jump there (also while playing). P = full screen.{preparing > 0 && ` Preparing ${preparing} preview cop${preparing === 1 ? 'y' : 'ies'}…`}</div>
    </div>
  );
}
