import { addPending } from './pendingPlace.ts';
import { useContext, useEffect, useState } from 'react';
import { askUser } from './Ask.tsx';
import { PrepInput } from './PrepInput.tsx';
import { SlotField } from './SlotField.tsx';
import { checkPrompt, providedOf } from './promptKind.ts';
import { SizeChooser, resolveSize, useSizeChoice, withSize, type SizeChoice } from './size.tsx';
import { C, api, thumbUrl, autoAssign, imageSlots, mediaSlots, mediaSlotKind, valuesOfDraft, type Draft, type PromptBlock, type PromptRecipe, type Slot } from './shared.tsx';
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
  if (!profiles.length) return <div className="empty">No profiles installed.</div>;
  const d: Draft = draft ?? { profileId: profiles.find((p) => p.kind === 'video')?.id ?? profiles[0]!.id, values: {}, inputs: {}, title: 'Generate' };
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

  return (
    <>
      {stack.length > 0 && <div className="row" style={{ margin: '0 0 6px' }}><button title="Go back to the form you came from, with all its settings" onClick={popDraft}>← Back to {stack[stack.length - 1]!.title}</button>{stack.length > 1 && <span className="note">{stack.map((x) => x.title).join(' › ')} › {d.title}</span>}</div>}
      <h2>{d.title}</h2>
      <select value={profile.id} onChange={(e) => changeProfile(e.target.value)}>{profiles.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select>
      <label>Add results to shot</label>
      <select value={d.shotId ?? ''} onChange={(e) => set({ shotId: e.target.value || undefined })}>
        <option value="">(none, leave unsorted)</option>
        {story.all.map(({ scene, shots }) => shots.map((s) => <option key={s.id} value={s.id}>{scene.name} / {s.name}</option>))}
      </select>
      {imageSlots(profile).map((s) => {
        const ids = d.inputs[s.id] ?? [];
        const max = s.type === 'image_list' ? s.max : 1;
        return (
          <div key={s.id}>
            <label>{s.label ?? s.id.replace(/_/g, ' ')}{s.type === 'image' && s.required ? ' *' : ''} <span className="note">{s.type === 'image_list' ? `up to ${max}, order = Picture 1, 2…` : ''}</span></label>
            <div className="refstrip">
              {ids.map((id, i) => <div className="ref" key={id + i}><img src={thumbUrl(id)} />{s.type === 'image_list' && <span className="badge">{i + 1}</span>}<button title="Remove" onClick={() => setInput(s.id, ids.filter((_, k) => k !== i))}>×</button><PrepInput id={id} selected={selectedAssets} openDraft={pushDraft} targetMp={targetMp} onReplace={(n) => setInput(s.id, ids.map((x, k) => (k === i ? n : x)))} /></div>)}
              {ids.length < max && <button className="addref" disabled={!selectedAssets.length} title="Add the assets selected on the canvas" onClick={() => setInput(s.id, [...ids, ...selectedAssets.filter((a) => !ids.includes(a))].slice(0, max))}>+ selected</button>}
            </div>
            {ids.map((id, i) => { const a = assets.get(id); return a?.width && a.height ? <div key={'p' + id + i} className="note">{s.type === 'image_list' ? `${i + 1}. ` : ''}{propsOf(a)}</div> : null; })}
          </div>
        );
      })}
      {mediaSlots(profile).map((s) => {
        const ids = d.inputs[s.id] ?? [];
        const max = s.type === 'video' ? 1 : s.max; const kind = mediaSlotKind(s);
        const usable = selectedAssets.filter((a) => assets.get(a)?.kind === kind && !ids.includes(a));
        return (
          <div key={s.id}>
            <label>{s.label ?? s.id.replace(/_/g, ' ')}{s.type === 'video' && s.required ? ' *' : ''} <span className="note">{s.type === 'video' ? '' : `up to ${max}`}</span></label>
            <div className="refstrip">
              {ids.map((id, i) => <div className="ref" key={id + i}>{kind === 'video' ? <img src={thumbUrl(id)} /> : <span className="audioChip">🔊 {metaName(id) ?? id.slice(0, 6)}</span>}{s.type !== 'video' && <span className="badge">{i + 1}</span>}<button title="Remove" onClick={() => setInput(s.id, ids.filter((_, k) => k !== i))}>×</button></div>)}
              {ids.length < max && <button className="addref" disabled={!usable.length} title={`Add the ${kind} clips selected on the canvas`} onClick={() => setInput(s.id, [...ids, ...usable].slice(0, max))}>+ selected {kind}</button>}
            </div>
            {ids.map((id, i) => { const a = assets.get(id); return a && kind === 'video' && a.width && a.height ? <div key={'p' + id + i} className="note">{propsOf(a)}</div> : null; })}
            {s.note && ids.length === 0 && <div className="note">{s.note}</div>}
          </div>
        );
      })}
      {sizeUi && <SizeChooser value={choice} onChange={setChoice} src={src} frame={frame} step={step} label="Size (sent exactly as shown)" />}
      {settings.filter((s) => !s.advanced).map((s) => (
        <div key={profile.id + s.id}>
          <SlotField slot={s as Slot} value={d.values[s.id]} onChange={(v) => setVal(s.id, v)} options={options[s.id]} saved={saved[s.id]} />
          {s.type === 'text' && s.role === 'prompt' && (
            <div className="row" style={{ margin: '4px 0' }}>
              <button disabled={enh.busy || !String(d.values.prompt ?? '').trim()} title={blocks.length || d.previous ? 'Write the action up as a full prompt for this model: the film blocks and the previous clip are carried in' : 'Write this idea up as a full prompt for the chosen model, using its guide'} onClick={enhance}>{enh.busy ? 'Writing…' : '✨ Enhance'}</button>
              {useBlocks && blocks.length > 0 && <button className="ghost" disabled={!action.trim()} title="Put the action and the film blocks together without the LLM" onClick={assemble}>Assemble</button>}
              {enh.before !== undefined && <button className="ghost" title="Go back to what you wrote" onClick={() => { set({ values: { ...d.values, prompt: enh.before, __action: undefined } }); setEnh({ busy: false, warnings: [] }); }}>Undo</button>}
              <span className="note">{useBlocks && (blocks.length || d.previous) ? 'write only the action; Enhance uses the LLM' : 'uses the LLM'}</span>
            </div>
          )}
          {s.type === 'text' && s.role === 'prompt' && enh.warnings.map((w, i) => <div key={i} className="warn">{w}</div>)}
          {s.type === 'text' && s.role === 'prompt' && enh.error && <div className="err">{enh.error}</div>}
          {s.type === 'text' && s.role === 'prompt' && useBlocks && (
            <BlocksPanel blocks={sb.blocks} source={sb.source} use={d.blockUse ?? {}} onUse={(u) => set({ blockUse: u })}
              previous={d.previous} onDropPrevious={() => set({ previous: undefined })} onSaveToStory={(id, t) => void saveBlockToStory(id, t)} />
          )}
        </div>
      ))}
      {advanced.length > 0 && (
        <details className="advanced">
          <summary title="Set once in Settings → ComfyUI; change them here for this generation only">Advanced{modelSlot ? <> · <span className="note">{shownOf(modelSlot)}</span></> : null}</summary>
          {advanced.map((s) => <div key={profile.id + s.id}><SlotField slot={s as Slot} value={d.values[s.id]} onChange={(v) => setVal(s.id, v)} options={options[s.id]} saved={saved[s.id]} /></div>)}
          <div className="note">Defaults for these live in Settings → ComfyUI.</div>
        </details>
      )}
      <div className="row" style={{ margin: '8px 0 0' }} title="How many results to make in one go, each with its own random seed (ComfyUI calls this batch size)"><span className="note">Batch size</span><input type="number" min={1} max={12} style={{ width: 64 }} value={batch} onChange={(e) => setBatch(Math.max(1, Math.min(12, Number(e.target.value) || 1)))} /></div>
      <button className="primary" onClick={go}>{batch > 1 ? `Generate ${batch}` : 'Generate'}</button>
      {sent && <div className="note">Queued. It will appear on the canvas when done.</div>}
      {error && <div className="err">{error}</div>}
    </>
  );
}

/** "960×544 · 0.52 MP · 16:9 · 4.0 s": what a model gets when this picture or clip is an input. */
const propsOf = (a: { width: number | null; height: number | null; duration_ms: number | null; kind: string }) => {
  const w = a.width!, h = a.height!; const gcd = (x: number, y: number): number => (y ? gcd(y, x % y) : x); const k = gcd(w, h);
  const ratio = w / k <= 32 && h / k <= 32 ? `${w / k}:${h / k}` : `${(w / h).toFixed(2)}:1`;
  return `${w}×${h} · ${((w * h) / 1e6).toFixed(2)} MP · ${ratio}${a.kind === 'video' && a.duration_ms ? ` · ${(a.duration_ms / 1000).toFixed(1)} s` : ''}`;
};
