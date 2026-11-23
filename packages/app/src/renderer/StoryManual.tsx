/* Story (manual): a film made shot by shot, by hand. Every shot has two steps, a start frame (image model, from pictures you chose)
   and a clip (video model, starting from the frame). The reference shelf holds the pictures you reuse. Dividers group shots;
   a seam chip between two shots says how the next one joins the one before. Nothing runs unless a button is pressed. */
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import './manual.css';
import { C, api, valuesOfDraft, autoAssign, imageSlots, slotWithRole, thumbUrl, type Asset, type Draft, type JobView, type Manifest } from './shared.tsx';
import type { MShot, MDivider, MRef, Seam } from '../main/api.ts';
import { assetName } from './Canvas.tsx';
import { askText, confirmUser } from './Ask.tsx';
import { defaultSize, useDefaults } from './defaults.ts';
import { SizeChooser, resolveSize, sizeInfo, useSizeChoice, withSize } from './size.tsx';
import { useStore, useUsage, joinForTimeline } from './editorBridge.tsx';
import { applyPicks } from '@driftboard/editor';
import { Icon } from './ui/Icon.tsx';
import { Button, IconButton, Menu, Popover, Seg, Empty, type MenuItem } from './ui/ui.tsx';
import { Thumb, Capsule, GenButton, type StepState } from './ManualParts.tsx';
import { AddSource } from './AddSource.tsx';
import { PrepInput } from './PrepInput.tsx';
import { MentionBox, resolveMentions, type Cand } from './MentionBox.tsx';
import { StepSettings } from './StepSettings.tsx';

type Stage = 'frame' | 'clip';
type View = 'row' | 'compact' | 'strip';
type Filter = 'all' | 'frame' | 'clip';
const ROLES = ['place', 'person', 'prop', 'style', 'other'];
const SEAMS: { id: Seam; label: string; sub: string; icon: 'film' | 'link' }[] = [
  { id: 'cut', label: 'Cut', sub: 'A new start frame, no link to the shot before', icon: 'film' },
  { id: 'last', label: 'Last frame', sub: 'The start frame is made from the last frame of the clip before', icon: 'link' },
  { id: 'held', label: 'Held frames', sub: 'The clip carries on from the last 22 frames of the clip before', icon: 'link' },
];
const DUR = [3, 4, 5, 6, 8, 10, 12, 15];
/** A picture of the shot takes part in a step when it is on and not meant for the other step only. */
const usedBy = (i: { on: boolean; use?: 'both' | 'frame' | 'clip' }, stage: Stage) => i.on && (i.use ?? 'both') !== (stage === 'frame' ? 'clip' : 'frame');
const jstr = (j: JobView): { shot: string; stage: Stage } | undefined => { try { return (JSON.parse(j.params) as { __ms?: { shot: string; stage: Stage } }).__ms; } catch { return undefined; } };
const loadView = (): View => { try { const v = localStorage.getItem('driftboard.msView'); return v === 'compact' || v === 'strip' ? v : 'row'; } catch { return 'row'; } };

