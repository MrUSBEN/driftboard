import { PrepInput } from './PrepInput.tsx';
import { useContext, useEffect, useRef, useState } from 'react';
import { C, api, thumbUrl } from './shared.tsx';
import { Storyboard } from './Storyboard.tsx';
import { SizeChooser, resolveSize, sizeInfo, useSizeChoice, withSize, type SizeChoice } from './size.tsx';
import { Cards } from './View.tsx';
import { tellUser } from './Ask.tsx';
import type { ElementGen } from '@driftboard/director';
import type { DirectorState } from '../main/api.ts';
import { useDirector, setDirector, updDirector, runStep, interpretScript, loadDirector, directorNow } from './directorStore.ts';
import { Icon } from './ui/Icon.tsx';
import { Button, Chip, Field, IconButton, Notice, Stepper, Tile } from './ui/ui.tsx';
import { FilmBlocksCard } from './FilmBlocksCard.tsx';
import { ShotFrames } from './ShotFrames.tsx';
import type { Draft } from './shared.tsx';

type Bible = NonNullable<DirectorState['bible']>;
type Kind = 'characters' | 'places' | 'props';
export type PlanStage = 'script' | 'bible' | 'board';

/**
 * The plan stages of a story: Script (the text, interpreted and checked), Bible (characters, places, props with
 * reference pictures, and the story's film blocks) and Board (the storyboard pictures). They all edit the story plan
 * (directorStore); the plan reaches the story's shots by itself.
 */
