import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import wordmark from './brand/driftboard-wordmark-light.svg';
import { FoldBar } from './View.tsx';
import { ReactFlowProvider } from '@xyflow/react';
import { AskHost } from './Ask.tsx';
import { ContinuityHost } from './Continuity.tsx';
import { NotesPanel, type Note } from './Notifications.tsx';
import { ProjectsScreen } from './ProjectsScreen.tsx';
import { LogTab } from './LogTab.tsx';
import { ActivityBar } from './ActivityBar.tsx';
import { C, api, inheritFrom, EMPTY_STORY, type Asset, type BoardView, type Ctx, type Draft, type JobView, type Manifest, type StoryView } from './shared.tsx';
import type { ProjectView } from '../main/api.ts';
import { Canvas } from './Canvas.tsx';
import { Preview, type PreviewHandle } from './Preview.tsx';
import { GenerateTab } from './Generate.tsx';
import { QueueTab } from './QueueTab.tsx';
import { StoryTab } from './StoryTab.tsx';
import { LibraryTab } from './LibraryTab.tsx';
import { DirectorTab } from './DirectorTab.tsx';
import { AssistantTab } from './AssistantTab.tsx';
import { SettingsTab } from './SettingsTab.tsx';
import { Timeline } from './Timeline.tsx';
import { TimelinePlayer } from './TimelinePlayer.tsx';
import { EditorCtx, useEditor, useUsage, joinForTimeline } from './editorBridge.tsx';
import { placeInGap, selectAssets, getState as editorState } from '@driftboard/editor';
import { loadPending, savePending } from './pendingPlace.ts';
import { installUndoRouter, registerUndo } from './undoRouter.ts';
import { hit } from './keys.ts';
import { confirmUser } from './Ask.tsx';
import { DEFAULT_FILM, FilmChip, type Film } from './size.tsx';

const EMPTY: BoardView = { items: [], edges: [], lineage: [], views: [], canUndo: false, canRedo: false };
type Tab = 'generate' | 'director' | 'story' | 'library' | 'queue' | 'assistant' | 'settings' | 'log';
interface Layout { leftW: number; rightW: number; tlH: number; tlOpen: boolean; rightOpen: boolean }
const DEFAULT_LAYOUT: Layout = { leftW: 330, rightW: 430, tlH: 330, tlOpen: true, rightOpen: true };
const loadLayout = (): Layout => { try { return { ...DEFAULT_LAYOUT, ...JSON.parse(localStorage.getItem('driftboard.layout') ?? '{}') }; } catch { return DEFAULT_LAYOUT; } };

