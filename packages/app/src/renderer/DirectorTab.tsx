import { PrepInput } from "./PrepInput.tsx";
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { C, api, thumbUrl, activity } from './shared.tsx';
import { Storyboard } from './Storyboard.tsx';
import { SizeChooser, resolveSize, sizeInfo, useSizeChoice, withSize, type SizeChoice } from './size.tsx';
import { Cards, ViewBar, ViewCtx, useView, viewClass, type ViewState } from './View.tsx';
import { confirmUser, tellUser } from './Ask.tsx';
import { registerUndo } from './undoRouter.ts';
import type { ElementGen } from '@driftboard/director';
import type { DirectorRunCard, DirectorProgress, DirectorState, DirectorStep, DirectorTarget, LlmStatus } from '../main/api.ts';

type Bible = NonNullable<DirectorState['bible']>;
const FRAMINGS = ['wide', 'medium', 'close', 'extreme-close', 'over-the-shoulder', 'low-angle', 'high-angle', 'top-down'];
const MOVES = ['static', 'push-in', 'pull-back', 'pan', 'tilt', 'tracking', 'orbit', 'crane', 'handheld', 'rack-focus'];

type Kind = 'characters' | 'places' | 'props';
export function DirectorTab({ selectedAssets, notify }: { selectedAssets: string[]; notify: (m: string) => void }) {
  const { story, jobs, profiles, film } = useContext(C);
  const [working, setWorking] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());   // prompts ticked for batch work
  const pending = useRef(new Map<string, { kind: Kind; id: string; batch: string }>());   // job id -> element waiting for its picture
  const applied = useRef(new Set<string>());   // batches whose first picture already became the reference
  const undoStack = useRef<Pick<DirectorState, 'bible' | 'scenes' | 'shots' | 'prompts' | 'style' | 'accepted' | 'name'>[]>([]);
  const redoStack = useRef<typeof undoStack.current>([]);
  const [undoN, setUndoN] = useState(0);
  const [redoN, setRedoN] = useState(0);
  const imageProfile = profiles.find((p) => p.kind === 'image' && p.slots.some((s) => s.role === 'prompt' && s.type === 'text') && !p.slots.some((s) => s.type === 'image_list')) ?? profiles.find((p) => p.kind === 'image');
  const [st, setSt] = useState<DirectorState | null>(null);
  const [targets, setTargets] = useState<DirectorTarget[]>([]);
  const [llm, setLlm] = useState<LlmStatus | null>(null);
  const [prog, setProg] = useState<DirectorProgress | null>(null);
  const [err, setErr] = useState('');
  type DTab = 'script' | 'pictures' | 'bible' | 'scenes' | 'shots' | 'prompts';
  const [tab, setTabState] = useState<DTab>(() => { try { return (['script', 'pictures', 'bible', 'scenes', 'shots', 'prompts'].includes(localStorage.getItem('driftboard.dirTab') ?? '') ? localStorage.getItem('driftboard.dirTab') as DTab : 'script'); } catch { return 'script'; } });
  const setTab = (t: DTab) => { setTabState(t); try { localStorage.setItem('driftboard.dirTab', t); } catch { /* ignore */ } };
  const [runs, setRuns] = useState<{ activeId: string | null; runs: DirectorRunCard[] } | null>(null);
  const [rview, setRview] = useView('dir-runs');
  const [renaming, setRenaming] = useState<string | null>(null);
  const loadRuns = useCallback(async () => setRuns(await api.directorRuns()), []);
  useEffect(() => { void loadRuns(); }, [loadRuns]);
  // output settings per category: characters are portraits, places are wide, props are square
  const [sizeChars, setSizeChars] = useSizeChoice('bible-characters', 'character');
  const [sizePlaces, setSizePlaces] = useSizeChoice('bible-places', 'wide');
  const [sizeProps, setSizeProps] = useSizeChoice('bible-props', 'square');
  const [batchN, setBatchN] = useState<Record<Kind, number>>({ characters: 1, places: 1, props: 1 });
  const [text, setText] = useState('');
  const [interp, setInterp] = useState('');
  const [missing, setMissing] = useState<{ speaker: string; line: string; saidBy?: string }[]>([]);

  const load = useCallback(async () => { const r = await api.directorState(); setSt(r.state); setTargets(r.targets); setText((t) => t || r.state.scriptText); }, []);
  useEffect(() => { setInterp(st?.interpreted ?? ''); if (st?.interpreted) void api.directorMissing(st.scriptText, st.interpreted).then(setMissing); else setMissing([]); }, [st?.interpreted]);   // eslint-disable-line react-hooks/exhaustive-deps
  const refreshLlm = useCallback(async () => setLlm(await api.llmStatus()), []);
  useEffect(() => { void load(); void refreshLlm(); const off = api.onDirectorProgress((p) => { setProg(p); if (!p.running) void load(); }); return off; }, [load, refreshLlm]);

  // a picture made for a character arrives: it becomes the character's reference picture
  useEffect(() => {
    if (!st?.bible) return;
    for (const [jid, w] of [...pending.current]) {
      const j = jobs.find((x) => x.id === jid); if (!j) continue;
      if (j.status === 'done' && j.outputs[0]) {
        pending.current.delete(jid); const bible = st.bible; const asset = j.outputs[0].assetId;
        if (applied.current.has(w.batch)) continue;   // a batch: the first picture is the reference, the others stay on the canvas
        applied.current.add(w.batch);
        void api.directorUpdate({ bible: { ...bible, [w.kind]: (bible[w.kind] ?? []).map((c) => (c.id === w.id ? { ...c, refAsset: asset } : c)) } }).then(setSt);
      } else if (j.status === 'failed' || j.status === 'cancelled') pending.current.delete(jid);
    }
  }, [jobs]);

  const undoRef = useRef<() => void>(() => {}); const redoRef = useRef<() => void>(() => {});
  // Ctrl+Z / Ctrl+Shift+Z reach the Director only while the pointer is over it (see undoRouter)
  useEffect(() => registerUndo('director', { undo: () => undoRef.current(), redo: () => redoRef.current() }), []);

  if (!st) return <div className="empty">Loading…</div>;
  const target = targets.find((t) => t.id === st.targetId) ?? targets[0];
  const busy = !!prog?.running || !!working;
  /** Every edit made here can be undone (the last 40), also removed characters, places and props. */
  const upd = async (patch: Parameters<typeof api.directorUpdate>[0]) => {
    const { bible, scenes, shots, prompts, style, accepted, name } = st;
    undoStack.current.push(structuredClone({ bible, scenes, shots, prompts, style, accepted, name })); if (undoStack.current.length > 40) undoStack.current.shift(); setUndoN(undoStack.current.length);
    redoStack.current = []; setRedoN(0);
    setSt(await api.directorUpdate(patch));
  };
  const undo = async () => {
    const prev = undoStack.current.pop(); setUndoN(undoStack.current.length); if (!prev) return;
    const { bible, scenes, shots, prompts, style, accepted, name } = st;
    redoStack.current.push(structuredClone({ bible, scenes, shots, prompts, style, accepted, name })); setRedoN(redoStack.current.length);
    setSt(await api.directorUpdate(prev)); notify('Undone');
  };
  const redo = async () => {
    const next = redoStack.current.pop(); setRedoN(redoStack.current.length); if (!next) return;
    const { bible, scenes, shots, prompts, style, accepted, name } = st;
    undoStack.current.push(structuredClone({ bible, scenes, shots, prompts, style, accepted, name })); setUndoN(undoStack.current.length);
    setSt(await api.directorUpdate(next)); notify('Redone');
  };
  const WORK: Record<DirectorStep, string> = { bible: 'Writing the story bible', scenes: 'Splitting the story into scenes', shots: 'Planning the shots', prompts: 'Writing prompts' };
  const run = async (s: DirectorStep, opts?: { only?: string | string[]; force?: boolean }) => {
    setErr(''); setWorking(WORK[s]); activity('director-' + s, WORK[s] + '…');
    try { const r = await api.directorRun(s, opts); if (!r.ok) setErr(r.error); else setSt(r.state); }
    finally { setWorking(''); activity('director-' + s, null); }
    void refreshLlm();
  };
  /** Generate reference pictures for one element with the image model; when the first one is done it becomes the element's picture (all of them land on the canvas). */
  const makePicture = async (kind: Kind, id: string, prompt: string, choice: SizeChoice, count: number) => {
    if (!imageProfile) return;
    const si = sizeInfo(imageProfile); const batch = Math.random().toString(36).slice(2);
    for (let k = 0; k < Math.max(1, count); k++) {
      const base: Record<string, unknown> = si.ok ? withSize({ prompt }, resolveSize(choice, film, null, si.step)) : { prompt };
      if (k > 0 && imageProfile.slots.some((q) => q.role === 'seed')) base.seed = Math.floor(Math.random() * 2 ** 31);
      const r = await api.generate(imageProfile.id, base);
      if (r.ok) pending.current.set(r.job.id, { kind, id, batch }); else { notify(r.error); return; }
    }
    notify(`Generating ${count > 1 ? count + ' pictures' : 'a picture'}… the first one becomes the reference when done`);
  };
  /** The video model matters only from shot planning on (allowed lengths, prompt format), so it lives in those two tabs. */
  const modelPick = <div className="row" style={{ margin: '4px 0' }}><span className="note">Video model</span>
    <select style={{ flex: 1 }} value={target?.id ?? ''} onChange={async (e) => { await api.directorSetTarget(e.target.value); void load(); }}>{targets.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select></div>;
  const screenplay = st.parsed?.mode === 'screenplay';
  const nShots = Object.values(st.shots).reduce((n, x) => n + x.shots.length, 0);
  const have: Record<string, string | undefined> = {
    script: st.parsed ? (st.parsed.mode === 'screenplay' ? `${st.parsed.scenes.length} scenes` : 'story text') : undefined,
    bible: st.bible ? `${st.bible.characters.length} characters${st.bible.places.length ? `, ${st.bible.places.length} places` : ''}${st.bible.props?.length ? `, ${st.bible.props.length} props` : ''}` : undefined,
    scenes: screenplay ? 'from the script' : st.scenes?.length ? `${st.scenes.length} scenes` : undefined,
    shots: nShots ? `${nShots} shots` : undefined,
    prompts: Object.keys(st.prompts).length ? `${Object.keys(st.prompts).length} prompts` : undefined,
    story: story.all.length ? `${story.all.length} scenes in ${story.stories.length} stor${story.stories.length === 1 ? 'y' : 'ies'}` : undefined,
  };
  type Need = { text: string; fix?: { label: string; run: () => void } };
  const needScript: Need = { text: 'Needs a script or story idea (the first section). You can also work from pictures or prompts you already have.', fix: { label: 'Open script', run: () => setTab('script') } };
  const needs: Record<string, Need[]> = {
    bible: st.parsed ? [] : [needScript],
    scenes: st.parsed ? [] : [needScript],
    shots: st.parsed ? (st.bible ? [] : [{ text: 'No story bible yet: shots are planned without character and place looks. Fine for a quick try.', fix: { label: 'Write bible first', run: () => void run('bible') } }]) : [needScript],
    prompts: nShots ? [] : [st.parsed ? { text: 'No shots planned yet.', fix: { label: 'Plan shots now', run: () => void run('shots') } } : needScript],
  };
  undoRef.current = () => void undo(); redoRef.current = () => void redo();
  const sec = { have, needs, undo: { n: undoN, run: () => void undo(), rn: redoN, redo: () => void redo() } };
  const sceneList: { id: string; title: string; text?: string }[] = screenplay ? (st.parsed?.scenes ?? []).map((s) => ({ id: s.id, title: s.heading || s.id, text: s.text })) : (st.scenes ?? []).map((s) => ({ id: s.id, title: s.title, text: s.summary }));
  const total = (sc: string) => st.shots[sc]?.shots.length ?? 0;

  const clearAll = async () => {
    if (!(await confirmUser('Clear the whole Director project?', 'The script, bible, scenes, shots, prompts and the storyboard pictures list are removed from the Director. Stories already sent to the Story tab, and the pictures themselves, stay. Tip: “New project” keeps a copy in Saved first.', 'Clear everything', true))) return;
    setSt(await api.directorClearAll()); setText(''); notify('Director cleared');
  };
  const PART_NAME = { bible: 'the story bible', scenes: 'all scenes (and the shots and prompts made from them)', shots: 'all planned shots and their prompts', prompts: 'all written prompts' } as const;
  const clearPart = async (part: keyof typeof PART_NAME) => {
    if (!(await confirmUser(`Clear ${PART_NAME[part]}?`, 'This only affects the Director. Edits you made here are lost; you can write them again with the LLM.', 'Clear', true))) return;
    if (part === 'bible') await upd({ bible: undefined, accepted: { ...st.accepted, bible: false } });
    else if (part === 'scenes') await upd({ scenes: undefined, shots: {}, prompts: {} });
    else if (part === 'shots') await upd({ shots: {}, prompts: {} });
    else await upd({ prompts: {} });
  };
  const openRun = async (id: string) => { setSt(await api.directorOpenRun(id)); setText(''); await load(); setTab('script'); undoStack.current = []; redoStack.current = []; setUndoN(0); setRedoN(0); setRuns(await api.directorRuns()); };
  const newRun = async () => { const n = await api.directorNewRun(); setSt(n); setText(''); await load(); setTab('script'); undoStack.current = []; redoStack.current = []; setUndoN(0); setRedoN(0); setRuns(await api.directorRuns()); };
  const backToRuns = async () => { await api.directorBack(); setRuns(await api.directorRuns()); };
  const TABS: { id: DTab; label: string; done: string | undefined }[] = [
    { id: 'script', label: 'Script', done: have.script }, { id: 'pictures', label: 'Storyboard', done: undefined }, { id: 'bible', label: 'Bible', done: have.bible },
    { id: 'scenes', label: 'Scenes', done: have.scenes }, { id: 'shots', label: 'Shots', done: have.shots }, { id: 'prompts', label: 'Prompts', done: have.prompts },
  ];

  if (runs && !runs.activeId) {
    const nameBox = (c: DirectorRunCard) => renaming === c.id
      ? <input autoFocus defaultValue={c.name} onClick={(e) => e.stopPropagation()} onBlur={async (e) => { setRuns({ ...runs, runs: await api.directorRunEdit(c.id, { name: e.target.value || c.name }) }); setRenaming(null); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); else if (e.key === 'Escape') setRenaming(null); }} />
      : <b style={{ fontSize: 14 }} title="Double-click to rename" onDoubleClick={(e) => { e.stopPropagation(); setRenaming(c.id); }}>{c.name}</b>;
    return (
      <>
        <h2>Director runs</h2>
        <div className="row" style={{ margin: '8px 0', flexWrap: 'wrap' }}>
          <button className="primary-sm" onClick={() => void newRun()}>+ New run</button>
          <span className="sp" /><ViewBar value={rview} onChange={setRview} />
        </div>
        <div className="note">Each run is its own project: script, bible, scenes, shots, prompts and pictures. Open one to work on it; ← Runs brings you back here. Double-click a name to rename it.</div>
        <div className={viewClass(rview)} style={{ marginTop: 8 }}>
          {runs.runs.map((c) => (
            <div className="card vcard storyCard" key={c.id} style={{ position: 'relative' }} onClick={() => void openRun(c.id)}>
              <div className="row" style={{ marginRight: 28 }}>{nameBox(c)}<span className="sp" /><button className="ghost" title="Rename" onClick={(e) => { e.stopPropagation(); setRenaming(c.id); }}>✎</button></div>
              <button className="ghost cardX" title="Delete this run" onClick={async (e) => { e.stopPropagation(); if (await confirmUser(`Delete the run “${c.name}”?`, 'Its script, bible, scenes, shots, prompts and pictures list are removed. Stories already sent to the Story tab, and the pictures themselves, stay.', 'Delete run', true)) setRuns({ ...runs, runs: await api.directorRunEdit(c.id, { remove: true }) }); }}>✕</button>
              <div className="note vdetail">{c.summary}</div>
              <div className="note vdetail">last changed {new Date(c.ts).toLocaleString()}</div>
            </div>
          ))}
        </div>
        {!runs.runs.length && <div className="empty">No runs yet. Start one with + New run.</div>}
      </>
    );
  }
  if (!runs) return <div className="empty">Loading…</div>;

  return (
    <>
      <div className="row" style={{ margin: '4px 0' }}>
        <button className="ghost" title="Back to all Director runs" onClick={() => void backToRuns()}>← Runs</button>
        <input type="text" style={{ flex: 1 }} key={st.name ?? ''} defaultValue={st.name ?? ''} placeholder="Project name (the LLM suggests one after you parse a script)" onBlur={(e) => e.target.value !== (st.name ?? '') && upd({ name: e.target.value })} />
        <button className="primary-sm" disabled={!nShots} title={nShots ? 'Put the scenes, shots, prompts and the bible into the Story tab. Run it again after changes: takes and picks are kept, and prompts you edited there stay.' : 'Plan shots first'} onClick={async () => { const r = await api.directorAccept(); notify(`Story: ${r.scenesAdded} scenes and ${r.shotsAdded} shots added, ${r.shotsUpdated} updated`); }}>Send to Story</button>
      </div>
      {busy && <div className="card working"><div className="row"><span className="spin" /><b>{prog?.running ? prog.label : working + '…'}</b></div>
        {prog?.running && prog.total > 1 ? <div className="bar"><div style={{ width: `${Math.round((prog.done / Math.max(1, prog.total)) * 100)}%` }} /></div> : <div className="bar indet"><div /></div>}
        <div className="note">The LLM is working. You can keep using the app; this also shows in the bar at the bottom.</div>
        <button onClick={() => api.directorCancel()}>Cancel</button></div>}
      {err && <div className="err">{err}</div>}
      <div className="dirTabs">{TABS.map((t) => <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)} title={t.done ? 'Has content' : 'Empty'}>{t.done ? <span className="tabOk">✓</span> : null}{t.label}{t.done ? <span className="count">{t.done}</span> : null}</button>)}</div>

      {tab === 'script' && <Pane id="script" st={sec} clear={{ label: 'Clear everything', run: () => void clearAll() }}>
        <label>Script (Fountain or plain), or a loose story idea</label>
        <textarea style={{ minHeight: 220 }} value={text} onChange={(e) => setText(e.target.value)} placeholder={'INT. KITCHEN - NIGHT\n\nELSA sets a bag on the table.\n\nJONAH\nYou came back.'} />
        <label>Look and style (optional)</label>
        <input type="text" value={st.style} onChange={(e) => setSt({ ...st, style: e.target.value })} placeholder="e.g. 35mm film, warm tungsten, muted colours" />
        <div className="row" style={{ marginTop: 8 }}>
          <button className="primary-sm" disabled={!text.trim() || busy} title="The LLM rewrites your text as a clean script (scenes, places, action, dialogue). You check and edit it before anything is built from it." onClick={async () => {
            setErr(''); setWorking('Interpreting the script'); activity('director-interpret', 'Interpreting the script…');
            try { const r = await api.directorInterpret(text); if (!r.ok) setErr(r.error); else setSt(r.state); } finally { setWorking(''); activity('director-interpret', null); }
          }}>Interpret script</button>
          <button disabled={!text.trim() || busy} title="Use the text exactly as written (needs scene headings and CHARACTER cues to be read as a script; otherwise the LLM splits it into scenes)" onClick={async () => { const n = await api.directorSetScript(text, st.style); setSt(n); if (!n.name?.trim()) void api.llmName('film project or story idea', text).then(async (nm) => { if (nm) setSt(await api.directorUpdate({ name: nm })); }); }}>Parse as is</button>
          <button onClick={async () => { const t = await api.directorImportFile(); if (t) setText(t); }}>Import file…</button>
        </div>
        {st.interpreted !== undefined && <div className="card" style={{ marginTop: 8 }}>
          <b>Interpreted script</b>
          <div className="note">The LLM rewrote your text as a script. Check that nothing of yours is lost or changed, edit anything, then use it. Scenes, places, characters and dialogue are taken from it exactly.</div>
          {missing.length > 0 && <div className="warn">Lines you wrote that are lost or changed in this script (fix them here):{missing.map((m, i) => <div key={i}>{m.speaker}: “{m.line}”{m.saidBy ? ` (the script gives it to ${m.saidBy})` : ' (missing)'}</div>)}</div>}
          <textarea style={{ minHeight: 280 }} value={interp} onChange={(e) => setInterp(e.target.value)} onBlur={async () => { if (interp !== (st.interpreted ?? '')) { setSt(await api.directorSetInterpreted(interp)); } setMissing(await api.directorMissing(st.scriptText, interp)); }} />
          <div className="row" style={{ marginTop: 6 }}>
            <button className="primary-sm" disabled={!interp.trim() || busy} onClick={async () => { if (interp !== (st.interpreted ?? '')) await api.directorSetInterpreted(interp); const n = await api.directorUseInterpreted(); setSt(n); notify('Using this script. Next: the Bible.'); }}>Use this script</button>
            {st.parsed && st.parsed.text.trim() === interp.trim() ? <span className="note">✓ in use</span> : <span className="note">not in use yet: the bible, scenes and shots are built from the script in use.</span>}
          </div>
        </div>}
        {st.parsed && <div className="note" style={{ marginTop: 8 }}>{st.parsed.mode === 'screenplay' ? `Screenplay: ${st.parsed.scenes.length} scenes` : 'Loose story: scenes will be planned by the LLM'} · characters: {st.parsed.characters.join(', ') || 'none found'}</div>}
      </Pane>}

      {tab === 'pictures' && <Pane id="pictures" st={sec}>
        <Storyboard selectedAssets={selectedAssets} target={target} notify={notify} />
      </Pane>}

      {tab === 'bible' && <Pane id="bible" st={sec} clear={{ label: 'Clear bible', run: () => void clearPart('bible') }}>
        <div className="row"><button className="primary-sm" disabled={busy} onClick={() => run('bible')}>{working === WORK.bible ? 'Writing…' : st.bible ? 'Rewrite bible' : 'Write story bible'}</button>
          {st.bible && <label className="row" style={{ margin: 0, color: 'var(--text)' }}><input type="checkbox" checked={!!st.accepted.bible} onChange={(e) => upd({ accepted: { ...st.accepted, bible: e.target.checked } })} />Looks right</label>}</div>
        {st.log.length > 0 && st.log.map((w, i) => <div key={i} className="warn">{w}</div>)}
        {(st.bible || true) && <BibleEditor bible={st.bible ?? { style: st.style, characters: [], places: [] }} onChange={(b) => upd({ bible: b })} selectedAssets={selectedAssets}
          gen={imageProfile ? { title: imageProfile.title, step: sizeInfo(imageProfile).ok ? sizeInfo(imageProfile).step : null, sizes: { characters: sizeChars, places: sizePlaces, props: sizeProps }, setSize: (k: Kind, c: SizeChoice) => (k === 'characters' ? setSizeChars : k === 'places' ? setSizePlaces : setSizeProps)(c), batches: batchN, setBatch: (k: Kind, n: number) => setBatchN((b) => ({ ...b, [k]: n })), make: makePicture } : null} />}
      </Pane>}

      {tab === 'scenes' && (screenplay
        ? <Pane id="scenes" st={sec}>
          <div className="note">This script has its own scenes (one for each scene heading), so nothing is split by the LLM: the scenes below are exactly what you confirmed in the Script tab. To change them, edit the script there.</div>
          <Cards>{(st.parsed?.scenes ?? []).map((sc) => (
            <div className="card vcard" key={sc.id}>
              <b>{sc.heading || sc.id}</b>
              <div className="note">{sc.place ? `place: ${sc.place}` : ''}{sc.characters.length ? ` · ${sc.characters.join(', ')}` : ''}</div>
              <div className="note vdetail" style={{ whiteSpace: 'pre-wrap' }}>{sc.text}</div>
            </div>
          ))}</Cards>
        </Pane>
        : <Pane id="scenes" st={sec} clear={{ label: 'Clear scenes', run: () => void clearPart('scenes') }}>
        <button className="primary-sm" disabled={busy} onClick={() => run('scenes')}>{st.scenes ? 'Re-split into scenes' : 'Split into scenes'}</button>
        <Cards>{(st.scenes ?? []).map((s, i) => (
          <div className="card vcard" key={s.id}>
            <input type="text" defaultValue={s.title} onBlur={(e) => upd({ scenes: st.scenes!.map((x, k) => (k === i ? { ...x, title: e.target.value } : x)) })} />
            <textarea style={{ minHeight: 60 }} defaultValue={s.summary} onBlur={(e) => upd({ scenes: st.scenes!.map((x, k) => (k === i ? { ...x, summary: e.target.value } : x)) })} />
            <button className="ghost" onClick={() => upd({ scenes: st.scenes!.filter((_, k) => k !== i) })}>Remove</button>
          </div>
        ))}</Cards>
        <button onClick={() => upd({ scenes: [...(st.scenes ?? []), { id: `s${(st.scenes?.length ?? 0) + 1}x${Date.now() % 1000}`, title: 'New scene', summary: '', characterIds: [] }] })}>+ Scene</button>
      </Pane>)}

      {tab === 'shots' && <Pane id="shots" st={sec} clear={{ label: 'Clear shots', run: () => void clearPart('shots') }}>
        {modelPick}
        <button className="primary-sm" disabled={busy} onClick={() => run('shots')}>Plan shots for all scenes</button>
        <div>{sceneList.map((sc) => (
          <div className="card" key={sc.id}>
            <div className="row"><b style={{ flex: 1 }}>{sc.title}</b><span className="note">{total(sc.id)} shots</span><button disabled={busy} onClick={() => run('shots', { only: sc.id })}>{total(sc.id) ? 'Redo' : 'Plan'}</button>{total(sc.id) > 0 && <button className="ghost" title="Remove this scene's shots and prompts" onClick={async () => { if (await confirmUser(`Clear the shots of “${sc.title}”?`, 'Its planned shots and written prompts are removed from the Director.', 'Clear', true)) { const { [sc.id]: _x, ...rest } = st.shots; await upd({ shots: rest, prompts: Object.fromEntries(Object.entries(st.prompts).filter(([k]) => !k.startsWith(sc.id + ':'))) }); } }}>Clear</button>}</div>
            {st.shots[sc.id]?.warnings.map((w, i) => <div key={i} className="warn">{w}</div>)}
            <Cards>{(st.shots[sc.id]?.shots ?? []).map((sh, i) => {
              const patch = (p: Partial<typeof sh>) => upd({ shots: { ...st.shots, [sc.id]: { ...st.shots[sc.id]!, shots: st.shots[sc.id]!.shots.map((x, k) => (k === i ? { ...x, ...p } : x)) } } });
              return (
                <div className="shotRow vcard" key={i}>
                  <div className="row"><b>{i + 1}</b>
                    <select value={sh.framing} onChange={(e) => patch({ framing: e.target.value as never })}>{FRAMINGS.map((f) => <option key={f}>{f}</option>)}</select>
                    <select value={sh.move} onChange={(e) => patch({ move: e.target.value as never })}>{MOVES.map((f) => <option key={f}>{f}</option>)}</select>
                    <select style={{ width: 70 }} value={sh.seconds} onChange={(e) => patch({ seconds: Number(e.target.value) })}>{(target?.seconds ?? [3, 5, 8]).map((n) => <option key={n} value={n}>{n}s</option>)}</select>
                    <select title="What kind of prompt to write for this shot" value={sh.promptMode ?? 'auto'} onChange={(e) => patch({ promptMode: e.target.value as never })}><option value="auto">Prompt: auto</option><option value="text">Text only</option><option value="refs">With pictures</option></select>
                    <button className="ghost" title="Delete shot" onClick={() => upd({ shots: { ...st.shots, [sc.id]: { ...st.shots[sc.id]!, shots: st.shots[sc.id]!.shots.filter((_, k) => k !== i) } } })}>✕</button></div>
                  <textarea style={{ minHeight: 50 }} defaultValue={sh.action} onBlur={(e) => e.target.value !== sh.action && patch({ action: e.target.value })} />
                  {sh.dialogue.map((d, k) => (
                    <div key={k} className="row" style={{ margin: '3px 0' }}>
                      <input type="text" style={{ width: 90 }} defaultValue={d.speaker} title="Who speaks" onBlur={(e) => e.target.value !== d.speaker && patch({ dialogue: sh.dialogue.map((x, q) => (q === k ? { ...x, speaker: e.target.value } : x)) })} />
                      <input type="text" style={{ flex: 1 }} defaultValue={d.line} title="The spoken line, word for word from the script" onBlur={(e) => e.target.value !== d.line && patch({ dialogue: sh.dialogue.map((x, q) => (q === k ? { ...x, line: e.target.value } : x)) })} />
                      <button className="ghost" title="Remove this line from the shot" onClick={() => patch({ dialogue: sh.dialogue.filter((_, q) => q !== k) })}>✕</button>
                    </div>
                  ))}
                  <button className="ghost" title="Add a spoken line to this shot" onClick={() => patch({ dialogue: [...sh.dialogue, { speaker: st.bible?.characters[0]?.name ?? '', line: '' }] })}>+ line</button>
                </div>
              );
            })}</Cards>
          </div>
        ))}</div>
      </Pane>}

      {tab === 'prompts' && <Pane id="prompts" st={sec} clear={{ label: 'Clear prompts', run: () => void clearPart('prompts') }}>
        {modelPick}
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="primary-sm" disabled={busy} onClick={() => run('prompts')}>{working === WORK.prompts ? 'Writing…' : 'Write all prompts'}</button>
          {picked.size > 0 && <><button disabled={busy} title="Write these prompts again (replaces them, including ones you edited)" onClick={async () => { const keys = [...picked]; await run('prompts', { only: keys, force: true }); setPicked(new Set()); }}>Rewrite {picked.size} selected</button><button className="ghost" onClick={() => setPicked(new Set())}>Clear</button></>}
          <button className="ghost" onClick={() => { const all = sceneList.flatMap((sc) => (st.shots[sc.id]?.shots ?? []).map((_, i) => `${sc.id}:${i}`)); setPicked((cur) => (cur.size === all.length ? new Set() : new Set(all))); }}>{picked.size ? 'Select none / all' : 'Select all'}</button>
        </div>
        <div className="note">Prompts you edit are kept when you write again. Characters with a reference picture become &lt;Picture n&gt;.</div>
        <div>{sceneList.map((sc) => (st.shots[sc.id]?.shots.length ?? 0) > 0 && (
          <div className="card" key={sc.id}>
            <b>{sc.title}</b>
            <Cards>{st.shots[sc.id]!.shots.map((sh, i) => {
              const k = `${sc.id}:${i}`, p = st.prompts[k];
              return (
                <div className="shotRow vcard" key={k}>
                  <div className="row"><input type="checkbox" checked={picked.has(k)} onChange={() => setPicked((s) => { const n = new Set(s); if (!n.delete(k)) n.add(k); return n; })} /><b>Shot {i + 1}</b><span className="note">{sh.framing} · {sh.move} · {sh.seconds}s {p?.edited ? '· edited' : ''}</span><span className="sp" />
                    <select title="What kind of prompt to write for this shot" style={{ width: 'auto' }} value={sh.promptMode ?? 'auto'} onChange={(e) => upd({ shots: { ...st.shots, [sc.id]: { ...st.shots[sc.id]!, shots: st.shots[sc.id]!.shots.map((x, q) => (q === i ? { ...x, promptMode: e.target.value as never } : x)) } } })}><option value="auto">auto</option><option value="text">text only</option><option value="refs">with pictures</option></select>
                    {p?.refs.map((a, n) => <span key={a} className="pill"><img className="mini" src={thumbUrl(a)} />{n + 1}</span>)}
                    {p?.audioRefs?.map((a, n) => <span key={a} className="pill" title="Voice sample sent along as <Audio n>"><img className="mini" src={thumbUrl(a)} />🔊 {n + 1}</span>)}
                    <button disabled={busy} title="Write this prompt now (replaces it)" onClick={() => run('prompts', { only: k, force: true })}>Write ↻</button>{p && <button className="ghost" title="Clear this prompt" onClick={() => { const { [k]: _x, ...rest } = st.prompts; void upd({ prompts: rest }); }}>✕</button>}</div>
                  <textarea style={{ minHeight: 90 }} key={p?.prompt} defaultValue={p?.prompt ?? ''} placeholder="(not written yet)" onBlur={(e) => p && e.target.value !== p.prompt && upd({ prompts: { ...st.prompts, [k]: { ...p, prompt: e.target.value } } })} />
                  {sh.dialogue.length > 0 && <div className="note">Says: {sh.dialogue.map((d) => `${d.speaker}: “${d.line}”`).join('  ')}</div>}
                  {p?.warnings.map((w, j) => <div key={j} className="warn">{w}</div>)}
                </div>
              );
            })}</Cards>
          </div>
        ))}</div>
      </Pane>}


    </>
  );
}

