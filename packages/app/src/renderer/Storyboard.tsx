import { PrepInput } from "./PrepInput.tsx";
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Cards } from './View.tsx';
import { C, api, thumbUrl, activity } from './shared.tsx';
import type { DirectorTarget, Frame, Storyboard as Board } from '../main/api.ts';

const uid = () => Math.random().toString(36).slice(2, 10);
import { splitPrompts } from './sbUtil.ts';

/**
 * The storyboard: pictures you already have, in the order you arrange them, each with your own notes.
 * Everything here works on whatever exists: describe, write prompts from notes, or let the LLM build a story from the pictures.
 */
export function Storyboard({ selectedAssets, target, notify, focus }: { selectedAssets: string[]; target?: DirectorTarget; notify: (m: string) => void; focus?: (id: string) => void }) {
  const { assets } = useContext(C);
  const [sb, setSb] = useState<Board>({ frames: [], idea: '' });
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<string[]>([]);
  const [dragI, setDragI] = useState<number | null>(null);
  /** the thumbnail whose number is being edited (type a position to move it there) */
  const [posEdit, setPosEdit] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  const [alsoFrames, setAlsoFrames] = useState(true);
  const ref = useRef(sb); ref.current = sb;
  const lock = useRef(false);   // one LLM action at a time, even for a second click before the screen updates

  const load = useCallback(async () => setSb(await api.sbGet()), []);
  useEffect(() => { void load(); }, [load]);
  const save = (next: Board) => { setSb(next); ref.current = next; void api.sbSet(next); };
  const setFrame = (id: string, patch: Partial<Frame>) => save({ ...ref.current, frames: ref.current.frames.map((f) => (f.id === id ? { ...f, ...patch } : f)) });
  const keys = sb.frames.filter((f) => f.role === 'keyframe');
  const canLast = !!target?.lastFrame;

  const addAssets = (ids: string[]) => {
    const have = new Set(ref.current.frames.map((f) => f.assetId));
    const add = ids.filter((id) => !have.has(id) && (assets.get(id)?.kind === 'image' || assets.get(id)?.kind === 'video')).map((assetId): Frame => ({ id: uid(), assetId, role: 'keyframe', note: '' }));
    if (!add.length) return notify(ids.length ? 'Those pictures are already on the storyboard.' : 'Select pictures on the canvas first (or use Add from file).');
    save({ ...ref.current, frames: [...ref.current.frames, ...add] }); notify(`Added ${add.length} picture${add.length === 1 ? '' : 's'}`);
  };
  const move = (from: number, to: number) => { if (to < 0 || to >= sb.frames.length || from === to) return; const a = [...sb.frames]; const [x] = a.splice(from, 1); a.splice(to, 0, x!); save({ ...sb, frames: a }); };

  /** Run an LLM batch: show it in the activity bar, reload the result, report what failed. */
  const run = async <T extends object>(label: string, fn: () => Promise<{ ok: true; value: T } | { ok: false; error: string }>): Promise<T | null> => {
    setBusy(label); setMsg([]); activity('storyboard', label + '…');
    try {
      const r = await fn(); await load();
      if (!r.ok) { setMsg([r.error]); return null; }
      const fl = (r.value as { failed?: string[] }).failed; if (fl?.length) setMsg(fl);
      return r.value;
    } finally { setBusy(''); activity('storyboard', null); }
  };
  const exclusive = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (lock.current) { notify('The LLM is already working. Wait for it or cancel it first.'); return undefined; }
    lock.current = true; try { return await fn(); } finally { lock.current = false; }
  };
  const describeRaw = (force = false) => run('Describing', () => api.sbDescribe(undefined, force));
  const describe = (force = false) => exclusive(() => describeRaw(force)).then((v) => v && notify(`Described ${v.done} picture${v.done === 1 ? '' : 's'}`));
  const prompts = (force: boolean) => target ? exclusive(() => run('Writing prompts', () => api.sbPrompts(undefined, target.id, force))).then((v) => v && notify(`Prompts: ${v.written} written${v.failed.length ? `, ${v.failed.length} failed` : ''}`)) : notify('Choose the video model in the box above first.');
  /** Describe what is missing and write the story (the action of each shot). It stops there so the story can be read and edited before any prompt is written. */
  const build = () => exclusive(async () => {
    if (!keys.length) return notify('Add pictures first.');
    if (keys.some((f) => f.note.trim() && !f.auto) && !window.confirm('Your own notes are kept. The LLM only writes the action for pictures without a note. Continue?')) return;
    if (keys.some((f) => !f.description) && !(await describeRaw().then((v) => v && true))) return;
    const s = await run('Building the story', () => api.sbStory()); if (!s) return;
    if (canLast) save({ ...ref.current, frames: ref.current.frames.map((f, i, a) => (f.role === 'keyframe' && a.slice(i + 1).some((x) => x.role === 'keyframe') ? { ...f, chain: true } : f)) });
    notify(`Story written: ${s.filled} action${s.filled === 1 ? '' : 's'}. Read and edit them below, then press Write prompts.`);
  });

  const rewriteOne = (id: string) => target ? exclusive(() => run('Writing the prompt', () => api.sbPrompts([id], target.id, true))).then((v) => v && notify(v.written ? 'Prompt rewritten' : 'Could not write it')) : notify('Choose the video model first.');
  const describeOne = (id: string) => exclusive(() => run('Describing', () => api.sbDescribe([id], true))).then((v) => v && notify('Described again'));
  const toPos = (id: string, text: string) => { setPosEdit(null); const n = Math.round(Number(text)); if (!Number.isFinite(n)) return; const from = ref.current.frames.findIndex((x) => x.id === id); move(from, Math.max(1, Math.min(ref.current.frames.length, n)) - 1); };
  const toStory = async () => { const r = await api.sbToStory('Storyboard'); notify(`Story: ${r.shots} shots added in a new scene "Storyboard". Run them from the Story tab.`); };
  const importPrompts = async () => {
    const list = splitPrompts(pasted); if (!list.length) return notify('Paste prompts first (separate them with a blank line, or number them).');
    const r = await api.promptsToStory(list, 'Imported prompts', alsoFrames && keys.length > 0);
    notify(`Story: ${r.shots} shots with your prompts${alsoFrames && keys.length ? `, the first ${Math.min(keys.length, r.shots)} start from your pictures` : ''}`); setPasted('');
  };
  const assignPrompts = () => {
    const list = splitPrompts(pasted); if (!list.length) return notify('Paste prompts first.');
    let n = 0; const frames = ref.current.frames.map((f) => (f.role === 'keyframe' && list[n] !== undefined ? { ...f, prompt: list[n++] } : f));
    save({ ...ref.current, frames }); notify(`${n} prompt${n === 1 ? '' : 's'} put on the pictures in order${list.length > n ? ` (${list.length - n} left over)` : ''}`); setPasted('');
  };

  return (
    <>
      <div className="note">Your pictures in shot order. Add notes if you like, build the story, read it, then write the prompts.</div>
      <div className="row" style={{ margin: '8px 0', flexWrap: 'wrap' }}>
        <button className="primary-sm" title="Add the pictures selected on the canvas, in the order you selected them" onClick={() => addAssets(selectedAssets)}>+ Selected on canvas{selectedAssets.length ? ` (${selectedAssets.length})` : ''}</button>
        <button onClick={async () => { const a = await api.importAssets(); if (a.length) addAssets(a.map((x) => x.id)); }}>+ From file…</button>
        <button disabled={!sb.frames.length} title="Remove every picture from the storyboard (they stay in the Library)" onClick={() => { if (window.confirm('Remove every picture from the storyboard? The pictures themselves stay in the Library.')) save({ ...sb, frames: [] }); }}>Clear pictures</button>
        <button disabled={!sb.frames.some((f) => f.prompt)} title="Empty every prompt; pictures, notes and the story stay" onClick={() => { if (window.confirm('Clear all prompts? Pictures, notes and the story stay.')) save({ ...sb, frames: sb.frames.map((f) => ({ ...f, prompt: undefined, warnings: undefined })) }); }}>Clear prompts</button>
        <button disabled={!sb.frames.some((f) => f.note || f.description)} title="Empty every note and description (and the prompts written from them); pictures stay" onClick={() => { if (window.confirm('Clear all notes, descriptions and prompts? Pictures stay.')) save({ ...sb, frames: sb.frames.map((f) => ({ ...f, note: '', auto: false, description: undefined, prompt: undefined, warnings: undefined })) }); }}>Clear story</button>
      </div>
      <label>What is the story? (optional: a sentence or two helps the LLM)</label>
      <textarea style={{ minHeight: 50 }} defaultValue={sb.idea} key={'idea' + sb.idea} onBlur={(e) => e.target.value !== sb.idea && save({ ...sb, idea: e.target.value })} placeholder="e.g. A girl finds a letter, follows it to the lighthouse and meets her grandfather." />

      {sb.frames.length > 0 && <div className="sbGrid">
        {sb.frames.map((f, i) => (
          <div key={f.id} className={'sbThumb' + (f.role === 'reference' ? ' ref' : '') + (dragI === i ? ' drag' : '')} draggable onDragStart={() => setDragI(i)} onDragOver={(e) => e.preventDefault()} onDrop={() => { if (dragI !== null) move(dragI, i); setDragI(null); }} onDragEnd={() => setDragI(null)} title="Drag to reorder">
            <img src={thumbUrl(f.assetId)} draggable={false} /><PrepInput id={f.assetId} selected={selectedAssets} onReplace={(n) => save({ ...sb, frames: sb.frames.map((x) => (x.id === f.id ? { ...x, assetId: n } : x)) })} />{posEdit === f.id ? <input className="posIn" autoFocus defaultValue={i + 1} onFocus={(e) => e.target.select()} onBlur={(e) => toPos(f.id, e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setPosEdit(null); }} /> : <span className="badge" title="Click and type a position to move this picture there" onClick={() => setPosEdit(f.id)}>{f.role === 'reference' ? 'ref' : keys.indexOf(f) + 1}</span>}{i > 0 && <button className="toFront" title="Move to the front" onClick={() => move(i, 0)}>⇤</button>}
            {f.chain && f.role === 'keyframe' && <i className="chainMark" title="Its last frame is the next picture">→</i>}
          </div>
        ))}
      </div>}

      <div className="row" style={{ margin: '8px 0', flexWrap: 'wrap' }}>
        <button className={keys.some((f) => f.note.trim()) ? '' : 'primary-sm'} disabled={!!busy || !keys.length} title="The LLM describes each picture and writes what happens in each shot you have no note for. Nothing else: prompts come next, after you have read it." onClick={() => void build()}>1 · Build the story</button>
        <button className={keys.some((f) => f.note.trim()) ? 'primary-sm' : ''} disabled={!!busy || !keys.length} title="Write the prompt of every shot that has none, from the notes" onClick={() => void prompts(false)}>2 · Write prompts</button>
        <button className="ghost" disabled={!!busy || !keys.some((f) => f.prompt)} title="Write every prompt again, including edited ones" onClick={() => { if (window.confirm('Write every prompt again? Prompts you edited are replaced.')) void prompts(true); }}>Rewrite all</button>
      </div>
      {canLast && keys.length > 1 && <div className="row" style={{ margin: '4px 0' }}>
        <button className="ghost" onClick={() => save({ ...sb, frames: sb.frames.map((f, i, a) => (f.role === 'keyframe' && a.slice(i + 1).some((x) => x.role === 'keyframe') ? { ...f, chain: true } : f)) })}>Chain every shot to the next picture</button>
        <button className="ghost" onClick={() => save({ ...sb, frames: sb.frames.map((f) => ({ ...f, chain: false })) })}>Unchain all</button>
        <span className="note">chained: each clip starts at its picture and ends at the next one</span></div>}
      {busy && <div className="card working"><div className="row"><span className="spin" /><b>{busy}…</b></div><div className="bar indet"><div /></div><button onClick={() => api.llmCancel()}>Cancel</button></div>}
      {msg.map((m, i) => <div key={i} className="warn">{m}</div>)}

      <Cards>{sb.frames.map((f, i) => {
        const k = keys.indexOf(f), next = keys[k + 1];
        return (
          <div className="card sbCard vcard" key={f.id}>
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <img className="sbPic" src={thumbUrl(f.assetId)} onClick={() => focus?.(f.assetId)} title="Show on the canvas" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row" style={{ flexWrap: 'wrap' }}>
                  <input type="text" style={{ width: 120 }} key={f.id + (f.name ?? '')} defaultValue={f.name ?? ''} placeholder={f.role === 'reference' ? 'Reference' : `Shot ${k + 1}`} title="Name of this shot (editable)" onBlur={(e) => e.target.value !== (f.name ?? '') && setFrame(f.id, { name: e.target.value })} />
                  <select style={{ width: 'auto' }} value={f.role} title="A reference picture is not a shot: it only tells the LLM how things should look" onChange={(e) => setFrame(f.id, { role: e.target.value as Frame['role'] })}><option value="keyframe">shot (starts here)</option><option value="reference">reference only</option></select>
                  {f.role === 'keyframe' && target && <select style={{ width: 'auto' }} value={f.seconds ?? ''} title="Length of this shot" onChange={(e) => setFrame(f.id, { seconds: e.target.value ? Number(e.target.value) : undefined })}><option value="">length: auto</option>{target.seconds.map((n) => <option key={n} value={n}>{n}s</option>)}</select>}
                  <span className="sp" />
                  <button className="ghost" disabled={i === 0} onClick={() => move(i, i - 1)}>↑</button>
                  <button className="ghost" disabled={i === sb.frames.length - 1} onClick={() => move(i, i + 1)}>↓</button>
                  <button className="ghost" title="Remove from the storyboard" onClick={() => save({ ...sb, frames: sb.frames.filter((x) => x.id !== f.id) })}>✕</button>
                </div>
                <textarea style={{ minHeight: 48 }} key={f.id + f.note} defaultValue={f.note} placeholder={f.role === 'reference' ? 'What should the LLM take from this picture? (optional)' : 'Your notes for this shot, casual is fine. Leave empty to let the LLM decide.'} onBlur={(e) => e.target.value !== f.note && setFrame(f.id, { note: e.target.value, auto: false })} />
                {f.auto && f.note && <div className="row"><span className="note">written by the LLM: edit it to make it yours</span><button className="ghost" onClick={() => setFrame(f.id, { note: '', auto: false })}>Clear</button></div>}
              </div>
            </div>
            {f.role === 'keyframe' && canLast && next && <label className="row" style={{ margin: '4px 0', color: 'var(--text)' }}><input type="checkbox" checked={!!f.chain} onChange={(e) => setFrame(f.id, { chain: e.target.checked })} />Ends at the next picture (last frame)</label>}
            <details><summary className="note">What the LLM sees{f.description ? '' : ' (not described yet)'}</summary>
              <textarea style={{ minHeight: 50 }} key={f.id + (f.description ?? '')} defaultValue={f.description ?? ''} placeholder="Write what the picture shows if the LLM got it wrong" onBlur={(e) => e.target.value !== (f.description ?? '') && setFrame(f.id, { description: e.target.value })} />
              <button className="ghost" disabled={!!busy} title="The LLM looks at this picture again" onClick={() => void describeOne(f.id)}>Describe again</button></details>
            {f.role === 'keyframe' && <>
              <div className="row" style={{ margin: '4px 0' }}><label style={{ margin: 0 }}>Prompt {f.prompt ? '' : <span className="note">(not written yet)</span>}</label><span className="sp" />{f.prompt && <button className="ghost" title="Empty this prompt" onClick={() => setFrame(f.id, { prompt: undefined, warnings: undefined })}>Clear</button>}<button className="ghost" disabled={!!busy} title="Write only this prompt again from its note and what the LLM sees" onClick={() => void rewriteOne(f.id)}>{f.prompt ? 'Rewrite this prompt ↻' : 'Write this prompt'}</button></div>
              <textarea style={{ minHeight: 70 }} key={f.id + (f.prompt ?? '')} defaultValue={f.prompt ?? ''} onBlur={(e) => e.target.value !== (f.prompt ?? '') && setFrame(f.id, { prompt: e.target.value })} />
              {f.warnings?.map((w, j) => <div key={j} className="warn">{w}</div>)}
            </>}
          </div>
        );
      })}</Cards>
      {!sb.frames.length && <div className="empty">Select pictures on the canvas and press “+ Selected on canvas”, or add files.</div>}
      {keys.length > 0 && <div className="row" style={{ margin: '8px 0' }}><button className="primary" onClick={() => void toStory()}>Send {keys.length} shot{keys.length === 1 ? '' : 's'} to the Story tab →</button></div>}

      <h2 style={{ marginTop: 14 }}>Prompts you already have</h2>
      <div className="note">Paste prompts, one per shot (blank line between them, or numbered). They are used exactly as written.</div>
      <textarea style={{ minHeight: 100 }} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder={'1. A girl opens a letter…\n\n2. She walks along the cliff…'} />
      <div className="row" style={{ margin: '6px 0', flexWrap: 'wrap' }}>
        <button disabled={!pasted.trim()} onClick={() => void importPrompts()}>Make shots in the Story tab</button>
        <label className="row" style={{ margin: 0, color: 'var(--text)' }}><input type="checkbox" checked={alsoFrames} onChange={(e) => setAlsoFrames(e.target.checked)} />start from my pictures in order</label>
        <button disabled={!pasted.trim() || !keys.length} title="Put the first prompt on the first picture, and so on" onClick={assignPrompts}>Put on the pictures above</button>
      </div>
    </>
  );
}
