import { useEffect, useState } from 'react';
import { api, thumbUrl } from './shared.tsx';
import { Dialog, Notice } from './ui/ui.tsx';
import { Icon } from './ui/Icon.tsx';
import type { DriftRow } from '../main/api.ts';

/** What the continuity popup works on: clips in playing order. On the timeline each item carries its clip id so a fix can swap the clip in place. */
export interface ContinuityReq {
  title: string;
  items: { assetId: string; clipId?: string }[];
  /** timeline: put a fixed copy in the place of the clip */
  replace?: (clipId: string, assetId: string) => Promise<string | false | void> | string | false | void;
  /** timeline: add a cross-dissolve between two neighbouring clips */
  dissolve?: (leftClipId: string, rightClipId: string) => void;
  /** timeline: even out the sound at a join; deltaDb = this clip's start minus the previous clip's end (positive = louder) */
  setAudio?: (clipId: string, prevClipId: string, deltaDb: number) => void;
}
export const openContinuity = (r: ContinuityReq) => window.dispatchEvent(new CustomEvent('driftboard-continuity', { detail: r }));

const PROBLEM_TEXT: Record<DriftRow['problems'][number], string> = { drift: 'Brightness or colour has drifted from the first clip', start: 'Exposure settles during the first moments', join: 'The join with the previous clip jumps', soft: 'The join with the previous clip is softer', audio: 'The sound changes loudness at the join', flash: 'A short flash or flicker inside the clip' };

type Item = ContinuityReq['items'][number] & { /** the versions this clip had before each fix, newest last (for Undo) */ history?: string[] };
type Fixed = { ok: true; assetId: string } | { ok: false; error: string };

/**
 * Mounted once in the app. Measures a run of clips (selection on the canvas, or the whole timeline), lists what looks irregular,
 * and offers a fix next to each problem. Every fix makes a copy and can be undone: Undo puts the previous version back and moves the copy to the Trash.
 * On the timeline the copies are not put on the canvas (they are in the Library); on the canvas they sit next to their original.
 */
