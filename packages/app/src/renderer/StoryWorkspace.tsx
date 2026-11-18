/* The Story workspace: the old Director and Story tabs as one. A story has four stages (Script, Bible, Board, Shots);
   its plan (the Director's state, one run per story) reaches its shots automatically through the existing accept path.
   Both data stores stay as they are; directorStore.ts keeps them in step. */
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { applyPicks } from '@driftboard/editor';
import { C, api, matches, thumbUrl, draftForShot, valuesOfDraft, elementsOfShot, refsOfShot, mediaOfShot, autoAssign, imageSlots, slotWithRole, type Asset, type Draft, type Manifest } from './shared.tsx';
import type { Shot, SceneTree, LlmProgress, DirectorProgress, StoryCard } from '../main/api.ts';
import { askUser, confirmUser } from './Ask.tsx';
import { ViewBar, useView, viewClass } from './View.tsx';
import { checkPrompt, providedOf, detectPromptKind, KIND_LABEL } from './promptKind.ts';
import { SizeChooser, resolveSize, useSizeChoice, sizeInfo, withSize } from './size.tsx';
import { useStore, joinForTimeline } from './editorBridge.tsx';
import { PrepInput } from './PrepInput.tsx';
import { DirectorStage, type PlanStage } from './DirectorTab.tsx';
import { useDirector, loadDirector, resetDirectorHistory, setSyncTarget, syncNow, runStep, workingNow, directorNow, setDirectorQuiet, updDirector, undoDirector, redoDirector } from './directorStore.ts';
import { registerUndo, undoChanged } from './undoRouter.ts';
import { takeStoryGoto } from './goto.ts';
import { Icon, type IconName } from './ui/Icon.tsx';
import { Button, Card, Chip, Dialog, Empty, IconButton, Menu, Notice, Progress, Section, Spinner, Stepper, Tile, type MenuItem } from './ui/ui.tsx';

type Stage = PlanStage | 'shots';
const FRAMINGS = ['wide', 'medium', 'close', 'extreme-close', 'over-the-shoulder', 'low-angle', 'high-angle', 'top-down'];
const MOVES = ['static', 'push-in', 'pull-back', 'pan', 'tilt', 'tracking', 'orbit', 'crane', 'handheld', 'rack-focus'];
type RunRec = { id: string; name: string; state?: { storyId?: string; scriptText?: string; parsed?: unknown; bible?: { characters?: unknown[]; places?: unknown[]; props?: unknown[] }; shots?: Record<string, { shots: unknown[] }> }; storyboard?: { frames?: { role?: string }[] } };
const readRuns = async (): Promise<RunRec[]> => { await api.directorRuns(); try { return JSON.parse((await api.blobGet('director_runs')) ?? '[]') as RunRec[]; } catch { return []; } };
const planEmpty = (r: RunRec) => !r.state?.scriptText?.trim() && !r.state?.bible && !Object.values(r.state?.shots ?? {}).some((x) => x.shots.length) && !r.storyboard?.frames?.length;
/** Shots the user deleted from a story although its plan still has them: the sync would bring them back, so they are removed again after each sync. */
const DROP_KEY = 'story_dropped';
const loadDropped = async (): Promise<Record<string, string[]>> => { try { return JSON.parse((await api.blobGet(DROP_KEY)) ?? '{}'); } catch { return {}; } };
const saveDropped = (d: Record<string, string[]>) => api.blobSet(DROP_KEY, JSON.stringify(d));