export function App() {
  const [project, setProject] = useState<ProjectView | null>(null);
  const [comfy, setComfy] = useState<{ ok: boolean; version?: string; error?: string; url: string } | null>(null);
  const [profiles, setProfiles] = useState<Manifest[]>([]);
  // Settings → ComfyUI changed which profiles are on, or reloaded the profile folders
  useEffect(() => { const f = () => { void api.profiles().then((l) => setProfiles(l.filter((p) => p.enabled))); }; window.addEventListener('driftboard-profiles', f); return () => window.removeEventListener('driftboard-profiles', f); }, []);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [board, setBoard] = useState<BoardView>(EMPTY);
  const [story, setStory] = useState<StoryView>(EMPTY_STORY);
  const [focus, setFocus] = useState<{ assetId: string; n: number } | null>(null);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tab, setTab] = useState<Tab | null>('generate');
  const [toast, setToast] = useState('');
  const [layout, setLayout] = useState<Layout>(loadLayout);
  const [mode, setMode] = useState<'asset' | 'timeline'>('asset');
  const [showProjects, setShowProjects] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);
  const [notesOpen, setNotesOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const noteId = useRef(0);
  const addNote = useCallback((msg: string, level: Note['level'] = 'info') => { setNotes((n) => [...n.slice(-199), { id: ++noteId.current, ts: Date.now(), msg, level }]); setUnread((u) => u + 1); }, []);
  useEffect(() => api.onLog((e) => { if (e.level !== 'info' && e.source !== 'ui') addNote(`${e.source}: ${e.msg.slice(0, 300)}`, e.level); }), [addNote]);
  const preview = useRef<PreviewHandle>(null);
  const [film, setFilmState] = useState<Film>(DEFAULT_FILM);
  const setFilm = useCallback((f: Film) => { setFilmState(f); void api.blobSet('film', JSON.stringify(f)); }, []);

  useEffect(() => { try { localStorage.setItem('driftboard.layout', JSON.stringify(layout)); } catch { /* ignore */ } }, [layout]);
  const notify = useCallback((m: string) => { void api.logAdd('info', 'ui', m); addNote(m); setToast(m); setTimeout(() => setToast((t) => (t === m ? '' : t)), 4000); }, [addNote]);
  // Ctrl+Z / Ctrl+Shift+Z act only on the area under the mouse pointer; the project's history asks first before undoing work the app did by itself
  const boardRef = useRef(board); boardRef.current = board;
  useEffect(() => installUndoRouter(notify), [notify]);
  // P = full screen for the preview that is showing (Esc leaves it)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!hit(e, 'preview.fullscreen')) return;
      const t = e.target as HTMLElement | null; if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      const st = document.querySelector<HTMLElement>('.right .stage'); if (!st) return;
      e.preventDefault(); void (document.fullscreenElement ? document.exitFullscreen() : st.requestFullscreen());
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, []);
  useEffect(() => registerUndo('project', {
    undo: async () => {
      const b = boardRef.current; if (!b.canUndo) return notify('Nothing to undo here.');
      if (/^(LLM|Import director plan|Import prompts|Storyboard)/.test(b.undoLabel ?? '') && !(await confirmUser(`Undo “${b.undoLabel}”?`, 'This was done by the app (for example prompts written by the LLM). Undoing it removes that work. Other places are not affected.', 'Undo it'))) return;
      void api.boardUndo();
    },
    redo: () => { if (boardRef.current.canRedo) void api.boardRedo(); else notify('Nothing to redo here.'); },
  }), [notify]);

  const refreshAssets = useCallback(async () => setAssets(await api.assets()), []);
  const refreshBoard = useCallback(async () => { setBoard(await api.board()); setStory(await api.story()); }, []);
  const refreshComfy = useCallback(async () => setComfy(await api.comfyStatus()), []);
  const loadAll = useCallback(async () => { setProject(await api.projectCurrent()); try { const f = await api.blobGet('film'); setFilmState({ ...DEFAULT_FILM, ...(f ? JSON.parse(f) : {}) }); } catch { setFilmState(DEFAULT_FILM); } setJobs(await api.jobs()); await Promise.all([refreshAssets(), refreshBoard()]); }, [refreshAssets, refreshBoard]);

  useEffect(() => {
    void (async () => { setProfiles((await api.profiles()).filter((p) => p.enabled)); await loadAll(); await refreshComfy(); })();
    const t = setInterval(refreshComfy, 5000);
    const offJob = api.onJob((j) => { setJobs((cur) => [j, ...cur.filter((x) => x.id !== j.id)].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))); if (j.status === 'done') void refreshAssets(); });
    const offP = api.onProgress((id, f) => setProgress((p) => ({ ...p, [id]: f })));
    const offB = api.onBoard(() => { void refreshBoard(); void refreshAssets(); });
    return () => { clearInterval(t); offJob(); offP(); offB(); };
  }, [loadAll, refreshAssets, refreshBoard, refreshComfy]);

  const choose = async (fn: () => Promise<ProjectView | null>) => { if (await fn()) { setSelected([]); setDraft(null); await loadAll(); } };

  const takeOf = useMemo(() => {
    const m = new Map<string, { shot: import('./shared.tsx').Shot; status: string; picked: boolean }>();
    for (const t of story.all) for (const sh of t.shots) for (const k of sh.takes) m.set(k.assetId, { shot: sh, status: k.status, picked: sh.pick === k.assetId });
    return m;
  }, [story]);
  const editor = useEditor(project?.dir ?? null, assets);
  const usage = useUsage(editor);
  // generated clips meant for a gap on the timeline (Bridge): placed there when their job is done, never over other clips
  useEffect(() => {
    if (!editor) return; const pend = loadPending(); let changed = false;
    for (const [jobId, pl] of Object.entries(pend)) {
      const j = jobs.find((x) => x.id === jobId); if (!j) continue;
      if (j.status === 'failed' || j.status === 'cancelled') { delete pend[jobId]; changed = true; continue; }
      if (j.status !== 'done' || !j.outputs.length) continue;
      const out = j.outputs[0]!.assetId;
      if (!selectAssets(editorState(editor)).some((a) => a.id === out)) continue;   // the timeline does not know the new file yet: next round
      delete pend[jobId]; changed = true;
      // a clip made with held frames goes in as its seam-matched copy without the repeated frames
      void joinForTimeline(editor, [out]).then(([o]) => notify(placeInGap(editor, o!, pl.start, pl.gap, pl.track) ? 'The new clip is in the gap on the timeline.' : 'The new clip is on the canvas; the gap on the timeline was no longer free, so it was not placed.'));
    }
    if (changed) savePending(pend);
  }, [jobs, assets, editor, notify]);
  // failed jobs do not sit on the canvas: say so once here (a proper notification centre comes later), details stay in the Queue tab
  const seenStatus = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    for (const j of jobs) {
      const prev = seenStatus.current.get(j.id); seenStatus.current.set(j.id, j.status);
      if (prev && prev !== 'failed' && j.status === 'failed') notify(`${j.profile_id ?? 'Job'} failed: ${(j.error ?? '').slice(0, 160)} (see Queue)`);
    }
  }, [jobs, notify]);
  const ctx = useMemo<Ctx>(() => ({ assets: new Map(assets.map((a) => [a.id, a])), jobs, jobsById: new Map(jobs.map((j) => [j.id, j])), progress, profiles, board, usage, story, takeOf, film, setFilm }), [assets, jobs, progress, profiles, board, usage, story, takeOf, film, setFilm]);

  const items = new Map(board.items.map((i) => [i.id, i]));
  const selAssetIds = selected.map((id) => items.get(id)).filter((i) => i?.kind === 'asset' && i.ref).map((i) => i!.ref!);
  const previewAsset = selAssetIds.length ? ctx.assets.get(selAssetIds[selAssetIds.length - 1]!) ?? null : null;
  /** Forms you jumped away from (e.g. a Bridge form, then Edit on one of its pictures): Back in the Generate tab returns to the last one with every setting as it was. */
  const [draftStack, setDraftStack] = useState<Draft[]>([]);
  const openDraft = useCallback((d: Draft) => {
    setDraftStack([]);
    // results of a generation started from a take go to the same shot unless told otherwise
    let shotId = d.shotId;
    if (!shotId && d.origin) { const it = board.items.find((i) => i.id === d.origin); const tk = it?.ref ? takeOf.get(it.ref) : undefined; if (tk) shotId = tk.shot.id; }
    const next = { ...d, shotId };
    setDraft(next); setTab('generate');
    // Continue / Bridge: carry the earlier clip's film blocks and prompt, so only the new action has to be written
    if (d.kind && d.previous === undefined && d.blockUse === undefined) {
      const fromItem = d.origin ? board.items.find((i) => i.id === d.origin && i.kind === 'asset')?.ref : undefined;
      const source = fromItem ?? Object.values(d.inputs).flat()[0];
      if (source) void api.storyBlocks(story.activeId ?? undefined).then((sb) => {
        const carry = inheritFrom(source, jobs, sb.blocks);
        if (carry.previous || carry.blockUse) setDraft((cur) => (cur === next ? { ...next, ...carry } : cur));
      }).catch(() => {});
    }
  }, [board.items, takeOf, jobs, story.activeId]);
  const focusAsset = useCallback((assetId: string) => setFocus((f) => ({ assetId, n: (f?.n ?? 0) + 1 })), []);
  const act = useMemo(() => ({ onSelect: (ids: string[]) => { setSelected(ids); setMode('asset'); }, editor, openDraft, previewFrame: () => preview.current?.frame() ?? null, notify }), [openDraft, notify, editor]);

  const drag = (axis: 'x' | 'y', apply: (delta: number, start: Layout) => Partial<Layout>) => (e: React.PointerEvent) => {
    e.preventDefault();
    const start = layout, x0 = e.clientX, y0 = e.clientY;
    const move = (ev: PointerEvent) => setLayout({ ...start, ...apply(axis === 'x' ? ev.clientX - x0 : ev.clientY - y0, start) });
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

  const clickTab = (t: Tab) => setTab((cur) => (cur === t ? null : t));

  return (
    <C.Provider value={ctx}>
      <EditorCtx.Provider value={editor}>
      <header>
        <h1><img src={wordmark} height={18} alt="Driftboard" style={{ display: 'block' }} /></h1>
        <button title="All projects: switch, relink, rename, delete" onClick={() => setShowProjects(true)}>📁 {project ? project.name : 'Projects'} ▾</button>
        {project && <FilmChip />}
        <span className="sp" />
        <span className="bellBtn"><button title="Notifications" onClick={() => { setNotesOpen(!notesOpen); setUnread(0); }}>🔔</button>{unread > 0 && !notesOpen && <i className="dotN">{unread > 99 ? '99+' : unread}</i>}</span>
        <span title={comfy?.error ?? comfy?.url}><span className={'dot' + (comfy?.ok ? ' ok' : '')} />ComfyUI {comfy?.ok ? `connected (${comfy.version})` : 'not reachable'}</span>
        <input type="text" style={{ width: 210 }} defaultValue={comfy?.url} key={comfy?.url} onBlur={async (e) => { if (e.target.value && e.target.value !== comfy?.url) { await api.setComfyUrl(e.target.value); void refreshComfy(); } }} />
      </header>
      {(showProjects || !project) && <ProjectsScreen hasProject={!!project} notify={notify} onClose={() => setShowProjects(false)} onNew={() => void choose(api.projectNew).then(() => setShowProjects(false))} onOpenFolder={() => void choose(api.projectOpen).then(() => setShowProjects(false))} onSwitch={async (dir) => { await choose(async () => { const r = await api.projectSwitch(dir); if (!r.ok) { notify(r.error); return null; } notify(`Switched to ${r.project.name} (the previous project was saved)`); return r.project; }); }} />}
      {!project ? <div className="empty">Create or open a project to start.</div> : (
        <div className="shell">
          <div className="topRow">
            <nav className="rail">
              <button className={tab === 'generate' ? 'on' : ''} title="Generate" onClick={() => clickTab('generate')}>✦<small>Generate</small></button>
              <button className={tab === 'director' ? 'on' : ''} title="Director" onClick={() => clickTab('director')}>🎬<small>Director</small></button>
              <button className={tab === 'story' ? 'on' : ''} title="Story" onClick={() => clickTab('story')}>☰<small>Story</small></button>
              <button className={tab === 'library' ? 'on' : ''} title="Library" onClick={() => clickTab('library')}>▦<small>Library</small></button>
              <button className={tab === 'queue' ? 'on' : ''} title="Queue" onClick={() => clickTab('queue')}>≡<small>Queue</small>{jobs.some((j) => j.status === 'running' || j.status === 'queued') && <i className="pulse" />}</button>
              <button className={tab === 'assistant' ? 'on' : ''} title="Assistant (chat)" onClick={() => clickTab('assistant')}>💬<small>Assistant</small></button>
              <button className={tab === 'settings' ? 'on' : ''} title="Settings: shortcuts, LLM, guides" onClick={() => clickTab('settings')}>⚙<small>Settings</small></button>
              <button className={tab === 'log' ? 'on' : ''} title="Log of everything the app does" onClick={() => clickTab('log')}>🧾<small>Log</small></button>
            </nav>
            {tab && <>
              <section className="side" data-undo={tab === 'director' ? 'director' : 'project'} style={{ width: tab === 'director' || tab === 'settings' || tab === 'log' ? Math.max(layout.leftW, 520) : layout.leftW }}>
                {tab === 'generate' ? <GenerateTab draft={draft} setDraft={setDraft} selectedAssets={selAssetIds} stack={draftStack} setStack={setDraftStack} /> : tab === 'director' ? <DirectorTab selectedAssets={selAssetIds} notify={notify} /> : tab === 'story' ? <StoryTab selectedAssets={selAssetIds} focus={focusAsset} notify={notify} openDraft={openDraft} /> : tab === 'assistant' ? <AssistantTab notify={notify} openDraft={openDraft} selectedAssets={selAssetIds} /> : tab === 'settings' ? <SettingsTab notify={notify} /> : tab === 'log' ? <LogTab notify={notify} /> : tab === 'library' ? <LibraryTab focusAssetId={selAssetIds.at(-1) ?? focus?.assetId ?? null} focus={focusAsset} notify={notify} /> : <QueueTab openDraft={openDraft} />}
                {['director', 'story', 'queue', 'library', 'settings', 'log'].includes(tab) && <FoldBar key={tab} folds={['director', 'story', 'queue'].includes(tab)} />}
              </section>
              <div className="gutter v" onPointerDown={drag('x', (d, s) => ({ leftW: clamp(s.leftW + d, 240, 560) }))} />
            </>}
            <div className="cv" data-undo="project"><ReactFlowProvider><Canvas act={act} selected={selected} focus={focus} /></ReactFlowProvider></div>
            {layout.rightOpen ? <>
              <div className="gutter v" onPointerDown={drag('x', (d, s) => ({ rightW: clamp(s.rightW - d, 280, 900) }))} />
              <section className="right" style={{ width: layout.rightW }}>
                <button className="collapse" title="Hide preview" onClick={() => setLayout({ ...layout, rightOpen: false })}>›</button>
                <div className="modeTabs"><button className={mode === 'asset' ? 'on' : ''} onClick={() => setMode('asset')}>Asset</button><button className={mode === 'timeline' ? 'on' : ''} onClick={() => setMode('timeline')}>Timeline</button></div>
                {mode === 'timeline' && editor ? <TimelinePlayer /> : <Preview ref={preview} asset={previewAsset} notify={notify} />}
              </section>
            </> : <button className="railOpen" title="Show preview" onClick={() => setLayout({ ...layout, rightOpen: true })}>‹</button>}
          </div>
          <div className="gutter h" onPointerDown={drag('y', (d, s) => ({ tlH: clamp(s.tlH - d, 80, 600), tlOpen: true }))} />
          <div className="timeline" data-undo="timeline" style={{ height: layout.tlOpen ? layout.tlH : 30 }}>
            <div className="tlHead"><b>Timeline</b><span className="sp" /><button onClick={() => setLayout({ ...layout, tlOpen: !layout.tlOpen })}>{layout.tlOpen ? '▾' : '▴'}</button></div>
            {layout.tlOpen && editor && <Timeline onFocus={() => setMode('timeline')} openDraft={openDraft} notify={notify} canvasAssets={selAssetIds} />}
          </div>
        </div>
      )}
      <ActivityBar openLog={() => clickTab('log')} />
      {notesOpen && <NotesPanel notes={notes} onClear={() => setNotes([])} onClose={() => setNotesOpen(false)} openLog={() => { setNotesOpen(false); setTab('log'); }} />}
      <AskHost />
      <ContinuityHost />
      {toast && <div className="toast">{toast}</div>}
      </EditorCtx.Provider>
    </C.Provider>
  );
}
