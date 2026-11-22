/* Activity: one panel for everything that runs or ran. Jobs (generations and LLM tasks, was the Queue tab),
   Messages (every message that popped up, was the bell) and Log (was the Log tab). The status bar opens it. */
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { C, api, draftFromJob, thumbUrl, type Draft, type JobView } from './shared.tsx';
import { confirmUser, tellUser } from './Ask.tsx';
import { Icon } from './ui/Icon.tsx';
import { Button, IconButton, Progress, Seg, StatusPill, Tile, Empty, Menu, type MenuItem } from './ui/ui.tsx';
import { useProfileTitle } from './Shell.tsx';
import type { LlmTask } from '../main/api.ts';
import type { LogEntry } from '../main/logger.ts';

export interface Note { id: number; ts: number; msg: string; level: 'info' | 'warn' | 'error' }
export type ActivityTab = 'jobs' | 'messages' | 'log';
const hhmmss = (t: number) => new Date(t).toLocaleTimeString([], { hour12: false });

export function ActivityPanel({ tab, setTab, notes, clearNotes, openDraft, notify, focus }: { tab: ActivityTab; setTab: (t: ActivityTab) => void; notes: Note[]; clearNotes: () => void; openDraft: (d: Draft) => void; notify: (m: string) => void; focus: (assetId: string) => void }) {
  const { jobs } = useContext(C);
  const [errors, setErrors] = useState(0);
  useEffect(() => { void api.logList().then((l) => setErrors(l.filter((r) => r.level === 'error').length)); return api.onLog((e) => { if (e.level === 'error') setErrors((n) => n + 1); }); }, []);
  const active = jobs.filter((j) => j.status === 'running' || j.status === 'queued').length;
  return (
    <>
      <div className="ph"><h2>Activity</h2></div>
      <div className="stages" role="tablist" aria-label="Activity">
        {([['jobs', 'Jobs', active], ['messages', 'Messages', notes.length], ['log', 'Log', errors]] as const).map(([k, l, n]) =>
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}{n ? <span className="cnt">{n}</span> : null}</button>)}
      </div>
      {tab === 'jobs' ? <JobsView openDraft={openDraft} focus={focus} /> : tab === 'messages' ? <MessagesView notes={notes} clear={clearNotes} openLog={() => setTab('log')} /> : <LogView notify={notify} />}
    </>
  );
}

/* ---------- Jobs ---------- */
type Filter = 'all' | 'active' | 'done' | 'failed';
const FINISHED = ['done', 'failed', 'cancelled'];
const shownStatus = (j: { status: string; error?: string | null }) => (j.status === 'failed' && /^Interrupted/.test(j.error ?? '') ? 'interrupted' : j.status);