/** "1 scene", "2 scenes" */
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
/** The shot the command palette asked for, until its card is shown. */
let pendingShot: string | null = null;
export function StoryWorkspace({ selectedAssets, focus, notify, openDraft }: { selectedAssets: string[]; focus: (assetId: string) => void; notify: (m: string) => void; openDraft: (d: Draft) => void }) {
  const { story } = useContext(C);
  const [runs, setRuns] = useState<RunRec[]>([]);
  const refreshRuns = useCallback(async () => setRuns(await readRuns()), []);
  useEffect(() => { void refreshRuns(); }, [refreshRuns, story.stories.length]);
  const [stage, setStageS] = useState<Stage>(() => { try { const v = localStorage.getItem('driftboard.storyStage'); return v === 'script' || v === 'bible' || v === 'board' || v === 'shots' ? v : 'shots'; } catch { return 'shots'; } });
  const setStage = (s: Stage) => { setStageS(s); try { localStorage.setItem('driftboard.storyStage', s); } catch { /* ignore */ } };
  const [ready, setReady] = useState<string | null>(null);   // the story whose plan is open
  /** The stories list was asked for. (With a single story the project always reports it as open, so the list is a view of its own here.) */
  const [home, setHome] = useState(false);
  const active = home ? null : story.stories.find((c) => c.id === story.activeId) ?? null;
  const openStory = useCallback(async (id: string) => { await api.storyActive(id); setHome(false); }, []);
  // the command palette asked for a story (and maybe one of its shots)
  useEffect(() => {
    const f = () => { const g = takeStoryGoto(); if (!g) return; if (g.shotId) { pendingShot = g.shotId; setStage('shots'); } void (async () => { if (story.activeId !== g.storyId || home) { await syncNow(); await openStory(g.storyId); } window.dispatchEvent(new Event('driftboard-shot-goto')); })(); };
    f(); window.addEventListener('driftboard-story-goto', f); return () => window.removeEventListener('driftboard-story-goto', f);
  }, [story.activeId, home, openStory]);   // eslint-disable-line react-hooks/exhaustive-deps

  // the plan's undo works while the pointer is over Script, Bible or Board
  useEffect(() => registerUndo('director', { undo: () => void undoDirector(notify), redo: () => void redoDirector(notify), info: () => { const d = { u: dirCounts.u, r: dirCounts.r }; return { canUndo: d.u > 0, canRedo: d.r > 0, undo: d.u ? `plan change (${d.u})` : undefined, redo: d.r ? 'plan change' : undefined }; } }), [notify]);
  const { undoN, redoN } = useDirector(); dirCounts.u = undoN; dirCounts.r = redoN;
  useEffect(() => { undoChanged(); }, [undoN, redoN]);

  // open the story's plan (its Director run); a story without one gets a new, empty one
  useEffect(() => {
    let live = true;
    if (!active) { setSyncTarget(null); setReady(null); return; }
    void (async () => {
      const all = await readRuns();
      const cur = (await api.directorState()).state; const act = (await api.directorRuns()).activeId;
      if (!(act && cur.storyId === active.id)) {
        const hit = all.find((r) => r.state?.storyId === active.id);
        if (hit) await api.directorOpenRun(hit.id);
        else { await api.directorNewRun(); await api.directorUpdate({ storyId: active.id, name: active.name }); }
        resetDirectorHistory();
      }
      await loadDirector();
      if (!live) return;
      setSyncTarget(active.id, async () => {
        const dropped = (await loadDropped())[active.id] ?? []; if (!dropped.length) return;
        const now = await api.story();
        for (const t of now.all.filter((x) => x.scene.storyId === active.id)) for (const sh of t.shots) if (sh.sourceId && dropped.includes(sh.sourceId) && !sh.takes.length) await api.storyOp('removeShot', sh.id);
      });
      setReady(active.id); void refreshRuns();
    })();
    return () => { live = false; };
  }, [active?.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  const back = async () => { await syncNow(); setSyncTarget(null); setReady(null); setHome(true); await api.directorBack(); await api.storyActive(null); void refreshRuns(); };
  if (!active) return <StoriesHome runs={runs} refreshRuns={refreshRuns} notify={notify} openStage={setStage} openStory={openStory} />;
  return (
    <div className="storyWs">
      <StoryHeader card={active} runs={runs} back={() => void back()} notify={notify} refreshRuns={refreshRuns} />
      <StageBar stage={stage} setStage={setStage} card={active} />
      <WorkingCard />
      <div className="stageScroll" data-undo={stage === 'shots' ? 'project' : 'director'} data-area="story">
        {ready !== active.id ? <div className="pb"><Spinner label="Opening the story" /></div>
          : stage === 'shots' ? <ShotsStage selectedAssets={selectedAssets} focus={focus} notify={notify} openDraft={openDraft} storyId={active.id} />
          : <DirectorStage stage={stage} storyId={active.id} selectedAssets={selectedAssets} notify={notify} focus={focus} goShots={() => setStage('shots')} />}
      </div>
    </div>
  );
}
const dirCounts = { u: 0, r: 0 };

/* ---------- stories home ---------- */
function StoriesHome({ runs, refreshRuns, notify, openStage, openStory }: { runs: RunRec[]; refreshRuns: () => Promise<void>; notify: (m: string) => void; openStage: (s: Stage) => void; openStory: (id: string) => Promise<void> }) {
  const { story } = useContext(C);
  const [view, setView] = useView('stories', { mode: 'grid' });
  const [chooser, setChooser] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const runOf = (id: string) => runs.find((r) => r.state?.storyId === id);
  const loose = runs.filter((r) => !planEmpty(r) && !story.stories.some((c) => c.id === r.state?.storyId));
  const thumbs = (id: string) => story.all.filter((t) => t.scene.storyId === id).flatMap((t) => t.shots.map((s) => s.pick ?? s.takes[0]?.assetId)).filter((x): x is string => !!x).slice(0, 4);
  const open = (id: string) => void openStory(id);
  const openLoose = async (r: RunRec) => {
    const st = (await api.storyOp('addStory', r.name || 'New story')) as { id: string } | undefined; if (!st) return;
    await api.directorOpenRun(r.id); await api.directorUpdate({ storyId: st.id }); await api.directorBack();
    await openStory(st.id); await refreshRuns();
  };
  return (
    <div className="pb">
      <div className="ph0 row"><h2 style={{ flex: 1 }}>Stories</h2><ViewBar value={view} onChange={setView} /></div>
      <div className="row"><Button kind="primary" icon="plus" onClick={() => setChooser(true)}>New story…</Button><span className="xs faint" style={{ flex: 1 }}>A story holds its script, bible, storyboard and shots. Double-click a name to rename it.</span></div>
      <div className={viewClass(view)}>
        {story.stories.map((c) => {
          const r = runOf(c.id); const b = r?.state?.bible; const nBible = (b?.characters?.length ?? 0) + (b?.places?.length ?? 0) + (b?.props?.length ?? 0);
          const nBoard = r?.storyboard?.frames?.filter((f) => f.role !== 'reference').length ?? 0; const th = thumbs(c.id);
          return (
            <div key={c.id} className="dcard hover vcard storyCard" role="button" tabIndex={0} onClick={() => open(c.id)} onKeyDown={(e) => { if (e.key === 'Enter') open(c.id); }}>
              {th.length > 0 && <div className="thumbs vdetail">{th.map((a) => <img key={a} src={thumbUrl(a)} alt="" />)}</div>}
              <div className="row">{renaming === c.id
                ? <input className="inp" autoFocus defaultValue={c.name} onClick={(e) => e.stopPropagation()} onBlur={(e) => { void api.storyOp('renameStory', c.id, e.target.value || c.name); setRenaming(null); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); else if (e.key === 'Escape') setRenaming(null); }} />
                : <b className="h3" style={{ flex: 1 }} title="Double-click to rename" onDoubleClick={(e) => { e.stopPropagation(); setRenaming(c.id); }}>{c.name}</b>}</div>
              <div className="progressRow vdetail">
                <Chip tone={r?.state?.parsed || r?.state?.scriptText?.trim() ? 'ok' : undefined} icon={r?.state?.parsed ? 'check' : undefined}>Script</Chip>
                <Chip>Bible {nBible}</Chip><Chip>Board {nBoard}</Chip><Chip>Shots {c.shots}</Chip>
                <Chip tone={c.shots && c.picked === c.shots ? 'coral' : undefined}>Picked {c.picked}/{c.shots}</Chip>
              </div>
            </div>
          );
        })}
      </div>
      {!story.stories.length && !loose.length && <Empty icon="story" title="No stories yet">Start one with New story: from an idea or a script, from pictures, from prompts you already have, or empty.</Empty>}
      {loose.length > 0 && <>
        <div className="ilabel" style={{ marginTop: 8 }}><Icon name="pencil" size="s" />Plans without a story yet</div>
        {loose.map((r) => <Card key={r.id} className="row"><b className="small" style={{ flex: 1 }}>{r.name}</b>
          <Button size="sm" kind="primary" onClick={() => void openLoose(r)}>Open as a story</Button>
          <IconButton size="sm" icon="trash" kind="danger" label={`Delete the plan “${r.name}”`} onClick={async () => { if (await confirmUser(`Delete the plan “${r.name}”?`, 'Its script, bible, scenes, shots and storyboard list are removed. The pictures themselves stay in the Library.', 'Delete plan', true)) { await api.directorRunEdit(r.id, { remove: true }); await refreshRuns(); } }} /></Card>)}
      </>}
      {chooser && <NewStoryDialog onClose={() => setChooser(false)} notify={notify} openStage={openStage} openStory={openStory} />}
    </div>
  );
}

function NewStoryDialog({ onClose, notify, openStage, openStory }: { onClose: () => void; notify: (m: string) => void; openStage: (s: Stage) => void; openStory: (id: string) => Promise<void> }) {
  const { story } = useContext(C);
  const [name, setName] = useState('');
  const opts: { id: Stage; icon: IconName; title: string; text: string; paste?: boolean }[] = [
    { id: 'script', icon: 'pencil', title: 'From an idea or a script', text: 'Write or paste it; the LLM can turn it into a script you check, then a bible and shots.' },
    { id: 'board', icon: 'image', title: 'From pictures (storyboard)', text: 'Put your pictures in order, add notes, let the LLM build the story and write prompts.' },
    { id: 'board', icon: 'list', title: 'From prompts I have', text: 'Paste one prompt per shot; they are used exactly as written.', paste: true },
    { id: 'shots', icon: 'scene', title: 'Empty', text: 'Add scenes and shots by hand and collect takes into them.' },
  ];
  const make = async (o: (typeof opts)[number]) => {
    const st = (await api.storyOp('addStory', name.trim() || `Story ${story.stories.length + 1}`)) as { id: string } | undefined; if (!st) return;
    openStage(o.id); await openStory(st.id); onClose();
    if (o.paste) notify('Paste your prompts under “Prompts you already have” at the bottom of the Board.');
  };
  return (
    <Dialog title="New story" width="w2" onClose={onClose} footer={<Button kind="quiet" onClick={onClose}>Cancel</Button>}>
      <label className="field"><span className="lbl">Name <span className="xs faint">(optional; you can change it any time)</span></span><input className="inp" autoFocus value={name} placeholder={`Story ${story.stories.length + 1}`} onChange={(e) => setName(e.target.value)} /></label>
      <span className="small dim">How do you want to start? You can use every stage later, whichever you pick.</span>
      <div className="chooser">
        {opts.map((o) => <button key={o.title} type="button" className="dcard hover chooseCard" onClick={() => void make(o)}><Icon name={o.icon} size="l" /><b>{o.title}</b><span className="small dim">{o.text}</span></button>)}
      </div>
    </Dialog>
  );
}

/* ---------- inside a story ---------- */
function StoryHeader({ card, runs, back, notify, refreshRuns }: { card: StoryCard; runs: RunRec[]; back: () => void; notify: (m: string) => void; refreshRuns: () => Promise<void> }) {
  const { st } = useDirector();
  const { profiles } = useContext(C);
  const videoProfiles = profiles.filter((x) => x.kind === 'video' && x.slots.some((s) => s.type === 'text' && s.role === 'prompt'));
  const [chosenId, setChosenId] = useStoryModel();
  const chosen = videoProfiles.find((x) => x.id === chosenId) ?? videoProfiles.find((x) => (x.director?.maxRefs ?? 0) > 0) ?? videoProfiles[0];
  const { targets } = useDirector();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  // the plan's video model follows the story's
  useEffect(() => { if (chosen && st && st.targetId !== chosen.id && targets.some((t) => t.id === chosen.id)) void api.directorSetTarget(chosen.id).then(() => loadDirector()); }, [chosen?.id, st?.targetId]);   // eslint-disable-line react-hooks/exhaustive-deps
  const rename = async (n: string) => { const v = n.trim(); setRenaming(false); if (!v || v === card.name) return; await api.storyOp('renameStory', card.id, v); await updDirector({ name: v }); void refreshRuns(); };
  const clear = async (part: 'all' | 'bible' | 'scenes' | 'shots' | 'board') => {
    const text = { all: 'the whole plan (script, bible, scenes, shots and the storyboard list)', bible: 'the bible (characters, places, props and their pictures in the plan)', scenes: 'the planned scenes and shots', shots: 'the planned shots', board: 'the storyboard pictures list' }[part];
    if (!(await confirmUser(`Clear ${text}?`, 'This only affects this story\'s plan. Shots, takes and picks in Shots stay; the pictures stay in the Library.', 'Clear', true))) return;
    const s = directorNow(); if (!s) return;
    if (part === 'all') { await api.directorClearAll(); setDirectorQuiet(await api.directorUpdate({ storyId: card.id, name: card.name })); resetDirectorHistory(); notify('The plan of this story is cleared'); }
    else if (part === 'bible') await updDirector({ bible: undefined, accepted: { ...s.accepted, bible: false } });
    else if (part === 'scenes') await updDirector({ scenes: undefined, shots: {}, prompts: {} });
    else if (part === 'shots') await updDirector({ shots: {}, prompts: {} });
    else { await api.sbSet({ frames: [], idea: '' } as never); notify('Storyboard cleared'); }
  };
  const del = async () => {
    const run = runs.find((r) => r.state?.storyId === card.id);
    if (!(await confirmUser(`Delete the story “${card.name}”?`, `${plural(card.scenes, 'scene')}, ${plural(card.shots, 'shot')} and the links to ${plural(card.takes, 'take')} are removed${run ? ', and its plan (script, bible, storyboard list)' : ''}. The pictures and videos stay in the Library. Ctrl+Z over a story brings the scenes and shots back; the plan cannot be brought back.`, 'Delete story', true))) return;
    back(); await api.storyOp('removeStory', card.id); if (run) await api.directorRunEdit(run.id, { remove: true }); notify(`Deleted “${card.name}”`); void refreshRuns();
  };
  const items: MenuItem[] = [
    { label: 'Rename', icon: 'pencil', onClick: () => setRenaming(true) },
    { header: 'Clear parts of the plan' },

    { label: 'Clear the bible…', icon: 'x', onClick: () => void clear('bible') },
    { label: 'Clear the planned scenes…', icon: 'x', disabled: st?.parsed && (st.parsed as { mode?: string }).mode === 'screenplay', title: 'Scenes of a screenplay come from the script', onClick: () => void clear('scenes') },
    { label: 'Clear the planned shots…', icon: 'x', onClick: () => void clear('shots') },
    { label: 'Clear the storyboard list…', icon: 'x', onClick: () => void clear('board') },
    { label: 'Clear the whole plan…', icon: 'x', danger: true, sub: 'Script, bible, scenes, shots, storyboard list', onClick: () => void clear('all') },
    { sep: true },
    { label: 'Delete story…', icon: 'trash', danger: true, onClick: () => void del() },
  ];
  return (
    <div className="ph storyHead">
      <Button size="sm" kind="quiet" icon="back" onClick={back}>Stories</Button>
      {renaming ? <input className="inp" autoFocus defaultValue={card.name} aria-label="Story name" onBlur={(e) => void rename(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); else if (e.key === 'Escape') setRenaming(false); }} />
        : <h2 title="Double-click to rename" onDoubleClick={() => setRenaming(true)}>{card.name}</h2>}
      <IconButton size="sm" icon="more" label="Story menu: rename, clear parts, delete" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.right - 260, y: r.bottom + 4 }); }} />
      {menu && <Menu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
    </div>
  );
}
/** The story's video model (kept as before in localStorage); the plan follows it. */
function useStoryModel(): [string, (id: string) => void] {
  const [id, setId] = useState(() => { try { return localStorage.getItem('driftboard.storyProfile') ?? ''; } catch { return ''; } });
  useEffect(() => { const f = () => { try { setId(localStorage.getItem('driftboard.storyProfile') ?? ''); } catch { /* ignore */ } }; window.addEventListener('driftboard-story-model', f); return () => window.removeEventListener('driftboard-story-model', f); }, []);
  return [id, (v) => { setId(v); try { localStorage.setItem('driftboard.storyProfile', v); } catch { /* ignore */ } window.dispatchEvent(new Event('driftboard-story-model')); }];
}

