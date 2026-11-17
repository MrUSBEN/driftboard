import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { FilmBlocksCard } from './FilmBlocksCard.tsx';
import { applyPicks } from '@driftboard/editor';
import { PrepInput } from "./PrepInput.tsx";
import { C, api, matches, thumbUrl, draftForShot, valuesOfDraft, elementsOfShot, refsOfShot, mediaOfShot, autoAssign, imageSlots, slotWithRole, type Asset, type Draft, type Manifest } from './shared.tsx';
import type { Shot, SceneTree, LlmProgress } from '../main/api.ts';
import { askUser, confirmUser } from './Ask.tsx';
import { ViewBar, UndoRedo, useView, viewClass } from './View.tsx';
import { checkPrompt, providedOf, detectPromptKind, KIND_LABEL } from './promptKind.ts';
import { SizeChooser, resolveSize, useSizeChoice, sizeInfo, withSize } from './size.tsx';
import { useStore, joinForTimeline } from './editorBridge.tsx';

const STATUS_LABEL: Record<string, string> = { empty: 'no takes', draft: 'draft', approved: 'approved', rejected: 'rejected' };
const statusOf = (s: Shot) => (!s.takes.length ? 'empty' : s.pick ? 'approved' : s.takes.every((t) => t.status === 'rejected') ? 'rejected' : 'draft');

