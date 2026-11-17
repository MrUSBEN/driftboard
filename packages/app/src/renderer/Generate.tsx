import { addPending } from './pendingPlace.ts';
import { useContext, useEffect, useState } from 'react';
import { askUser } from './Ask.tsx';
import { PrepInput } from './PrepInput.tsx';
import { SlotField } from './SlotField.tsx';
import { checkPrompt, providedOf, detectPromptKind, KIND_LABEL } from './promptKind.ts';
import { Icon } from './ui/Icon.tsx';
import { Button, Chip, Empty, Notice, Popover, Progress, Section, Spinner, Stepper, Tile } from './ui/ui.tsx';
import { SizeChooser, resolveSize, useSizeChoice, withSize, ratioText, type SizeChoice } from './size.tsx';
import { C, api, thumbUrl, autoAssign, imageSlots, mediaSlots, mediaSlotKind, valuesOfDraft, type Draft, type Manifest, type PromptBlock, type PromptRecipe, type Slot } from './shared.tsx';
import { BlocksPanel } from './BlocksPanel.tsx';
import { activeBlocks, assemblePrompt } from '@driftboard/director/src/blocks.ts';

export function GenerateTab({ draft, setDraft, selectedAssets, stack, setStack }: { draft: Draft | null; setDraft: (d: Draft | null) => void; selectedAssets: string[]; stack: Draft[]; setStack: (s: Draft[]) => void }) {
  const { profiles, story, assets, film } = useContext(C);
  const [remembered, setRemembered] = useSizeChoice('gen');
  const metaName = (id: string) => story.meta[id]?.name;
  const [error, setError] = useState('');
  const [batch, setBatch] = useState(1);
  const [sent, setSent] = useState(false);
  const [options, setOptions] = useState<Record<string, string[]>>({});
  const [enh, setEnh] = useState<{ busy: boolean; before?: string; warnings: string[]; error?: string }>({ busy: false, warnings: [] });
  useEffect(() => { setError(''); setSent(false); setEnh({ busy: false, warnings: [] }); }, [draft]);
  const pid = draft?.profileId ?? profiles.find((p) => p.kind === 'video')?.id ?? profiles[0]?.id;
  useEffect(() => { if (!pid) return; let live = true; void api.profileOptions(pid).then((o) => { if (live) setOptions(o); }).catch(() => {}); return () => { live = false; }; }, [pid]);
  /** The open story's film blocks (or the project default): every prompt carries them, the prompt box is only the action. */
  const [sb, setSb] = useState<{ blocks: PromptBlock[]; source: 'story' | 'project' | 'starter' }>({ blocks: [], source: 'starter' });
  useEffect(() => { let live = true; void api.storyBlocks(story.activeId ?? undefined).then((b) => { if (live) setSb(b); }).catch(() => {}); return () => { live = false; }; }, [story]);
  /** Your defaults from Settings → ComfyUI, and which optional nodes ComfyUI has: both decide what the form shows. */
  const [saved, setSaved] = useState<Record<string, unknown>>({});
  const [has, setHas] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!pid) return; let live = true;
    const need = [...new Set(profiles.find((p) => p.id === pid)?.slots.flatMap((s) => (s.type === 'boolean' && s.needsNodes) || []) ?? [])];
    void api.comfyPrefs().then((p) => { if (live) setSaved(p.profiles[pid]?.defaults ?? {}); }).catch(() => {});
    void (need.length ? api.comfyHas(need) : Promise.resolve({})).then((h) => { if (live) setHas(h); }).catch(() => {});
    return () => { live = false; };
  }, [pid, profiles]);
  if (!profiles.length) return <div className="pb"><Empty icon="chip" title="No models to use">Turn on at least one workflow in Settings › ComfyUI, or check that ComfyUI is running.</Empty></div>;
  const d: Draft = draft ?? { profileId: profiles.find((p) => p.kind === 'video')?.id ?? profiles[0]!.id, values: {}, inputs: {}, title: 'Create' };
  const profile = profiles.find((p) => p.id === d.profileId) ?? profiles[0]!;
  const set = (patch: Partial<Draft>) => setDraft({ ...d, ...patch });
  /** Open another form from this one (e.g. Edit on an input) and remember this one, settings and all. */
  const pushDraft = (n: Draft | null) => { if (n) setStack([...stack, d]); setDraft(n); };
  const popDraft = () => { const prev = stack[stack.length - 1]; if (!prev) return; setStack(stack.slice(0, -1)); setDraft(prev); };
  const setVal = (id: string, v: unknown) => set({ values: { ...d.values, [id]: v } });

  const changeProfile = (id: string) => {
    const p = profiles.find((x) => x.id === id)!;
    const all = Object.values(d.inputs).flat();
    set({ profileId: id, values: { prompt: d.values.prompt }, inputs: autoAssign(p, all) });
  };
  /** The first input picture/clip that has a size: what the "match input" sizes follow. */
  const src = (() => { for (const s of imageSlots(profile)) for (const id of d.inputs[s.id] ?? []) { const a = assets.get(id); if (a?.width && a.height) return a; } return undefined; })();
  const frameSlot = profile.kind === 'video' ? imageSlots(profile).find((s) => s.role === 'first_frame') : undefined;
  const frame = frameSlot ? assets.get((d.inputs[frameSlot.id] ?? [])[0] ?? '') : undefined;
  const sizeUi = profile.slots.some((s) => s.type === 'enum' && !!(s as { customSize?: unknown }).customSize);
  const step = (profile.slots.find((s) => (s as Slot).customMultiple) as Slot | undefined)?.customMultiple ?? 8;
  const isSizeSlot = (s: Slot) => sizeUi && ((s.type === 'enum' && !!s.customSize) || (s.type === 'number' && /megapixel/.test(s.id)));
  /** What the chooser shows: the draft's own choice, else a custom size it already carries, else follow the first frame, else the last choice. */
  const choice: SizeChoice = (d.values.__size as SizeChoice | undefined) ?? (d.values.custom_width !== undefined ? { purpose: 'custom', w: Number(d.values.custom_width), h: Number(d.values.custom_height) } : frame ? { purpose: 'match' } : remembered);
  const setChoice = (c: SizeChoice) => { setVal('__size', c); setRemembered(c); };
  /** The size this generation will run at, so inputs smaller than it can be flagged. */
  const targetMp = (() => { if (!sizeUi) return undefined; try { return Math.round(resolveSize(choice, film, src, step).mp * 100) / 100; } catch { return undefined; } })();
  const setInput = (slot: string, ids: string[]) => set({ inputs: { ...d.inputs, [slot]: ids } });
  /** Settings of this profile that are not inputs or the size; optional speed-ups only when ComfyUI has their nodes. */
  const settings = profile.slots.filter((s) => s.type !== 'image' && s.type !== 'image_list' && s.type !== 'video' && s.type !== 'video_list' && s.type !== 'audio_list' && !isSizeSlot(s as Slot)
    && !(s.type === 'boolean' && s.needsNodes?.some((n) => !has[n])));
  const advanced = settings.filter((s) => s.advanced);
  const modelSlot = advanced.find((s) => s.type === 'enum' && s.model === 'unet' || (s.type === 'enum' && s.model === 'checkpoint')) as Slot | undefined;
  const shownOf = (s: Slot) => String(d.values[s.id] ?? saved[s.id] ?? s.wfDefault ?? '');
  const useBlocks = profile.slots.some((s) => s.role === 'prompt') && profile.kind === 'video';
  const blocks = useBlocks ? activeBlocks(sb.blocks, d.blockUse) : [];
  /** What the user wrote as the action (the prompt box holds the finished prompt after Enhance or Assemble). */
  const action = String(d.values.__action ?? d.values.prompt ?? '');
  const assemble = () => set({ values: { ...d.values, __action: action, prompt: assemblePrompt(action, blocks) } });
  const saveBlockToStory = async (id: string, text: string) => {
    await api.storySetBlocks(sb.source === 'story' && story.activeId ? story.activeId : 'project', sb.blocks.map((b) => (b.id === id ? { ...b, text } : b)));
    setSb(await api.storyBlocks(story.activeId ?? undefined));
  };

  /** Turn the idea in the prompt box into a prompt written for this model (uses the LLM and the profile's guide). */
  const enhance = async () => {
    const idea = String(d.values.prompt ?? '');
    const inputs: { n: number; tag?: 'Picture' | 'Video' | 'Audio'; role: string; name?: string }[] = [];
    for (const s of imageSlots(profile)) for (const id of d.inputs[s.id] ?? []) {
      const role = s.role === 'first_frame' ? 'the literal first frame (opening frame) of the video' : s.role === 'last_frame' ? 'the literal last frame of the video' : s.type === 'image_list' ? 'reference picture' : 'input picture';
      inputs.push({ n: inputs.length + 1, role, name: metaName(id) });
    }
    for (const s of mediaSlots(profile)) {
      if (s.role === 'guide_start' || s.role === 'guide_end') continue;   // held frames are anchored frames of the new clip, not something the prompt refers to
      const tag = s.type === 'audio_list' ? 'Audio' as const : 'Video' as const;
      (d.inputs[s.id] ?? []).forEach((id, i) => inputs.push({ n: i + 1, tag, role: tag === 'Audio' ? 'reference audio: the voice or sound to keep' : 'reference video: the motion or look to follow', name: metaName(id) }));
    }
    const dur = profile.slots.find((s) => s.type === 'number' && s.role === 'duration');
    const seconds = dur ? ((d.values[dur.id] as number | undefined) ?? (dur as Slot).wfDefault as number | undefined) : undefined;
    setEnh({ busy: true, warnings: [] });
    const r = await api.llmEnhance({ profileId: profile.id, idea, seconds, inputs, kind: d.kind, blocks, previousPrompt: d.previous });
    if (r.ok) { setEnh({ busy: false, before: idea, warnings: r.warnings }); set({ values: { ...d.values, __action: idea, prompt: r.prompt } }); }
    else setEnh({ busy: false, warnings: [], error: r.error });
  };

  const go = async () => {
    setError('');
    const warns = checkPrompt(String(d.values.prompt ?? ''), providedOf(profile.slots, d.inputs), profile.slots);
    if (warns.length) {
      const a = await askUser({ title: 'This prompt does not match its inputs', lines: warns, message: 'Run it anyway, or go back and change the prompt, the inputs or the model (a text-to-video model takes no pictures; a first/last-frame model needs them).', buttons: [{ id: 'cancel', label: 'Go back' }, { id: 'run', label: 'Run anyway', kind: 'danger' }] });
      if (a !== 'run') return;
    }
    let values = valuesOfDraft(profile, d); delete values.__match; delete values.__size; delete values.__action;
    // the job remembers how its prompt was made, so Continue / Bridge from its clip can carry the same blocks on
    if (useBlocks) values.__prompt = { action, blocks, storyId: story.activeId ?? undefined } satisfies PromptRecipe;
    if (sizeUi) values = withSize(values, resolveSize(choice, film, src, step));
    const n = Math.max(1, Math.min(12, batch)); const hasSeed = profile.slots.some((s) => s.role === 'seed');
    let failed = '';
    for (let i = 0; i < n; i++) {
      const v = { ...values }; if (n > 1 && hasSeed && (i > 0 || v.seed === undefined)) v.seed = Math.floor(Math.random() * 2 ** 31);   // each of a batch gets its own seed
      const r = await api.generate(profile.id, v, d.origin, d.shotId, { ignoreWarnings: true });
      if (!r.ok) { failed = r.error; break; }
      if (i === 0 && d.place) addPending(r.job.id, d.place);   // the first result of a batch fills the timeline gap
    }
    if (failed) setError(failed); else setSent(true);
  };

  const promptSlot = profile.slots.find((s) => s.type === 'text' && s.role === 'prompt') as Slot | undefined;
  const isVideo = profile.kind === 'video';
  const prompt = String(d.values.prompt ?? '');
  const kind = detectPromptKind(prompt).kind;
  const warns = prompt.trim() ? checkPrompt(prompt, providedOf(profile.slots, d.inputs), profile.slots) : [];
  const size = sizeUi ? (() => { try { return resolveSize(choice, film, src, step); } catch { return null; } })() : null;
  const durSlot = profile.slots.find((s) => s.type === 'number' && s.role === 'duration') as Slot | undefined;
  const secs = durSlot ? (d.values[durSlot.id] as number | undefined) ?? (saved[durSlot.id] as number | undefined) ?? (durSlot.wfDefault as number | undefined) : undefined;
  const seedSlot = profile.slots.find((s) => s.role === 'seed');
  const seedText = seedSlot ? (d.values[seedSlot.id] !== undefined && batch === 1 ? `seed ${d.values[seedSlot.id]}` : 'a new seed for each result') : '';
  const words = prompt.trim() ? prompt.trim().split(/\s+/).length : 0;
  const hasInputs = imageSlots(profile).length + mediaSlots(profile).length > 0;
  const addFromSel = (slot: string, ids: string[], max: number, kindOk: (id: string) => boolean) => setInput(slot, [...ids, ...selectedAssets.filter((a) => !ids.includes(a) && kindOk(a))].slice(0, max));
  const isImg = (id: string) => assets.get(id)?.kind === 'image';
  const tileOf = (slot: string, ids: string[], id: string, i: number, list: 'Picture' | 'Video' | 'Audio' | null) => {
    const a = assets.get(id);
    return (
      <div className="slotTile" key={id + i}>
        <Tile src={a?.kind === 'audio' ? undefined : thumbUrl(id)} kind={a?.kind === 'audio' ? 'audio' : 'image'} badge={list ? `${list} ${i + 1}` : undefined} onRemove={() => setInput(slot, ids.filter((_, k) => k !== i))} removeLabel="Remove this input">
          {a?.kind === 'image' && <PrepInput id={id} selected={selectedAssets} openDraft={pushDraft} targetMp={targetMp} onReplace={(n) => setInput(slot, ids.map((x, k) => (k === i ? n : x)))} />}
        </Tile>
        {a && (a.width && a.height ? <span className="meta">{propsOf(a)}</span> : a.duration_ms ? <span className="meta">{(a.duration_ms / 1000).toFixed(1)} s{a.kind === 'audio' && metaName(id) ? ` · ${metaName(id)}` : ''}</span> : null)}
      </div>
    );
  };
  return (
    <div className="create">
      <div className="ph"><h2>{d.title === 'Generate' ? 'Create' : d.title}</h2><span className="sp" /><Button size="sm" kind="quiet" icon="plus" title="Start a new empty form" onClick={() => { setStack([]); setDraft(null); }}>New</Button></div>
      {stack.length > 0 && <div className="row backRow"><Button size="sm" kind="quiet" icon="back" title="Go back to the form you came from, with all its settings" onClick={popDraft}>Back to {stack[stack.length - 1]!.title}</Button>{stack.length > 1 && <span className="xs faint">{stack.map((x) => x.title).join(' › ')} › {d.title}</span>}</div>}
      <div className="pb">
        <ModelPicker profiles={profiles} current={profile} onPick={changeProfile} />
        {hasInputs ? <Section title="Inputs" icon="import">
          {imageSlots(profile).map((s) => {
            const ids = d.inputs[s.id] ?? []; const max = s.type === 'image_list' ? s.max : 1;
            const n = selectedAssets.filter((a) => !ids.includes(a) && isImg(a)).length;
            return (
              <div className="field" key={s.id}>
                <span className="lbl">{s.label ?? s.id.replace(/_/g, ' ')}{s.type === 'image' && s.required && <span className="req" aria-label="required">*</span>}<span className="sp" /><span className="xs faint">{s.type === 'image_list' ? `up to ${max} · order = Picture 1, 2…` : ''}</span></span>
                <div className="row wrap" style={{ alignItems: 'flex-start' }}>
                  {ids.map((id, i) => tileOf(s.id, ids, id, i, s.type === 'image_list' ? 'Picture' : null))}
                  {ids.length < max && <button type="button" className="tile add" disabled={!n} title={n ? `Add the ${n} picture${n === 1 ? '' : 's'} selected on the canvas` : 'Select pictures on the canvas first'} onClick={() => addFromSel(s.id, ids, max, isImg)}><Icon name="plus" size="s" /><span>{n ? `From selection (${n})` : 'From selection'}</span></button>}
                </div>
              </div>
            );
          })}
          {mediaSlots(profile).map((s) => {
            const ids = d.inputs[s.id] ?? []; const max = s.type === 'video' ? 1 : s.max; const k = mediaSlotKind(s);
            const usable = selectedAssets.filter((a) => assets.get(a)?.kind === k && !ids.includes(a));
            return (
              <div className="field" key={s.id}>
                <span className="lbl">{s.label ?? s.id.replace(/_/g, ' ')}{s.type === 'video' && s.required && <span className="req" aria-label="required">*</span>}<span className="sp" /><span className="xs faint">{s.type === 'video' ? 'clip' : `up to ${max} · order = ${k === 'audio' ? 'Audio' : 'Video'} 1, 2…`}</span></span>
                <div className="row wrap" style={{ alignItems: 'flex-start' }}>
                  {ids.map((id, i) => tileOf(s.id, ids, id, i, s.type === 'video' ? null : k === 'audio' ? 'Audio' : 'Video'))}
                  {ids.length < max && <button type="button" className="tile add" disabled={!usable.length} title={usable.length ? `Add the ${k} selected on the canvas` : `Select a ${k === 'audio' ? 'sound' : 'clip'} on the canvas first`} onClick={() => setInput(s.id, [...ids, ...usable].slice(0, max))}><Icon name="plus" size="s" /><span>{usable.length ? `From selection (${usable.length})` : 'From selection'}</span></button>}
                </div>
                {s.note && ids.length === 0 && <span className="xs faint">{s.note}</span>}
              </div>
            );
          })}
        </Section> : <Notice>{profile.title} takes no inputs: text only.</Notice>}
        {promptSlot && <Section title={isVideo && useBlocks && blocks.length ? 'Action' : 'Prompt'} icon="pencil" actions={prompt.trim() ? <span className={'chip ' + (warns.length ? 'bad' : 'ok')} title="What the prompt is written for, from the inputs it mentions"><Icon name={warns.length ? 'warn' : 'check'} size={12} />Reads as: {KIND_LABEL[kind]}</span> : undefined}>
          {d.previous && <div className="row"><Chip on icon="cont" title={d.previous} onRemove={() => set({ previous: undefined })} removeLabel="Do not use the previous clip's prompt">Previous clip's prompt</Chip><span className="xs faint">carried into Enhance</span></div>}
          <textarea className="ta" aria-label="Prompt" placeholder={isVideo && blocks.length ? 'What happens in this clip. The film blocks below add the look, place, characters and sound.' : isVideo ? 'What happens in this clip.' : 'Describe the picture.'} value={prompt} onChange={(e) => setVal(promptSlot.id, e.target.value)} />
          {warns.length > 0 && <Notice tone="bad">{warns.map((w, i) => <span key={i}>{w}</span>)}<span>Change the prompt, the inputs or the model.</span></Notice>}
          {enh.busy && <div className="working"><div className="row"><Spinner /><b className="small">Writing the prompt with the LLM…</b></div><Progress label="Writing the prompt" /><span className="xs dim">Uses this model's guide. The GPU is freed afterwards if Settings › LLM says so.</span></div>}
          {enh.warnings.length > 0 && <Notice tone="warn">{enh.warnings.map((w, i) => <span key={i}>{w}</span>)}</Notice>}
          {enh.error && <Notice tone="bad">{enh.error}<span>Check that the LLM server is running (top bar), then try again.</span></Notice>}
          <div className="row wrap">
            <Button size="sm" icon="wand" disabled={enh.busy || !prompt.trim()} title={blocks.length || d.previous ? 'Write the action up as a full prompt for this model: the film blocks and the previous clip are carried in (LLM)' : 'Write this idea up as a full prompt for the chosen model, using its guide (LLM)'} onClick={enhance}>{enh.busy ? 'Writing…' : 'Enhance'}</Button>
            {useBlocks && blocks.length > 0 && <Button size="sm" kind="quiet" disabled={!action.trim()} title="Put the action and the film blocks together without the LLM" onClick={assemble}>Assemble</Button>}
            {enh.before !== undefined && <Button size="sm" kind="quiet" icon="undo" title="Back to what you wrote" onClick={() => { set({ values: { ...d.values, prompt: enh.before, __action: undefined } }); setEnh({ busy: false, warnings: [] }); }}>Undo</Button>}
            <span className="sp" /><span className="xs faint">{words} word{words === 1 ? '' : 's'}</span>
          </div>
          {useBlocks && <BlocksPanel blocks={sb.blocks} source={sb.source} use={d.blockUse ?? {}} onUse={(u) => set({ blockUse: u })} onSaveToStory={(id, t) => void saveBlockToStory(id, t)} storyName={story.stories.find((x) => x.id === story.activeId)?.name} />}
        </Section>}
        {sizeUi && <Section title="Size" icon="fit" actions={size ? <span className="mono xs dim">{size.w}×{size.h}</span> : undefined}><SizeChooser value={choice} onChange={setChoice} src={src} frame={frame} step={step} /></Section>}
        {settings.some((s) => !s.advanced && s !== promptSlot) && <Section title="Settings" icon="settings">
          {settings.filter((s) => !s.advanced && s !== promptSlot).map((s) => <SlotField key={profile.id + s.id} slot={s as Slot} value={d.values[s.id]} onChange={(v) => setVal(s.id, v)} options={options[s.id]} saved={saved[s.id]} />)}
        </Section>}
        {advanced.length > 0 && <Section title="Advanced" icon="chip" count={modelSlot ? `· ${shownOf(modelSlot)}` : undefined} fold foldKey="createAdvanced" defaultOpen={false}>
          {advanced.map((s) => <SlotField key={profile.id + s.id} slot={s as Slot} value={d.values[s.id]} onChange={(v) => setVal(s.id, v)} options={options[s.id]} saved={saved[s.id]} />)}
          <span className="xs faint">Defaults for these live in Settings › ComfyUI. A change here is for this generation only.</span>
        </Section>}
      </div>
      <div className="pf">
        {sent && <Notice><span>Queued{batch > 1 ? ` ${batch}` : ''}. {batch > 1 ? 'They land' : 'It lands'} on the canvas{d.origin ? ' next to where it started' : ''} when done. <button type="button" className="linkBtn" onClick={() => window.dispatchEvent(new CustomEvent('driftboard-open-activity', { detail: 'jobs' }))}>Show in Activity</button></span></Notice>}
        {error && <Notice tone="bad"><span>{error}</span><span>Nothing was queued. Fix the problem above (or start ComfyUI), then press Generate again.</span></Notice>}
        <div className="row"><span className="lbl" style={{ whiteSpace: 'nowrap' }}>Results go to</span>
          <select className="selc" style={{ flex: 1, minWidth: 0 }} aria-label="Results go to" value={d.shotId ?? ''} onChange={(e) => set({ shotId: e.target.value || undefined })}>
            <option value="">the canvas only</option>
            {story.all.map(({ scene, shots }) => <optgroup key={scene.id} label={scene.name}>{shots.map((s) => <option key={s.id} value={s.id}>the canvas + shot “{s.name}”</option>)}</optgroup>)}
          </select></div>
        <div className="row">
          <Stepper value={batch} onChange={setBatch} label="Results" />
          <Button kind="primary" icon="create" style={{ flex: 1 }} onClick={go}>Generate{batch > 1 ? ` ${batch}` : ''}{size ? ` · ${size.w}×${size.h}` : ''}{isVideo && secs ? ` · ${secs} s` : ''}</Button>
        </div>
        <span className="xs faint">{profile.title}{size ? ` · ${size.mp.toFixed(2)} MP · ${ratioText(size.w, size.h)}` : ''}{seedText ? ` · ${seedText}` : ''}</span>
      </div>
    </div>
  );
}

/** Capabilities of a workflow profile in plain words: what it takes in. */
export function capsOf(p: Manifest): string[] {
  const out: string[] = [];
  if (p.slots.some((s) => s.role === 'prompt')) out.push('text');
  if (p.slots.some((s) => s.role === 'first_frame')) out.push('first frame');
  if (p.slots.some((s) => s.role === 'last_frame')) out.push('last frame');
  const list = p.slots.find((s) => s.type === 'image_list'); if (list && list.type === 'image_list') out.push(`pictures ×${list.max}`);
  if (p.slots.some((s) => s.type === 'image' && s.role !== 'first_frame' && s.role !== 'last_frame' && !/guide_still/.test(s.id))) out.push('picture');
  if (p.slots.some((s) => s.role === 'guide_start' || s.role === 'guide_end')) out.push('held frames');
  if (p.slots.some((s) => s.type === 'video_list')) out.push('video');
  if (p.slots.some((s) => s.type === 'audio_list')) out.push('sound');
  if (p.kind === 'video' && !p.slots.some((s) => s.type === 'image' || s.type === 'image_list' || s.type === 'video' || s.type === 'video_list')) out.push('no inputs');
  return out;
}

/** The model picker: each model with what it takes, grouped by video and pictures; models missing a file say so. */
function ModelPicker({ profiles, current, onPick }: { profiles: Manifest[]; current: Manifest; onPick: (id: string) => void }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [health, setHealth] = useState<Record<string, boolean>>({});
  useEffect(() => { if (!anchor) return; let live = true; void api.comfyHealth().then((h) => { if (live) setHealth(Object.fromEntries(h.map((x) => [x.id, x.ok]))); }).catch(() => {}); return () => { live = false; }; }, [anchor]);
  const row = (p: Manifest) => (
    <button key={p.id} type="button" role="menuitem" className={'mi' + (p.id === current.id ? ' act' : '')} onClick={() => { setAnchor(null); if (p.id !== current.id) onPick(p.id); }}>
      <Icon name={p.kind === 'video' ? 'video' : 'image'} />
      <span className="mt"><b style={{ fontWeight: 600 }}>{p.title}</b>{p.id === current.id && <span className="rec">current</span>}
        <span className="capRow">{capsOf(p).map((c) => <span key={c} className="chip">{c}</span>)}{health[p.id] === false && <span className="chip bad"><Icon name="warn" size={11} />needs a model file or node</span>}</span></span>
    </button>
  );
  return (
    <div className="field">
      <span className="lbl">Model</span>
      <button type="button" className="btn modelBtn" aria-haspopup="menu" aria-expanded={!!anchor} onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}>
        <Icon name={current.kind === 'video' ? 'video' : 'image'} size="l" />
        <span className="mt"><b>{current.title}</b><span className="capRow">{capsOf(current).map((c) => <span key={c} className="chip">{c}</span>)}</span></span>
        <Icon name="chev" size="s" />
      </button>
      {anchor && <Popover anchor={anchor} onClose={() => setAnchor(null)} width={Math.max(320, anchor.offsetWidth)} title="Model">
        <div className="dmenu modelList" role="menu" style={{ position: 'static', boxShadow: 'none', border: 0, padding: 0, background: 'transparent', minWidth: 0, maxWidth: 'none', animation: 'none', maxHeight: 'none' }}>
          {profiles.some((p) => p.kind === 'video') && <div className="mh">Video</div>}{profiles.filter((p) => p.kind === 'video').map(row)}
          {profiles.some((p) => p.kind !== 'video') && <div className="mh">Pictures</div>}{profiles.filter((p) => p.kind !== 'video').map(row)}
        </div>
        <span className="xs faint">Turn models on or off and set their defaults in Settings › ComfyUI.</span>
      </Popover>}
    </div>
  );
}

/** "960×544 · 0.52 MP · 16:9 · 4.0 s": what a model gets when this picture or clip is an input. */
const propsOf = (a: { width: number | null; height: number | null; duration_ms: number | null; kind: string }) => {
  const w = a.width!, h = a.height!; const gcd = (x: number, y: number): number => (y ? gcd(y, x % y) : x); const k = gcd(w, h);
  const ratio = w / k <= 32 && h / k <= 32 ? `${w / k}:${h / k}` : `${(w / h).toFixed(2)}:1`;
  return `${w}×${h} · ${((w * h) / 1e6).toFixed(2)} MP · ${ratio}${a.kind === 'video' && a.duration_ms ? ` · ${(a.duration_ms / 1000).toFixed(1)} s` : ''}`;
};
