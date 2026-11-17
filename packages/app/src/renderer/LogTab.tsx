import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './shared.tsx';
import type { LogEntry } from '../main/logger.ts';

const hhmmss = (t: number) => new Date(t).toLocaleTimeString([], { hour12: false });

/** Everything the app did and every error, newest at the bottom. Also written to a file in the user folder. */
export function LogTab({ notify }: { notify: (m: string) => void }) {
  const [rows, setRows] = useState<LogEntry[]>([]);
  const [level, setLevel] = useState<'all' | 'warn' | 'error'>('all');
  const [source, setSource] = useState('');
  const [q, setQ] = useState('');
  const [follow, setFollow] = useState(true);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    void api.logList().then((l) => { if (live) setRows(l); });
    const off = api.onLog((e) => setRows((cur) => [...cur.slice(-2999), e]));
    return () => { live = false; off(); };
  }, []);
  useEffect(() => { if (follow) end.current?.scrollIntoView({ block: 'end' }); }, [rows, follow, level, source, q]);

  const sources = useMemo(() => [...new Set(rows.map((r) => r.source))].sort(), [rows]);
  const shown = rows.filter((r) => (level === 'all' || (level === 'error' ? r.level === 'error' : r.level !== 'info')) && (!source || r.source === source) && (!q.trim() || (r.msg + ' ' + r.source).toLowerCase().includes(q.toLowerCase())));
  const text = () => shown.map((r) => `${new Date(r.ts).toISOString()} ${r.level.toUpperCase()} [${r.source}] ${r.msg}`).join('\n');
  const errors = rows.filter((r) => r.level === 'error').length;

  return (
    <div className="logTab">
      <h2>Log</h2>
      <div className="note">Every action and error, with times. Also saved to a file you can send along with a bug report.</div>
      <div className="row" style={{ margin: '8px 0', flexWrap: 'wrap' }}>
        <div className="seg">
          {([['all', 'All'], ['warn', 'Warnings+'], ['error', 'Errors']] as const).map(([k, label]) => <button key={k} className={level === k ? 'on' : ''} onClick={() => setLevel(k)}>{label}{k === 'error' && errors ? <span className="count"> {errors}</span> : null}</button>)}
        </div>
        <select value={source} onChange={(e) => setSource(e.target.value)} style={{ width: 'auto' }}><option value="">all sources</option>{sources.map((s) => <option key={s}>{s}</option>)}</select>
      </div>
      <input type="text" placeholder="Search the log…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="row" style={{ margin: '6px 0', flexWrap: 'wrap' }}>
        <label className="row" style={{ margin: 0, color: 'var(--text)' }}><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />Follow</label>
        <span className="sp" />
        <button onClick={() => { void navigator.clipboard.writeText(text()); notify(`Copied ${shown.length} lines`); }}>Copy</button>
        <button onClick={() => void api.logReveal()}>Show file</button>
        <button onClick={async () => { await api.logClear(); setRows([]); }}>Clear</button>
      </div>
      <div className="logRows">
        {!shown.length && <div className="empty">Nothing logged yet.</div>}
        {shown.map((r) => (
          <div key={r.id} className={'logRow ' + r.level}>
            <span className="t">{hhmmss(r.ts)}</span><span className="s">{r.source}</span><span className="m">{r.msg}</span>
          </div>
        ))}
        <div ref={end} />
      </div>
    </div>
  );
}