type Gen = { title: string; step: number | null; sizes: Record<Kind, SizeChoice>; setSize: (k: Kind, c: SizeChoice) => void; batches: Record<Kind, number>; setBatch: (k: Kind, n: number) => void; make: (kind: 'characters' | 'places' | 'props', id: string, prompt: string, size: SizeChoice, batch: number) => Promise<void> };
type El = { id: string; name: string; look: string; refAsset?: string; voiceAsset?: string; gen?: ElementGen };
const KINDS = [
  { k: 'characters' as const, title: 'Characters', one: 'character', prompt: (style: string, look: string) => `${style}. Character reference picture, full body, facing the camera, plain neutral background, no text. ${look}` },
  { k: 'places' as const, title: 'Places', one: 'place', prompt: (style: string, look: string) => `${style}. Reference picture of a location, wide establishing view, no people, no text. ${look}` },
  { k: 'props' as const, title: 'Props and other things', one: 'prop', prompt: (style: string, look: string) => `${style}. Reference picture of a single object, centred, plain neutral background, no text. ${look}` },
];

function BibleEditor({ bible, onChange, selectedAssets, gen }: { bible: Bible; onChange: (b: Bible) => void; selectedAssets: string[]; gen: Gen | null }) {
  const list = (k: 'characters' | 'places' | 'props'): El[] => (bible[k] ?? []) as El[];
  const setList = (k: 'characters' | 'places' | 'props', l: El[]) => onChange({ ...bible, [k]: l } as Bible);
  return (
    <>
      <label>Style</label>
      <textarea style={{ minHeight: 50 }} defaultValue={bible.style} onBlur={(e) => e.target.value !== bible.style && onChange({ ...bible, style: e.target.value })} />
      {KINDS.map((K) => (
        <div key={K.k}>
          <div className="row" style={{ marginTop: 12 }}><h2 style={{ margin: 0, flex: 1 }}>{K.title}</h2>
            <button title={`Add a ${K.one} by hand`} onClick={() => setList(K.k, [...list(K.k), { id: `${K.one[0]}${Date.now().toString(36)}`, name: `New ${K.one}`, look: '' }])}>+ {K.one[0]!.toUpperCase() + K.one.slice(1)}</button></div>
          {gen && <div className="card" style={{ marginTop: 6 }}>
            <b>Reference pictures for all {K.k}</b>
            {gen.step !== null && <SizeChooser value={gen.sizes[K.k]} onChange={(c) => gen.setSize(K.k, c)} step={gen.step} label={`Picture size (every ${K.one} without its own setting)`} />}
            <div className="row" style={{ margin: '4px 0', flexWrap: 'wrap' }} title="How many pictures are made per click, each with a new seed. The first becomes the reference, the others stay on the canvas."><span className="note">Batch size (pictures per {K.one})</span><input type="number" min={1} max={12} style={{ width: 64 }} value={gen.batches[K.k]} onChange={(e) => gen.setBatch(K.k, Math.max(1, Math.min(12, Number(e.target.value) || 1)))} /><span className="note">with {gen.title}</span>
              {(() => { const missing = list(K.k).filter((x) => !x.refAsset); return <button disabled={!missing.length} title={`Make a picture for every ${K.one} that has none`} onClick={async () => { for (const c of missing) await gen.make(K.k, c.id, K.prompt(bible.style, c.look), (c.gen?.size as SizeChoice | undefined) ?? gen.sizes[K.k], c.gen?.batch ?? gen.batches[K.k]); }}>Generate for all without a picture ({missing.length})</button>; })()}</div>
          </div>}
          {!list(K.k).length && <div className="note">{K.k === 'props' ? 'Add anything the film needs a reference picture for: an object, a vehicle, a costume, a creature.' : `No ${K.k} yet.`}</div>}
          <Cards>
            {list(K.k).map((c, i) => {
              const set = (p: Partial<El>) => setList(K.k, list(K.k).map((x, q) => (q === i ? { ...x, ...p } : x)));
              return <ElementCard key={c.id} el={c} kind={K.one} cat={K.k} gen={gen} selectedAssets={selectedAssets}
                prompt={K.prompt(bible.style, c.look)} onSet={set} onRemove={() => setList(K.k, list(K.k).filter((_, q) => q !== i))}
                make={(size, n) => gen!.make(K.k, c.id, K.prompt(bible.style, c.look), size, n)} />;
            })}
          </Cards>
        </div>
      ))}
    </>
  );
}

