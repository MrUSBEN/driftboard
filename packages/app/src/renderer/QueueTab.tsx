import { useContext, useEffect, useMemo, useState } from 'react';
import { C, api, draftFromJob, type Draft } from './shared.tsx';
import { Cards, ViewBar, ViewCtx, useView } from './View.tsx';
import { confirmUser, tellUser } from './Ask.tsx';
import type { LlmTask } from '../main/api.ts';

type Filter = 'all' | 'active' | 'done' | 'failed';
const FINISHED = ['done', 'failed', 'cancelled'];

export function QueueTab({ openDraft }: { openDraft: (d: Draft) => void }) {
  const { jobs, progress, profiles } = useContext(C);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [view, setView] = useView('queue');
  const [filter, setFilter] = useState<Filter>('all');
  const [llmTasks, setLlmTasks] = useState<LlmTask[]>([]);
  useEffect(() => { void api.llmTasks().then(setLlmTasks); return api.onLlmTasks((t) => setLlmTasks([...t])); }, []);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [showHidden, setShowHidden] = useState(false);
  // cleared jobs are only hidden from this list (the lineage and results of a job always stay), remembered per project
  useEffect(() => { void api.blobGet('queue_hidden').then((v) => { try { setHidden(new Set(JSON.parse(v ?? '[]'))); } catch { /* none */ } }); }, []);
  const saveHidden = (s: Set<string>) => { setHidden(s); void api.blobSet('queue_hidden', JSON.stringify([...s])); };

  const llmDone = (t: LlmTask) => t.status !== 'running';
  const llmShown = (t: LlmTask) => (showHidden || !hidden.has(t.id)) && (filter === 'all' || (filter === 'active' ? t.status === 'running' : filter === 'done' ? t.status === 'done' : t.status === 'failed' || t.status === 'cancelled'));
  const finished = jobs.filter((j) => FINISHED.includes(j.status) && !hidden.has(j.id));
  const llmFinished = llmTasks.filter((t) => llmDone(t) && !hidden.has(t.id));
  const clear = async (which: 'finished' | 'failed') => {
    const ids = [...finished, ...llmFinished].filter((j) => which === 'finished' || j.status === 'failed' || j.status === 'cancelled').map((j) => j.id);
    if (!ids.length) return;
    if (!(await confirmUser(`Clear ${ids.length} ${which === 'failed' ? 'failed or cancelled ' : 'finished '}job${ids.length === 1 ? '' : 's'} from the queue?`, 'They are only hidden from this list. Their results stay on the canvas and in the Library, and “Show cleared” brings them back.', 'Clear'))) return;
    saveHidden(new Set([...hidden, ...ids]));
  };
  const shown = useMemo(() => jobs.filter((j) => (showHidden || !hidden.has(j.id)) && (filter === 'all' || (filter === 'active' ? !FINISHED.includes(j.status) : filter === 'done' ? j.status === 'done' : j.status === 'failed' || j.status === 'cancelled'))), [jobs, hidden, showHidden, filter]);
  const count = (f: Filter) => llmTasks.filter((t) => !hidden.has(t.id) && llmShown({ ...t })  && (f === 'all' || (f === 'active' ? t.status === 'running' : f === 'done' ? t.status === 'done' : t.status === 'failed' || t.status === 'cancelled'))).length + jobs.filter((j) => !hidden.has(j.id) && (f === 'all' || (f === 'active' ? !FINISHED.includes(j.status) : f === 'done' ? j.status === 'done' : j.status === 'failed' || j.status === 'cancelled'))).length;

  return (
    <>
      <h2>Queue and history</h2>
      <div className="row" style={{ margin: '6px 0', flexWrap: 'wrap' }}>
        <div className="seg">{(['all', 'active', 'done', 'failed'] as const).map((f) => <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{f === 'all' ? 'All' : f === 'active' ? 'Running' : f === 'done' ? 'Done' : 'Failed'}<span className="count"> {count(f)}</span></button>)}</div>
        <span className="sp" /><ViewBar value={view} onChange={setView} />
      </div>
      <div className="row" style={{ margin: '4px 0', flexWrap: 'wrap' }}>
        <button disabled={!finished.length && !llmFinished.length} onClick={() => void clear('finished')}>Clear finished ({finished.length + llmFinished.length})</button>
        <button disabled={![...finished, ...llmFinished].some((j) => j.status !== 'done')} onClick={() => void clear('failed')}>Clear failed</button>
        {hidden.size > 0 && <label className="row" style={{ margin: 0, color: 'var(--text)' }}><input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />Show cleared ({hidden.size})</label>}
        {showHidden && hidden.size > 0 && <button className="ghost" onClick={() => { saveHidden(new Set()); setShowHidden(false); }}>Restore all</button>}
      </div>
      {!shown.length && !llmTasks.some(llmShown) && <div className="empty">{jobs.length || llmTasks.length ? 'Nothing here.' : 'No jobs yet.'}</div>}
      <ViewCtx.Provider value={view}>
        <Cards>
          {llmTasks.filter(llmShown).slice().reverse().map((t) => (
            <div className={'card queueCard vcard' + (hidden.has(t.id) ? ' cleared' : '')} key={t.id}>
              <div className="meta"><span>LLM · {t.model || 'model'}</span><span className={'status ' + (t.status === 'running' ? 'running' : t.status)}>{t.status}</span></div>
              <div className="prompt vdetail open">{t.label}{t.ended ? ` · ${Math.round((t.ended - t.started) / 1000)}s` : ''}</div>
              {t.status === 'running' && <div className="bar indet"><div /></div>}
              {t.error && <div className="err">{t.error}</div>}
              <div className="row">
                {t.status === 'running' && <button onClick={() => void api.llmCancel()}>Cancel</button>}
                {llmDone(t) && <button className="ghost" title="Hide from this list" onClick={() => saveHidden(new Set(hidden.has(t.id) ? [...hidden].filter((x) => x !== t.id) : [...hidden, t.id]))}>{hidden.has(t.id) ? 'Unhide' : '✕'}</button>}
              </div>
            </div>
          ))}
          {shown.map((j) => {
            const p = JSON.parse(j.params) as Record<string, unknown>;
            const f = j.status === 'running' ? progress[j.id] ?? j.progress ?? 0 : null;
            const again = (newSeed: boolean) => { const d = draftFromJob(j, profiles, newSeed); if (d) openDraft(d); };
            return (
              <div className={'card queueCard vcard' + (hidden.has(j.id) ? ' cleared' : '')} key={j.id}>
                <div className="meta"><span>{j.profile_id}{p.custom_width ? ` · ${p.custom_width}×${p.custom_height}` : ''}</span><span className={'status ' + j.status}>{j.status}</span></div>
                <div className={'prompt vdetail' + (open.has(j.id) ? ' open' : '')} title="Click to show more or less" onClick={() => setOpen((s) => { const n = new Set(s); if (!n.delete(j.id)) n.add(j.id); return n; })}>{String(p.prompt ?? '')}</div>
                {f !== null && <div className="bar"><div style={{ width: `${Math.round(f * 100)}%` }} /></div>}
                {j.error && <div className="err">{j.error}</div>}
                <div className="row" style={{ flexWrap: 'wrap' }}>
                  {(j.status === 'queued' || j.status === 'running') && <button onClick={() => api.cancel(j.id)}>Cancel</button>}
                  {j.status === 'done' && j.outputs.length > 0 && <button onClick={() => api.boardAddAssets(j.outputs.map((o) => o.assetId), 0, 0)}>Add to board</button>}
                  {FINISHED.includes(j.status) && j.profile_id && <>
                    <button onClick={() => again(false)}>Run again…</button>
                    <button onClick={() => again(true)}>New seed…</button>
                    <button title="Make 4 more with new seeds" onClick={async () => { const r = await api.variations(j.id, 4); if (!r.ok) void tellUser('Could not make more', `${r.error}

Check that ComfyUI is connected (top bar), then try again.`); }}>×4</button>
                  </>}
                  {FINISHED.includes(j.status) && <button className="ghost" title="Hide from this list" onClick={() => saveHidden(new Set(hidden.has(j.id) ? [...hidden].filter((x) => x !== j.id) : [...hidden, j.id]))}>{hidden.has(j.id) ? 'Unhide' : '✕'}</button>}
                </div>
              </div>
            );
          })}
        </Cards>
      </ViewCtx.Provider>
    </>
  );
}
