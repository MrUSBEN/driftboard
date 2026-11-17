import { useContext, useEffect, useState } from 'react';
import { C, api } from './shared.tsx';
import type { DirectorProgress, LlmProgress } from '../main/api.ts';
import type { LogEntry } from '../main/logger.ts';

/**
 * One strip at the bottom of the app that always says what is going on: generations (with progress), LLM work,
 * the Director, exports, and the latest problem. Click a message to open the Log.
 */
export function ActivityBar({ openLog }: { openLog: () => void }) {
  const { jobs, progress } = useContext(C);
  const [llm, setLlm] = useState<LlmProgress | null>(null);
  const [dir, setDir] = useState<DirectorProgress | null>(null);
  const [exp, setExp] = useState<number | null>(null);
  const [alert, setAlert] = useState<LogEntry | null>(null);
  const [misc, setMisc] = useState<Record<string, string>>({});
  useEffect(() => { const f = (e: Event) => { const d = (e as CustomEvent<{ id: string; label: string | null }>).detail; setMisc((m) => { const n = { ...m }; if (d.label) n[d.id] = d.label; else delete n[d.id]; return n; }); }; window.addEventListener('driftboard-activity', f); return () => window.removeEventListener('driftboard-activity', f); }, []);

  useEffect(() => api.onLlmProgress((p) => setLlm(p.running ? p : null)), []);
  useEffect(() => api.onDirectorProgress((p) => setDir(p.running ? p : null)), []);
  useEffect(() => api.onExportProgress((f) => setExp(f >= 1 ? null : f)), []);
  useEffect(() => api.onLog((e) => { if (e.level === 'error') setAlert(e); }), []);
  useEffect(() => { if (alert) { const t = setTimeout(() => setAlert((a) => (a === alert ? null : a)), 20000); return () => clearTimeout(t); } }, [alert]);

  const running = jobs.find((j) => j.status === 'running');
  const queued = jobs.filter((j) => j.status === 'queued').length;
  const f = running ? progress[running.id] ?? running.progress ?? 0 : 0;
  const items: { key: string; label: string; frac?: number; cancel?: () => void }[] = [];
  if (running) items.push({ key: 'job', label: `Generating ${running.profile_id ?? ''}${queued ? ` · ${queued} queued` : ''}`, frac: f, cancel: () => void api.cancel(running.id) });
  else if (queued) items.push({ key: 'q', label: `${queued} queued` });
  if (llm) items.push({ key: 'llm', label: llm.label, frac: llm.total > 0 ? llm.done / llm.total : undefined, cancel: () => void api.llmCancel() });
  if (dir) items.push({ key: 'dir', label: `Director: ${dir.label}`, frac: dir.total > 0 ? dir.done / dir.total : undefined, cancel: () => void api.directorCancel() });
  for (const [id, label] of Object.entries(misc)) if (!(id.startsWith('director-') && dir)) items.push({ key: id, label });
  if (exp !== null) items.push({ key: 'exp', label: 'Exporting the film', frac: exp, cancel: () => void api.exportCancel() });

  return (
    <div className="activity">
      {items.length === 0 && !alert && <span className="note">Idle</span>}
      {items.map((it) => (
        <div className="act" key={it.key}>
          <span className="lbl" title={it.label}>{it.label}</span>
          {it.frac !== undefined ? <div className="bar"><div style={{ width: `${Math.round(Math.max(0, Math.min(1, it.frac)) * 100)}%` }} /></div> : <div className="bar indet"><div /></div>}
          {it.frac !== undefined && <span className="pct">{Math.round(it.frac * 100)}%</span>}
          {it.cancel && <button className="ghost" title="Cancel" onClick={it.cancel}>✕</button>}
        </div>
      ))}
      <span className="sp" />
      {alert && <span className="alert" title={alert.msg} onClick={openLog}>⚠ {alert.source}: {alert.msg.slice(0, 140)} <button className="ghost" onClick={(e) => { e.stopPropagation(); setAlert(null); }}>✕</button></span>}
      <button className="ghost" onClick={openLog}>Log</button>
    </div>
  );
}
