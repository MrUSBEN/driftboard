import { useContext, useEffect, useRef, useState } from 'react';
import { C, api, autoAssign, imageSlots, thumbUrl, valuesOfDraft, type Draft } from './shared.tsx';
import { resolveSize, sizeInfo, withSize } from './size.tsx';
import { Icon } from './ui/Icon.tsx';
import { Button, Notice, Popover, Spinner, Tile } from './ui/ui.tsx';

/** "1024×576 · 0.59 MP" for a picture's size, or '' when it is not known. */
export const sizeText = (a?: { width: number | null; height: number | null }) => (a?.width && a.height ? `${a.width}×${a.height} · ${((a.width * a.height) / 1e6).toFixed(2)} MP` : '');

/** What the image model is asked to do by default when a picture is enhanced; the form lets you change it, and your change is remembered. */
export const ENHANCE_PROMPT = 'Make the image high resolution: restore sharp fine detail, clean lines and crisp textures. Keep the composition, the people, their clothes, the colours and the light exactly the same.';
const loadPrompt = () => { try { return localStorage.getItem('driftboard.enhancePrompt') || ENHANCE_PROMPT; } catch { return ENHANCE_PROMPT; } };

/**
 * The "prepare this input" button every picture input has (Generate slots, story shot inputs, Assistant attachments, Storyboard...):
 * shows the real size, upscales to a chosen size, edits with an image model, or swaps in the picture selected on the canvas.
 * The original asset is never changed: every option makes a new asset and calls onReplace with it.
 * `targetMp` (the size the generation will run at) marks inputs that are smaller than that.
 */
