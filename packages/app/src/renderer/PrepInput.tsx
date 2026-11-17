import { useContext, useState } from 'react';
import { C, api, autoAssign, imageSlots, type Draft } from './shared.tsx';

/** "1024×576 · 0.59 MP" for a picture's size, or '' when it is not known. */
export const sizeText = (a?: { width: number | null; height: number | null }) => (a?.width && a.height ? `${a.width}×${a.height} · ${((a.width * a.height) / 1e6).toFixed(2)} MP` : '');

/**
 * The "prepare this input" button every picture input has (Generate slots, story shot inputs, Assistant attachments, Storyboard...):
 * shows the real size, upscales to a chosen size, edits with an image model, or swaps in the picture selected on the canvas.
 * The original asset is never changed: every option makes a new asset and calls onReplace with it.
 * `targetMp` (the size the generation will run at) marks inputs that are smaller than that.
 */
export function PrepInput({ id, onReplace, selected, openDraft, targetMp }: { id: string; onReplace: (newId: string) => void; selected?: string[]; openDraft?: (d: Draft) => void; targetMp?: number }) {
  const { assets, profiles } = useContext(C);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const a = assets.get(id);
  if (!a || a.kind !== 'image') return null;
  const mp = a.width && a.height ? (a.width * a.height) / 1e6 : 0;
  const small = !!targetMp && mp > 0 && mp < targetMp * 0.9;
  const editor = profiles.find((p) => p.kind === 'image' && imageSlots(p).length > 0 && p.slots.some((s) => s.role === 'prompt'));
  const swap = (selected ?? []).find((x) => x !== id && assets.get(x)?.kind === 'image');
  const upscale = async (toMp: number) => {
    setBusy(`Upscaling to ${toMp} MP…`); setErr('');
    const r = await api.mediaEdit(id, { op: 'upscale', toMp });
    setBusy('');
    if (r.ok) { setOpen(false); onReplace(r.assetId); } else setErr(r.error);
  };
  const sizes = [...new Set([0.25, 0.5, 1, 2, ...(targetMp ? [Math.round(targetMp * 100) / 100] : [])])].sort((x, y) => x - y);
  return (
    <span className="prep" onClick={(e) => e.stopPropagation()}>
      <button className={`prepBtn${small ? ' small' : ''}`} title={small ? `${sizeText(a)}: smaller than the ${targetMp} MP this runs at. Click to upscale or edit.` : `${sizeText(a)}. Prepare this input: upscale, edit, replace`} onClick={() => { setOpen(!open); setErr(''); }}>⚙</button>
      {open && (
        <div className="prepMenu">
          <div className="note">{sizeText(a) || 'size unknown'}{small ? ' · smaller than the target' : ''}</div>
          {sizes.map((s) => <button key={s} disabled={!!busy || !(mp > 0 && s > mp * 1.001)} onClick={() => upscale(s)}>Upscale to {s} MP{s === targetMp ? ' (target)' : ''}</button>)}
          <button disabled={!editor || !openDraft} title={editor ? 'Open the image-edit form with this picture as the input. The result lands on the canvas: select it and use "Replace with selected".' : 'No image-edit profile is installed'} onClick={() => { setOpen(false); const d: Draft = { profileId: editor!.id, values: {}, inputs: autoAssign(editor!, [id]), title: 'Edit this input' }; openDraft!(d); }}>Edit with image model…</button>
          <button disabled={!swap} title="Use the other picture selected on the canvas instead" onClick={() => { setOpen(false); onReplace(swap!); }}>Replace with selected</button>
          {busy && <div className="note">{busy}</div>}
          {err && <div className="err">{err}</div>}
          <button className="ghost" onClick={() => setOpen(false)}>Close</button>
        </div>
      )}
    </span>
  );
}
