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
  replace?: (clipId: string, assetId: string) => Promise<void> | void;
  /** timeline: add a cross-dissolve between two neighbouring clips */
  dissolve?: (leftClipId: string, rightClipId: string) => void;
  /** timeline: even out the sound at a join; deltaDb = this clip's start minus the previous clip's end (positive = louder) */
  setAudio?: (clipId: string, prevClipId: string, deltaDb: number) => void;
}
export const openContinuity = (r: ContinuityReq) => window.dispatchEvent(new CustomEvent('driftboard-continuity', { detail: r }));

const PROBLEM_TEXT: Record<DriftRow['problems'][number], string> = { drift: 'Brightness or colour has drifted from the first clip', start: 'Exposure settles during the first moments', join: 'The join with the previous clip jumps', soft: 'The join with the previous clip is softer', audio: 'The sound changes loudness at the join' };

/**
 * Mounted once in the app. Measures a run of clips (selection on the canvas, or the whole timeline), lists what looks irregular,
 * and offers a fix next to each problem. Prevention (held frames, colour-matched inputs) is built into generation; this is the check afterwards.
 */
export function ContinuityHost() {
  const [req, setReq] = useState<ContinuityReq | null>(null);
  const [items, setItems] = useState<ContinuityReq['items']>([]);
  const [rows, setRows] = useState<DriftRow[] | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [file, setFile] = useState('');

  const analyze = async (list: ContinuityReq['items']) => {
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

  const close = () => setReq(null);
  /** Make a colour-matched copy of one clip toward another clip's first frame; on the timeline the copy takes the clip's place. */
  const fix = async (i: number, toIndex: number) => {
    const it = items[i]!, ref = items[toIndex]!;
    setBusy(`Matching clip ${i + 1} to clip ${toIndex + 1}…`); setErr('');
    const r = await api.colorMatch([it.assetId], ref.assetId);
    if (!r.ok || !r.assetIds[0]) { setBusy(''); setErr(r.ok ? 'Nothing to change.' : r.error); return; }
    const copy = r.assetIds[0];
    if (req.replace && it.clipId) await req.replace(it.clipId, copy);
    const next = items.map((x, k) => (k === i ? { ...x, assetId: copy } : x));
    setItems(next); await analyze(next);
  };
  const flagged = (rows ?? []).filter((r) => r.index > 1 && r.problems.some((p) => p === 'join' || p === 'start'));
  /** Make the start of a clip agree with the end of the clip before it; the rest of the clip is left as it is. */
  const fixSeam = async (i: number) => {
    const it = items[i]!, prev = items[i - 1]!;
    setBusy(`Matching the start of clip ${i + 1} to clip ${i}…`); setErr('');
    const r = await api.seamMatch(it.assetId, prev.assetId);
    if (!r.ok) { setBusy(''); setErr(r.error); return; }
    if (req!.replace && it.clipId) await req!.replace(it.clipId, r.assetId);
    const next = items.map((x, k) => (k === i ? { ...x, assetId: r.assetId } : x));
    setItems(next); await analyze(next);
  };
  const fixAll = async () => {
    let cur = items;
    for (const r of flagged) {
      const i = r.index - 1;
      setBusy(`Matching the start of clip ${r.index}…`);
      const res = await api.seamMatch(cur[i]!.assetId, cur[i - 1]!.assetId).then((x) => (x.ok ? { ok: true as const, assetIds: [x.assetId] } : x));
      if (res.ok && res.assetIds[0]) { if (req.replace && cur[i]!.clipId) await req.replace(cur[i]!.clipId!, res.assetIds[0]); cur = cur.map((x, k) => (k === i ? { ...x, assetId: res.assetIds[0]! } : x)); }
    }
    setItems(cur); await analyze(cur);
  };

  return (
    <Dialog title={req.title} icon="chart" width="w3" onClose={close}>
        <div className="note" style={{ marginBottom: 8 }}>Continuity is prevented while generating (held frames, colour-matched inputs). This checks the result: brightness and colour against the first clip, exposure at each clip's start, and every join. Fixes make copies and never touch the originals{req.replace ? '; on the timeline the copy takes the clip\'s place' : ''}.</div>
        {busy && <div className="row"><span className="spin" /> <span>{busy}</span></div>}
        {err && <Notice tone="bad">{err} Check that the clips still exist in the Library, then run the check again.</Notice>}
        {rows && <>
          <div className="note" style={{ color: 'var(--text)', margin: '4px 0' }}>{rows.every((r) => !r.flags.length) ? 'No visible problems.' : `${rows.filter((r) => r.flags.length).length} of ${rows.length} clips have something to look at.`}</div>
          {rows.map((r) => {
            const i = r.index - 1; const it = items[i]!;
            const canMatch = r.problems.some((p) => p === 'drift' || p === 'start' || p === 'join');
            return (
              <div key={r.index + it.assetId} className="row" style={{ alignItems: 'flex-start', gap: 8, borderTop: '1px solid var(--line)', padding: '6px 0' }}>
                <img className="mini big" src={thumbUrl(it.assetId)} style={{ marginTop: 2 }} />
                <div style={{ flex: 1 }}>
                  <b>Clip {r.index}</b> <span className="note">brightness {r.brightnessPct > 0 ? '+' : ''}{r.brightnessPct}% · colour {r.saturationPct > 0 ? '+' : ''}{r.saturationPct}% vs clip 1{r.startShiftPct !== undefined ? ` · start ${r.startShiftPct > 0 ? '+' : ''}${r.startShiftPct}%` : ''}{r.seamBrightness !== undefined ? ` · join ${r.seamBrightness}/${r.seamColor}` : ''}{r.audioJumpDb !== undefined ? ` · sound ${r.audioJumpDb > 0 ? '+' : ''}${r.audioJumpDb} dB` : ''}</span>
                  {r.flags.length === 0 ? <div className="note row" style={{ gap: 5, color: 'var(--ok)' }}><Icon name="check" size="s" />Looks consistent</div> : r.flags.map((f, k) => <div key={k} className="warn" style={{ margin: '2px 0' }}>{f}</div>)}
                  {r.problems.map((p) => <div key={p} className="note">{PROBLEM_TEXT[p]}{p === 'soft' ? '. Regenerate it from a sharper input (Prepare › Upscale on its input) or use held frames.' : ''}</div>)}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {canMatch && i > 0 && <button disabled={!!busy} title="Pulls the whole clip toward the first clip's look. Only for drift you did not intend: it also flattens real lighting changes in the story." onClick={() => void fix(i, 0)}>Match whole clip to clip 1</button>}
                  {(r.problems.includes('join') || r.problems.includes('start')) && i > 0 && <button disabled={!!busy} title="Makes the start of this clip agree with the end of the clip before it, fading out over 2 seconds. The rest of the clip is left as it is, so the story can keep getting darker or lighter." onClick={() => void fixSeam(i)}>Match start to previous</button>}
                  {canMatch && i === 0 && r.problems.includes('start') && <span className="note">first clip = the reference</span>}
                  {r.problems.includes('audio') && req.setAudio && it.clipId && items[i - 1]?.clipId && r.audioJumpDb !== undefined && <button disabled={!!busy} title="Lowers the louder side so the sound is the same level at the cut (the audio level of the clip on the timeline, nothing is re-encoded)" onClick={() => { req.setAudio!(it.clipId!, items[i - 1]!.clipId!, r.audioJumpDb!); void analyze(items); }}>Even out the sound</button>}
                  {r.problems.includes('join') && req.dissolve && it.clipId && items[i - 1]?.clipId && <button disabled={!!busy} title="A cross-dissolve hides a small jump at the cut (the export renders it)" onClick={() => { req.dissolve!(items[i - 1]!.clipId!, it.clipId!); void analyze(items); }}>Add dissolve</button>}
                </div>
              </div>
            );
          })}
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 10, flexWrap: 'wrap' }}>
            <span className="note">Report saved: {file}</span>
            <span className="row"><button disabled={!!busy || !flagged.length} onClick={() => void fixAll()} title="Make the start of every clip with a join or start problem agree with the end of the clip before it (the rest of each clip is left as it is)">Fix all joins</button><button disabled={!!busy} onClick={() => void analyze(items)}>Check again</button><button onClick={close}>Close</button></span>
          </div>
        </>}
        {!rows && !busy && <div className="row" style={{ justifyContent: 'flex-end' }}><button onClick={close}>Close</button></div>}
    </Dialog>
  );
}