/** One bible element (character, place, prop): name, look, reference picture, and its own output settings. The remove button sits alone in the top right corner. */
function ElementCard({ el, kind, cat, gen, selectedAssets, onSet, onRemove, make }: { el: El; kind: string; cat: Kind; gen: Gen | null; selectedAssets: string[]; prompt: string; onSet: (p: Partial<El>) => void; onRemove: () => void; make: (size: SizeChoice, n: number) => Promise<void> }) {
  const { assets } = useContext(C);
  const voicePick = [...selectedAssets].reverse().find((a) => assets.get(a)?.kind === 'audio');
  const [open, setOpen] = useState(false);
  const [reading, setReading] = useState(false);
  const [proposal, setProposal] = useState<string | null>(null);
  const own = el.gen ?? {};
  const size = (own.size as SizeChoice | undefined) ?? gen?.sizes[cat];
  const n = own.batch ?? gen?.batches[cat] ?? 1;
  return (
    <div className="card vcard" style={{ position: 'relative' }}>
      <button className="ghost cardX" title={`Remove this ${kind} (Undo brings it back)`} onClick={onRemove}>✕</button>
      <input type="text" style={{ width: 'calc(100% - 34px)' }} defaultValue={el.name} key={el.id + el.name} title="Name (editable)" onBlur={(e) => e.target.value !== el.name && onSet({ name: e.target.value })} />
      <div className="row" style={{ margin: '6px 0', flexWrap: 'wrap' }}>
        {el.refAsset && <span className="refPic"><img className="mini big" src={thumbUrl(el.refAsset)} /><PrepInput id={el.refAsset} selected={selectedAssets} onReplace={(n) => onSet({ refAsset: n })} /></span>}
        {gen && size && <button title={`Make ${n > 1 ? n + ' pictures' : 'a picture'} of this ${kind} with ${gen.title}`} onClick={() => void make(size, n)}>{el.refAsset ? 'Regenerate' : 'Generate picture'}{n > 1 ? ` ×${n}` : ''}</button>}
        <button disabled={!selectedAssets.length} title={`Use the image selected on the canvas as this ${kind}'s reference picture`} onClick={() => onSet({ refAsset: selectedAssets[selectedAssets.length - 1] })}>{el.refAsset ? 'Change picture' : '+ from selection'}</button>
        {el.refAsset && <button disabled={reading} title="The vision LLM describes this picture and proposes it as the written look, so text and picture agree. You decide whether to use it." onClick={async () => { setReading(true); const r = await api.llmReadLook(el.refAsset!, kind as 'character' | 'place' | 'prop'); setReading(false); if (r.ok) setProposal(r.look); else void tellUser('Could not read the picture', `${r.error}

Check that the LLM in Settings › LLM is running and can see pictures (a vision model), then try again.`); }}>{reading ? 'Reading…' : 'Read the picture'}</button>}
        {el.refAsset && <button className="ghost" title="Take the reference picture off (the picture itself stays in the Library)" onClick={() => onSet({ refAsset: undefined })}>Remove picture</button>}
        {gen && <button className="ghost" title="Output settings of this card" onClick={() => setOpen(!open)}>⚙ {own.size || own.batch ? 'own settings' : 'settings'}</button>}
      </div>
      {kind === 'character' && <div className="row" style={{ margin: '4px 0', flexWrap: 'wrap' }}>
        <span className="note">Voice</span>
        {el.voiceAsset ? <span className="audioChip" title="This sample goes along wherever this character's picture is sent, to keep the voice the same">🔊 {el.voiceAsset.slice(0, 6)}</span> : <span className="note">no sample</span>}
        <button disabled={!voicePick} title="Use the audio clip selected on the canvas as this character's voice sample" onClick={() => onSet({ voiceAsset: voicePick })}>{el.voiceAsset ? 'Change voice sample' : '+ voice from selected audio'}</button>
        {el.voiceAsset && <button className="ghost" onClick={() => onSet({ voiceAsset: undefined })}>Remove voice</button>}
      </div>}
      {open && gen && gen.step !== null && <div className="sizeBox">
        <label className="row" style={{ color: 'var(--text)', margin: 0 }}><input type="checkbox" checked={!!own.size} onChange={(e) => onSet({ gen: { ...own, size: e.target.checked ? gen.sizes[cat] : undefined } })} />Own size for this {kind}</label>
        {own.size && <SizeChooser value={own.size as SizeChoice} onChange={(c) => onSet({ gen: { ...own, size: c } })} step={gen.step} label={`Size of this ${kind}'s pictures`} />}
        <div className="row" style={{ margin: '4px 0' }}><label className="row" style={{ color: 'var(--text)', margin: 0 }}><input type="checkbox" checked={own.batch !== undefined} onChange={(e) => onSet({ gen: { ...own, batch: e.target.checked ? gen.batches[cat] : undefined } })} />Own batch size</label>
          {own.batch !== undefined && <input type="number" min={1} max={12} style={{ width: 64 }} value={own.batch} onChange={(e) => onSet({ gen: { ...own, batch: Math.max(1, Math.min(12, Number(e.target.value) || 1)) } })} />}</div>
      </div>}
      {proposal !== null && <div className="warn"><b>What the picture shows:</b><div style={{ margin: '4px 0' }}>{proposal}</div><div className="row"><button className="primary-sm" onClick={() => { onSet({ look: proposal }); setProposal(null); }}>Use as the look</button><button className="ghost" onClick={() => setProposal(null)}>Keep mine</button></div></div>}
      <textarea style={{ minHeight: 70 }} defaultValue={el.look} key={el.id + 'l' + el.look} placeholder={`How this ${kind} looks (visual details only)`} onBlur={(e) => e.target.value !== el.look && onSet({ look: e.target.value })} />
      <div className="note">{el.look.trim().split(/\s+/).filter(Boolean).length} words</div>
    </div>
  );
}