export function PrepInput({ id, onReplace, selected, openDraft, targetMp }: { id: string; onReplace: (newId: string) => void; selected?: string[]; openDraft?: (d: Draft) => void; targetMp?: number }) {
  const { assets, profiles } = useContext(C);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [form, setForm] = useState(false);
  const [prompt, setPrompt] = useState(loadPrompt);
  const [outMp, setOutMp] = useState<number | 'same'>('same');
  const [job, setJob] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const a = assets.get(id);
  if (!a || a.kind !== 'image') return null;
  const mp = a.width && a.height ? (a.width * a.height) / 1e6 : 0;
  const small = !!targetMp && mp > 0 && mp < targetMp * 0.9;
  const editor = profiles.find((p) => p.kind === 'image' && imageSlots(p).length > 0 && p.slots.some((s) => s.role === 'prompt'));
  const swap = (selected ?? []).find((x) => x !== id && assets.get(x)?.kind === 'image');
  /** A new picture at about `toMp` megapixels, ratio kept: upscaled (Lanczos) when bigger, scaled down when smaller. */
  const upscale = async (toMp: number) => {
    const down = toMp < mp;
    setBusy(`${down ? 'Scaling down' : 'Upscaling'} to ${toMp} MP…`); setErr('');
    const r = await api.mediaEdit(id, down ? { op: 'resize', scale: Math.sqrt(toMp / mp) } : { op: 'upscale', toMp });
    setBusy('');
    if (r.ok) { setAnchor(null); onReplace(r.assetId); } else setErr(r.error);
  };
  /** Run the image-edit model on this picture with the (editable) prompt and wait for its result, which replaces the picture. */
  const enhance = async () => {
    if (!editor) return;
    setErr(''); try { localStorage.setItem('driftboard.enhancePrompt', prompt); } catch { /* ignore */ }
    const d: Draft = { profileId: editor.id, values: { prompt }, inputs: autoAssign(editor, [id]), title: 'Enhance picture' };
    let values = valuesOfDraft(editor, d); delete values.__match; delete values.__size; delete values.__action;
    const si = sizeInfo(editor);
    if (si.ok) { try { values = withSize(values, resolveSize({ purpose: outMp === 'same' ? 'same' : 'match', mp: outMp === 'same' ? undefined : outMp }, { aspect: '16:9', mp: 1, seconds: 5 }, a, si.step)); } catch { /* the model's own size */ } }
    values.seed = Math.floor(Math.random() * 2 ** 31);
    setBusy('Enhancing with the image model…');
    const r = await api.generate(editor.id, values, undefined, undefined, { ignoreWarnings: true });
    if (!r.ok) { setBusy(''); return setErr(r.error); }
    setJob(r.job.id);
    const off = api.onJob((j) => {
      if (j.id !== r.job.id) return;
      if (j.status === 'done' && j.outputs[0]) { off(); setBusy(''); setJob(null); if (alive.current) { setForm(false); setAnchor(null); } onReplace(j.outputs[0].assetId); }
      else if (j.status === 'failed' || j.status === 'cancelled') { off(); setBusy(''); setJob(null); if (alive.current) setErr(j.error || 'The edit did not finish.'); }
    });
  };
  const sizes = [...new Set([0.25, 0.5, 1, 2, ...(targetMp ? [Math.round(targetMp * 100) / 100] : [])])].sort((x, y) => x - y);
  return (
    <span className="prep" onClick={(e) => e.stopPropagation()}>
      <button type="button" className={`prepB${small ? ' small' : ''}`} aria-haspopup="dialog" aria-expanded={!!anchor} title={small ? `${sizeText(a)}: smaller than the ${targetMp} MP this runs at. Click to upscale or edit.` : `${sizeText(a)}. Prepare this input: upscale, edit, replace`} onClick={(e) => { setAnchor(anchor ? null : e.currentTarget); setErr(''); }}><Icon name="prep" size={10} />{small ? 'small' : 'Prepare'}</button>
      {anchor && <Popover anchor={anchor} onClose={() => setAnchor(null)} width={320}>
        <div className="row" style={{ alignItems: 'flex-start' }}><Tile src={thumbUrl(id)} style={{ width: 84 }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}><h4>Prepare input</h4><span className="mono xs">{sizeText(a) || 'size unknown'}</span>
            {targetMp ? (small ? <span className="xs" style={{ color: 'var(--warn)' }}>smaller than the {targetMp} MP this runs at</span> : mp > targetMp * 1.5 ? <span className="xs faint">bigger than the {targetMp} MP this runs at (scaled when it runs; scale it down here to keep a smaller copy)</span> : <span className="xs faint">fits the {targetMp} MP this runs at</span>) : null}</div></div>
        <span className="lbl">Change the size (a new picture; the original stays)</span>
        <div className="row wrap">{sizes.map((x) => <Button key={x} size="sm" disabled={!!busy || !(mp > 0) || Math.abs(x - mp) / mp < 0.03} title={mp > 0 && x < mp ? `Scale down to about ${x} MP` : `Upscale to about ${x} MP`} onClick={() => upscale(x)}>{x} MP{x === targetMp ? ' (target)' : ''}</Button>)}</div>
        {openDraft
          ? <Button size="sm" icon="wand" style={{ justifyContent: 'flex-start' }} disabled={!editor} title={editor ? 'Open the image-edit form with this picture as the input. The result lands on the canvas: select it, then use Replace with the canvas selection.' : 'No image-edit workflow is installed'} onClick={() => { setAnchor(null); const d: Draft = { profileId: editor!.id, values: {}, inputs: autoAssign(editor!, [id]), title: 'Edit this input' }; openDraft(d); }}>Edit with the image model…</Button>
          : <>
            <Button size="sm" icon="wand" style={{ justifyContent: 'flex-start' }} disabled={!editor} on={form} title={editor ? 'Enhance or edit this picture with the image model; the result replaces it here' : 'No image-edit workflow is installed'} onClick={() => setForm((f) => !f)}>Edit with the image model…</Button>
            {form && editor && <div className="prepForm">
              <span className="lbl">What to do with the picture ({editor.title})</span>
              <textarea className="ta" rows={4} value={prompt} aria-label="Edit prompt" disabled={!!busy} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
              <div className="row wrap"><span className="xs faint">Result size</span>
                {(['same', 0.5, 1, 2] as const).map((x) => <Button key={x} size="sm" on={outMp === x} disabled={!!busy} onClick={() => setOutMp(x)}>{x === 'same' ? 'Same as input' : `${x} MP`}</Button>)}</div>
              <div className="row">
                <Button size="sm" kind="primary" disabled={!!busy || !prompt.trim()} onClick={() => void enhance()}>Make the new picture</Button>
                <Button size="sm" kind="quiet" disabled={!!busy || prompt === ENHANCE_PROMPT} onClick={() => setPrompt(ENHANCE_PROMPT)}>Back to the default prompt</Button>
                {job && <Button size="sm" kind="quiet" onClick={() => void api.cancel(job)}>Cancel</Button>}
              </div>
              <span className="xs faint">The original stays. The new picture is saved in the Library and takes its place in this shot.</span>
            </div>}
          </>}
        <Button size="sm" icon="restore" style={{ justifyContent: 'flex-start' }} disabled={!swap} title={swap ? 'Use the other picture selected on the canvas instead' : 'Select another picture on the canvas first'} onClick={() => { setAnchor(null); onReplace(swap!); }}>Replace with the canvas selection</Button>
        {busy && <div className="row"><Spinner /><span className="small">{busy}</span></div>}
        {err && <Notice tone="bad">{err}</Notice>}
      </Popover>}
    </span>
  );
}
