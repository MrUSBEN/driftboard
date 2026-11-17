import { useState } from 'react';
import { Button, Dialog, Stepper, Tile } from './ui/ui.tsx';
import { thumbUrl } from './shared.tsx';
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
  return (
    <Dialog title="Regenerate" icon="regen" onClose={onClose} footer={<>
      <Button kind="quiet" onClick={onClose}>Cancel</Button>
      <Button title="Open Create with these exact settings (new seed) to change what you like" onClick={form}>Change settings…</Button>
      <Button kind="primary" onClick={() => void run()}>Generate {n || 1}</Button>
    </>}>
      <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
        {job.outputs[0] && <Tile big src={thumbUrl(job.outputs[0].assetId)} />}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="row"><span className="lbl">New results</span><Stepper value={n} onChange={setN} label="Results" /></div>
          <span className="small dim">Same prompt, size and inputs, a new random seed each. Results land on the canvas next to the original.</span>
        </div>
      </div>
    </Dialog>
  );
}