function JobsView({ openDraft, focus }: { openDraft: (d: Draft) => void; focus: (assetId: string) => void }) {
  const { jobs, progress, profiles } = useContext(C);
  const title = useProfileTitle();
  const [filter, setFilter] = useState<Filter>('all');
  const [llmTasks, setLlmTasks] = useState<LlmTask[]>([]);
  useEffect(() => { void api.llmTasks().then(setLlmTasks); return api.onLlmTasks((t) => setLlmTasks([...t])); }, []);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [showHidden, setShowHidden] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // cleared jobs are only hidden from this list (the lineage and results of a job always stay), remembered per project
  useEffect(() => { void api.blobGet('queue_hidden').then((v) => { try { setHidden(new Set(JSON.parse(v ?? '[]'))); } catch { /* none */ } }); }, []);
  const saveHidden = (s: Set<string>) => { setHidden(s); void api.blobSet('queue_hidden', JSON.stringify([...s])); };
  const toggleHidden = (id: string) => saveHidden(new Set(hidden.has(id) ? [...hidden].filter((x) => x !== id) : [...hidden, id]));

  const inFilter = (status: string, f: Filter) => f === 'all' || (f === 'active' ? !FINISHED.includes(status) : f === 'done' ? status === 'done' : status === 'failed' || status === 'cancelled');
  const finished = jobs.filter((j) => FINISHED.includes(j.status) && !hidden.has(j.id));
  const llmFinished = llmTasks.filter((t) => t.status !== 'running' && !hidden.has(t.id));
  const clear = async (which: 'finished' | 'failed') => {
    const ids = [...finished, ...llmFinished].filter((j) => which === 'finished' || j.status === 'failed' || j.status === 'cancelled').map((j) => j.id);
    if (!ids.length) return;
    if (!(await confirmUser(`Clear ${ids.length} ${which === 'failed' ? 'failed or cancelled ' : 'finished '}job${ids.length === 1 ? '' : 's'} from the list?`, 'They are only hidden from this list. Their results stay on the canvas and in the Library, and “Show cleared” brings them back.', 'Clear'))) return;
    saveHidden(new Set([...hidden, ...ids]));
  };
  const shown = useMemo(() => jobs.filter((j) => (showHidden || !hidden.has(j.id)) && inFilter(j.status, filter)), [jobs, hidden, showHidden, filter]);
  const llmShown = llmTasks.filter((t) => (showHidden || !hidden.has(t.id)) && inFilter(t.status === 'running' ? 'running' : t.status, filter));
  const count = (f: Filter) => jobs.filter((j) => !hidden.has(j.id) && inFilter(j.status, f)).length + llmTasks.filter((t) => !hidden.has(t.id) && inFilter(t.status, f)).length;
  const more: MenuItem[] = [
    { label: `Clear finished (${finished.length + llmFinished.length})`, icon: 'check', disabled: !finished.length && !llmFinished.length, onClick: () => void clear('finished') },
    { label: 'Clear failed and cancelled', icon: 'x', disabled: ![...finished, ...llmFinished].some((j) => j.status !== 'done'), onClick: () => void clear('failed') },
    { sep: true },
    { label: showHidden ? 'Hide cleared jobs' : `Show cleared (${hidden.size})`, icon: 'eye', disabled: !hidden.size, onClick: () => setShowHidden(!showHidden) },
    { label: 'Restore all cleared', icon: 'restore', disabled: !hidden.size, onClick: () => { saveHidden(new Set()); setShowHidden(false); } },
  ];

  return (
    <div className="pb" data-area="activity">
      <div className="row">
        <Seg label="Show" value={filter} onChange={setFilter} options={([['all', 'All'], ['active', 'Running'], ['done', 'Done'], ['failed', 'Failed']] as const).map(([v, l]) => ({ value: v, label: l, count: count(v) }))} />
        <span className="sp" /><IconButton size="sm" icon="more" label="More: clear finished, show cleared" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.right - 240, y: r.bottom + 4 }); }} />
        {menu && <Menu x={menu.x} y={menu.y} items={more} onClose={() => setMenu(null)} />}
      </div>
      {!shown.length && !llmShown.length && <Empty icon="activity" title={jobs.length || llmTasks.length ? 'Nothing here' : 'No jobs yet'}>{jobs.length || llmTasks.length ? 'Try another filter.' : 'Generations and LLM work show up here while they run, and stay as a history.'}</Empty>}
      {shown.map((j) => <JobCard key={j.id} j={j} f={j.status === 'running' ? progress[j.id] ?? j.progress ?? 0 : null} title={title(j.profile_id)} cleared={hidden.has(j.id)} onHide={() => toggleHidden(j.id)} again={(newSeed) => { const d = draftFromJob(j, profiles, newSeed); if (d) openDraft(d); }} focus={focus} />)}
      {llmShown.length > 0 && <div className="ilabel"><Icon name="llm" size="s" />LLM tasks</div>}
      {llmShown.slice().reverse().map((t) => (
        <div className={'card dcard queueCard vcard' + (hidden.has(t.id) ? ' cleared' : '')} key={t.id} style={{ margin: 0 }}>
          <div className="row"><StatusPill status={t.status} /><b className="small" style={{ flex: 1, minWidth: 0 }}>{t.label}</b><span className="mono xs faint">{t.model || 'model'}{t.ended ? ` · ${Math.round((t.ended - t.started) / 1000)} s` : ''}</span>
            {t.status === 'running' ? <Button size="sm" onClick={() => void api.llmCancel()}>Cancel</Button> : <IconButton size="sm" icon={hidden.has(t.id) ? 'eye' : 'x'} label={hidden.has(t.id) ? 'Show again in this list' : 'Hide from this list'} onClick={() => toggleHidden(t.id)} />}
          </div>
          {t.status === 'running' && <Progress label={t.label} style={{ marginTop: 8 }} />}
          {t.error && <div className="notice bad" style={{ marginTop: 8 }}><Icon name="warn" /><div className="nb xs">{t.error}</div></div>}
        </div>
      ))}
    </div>
  );
}