/** Drop zone: a picture dragged from the Library or a chip from the shelf. */
function dropProps(onAsset: (assetId: string, refId?: string) => void, refs: MRef[]) {
  const ok = (e: React.DragEvent) => e.dataTransfer.types.includes('application/x-driftboard-asset') || e.dataTransfer.types.includes('application/x-driftboard-ref');
  return {
    onDragOver: (e: React.DragEvent) => { if (ok(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; e.currentTarget.classList.add('drop'); } },
    onDragLeave: (e: React.DragEvent) => e.currentTarget.classList.remove('drop'),
    onDrop: (e: React.DragEvent) => {
      e.currentTarget.classList.remove('drop');
      const ref = e.dataTransfer.getData('application/x-driftboard-ref'), a = e.dataTransfer.getData('application/x-driftboard-asset');
      if (ref) { e.preventDefault(); const r = refs.find((x) => x.id === ref); if (r) onAsset(r.asset, r.id); } else if (a) { e.preventDefault(); onAsset(a); }
    },
  };
}

/** A text box that saves when you leave it. */
function PromptBox({ value, onSave, placeholder, rows = 3 }: { value: string; onSave: (v: string) => void; placeholder: string; rows?: number }) {
  const [t, setT] = useState(value);
  useEffect(() => setT(value), [value]);
  return <textarea className="ta mPrompt" rows={rows} value={t} placeholder={placeholder} onChange={(e) => setT(e.target.value)} onBlur={() => { if (t !== value) onSave(t); }} onKeyDown={(e) => e.stopPropagation()} />;
}
function NameBox({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [t, setT] = useState(value);
  useEffect(() => setT(value), [value]);
  return <input className="mName" value={t} aria-label="Name" onChange={(e) => setT(e.target.value)} onBlur={() => { if (t.trim() && t !== value) onSave(t.trim()); else setT(value); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); e.stopPropagation(); }} />;
}

export function StoryManual({ selectedAssets, focus, notify, openAuto }: { selectedAssets: string[]; focus: (assetId: string) => void; notify: (m: string) => void; openAuto: () => void }) {
  const { story, assets, jobs, progress, profiles, film, board } = useContext(C);
  const editor = useStore();
  const ms = story.ms;
  const [sid, setSid] = useState<string>(() => { try { return localStorage.getItem('driftboard.msStory') ?? ''; } catch { return ''; } });
  const sidNow = ms.stories.some((s) => s.id === sid) ? sid : ms.stories[0]?.id ?? '';
  useEffect(() => { if (!ms.stories.length) void api.msOp('ensureStory'); }, [ms.stories.length]);
  const items = useMemo(() => ms.items.filter((i) => i.storyId === sidNow), [ms.items, sidNow]);
  const refs = useMemo(() => ms.refs.filter((r) => r.storyId === sidNow), [ms.refs, sidNow]);
  const shots = useMemo(() => items.filter((i): i is MShot => i.kind === 'shot'), [items]);
  const op = useCallback((o: string, ...a: unknown[]) => api.msOp(o, ...a), []);
  const [view, setViewS] = useState<View>(loadView);
  const setView = (v: View) => { setViewS(v); try { localStorage.setItem('driftboard.msView', v); } catch { /* ignore */ } };
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [sel, setSel] = useState<{ shot: string; stage: Stage; asset: string } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [writing, setWriting] = useState<Set<string>>(new Set());
  const size: import('./size.tsx').SizeChoice = { purpose: 'film' };   // the Story has no size of its own: it follows the project (top bar) and Defaults
  const defs = useDefaults();
  const [shelfOpen, setShelfOpen] = useState(() => { try { return localStorage.getItem('driftboard.msShelf') !== 'closed'; } catch { return true; } });
  const toggleShelf = () => setShelfOpen((o) => { try { localStorage.setItem('driftboard.msShelf', o ? 'closed' : 'open'); } catch { /* ignore */ } return !o; });

  /* ---- what the jobs made for each step ---- */
  const steps = useMemo(() => {
    const m = new Map<string, { done: string[]; running: JobView[]; queued: JobView[]; failed: JobView[] }>();
    for (const j of [...jobs].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
      const t = jstr(j); if (!t) continue;
      const k = `${t.shot}|${t.stage}`; const e = m.get(k) ?? { done: [], running: [], queued: [], failed: [] }; m.set(k, e);
      if (j.status === 'done') for (const o of j.outputs) e.done.push(o.assetId);
      else if (j.status === 'running') e.running.push(j); else if (j.status === 'queued') e.queued.push(j); else if (j.status === 'failed') e.failed.push(j);
    }
    return m;
  }, [jobs]);
  const takesOf = (sh: MShot, stage: Stage): string[] => {
    const st = stage === 'frame' ? sh.frame : sh.clip;
    return [...new Set([...st.extra, ...(steps.get(`${sh.id}|${stage}`)?.done ?? [])])].filter((id) => assets.get(id) && !story.meta[id]?.trashed);
  };
  const stateOf = (sh: MShot, stage: Stage): StepState => {
    const e = steps.get(`${sh.id}|${stage}`); const r = e?.running[0];
    const lastFail = e?.failed.length ? e.failed[e.failed.length - 1] : undefined;
    return { running: e?.running.length ?? 0, queued: e?.queued.length ?? 0, pct: r ? progress[r.id] ?? r.progress ?? 0 : undefined, done: e?.done.length ?? 0, failed: lastFail?.error ?? undefined };
  };
  const busy = (sh: MShot, stage: Stage) => { const s = stateOf(sh, stage); return s.running + s.queued > 0; };
  const cancelStep = (sh: MShot, stage: Stage) => { const e = steps.get(`${sh.id}|${stage}`); for (const j of [...(e?.running ?? []), ...(e?.queued ?? [])]) void api.cancel(j.id); };

  /* The clip as the film uses it: a take made with held frames is shown and sent trimmed (the frames that repeat the shot before are cut off),
     so an 8 s clip is 8 s here too. Made once per take by the same step the timeline uses, then remembered. */
  const [joined, setJoined] = useState<Map<string, string>>(new Map());
  const asked = useRef<Set<string>>(new Set());
  const clipIds = shots.flatMap((s) => takesOf(s, 'clip')).join(',');
  useEffect(() => {
    const todo = [...new Set(clipIds.split(',').filter(Boolean))].filter((id) => !asked.current.has(id)); if (!todo.length) return;
    todo.forEach((id) => asked.current.add(id));
    void api.joinAssets(todo).then((out) => setJoined((m) => { const n = new Map(m); todo.forEach((id, i) => { if (out[i] && out[i] !== id) n.set(id, out[i]!); }); return n; })).catch(() => todo.forEach((id) => asked.current.delete(id)));
  }, [clipIds]);   // eslint-disable-line react-hooks/exhaustive-deps
  const trimmedOf = (id: string) => { const v = joined.get(id); return v && assets.get(v) ? v : id; };
  const usage = useUsage(editor);
  const onTimeline = (id: string | undefined) => !!id && ((usage.get(id) ?? 0) > 0 || (usage.get(trimmedOf(id)) ?? 0) > 0);

  /* ---- models and sizes ---- */
  const capacity = (x: Manifest) => imageSlots(x).reduce((n, s) => n + (s.type === 'image_list' ? s.max : 1), 0);
  const imageModels = profiles.filter((x) => x.kind === 'image' && x.slots.some((s) => s.type === 'text' && s.role === 'prompt'));
  const frameModel = (tiles: number, chosen?: string): Manifest | undefined => {
    const pick = imageModels.find((x) => x.id === chosen && (tiles === 0 || imageSlots(x).length > 0));
    if (pick) return pick;
    const saved = (() => { try { return localStorage.getItem('driftboard.frameMaker') ?? ''; } catch { return ''; } })();
    const withIn = imageModels.filter((x) => imageSlots(x).length > 0);
    if (tiles > 0) return withIn.find((x) => x.id === saved) ?? [...withIn].sort((a, b) => capacity(b) - capacity(a))[0];
    return imageModels.find((x) => !x.slots.some((s) => s.type === 'image' && s.required)) ?? imageModels[0];
  };
  const videos = profiles.filter((x) => x.kind === 'video' && x.slots.some((s) => s.type === 'text' && s.role === 'prompt'));
  const needsImage = (x: Manifest) => x.slots.some((s) => s.type === 'image' && s.required);
  const hasRole = (x: Manifest, r: string) => x.slots.some((s) => s.role === r);
  const durSlot = (x: Manifest) => x.slots.find((s) => s.type === 'number' && s.role === 'duration') as (Manifest['slots'][number] & { id: string; min?: number; max?: number }) | undefined;

  /** Queue n tries of a step: each with its own seed, results tagged so the card finds them. */
  const run = async (p: Manifest, d: Draft, n: number, shot: string, stage: Stage, src: Asset | undefined): Promise<string | null> => {
    const choice = (d.values.__size as typeof size | undefined) ?? defaultSize(defs, p, size).choice;
    let values = valuesOfDraft(p, d); delete values.__match; delete values.__size; delete values.__action;
    const si = sizeInfo(p);
    if (si.ok) { try { values = withSize(values, resolveSize(choice, film, src ?? null, si.step)); } catch { /* keep the model's own size */ } }
    values.__ms = { shot, stage };
    const hasSeed = p.slots.some((s) => s.role === 'seed');
    for (let i = 0; i < n; i++) {
      const v = { ...values }; if (hasSeed && (n > 1 || v.seed === undefined)) v.seed = Math.floor(Math.random() * 2 ** 31);
      const r = await api.generate(p.id, v, undefined, undefined, { ignoreWarnings: true });
      if (!r.ok) return r.error;
    }
    return null;
  };
  const prevShot = (sh: MShot): MShot | undefined => { const i = shots.findIndex((x) => x.id === sh.id); return i > 0 ? shots[i - 1] : undefined; };
  /** The last frame of the clip before, taken once and kept until that clip's pick changes. */
  const ensureSeam = async (sh: MShot): Promise<string | { error: string }> => {
    const prev = prevShot(sh); const pick = prev?.clip.pick;
    if (!prev || !pick) return { error: `Pick a clip for ${prev?.name ?? 'the shot before'} first: the seam uses its last frame.` };
    if (sh.frame.seamAsset && sh.frame.seamFrom === pick && assets.get(sh.frame.seamAsset)) return sh.frame.seamAsset;
    const r = await api.frameExtract(pick, 'last');
    if (!r.ok) return { error: r.error };
    await op('patchShot', sh.id, { frame: { seamAsset: r.assetId, seamFrom: pick, seamEnhanced: false } }, 'Seam frame');
    return r.assetId;
  };
  /** The last frame of the shot before, when it is there and still belongs to that shot's pick. */
  const seamOf = (sh: MShot): string | undefined => (sh.seam !== 'cut' && sh.frame.seamAsset && sh.frame.seamFrom && sh.frame.seamFrom === prevShot(sh)?.clip.pick && assets.get(sh.frame.seamAsset) ? sh.frame.seamAsset : undefined);
  /** What the clip starts from: the picked frame, or with the "last frame" seam the last frame of the shot before (enhanced or not). */
  const startOf = (sh: MShot): string | undefined => sh.frame.pick ?? (sh.seam === 'last' ? seamOf(sh) : undefined);
  const seamTried = useRef<Set<string>>(new Set());
  useEffect(() => {   // the last frame is taken as soon as a shot joins the one before, so it can be seen, enhanced and mentioned
    for (const sh of shots) {
      if (sh.seam === 'cut') continue; const pick = prevShot(sh)?.clip.pick; if (!pick || seamOf(sh)) continue;
      const key = sh.id + '|' + pick; if (seamTried.current.has(key)) continue; seamTried.current.add(key); void ensureSeam(sh);
    }
  });   // eslint-disable-line react-hooks/exhaustive-deps
  /** The pictures a start frame is made from, in <Picture n> order: the seam's last frame, then the inputs that are on. */
  const frameTiles = async (sh: MShot): Promise<{ asset: string; role: string; id?: string }[] | { error: string }> => {
    const out: { asset: string; role: string; id?: string }[] = [];
    if (sh.seam !== 'cut' && sh.frame.seamOn) { const a = await ensureSeam(sh); if (typeof a !== 'string') return a; out.push({ asset: a, role: 'place', id: 'seam' }); }
    for (const i of sh.frame.inputs) if (usedBy(i, 'frame') && assets.get(i.asset)) out.push({ asset: i.asset, role: i.role, id: i.id });
    return out;
  };
  /** How a prompt's @ chips read for a step: the number of the picture in that step, else its name. */
  const labelOf = (i: { id: string; asset: string; refId?: string; source: string }): string => (i.source === 'shelf' ? refs.find((r) => r.id === i.refId)?.name : undefined) ?? (assets.get(i.asset) ? assetName(assets.get(i.asset)!, story.meta) : 'picture');
  const knownOf = (sh: MShot) => ({ ...(seamOf(sh) ? { seam: { asset: seamOf(sh)!, label: `Last frame of ${prevShot(sh)?.name ?? 'the shot before'}` } } : {}), ...Object.fromEntries(sh.frame.inputs.filter((i) => assets.get(i.asset)).map((i) => [i.id, { asset: i.asset, label: labelOf(i) }])) });
  const textFor = (sh: MShot, stage: Stage, text: string, nums: Map<string, number>) => resolveMentions(text, (id) => (nums.get(id) ? `<Picture ${nums.get(id)}>` : stage === 'clip' ? mediaNums(sh).get(id) : undefined), (id) => { if (id === 'seam') return 'the last frame of the shot before'; const i = sh.frame.inputs.find((x) => x.id === id); return i ? labelOf(i) : undefined; });
  /** The pictures a clip is given besides its frame, in order, one per picture. */
  const clipRefs = (sh: MShot) => { const seen = new Set<string>(); return sh.frame.inputs.filter((i) => usedBy(i, 'clip') && assets.get(i.asset)?.kind === 'image' && !seen.has(i.asset) && (seen.add(i.asset), true)); };
  /** The clips and sounds a clip is given as references, in order. */
  const clipMedia = (sh: MShot, kind: 'video' | 'audio') => sh.frame.inputs.filter((i) => usedBy(i, 'clip') && assets.get(i.asset)?.kind === kind);
  const mediaNums = (sh: MShot) => new Map([...clipMedia(sh, 'video').map((i, k) => [i.id, `<Video ${k + 1}>`] as [string, string]), ...clipMedia(sh, 'audio').map((i, k) => [i.id, `<Audio ${k + 1}>`] as [string, string])]);
  const clipNums = (sh: MShot) => { const off = sh.seam === 'held' && sh.frame.pick ? 1 : 0; return new Map(clipRefs(sh).map((i, k) => [i.id, k + 1 + off] as [string, number])); };

  const makeFrame = async (sh: MShot, n: number): Promise<string | null> => {
    if (!sh.frame.prompt.trim()) return 'Write a prompt for the frame first.';
    const tiles = await frameTiles(sh); if ('error' in tiles) return tiles.error;
    const nums = new Map(tiles.map((t, k) => [t.id ?? '', k + 1] as [string, number]));
    const prompt = textFor(sh, 'frame', sh.frame.prompt, nums);
    const p = frameModel(tiles.length, sh.frame.profileId); if (!p) return 'No image model is on: turn one on in Settings › ComfyUI.';
    const ids = tiles.map((t) => t.asset).slice(0, capacity(p));
    return run(p, { profileId: p.id, values: { ...(sh.frame.values ?? {}), prompt }, inputs: autoAssign(p, ids), title: `Frame for ${sh.name}` }, n, sh.id, 'frame', undefined);
  };
  const clipModel = (sh: MShot): Manifest | undefined => {
    const chosen = videos.find((x) => x.id === sh.clip.profileId);
    const hasV = clipMedia(sh, 'video').length > 0, hasA = clipMedia(sh, 'audio').length > 0;
    const takes = (x: Manifest) => (!hasV || x.slots.some((s) => s.type === 'video_list')) && (!hasA || x.slots.some((s) => s.type === 'audio_list'));
    const find = (f: (x: Manifest) => boolean) => videos.find((x) => f(x) && takes(x)) ?? videos.find(f);
    if (sh.seam === 'held') return chosen && hasRole(chosen, 'guide_start') ? chosen : find((x) => hasRole(x, 'guide_start'));
    if (startOf(sh)) return chosen && (hasRole(chosen, 'first_frame') || hasRole(chosen, 'guide_still')) ? chosen : find((x) => hasRole(x, 'first_frame')) ?? find((x) => hasRole(x, 'guide_still'));
    return chosen && !needsImage(chosen) ? chosen : find((x) => !needsImage(x));
  };
  const makeClip = async (sh: MShot, n: number): Promise<string | null> => {
    if (!sh.clip.prompt.trim()) return 'Write a prompt for the clip first.';
    const prompt = textFor(sh, 'clip', sh.clip.prompt, clipNums(sh));
    const p = clipModel(sh); if (!p) return sh.seam === 'held' ? 'No video model takes held frames.' : startOf(sh) ? 'No video model starts from a picture.' : 'No video model that needs no picture: pick a frame first.';
    const values: Record<string, unknown> = { ...(sh.clip.values ?? {}), prompt }; const inputs: Record<string, string[]> = {};
    const dur = durSlot(p); if (dur && sh.clip.seconds) values[dur.id] = sh.clip.seconds;
    const pick = startOf(sh);
    const refSlot = p.slots.find((s) => s.type === 'image_list') as (Manifest['slots'][number] & { id: string; max: number }) | undefined;
    const tileAssets = clipRefs(sh).map((i) => i.asset);
    if (sh.seam === 'held') {
      const prev = prevShot(sh)?.clip.pick; if (!prev) return `Pick a clip for ${prevShot(sh)?.name ?? 'the shot before'} first: the held frames come from it.`;
      const g = await api.guideClip(prev, { side: 'tail', frames: 22, matchColor: true }); if (!g.ok) return g.error;
      inputs[slotWithRole(p, 'guide_start')?.id ?? p.slots.find((s) => s.role === 'guide_start')!.id] = [g.assetId]; values.guide_start_frames = g.frames;
      if (refSlot) { const pics = [...new Set([...(pick ? [pick] : []), ...tileAssets, ...(g.keystone ? [g.keystone] : [])])].slice(0, refSlot.max); if (pics.length) inputs[refSlot.id] = pics; }
      // the user's enhanced last frame is pinned at the last held frame: the clip carries on from a sharp picture, the held frames only give the motion
      const sa = seamOf(sh), still = p.slots.find((s) => s.role === 'guide_still');
      if (sh.frame.seamEnhanced && sa && still) { inputs[still.id] = [sa]; values[still.id + '_frame'] = g.frames - 1; }
    } else if (pick) {
      const first = slotWithRole(p, 'first_frame');
      if (first) inputs[first.id] = [pick];
      else { const still = p.slots.find((s) => s.role === 'guide_still'); if (still) { inputs[still.id] = [pick]; values[still.id + '_frame'] = 0; } if (refSlot && tileAssets.length) inputs[refSlot.id] = tileAssets.slice(0, refSlot.max); }
    } else if (refSlot && tileAssets.length) inputs[refSlot.id] = tileAssets.slice(0, refSlot.max);
    const vSlot = p.slots.find((s) => s.type === 'video_list') as (Manifest['slots'][number] & { id: string; max: number }) | undefined, aSlot = p.slots.find((s) => s.type === 'audio_list') as (Manifest['slots'][number] & { id: string; max: number }) | undefined;
    const vids = clipMedia(sh, 'video').map((i) => i.asset), auds = clipMedia(sh, 'audio').map((i) => i.asset);
    if (vSlot && vids.length) inputs[vSlot.id] = vids.slice(0, vSlot.max); if (aSlot && auds.length) inputs[aSlot.id] = auds.slice(0, aSlot.max);
    return run(p, { profileId: p.id, values, inputs, title: `Clip for ${sh.name}` }, n, sh.id, 'clip', pick ? assets.get(pick) : undefined);
  };
  const countOf = (sh: MShot, stage: Stage) => counts[`${sh.id}|${stage}`] ?? 1;
  const go = async (sh: MShot, stage: Stage) => {
    const err = stage === 'frame' ? await makeFrame(sh, countOf(sh, stage)) : await makeClip(sh, countOf(sh, stage));
    if (err) notify(`${sh.name}: ${err}`);
  };
  /** The LLM writes one prompt, from what is in the card. Only when asked. */
  const writeFor = async (sh: MShot, stage: Stage) => {
    const key = `${sh.id}|${stage}`; setWriting((w) => new Set(w).add(key));
    try {
      let p: Manifest | undefined; const inputs: { n: number; role: string; name?: string }[] = [];
      let idea = '';
      if (stage === 'frame') {
        const tiles = await frameTiles(sh); if ('error' in tiles) return notify(tiles.error);
        idea = textFor(sh, 'frame', sh.frame.prompt, new Map(tiles.map((t, k) => [t.id ?? '', k + 1] as [string, number]))) || sh.name;
        p = frameModel(tiles.length, sh.frame.profileId); if (!p) return notify('No image model is on.');
        tiles.slice(0, capacity(p)).forEach((t, i) => inputs.push({ n: i + 1, role: `${t.role} reference picture`, name: assetName(assets.get(t.asset)!, story.meta) }));
      } else {
        idea = textFor(sh, 'clip', sh.clip.prompt, clipNums(sh)) || sh.name;
        p = clipModel(sh); if (!p) return notify('No video model fits this shot.');
        if (startOf(sh) && hasRole(p, 'first_frame')) inputs.push({ n: 1, role: 'the literal first frame (opening frame) of the video' });
        else { const off = sh.seam === 'held' && sh.frame.pick ? 1 : 0; clipRefs(sh).forEach((i, k) => inputs.push({ n: k + 1 + off, role: `${i.role} reference picture`, name: assetName(assets.get(i.asset)!, story.meta) })); }
        if (p.slots.some((s) => s.type === 'video_list')) clipMedia(sh, 'video').forEach((i, k) => inputs.push({ n: k + 1, role: `reference video <Video ${k + 1}>: motion or look to follow`, name: assetName(assets.get(i.asset)!, story.meta) }));
        if (p.slots.some((s) => s.type === 'audio_list')) clipMedia(sh, 'audio').forEach((i, k) => inputs.push({ n: k + 1, role: `reference audio <Audio ${k + 1}>: a voice or sound to keep`, name: assetName(assets.get(i.asset)!, story.meta) }));
      }
      const dur = p && durSlot(p);
      const r = await api.llmEnhance({ profileId: p.id, idea, seconds: stage === 'clip' ? sh.clip.seconds ?? (dur as { wfDefault?: number } | undefined)?.wfDefault : undefined, inputs, kind: stage === 'clip' && sh.seam === 'held' ? 'continue-held' : undefined, previousPrompt: stage === 'clip' ? prevShot(sh)?.clip.prompt : undefined });
      if (!r.ok) return notify(r.error === 'Cancelled' ? 'Stopped: the prompt was not changed.' : r.error);
      await op('patchShot', sh.id, stage === 'frame' ? { frame: { prompt: r.prompt } } : { clip: { prompt: r.prompt } }, 'Write prompt');
    } finally { setWriting((w) => { const n = new Set(w); n.delete(key); return n; }); }
  };

  const select = async (sh: MShot, stage: Stage, asset: string) => {
    setSel({ shot: sh.id, stage, asset }); togglePick(sh, stage, asset);
    const shown = stage === 'clip' ? trimmedOf(asset) : asset;
    if (!board.items.some((i) => i.kind === 'asset' && i.ref === shown)) await api.boardAddAssets([shown], 0, 0);
    focus(shown);
  };
  /** Put the picked clip of a shot on the timeline. With onlySwap it only replaces a take of this shot that is already there. */
  const sendClip = async (sh: MShot, pickId: string | undefined, onlySwap = false) => {
    if (!editor || !pickId) return;
    const all = [...new Set([...takesOf(sh, 'clip'), pickId])];
    const out = await joinForTimeline(editor, all); const jm = new Map(all.map((id, i) => [id, out[i]!]));
    const r = applyPicks(editor, [{ pick: jm.get(pickId), takes: takesOf(sh, 'clip').map((t) => jm.get(t) ?? t) }], { onlySwap });
    if (!onlySwap) notify(r.appended ? `${sh.name} is on the timeline.` : r.swapped ? `${sh.name}: the timeline clip was replaced.` : `${sh.name} is already on the timeline.`);
    else if (r.swapped) notify(`${sh.name}: the timeline clip was replaced by the new pick.`);
  };
  /** Choosing a take is the pick: the one you click is the one that is used (and swapped in on the timeline when an older take of the shot is there). */
  const togglePick = (sh: MShot, stage: Stage, asset: string) => {
    const cur = stage === 'frame' ? sh.frame.pick : sh.clip.pick; if (cur === asset) return;
    void op('setPick', sh.id, stage, asset).then(() => { if (stage === 'clip') void sendClip(sh, asset, true); });
  };
  /** Take away a generated or added take: a hand-added one just leaves the card, a generated one goes to the Library Trash (it can come back from there). */
  const removeTake = async (sh: MShot, stage: Stage, id: string) => {
    const st = stage === 'frame' ? sh.frame : sh.clip;
    if (st.extra.includes(id)) await op('removeExtra', sh.id, stage, id);
    if (steps.get(`${sh.id}|${stage}`)?.done.includes(id)) await api.libraryTrash([id], true);
    notify(`Removed from ${sh.name}. Library › Trash brings a generated one back.`);
  };
  /* with one take it is the pick; when the picked take is gone the newest one takes over */
  const repicked = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!assets.size) return;
    for (const sh of shots) for (const stage of ['frame', 'clip'] as Stage[]) {
      const st = stage === 'frame' ? sh.frame : sh.clip; const list = takesOf(sh, stage); if (!list.length) continue;
      const gone = !!st.pick && (!assets.get(st.pick) || !!story.meta[st.pick]?.trashed);
      if (st.pick && !gone) continue;
      const target = list[list.length - 1]!; const key = `${sh.id}|${stage}|${st.pick ?? ''}|${target}`;
      if (repicked.current.has(key)) continue; repicked.current.add(key);
      void op('setPick', sh.id, stage, target).then(() => { if (stage === 'clip' && gone) void sendClip(sh, target, true); });
    }
  });   // eslint-disable-line react-hooks/exhaustive-deps
  const stepKey = (e: React.KeyboardEvent) => {
    if (!sel || (e.target as HTMLElement).tagName === 'TEXTAREA' || (e.target as HTMLElement).tagName === 'INPUT') return;
    const sh = shots.find((x) => x.id === sel.shot); if (!sh) return;
    const list = takesOf(sh, sel.stage); const i = list.indexOf(sel.asset);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { const j = i + (e.key === 'ArrowRight' ? 1 : -1); if (list[j]) { e.preventDefault(); void select(sh, sel.stage, list[j]!); } }
    else if (e.key.toLowerCase() === 'p' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); togglePick(sh, sel.stage, sel.asset); }
  };
  const selectedImages = selectedAssets.filter((a) => assets.get(a)?.kind === 'image');
  const selectedVideos = selectedAssets.filter((a) => assets.get(a)?.kind === 'video');
  const selectedAudios = selectedAssets.filter((a) => assets.get(a)?.kind === 'audio');

  /* ---- batches over the shots shown ---- */
  const visibleShots = shots.filter((s) => filter === 'all' || (filter === 'frame' ? !s.frame.pick : !!s.frame.pick && !s.clip.pick));
  const batch = async (stage: Stage) => {
    const todo = shots.filter((s) => (stage === 'frame' ? !s.frame.pick : !s.clip.pick) && visibleShots.includes(s) && !busy(s, stage));
    if (!todo.length) return notify(stage === 'frame' ? 'Every shown shot already has a picked frame.' : 'Every shown shot already has a picked clip.');
    let made = 0; const bad: string[] = [];
    for (const s of todo) {
      if (stage === 'clip' && !s.clip.prompt.trim()) { bad.push(`${s.name}: no clip prompt`); continue; }
      if (stage === 'frame' && !s.frame.prompt.trim()) { bad.push(`${s.name}: no frame prompt`); continue; }
      const e = stage === 'frame' ? await makeFrame(s, 1) : await makeClip(s, 1);
      if (e) bad.push(`${s.name}: ${e}`); else made++;
    }
    notify(`Queued ${made} ${stage === 'frame' ? 'frame' : 'clip'}${made === 1 ? '' : 's'}${bad.length ? `. Skipped ${bad.length}: ${bad[0]}${bad.length > 1 ? ` (and ${bad.length - 1} more)` : ''}` : ''}`);
  };
  const picksToTimeline = async () => {
    if (!editor) return;
    const picked = shots.filter((s) => s.clip.pick); if (!picked.length) return notify('No clips picked yet: nothing to put on the timeline.');
    const all = [...new Set(picked.flatMap((s) => takesOf(s, 'clip')))];
    const joined = await joinForTimeline(editor, all); const jm = new Map(all.map((id, i) => [id, joined[i]!]));
    const r = applyPicks(editor, picked.map((s) => ({ pick: jm.get(s.clip.pick!) ?? s.clip.pick, takes: takesOf(s, 'clip').map((t) => jm.get(t) ?? t) })));
    notify(`Timeline: ${r.appended} added, ${r.swapped} swapped, ${picked.length - r.appended - r.swapped} unchanged`);
  };

  /* ---- structure ---- */
  const askDivider = async (afterId: string | null | undefined) => { const n = await askText('New divider', 'Name', { placeholder: 'e.g. Inside the house', ok: 'Add divider' }); if (n) void op('addDivider', sidNow, n, afterId); };
  const [adding, setAdding] = useState('');
  const addLine = () => { const t = adding.trim(); if (!t) return; setAdding(''); if (t.startsWith('#')) void op('addDivider', sidNow, t.replace(/^#+\s*/, '')); else void op('addShot', sidNow, t); };
  const dragId = useRef<string | null>(null);
  const gapDrop = (beforeId: string | null) => ({
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes('application/x-driftboard-ms')) { e.preventDefault(); e.currentTarget.classList.add('drop'); } },
    onDragLeave: (e: React.DragEvent) => e.currentTarget.classList.remove('drop'),
    onDrop: (e: React.DragEvent) => { e.currentTarget.classList.remove('drop'); const id = e.dataTransfer.getData('application/x-driftboard-ms'); if (id) { e.preventDefault(); void op('moveItem', id, beforeId); } },
  });
  const seamMenu = (e: React.MouseEvent, sh: MShot) => {
    setMenu({ x: e.clientX, y: e.clientY, items: [{ header: `How ${sh.name} joins the shot before` }, ...SEAMS.map((s) => ({ label: s.label, sub: s.sub, icon: s.icon, onClick: () => { void op('patchShot', sh.id, { seam: s.id }, 'Seam').then(() => { if (s.id !== 'cut') void ensureSeam({ ...sh, seam: s.id }); }); } }))] });
  };
  const jump = (v: string) => { const n = parseInt(v, 10); const sh = shots[n - 1]; if (!sh) return notify(`There is no shot ${v}.`); setOpen((o) => new Set(o).add(sh.id)); setTimeout(() => { const el = document.getElementById('ms-' + sh.id); el?.scrollIntoView({ block: 'center', behavior: 'smooth' }); el?.classList.add('flash'); setTimeout(() => el?.classList.remove('flash'), 1200); }, 60); };

  const env: Env = { jobTakes: (sh, st) => steps.get(`${sh.id}|${st}`)?.done ?? [], nextShot: (sh) => { const i = shots.findIndex((x) => x.id === sh.id); return i >= 0 ? shots[i + 1] : undefined; }, storyMeta: story.meta, selected: selectedAssets, size, imageModels, frameModel, knownOf, labelOf, clipNums, clipRefs, op, assets, refs, takesOf, stateOf, busy, countOf, setCount: (sh, st, n) => setCounts((c) => ({ ...c, [`${sh.id}|${st}`]: n })), sel, select, togglePick, sendClip, removeTake, view: trimmedOf, onTimeline, go, writeFor, writing, cancelStep, selectedImages, videos, clipModel, notify, setMenu, prevShot, ensureSeam, selectedVideos, selectedAudios, mediaNums, clipMedia, seamOf, startOf };

  /* ---- layout ---- */
  const folded = new Set<string>(); { let cur: MDivider | null = null; for (const it of items) { if (it.kind === 'divider') cur = it.folded ? it : null; else if (cur) folded.add(it.id); } }
  const rows: React.ReactNode[] = [];
  let num = 0; let lastShot: MShot | undefined;
  rows.push(<div key="gap-top" className="mGap" {...gapDrop(items[0]?.id ?? null)}><span className="addDv" role="button" tabIndex={0} onClick={() => void askDivider(null)}>+ divider</span></div>);
  items.forEach((it, idx) => {
    const after = it.id; const next = items[idx + 1];
    if (it.kind === 'divider') {
      const count = (() => { let c = 0; for (let k = idx + 1; k < items.length && items[k]!.kind !== 'divider'; k++) c++; return c; })();
      rows.push(<div key={it.id} className="mDivider" draggable onDragStart={(e) => { e.dataTransfer.setData('application/x-driftboard-ms', it.id); dragId.current = it.id; }}>
        <button type="button" className="fold" aria-expanded={!it.folded} aria-label={it.folded ? 'Open this part' : 'Fold this part'} onClick={() => void op('setFolded', it.id, !it.folded)}><Icon name={it.folded ? 'chevR' : 'chev'} size={14} /></button>
        <NameBox value={it.name} onSave={(v) => void op('renameItem', it.id, v)} /><span className="ln" /><span className="ct">{count} shot{count === 1 ? '' : 's'}</span>
        <IconButton size="sm" icon="x" label="Delete the divider (its shots stay)" onClick={() => void op('removeItem', it.id)} />
      </div>);
      lastShot = undefined;
      return;
    }
    num++;
    if (folded.has(it.id)) { lastShot = it; return; }
    const hide = !visibleShots.includes(it);
    const seamHere = shots.indexOf(it) > 0;
    if (seamHere) rows.push(<div key={'seam-' + it.id} className="mGap seam" {...gapDrop(it.id)}>
      <span className="rail" /><button type="button" className={'mSeam' + (it.seam !== 'cut' ? ' link' : '')} onClick={(e) => seamMenu(e, it)} title="How this shot joins the one before: click to change"><Icon name={it.seam === 'cut' ? 'split' : 'link'} size={12} />{SEAMS.find((s) => s.id === it.seam)!.label}</button>
      <span className="addDv" role="button" tabIndex={0} onClick={() => void askDivider(lastShot?.id ?? items[idx - 1]?.id ?? null)}>+ divider</span></div>);
    if (!hide) rows.push(<ShotView key={it.id} sh={it} num={num} view={view} expanded={open.has(it.id)} toggle={() => setOpen((o) => { const n = new Set(o); if (n.has(it.id)) n.delete(it.id); else n.add(it.id); return n; })} env={env} onDragStart={() => { dragId.current = it.id; }} />);
    lastShot = it; void after; void next;
  });
  rows.push(<div key="gap-end" className="mGap" {...gapDrop(null)}><span className="addDv" role="button" tabIndex={0} onClick={() => void askDivider(undefined)}>+ divider</span></div>);

  const story0 = ms.stories.find((s) => s.id === sidNow);
  return (
    <div className="mStory" tabIndex={-1} onKeyDown={stepKey} data-area="story">
      <div className="ph mHead">
        <h2>Story</h2>
        {ms.stories.length > 1 ? <select className="selc mStoryPick" aria-label="Story" value={sidNow} onChange={(e) => { setSid(e.target.value); try { localStorage.setItem('driftboard.msStory', e.target.value); } catch { /* ignore */ } }}>{ms.stories.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          : story0 && <NameBox value={story0.name} onSave={(v) => void op('renameStory', story0.id, v)} />}
        <span className="sp" />
        <IconButton size="sm" icon="plus" label="New story" onClick={async () => { const n = await askText('New story', 'Name', { placeholder: 'e.g. The detective', ok: 'Create' }); if (n) { const s = await op('addStory', n) as { id: string }; setSid(s.id); try { localStorage.setItem('driftboard.msStory', s.id); } catch { /* ignore */ } } }} />
        <IconButton size="sm" icon="auto" label="Open Auto (experimental)" onClick={openAuto} />
      </div>
      <div className="pb mBody">
        <div className="mBar">
          <Button size="sm" onClick={() => void batch('frame')} title="Make a frame for every shown shot that has none picked and a prompt">Make frames</Button>
          <Button size="sm" onClick={() => void batch('clip')} title="Make a clip for every shown shot that has none picked and a prompt">Make clips</Button>
          <Button size="sm" kind="primary" icon="film" onClick={() => void picksToTimeline()} title="Put the picked clips on the timeline in story order">Picks to timeline</Button>
          <span className="sp" />
        </div>
        <Shelf refs={refs} sid={sidNow} open={shelfOpen} toggle={toggleShelf} env={env} />
        <div className="mTools">
          <Seg label="View" size="sm" value={view} onChange={setView} options={[{ value: 'row', label: 'Row' }, { value: 'compact', label: 'Compact' }, { value: 'strip', label: 'Strip' }]} />
          <Seg label="Show" size="sm" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All', count: shots.length }, { value: 'frame', label: 'Needs frame', count: shots.filter((s) => !s.frame.pick).length }, { value: 'clip', label: 'Needs clip', count: shots.filter((s) => !!s.frame.pick && !s.clip.pick).length }]} />
          <input className="inp mJump" placeholder="Go to shot #" aria-label="Go to shot number" onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { jump((e.target as HTMLInputElement).value); (e.target as HTMLInputElement).value = ''; } }} />
        </div>
        {!shots.length && !items.length && <Empty icon="story" title="No shots yet">Type a line below and press Enter to add the first shot. Start a line with # to add a divider.</Empty>}
        <div className={'mList v-' + view}>{view === 'strip' ? <StripView shots={visibleShots} folded={folded} env={env} setView={setView} open={setOpen} /> : rows}</div>
        <div className="mAdd"><input className="inp" value={adding} placeholder="Type a line and press Enter to add a shot (# for a divider)" aria-label="Add a shot" onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') addLine(); }} /></div>
        <div className="xs faint mHint">Hover a clip to scrub it. Hold Alt over any picture for a large peek. Click a take to use it and see it in the viewer; ← → step through takes.</div>
      </div>
      {menu && <Menu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

interface Env {
  jobTakes: (sh: MShot, st: Stage) => string[]; nextShot: (sh: MShot) => MShot | undefined; storyMeta: Record<string, any>;
  selected: string[]; size: import('./size.tsx').SizeChoice; imageModels: Manifest[]; frameModel: (tiles: number, chosen?: string) => Manifest | undefined;
  knownOf: (sh: MShot) => Record<string, { asset: string; label: string }>; labelOf: (i: { id: string; asset: string; refId?: string; source: string }) => string;
  clipNums: (sh: MShot) => Map<string, number>; clipRefs: (sh: MShot) => import('../main/api.ts').MShot['frame']['inputs'];
  op: (o: string, ...a: unknown[]) => Promise<unknown>; assets: Map<string, Asset>; refs: MRef[];
  takesOf: (sh: MShot, st: Stage) => string[]; stateOf: (sh: MShot, st: Stage) => StepState; busy: (sh: MShot, st: Stage) => boolean;
  countOf: (sh: MShot, st: Stage) => number; setCount: (sh: MShot, st: Stage, n: number) => void;
  sel: { shot: string; stage: Stage; asset: string } | null; select: (sh: MShot, st: Stage, a: string) => Promise<void>; togglePick: (sh: MShot, st: Stage, a: string) => void; sendClip: (sh: MShot, pick: string | undefined, onlySwap?: boolean) => Promise<void>; removeTake: (sh: MShot, st: Stage, id: string) => Promise<void>; view: (id: string) => string; onTimeline: (id: string | undefined) => boolean;
  go: (sh: MShot, st: Stage) => Promise<void>; writeFor: (sh: MShot, st: Stage) => Promise<void>; writing: Set<string>; cancelStep: (sh: MShot, st: Stage) => void;
  selectedImages: string[]; selectedVideos: string[]; selectedAudios: string[]; mediaNums: (sh: MShot) => Map<string, string>; seamOf: (sh: MShot) => string | undefined; startOf: (sh: MShot) => string | undefined; clipMedia: (sh: MShot, kind: 'video' | 'audio') => import('../main/api.ts').MShot['frame']['inputs']; videos: Manifest[]; clipModel: (sh: MShot) => Manifest | undefined; notify: (m: string) => void;
  setMenu: (m: { x: number; y: number; items: MenuItem[] } | null) => void; prevShot: (sh: MShot) => MShot | undefined; ensureSeam: (sh: MShot) => Promise<string | { error: string }>;
}

/* ---------------------------------------------------------------- the reference shelf */
function Shelf({ refs, sid, open, toggle, env }: { refs: MRef[]; sid: string; open: boolean; toggle: () => void; env: Env }) {
  const { assets, story } = useContext(C);
  const groups = [...new Set(refs.map((r) => r.group))];
  const add = (ids: string[], group = 'References') => { for (const id of ids) { const a = assets.get(id); if (a) void env.op('addRef', sid, assetName(a, story.meta), group, id); } };
  const dropP = dropProps((a) => add([a]), refs);
  const refMenu = (e: React.MouseEvent, r: MRef) => {
    e.preventDefault(); e.stopPropagation();
    env.setMenu({ x: e.clientX, y: e.clientY, items: [
      { label: 'Rename…', icon: 'pencil', onClick: async () => { const n = await askText('Rename', 'Name', { value: r.name }); if (n) void env.op('updateRef', r.id, { name: n }); } },
      { label: 'Move to a group…', icon: 'folder', onClick: async () => { const n = await askText('Group', 'Group name', { value: r.group, message: `Existing: ${groups.join(', ') || 'none'}` }); if (n) void env.op('updateRef', r.id, { group: n }); } },
      { sep: true }, { label: 'Remove from the shelf', icon: 'trash', danger: true, sub: 'The picture itself stays in the Library', onClick: () => void env.op('removeRef', r.id) },
    ] });
  };
  return (
    <div className={'mShelf' + (open ? ' open' : '')} {...dropP}>
      <div className="bar" role="button" tabIndex={0} aria-expanded={open} onClick={toggle} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}>
        <Icon name={open ? 'chev' : 'chevR'} size={14} /><b>Reference shelf</b><span className="mPill">{refs.length}</span>
        {!open && <span className="minis">{refs.slice(0, 12).map((r) => <img key={r.id} src={`driftboard-thumb://${r.asset}`} alt={r.name} title={r.name} />)}</span>}
        <span className="sp" /><span className="xs faint">{open ? 'Click to fold into a bar' : 'Click to open and drag references onto shots'}</span>
      </div>
      {open && <div className="body">
        {!refs.length && <div className="xs faint">Nothing on the shelf yet. Press “Add to the shelf” to pick from the canvas, the Library or your computer, or drop pictures here.</div>}
        {groups.map((g) => <div key={g} className="mGrp">
          <div className="gl"><span onDoubleClick={async () => { const n = await askText('Rename the group', 'Name', { value: g }); if (n) void env.op('renameGroup', sid, g, n); }} title="Double-click to rename">{g}</span></div>
          <div className="mRefs">{refs.filter((r) => r.group === g).map((r) => (
            <div key={r.id} className="mRefItem" draggable onDragStart={(e) => { e.dataTransfer.setData('application/x-driftboard-ref', r.id); e.dataTransfer.effectAllowed = 'copy'; }} onContextMenu={(e) => refMenu(e, r)}>
              <Thumb asset={assets.get(r.asset)} w={74} h={50} onClick={() => { void api.boardAddAssets([r.asset], 0, 0); }} label={`${r.name}: show on the canvas`} onRemove={() => void env.op('removeRef', r.id)} removeLabel="Remove from the shelf (the picture stays in the Library)" />
              <span className="rn" title={r.name}>{r.name}</span>
            </div>))}</div>
        </div>)}
        <div className="mRow"><AddSource kinds={['image']} selected={env.selected} exclude={refs.map((r) => r.asset)} className="btn sm" label="Add to the shelf" what="Add pictures to the shelf." onPick={(ids) => add(ids)} />
          <span className="xs faint">Drag a reference onto a shot, or right-click it to rename, group or remove.</span></div>
      </div>}
    </div>
  );
}

/* ---------------------------------------------------------------- one shot, in three sizes */
function dots(sh: MShot) {
  return <span className="mDots"><i className={sh.frame.pick ? 'on' : ''} title={sh.frame.pick ? 'Frame picked' : 'No frame picked'} /><i className={sh.clip.pick ? 'on' : ''} title={sh.clip.pick ? 'Clip picked' : 'No clip picked'} /></span>;
}

function ShotView({ sh, num, view, expanded, toggle, env, onDragStart }: { sh: MShot; num: number; view: View; expanded: boolean; toggle: () => void; env: Env; onDragStart: () => void }) {
  const { assets } = useContext(C);
  if (view === 'compact' && !expanded) {
    const fr = sh.frame.pick, cl = sh.clip.pick;
    return <div id={'ms-' + sh.id} className="mCompact" role="button" tabIndex={0} onClick={toggle} onKeyDown={(e) => { if (e.key === 'Enter') toggle(); }} title="Open this shot">
      <span className="n">{num}</span><Thumb asset={fr ? assets.get(fr) : undefined} w={34} h={20} /><Thumb asset={cl ? assets.get(cl) : undefined} w={34} h={20} />
      <span className="t">{sh.name}</span>{dots(sh)}
    </div>;
  }
  return <ShotCard sh={sh} num={num} env={env} onClose={view === 'compact' ? toggle : undefined} onDragStart={onDragStart} />;
}

function StripView({ shots, folded, env, setView, open }: { shots: MShot[]; folded: Set<string>; env: Env; setView: (v: View) => void; open: (f: (o: Set<string>) => Set<string>) => void }) {
  const { assets } = useContext(C);
  return <div className="mStrip">{shots.filter((s) => !folded.has(s.id)).map((s) => {
    const a = s.frame.pick ?? env.takesOf(s, 'frame')[0]; const n = shots.indexOf(s) + 1;
    return <div key={s.id} id={'ms-' + s.id} className="sc" role="button" tabIndex={0} title={s.name} onClick={() => { open((o) => new Set(o).add(s.id)); setView('compact'); }}>
      <Thumb asset={a ? assets.get(a) : undefined} w={96} h={54} /><span className="cap"><b>{n}</b> {s.name}</span>{dots(s)}</div>;
  })}</div>;
}

const USE_NEXT = { both: 'frame', frame: 'clip', clip: 'both' } as const;
const USE_TEXT = { both: 'Both', frame: 'Frame', clip: 'Clip' } as const;

/** The pictures of a shot, shared by its two steps. A tile shows its number in the tab that is open (the number the prompt's @ turns into), which steps use it, and can be turned off or moved. */
function SharedInputs({ sh, tab, env, lead }: { sh: MShot; tab: Stage; env: Env; lead?: React.ReactNode }) {
  const { assets } = useContext(C);
  const list = sh.frame.inputs;
  const seamOn = sh.seam !== 'cut' && sh.frame.seamOn;
  const nums = tab === 'frame' ? new Map(list.filter((i) => usedBy(i, 'frame') && assets.get(i.asset)).map((i, k) => [i.id, k + 1 + (seamOn ? 1 : 0)] as [string, number])) : env.clipNums(sh);
  const media = env.mediaNums(sh);
  const dropIn = dropProps((a, refId) => { const k = assets.get(a)?.kind; if (k) void env.op('addInput', sh.id, { asset: a, source: refId ? 'shelf' : 'once', refId, role: 'other', ...(k !== 'image' ? { use: 'clip' as const } : {}) }, 'frame'); }, env.refs);
  const upd = (id: string, patch: Record<string, unknown>) => void env.op('updateInput', sh.id, id, patch, 'frame');
  return (
    <div className="mIns" {...dropIn}>
      {lead}
      {list.map((i) => {
        const a = assets.get(i.asset); const mk = a?.kind ?? 'image'; const mw = media.get(i.id); const n = nums.get(i.id) ?? (tab === 'clip' && mw ? mw.replace(/[<>]/g, '').replace('Video ', 'V').replace('Audio ', 'A') : undefined); const use = i.use ?? 'both';
        return (
          <div key={i.id} className={'mTile' + (i.on ? '' : ' off') + (i.on && !n ? ' idle' : '')}>
            <div className="im"><Thumb asset={a} w={92} h={52} onClick={() => void api.boardAddAssets([i.asset], 0, 0)} label="Show on the canvas" onRemove={() => void env.op('removeInput', sh.id, i.id, 'frame')} />{n && <span className="pn">{n}</span>}{mk === 'image' && <PrepInput id={i.asset} selected={env.selected} onReplace={(nw) => upd(i.id, { asset: nw })} />}</div>
            <div className="src" role="button" tabIndex={0} title={`${env.labelOf(i)} · role: ${i.role}. Click to change the role (place, person, prop, style, other): the prompt writer reads it.`}
              onClick={() => { if (mk === 'image') upd(i.id, { role: ROLES[(ROLES.indexOf(i.role) + 1) % ROLES.length] }); }}>{env.labelOf(i)}<span className="rl"> · {mk === 'image' ? i.role : mk === 'video' ? 'reference clip' : 'reference sound'}</span></div>
            <div className="row2">
              <span className="tg" role="button" tabIndex={0} title={i.on ? 'Turn this picture off for both steps' : 'Turn it back on'} onClick={() => upd(i.id, { on: !i.on })}>{i.on ? 'On' : 'Off'}</span>
              <span className={'use' + (use !== 'both' ? ' set' : '')} role="button" tabIndex={0} title="Which steps use this picture: both, the frame only, or the clip only. Click to change." onClick={() => { if (mk === 'image') upd(i.id, { use: USE_NEXT[use] }); }}>{USE_TEXT[use]}</span>
              <IconButton size="sm" icon="back" label="Move earlier" onClick={() => void env.op('moveInput', sh.id, i.id, -1, 'frame')} /><IconButton size="sm" icon="chevR" label="Move later" onClick={() => void env.op('moveInput', sh.id, i.id, 1, 'frame')} />
            </div>
          </div>);
      })}
      <AddSource kinds={['image', 'video', 'audio']} selected={env.selected} exclude={list.map((i) => i.asset)} what={`Add pictures, clips or sounds to ${sh.name}.`} title="Add pictures, clips or sounds the model can take: from the canvas, the Library or your computer. You can also drop them here."
        onPick={(ids) => { for (const a of ids) void env.op('addInput', sh.id, { asset: a, source: 'once', role: 'other', ...(assets.get(a)?.kind !== 'image' ? { use: 'clip' as const } : {}) }, 'frame'); }}>
        <Icon name="plus" size="s" />Add</AddSource>
    </div>
  );
}

function ShotCard({ sh, num, env, onClose, onDragStart }: { sh: MShot; num: number; env: Env; onClose?: () => void; onDragStart: () => void }) {
  const { assets } = useContext(C);
  const defs = useDefaults();
  const [tab, setTab] = useState<Stage>('clip');
  const prev = env.prevShot(sh);
  const dropFrame = dropProps((a) => { if (assets.get(a)?.kind === 'image') void env.op('addExtra', sh.id, 'frame', a).then(() => env.op('setPick', sh.id, 'frame', a)); }, env.refs);
  const dropClip = dropProps((a) => { if (assets.get(a)?.kind === 'video') void env.op('addExtra', sh.id, 'clip', a).then(() => env.op('setPick', sh.id, 'clip', a)); else env.notify('Only clips can be a clip take.'); }, env.refs);
  const seamStale = sh.seam !== 'cut' && !!prev?.clip.pick && sh.frame.seamFrom !== prev.clip.pick;
  const seamOn = sh.seam !== 'cut' && sh.frame.seamOn;
  const fTakes = env.takesOf(sh, 'frame'), cTakes = env.takesOf(sh, 'clip');
  const fState = env.stateOf(sh, 'frame'), cState = env.stateOf(sh, 'clip');
  const secs = sh.clip.seconds; const cModel = env.clipModel(sh);
  const fTiles = sh.frame.inputs.filter((i) => usedBy(i, 'frame') && assets.get(i.asset)).length + (seamOn ? 1 : 0);
  const fModel = env.frameModel(fTiles, sh.frame.profileId);
  const dur = cModel?.slots.find((s) => s.type === 'number' && s.role === 'duration') as (Manifest['slots'][number] & { wfDefault?: number }) | undefined;
  const modelMenu = (stage: Stage) => (e: React.MouseEvent) => {
    const list = stage === 'clip' ? env.videos : env.imageModels; const reset = { profileId: undefined as string | undefined, values: undefined as Record<string, unknown> | undefined };
    const patch = (id?: string) => ({ [stage]: { profileId: id, values: (stage === 'frame' ? sh.frame.values : sh.clip.values)?.__size ? { __size: (stage === 'frame' ? sh.frame.values : sh.clip.values)!.__size } : undefined } });
    void reset;
    env.setMenu({ x: e.clientX, y: e.clientY, items: [{ header: stage === 'clip' ? 'Video model for this clip' : 'Image model for this frame' }, { label: 'Choose for me', sub: stage === 'clip' ? 'Held frames, a frame or a prompt alone decide' : 'The model that fits the pictures', icon: 'wand', onClick: () => void env.op('patchShot', sh.id, patch(undefined)) }, ...list.map((v) => ({ label: v.title, icon: (stage === 'clip' ? 'video' : 'image') as 'video' | 'image', onClick: () => void env.op('patchShot', sh.id, patch(v.id)) }))] });
  };
  const lenMenu = (e: React.MouseEvent) => env.setMenu({ x: e.clientX, y: e.clientY, items: [{ header: 'Length of the clip' }, ...DUR.map((d) => ({ label: `${d} s`, onClick: () => void env.op('patchShot', sh.id, { clip: { seconds: d } }) })), { sep: true }, { label: 'Another length…', onClick: async () => { const v = await askText('Length', 'Seconds', { value: String(secs ?? '') }); const n = Number(v); if (n > 0) void env.op('patchShot', sh.id, { clip: { seconds: n } }); } }] });

  /* the @ list of a step: the shot's pictures with their number in that step, then shelf pictures and canvas selection that can be added on the spot */
  const cands = (stage: Stage): Cand[] => {
    const nums = stage === 'clip' ? env.clipNums(sh) : new Map(sh.frame.inputs.filter((i) => usedBy(i, 'frame') && assets.get(i.asset)).map((i, k) => [i.id, k + 1 + (seamOn ? 1 : 0)] as [string, number]));
    const mn = stage === 'clip' ? env.mediaNums(sh) : new Map<string, string>();
    const inShot: Cand[] = sh.frame.inputs.filter((i) => nums.has(i.id) || mn.has(i.id)).map((i) => ({ id: i.id, asset: i.asset, label: env.labelOf(i), n: nums.get(i.id) ?? mn.get(i.id)!.replace(/[<>]/g, '').replace('Video ', 'V').replace('Audio ', 'A'), sub: i.source === 'shelf' ? 'From the shelf' : 'Used once' })).sort((a, b) => (typeof a.n === 'number' ? a.n : 1e3) - (typeof b.n === 'number' ? b.n : 1e3));
    const sa = sh.seam === 'cut' ? undefined : stage === 'frame' ? (seamOn ? env.seamOf(sh) : undefined) : env.seamOf(sh);
    if (sa) inShot.unshift({ id: 'seam', asset: sa, label: `Last frame of ${prev?.name ?? 'the shot before'}`, n: stage === 'frame' ? 1 : 'last', sub: stage === 'clip' ? (sh.seam === 'held' ? (sh.frame.seamEnhanced ? 'Enhanced · pinned at the end of the held frames' : 'End of the held frames') : 'The clip starts from it') : 'From the shot before' });
    const have = new Set(sh.frame.inputs.map((i) => i.asset));
    const add = (asset: string, label: string, sub: string, refId?: string): Cand => ({ id: 'add-' + asset, asset, label, sub, add: async () => (await env.op('addInput', sh.id, { asset, source: refId ? 'shelf' : 'once', refId, role: 'other', ...(assets.get(asset)?.kind !== 'image' ? { use: 'clip' as const } : {}) }, 'frame')) as string | undefined });
    const shelf = env.refs.filter((r) => !have.has(r.asset) && assets.get(r.asset)).slice(0, 8).map((r) => add(r.asset, r.name, 'On the shelf', r.id));
    const onCanvas = (stage === 'clip' ? [...env.selectedImages, ...env.selectedVideos, ...env.selectedAudios] : env.selectedImages).filter((a) => !have.has(a) && !env.refs.some((r) => r.asset === a)).slice(0, 6).map((a) => add(a, assetName(assets.get(a)!, env.storyMeta), 'Selected on the canvas'));
    return [...inShot, ...shelf, ...onCanvas];
  };
  const known = env.knownOf(sh);
  const sizeOf = (st: Stage) => ((st === 'frame' ? sh.frame.values : sh.clip.values)?.__size as typeof env.size | undefined) ?? defaultSize(defs, st === 'frame' ? fModel : cModel, env.size).choice;
  const setVal = (st: Stage, id: string, v: unknown) => { const cur = { ...((st === 'frame' ? sh.frame.values : sh.clip.values) ?? {}) }; if (v === undefined) delete cur[id]; else cur[id] = v; void env.op('patchShot', sh.id, { [st]: { values: cur } }, 'Settings'); };
  const settings = (st: Stage) => { const p = st === 'frame' ? fModel : cModel; return p ? <StepSettings key={st + p.id} profile={p} foldKey={'msSettings.' + st} values={(st === 'frame' ? sh.frame.values : sh.clip.values) ?? {}} onChange={(id, v) => setVal(st, id, v)} onReset={() => void env.op('patchShot', sh.id, { [st]: { values: undefined } }, 'Reset settings')} size={sizeOf(st)} onSize={(c) => setVal(st, '__size', c)} /> : null; };
  const preview = (id: string | undefined, stage: Stage) => id
    ? <div className="mBig"><Thumb asset={assets.get(id)} w={240} h={135} selected={env.sel?.asset === id && env.sel.shot === sh.id} picked onClick={() => void env.select(sh, stage, id)} label="Show in the viewer" /><span className="cp">{stage === 'frame' ? 'Picked frame' : (sh.clip.extra.includes(id) && !(env.jobTakes(sh, 'clip').includes(id)) ? 'Picked clip · added by hand' : 'Picked clip')}</span></div>
    : <div className="mBig empty">{stage === 'frame' ? 'No frame picked yet' : 'No clip picked yet'}</div>;
  const takes = (stage: Stage) => {
    const list = stage === 'frame' ? fTakes : cTakes; const st = stage === 'frame' ? sh.frame : sh.clip; const drop = stage === 'frame' ? dropFrame : dropClip;
    return (
      <div className="mTakes" {...drop}>
        {list.map((id) => <Thumb key={id} asset={assets.get(stage === 'clip' ? env.view(id) : id) ?? assets.get(id)} w={stage === 'clip' ? 128 : 92} h={stage === 'clip' ? 72 : 52} selected={env.sel?.asset === id && env.sel.shot === sh.id && env.sel.stage === stage} picked={st.pick === id} onClick={() => void env.select(sh, stage, id)}
          onRemove={() => void env.removeTake(sh, stage, id)} removeLabel={env.jobTakes(sh, stage).includes(id) ? 'Remove (to the Library Trash)' : 'Remove from this shot'} label={st.pick === id ? 'Used for this shot' : 'Click to use this one'}>
          {stage === 'clip' && st.pick === id && env.onTimeline(id) && <span className="tl">On timeline</span>}</Thumb>)}
        <AddSource kinds={[stage === 'frame' ? 'image' : 'video']} max={1} selected={env.selected} className="mAddIn small" what={stage === 'frame' ? `Pick the frame for ${sh.name}.` : `Pick the clip for ${sh.name}.`}
          title={stage === 'frame' ? 'Use a picture you already have as the start frame' : 'Use a clip you already have: it becomes the picked take, and you can add a prompt or references if you want more takes'}
          onPick={(ids) => { const a = ids[0]!; void env.op('addExtra', sh.id, stage, a).then(() => env.op('setPick', sh.id, stage, a)).then(() => { if (stage === 'clip') void env.sendClip(sh, a, true); }); }}>
          <Icon name={stage === 'frame' ? 'image' : 'video'} size="s" />{stage === 'frame' ? 'Use a picture' : 'Use a clip'}</AddSource>
      </div>
    );
  };
  const pull = async (which: 'first' | 'last') => {
    const clip = sh.clip.pick; if (!clip) return;
    const r = await api.frameExtract(which === 'first' ? env.view(clip) : clip, which); if (!r.ok) return env.notify(r.error);
    if (which === 'first') { await env.op('addExtra', sh.id, 'frame', r.assetId); await env.op('setPick', sh.id, 'frame', r.assetId); env.notify(`First frame of the clip is now the start frame of ${sh.name}.`); }
    else { const nx = env.nextShot(sh); if (nx) { await env.op('addInput', nx.id, { asset: r.assetId, source: 'once', role: 'place' }, 'frame'); env.notify(`Last frame added as a picture of ${nx.name}.`); } else env.notify('Last frame is on the canvas.'); }
  };
  const seamA = env.seamOf(sh);
  const seamTile = (clipTab: boolean) => <div className={'mTile seam' + (!clipTab && !sh.frame.seamOn ? ' off' : '')}>
    <div className="im"><Thumb asset={seamA ? assets.get(seamA) : undefined} w={92} h={52} onRemove={() => void env.op('patchShot', sh.id, { seam: 'cut' }, 'Stop carrying on')} removeLabel={`Remove: stop carrying on from ${prev?.name ?? 'the shot before'}`} />
      {!clipTab && seamOn && <span className="pn">1</span>}
      <span className={'bd' + (sh.frame.seamEnhanced ? ' on' : '')}>{sh.frame.seamEnhanced ? <><Icon name="wand" size={9} />Enhanced{clipTab && sh.seam === 'held' ? ' · pinned' : ''}</> : 'Last frame'}</span>
      {seamA && <PrepInput id={seamA} selected={env.selected} onReplace={(n) => void env.op('patchShot', sh.id, { frame: { seamAsset: n, seamEnhanced: true } }, 'Enhanced last frame')} />}</div>
    <div className="src" title={`The last frame of ${prev?.name ?? 'the shot before'}`}><Icon name="link" size={11} />{prev ? prev.name : 'No shot before'}</div>
    <div className="row2">{clipTab
      ? (sh.frame.seamEnhanced
        ? <span className="tg" role="button" tabIndex={0} title="Go back to the plain last frame" onClick={() => void env.ensureSeam({ ...sh, frame: { ...sh.frame, seamAsset: undefined, seamFrom: undefined } })}>Undo enhance</span>
        : <span className="xs faint">{sh.seam === 'held' ? 'Held frames end here' : 'Clip starts here'}</span>)
      : <span className="tg" role="button" tabIndex={0} onClick={() => void env.op('patchShot', sh.id, { frame: { seamOn: !sh.frame.seamOn } })}>{sh.frame.seamOn ? 'On' : 'Off'}</span>}</div>
    {seamStale && <div className="xs warnT">{prev?.clip.pick ? 'taking the last frame…' : 'pick a clip before'}</div>}
  </div>;
  const pickedTile = (ref: boolean) => sh.frame.pick ? <div className="mTile seam"><div className="im"><Thumb asset={assets.get(sh.frame.pick)} w={92} h={52} picked onRemove={() => void env.op('setPick', sh.id, 'frame', undefined)} removeLabel="Un-pick this frame (it stays in the takes)" />{ref && <span className="pn">1</span>}</div><div className="src">{ref ? 'Reference' : 'Start frame'}</div><div className="row2"><span className="xs faint">{ref ? 'the picked frame' : 'the picked frame'}</span></div></div> : null;
  const lead = tab === 'frame'
    ? (sh.seam !== 'cut' ? seamTile(false) : null)
    : sh.seam === 'held' ? <>{seamTile(true)}{pickedTile(true)}</>
    : sh.frame.pick ? pickedTile(false)
    : sh.seam === 'last' && seamA ? seamTile(true) : null;
  const cImported = !!sh.clip.pick && !env.jobTakes(sh, 'clip').includes(sh.clip.pick);
  const tabBtn = (st: Stage) => {
    const on = tab === st; const state = st === 'frame' ? fState : cState; const takesN = (st === 'frame' ? fTakes : cTakes).length; const pk = st === 'frame' ? sh.frame.pick : sh.clip.pick;
    const status = state.running ? `${Math.round((state.pct ?? 0) * 100)}%` : state.queued ? 'queued' : st === 'clip' && cImported ? 'imported' : takesN ? `${takesN}` : '';
    return <button key={st} type="button" role="tab" aria-selected={on} className={'mTab' + (on ? ' on' : '')} onClick={() => setTab(st)}>
      <Icon name={st === 'frame' ? 'image' : 'video'} size="s" />{st === 'frame' ? 'Frame' : 'Clip'}
      {st === 'frame' && pk && <img className="tth" src={thumbUrl(pk)} alt="" />}{status && <small className={state.running ? 'run' : ''}>{status}</small>}{!pk && !takesN && !state.running && <i className="dot" title="Nothing picked yet" />}
    </button>;
  };
  return (
    <div id={'ms-' + sh.id} className="mShot">
      <div className="mHd">
        <span className="grip" draggable title="Drag to move this shot" onDragStart={(e) => { e.dataTransfer.setData('application/x-driftboard-ms', sh.id); onDragStart(); }}><Icon name="grip" size={14} /></span>
        <span className="n">{num}</span>
        <div className="mTabs" role="tablist" aria-label="Step">{tabBtn('frame')}{tabBtn('clip')}</div>
        <NameBox value={sh.name} onSave={(v) => void env.op('renameItem', sh.id, v)} />
        {onClose && <IconButton size="sm" icon="chev" label="Close this shot" onClick={onClose} />}
        <IconButton size="sm" icon="trash" kind="danger" label="Delete this shot" onClick={async () => { if (await confirmUser(`Delete “${sh.name}”?`, 'Its picks and prompts go with it. Ctrl+Z brings it back; the pictures and clips stay on the canvas and in the Library.', 'Delete shot', true)) void env.op('removeItem', sh.id); }} />
      </div>
      <div className="lb2 mInHd">Pictures, clips and sounds for this shot<span className="faint"> · shared by the frame and the clip{tab === 'frame' ? '; numbers are for the frame' : '; numbers are for the clip (V = clip, A = sound)'}</span></div>
      <SharedInputs sh={sh} tab={tab} env={env} lead={lead} />
      {tab === 'frame' ? (
        <div className="mPane" data-stage="frame">
          <div className="lb"><Icon name="image" size="s" />Start frame<span className="faint"> · optional: the clip can start from it</span><span className="sp" /><Capsule s={fState} takes={fTakes.length} /></div>
          {takes('frame')}
          <MentionBox value={sh.frame.prompt} cands={cands('frame')} known={known} placeholder="What the first frame shows. Type @ to refer to a picture." onSave={(v) => void env.op('patchShot', sh.id, { frame: { prompt: v } }, 'Frame prompt')} />
          <div className="mChips"><button type="button" className="mChip" onClick={modelMenu('frame')}>Model <b>{fModel?.title ?? 'none fits'}</b></button></div>
          <div className="mAct">
            <GenButton n={env.countOf(sh, 'frame')} setN={(n) => env.setCount(sh, 'frame', n)} running={env.busy(sh, 'frame')} hasTakes={fTakes.length > 0} onGo={() => void env.go(sh, 'frame')} onCancel={() => env.cancelStep(sh, 'frame')} />
            <button type="button" className="mWrite" disabled={env.writing.has(sh.id + '|frame')} onClick={() => void env.writeFor(sh, 'frame')} title="The LLM writes the prompt from your words, the shot name and the pictures above"><Icon name="wand" size="s" />{env.writing.has(sh.id + '|frame') ? 'Writing…' : 'Write for me'}</button>
          </div>
          {settings('frame')}
        </div>
      ) : (
        <div className="mPane" data-stage="clip">
          <div className="lb"><Icon name="video" size="s" />Clip<span className="sp" /><Capsule s={cState} takes={cTakes.length} /></div>
          <div className="mFrom">
            {sh.seam === 'held' ? <><Icon name="link" size={12} /><span>Carries on from the last 22 frames of {prev?.name ?? 'the shot before'}{sh.frame.seamEnhanced ? ', starting from your enhanced last frame' : ''}</span></>
              : env.startOf(sh) ? <><Icon name="image" size={12} /><span>{sh.frame.pick ? 'Starts from the picked frame' : `Starts from the last frame of ${prev?.name ?? 'the shot before'}${sh.frame.seamEnhanced ? ' (enhanced)' : ''}`}</span></>
              : <span className="faint">No start frame: the clip is made from its prompt{env.clipRefs(sh).length ? ' and the pictures' : ''}.</span>}
            {cModel && !cModel.slots.some((x) => x.type === 'image_list') && env.clipRefs(sh).length > 0 && <span className="warnT"> · {cModel.title} takes no reference pictures, they are ignored</span>}
            {cModel && !cModel.slots.some((x) => x.type === 'video_list') && env.clipMedia(sh, 'video').length > 0 && <span className="warnT"> · {cModel.title} takes no reference clips, they are ignored</span>}
            {cModel && !cModel.slots.some((x) => x.type === 'audio_list') && env.clipMedia(sh, 'audio').length > 0 && <span className="warnT"> · {cModel.title} takes no reference sounds, they are ignored</span>}
          </div>
          {takes('clip')}
          {sh.clip.pick && <div className="mRow"><span className="xs faint">{cImported ? 'Imported clip.' : 'Picked clip.'} Pull a still out:</span>
            <Button size="sm" kind="quiet" title="Make the first frame of the picked clip this shot's start frame" onClick={() => void pull('first')}>First frame</Button>
            <Button size="sm" kind="quiet" title="Add the last frame of the picked clip as a picture of the next shot" onClick={() => void pull('last')}>Last frame</Button></div>}
          <MentionBox value={sh.clip.prompt} cands={cands('clip')} known={known} placeholder={cImported && !sh.clip.prompt ? 'Optional: describe the motion to make more takes. Type @ to refer to a picture.' : 'What happens in the clip: the motion, the camera, the sound. Type @ to refer to a picture.'} onSave={(v) => void env.op('patchShot', sh.id, { clip: { prompt: v } }, 'Clip prompt')} />
          <div className="mChips">
            <button type="button" className="mChip" onClick={lenMenu}><b>{secs ?? dur?.wfDefault ?? '?'} s</b> length</button>
            <button type="button" className="mChip" onClick={modelMenu('clip')}>Model <b>{cModel?.title ?? 'none fits'}</b></button>
          </div>
          <div className="mAct">
            <GenButton n={env.countOf(sh, 'clip')} setN={(n) => env.setCount(sh, 'clip', n)} running={env.busy(sh, 'clip')} hasTakes={cTakes.length > 0} onGo={() => void env.go(sh, 'clip')} onCancel={() => env.cancelStep(sh, 'clip')} />
            <button type="button" className="mWrite" disabled={env.writing.has(sh.id + '|clip')} onClick={() => void env.writeFor(sh, 'clip')} title="The LLM writes the motion prompt from your words, the frame and the shot before"><Icon name="wand" size="s" />{env.writing.has(sh.id + '|clip') ? 'Writing…' : 'Write for me'}</button>
            <span className="sp" />
            <Button size="sm" icon="film" disabled={!sh.clip.pick} title={sh.clip.pick ? 'Put the picked clip on the timeline. Picking another clip later replaces it there by itself.' : 'Pick a clip first'} onClick={() => void env.sendClip(sh, sh.clip.pick)}>{env.onTimeline(sh.clip.pick) ? 'On timeline' : 'To timeline'}</Button>
          </div>
          {settings('clip')}
        </div>
      )}
    </div>
  );
}