export function ContinuityHost() {
  const [req, setReq] = useState<ContinuityReq | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [rows, setRows] = useState<DriftRow[] | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [file, setFile] = useState('');

  const analyze = async (list: Item[]) => {
    setBusy('Measuring every clip and join…'); setErr('');
    const r = await api.driftCheck(list.map((i) => i.assetId));
    setBusy('');
    if (r.ok) { setRows(r.rows); setFile(r.file); } else { setRows(null); setErr(r.error); }
  };
  useEffect(() => {
    const f = (e: Event) => { const d = (e as CustomEvent<ContinuityReq>).detail; setReq(d); setItems(d.items); setRows(null); void analyze(d.items); };
    window.addEventListener('driftboard-continuity', f); return () => window.removeEventListener('driftboard-continuity', f);
  }, []);
  if (!req) return null;

  const onTimeline = !!req.replace;
  const place = !onTimeline;
  const close = () => setReq(null);
  /** Swap clip i to a new version (on the timeline too) and remember the old one for Undo. */
  const swap = async (cur: Item[], i: number, assetId: string): Promise<Item[]> => {
    const it = cur[i]!;
    if (assetId === it.assetId) return cur;
    // the timeline makes a new clip in the old one's place: keep its id, so a later fix or Undo finds it
    const clipId = req.replace && it.clipId ? (await req.replace(it.clipId, assetId)) || it.clipId : it.clipId;
    return cur.map((x, k) => (k === i ? { ...x, assetId, clipId, history: [...(x.history ?? []), x.assetId] } : x));
  };
  const run = async (i: number, label: string, make: (it: Item) => Promise<Fixed>) => {
    setBusy(label); setErr('');
    const r = await make(items[i]!);
    if (!r.ok) { setBusy(''); setErr(r.error); return; }
    const next = await swap(items, i, r.assetId); setItems(next); await analyze(next);
  };
  /** Put back the version clip i had before its last fix; the fixed copy goes to the Trash. */
  const undoOne = async (cur: Item[], i: number): Promise<Item[]> => {
    const it = cur[i]!; const prev = it.history?.at(-1); if (!prev) return cur;
    const clipId = req.replace && it.clipId ? (await req.replace(it.clipId, prev)) || it.clipId : it.clipId;
    await api.libraryTrash([it.assetId], true);
    return cur.map((x, k) => (k === i ? { ...x, assetId: prev, clipId, history: x.history!.slice(0, -1) } : x));
  };
  const undo = async (i: number) => { setBusy(`Undoing the fix on clip ${i + 1}…`); const next = await undoOne(items, i); setItems(next); await analyze(next); };
  const undoAll = async () => {
    setBusy('Undoing every fix…'); let cur = items;
    for (let i = 0; i < cur.length; i++) while (cur[i]!.history?.length) cur = await undoOne(cur, i);
    setItems(cur); await analyze(cur);
  };
  const fixColor = (i: number) => run(i, `Matching clip ${i + 1} to clip 1…`, async (it) => { const r = await api.colorMatch([it.assetId], items[0]!.assetId, { place }); return r.ok ? (r.assetIds[0] ? { ok: true, assetId: r.assetIds[0] } : { ok: false, error: 'Nothing to change.' }) : r; });
  const fixSeam = (i: number) => run(i, `Smoothing the join into clip ${i + 1}…`, (it) => api.seamMatch(it.assetId, items[i - 1]!.assetId, { place }));
  const fixFlash = (i: number, r: DriftRow) => run(i, `Smoothing the flash in clip ${i + 1}…`, (it) => api.smoothFlashes(it.assetId, r.flashes ?? [], { place }));
  const remake = (i: number) => run(i, `Remaking clip ${i + 1} with the current join fix…`, (it) => api.refreshJoin(it.assetId));
  const flagged = (rows ?? []).filter((r) => r.index > 1 && !r.oldJoin && r.problems.some((p) => p === 'join' || p === 'start'));
  const stale = (rows ?? []).filter((r) => r.oldJoin);
  const fixAll = async () => {
    let cur = items;
    for (const r of stale) { const i = r.index - 1; setBusy(`Remaking clip ${r.index}…`); const x = await api.refreshJoin(cur[i]!.assetId); if (x.ok) cur = await swap(cur, i, x.assetId); }
    for (const r of flagged) {
      const i = r.index - 1;
      setBusy(`Smoothing the join into clip ${r.index}…`);
      const x = await api.seamMatch(cur[i]!.assetId, cur[i - 1]!.assetId, { place });
      if (x.ok) cur = await swap(cur, i, x.assetId);
    }
    setItems(cur); await analyze(cur);
  };
  const anyFix = items.some((x) => x.history?.length);

  return (
    <Dialog title={req.title} icon="chart" width="w3" onClose={close}>
        <div className="note" style={{ marginBottom: 8 }}>Checks brightness and colour against the first clip, exposure at each clip's start, flashes inside a clip and every join. Fixes make copies and never touch the originals{onTimeline ? '; on the timeline the copy takes the clip\'s place' : ''}. Every fix can be undone.</div>
        {busy && <div className="row"><span className="spin" /> <span>{busy}</span></div>}
        {err && <Notice tone="bad">{err} Check that the clips still exist in the Library, then run the check again.</Notice>}
        {rows && <>
          <div className="note" style={{ color: 'var(--text)', margin: '4px 0' }}>{rows.every((r) => !r.flags.length && !r.oldJoin) ? 'No visible problems.' : `${rows.filter((r) => r.flags.length || r.oldJoin).length} of ${rows.length} clips have something to look at.`}</div>
          {rows.map((r) => {
            const i = r.index - 1; const it = items[i]!;
            const fixes = it.history?.length ?? 0;
            return (
              <div key={r.index + it.assetId} className="row" style={{ alignItems: 'flex-start', gap: 8, borderTop: '1px solid var(--line)', padding: '6px 0' }}>
                <img className="mini big" src={thumbUrl(it.assetId)} style={{ marginTop: 2 }} />
                <div style={{ flex: 1 }}>
                  <b>Clip {r.index}</b>{fixes > 0 && <span className="note"> · fixed{fixes > 1 ? ` ×${fixes}` : ''}</span>} <span className="note">{r.index === 1 ? 'the reference for the others' : `brightness ${r.brightnessPct > 0 ? '+' : ''}${r.brightnessPct}% · colour ${r.saturationPct > 0 ? '+' : ''}${r.saturationPct}% vs clip 1`}{r.startShiftPct !== undefined ? ` · start ${r.startShiftPct > 0 ? '+' : ''}${r.startShiftPct}%` : ''}{r.seamBrightness !== undefined ? ` · join ${r.seamBrightness}/${r.seamColor}` : ''}{r.audioJumpDb !== undefined ? ` · sound ${r.audioJumpDb > 0 ? '+' : ''}${r.audioJumpDb} dB` : ''}</span>
                  {r.oldJoin && <div className="warn" style={{ margin: '2px 0' }}>{r.oldJoin}</div>}
                  {r.flags.length === 0 && !r.oldJoin ? <div className="note row" style={{ gap: 5, color: 'var(--ok)' }}><Icon name="check" size="s" />Looks consistent</div> : r.flags.map((f, k) => <div key={k} className="warn" style={{ margin: '2px 0' }}>{f}</div>)}
                  {r.problems.map((p) => <div key={p} className="note">{PROBLEM_TEXT[p]}{p === 'soft' ? '. Regenerate it from a sharper input (Prepare › Upscale on its input) or use held frames.' : p === 'drift' ? '. Often this is the story\'s own light; match only drift you did not intend.' : ''}</div>)}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {r.oldJoin && <button disabled={!!busy} title="Makes this clip again from its generated original with the current join fix: the held frames at both ends are trimmed and the flicker after the join is smoothed" onClick={() => void remake(i)}>Remake with the current fix</button>}
                  {!r.oldJoin && (r.problems.includes('join') || r.problems.includes('start')) && i > 0 && <button disabled={!!busy} title="The start of this clip steps to the end of the clip before it and fades back over 2 seconds; quick flicker in that first second is smoothed. Slower light changes in the story stay." onClick={() => void fixSeam(i)}>Smooth the join</button>}
                  {r.problems.includes('flash') && <button disabled={!!busy} title="Pulls the short flash back to the clip's steady level; the rest of the clip is left as it is" onClick={() => void fixFlash(i, r)}>Smooth the flash</button>}
                  {r.problems.includes('drift') && i > 0 && <button disabled={!!busy} title="Pulls the whole clip toward clip 1's look. Only for drift you did not intend: it also flattens real lighting changes in the story." onClick={() => void fixColor(i)}>Match whole clip to clip 1</button>}
                  {r.problems.includes('audio') && req.setAudio && it.clipId && items[i - 1]?.clipId && r.audioJumpDb !== undefined && <button disabled={!!busy} title="Lowers the louder side so the sound is the same level at the cut (the audio level of the clip on the timeline, nothing is re-encoded)" onClick={() => { req.setAudio!(it.clipId!, items[i - 1]!.clipId!, r.audioJumpDb!); void analyze(items); }}>Even out the sound</button>}
                  {r.problems.includes('join') && req.dissolve && it.clipId && items[i - 1]?.clipId && <button disabled={!!busy} title="A cross-dissolve hides a small jump at the cut (the export renders it)" onClick={() => { req.dissolve!(items[i - 1]!.clipId!, it.clipId!); void analyze(items); }}>Add dissolve</button>}
                  {fixes > 0 && <button disabled={!!busy} title="Put back the version from before the last fix; the fixed copy goes to the Trash" onClick={() => void undo(i)}><Icon name="undo" size="s" /> Undo fix</button>}
                </div>
              </div>
            );
          })}
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 10, flexWrap: 'wrap' }}>
            <span className="note">Report saved: {file}</span>
            <span className="row">
              {anyFix && <button disabled={!!busy} onClick={() => void undoAll()} title="Put back every clip as it was when the check opened; the fixed copies go to the Trash">Undo all fixes</button>}
              <button disabled={!!busy || (!flagged.length && !stale.length)} onClick={() => void fixAll()} title="Remake clips made by the older join fix, then smooth every join that jumps (the rest of each clip is left as it is)">Fix all joins</button>
              <button disabled={!!busy} onClick={() => void analyze(items)}>Check again</button><button onClick={close}>Close</button>
            </span>
          </div>
        </>}
        {!rows && !busy && <div className="row" style={{ justifyContent: 'flex-end' }}><button onClick={close}>Close</button></div>}
    </Dialog>
  );
}