function StageBar({ stage, setStage, card }: { stage: Stage; setStage: (s: Stage) => void; card: StoryCard }) {
  const { st } = useDirector();
  const [board, setBoard] = useState(0);
  useEffect(() => { void api.sbGet().then((b) => setBoard(b.frames.filter((f) => f.role !== 'reference').length)); }, [stage, card.id]);
  const nBible = st?.bible ? st.bible.characters.length + st.bible.places.length + (st.bible.props?.length ?? 0) : 0;
  const tabs: { id: Stage; label: string; cnt?: ReactNode; ok?: boolean; tip?: string }[] = [
    { id: 'script', label: 'Script', ok: !!st?.parsed },
    { id: 'bible', label: 'Bible', cnt: nBible || undefined },
    { id: 'board', label: 'Board', cnt: board || undefined },
    { id: 'shots', label: 'Shots', cnt: card.shots ? `${card.picked}/${card.shots}` : undefined, tip: card.shots ? `${card.shots} shots, ${card.picked} picked` : undefined },
  ];
  return <div className="stages" role="tablist" aria-label="Stages of the story">{tabs.map((t) => <button key={t.id} type="button" role="tab" aria-selected={stage === t.id} className={stage === t.id ? 'on' : ''} title={t.tip} onClick={() => setStage(t.id)}>{t.ok && <Icon name="check" size="s" className="okm" />}{t.label}{t.cnt !== undefined && <span className="cnt">{t.cnt}</span>}</button>)}</div>;
}

/** The LLM working card with Cancel: the same in every stage. */
function WorkingCard() {
  useDirector();
  const [llm, setLlm] = useState<LlmProgress | null>(null);
  const [dir, setDir] = useState<DirectorProgress | null>(null);
  useEffect(() => api.onLlmProgress((p) => setLlm(p.running ? p : null)), []);
  useEffect(() => api.onDirectorProgress((p) => setDir(p.running ? p : null)), []);
  const w = workingNow();
  const label = dir?.label ?? llm?.label ?? (w ? w + '…' : '');
  if (!label) return null;
  const p = dir ?? llm;
  return (
    <div className="working wsWorking" role="status">
      <div className="row"><Spinner /><b className="small" style={{ flex: 1 }}>{label}{p && p.total > 1 ? ` · ${p.done} of ${p.total}` : ''}</b><Button size="sm" onClick={() => void (dir || w ? api.directorCancel() : api.llmCancel())}>Cancel</Button></div>
      <Progress value={p && p.total > 1 ? p.done / p.total : undefined} label={label} />
      <span className="xs dim">The LLM is working. You can keep using the app; the status bar shows it too.</span>
    </div>
  );
}

/* ---------- Shots ---------- */
const statusOf = (s: Shot) => (!s.takes.length ? 'empty' : s.pick ? 'pick' : s.takes.some((t) => t.status === 'approved') ? 'ok' : s.takes.every((t) => t.status === 'rejected') ? 'bad' : 'dr');
const STATUS_TITLE: Record<string, string> = { empty: 'No takes yet', pick: 'Has a pick (goes to the timeline)', ok: 'Has an approved take', bad: 'Every take rejected', dr: 'Takes, none picked' };