export function StoryTab({ selectedAssets, focus, notify, openDraft }: { selectedAssets: string[]; focus: (assetId: string) => void; notify: (m: string) => void; openDraft: (d: Draft) => void }) {
  const { story, assets, jobs, profiles, film } = useContext(C);
  const kindMap = new Map([...assets.values()].map((a) => [a.id, a.kind] as [string, string]));
  const [size, setSize] = useSizeChoice('story');
  const [batch, setBatch] = useState(1);
  const [view, setView] = useView('shots');
  const [sview, setSview] = useView('stories', { mode: 'grid' });
  const [renaming, setRenaming] = useState<string | null>(null);
  const editor = useStore();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const op = (name: Parameters<typeof api.storyOp>[0], ...a: unknown[]) => api.storyOp(name, ...a);

  const promptOf = useMemo(() => { const m = new Map<string, string>(); for (const j of jobs) for (const o of j.outputs) { const p = JSON.parse(j.params).prompt; if (typeof p === 'string') m.set(o.assetId, p); } return m; }, [jobs]);
  const nameOf = (a: Asset) => story.meta[a.id]?.name ?? a.id.slice(0, 8);
  const takeText = (id: string) => { const a = assets.get(id); return [a ? nameOf(a) : id, story.meta[id]?.tags?.join(' '), story.meta[id]?.note, promptOf.get(id)].join(' '); };

  const filtered: SceneTree[] = useMemo(() => {
    if (!q.trim()) return story.tree;
    return story.tree.map(({ scene, shots }) => {
      const sceneHit = matches(q, scene.name, scene.notes);
      const keep = shots.map((s) => {
        const shotHit = sceneHit || matches(q, s.name, s.notes, s.tags.join(' '));
        const takes = shotHit ? s.takes : s.takes.filter((t) => matches(q, takeText(t.assetId), t.note));
        return shotHit || takes.length ? { ...s, takes } : null;
      }).filter((s): s is Shot => !!s);
      return { scene, shots: keep };
    }).filter((t) => t.shots.length || matches(q, t.scene.name));
  }, [story, q, assets, promptOf]);

  const assigned = useMemo(() => new Set(story.all.flatMap((t) => t.shots.flatMap((s) => s.takes.map((k) => k.assetId)))), [story]);
  const unsorted = [...assets.values()].filter((a) => (a.kind === 'video' || a.kind === 'image') && !assigned.has(a.id) && !story.meta[a.id]?.trashed && (!q.trim() || matches(q, takeText(a.id))));
  const shotCount = story.tree.reduce((n, t) => n + t.shots.length, 0);
  const allShots = story.tree.flatMap((t) => t.shots.map((s) => ({ s, scene: t.scene })));

  const pickAllToTimeline = async () => {
    if (!editor) return;
    // shots that have takes but no pick yet use their first take that is not rejected (and keep it as their pick), in story order
    const shotsNow = story.tree.flatMap((t) => t.shots);
    for (const s of shotsNow) if (!s.pick) { const t = s.takes.find((x) => x.status !== 'rejected'); if (t) { void op('setPick', s.id, t.assetId); s.pick = t.assetId; } }
    const picks = shotsNow.filter((s) => s.pick);
    if (!picks.length) return notify('No takes yet: nothing to put on the timeline.');
    // takes made with held frames go on the timeline as their seam-matched copies without the repeated frames
    const all = [...new Set(picks.flatMap((s) => s.takes.map((t) => t.assetId)))]; const joined = await joinForTimeline(editor, all); const jm = new Map(all.map((id, i) => [id, joined[i]!]));
    const r = applyPicks(editor, picks.map((s) => ({ pick: s.pick ? jm.get(s.pick) ?? s.pick : s.pick, takes: s.takes.map((t) => jm.get(t.assetId) ?? t.assetId) })));
    notify(`Timeline: ${r.appended} added, ${r.swapped} swapped, ${picks.length - r.appended - r.swapped} unchanged`);
  };

  const videoProfiles = profiles.filter((x) => x.kind === 'video' && x.slots.some((s) => s.type === 'text' && s.role === 'prompt'));
  const [profileId, setProfileId] = useState<string>(() => { try { return localStorage.getItem('driftboard.storyProfile') ?? ''; } catch { return ''; } });
  const chosen = videoProfiles.find((x) => x.id === profileId) ?? videoProfiles.find((x) => (x.director?.maxRefs ?? 0) > 0) ?? videoProfiles[0];
  const pickProfile = (id: string) => { setProfileId(id); try { localStorage.setItem('driftboard.storyProfile', id); } catch { /* ignore */ } };
  const [prog, setProg] = useState<LlmProgress | null>(null);
  const [alsoTaken, setAlsoTaken] = useState(false);
  /* start frames: for a model that must begin from a picture, the app composes one per shot from the bible pictures with whichever image model can take pictures in */
  const makers = profiles.filter((x) => x.kind === 'image' && imageSlots(x).length > 0 && x.slots.some((s) => s.type === 'text' && s.role === 'prompt'));
  const capacity = (x: Manifest) => imageSlots(x).reduce((n, s) => n + (s.type === 'image_list' ? s.max : 1), 0);
  /** the image model that makes start frames: the one that takes the most pictures in */
  const maker = [...makers].sort((a, b) => capacity(b) - capacity(a))[0];
  const [sfSize, setSfSize] = useSizeChoice('startframe', 'film');
  const sfPending = useRef(new Map<string, string>());   // job id -> shot waiting for its start frame
  useEffect(() => api.onLlmProgress(setProg), []);
  /** Shots ticked for batch work. With none ticked, the buttons act on the whole story. */
  const [sel, setSel] = useState<Set<string>>(new Set());
  useEffect(() => { const ids = new Set(allShots.map((x) => x.s.id)); setSel((cur) => (cur.size && [...cur].some((i) => !ids.has(i)) ? new Set([...cur].filter((i) => ids.has(i))) : cur)); }, [story.tree]);
  useEffect(() => {   // the floating Collapse all / Expand all
    const f = (e: Event) => { const o = (e as CustomEvent<{ open: boolean }>).detail.open; setOpen(o ? Object.fromEntries(allShots.map((x) => ['s:' + x.s.id, true])) : {}); };
    window.addEventListener('driftboard-fold', f); return () => window.removeEventListener('driftboard-fold', f);
  }, [story.tree]);   // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (!n.delete(id)) n.add(id); return n; });
  const toggleMany = (ids: string[]) => setSel((s) => { const n = new Set(s); const all = ids.every((i) => n.has(i)); for (const i of ids) { if (all) n.delete(i); else n.add(i); } return n; });
  const inScope = (id: string) => !sel.size || sel.has(id);
  const chosenNeedsFrame = !!chosen && chosen.slots.some((s) => s.type === 'image' && s.required) && !!slotWithRole(chosen, 'first_frame');
  /** shots the chosen model cannot start (no first frame), and those among them the bible can make a picture for */
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

  /** Open the Generate tab for a shot: its prompt, length and the reference pictures of its characters (in <Picture n> order). */
  const generateHere = (shot: Shot) => { const d = draftForShot(shot, story, profiles, chosen?.id, kindMap); if (d) openDraft(d); };

  /** One LLM batch for every shot that has a brief but no prompt. The model is freed afterwards if the settings say so. */
  const writeFor = async (ids: string[], force = false): Promise<boolean> => {
    if (!chosen) { notify('No video model profile.'); return false; }
    const todo = allShots.filter(({ s }) => ids.includes(s.id) && s.brief && (force || !s.prompt?.trim())).map(({ s }) => s.id);
    if (!todo.length) return true;
    const r = await api.llmWritePrompts(todo, chosen.id, force);
    if (!r.ok) { notify(r.error); return false; }
    notify(`Prompts: ${r.written} written${r.failed.length ? `, ${r.failed.length} failed (${r.failed[0]})` : ''}${r.cancelled ? ', cancelled' : ''}`);
    return !r.cancelled;
  };
  const writePrompts = () => writeFor(needPrompt.map(({ s }) => s.id));
  /** Write missing prompts for these shots (LLM phase), then queue a generation for each (GPU phase). `again` = also shots that already have takes. */
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
      // a shot that starts from a picture follows that picture's aspect unless the size was set to something other than "film aspect"
      const ch = fa && size.purpose === 'film' ? { ...size, purpose: 'match' as const } : size;
      const values = si.ok ? withSize(valuesOfDraft(pr, d), resolveSize(ch, film, fa, si.step)) : valuesOfDraft(pr, d);
      if (fa && size.purpose === 'film' && Math.abs(fa.width! / fa.height! / (film.aspect.split(':').map(Number)[0]! / film.aspect.split(':').map(Number)[1]!) - 1) > 0.05) warnFrames++;
      plan.push({ s, pr, values, issues: checkPrompt(s.prompt, providedOf(pr.slots, d.inputs), pr.slots) });
    }
    // prompts that do not fit their inputs (e.g. written for a first frame, none attached): ask once for the whole batch
    const mism = plan.filter((x) => x.issues.length);
    let run = plan;
    if (mism.length) {
      const a = await askUser({ title: `${mism.length} of ${plan.length} shots have a prompt that does not match its inputs`, lines: mism.map((x) => `${x.s.name}: ${x.issues[0]}`), message: 'Run them anyway, skip those shots, or cancel and fix them first (✦ opens the Generate tab for a shot).', buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'skip', label: 'Skip those' }, { id: 'run', label: 'Run all anyway', kind: 'danger' }] });
      if (a === 'skip') run = plan.filter((x) => !x.issues.length); else if (a !== 'run') return;
    }
    for (const x of run) for (let k = 0; k < Math.max(1, batch); k++) {
      const values = { ...x.values }; if (batch > 1 && x.pr.slots.some((q) => q.role === 'seed')) values.seed = Math.floor(Math.random() * 2 ** 31);
      const r = await api.generate(x.pr.id, values, undefined, x.s.id, { ignoreWarnings: true });
      if (r.ok) queued++; else bad.push(`${x.s.name}: ${r.error}`);
    }
    notify(`Queued ${queued} generation${queued === 1 ? '' : 's'}${warnFrames ? `, ${warnFrames} follow their first frame's aspect instead of the film's ${film.aspect}` : ''}${skipped.length ? `, ${skipped.length} have no prompt (${skipped[0]})` : ''}${bad.length ? `, ${bad.length} could not be queued (${bad[0]})` : ''}`);
  };
  /** What the prompt reads as (text only / first frame / …), red when it does not fit the inputs the shot would get. */
  const promptBadge = (s: Shot) => {
    if (!s.prompt?.trim()) return null;
    const d = chosen ? draftForShot(s, story, profiles, chosen.id, kindMap) : null; const pr = d ? profiles.find((x) => x.id === d.profileId) : undefined;
    const kind = detectPromptKind(s.prompt).kind; const issues = pr && d ? checkPrompt(s.prompt, providedOf(pr.slots, d.inputs), pr.slots) : [];
    return <span className={'tagChip' + (issues.length ? ' bad' : '')} title={issues.length ? issues.join(' ') : `Written as: ${KIND_LABEL[kind]}`}>{issues.length ? '⚠ ' : ''}{KIND_LABEL[kind]}</span>;
  };
  const runAll = () => runShots(needTake.map(({ s }) => s.id));
  const llmBusy = !!prog?.running;
  const openStory = async (id: string) => { await api.storyActive(id); };
  const newStory = async () => { const st = (await op('addStory', `Story ${story.stories.length + 1}`)) as { id: string } | undefined; if (st) await openStory(st.id); };
  const deleteStory = async (c: { id: string; name: string; scenes: number; shots: number; takes: number }) => {
    if (await confirmUser(`Delete the story “${c.name}”?`, `${c.scenes} scenes, ${c.shots} shots and the links to ${c.takes} takes will be removed from the story. The pictures and videos stay in the Library, and Ctrl+Z brings the story back.`, 'Delete story', true)) {
      await op('removeStory', c.id); if (story.activeId === c.id) await api.storyActive(null); notify(`Deleted “${c.name}” (Ctrl+Z to undo)`);
    }
  };
  const nameBox = (id: string, name: string, big = false) => renaming === id
    ? <input autoFocus defaultValue={name} onClick={(e) => e.stopPropagation()} onBlur={(e) => { void op('renameStory', id, e.target.value || name); setRenaming(null); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); else if (e.key === 'Escape') setRenaming(null); }} />
    : <b style={big ? { fontSize: 14 } : undefined} title="Double-click to rename" onDoubleClick={(e) => { e.stopPropagation(); setRenaming(id); }}>{name}</b>;
  if (!story.activeId) return (
    <>
      <h2>Stories</h2>
      <div className="row" style={{ margin: '8px 0', flexWrap: 'wrap' }}>
        <button className="primary-sm" onClick={() => void newStory()}>+ New story</button>
        <span className="sp" /><UndoRedo /><ViewBar value={sview} onChange={setSview} />
      </div>
      <div className="note">Each story has its own scenes, shots and takes. The Director creates a new story when you send a plan to the Story tab; the LLM suggests a name, and you can rename any story (double-click its name).</div>
      <div className={viewClass(sview)} style={{ marginTop: 8 }}>
        {story.stories.map((c) => (
          <div className="card vcard storyCard" key={c.id} onClick={() => void openStory(c.id)}>
            <div className="row">{nameBox(c.id, c.name, true)}<span className="sp" />
              <button className="ghost" title="Rename" onClick={(e) => { e.stopPropagation(); setRenaming(c.id); }}>✎</button>
              <button className="ghost" title="Delete this story" onClick={(e) => { e.stopPropagation(); void deleteStory(c); }}>✕</button></div>
            <div className="note vdetail">{c.scenes} scenes · {c.shots} shots · {c.takes} takes · {c.picked} picked</div>
            <div className="note vdetail">created {new Date(c.created).toLocaleDateString()}</div>
          </div>
        ))}
      </div>
      {!story.stories.length && <div className="empty">No stories yet. Make one with + New story, or build one in the Director.</div>}
    </>
  );
  const active = story.stories.find((c) => c.id === story.activeId)!;

  return (
    <>
      <div className="row" style={{ margin: '0 0 6px' }}>
        <button className="ghost" title="Back to all stories" onClick={() => void api.storyActive(null)}>← Stories</button>
        {nameBox(active.id, active.name, true)}<button className="ghost" title="Rename" onClick={() => setRenaming(active.id)}>✎</button>
        <span className="sp" /><UndoRedo /><button className="ghost" title="Delete this story" onClick={() => void deleteStory(active)}>Delete story</button>
      </div>
      <FilmBlocksCard storyId={active.id} notify={notify} />
      <input type="text" placeholder="Search scenes, shots, takes, tags, prompts…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="row" style={{ margin: '8px 0', flexWrap: 'wrap' }}>
        <button onClick={() => op('addScene', `Scene ${story.tree.length + 1}`, story.activeId)}>+ Scene</button>
        <button title="Lay the canvas out by scene and shot" onClick={async () => { const r = await api.boardArrange(); notify(`Arranged ${r.scenes} scenes, moved ${r.moved} items`); window.dispatchEvent(new Event('driftboard-fit')); }}>Arrange canvas</button>
        <ViewBar value={view} onChange={setView} />
        <button title="Add every picked take to the timeline (or swap changed picks)" onClick={pickAllToTimeline}>Picks → timeline</button>
      </div>
      {shotCount > 0 && videoProfiles.length > 0 && (
        <div className="card">
          <div className="row"><span className="note">Generate with</span>
            <select value={chosen?.id ?? ''} onChange={(e) => pickProfile(e.target.value)}>{videoProfiles.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}</select></div>
          {chosen && sizeInfo(chosen).ok && <SizeChooser value={size} onChange={setSize} step={sizeInfo(chosen).step} label="Size of every shot you run (a single shot can be changed with ✦)" />}
          {noFrame.length > 0 && <div className="row" style={{ margin: '4px 0', flexWrap: 'wrap' }}><span className="note" title={`${chosen!.title} must start from a picture. Shots without one are not run by it.`}>{noFrame.length} shot{noFrame.length === 1 ? ' has' : 's have'} no first frame</span>{needStart.length > 0 && maker && <button className="ghost" title={`Compose one picture per shot from the bible with ${maker.title}; it becomes the shot's first frame`} onClick={() => void makeStartFrames()}>Make {needStart.length} from the bible</button>}</div>}
          <div className="row" style={{ margin: '6px 0', flexWrap: 'wrap' }}>
            <button disabled={llmBusy || !needPrompt.length} title="One LLM batch: write the prompt of every shot that has none, then free the GPU" onClick={writePrompts}>Write prompts ({needPrompt.length})</button>
            <button className="ghost" disabled={llmBusy || !allShots.some(({ s }) => s.prompt?.trim())} title="Empty the prompt of every shot (or of the ticked ones). Takes, pictures and the story stay." onClick={() => { const list = allShots.filter(({ s }) => inScope(s.id) && s.prompt?.trim()); if (list.length && window.confirm(`Clear ${list.length} prompt${list.length === 1 ? '' : 's'}? Takes and pictures stay.`)) for (const { s } of list) void op('updateShot', s.id, { prompt: '', generatedPrompt: undefined, promptWarnings: [] }); }}>Clear prompts</button>
            <button className="primary-sm" disabled={llmBusy || !needTake.length} title="Write missing prompts first (LLM), then queue the shots for generation (GPU)" onClick={runAll}>{sel.size ? 'Run selected' : 'Run all'} ({needTake.length})</button>
          </div>
          {sel.size > 0 && <div className="row" style={{ margin: '6px 0', flexWrap: 'wrap' }}>
            <span className="note">{sel.size} shot{sel.size === 1 ? '' : 's'} selected</span><span className="sp" />
            <button className="ghost" disabled={llmBusy} title="Empty the prompts of the selected shots (takes and pictures stay)" onClick={() => { if (window.confirm(`Clear the prompts of ${sel.size} selected shot(s)?`)) for (const id of sel) void op('updateShot', id, { prompt: '', generatedPrompt: undefined, promptWarnings: [] }); }}>Clear prompts</button>
            <button disabled={llmBusy} title="Write the prompts of the selected shots again, replacing the current ones" onClick={() => { if (window.confirm(`Rewrite the prompts of ${sel.size} selected shot(s)? Your current prompts are replaced.`)) void writeFor([...sel], true); }}>Rewrite prompts</button>
            <button disabled={llmBusy} title="Queue a new take for every selected shot, even those that already have takes" onClick={() => void runShots([...sel], true)}>New take for each</button>
            <button className="ghost" onClick={() => setSel(new Set())}>Clear</button>
          </div>}
          <div className="row" style={{ margin: '4px 0' }} title="How many takes are queued for each shot when you run (each with its own random seed), like ComfyUI's batch size"><span className="note">Batch size (takes per shot)</span><input type="number" min={1} max={12} style={{ width: 64 }} value={batch} onChange={(e) => setBatch(Math.max(1, Math.min(12, Number(e.target.value) || 1)))} /></div>
          <label className="row" style={{ color: 'var(--text)', margin: 0 }}><input type="checkbox" checked={alsoTaken} onChange={(e) => setAlsoTaken(e.target.checked)} />Also shots that already have takes</label>
          {llmBusy && <><div className="note">{prog!.label}</div><div className="bar"><div style={{ width: `${Math.round((prog!.done / Math.max(1, prog!.total)) * 100)}%` }} /></div><button onClick={() => api.llmCancel()}>Cancel</button></>}
        </div>
      )}
      <div className="note">{story.tree.length} scenes · {shotCount} shots · {story.tree.flatMap((t) => t.shots).filter((s) => s.pick).length} picked</div>
      {filtered.map(({ scene, shots }, si) => {
        const collapsed = open[scene.id] === false;
        return (
          <div className="scene" key={scene.id}>
            <div className="sceneHead">
              <button className="ghost" onClick={() => setOpen((o) => ({ ...o, [scene.id]: o[scene.id] === false }))}>{collapsed ? '▸' : '▾'}</button>
              {editing === scene.id ? <input autoFocus defaultValue={scene.name} onBlur={(e) => { void op('updateScene', scene.id, { name: e.target.value || scene.name }); setEditing(null); }} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
                : <b onDoubleClick={() => setEditing(scene.id)} title="Double-click to rename">{scene.name}</b>}
              <input type="checkbox" title="Select every shot of this scene" checked={shots.length > 0 && shots.every((x) => sel.has(x.id))} onChange={() => toggleMany(shots.map((x) => x.id))} />
              <span className="note">{shots.length}</span><span className="sp" />
              <button className="ghost" title="Run this scene: write missing prompts, then generate its shots without takes" disabled={llmBusy || !shots.length} onClick={() => void runShots(shots.map((x) => x.id))}>▶ Run scene</button>
              <button className="ghost" title="Move up" disabled={si === 0 || !!q} onClick={() => op('moveScene', scene.id, -1)}>↑</button>
              <button className="ghost" title="Move down" disabled={!!q} onClick={() => op('moveScene', scene.id, 1)}>↓</button>
              <button className="ghost" title="Add shot" onClick={() => op('addShot', scene.id)}>＋</button>
              <button className="ghost" title="Delete scene" onClick={() => op('removeScene', scene.id)}>✕</button>
            </div>
            {!collapsed && <div className={viewClass(view)}>{shots.map((s) => {
              const st = statusOf(s); const exp = open['s:' + s.id];
              return (
                <div className={'shot vcard' + (exp ? ' wide' : '')} key={s.id}>
                  {view.mode === 'grid' && (s.pick ?? s.takes[0]?.assetId) && <img className="vthumb" src={thumbUrl((s.pick ?? s.takes[0]!.assetId))} onClick={() => focus((s.pick ?? s.takes[0]!.assetId))} />}
                  <div className="shotHead">
                    <button className="ghost" onClick={() => setOpen((o) => ({ ...o, ['s:' + s.id]: !o['s:' + s.id] }))}>{exp ? '▾' : '▸'}</button>
                    <input type="checkbox" title="Select this shot for batch work" checked={sel.has(s.id)} onChange={() => toggle(s.id)} />
                    <i className={'dotS s-' + st} title={STATUS_LABEL[st]} />
                    {editing === s.id ? <input autoFocus defaultValue={s.name} onBlur={(e) => { void op('updateShot', s.id, { name: e.target.value || s.name }); setEditing(null); }} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
                      : <span className="shotName" onDoubleClick={() => setEditing(s.id)} title="Double-click to rename">{s.name}</span>}
                    {s.pick && <img className="pickThumb" src={thumbUrl(s.pick)} onClick={() => focus(s.pick!)} />}
                    <span className="note">{s.takes.length} take{s.takes.length === 1 ? '' : 's'}</span>{promptBadge(s)}{s.frames?.first && <span className="tagChip" title="This shot starts from a picture">start frame</span>}{(() => { const n = refsOfShot(s, story.bible).length; return n ? <span className="tagChip" title="Reference pictures attached to this shot (bible characters, place, props)">{n} ref pic{n === 1 ? '' : 's'}</span> : null; })()}<span className="sp" />
                    <button className="ghost" title="Add the assets selected on the canvas as takes" disabled={!selectedAssets.length} onClick={async () => { for (const a of selectedAssets) await op('addTake', s.id, a); }}>＋sel</button>
                    <button className="ghost" title="Run this shot now: write its prompt if missing, then queue a new take" disabled={llmBusy} onClick={() => void runShots([s.id], true)}>▶</button>
                    <button className="ghost" title="Open the Generate tab for this shot (to change settings first)" onClick={() => generateHere(s)}>✦</button>
                    <button className="ghost" title="Delete shot" onClick={() => op('removeShot', s.id)}>✕</button>
                  </div>
                  {s.tags.length > 0 && <div className="tags">{s.tags.map((t) => <span key={t} className="tag" onClick={() => setQ(t)}>{t}</span>)}</div>}
                  {exp && <>
                    <div className="takes">
                      {s.takes.map((t) => {
                        const a = assets.get(t.assetId); if (!a) return null;
                        return (
                          <div key={t.assetId} className={'take ' + t.status + (s.pick === t.assetId ? ' picked' : '')}>
                            <img src={thumbUrl(a.id)} loading="lazy" onClick={() => focus(a.id)} title={promptOf.get(a.id) ?? nameOf(a)} />
                            {a.kind === 'video' && <span className="dur">{a.duration_ms ? (a.duration_ms / 1000).toFixed(1) + 's' : ''}</span>}
                            <div className="tb">
                              <button title="Pick for the timeline" className={s.pick === t.assetId ? 'on' : ''} onClick={() => op('setPick', s.id, s.pick === t.assetId ? undefined : t.assetId)}>★</button>
                              <button title="Approve" className={t.status === 'approved' ? 'on' : ''} onClick={() => op('setTakeStatus', s.id, t.assetId, t.status === 'approved' ? 'draft' : 'approved')}>✓</button>
                              <button title="Reject" className={t.status === 'rejected' ? 'bad' : ''} onClick={() => op('setTakeStatus', s.id, t.assetId, t.status === 'rejected' ? 'draft' : 'rejected')}>✗</button>
                              <button title="Remove from shot" onClick={() => op('removeTake', s.id, t.assetId)}>–</button>
                            </div>
                          </div>
                        );
                      })}
                      {!s.takes.length && <span className="note">No takes yet. Select assets on the canvas and press ＋sel, or generate one.</span>}
                    </div>
                    <div className="row" style={{ flexWrap: 'wrap', margin: '4px 0', alignItems: 'center' }}>
                      <span className="note">Inputs</span>
                      {s.frames?.first && <span className="refPic" title="First frame"><img className="mini big" src={thumbUrl(s.frames.first)} onClick={() => focus(s.frames!.first!)} /><i>first</i><PrepInput id={s.frames.first} selected={selectedAssets} openDraft={openDraft} onReplace={(n) => op("updateShot", s.id, { frames: { ...s.frames, first: n } })} /><button className="ghost" title="Remove the first frame" onClick={() => op('updateShot', s.id, { frames: { ...s.frames, first: undefined } })}>✕</button></span>}
                      {s.frames?.last && <span className="refPic" title="Last frame"><img className="mini big" src={thumbUrl(s.frames.last)} onClick={() => focus(s.frames!.last!)} /><i>last</i><PrepInput id={s.frames.last} selected={selectedAssets} openDraft={openDraft} onReplace={(n) => op("updateShot", s.id, { frames: { ...s.frames, last: n } })} /><button className="ghost" title="Remove the last frame" onClick={() => op('updateShot', s.id, { frames: { ...s.frames, last: undefined } })}>✕</button></span>}
                      {refsOfShot(s, story.bible).map((a, n) => { const nm = [...(story.bible?.characters ?? []), ...(story.bible?.places ?? []), ...(story.bible?.props ?? [])].find((x) => x.refAsset === a)?.name; return <span className="refPic" key={a} title={`<Picture ${n + 1}> ${nm ?? 'reference'}`}><img className="mini big" src={thumbUrl(a)} onClick={() => focus(a)} /><i>{n + 1} {nm ?? ''}</i><PrepInput id={a} selected={selectedAssets} openDraft={openDraft} onReplace={(n) => op("updateShot", s.id, { refs: refsOfShot(s, story.bible).map((x) => (x === a ? n : x)) })} /><button className="ghost" title="Take this reference off the shot" onClick={() => op('updateShot', s.id, { refs: refsOfShot(s, story.bible).filter((x) => x !== a) })}>✕</button></span>; })}
                      {(() => { const m = mediaOfShot(s, story.bible, kindMap); const rm = (a: string) => op('updateShot', s.id, { media: (s.media ?? []).filter((x) => x !== a) });
                        return <>
                          {m.voices.map((v, n) => <span className="refPic" key={'v' + v.asset} title={`<Audio ${n + 1}> voice of ${v.name} (from the bible)`}><img className="mini big" src={thumbUrl(v.asset)} onClick={() => focus(v.asset)} /><i>🔊 {n + 1} {v.name}</i></span>)}
                          {m.audios.map((a, n) => <span className="refPic" key={'a' + a} title={`<Audio ${m.voices.length + n + 1}> audio reference`}><img className="mini big" src={thumbUrl(a)} onClick={() => focus(a)} /><i>🔊 {m.voices.length + n + 1}</i><button className="ghost" title="Take this off the shot" onClick={() => rm(a)}>✕</button></span>)}
                          {m.videos.map((a, n) => <span className="refPic" key={'m' + a} title={`<Video ${n + 1}> video reference`}><img className="mini big" src={thumbUrl(a)} onClick={() => focus(a)} /><i>🎞 {n + 1}</i><button className="ghost" title="Take this off the shot" onClick={() => rm(a)}>✕</button></span>)}
                        </>; })()}
                      {!s.frames?.first && !s.frames?.last && !refsOfShot(s, story.bible).length && !(s.media?.length) && !mediaOfShot(s, story.bible, kindMap).voices.length && <span className="note">none</span>}
                      <button className="ghost" disabled={!selectedAssets.some((a) => ['video', 'audio'].includes(assets.get(a)?.kind ?? ''))} title="Add the videos / sounds selected on the canvas as video or audio references" onClick={() => op('updateShot', s.id, { media: [...new Set([...(s.media ?? []), ...selectedAssets.filter((a) => ['video', 'audio'].includes(assets.get(a)?.kind ?? ''))])] })}>+ video/audio</button>
                      {chosenNeedsFrame && !s.frames?.first && elementsOfShot(s, story.bible).length > 0 && maker && <button className="ghost" title="Compose this shot's first frame from the bible" onClick={() => void makeStartFrames([{ s }])}>Make start frame</button>}
                      <button className="ghost" disabled={!selectedAssets.length} title="Add the pictures selected on the canvas as references" onClick={() => op('updateShot', s.id, { refs: [...new Set([...refsOfShot(s, story.bible), ...selectedAssets.filter((a) => assets.get(a)?.kind === 'image')])] })}>+ sel</button>
                      {s.refs !== undefined && <button className="ghost" title="Use the bible's pictures for this shot again" onClick={() => op('updateShot', s.id, { refs: undefined })}>↺ bible</button>}
                    </div>
                    {s.brief && <div className="note">{s.brief.framing} · {s.brief.move} · {s.brief.seconds}s — {s.brief.action}</div>}
                    {s.brief?.dialogue.map((d, k) => <div key={k} className="note">{d.speaker}: “{d.line}”</div>)}
                    <div className="row" style={{ margin: '4px 0' }}><label style={{ margin: 0 }}>Prompt</label><span className="sp" />{s.prompt?.trim() && <button className="ghost" title="Empty this prompt" onClick={() => op('updateShot', s.id, { prompt: '', generatedPrompt: undefined, promptWarnings: [] })}>Clear</button>}</div>
                    <textarea className="shotNotes" style={{ minHeight: 80 }} key={s.prompt} placeholder="(no prompt yet: use the Director tab)" defaultValue={s.prompt ?? ''} onBlur={(e) => e.target.value !== (s.prompt ?? '') && op('updateShot', s.id, { prompt: e.target.value })} />
                    {s.promptWarnings?.map((w, k) => <div key={k} className="warn">{w}</div>)}
                    <TagEditor tags={s.tags} onChange={(tags) => op('updateShot', s.id, { tags })} />
                    <textarea className="shotNotes" placeholder="Notes…" defaultValue={s.notes ?? ''} onBlur={(e) => e.target.value !== (s.notes ?? '') && op('updateShot', s.id, { notes: e.target.value })} />
                  </>}
                </div>
              );
            })}</div>}
          </div>
        );
      })}
      {unsorted.length > 0 && (
        <div className="scene">
          <div className="sceneHead"><b>Unsorted</b><span className="note">{unsorted.length} not in any shot</span></div>
          <div className="takes">
            {unsorted.slice(0, 60).map((a) => (
              <div key={a.id} className="take">
                <img src={thumbUrl(a.id)} loading="lazy" onClick={() => focus(a.id)} title={promptOf.get(a.id) ?? nameOf(a)} />
                <select className="moveTo" value="" onChange={(e) => e.target.value && op('addTake', e.target.value, a.id)}>
                  <option value="">→ shot…</option>
                  {allShots.map(({ s, scene }) => <option key={s.id} value={s.id}>{scene.name} / {s.name}</option>)}
                </select>
              </div>
            ))}
          </div>
          {unsorted.length > 60 && <div className="note">+{unsorted.length - 60} more (use search)</div>}
        </div>
      )}
      {!story.tree.length && <div className="empty">Add a scene, then shots, then collect takes into them.</div>}
      {story.tree.length > 0 && q.trim() && !filtered.length && !unsorted.length && <div className="empty">No matches for “{q}”.</div>}
    </>
  );
}

export function TagEditor({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }) {
  const [v, setV] = useState('');
  const add = () => { const t = v.trim(); if (t) onChange([...tags, t]); setV(''); };
  return (
    <div className="tags">
      {tags.map((t) => <span className="tag" key={t}>{t}<b onClick={() => onChange(tags.filter((x) => x !== t))}>×</b></span>)}
      <input className="tagIn" type="text" placeholder="+ tag" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} onBlur={add} />
    </div>
  );
}