/** One tab of the Director: what is missing (never blocking), view options for its list, and a clear button. */
function Pane({ id, st, clear, children }: { id: string; st: { needs: Record<string, { text: string; fix?: { label: string; run: () => void } }[]>; undo?: { n: number; run: () => void; rn: number; redo: () => void } }; clear?: { label: string; run: () => void }; children: React.ReactNode }) {
  const [view, setView] = useView('dir-' + id);
  return (
    <ViewCtx.Provider value={view}>
      <div className="row" style={{ margin: '4px 0' }}><span className="sp" />{st.undo && <button className="ghost" disabled={!st.undo.n} title="Undo the last change in the Director (removed characters, places, props, edits, clears)" onClick={st.undo.run}>↶ Undo{st.undo.n ? ` (${st.undo.n})` : ''}</button>}{st.undo && <button className="ghost" disabled={!st.undo.rn} title="Redo (Ctrl+Shift+Z)" onClick={st.undo.redo}>↷ Redo</button>}<ViewBar value={view} onChange={setView} />{clear && <button className="ghost" onClick={clear.run}>{clear.label}</button>}</div>
      {(st.needs[id] ?? []).map((n, i) => <div key={i} className="warn">{n.text}{n.fix && <button style={{ marginLeft: 8 }} onClick={n.fix.run}>{n.fix.label}</button>}</div>)}
      {children}
    </ViewCtx.Provider>
  );
}