function ShotsStage({ selectedAssets, focus, notify, openDraft, storyId }: { selectedAssets: string[]; focus: (assetId: string) => void; notify: (m: string) => void; openDraft: (d: Draft) => void; storyId: string }) {
  const { story, assets, jobs, profiles, film } = useContext(C);
  const { st } = useDirector();
  const kindMap = new Map([...assets.values()].map((a) => [a.id, a.kind] as [string, string]));
  const [size, setSize] = useSizeChoice('story');
  const [batch, setBatch] = useState(1);
  const [view, setView] = useView('shots');
  const editor = useStore();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const op = (name: Parameters<typeof api.storyOp>[0], ...a: unknown[]) => api.storyOp(name, ...a);
  const promptOf = useMemo(() => { const m = new Map<string, string>(); for (const j of jobs) for (const o of j.outputs) { try { const p = JSON.parse(j.params).prompt; if (typeof p === 'string') m.set(o.assetId, p); } catch { /* none */ } } return m; }, [jobs]);
  const nameOf = (a: Asset) => story.meta[a.id]?.name ?? a.original_name ?? a.id.slice(0, 8);
  const takeText = (id: string) => { const a = assets.get(id); return [a ? nameOf(a) : id, story.meta[id]?.tags?.join(' '), story.meta[id]?.note, promptOf.get(id)].join(' '); };
  const filtered: SceneTree[] = useMemo(() => {
    if (!q.trim()) return story.tree;
    return story.tree.map(({ scene, shots }) => {
      const sceneHit = matches(q, scene.name, scene.notes);
      const keep = shots.map((s) => { const shotHit = sceneHit || matches(q, s.name, s.notes, s.tags.join(' '), s.prompt); const takes = shotHit ? s.takes : s.takes.filter((t) => matches(q, takeText(t.assetId), t.note)); return shotHit || takes.length ? { ...s, takes } : null; }).filter((s): s is Shot => !!s);
      return { scene, shots: keep };
    }).filter((t) => t.shots.length || matches(q, t.scene.name));
  }, [story, q, assets, promptOf]);   // eslint-disable-line react-hooks/exhaustive-deps
  const assigned = useMemo(() => new Set(story.all.flatMap((t) => t.shots.flatMap((s) => s.takes.map((k) => k.assetId)))), [story]);
  const unsorted = [...assets.values()].filter((a) => (a.kind === 'video' || a.kind === 'image') && !assigned.has(a.id) && !story.meta[a.id]?.trashed && (!q.trim() || matches(q, takeText(a.id))));
  const shotCount = story.tree.reduce((n, t) => n + t.shots.length, 0);
  const allShots = story.tree.flatMap((t) => t.shots.map((s) => ({ s, scene: t.scene })));
  const screenplay = (st?.parsed as { mode?: string } | undefined)?.mode === 'screenplay';

  const pickAllToTimeline = async () => {
    if (!editor) return;
    const shotsNow = story.tree.flatMap((t) => t.shots);
    for (const s of shotsNow) if (!s.pick) { const t = s.takes.find((x) => x.status !== 'rejected'); if (t) { void op('setPick', s.id, t.assetId); s.pick = t.assetId; } }
    const picks = shotsNow.filter((s) => s.pick);
    if (!picks.length) return notify('No takes yet: nothing to put on the timeline.');
    const all = [...new Set(picks.flatMap((s) => s.takes.map((t) => t.assetId)))]; const joined = await joinForTimeline(editor, all); const jm = new Map(all.map((id, i) => [id, joined[i]!]));
    const r = applyPicks(editor, picks.map((s) => ({ pick: s.pick ? jm.get(s.pick) ?? s.pick : s.pick, takes: s.takes.map((t) => jm.get(t.assetId) ?? t.assetId) })));
    notify(`Timeline: ${r.appended} added, ${r.swapped} swapped, ${picks.length - r.appended - r.swapped} unchanged`);
  };
  const videoProfiles = profiles.filter((x) => x.kind === 'video' && x.slots.some((s) => s.type === 'text' && s.role === 'prompt'));
  const [profileId, setProfileId] = useStoryModel();
  const chosen = videoProfiles.find((x) => x.id === profileId) ?? videoProfiles.find((x) => (x.director?.maxRefs ?? 0) > 0) ?? videoProfiles[0];
  const [prog, setProg] = useState<LlmProgress | null>(null);
  useEffect(() => api.onLlmProgress(setProg), []);
  const [alsoTaken, setAlsoTaken] = useState(false);
  const makers = profiles.filter((x) => x.kind === 'image' && imageSlots(x).length > 0 && x.slots.some((s) => s.type === 'text' && s.role === 'prompt'));
  const capacity = (x: Manifest) => imageSlots(x).reduce((n, s) => n + (s.type === 'image_list' ? s.max : 1), 0);
  const maker = [...makers].sort((a, b) => capacity(b) - capacity(a))[0];
  const [sfSize] = useSizeChoice('startframe', 'film');
  const sfPending = useRef(new Map<string, string>());
  const [sel, setSel] = useState<Set<string>>(new Set());
  useEffect(() => { const ids = new Set(allShots.map((x) => x.s.id)); setSel((cur) => (cur.size && [...cur].some((i) => !ids.has(i)) ? new Set([...cur].filter((i) => ids.has(i))) : cur)); }, [story.tree]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const f = (e: Event) => { const o = (e as CustomEvent<{ open: boolean }>).detail.open; setOpen(o ? Object.fromEntries(allShots.map((x) => ['s:' + x.s.id, true])) : {}); };
    window.addEventListener('driftboard-fold', f); return () => window.removeEventListener('driftboard-fold', f);
  }, [story.tree]);   // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (!n.delete(id)) n.add(id); return n; });
  // a shot asked for by the command palette: open its card and scroll to it
  useEffect(() => {
    const f = () => {
      const id = pendingShot; if (!id || !allShots.some((x) => x.s.id === id)) return; pendingShot = null;
      setOpen((o) => ({ ...o, ['s:' + id]: true }));
      setTimeout(() => { const el = document.querySelector<HTMLElement>(`[data-shot="${CSS.escape(id)}"]`); el?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); el?.focus?.(); }, 250);
    };
    f(); window.addEventListener('driftboard-shot-goto', f); return () => window.removeEventListener('driftboard-shot-goto', f);
  }, [story.tree]);   // eslint-disable-line react-hooks/exhaustive-deps
  const toggleMany = (ids: string[]) => setSel((s) => { const n = new Set(s); const all = ids.every((i) => n.has(i)); for (const i of ids) { if (all) n.delete(i); else n.add(i); } return n; });
  const inScope = (id: string) => !sel.size || sel.has(id);
  const chosenNeedsFrame = !!chosen && chosen.slots.some((s) => s.type === 'image' && s.required) && !!slotWithRole(chosen, 'first_frame');
  const noFrame = chosenNeedsFrame ? allShots.filter(({ s }) => inScope(s.id) && !s.frames?.first) : [];
  const needStart = noFrame.filter(({ s }) => elementsOfShot(s, story.bible).length > 0 && s.brief);
  const makeStartFrames = async (list: { s: Shot }[] = needStart) => {
    if (!maker || !story.bible) return;
    const si = sizeInfo(maker); let n = 0; const bad: string[] = [];
    for (const { s } of list) {
      const els = elementsOfShot(s, story.bible).slice(0, capacity(maker));
      const b = s.brief!;
      const prompt = `${story.bible.style}. A single still frame: the first frame of this shot, ${b.framing} framing. ${b.action} The reference pictures, in order: ${els.map((e, i) => `${i + 1} = ${e.name} (${e.role})`).join('; ')}. Keep each person, the place and every object exactly as in its reference picture: same face, hair, clothing, colours and materials. No text.`;
      const d: Draft = { profileId: maker.id, values: { prompt }, inputs: autoAssign(maker, els.map((e) => e.asset)), title: `Start frame for ${s.name}` };
      const v = valuesOfDraft(maker, d);
      const r = await api.generate(maker.id, si.ok ? withSize(v, resolveSize(sfSize, film, null, si.step)) : v);
      if (r.ok) { sfPending.current.set(r.job.id, s.id); n++; } else bad.push(`${s.name}: ${r.error}`);
    }
    notify(`Making ${n} start frame${n === 1 ? '' : 's'}… each becomes its shot's first frame when done${bad.length ? `; ${bad.length} could not be queued (${bad[0]})` : ''}`);
  };
  useEffect(() => {
    for (const [jid, shotId] of [...sfPending.current]) {
      const j = jobs.find((x) => x.id === jid); if (!j) continue;
      if (j.status === 'done' && j.outputs[0]) { sfPending.current.delete(jid); const sh = allShots.find((x) => x.s.id === shotId)?.s; if (sh) void op('updateShot', shotId, { frames: { ...(sh.frames ?? {}), first: j.outputs[0].assetId } }); }
      else if (j.status === 'failed' || j.status === 'cancelled') sfPending.current.delete(jid);
    }
  }, [jobs]);   // eslint-disable-line react-hooks/exhaustive-deps
  const needPrompt = allShots.filter(({ s }) => inScope(s.id) && s.brief && !s.prompt?.trim());
  const needTake = allShots.filter(({ s }) => inScope(s.id) && (alsoTaken || !s.takes.length) && (s.prompt?.trim() || s.brief));
  const generateHere = (shot: Shot) => { const d = draftForShot(shot, story, profiles, chosen?.id, kindMap); if (d) openDraft(d); };
  const writeFor = async (ids: string[], force = false): Promise<boolean> => {
    if (!chosen) { notify('No video model: turn one on in Settings › ComfyUI.'); return false; }
    const todo = allShots.filter(({ s }) => ids.includes(s.id) && s.brief && (force || !s.prompt?.trim())).map(({ s }) => s.id);
    if (!todo.length) return true;
    const r = await api.llmWritePrompts(todo, chosen.id, force);
    if (!r.ok) { notify(`Could not write prompts: ${r.error}. Check that the LLM server is running (top bar).`); return false; }
    notify(`Prompts: ${r.written} written${r.failed.length ? `, ${r.failed.length} failed (${r.failed[0]})` : ''}${r.cancelled ? ', cancelled' : ''}`);
    return !r.cancelled;
  };
  const runShots = async (ids: string[], again = alsoTaken) => {
    if (!chosen) return;
    if (!(await writeFor(ids))) return;
    const fresh = await api.story();
    let queued = 0, warnFrames = 0; const bad: string[] = [], skipped: string[] = [];
    type Plan = { s: Shot; pr: Manifest; values: Record<string, unknown>; issues: string[] };
    const plan: Plan[] = [];
    for (const { shots } of fresh.tree) for (const s of shots) {
      if (!ids.includes(s.id)) continue;
      if (!again && s.takes.length) continue;
      if (!s.prompt?.trim()) { skipped.push(s.name); continue; }
      const d = draftForShot(s, fresh, profiles, chosen.id, kindMap); if (!d) continue;
      const pr = profiles.find((x) => x.id === d.profileId) ?? chosen; const si = sizeInfo(pr);
      const first = Object.values(d.inputs).flat()[0]; const fa = s.frames?.first && first ? assets.get(first) : undefined;
      const ch = fa && size.purpose === 'film' ? { ...size, purpose: 'match' as const } : size;
      const values = si.ok ? withSize(valuesOfDraft(pr, d), resolveSize(ch, film, fa, si.step)) : valuesOfDraft(pr, d);
      if (fa && size.purpose === 'film' && Math.abs(fa.width! / fa.height! / (film.aspect.split(':').map(Number)[0]! / film.aspect.split(':').map(Number)[1]!) - 1) > 0.05) warnFrames++;
      plan.push({ s, pr, values, issues: checkPrompt(s.prompt, providedOf(pr.slots, d.inputs), pr.slots) });
    }
    const mism = plan.filter((x) => x.issues.length);
    let run = plan;
    if (mism.length) {
      const a = await askUser({ title: `${mism.length} of ${plan.length} shots have a prompt that does not fit its inputs`, lines: mism.map((x) => `${x.s.name}: ${x.issues[0]}`), message: 'Run them anyway, skip those shots, or cancel and fix them first (Open in Create on a shot shows its inputs).', buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'skip', label: 'Skip those' }, { id: 'run', label: 'Run all anyway', kind: 'danger' }] });
      if (a === 'skip') run = plan.filter((x) => !x.issues.length); else if (a !== 'run') return;
    }
    // a part that continues the shot before it (same take) starts from that shot's last frames: it waits for its take
    const prevOf = new Map(fresh.tree.flatMap(({ shots }) => shots.map((s, i) => [s.id, shots[i - 1]] as const)));
    const done = new Set<string>(); let chained = 0;
    for (const x of run) {
      const prev = prevOf.get(x.s.id);
      if (x.s.brief?.continues && prev && x.pr.slots.some((qq) => qq.role === 'guide_start')) {
        const r = await api.generateAfter(prev.id, x.pr.id, x.values, x.s.id, Math.max(1, batch), !done.has(prev.id));
        if (r.ok) { done.add(x.s.id); if (r.waiting) chained++; else queued += Math.max(1, batch); } else bad.push(`${x.s.name}: ${r.error}`);
        continue;
      }
      for (let k = 0; k < Math.max(1, batch); k++) {
        const values = { ...x.values }; if (batch > 1 && x.pr.slots.some((qq) => qq.role === 'seed')) values.seed = Math.floor(Math.random() * 2 ** 31);
        const r = await api.generate(x.pr.id, values, undefined, x.s.id, { ignoreWarnings: true });
        if (r.ok) { queued++; done.add(x.s.id); } else bad.push(`${x.s.name}: ${r.error}`);
      }
    }
    notify(`Queued ${queued} generation${queued === 1 ? '' : 's'}${chained ? `; ${chained} continuing part${chained === 1 ? '' : 's'} start${chained === 1 ? 's' : ''} as soon as the part before ${chained === 1 ? 'has' : 'have'} a take` : ''}${warnFrames ? `, ${warnFrames} follow their first frame's aspect instead of the film's ${film.aspect}` : ''}${skipped.length ? `, ${skipped.length} have no prompt (${skipped[0]})` : ''}${bad.length ? `, ${bad.length} could not be queued (${bad[0]})` : ''}`);
  };
  const promptBadge = (s: Shot) => {
    if (!s.prompt?.trim()) return null;
    const d = chosen ? draftForShot(s, story, profiles, chosen.id, kindMap) : null; const pr = d ? profiles.find((x) => x.id === d.profileId) : undefined;
    const kind = detectPromptKind(s.prompt).kind; const issues = pr && d ? checkPrompt(s.prompt, providedOf(pr.slots, d.inputs), pr.slots) : [];
    return <Chip tone={issues.length ? 'bad' : undefined} icon={issues.length ? 'warn' : undefined} title={issues.length ? issues.join(' ') : `Written as: ${KIND_LABEL[kind]}`}>{KIND_LABEL[kind]}</Chip>;
  };
  const llmBusy = !!prog?.running || !!workingNow();
  /* the plan behind a shot (the Director's shot it came from): found by its source id */
  const planOf = (s: Shot): { sceneId: string; i: number } | null => {
    if (!s.sourceId || !st) return null;
    for (const [sceneId, entry] of Object.entries(st.shots)) { const i = entry.shots.findIndex((_, k) => `${sceneId}-${k + 1}` === s.sourceId); if (i >= 0) return { sceneId, i }; }
    return null;
  };
  /** A plan field changed on a shot card: the story gets it now (undo works on it), the plan is told too, so the next sync keeps it. */
  const patchBrief = async (s: Shot, p: Partial<NonNullable<Shot['brief']>>) => {
    if (!s.brief) return;
    await op('updateShot', s.id, { brief: { ...s.brief, ...p } });
    const at = planOf(s); const cur = directorNow(); if (!at || !cur) return;
    const entry = cur.shots[at.sceneId]!;
    setDirectorQuiet(await api.directorUpdate({ shots: { ...cur.shots, [at.sceneId]: { ...entry, shots: entry.shots.map((x, k) => (k === at.i ? { ...x, ...p } as typeof x : x)) } } }));
  };
  const removeShot = async (s: Shot) => {
    if (s.sourceId) { const d = await loadDropped(); d[storyId] = [...new Set([...(d[storyId] ?? []), s.sourceId])]; await saveDropped(d); }
    await op('removeShot', s.id); notify(`Deleted “${s.name}” (Ctrl+Z over the shots brings it back)`);
  };
  const planShots = async (sceneSource?: string) => {
    const d = await loadDropped(); d[storyId] = sceneSource ? (d[storyId] ?? []).filter((x) => !x.startsWith(sceneSource + '-')) : []; await saveDropped(d);
    const e = await runStep('shots', sceneSource ? { only: sceneSource } : undefined); if (e) notify(`Could not plan the shots: ${e}. Check that the LLM server is running (top bar).`);
  };
  const splitScenes = async () => { const e = await runStep('scenes'); if (e) notify(`Could not split into scenes: ${e}`); };
  const renameScene = async (sceneId: string, sourceId: string | undefined, name: string) => {
    await op('updateScene', sceneId, { name });
    const cur = directorNow(); if (!sourceId || !cur?.scenes) return;
    if (cur.scenes.some((x) => x.id === sourceId)) setDirectorQuiet(await api.directorUpdate({ scenes: cur.scenes.map((x) => (x.id === sourceId ? { ...x, title: name } : x)) }));
  };
  const removeScene = async (sceneId: string, sourceId: string | undefined, name: string) => {
    if (!(await confirmUser(`Delete the scene “${name}”?`, 'Its shots move to the scene before it (or are removed when this is the only scene and they have no takes). Ctrl+Z over the shots brings it back.', 'Delete scene', true))) return;
    await op('removeScene', sceneId);
    const cur = directorNow(); if (sourceId && cur?.scenes?.some((x) => x.id === sourceId)) { const { [sourceId]: _x, ...rest } = cur.shots; setDirectorQuiet(await api.directorUpdate({ scenes: cur.scenes.filter((x) => x.id !== sourceId), shots: rest })); }
  };
  const hasScenesToPlan = !!st && (screenplay ? ((st.parsed as { scenes?: unknown[] }).scenes?.length ?? 0) > 0 : (st.scenes?.length ?? 0) > 0);
  const nPlanned = st ? Object.values(st.shots).reduce((n, x) => n + x.shots.length, 0) : 0;
  const sizeOk = chosen && sizeInfo(chosen).ok;
  const sizeNow = sizeOk ? (() => { try { return resolveSize(size, film, null, sizeInfo(chosen!).step); } catch { return null; } })() : null;

  return (
    <div className="pb shotsStage">
      <Card className="toolCard">
        {videoProfiles.length > 0 && <label className="row" style={{ margin: 0 }}><span className="lbl" style={{ whiteSpace: 'nowrap' }}>Video model</span>
          <select className="selc" style={{ flex: 1, minWidth: 0 }} aria-label="Video model of this story" title="The model the shots are planned, written and run for" value={chosen?.id ?? ''} onChange={(e) => setProfileId(e.target.value)}>{videoProfiles.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}</select></label>}
        <div className="row wrap">
          {st?.parsed && !screenplay && !st.scenes?.length && <Button size="sm" icon="scene" disabled={llmBusy} title="The LLM splits the loose story into scenes" onClick={() => void splitScenes()}>Split into scenes</Button>}
          {st?.parsed && <Button size="sm" icon="wand" disabled={llmBusy || !hasScenesToPlan} title={hasScenesToPlan ? 'The LLM plans the shots of every scene (framing, move, length, dialogue). Takes and picks stay.' : 'Split the story into scenes first'} onClick={() => void planShots()}>{nPlanned ? 'Plan shots again' : 'Plan shots'}</Button>}
          {st?.parsed && <label className="row" style={{ margin: 0, gap: 6 }} title="The longest clip the planner makes. A longer shot is cut into parts of at most this length that continue the same take (each part starts from the last frames of the one before). Used the next time shots are planned."><span className="xs dim">Longest clip</span>
            <select className="selc" aria-label="Longest clip" value={st.maxPart ?? 10} onChange={(e) => void updDirector({ maxPart: Number(e.target.value) })}>{[5, 6, 8, 10, 12, 15].filter((n) => !chosen?.director?.seconds || n <= Math.max(...chosen.director.seconds)).map((n) => <option key={n} value={n}>{n} s</option>)}</select></label>}
          <Button size="sm" icon="pencil" disabled={llmBusy || !needPrompt.length} title="One LLM batch: write the prompt of every shot that has none, then free the GPU" onClick={() => void writeFor(needPrompt.map(({ s }) => s.id))}>Write prompts ({needPrompt.length})</Button>
          <span className="sp" />
          <Stepper value={batch} onChange={setBatch} label="Takes" title={`Takes ×${batch}: how many takes are queued for each shot, each with its own seed (ComfyUI calls this batch size)`} />
          <Button size="sm" kind="primary" icon="play" disabled={llmBusy || !needTake.length || !chosen} title="Write missing prompts first (LLM), then queue the shots for generation (GPU)" onClick={() => void runShots(needTake.map(({ s }) => s.id))}>{sel.size ? 'Run selected' : 'Run all'} ({needTake.length})</Button>
        </div>
        <label className="check small"><input type="checkbox" checked={alsoTaken} onChange={(e) => setAlsoTaken(e.target.checked)} />Also shots that already have takes</label>
        {sizeOk && <Section title="Size of every shot you run" icon="fit" count={sizeNow ? `· ${sizeNow.w}×${sizeNow.h}` : undefined} fold foldKey="storySize" defaultOpen={false}>
          <SizeChooser value={size} onChange={setSize} step={sizeInfo(chosen!).step} />
          <span className="xs faint">Shots that start from a picture follow its aspect when this says Film. One shot can be changed with Open in Create.</span>
        </Section>}
        {noFrame.length > 0 && <Notice tone="warn"><span>{chosen!.title} must start from a picture: {noFrame.length} shot{noFrame.length === 1 ? ' has' : 's have'} no first frame and {noFrame.length === 1 ? 'is' : 'are'} not run by it.</span>{needStart.length > 0 && maker && <div className="row"><Button size="sm" title={`Compose one picture per shot from the bible with ${maker.title}; it becomes the shot's first frame`} onClick={() => void makeStartFrames()}>Make {needStart.length} from the bible</Button></div>}</Notice>}
        <div className="row wrap">
          <input className="inp" style={{ flex: 1, minWidth: 140 }} placeholder="Search scenes, shots, takes, tags, prompts" aria-label="Search the shots" value={q} onChange={(e) => setQ(e.target.value)} />
          <ViewBar value={view} onChange={setView} />
        </div>
        <div className="row wrap">
          <Button size="sm" kind="quiet" icon="plus" onClick={() => void op('addScene', `Scene ${story.tree.length + 1}`, story.activeId)}>Scene</Button>
          <Button size="sm" kind="quiet" icon="arrange" title="Lay the canvas out by scene and shot" onClick={async () => { const r = await api.boardArrange(); notify(`Arranged ${plural(r.scenes, 'scene')}, moved ${plural(r.moved, 'item')}`); window.dispatchEvent(new Event('driftboard-fit')); }}>Arrange canvas</Button>
          <span className="sp" />
          <Button size="sm" icon="film" title="Add every picked take to the timeline (or swap changed picks)" onClick={() => void pickAllToTimeline()}>Picks → timeline</Button>
        </div>
      </Card>
      {sel.size > 0 && <div className="selBarP">
        <span className="small"><b>{sel.size}</b> shot{sel.size === 1 ? '' : 's'} selected</span><span className="sp" />
        <Button size="sm" kind="quiet" disabled={llmBusy} onClick={async () => { if (await confirmUser(`Clear the prompts of ${sel.size} selected shot${sel.size === 1 ? '' : 's'}?`, 'Takes and pictures stay. Ctrl+Z over the shots brings the prompts back.', 'Clear prompts', true)) for (const id of sel) void op('updateShot', id, { prompt: '', generatedPrompt: undefined, promptWarnings: [] }); }}>Clear prompts</Button>
        <Button size="sm" disabled={llmBusy} onClick={async () => { if (await confirmUser(`Rewrite the prompts of ${sel.size} selected shot${sel.size === 1 ? '' : 's'}?`, 'The LLM writes them again and your current prompts are replaced.', 'Rewrite prompts')) void writeFor([...sel], true); }}>Rewrite prompts</Button>
        <Button size="sm" disabled={llmBusy} title="Queue a new take for every selected shot, even those that already have takes" onClick={() => void runShots([...sel], true)}>New take for each</Button>
        <IconButton size="sm" icon="x" label="Clear the selection" onClick={() => setSel(new Set())} />
      </div>}
      <span className="xs faint">{plural(story.tree.length, 'scene')} · {plural(shotCount, 'shot')} · {story.tree.flatMap((t) => t.shots).filter((s) => s.pick).length} picked</span>
      {filtered.map(({ scene, shots }, si) => {
        const collapsed = open[scene.id] === false;
        const fromScript = !!scene.sourceId && screenplay && (st?.parsed as { scenes?: { id: string }[] } | undefined)?.scenes?.some((x) => x.id === scene.sourceId);
        return (
          <div className="scene sceneG" key={scene.id}>
            <div className="sceneH">
              <IconButton size="sm" icon={collapsed ? 'chevR' : 'chev'} label={collapsed ? `Open ${scene.name}` : `Fold ${scene.name}`} onClick={() => setOpen((o) => ({ ...o, [scene.id]: o[scene.id] === false }))} />
              <input type="checkbox" aria-label={`Select every shot of ${scene.name}`} title="Select every shot of this scene" checked={shots.length > 0 && shots.every((x) => sel.has(x.id))} onChange={() => toggleMany(shots.map((x) => x.id))} />
              {editing === scene.id ? <input className="inp" autoFocus defaultValue={scene.name} onBlur={(e) => { void renameScene(scene.id, scene.sourceId, e.target.value || scene.name); setEditing(null); }} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
                : <b onDoubleClick={() => { if (!fromScript) setEditing(scene.id); }} title={fromScript ? 'Comes from the scene heading in the script: change it in Script' : 'Double-click to rename'}>{scene.name}</b>}
              <span className="xs faint">{shots.length}</span><span className="sp" />
              {scene.sourceId && st?.shots && hasScenesToPlan && <IconButton size="sm" icon="wand" label="Plan this scene's shots again (LLM)" disabled={llmBusy} onClick={() => void planShots(scene.sourceId)} />}
              <IconButton size="sm" icon="play" label="Run this scene: write missing prompts, then generate its shots without takes" disabled={llmBusy || !shots.length} onClick={() => void runShots(shots.map((x) => x.id))} />
              <IconButton size="sm" icon="up" label="Move up" disabled={si === 0 || !!q} onClick={() => void op('moveScene', scene.id, -1)} />
              <IconButton size="sm" icon="chev" label="Move down" disabled={!!q} onClick={() => void op('moveScene', scene.id, 1)} />
              <IconButton size="sm" icon="plus" label="Add a shot" onClick={() => void op('addShot', scene.id)} />
              <IconButton size="sm" icon="trash" label={fromScript ? 'Comes from the script: remove it in Script' : 'Delete the scene'} disabled={!!fromScript} onClick={() => void removeScene(scene.id, scene.sourceId, scene.name)} />
            </div>
            {!collapsed && <div className={viewClass(view)}>{shots.map((s) => <ShotCard key={s.id} s={s} exp={!!open['s:' + s.id]} setExp={(v) => setOpen((o) => ({ ...o, ['s:' + s.id]: v }))} sel={sel.has(s.id)} toggleSel={() => toggle(s.id)}
              editing={editing === s.id} setEditing={(v) => setEditing(v ? s.id : null)} selectedAssets={selectedAssets} focus={focus} openDraft={openDraft} kindMap={kindMap} promptOf={promptOf} nameOf={nameOf}
              badge={promptBadge(s)} llmBusy={llmBusy} run={() => void runShots([s.id], true)} openInCreate={() => generateHere(s)} remove={() => void removeShot(s)} writeOne={() => void writeFor([s.id], true)}
              patchBrief={(p) => void patchBrief(s, p)}
              startFrame={chosenNeedsFrame && !s.frames?.first && elementsOfShot(s, story.bible).length > 0 && maker ? () => void makeStartFrames([{ s }]) : undefined} />)}</div>}
          </div>
        );
      })}
      {unsorted.length > 0 && (
        <div className="scene sceneG">
          <div className="sceneH"><Icon name="grid" size="s" /><b>Unsorted</b><span className="xs faint">{unsorted.length} not in any shot</span></div>
          <div className="takes">
            {unsorted.slice(0, 60).map((a) => (
              <div key={a.id} className="take">
                <Tile src={thumbUrl(a.id)} title={promptOf.get(a.id) ?? nameOf(a)} onClick={() => focus(a.id)} style={{ width: '100%' }} />
                <select className="selc" aria-label="Add to a shot" value="" onChange={(e) => e.target.value && void op('addTake', e.target.value, a.id)}>
                  <option value="">Add to shot…</option>
                  {allShots.map(({ s, scene }) => <option key={s.id} value={s.id}>{scene.name} / {s.name}</option>)}
                </select>
              </div>
            ))}
          </div>
          {unsorted.length > 60 && <span className="xs faint">+{unsorted.length - 60} more (use search)</span>}
        </div>
      )}
      {!story.tree.length && <Empty icon="scene" title="No shots yet">Plan them from the script (Script, then Plan shots here), make them from pictures on the Board, or add a scene and shots by hand.</Empty>}
      {story.tree.length > 0 && q.trim() && !filtered.length && !unsorted.length && <Empty icon="search" title={`No matches for “${q}”`} />}
    </div>
  );
}

