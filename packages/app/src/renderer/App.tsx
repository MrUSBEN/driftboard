import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { AskHost, confirmUser } from './Ask.tsx';
import { ContinuityHost } from './Continuity.tsx';
import { ProjectsScreen } from './ProjectsScreen.tsx';
import { C, api, inheritFrom, EMPTY_STORY, type Asset, type BoardView, type Ctx, type Draft, type JobView, type Manifest, type StoryView } from './shared.tsx';
import type { ProjectView } from '../main/api.ts';
import { Canvas, setCanvasInsets } from './Canvas.tsx';
import { Preview, type PreviewHandle } from './Preview.tsx';
import { GenerateTab } from './Generate.tsx';
import { StoryTab } from './StoryTab.tsx';
import { LibraryTab } from './LibraryTab.tsx';
import { DirectorTab } from './DirectorTab.tsx';
import { AssistantTab } from './AssistantTab.tsx';
import { SettingsSheet, loadSettingsPane } from './SettingsTab.tsx';
import { Timeline } from './Timeline.tsx';
import { TimelinePlayer } from './TimelinePlayer.tsx';
import { EditorCtx, useEditor, useUsage, joinForTimeline } from './editorBridge.tsx';
import { placeInGap, selectAssets, getState as editorState } from '@driftboard/editor';
import { loadPending, savePending } from './pendingPlace.ts';
import { installUndoRouter, registerUndo, undoChanged } from './undoRouter.ts';
import { hit } from './keys.ts';
import { DEFAULT_FILM, type Film } from './size.tsx';
import { IconButton, Seg, ToastHost, showToast } from './ui/ui.tsx';
import { TopBar, Rail, StatusBar, PanelTools, Gutter, type PanelId, type SettingsPane } from './Shell.tsx';
import { ActivityPanel, type ActivityTab, type Note } from './Activity.tsx';

