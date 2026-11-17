import { useEffect, useState } from 'react';
import { api, draftFromJob, type Draft, type JobView } from './shared.tsx';
import type { Manifest } from './shared.tsx';

/** The job that made an asset (the finished one that has it as an output). */
export const jobOfAsset = (jobs: JobView[], assetId: string) => jobs.find((j) => j.profile_id && j.status === 'done' && j.outputs.some((o) => o.assetId === assetId));

/**
 * One "Regenerate" popup for canvas and timeline: run the same generation again right away (batch size, new seed each),
 * or open the whole form in the left panel with the exact settings to change what you like.
 */
export function RegenerateDialog({ job, profiles, origin, openDraft, notify, onClose }: {
  job: JobView; profiles: Manifest[]; origin?: string; openDraft: (d: Draft) => void; notify: (m: string) => void; onClose: () => void;
}) {
  const [n, setN] = useState(4);
  const run = async () => { onClose(); const r = await api.variations(job.id, Math.max(1, Math.min(12, n || 1))); notify(r.ok ? `Queued ${r.queued} new result${r.queued === 1 ? '' : 's'}. They land next to the original.` : r.error); };
  const form = () => { onClose(); const d = draftFromJob(job, profiles, true); if (d) openDraft({ ...d, origin, title: 'Regenerate' }); else notify('The profile of this generation is not installed.'); };
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); });
  return (
    <div className="modalBack" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <h3>Regenerate</h3>
        <label>How many new results (1–12)</label>
        <input type="number" min={1} max={12} autoFocus value={n} onChange={(e) => setN(Number(e.target.value))} onKeyDown={(e) => { if (e.key === 'Enter') void run(); }} />
        <div className="note">Same prompt, size and inputs, a new random seed each. Results land on the canvas next to the original.</div>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <button onClick={onClose}>Cancel</button>
          <button title="Open the Generate form in the left panel with these exact settings (new seed)" onClick={form}>Change settings…</button>
          <button className="primary-sm" onClick={() => void run()}>Generate {n || 1}</button>
        </div>
      </div>
    </div>
  );
}