function ShotCard({ s, exp, setExp, sel, toggleSel, editing, setEditing, selectedAssets, focus, openDraft, kindMap, promptOf, nameOf, badge, llmBusy, run, openInCreate, remove, writeOne, patchBrief, startFrame }: {
  s: Shot; exp: boolean; setExp: (v: boolean) => void; sel: boolean; toggleSel: () => void; editing: boolean; setEditing: (v: boolean) => void; selectedAssets: string[]; focus: (id: string) => void; openDraft: (d: Draft) => void;
  kindMap: Map<string, string>; promptOf: Map<string, string>; nameOf: (a: Asset) => string; badge: ReactNode; llmBusy: boolean; run: () => void; openInCreate: () => void; remove: () => void; writeOne: () => void;
  patchBrief: (p: Partial<NonNullable<Shot['brief']>>) => void; startFrame?: () => void;
}) {
  const { story, assets } = useContext(C);
  const { st, targets } = useDirector();
  const op = (name: Parameters<typeof api.storyOp>[0], ...a: unknown[]) => api.storyOp(name, ...a);
  const status = statusOf(s);
  const lengths = (targets.find((t) => t.id === st?.targetId) ?? targets[0])?.seconds ?? [3, 5, 8, 10];
  const refs = refsOfShot(s, story.bible);
  const bibleNames = [...(story.bible?.characters ?? []), ...(story.bible?.places ?? []), ...(story.bible?.props ?? [])];
  const m = mediaOfShot(s, story.bible, kindMap);
  const thumb = s.pick ?? s.takes[0]?.assetId;
  const addTakes = async () => { for (const a of selectedAssets) await op('addTake', s.id, a); };
  return (
    <div className={'shot vcard' + (exp ? ' wide' : '') + (sel ? ' sel' : '')} data-shot={s.id}>
      <div className="shh">
        <IconButton size="sm" icon={exp ? 'chev' : 'chevR'} label={exp ? 'Fold the shot' : 'Open the shot'} onClick={() => setExp(!exp)} />
        <input type="checkbox" aria-label={`Select ${s.name}`} title="Select this shot for batch work" checked={sel} onChange={toggleSel} />
        <i className={'sdot is-' + status} title={STATUS_TITLE[status]} />
        {editing ? <input className="inp" autoFocus defaultValue={s.name} onBlur={(e) => { void op('updateShot', s.id, { name: e.target.value || s.name }); setEditing(false); }} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
          : <span className="nm" onDoubleClick={() => setEditing(true)} title="Double-click to rename">{s.name}</span>}
        <span className="xs faint">{s.takes.length} take{s.takes.length === 1 ? '' : 's'}</span>
        {s.brief?.continues && <Chip icon="cont" title="Continues the shot before as the same take: made from its last frames when it has a take">continues</Chip>}
        {badge}
        <span className="sp" />
        <IconButton size="sm" icon="plus" label={selectedAssets.length ? `Add the ${selectedAssets.length} selected on the canvas as takes` : 'Select pictures or clips on the canvas to add them as takes'} disabled={!selectedAssets.length} onClick={() => void addTakes()} />
        <IconButton size="sm" icon="play" label="Run this shot now: write its prompt if missing, then queue a new take" disabled={llmBusy} onClick={run} />
        <IconButton size="sm" icon="create" label="Open in Create (to change settings first)" onClick={openInCreate} />
        <IconButton size="sm" icon="trash" label="Delete the shot" onClick={remove} />
      </div>
      <div className="shm" onClick={() => !exp && setExp(true)}>
        {thumb && <img className="pickThumb" src={thumbUrl(thumb)} alt="" onClick={(e) => { e.stopPropagation(); focus(thumb); }} />}
        <span className="xs dim">{s.brief ? `${s.brief.framing} · ${s.brief.move} · ${s.brief.seconds} s` : 'no plan'}</span>
        {s.frames?.first && <Chip icon="image">start frame</Chip>}
        {refs.length > 0 && <Chip>{refs.length} picture{refs.length === 1 ? '' : 's'}</Chip>}
        {s.brief?.action && <span className="xs faint act">{s.brief.action}</span>}
      </div>
      {s.tags.length > 0 && <div className="tags">{s.tags.map((t) => <span key={t} className="tag">{t}</span>)}</div>}
      {exp && <div className="shb">
        {s.brief && <>
          <div className="ilabel">Plan</div>
          <div className="plan">
            <select className="selc" aria-label="Framing" value={s.brief.framing} onChange={(e) => patchBrief({ framing: e.target.value })}>{[...new Set([s.brief.framing, ...FRAMINGS])].map((f) => <option key={f}>{f}</option>)}</select>
            <select className="selc" aria-label="Camera move" value={s.brief.move} onChange={(e) => patchBrief({ move: e.target.value })}>{[...new Set([s.brief.move, ...MOVES])].map((f) => <option key={f}>{f}</option>)}</select>
            <select className="selc" aria-label="Length" value={s.brief.seconds} onChange={(e) => patchBrief({ seconds: Number(e.target.value) })}>{[...new Set([s.brief.seconds, ...lengths])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{n} s</option>)}</select>
            <select className="selc" aria-label="Prompt type" title="What kind of prompt to write for this shot" value={(s.brief as { promptMode?: string }).promptMode ?? 'auto'} onChange={(e) => patchBrief({ promptMode: e.target.value } as never)}><option value="auto">Prompt: auto</option><option value="text">Text only</option><option value="refs">With pictures</option></select>
          </div>
          <textarea className="ta" style={{ minHeight: 50 }} aria-label="What happens" key={'a' + s.brief.action} defaultValue={s.brief.action} onBlur={(e) => e.target.value !== s.brief!.action && patchBrief({ action: e.target.value, beats: undefined })} />
          <label className="check" title="On: this clip is the next part of the same camera take. It is made from the last frames of the shot before (it waits for its take), and its prompt carries on from that shot's prompt. Off: a cut."><input type="checkbox" checked={!!s.brief.continues} onChange={(e) => patchBrief({ continues: e.target.checked })} />Continues the shot before (same take, no cut)</label>
          <textarea className="ta" style={{ minHeight: 40 }} aria-label="How the shot ends" placeholder="How things stand at the end (who is where, holding what): the next shot of the scene starts from this" key={'e' + (s.brief.endState ?? '')} defaultValue={s.brief.endState ?? ''} onBlur={(e) => e.target.value !== (s.brief!.endState ?? '') && patchBrief({ endState: e.target.value || undefined })} />
          {s.brief.dialogue.map((d, k) => (
            <div key={k} className="row">
              <input className="inp" style={{ width: 110 }} aria-label="Who speaks" defaultValue={d.speaker} onBlur={(e) => e.target.value !== d.speaker && patchBrief({ dialogue: s.brief!.dialogue.map((x, qq) => (qq === k ? { ...x, speaker: e.target.value } : x)) })} />
              <input className="inp" style={{ flex: 1 }} aria-label="The spoken line" title="Word for word from the script" defaultValue={d.line} onBlur={(e) => e.target.value !== d.line && patchBrief({ dialogue: s.brief!.dialogue.map((x, qq) => (qq === k ? { ...x, line: e.target.value } : x)) })} />
              <IconButton size="sm" icon="x" label="Remove this line from the shot" onClick={() => patchBrief({ dialogue: s.brief!.dialogue.filter((_, qq) => qq !== k) })} />
            </div>
          ))}
          <div className="row"><Button size="sm" kind="quiet" icon="plus" onClick={() => patchBrief({ dialogue: [...s.brief!.dialogue, { speaker: story.bible?.characters[0]?.name ?? '', line: '' }] })}>Line</Button></div>
        </>}
        <div className="ilabel">Inputs</div>
        <div className="row wrap" style={{ alignItems: 'flex-start' }}>
          {s.frames?.first && <div className="slotTile"><Tile src={thumbUrl(s.frames.first)} badge="first" onClick={() => focus(s.frames!.first!)} onRemove={() => void op('updateShot', s.id, { frames: { ...s.frames, first: undefined } })} removeLabel="Remove the first frame"><PrepInput id={s.frames.first} selected={selectedAssets} openDraft={openDraft} onReplace={(n) => void op('updateShot', s.id, { frames: { ...s.frames, first: n } })} /></Tile></div>}
          {s.frames?.last && <div className="slotTile"><Tile src={thumbUrl(s.frames.last)} badge="last" onClick={() => focus(s.frames!.last!)} onRemove={() => void op('updateShot', s.id, { frames: { ...s.frames, last: undefined } })} removeLabel="Remove the last frame"><PrepInput id={s.frames.last} selected={selectedAssets} openDraft={openDraft} onReplace={(n) => void op('updateShot', s.id, { frames: { ...s.frames, last: n } })} /></Tile></div>}
          {refs.map((a, n) => { const nm = bibleNames.find((x) => x.refAsset === a)?.name; return <div className="slotTile" key={a} title={`<Picture ${n + 1}> ${nm ?? 'reference'}`}><Tile src={thumbUrl(a)} badge={`Picture ${n + 1}`} onClick={() => focus(a)} onRemove={() => void op('updateShot', s.id, { refs: refs.filter((x) => x !== a) })} removeLabel="Take this reference off the shot"><PrepInput id={a} selected={selectedAssets} openDraft={openDraft} onReplace={(nn) => void op('updateShot', s.id, { refs: refs.map((x) => (x === a ? nn : x)) })} /></Tile>{nm && <span className="meta">{nm}</span>}</div>; })}
          {m.voices.map((v, n) => <div className="slotTile" key={'v' + v.asset} title={`<Audio ${n + 1}> voice of ${v.name} (from the bible)`}><Tile kind="audio" badge={`Audio ${n + 1}`} onClick={() => focus(v.asset)} /><span className="meta">voice · {v.name}</span></div>)}
          {m.audios.map((a, n) => <div className="slotTile" key={'a' + a} title={`<Audio ${m.voices.length + n + 1}> audio reference`}><Tile kind="audio" badge={`Audio ${m.voices.length + n + 1}`} onClick={() => focus(a)} onRemove={() => void op('updateShot', s.id, { media: (s.media ?? []).filter((x) => x !== a) })} /></div>)}
          {m.videos.map((a, n) => <div className="slotTile" key={'m' + a} title={`<Video ${n + 1}> video reference`}><Tile src={thumbUrl(a)} badge={`Video ${n + 1}`} onClick={() => focus(a)} onRemove={() => void op('updateShot', s.id, { media: (s.media ?? []).filter((x) => x !== a) })} /></div>)}
          {!s.frames?.first && !s.frames?.last && !refs.length && !(s.media?.length) && !m.voices.length && <span className="xs faint">none</span>}
        </div>
        <div className="row wrap">
          <Button size="sm" kind="quiet" icon="plus" disabled={!selectedAssets.some((a) => assets.get(a)?.kind === 'image')} title="Add the pictures selected on the canvas as references" onClick={() => void op('updateShot', s.id, { refs: [...new Set([...refs, ...selectedAssets.filter((a) => assets.get(a)?.kind === 'image')])] })}>From selection ({selectedAssets.filter((a) => assets.get(a)?.kind === 'image').length})</Button>
          <Button size="sm" kind="quiet" icon="plus" disabled={!selectedAssets.some((a) => ['video', 'audio'].includes(assets.get(a)?.kind ?? ''))} title="Add the clips or sounds selected on the canvas as video or audio references" onClick={() => void op('updateShot', s.id, { media: [...new Set([...(s.media ?? []), ...selectedAssets.filter((a) => ['video', 'audio'].includes(assets.get(a)?.kind ?? ''))])] })}>Video / sound</Button>
          {startFrame && <Button size="sm" kind="quiet" icon="image" title="Compose this shot's first frame from the bible" onClick={startFrame}>Make start frame</Button>}
          {s.refs !== undefined && <Button size="sm" kind="quiet" icon="restore" title="Use the bible's pictures for this shot again" onClick={() => void op('updateShot', s.id, { refs: undefined })}>Bible pictures</Button>}
        </div>
        <div className="ilabel">Prompt<span className="sp" />
          <Button size="sm" kind="quiet" icon="regen" disabled={llmBusy || !s.brief} title={s.brief ? 'Write this prompt (again) with the LLM; replaces it' : 'This shot has no plan to write from: write the prompt yourself'} onClick={writeOne}>{s.prompt?.trim() ? 'Rewrite' : 'Write'}</Button>
          {s.prompt?.trim() && <Button size="sm" kind="quiet" icon="x" onClick={() => void op('updateShot', s.id, { prompt: '', generatedPrompt: undefined, promptWarnings: [] })}>Clear</Button>}</div>
        <textarea className="ta" style={{ minHeight: 80 }} key={s.prompt} aria-label="Prompt" placeholder="No prompt yet: write one, or let the LLM write it (Write)." defaultValue={s.prompt ?? ''} onBlur={(e) => e.target.value !== (s.prompt ?? '') && void op('updateShot', s.id, { prompt: e.target.value })} />
        {(s.promptWarnings?.length ?? 0) > 0 && <Notice tone="warn">{s.promptWarnings!.map((w, k) => <span key={k}>{w}</span>)}</Notice>}
        <div className="ilabel">Takes</div>
        <div className="takes">
          {s.takes.map((t) => {
            const a = assets.get(t.assetId); if (!a) return null;
            const picked = s.pick === t.assetId;
            return (
              <div key={t.assetId} className="take">
                <Tile src={thumbUrl(a.id)} title={promptOf.get(a.id) ?? nameOf(a)} onClick={() => focus(a.id)} style={{ width: '100%', ...(picked ? { borderColor: 'var(--primary)', borderWidth: 2 } : t.status === 'rejected' ? { opacity: 0.55 } : {}) }} badge={a.kind === 'video' && a.duration_ms ? `${(a.duration_ms / 1000).toFixed(1)} s` : undefined} />
                <div className="tb">
                  <button type="button" className={picked ? 'on p' : ''} aria-pressed={picked} title="Pick: this take goes to the timeline" aria-label="Pick" onClick={() => void op('setPick', s.id, picked ? undefined : t.assetId)}><Icon name={picked ? 'starf' : 'star'} size={13} /></button>
                  <button type="button" className={t.status === 'approved' ? 'on o' : ''} aria-pressed={t.status === 'approved'} title="Approve" aria-label="Approve" onClick={() => void op('setTakeStatus', s.id, t.assetId, t.status === 'approved' ? 'draft' : 'approved')}><Icon name="check" size={13} /></button>
                  <button type="button" className={t.status === 'rejected' ? 'on r' : ''} aria-pressed={t.status === 'rejected'} title="Reject" aria-label="Reject" onClick={() => void op('setTakeStatus', s.id, t.assetId, t.status === 'rejected' ? 'draft' : 'rejected')}><Icon name="x" size={13} /></button>
                  <button type="button" title="Take it off this shot (the file stays)" aria-label="Remove from the shot" onClick={() => void op('removeTake', s.id, t.assetId)}><Icon name="minus" size={13} /></button>
                </div>
              </div>
            );
          })}
          {!s.takes.length && <span className="xs faint">No takes yet. Run the shot, or select pictures or clips on the canvas and add them with +.</span>}
        </div>
        <TagEditor tags={s.tags} onChange={(tags) => void op('updateShot', s.id, { tags })} />
        <textarea className="ta" style={{ minHeight: 44 }} aria-label="Notes" placeholder="Notes…" defaultValue={s.notes ?? ''} onBlur={(e) => e.target.value !== (s.notes ?? '') && void op('updateShot', s.id, { notes: e.target.value })} />
      </div>}
    </div>
  );
}

export function TagEditor({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }) {
  const [v, setV] = useState('');
  const add = () => { const t = v.trim(); if (t) onChange([...tags, t]); setV(''); };
  return (
    <div className="tags">
      {tags.map((t) => <Chip key={t} onRemove={() => onChange(tags.filter((x) => x !== t))} removeLabel={`Remove the tag ${t}`}>{t}</Chip>)}
      <input className="inp tagIn" type="text" aria-label="Add a tag" placeholder="+ tag" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} onBlur={add} />
    </div>
  );
}