export function DirectorStage({ stage, storyId, selectedAssets, notify, focus, goShots, openDraft }: { stage: PlanStage; storyId: string; selectedAssets: string[]; notify: (m: string) => void; focus?: (id: string) => void; goShots: () => void; openDraft?: (d: Draft) => void }) {
  /** A new script starts the plan over, and the plan forgets which story it belongs to: link it again, or nothing would reach the story. */
  const keepLink = async (s: DirectorState, name?: string) => (s.storyId === storyId ? s : api.directorUpdate({ storyId, name: s.name || name }));
  const { profiles, film, story } = useContext(C);
  const { st, targets } = useDirector();
  const imageProfile = profiles.find((p) => p.kind === 'image' && p.slots.some((s) => s.role === 'prompt' && s.type === 'text') && !p.slots.some((s) => s.type === 'image_list')) ?? profiles.find((p) => p.kind === 'image');
  const [err, setErr] = useState('');
  // output settings per category: characters are portraits, places are wide, props are square
  const [sizeChars, setSizeChars] = useSizeChoice('bible-characters', 'character');
  const [sizePlaces, setSizePlaces] = useSizeChoice('bible-places', 'wide');
  const [sizeProps, setSizeProps] = useSizeChoice('bible-props', 'square');
  const [batchN, setBatchN] = useState<Record<Kind, number>>({ characters: 1, places: 1, props: 1 });
  const [text, setText] = useState('');
  const [interp, setInterp] = useState('');
  const [missing, setMissing] = useState<{ speaker: string; line: string; saidBy?: string }[]>([]);
  const [boardN, setBoardN] = useState<number | null>(null);   // pictures on the Board: tells which way this story was started
  useEffect(() => { void api.sbGet().then((b) => setBoardN(b.frames.length)); }, [stage, storyId]);
  useEffect(() => { if (st) setText((t) => t || st.scriptText); }, [st?.scriptText]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setInterp(st?.interpreted ?? ''); if (st?.interpreted) void api.directorMissing(st.scriptText, st.interpreted).then(setMissing); else setMissing([]); }, [st?.interpreted]);   // eslint-disable-line react-hooks/exhaustive-deps

  const [planning, setPlanning] = useState(false);
  const [autoPics, setAutoPics] = useState(() => { try { return localStorage.getItem('driftboard.bibleAutoPics') !== '0'; } catch { return true; } });
  const setAuto = (v: boolean) => { setAutoPics(v); try { localStorage.setItem('driftboard.bibleAutoPics', v ? '1' : '0'); } catch { /* ignore */ } };

  if (!st) return <div className="pb"><span className="spin" /></div>;
  const target = targets.find((t) => t.id === st.targetId) ?? targets[0];
  const run = async (s: 'bible' | 'scenes' | 'shots' | 'prompts') => {
    const e = await runStep(s); setErr(e);
    if (s === 'bible' && !e && autoPics) await makeMissing();   // casting: every character, place and prop gets a reference picture
  };
  /** Generate reference pictures for one element with the image model; when the first one is done it becomes the element's picture (all of them land on the canvas). The main process assigns it, so it arrives even if this stage is closed. */
  const makePicture = async (kind: Kind, id: string, prompt: string, choice: SizeChoice, count: number, quiet = false) => {
    if (!imageProfile) return;
    const si = sizeInfo(imageProfile); const batch = Math.random().toString(36).slice(2);
    for (let k = 0; k < Math.max(1, count); k++) {
      const base: Record<string, unknown> = si.ok ? withSize({ prompt }, resolveSize(choice, film, null, si.step)) : { prompt };
      if (k > 0 && imageProfile.slots.some((q) => q.role === 'seed')) base.seed = Math.floor(Math.random() * 2 ** 31);
      const r = await api.bibleRefMake(imageProfile.id, base, kind, id, batch);
      if (!r.ok) { notify(r.error); return; }
    }
    if (!quiet) notify(`Generating ${count > 1 ? count + ' pictures' : 'a picture'}… the first one becomes the reference when done`);
  };
  /** A picture for every character, place and prop that has none, each with its own or its category's size and count. */
  const makeMissing = async () => {
    const b = directorNow()?.bible; if (!b || !imageProfile) return;
    const sizes = { characters: sizeChars, places: sizePlaces, props: sizeProps };
    let n = 0;
    for (const K of KINDS) for (const c of (b[K.k] ?? []) as El[]) if (!c.refAsset) { await makePicture(K.k, c.id, K.prompt(b.style, c.look), (c.gen?.size as SizeChoice | undefined) ?? sizes[K.k], c.gen?.batch ?? batchN[K.k], true); n++; }
    if (n) notify(`Making reference pictures for ${n} character${n === 1 ? '' : 's'}, places and props… each becomes the reference when done. Check them in the Bible.`);
  };
  const errBox = err ? <Notice tone="bad"><span>{err}</span><span>Check that the LLM server is running (top bar), then try again.</span></Notice> : null;

  const fromPictures = !!boardN && !st.parsed;
  const planned = story.all.some((t) => t.scene.storyId === storyId && t.shots.some((s) => s.brief));
  const pictureNote = fromPictures && <Notice><b>This story is being made from pictures on the Board.</b><span>Script and Bible are for starting from text: an idea or a script becomes a bible (characters, places, props) and then shots. You do not need them for a storyboard; the Board describes your pictures, builds the story and writes the prompts. You can still use the Bible to keep reference pictures of your characters.</span></Notice>;

  if (stage === 'script') return (
    <div className="stageBody">
      {errBox}
      {pictureNote}
      <Field label="Idea or script (Fountain or plain text)">
        <textarea className="ta" style={{ minHeight: 220 }} value={text} onChange={(e) => setText(e.target.value)} placeholder={'INT. KITCHEN - NIGHT\n\nELSA sets a bag on the table.\n\nJONAH\nYou came back.'} />
      </Field>
      <Field label="Look and style (optional)" hint="A hint for the bible: it becomes the story's Film look block, which you can edit there.">
        <input className="inp" value={st.style} onChange={(e) => setDirector({ ...st, style: e.target.value })} placeholder="e.g. 35mm film, warm tungsten, muted colours" />
      </Field>
      <div className="row wrap">
        <Button kind="primary" icon="wand" disabled={!text.trim()} title="The LLM rewrites your text as a clean script (scenes, places, action, dialogue). You check and edit it before anything is built from it." onClick={async () => setErr(await interpretScript(text))}>Interpret</Button>
        <Button disabled={!text.trim()} title="Use the text exactly as written (needs scene headings and CHARACTER cues to be read as a script; otherwise the LLM splits it into scenes)" onClick={async () => { const name = st.name; setDirector(await keepLink(await api.directorSetScript(text, st.style), name)); }}>Use as written</Button>
        <Button kind="quiet" icon="import" onClick={async () => { const t = await api.directorImportFile(); if (t) setText(t); }}>Import file…</Button>
      </div>
      {st.interpreted !== undefined && <div className="dcard" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="h3">Check the script</div>
        <span className="small dim">The LLM rewrote your text as a script. Check that nothing of yours is lost or changed, edit anything, then use it. Scenes, places, characters and dialogue are taken from it exactly.</span>
        {missing.length > 0 && <Notice tone="warn"><b>Lines you wrote that are lost or changed here (fix them below):</b>{missing.map((m, i) => <span key={i}>{m.speaker}: “{m.line}”{m.saidBy ? ` (the script gives it to ${m.saidBy})` : ' (missing)'}</span>)}</Notice>}
        <div className="scriptCheck">
          <div><span className="lbl">What you wrote</span><div className="srcText">{st.scriptText}</div></div>
          <div><span className="lbl">As a script</span><textarea className="ta mono" style={{ minHeight: 280 }} value={interp} onChange={(e) => setInterp(e.target.value)} onBlur={async () => { if (interp !== (st.interpreted ?? '')) setDirector(await api.directorSetInterpreted(interp)); setMissing(await api.directorMissing(st.scriptText, interp)); }} /></div>
        </div>
        <div className="row">
          <Button kind="primary" disabled={!interp.trim()} onClick={async () => { if (interp !== (st.interpreted ?? '')) await api.directorSetInterpreted(interp); setDirector(await keepLink(await api.directorUseInterpreted(), st.name)); notify('Using this script. Next: the Bible.'); }}>Use this script</Button>
          {st.parsed && st.parsed.text.trim() === interp.trim() ? <Chip tone="ok" icon="check">in use</Chip> : <span className="xs dim">not in use yet: the bible, scenes and shots are built from the script in use.</span>}
        </div>
      </div>}
      {st.parsed && <Notice><span>{st.parsed.mode === 'screenplay' ? `Screenplay: ${st.parsed.scenes.length} scenes` : 'Loose story: the LLM plans the scenes in Shots'} · characters: {st.parsed.characters.join(', ') || 'none found'}</span>
        <div className="row"><Button size="sm" onClick={() => void run('bible')}>Write the bible</Button><Button size="sm" kind="quiet" onClick={goShots}>Go to Shots</Button></div></Notice>}
    </div>
  );

  if (stage === 'board') return (
    <div className="stageBody">
      {errBox}
      {planned ? <>
        <ShotFrames storyId={storyId} selectedAssets={selectedAssets} notify={notify} openDraft={openDraft} goShots={goShots} />
        <details className="card"><summary className="small dim">Start from your own pictures instead (picture storyboard{boardN ? `, ${boardN} on it` : ''})</summary>
          <Storyboard selectedAssets={selectedAssets} target={target} notify={notify} focus={focus} storyId={storyId} goShots={goShots} /></details>
      </> : <>
        {st.parsed && <Notice><b>Storyboard frames come from the planned shots: one frame per cut.</b><span>Plan the shots now (the LLM splits each scene into shots; you can check them in Shots), and the frames are made here. Or, below, make a story from pictures you already have.</span>
          <div className="row"><Button size="sm" kind="primary" icon="wand" disabled={planning} onClick={async () => { setPlanning(true); try { if (st.parsed!.mode !== 'screenplay' && !st.scenes?.length) { const e = await runStep('scenes'); if (e) { setErr(e); return; } } setErr(await runStep('shots')); } finally { setPlanning(false); } }}>{planning ? 'Planning the shots…' : 'Plan the shots'}</Button>{planning && <span className="spin" />}</div></Notice>}
        <Storyboard selectedAssets={selectedAssets} target={target} notify={notify} focus={focus} storyId={storyId} goShots={goShots} />
      </>}
    </div>
  );

  // bible
  return (
    <div className="stageBody">
      {errBox}
      {pictureNote || (!st.parsed && <Notice>No script yet: the LLM writes the bible from the script. You can still add characters, places and props by hand.</Notice>)}
      <div className="row wrap">
        <Button kind="primary" icon="wand" disabled={!st.parsed} onClick={() => void run('bible')}>{st.bible ? 'Rewrite the bible' : 'Write the bible'}</Button>
        {imageProfile && <label className="check" title={`After the bible is written, ${imageProfile.title} makes a reference picture for every character, place and prop that has none. You can regenerate or replace any of them.`}><input type="checkbox" checked={autoPics} onChange={(e) => setAuto(e.target.checked)} />Also make the reference pictures</label>}
      </div>
      {st.log.length > 0 && <Notice tone="warn">{st.log.map((w, i) => <span key={i}>{w}</span>)}</Notice>}
      <FilmBlocksCard storyId={storyId} notify={notify} open />
      <BibleEditor bible={st.bible ?? { style: st.style, characters: [], places: [] }} onChange={(b) => void updDirector({ bible: b })} selectedAssets={selectedAssets}
        gen={imageProfile ? { title: imageProfile.title, step: sizeInfo(imageProfile).ok ? sizeInfo(imageProfile).step : null, sizes: { characters: sizeChars, places: sizePlaces, props: sizeProps }, setSize: (k: Kind, c: SizeChoice) => (k === 'characters' ? setSizeChars : k === 'places' ? setSizePlaces : setSizeProps)(c), batches: batchN, setBatch: (k: Kind, n: number) => setBatchN((b) => ({ ...b, [k]: n })), make: makePicture } : null} />
    </div>
  );
}
/** Load the plan once (the workspace calls this after opening a story's run). */
export const reloadPlan = loadDirector;

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
      {KINDS.map((K) => (
        <div key={K.k}>
          <div className="row" style={{ marginTop: 12 }}><Icon name={K.k === 'characters' ? 'person' : K.k === 'places' ? 'place' : 'prop'} /><h3 className="h3" style={{ flex: 1 }}>{K.title} <span className="faint xs">{list(K.k).length}</span></h3>
            <Button size="sm" icon="plus" title={`Add a ${K.one} by hand`} onClick={() => setList(K.k, [...list(K.k), { id: `${K.one[0]}${Date.now().toString(36)}`, name: `New ${K.one}`, look: '' }])}>{K.one[0]!.toUpperCase() + K.one.slice(1)}</Button></div>
          {gen && <div className="dcard" style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <b className="small">Reference pictures for all {K.k}</b>
            {gen.step !== null && <SizeChooser value={gen.sizes[K.k]} onChange={(c) => gen.setSize(K.k, c)} step={gen.step} label={`Picture size (every ${K.one} without its own setting)`} />}
            <div className="row" style={{ flexWrap: 'wrap' }}><span className="lbl">Pictures per {K.one}</span><Stepper value={gen.batches[K.k]} onChange={(n) => gen.setBatch(K.k, n)} label="Results" title="How many pictures are made per click, each with a new seed. The first becomes the reference, the others stay on the canvas." /><span className="xs faint">with {gen.title}</span>
              {(() => { const missing = list(K.k).filter((x) => !x.refAsset); return <Button size="sm" icon="create" disabled={!missing.length} title={`Make a picture for every ${K.one} that has none`} onClick={async () => { for (const c of missing) await gen.make(K.k, c.id, K.prompt(bible.style, c.look), (c.gen?.size as SizeChoice | undefined) ?? gen.sizes[K.k], c.gen?.batch ?? gen.batches[K.k]); }}>Make the missing pictures ({missing.length})</Button>; })()}</div>
          </div>}
          {!list(K.k).length && <div className="xs faint">{K.k === 'props' ? 'Add anything the film needs a reference picture for: an object, a vehicle, a costume, a creature.' : `No ${K.k} yet.`}</div>}
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
    <div className="dcard vcard bibleCard" style={{ position: 'relative' }}>
      <IconButton size="sm" className="cardX" icon="x" label={`Remove this ${kind} (Undo brings it back)`} onClick={onRemove} />
      {el.refAsset ? <Tile src={thumbUrl(el.refAsset)} big style={{ aspectRatio: kind === 'character' ? '2 / 3' : '16 / 9.2' }}><PrepInput id={el.refAsset} selected={selectedAssets} onReplace={(n) => onSet({ refAsset: n })} /></Tile>
        : <div className="tile big noPic" style={{ aspectRatio: kind === 'character' ? '2 / 3' : '16 / 9.2' }}><Icon name={kind === 'character' ? 'person' : kind === 'place' ? 'place' : 'prop'} size="l" /></div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <input className="inp nameIn" defaultValue={el.name} key={el.id + el.name} aria-label="Name" title="Name (editable)" onBlur={(e) => e.target.value !== el.name && onSet({ name: e.target.value })} />
      <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
        {gen && size && <Button size="sm" icon="create" title={`Make ${n > 1 ? n + ' pictures' : 'a picture'} of this ${kind} with ${gen.title}`} onClick={() => void make(size, n)}>{el.refAsset ? 'Generate again' : 'Generate'}{n > 1 ? ` ×${n}` : ''}</Button>}
        <Button size="sm" disabled={!selectedAssets.length} title={`Use the image selected on the canvas as this ${kind}'s reference picture`} onClick={() => onSet({ refAsset: selectedAssets[selectedAssets.length - 1] })}>{el.refAsset ? 'Change picture' : 'From selection'}</Button>
        {el.refAsset && <button type="button" className="btn sm" disabled={reading} title="The vision LLM describes this picture and proposes it as the written look, so text and picture agree. You decide whether to use it." onClick={async () => { setReading(true); const r = await api.llmReadLook(el.refAsset!, kind as 'character' | 'place' | 'prop'); setReading(false); if (r.ok) setProposal(r.look); else void tellUser('Could not read the picture', `${r.error}

Check that the LLM in Settings › LLM is running and can see pictures (a vision model), then try again.`); }}>{reading ? 'Reading…' : 'Read the picture'}</button>}
        {el.refAsset && <Button size="sm" kind="quiet" title="Take the reference picture off (the picture itself stays in the Library)" onClick={() => onSet({ refAsset: undefined })}>Remove picture</Button>}
        {gen && <Button size="sm" kind="quiet" icon="settings" on={!!(own.size || own.batch)} title="Output settings of this card" onClick={() => setOpen(!open)}>{own.size || own.batch ? 'Own settings' : 'Settings'}</Button>}
      </div>
      {kind === 'character' && <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
        <span className="lbl">Voice</span>
        {el.voiceAsset ? <Chip icon="sound" title="This sample goes along wherever this character's picture is sent, to keep the voice the same" onRemove={() => onSet({ voiceAsset: undefined })} removeLabel="Remove the voice sample">sample</Chip> : <span className="xs faint">no sample</span>}
        <Button size="sm" kind="quiet" disabled={!voicePick} title={voicePick ? "Use the sound selected on the canvas as this character's voice sample" : 'Select a sound on the canvas first'} onClick={() => onSet({ voiceAsset: voicePick })}>{el.voiceAsset ? 'Change voice sample' : 'Voice from selection'}</Button>
      </div>}
      {open && gen && gen.step !== null && <div className="sizeBox">
        <label className="check"><input type="checkbox" checked={!!own.size} onChange={(e) => onSet({ gen: { ...own, size: e.target.checked ? gen.sizes[cat] : undefined } })} />Own size for this {kind}</label>
        {own.size && <SizeChooser value={own.size as SizeChoice} onChange={(c) => onSet({ gen: { ...own, size: c } })} step={gen.step} label={`Size of this ${kind}'s pictures`} />}
        <div className="row"><label className="check"><input type="checkbox" checked={own.batch !== undefined} onChange={(e) => onSet({ gen: { ...own, batch: e.target.checked ? gen.batches[cat] : undefined } })} />Own number of pictures</label>
          {own.batch !== undefined && <Stepper size="sm" value={own.batch} onChange={(v) => onSet({ gen: { ...own, batch: v } })} label="Results" />}</div>
      </div>}
      {proposal !== null && <Notice><b>What the picture shows:</b><span>{proposal}</span><div className="row"><Button size="sm" kind="primary" onClick={() => { onSet({ look: proposal }); setProposal(null); }}>Use as the look</Button><Button size="sm" kind="quiet" onClick={() => setProposal(null)}>Keep mine</Button></div></Notice>}
      <textarea className="ta" style={{ minHeight: 70 }} defaultValue={el.look} key={el.id + 'l' + el.look} aria-label={`How this ${kind} looks`} placeholder={`How this ${kind} looks (visual details only)`} onBlur={(e) => e.target.value !== el.look && onSet({ look: e.target.value })} />
      <div className="xs faint">{el.look.trim().split(/\s+/).filter(Boolean).length} words</div>
      </div>
    </div>
  );
}