const EMPTY: BoardView = { items: [], edges: [], lineage: [], views: [], canUndo: false, canRedo: false };
interface Layout { leftW: number; rightW: number; tlH: number; tlOpen: boolean; rightOpen: boolean }
const DEFAULT_LAYOUT: Layout = { leftW: 360, rightW: 420, tlH: 260, tlOpen: true, rightOpen: true };
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
/** Which panel is open and which story view: remembered like the panel sizes. */
const loadPanel = (): PanelId | null => { try { const v = localStorage.getItem('driftboard.panel'); return v === 'none' ? null : (['create', 'story', 'assistant', 'library', 'activity'].includes(v ?? '') ? v as PanelId : 'create'); } catch { return 'create'; } };
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
  const [panel, setPanelState] = useState<PanelId | null>(loadPanel);
  const setPanel = useCallback((p: PanelId | null) => { setPanelState(p); try { localStorage.setItem('driftboard.panel', p ?? 'none'); } catch { /* ignore */ } }, []);
  const [storyView, setStoryView] = useState<'stories' | 'plan'>(() => { try { return localStorage.getItem('driftboard.storyView') === 'plan' ? 'plan' : 'stories'; } catch { return 'stories'; } });
  const pickStoryView = (v: 'stories' | 'plan') => { setStoryView(v); try { localStorage.setItem('driftboard.storyView', v); } catch { /* ignore */ } };
  const [activityTab, setActivityTab] = useState<ActivityTab>('jobs');
  const [settings, setSettings] = useState<SettingsPane | null>(null);
  const openSettings = useCallback((p?: SettingsPane) => setSettings(p ?? loadSettingsPane()), []);
  const [layout, setLayout] = useState<Layout>(loadLayout);
  const [mode, setMode] = useState<'asset' | 'timeline'>('asset');
  const [showProjects, setShowProjects] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);
  const [unread, setUnread] = useState(0);
  const noteId = useRef(0);
  const addNote = useCallback((msg: string, level: Note['level'] = 'info') => { setNotes((n) => [...n.slice(-199), { id: ++noteId.current, ts: Date.now(), msg, level }]); setUnread((u) => u + 1); }, []);
  useEffect(() => api.onLog((e) => { if (e.level !== 'info' && e.source !== 'ui') addNote(`${e.source}: ${e.msg.slice(0, 300)}`, e.level); }), [addNote]);
  const preview = useRef<PreviewHandle>(null);
  const [film, setFilmState] = useState<Film>(DEFAULT_FILM);
  const setFilm = useCallback((f: Film) => { setFilmState(f); void api.blobSet('film', JSON.stringify(f)); }, []);

  useEffect(() => { try { localStorage.setItem('driftboard.layout', JSON.stringify(layout)); } catch { /* ignore */ } }, [layout]);
  const notify = useCallback((m: string) => { void api.logAdd('info', 'ui', m); addNote(m); showToast(m); }, [addNote]);
  const openActivity = useCallback((t: ActivityTab) => { setActivityTab(t); setPanel('activity'); if (t === 'messages') setUnread(0); }, [setPanel]);
  useEffect(() => { if (panel === 'activity' && activityTab === 'messages') setUnread(0); }, [panel, activityTab, notes]);
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
    info: () => ({ canUndo: boardRef.current.canUndo, canRedo: boardRef.current.canRedo, undo: boardRef.current.undoLabel, redo: boardRef.current.redoLabel }),
  }), [notify]);
  useEffect(() => { undoChanged(); }, [board.canUndo, board.canRedo, board.undoLabel, board.redoLabel]);

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
      if (prev && prev !== 'failed' && j.status === 'failed') notify(`${profiles.find((p) => p.id === j.profile_id)?.title ?? 'A generation'} failed: ${(j.error ?? '').slice(0, 160)} (details in Activity › Jobs)`);
    }
  }, [jobs, notify, profiles]);
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
    setDraft(next); setPanel('create');
    // Continue / Bridge: carry the earlier clip's film blocks and prompt, so only the new action has to be written
    if (d.kind && d.previous === undefined && d.blockUse === undefined) {
      const fromItem = d.origin ? board.items.find((i) => i.id === d.origin && i.kind === 'asset')?.ref : undefined;
      const source = fromItem ?? Object.values(d.inputs).flat()[0];
      if (source) void api.storyBlocks(story.activeId ?? undefined).then((sb) => {
        const carry = inheritFrom(source, jobs, sb.blocks);
        if (carry.previous || carry.blockUse) setDraft((cur) => (cur === next ? { ...next, ...carry } : cur));
      }).catch(() => {});
    }
  }, [board.items, takeOf, jobs, story.activeId, setPanel]);
  const focusAsset = useCallback((assetId: string) => setFocus((f) => ({ assetId, n: (f?.n ?? 0) + 1 })), []);
  const act = useMemo(() => ({ onSelect: (ids: string[]) => { setSelected(ids); setMode('asset'); }, editor, openDraft, previewFrame: () => preview.current?.frame() ?? null, notify }), [openDraft, notify, editor]);

  // panel sizes: drag the gutters, remembered between sessions
  const dragStart = useRef(layout);
  const resize = (apply: (d: number, start: Layout) => Partial<Layout>) => (d: number) => setLayout({ ...dragStart.current, ...apply(d, dragStart.current) });
  const beginResize = () => { dragStart.current = layout; };
  const clickPanel = (p: PanelId) => setPanel(panel === p ? null : p);
  const wide = panel === 'story' && storyView === 'plan';
  const panelW = wide ? Math.max(layout.leftW, 520) : layout.leftW;
  // the canvas runs under the floating panels: tell it how much of it they cover, so Fit and its tools stay in the free part
  const insetL = 12 + 62 + 12 + (panel ? panelW + 12 : 0), insetR = layout.rightOpen ? 12 + layout.rightW + 12 : 12;
  useEffect(() => { setCanvasInsets(insetL, insetR); }, [insetL, insetR]);
  const sideRef = useRef<HTMLDivElement>(null);
  const scroller = useCallback(() => sideRef.current, []);
  const panelArea = panel === 'story' ? (storyView === 'plan' ? 'director' : 'story') : panel ?? 'canvas';

  return (
    <C.Provider value={ctx}>
      <EditorCtx.Provider value={editor}>
      <div className="app">
        <TopBar project={project} comfy={comfy} refreshComfy={() => void refreshComfy()} openProjects={() => setShowProjects(true)} openSettings={openSettings} notify={notify} />
        {!project ? <ProjectsScreen hasProject={false} comfy={comfy} notify={notify} onClose={() => {}} onNew={() => void choose(api.projectNew)} onOpenFolder={() => void choose(api.projectOpen)} onSwitch={async (dir) => { await choose(async () => { const r = await api.projectSwitch(dir); if (!r.ok) { notify(r.error); return null; } return r.project; }); }} /> : <>
          <div className="body" style={{ ['--panelW' as string]: panelW + 'px', ['--rightW' as string]: layout.rightW + 'px', ['--insetL' as string]: insetL + 'px', ['--insetR' as string]: insetR + 'px' }}>
            <div className="cvLayer" data-undo="project" data-area="canvas"><ReactFlowProvider><Canvas act={act} selected={selected} focus={focus} /></ReactFlowProvider></div>
            <Rail panel={panel} onPanel={clickPanel} openSettings={() => openSettings()} />
            {panel && <>
              <section className="fpanel" aria-label={panel} data-area={panel === 'story' ? 'story' : panel} data-undo={panelArea === 'director' ? 'director' : 'project'}>
                {panel === 'story' && <div className="storySwitch"><Seg label="Story view" value={storyView} onChange={pickStoryView} options={[{ value: 'stories', label: 'Stories', icon: 'story' }, { value: 'plan', label: 'Plan from a script', icon: 'pencil' }]} /></div>}
                {panel === 'activity'
                  ? <ActivityPanel tab={activityTab} setTab={(t) => { setActivityTab(t); if (t === 'messages') setUnread(0); }} notes={notes} clearNotes={() => { setNotes([]); setUnread(0); }} openDraft={openDraft} notify={notify} />
                  : <div className="side" ref={sideRef} data-area={panelArea}>
                    {panel === 'create' ? <GenerateTab draft={draft} setDraft={setDraft} selectedAssets={selAssetIds} stack={draftStack} setStack={setDraftStack} />
                      : panel === 'story' ? (storyView === 'plan' ? <DirectorTab selectedAssets={selAssetIds} notify={notify} /> : <StoryTab selectedAssets={selAssetIds} focus={focusAsset} notify={notify} openDraft={openDraft} />)
                      : panel === 'assistant' ? <AssistantTab notify={notify} openDraft={openDraft} selectedAssets={selAssetIds} />
                      : <LibraryTab focusAssetId={selAssetIds.at(-1) ?? focus?.assetId ?? null} focus={focusAsset} notify={notify} />}
                  </div>}
                {panel === 'story' && <PanelTools key={storyView} folds scroller={scroller} />}
                {panel === 'library' && <PanelTools key="lib" folds={false} scroller={scroller} />}
              </section>
              <Gutter axis="x" label="Panel width" onStart={beginResize} onDrag={resize((dx, st) => ({ leftW: clamp(st.leftW + dx, 280, 760) }))} onReset={() => setLayout({ ...layout, leftW: DEFAULT_LAYOUT.leftW })} />
            </>}
            <span className="bodySp" />
            {layout.rightOpen ? <>
              <Gutter axis="x" label="Viewer width" onStart={beginResize} onDrag={resize((dx, st) => ({ rightW: clamp(st.rightW - dx, 280, 900) }))} onReset={() => setLayout({ ...layout, rightW: DEFAULT_LAYOUT.rightW })} />
              <aside className="fright" data-area="viewer" aria-label="Viewer">
                <div className="vtabs">
                  <Seg label="Viewer" value={mode} onChange={setMode} options={[{ value: 'asset', label: 'Clip', icon: 'image' }, { value: 'timeline', label: 'Film', icon: 'film' }]} />
                  <span className="sp" /><IconButton size="sm" icon="chevR" label="Hide the viewer" onClick={() => setLayout({ ...layout, rightOpen: false })} />
                </div>
                {mode === 'timeline' && editor ? <TimelinePlayer /> : <Preview ref={preview} asset={previewAsset} notify={notify} />}
              </aside>
            </> : <IconButton className="showRight" kind="secondary" icon="back" label="Show the viewer" onClick={() => setLayout({ ...layout, rightOpen: true })} />}
          </div>
          {layout.tlOpen && <Gutter axis="y" label="Timeline height" onStart={beginResize} onDrag={resize((dy, st) => ({ tlH: clamp(st.tlH - dy, 120, 640) }))} onReset={() => setLayout({ ...layout, tlH: DEFAULT_LAYOUT.tlH })} />}
          <section className={'timelineWrap' + (layout.tlOpen ? '' : ' closed')} data-undo="timeline" data-area="timeline" aria-label="Timeline" style={{ height: layout.tlOpen ? layout.tlH : undefined }}>
            <div className="tlHead"><IconButton size="sm" icon={layout.tlOpen ? 'chev' : 'up'} label={layout.tlOpen ? 'Hide the timeline' : 'Show the timeline'} onClick={() => setLayout({ ...layout, tlOpen: !layout.tlOpen })} /><b className="display">Timeline</b></div>
            {layout.tlOpen && editor && <Timeline onFocus={() => setMode('timeline')} openDraft={openDraft} notify={notify} canvasAssets={selAssetIds} />}
          </section>
        </>}
        <StatusBar openActivity={openActivity} unread={unread} />
      </div>
      {showProjects && project && <ProjectsScreen hasProject comfy={comfy} notify={notify} onClose={() => setShowProjects(false)} onNew={() => void choose(api.projectNew).then(() => setShowProjects(false))} onOpenFolder={() => void choose(api.projectOpen).then(() => setShowProjects(false))} onSwitch={async (dir) => { await choose(async () => { const r = await api.projectSwitch(dir); if (!r.ok) { notify(r.error); return null; } notify(`Switched to ${r.project.name} (the previous project was saved)`); return r.project; }); }} />}
      {settings && <SettingsSheet pane={settings} setPane={setSettings} onClose={() => setSettings(null)} notify={notify} />}
      <AskHost />
      <ContinuityHost />
      <ToastHost />
      </EditorCtx.Provider>
    </C.Provider>
  );
}