/** 74 -> "1:14", 3700 -> "1:01:40"; under a minute "42 s". */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}
/** Time stat of a job: how long it waited in the queue and how long it ran (live while running). */
function jobTimes(j: JobView, now: number): { waited?: string; ran?: string; running: boolean } {
  const t = (v: string | null) => (v ? Date.parse(v) : NaN);
  const created = t(j.created_at), started = t(j.started_at), ended = t(j.finished_at);
  const waited = Number.isFinite(started) && Number.isFinite(created) && started - created >= 2000 ? fmtDuration(started - created) : undefined;
  if (j.status === 'running' && Number.isFinite(started)) return { waited, ran: fmtDuration(now - started), running: true };
  if (Number.isFinite(started) && Number.isFinite(ended)) return { waited, ran: fmtDuration(ended - started), running: false };
  return { running: false };
}
function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!on) return; const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, [on]);
  return now;
}

function JobCard({ j, f, title, cleared, onHide, again, focus }: { j: JobView; f: number | null; title: string; cleared: boolean; onHide: () => void; again: (newSeed: boolean) => void; focus: (assetId: string) => void }) {
  const { board } = useContext(C);
  const now = useNow(j.status === 'running');
  const tm = jobTimes(j, now);
  const p = useMemo(() => { try { return JSON.parse(j.params) as Record<string, unknown>; } catch { return {}; } }, [j.params]);
  const st = shownStatus(j);
  const thumb = j.outputs[0]?.assetId ?? j.inputs[0]?.assetId;
  const prompt = String(p.prompt ?? '');
  const size = p.custom_width ? `${p.custom_width}×${p.custom_height}` : p.width ? `${p.width}×${p.height}` : '';
  return (
    <div className={'card dcard queueCard vcard jobCard' + (cleared ? ' cleared' : '')} style={{ margin: 0 }}>
      <div className="row" style={{ alignItems: 'flex-start', gap: 10 }}>
        {thumb ? <Tile src={thumbUrl(thumb)} style={{ width: 88 }} /> : <div className="tile" style={{ width: 88, display: 'grid', placeItems: 'center', color: 'var(--on-media)' }}><Icon name="image" /></div>}
        <div className="col" style={{ gap: 5, minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div className="row"><StatusPill status={st} pct={f ?? undefined} /><span className="sp" /><span className="mono xs faint">{size}</span></div>
          <b className="small" title={j.profile_id ?? undefined}>{title}</b>
          {tm.ran && <span className="mono xs faint" title={tm.waited ? `Waited ${tm.waited} in the queue before it started` : undefined}>{tm.running ? 'Running ' : j.status === 'done' ? 'Took ' : 'Ran '}{tm.ran}{tm.waited ? ` · waited ${tm.waited}` : ''}</span>}
          {f !== null && <Progress value={f} label="Progress" />}
          {j.error && <div className="notice bad" style={{ padding: '6px 8px' }}><Icon name="warn" size="s" /><div className="nb xs" style={{ userSelect: 'text' }}>{j.error}</div></div>}
          {prompt && <details><summary className="xs dim" style={{ cursor: 'pointer' }}>Prompt</summary><div className="prompt full" style={{ marginTop: 4, fontSize: 11.5, color: 'var(--text)', userSelect: 'text' }}>{prompt}</div></details>}
          <div className="row" style={{ gap: 2, flexWrap: 'wrap' }}>
            {(j.status === 'queued' || j.status === 'running') && <Button size="sm" onClick={() => void api.cancel(j.id)}>Cancel</Button>}
            {j.status === 'done' && j.outputs.length > 0 && <Button size="sm" kind="quiet" icon="views" title="Jump to the results on the canvas (results that are not on it are put there first; they stay in the Library either way)" onClick={() => {
              const on = new Set(board.items.filter((i) => i.kind === 'asset' && i.ref).map((i) => i.ref!));
              const ids = j.outputs.map((o) => o.assetId); const missing = ids.filter((id) => !on.has(id));
              void (missing.length ? api.boardAddAssets(missing, 0, 0) : Promise.resolve()).then(() => focus(ids[0]!));
            }}>Show on canvas</Button>}
            {FINISHED.includes(j.status) && j.profile_id && <>
              <Button size="sm" kind="quiet" icon="regen" onClick={() => again(false)}>Run again…</Button>
              <Button size="sm" kind="quiet" icon="dice" onClick={() => again(true)}>New seed…</Button>
              <Button size="sm" kind="quiet" title="Make 4 more with new seeds" onClick={async () => { const r = await api.variations(j.id, 4); if (!r.ok) void tellUser('Could not make more', `${r.error}\n\nCheck that ComfyUI is connected (top bar), then try again.`); }}>×4</Button>
            </>}
            <span className="sp" />
            {FINISHED.includes(j.status) && <IconButton size="sm" icon={cleared ? 'eye' : 'x'} label={cleared ? 'Show again in this list' : 'Hide from this list (results stay)'} onClick={onHide} />}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Messages ---------- */
function MessagesView({ notes, clear, openLog }: { notes: Note[]; clear: () => void; openLog: () => void }) {
  return (
    <div className="pb" data-area="activity">
      <div className="row"><span className="small dim">Every message that popped up, newest first.</span><span className="sp" /><Button size="sm" kind="quiet" onClick={openLog}>Open log</Button><Button size="sm" kind="quiet" disabled={!notes.length} onClick={clear}>Clear</Button></div>
      {!notes.length && <Empty icon="bell" title="No messages yet">Messages that pop up at the bottom right are kept here.</Empty>}
      {[...notes].reverse().map((n) => (
        <div key={n.id} className="dcard row" style={{ alignItems: 'flex-start', padding: '9px 11px' }}>
          <Icon name={n.level === 'info' ? 'info' : 'warn'} size="s" style={{ color: n.level === 'error' ? 'var(--bad)' : n.level === 'warn' ? 'var(--warn)' : 'var(--dim)', marginTop: 2 }} />
          <span className="small" style={{ flex: 1, userSelect: 'text', color: n.level === 'error' ? 'var(--bad)' : n.level === 'warn' ? 'var(--warn)' : 'var(--text)' }}>{n.msg}</span>
          <span className="mono xs faint">{hhmmss(n.ts)}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------- Log ---------- */
function LogView({ notify }: { notify: (m: string) => void }) {
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
    <div className="pb logTab" data-area="activity">
      <span className="small dim">Every action and error, with times. Also saved to a file you can send with a bug report.</span>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <Seg label="Level" value={level} onChange={setLevel} options={[{ value: 'all', label: 'All' }, { value: 'warn', label: 'Warnings+' }, { value: 'error', label: 'Errors', count: errors || undefined }]} />
        <select className="selc" style={{ width: 130 }} aria-label="Source" value={source} onChange={(e) => setSource(e.target.value)}><option value="">all sources</option>{sources.map((s) => <option key={s}>{s}</option>)}</select>
        <span className="sp" />
        <label className="check"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />Follow</label>
      </div>
      <div className="row">
        <input className="inp" placeholder="Filter lines" aria-label="Filter the log" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button size="sm" icon="copy" onClick={() => { void navigator.clipboard.writeText(text()); notify(`Copied ${shown.length} lines`); }}>Copy</Button>
        <Button size="sm" onClick={() => void api.logReveal()}>Show file</Button>
        <Button size="sm" kind="quiet" onClick={async () => { if (await confirmUser('Clear the log?', 'The lines shown here and the log file are emptied. New lines keep coming.', 'Clear the log', true)) { await api.logClear(); setRows([]); } }}>Clear</Button>
      </div>
      <div className="logRows">
        {!shown.length && <Empty icon="list" title="Nothing logged yet" />}
        {shown.map((r) => (
          <div key={r.id} className={'logRow ' + r.level}>
            <span className="t">{hhmmss(r.ts)}</span><span className={'lv ' + r.level}>{r.level}</span><span className="s">{r.source}</span><span className="m">{r.msg}</span>
          </div>
        ))}
        <div ref={end} />
      </div>
    </div>
  );
}
