/* The app shell of the Sand Atelier design: top bar, floating rail, status bar, connection pills, the one Undo/Redo.
   Panels themselves live in their own files; App.tsx puts it all together. */
import { useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { C, api } from './shared.tsx';
import { Icon, type IconName } from './ui/Icon.tsx';
import { Button, IconButton, Menu, Popover, Progress, Spinner, ThemeSwitch, Field, Chip, type MenuItem } from './ui/ui.tsx';
import { Wordmark } from './ui/Wordmark.tsx';
import { FilmChip } from './size.tsx';
import { undoInLast, undoInfo, useUndoTarget } from './undoRouter.ts';
import { bindOf } from './keys.ts';
import { askUser } from './Ask.tsx';
import type { DirectorProgress, LlmProgress, LlmStatus, ProjectView } from '../main/api.ts';
import type { LogEntry } from '../main/logger.ts';

export type PanelId = 'create' | 'story' | 'assistant' | 'library' | 'activity';
export type SettingsPane = 'comfy' | 'llm' | 'guides' | 'keys' | 'look';
export type ComfyState = { ok: boolean; version?: string; error?: string; url: string } | null;

/** A profile's title for the UI (ids stay in the Inspector and Settings). */
export function useProfileTitle() {
  const { profiles } = useContext(C);
  return useCallback((id: string | null | undefined) => (id ? profiles.find((p) => p.id === id)?.title ?? id : 'Job'), [profiles]);
}

/* ---------- top bar ---------- */
export function TopBar({ project, comfy, refreshComfy, openProjects, openSettings, notify }: { project: ProjectView | null; comfy: ComfyState; refreshComfy: () => void; openProjects: () => void; openSettings: (p?: SettingsPane) => void; notify: (m: string) => void }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const about = () => void askUser({ title: 'About Driftboard', message: 'A local-first desktop app for making short AI films. ComfyUI makes the pictures and clips, an LLM server (LM Studio, Ollama or similar) writes; everything stays on this computer.\n\nFree software under the GPL-3.0 licence. The name and logo are not covered by the GPL (see BRAND.md).', buttons: [{ id: 'ok', label: 'Close', kind: 'primary' }] });
  const items: MenuItem[] = [
    { label: 'Projects…', icon: 'folder', onClick: openProjects },
    { label: 'Settings', icon: 'settings', onClick: () => openSettings() },
    { label: 'Keyboard shortcuts', icon: 'keyboard', onClick: () => openSettings('keys') },
    { sep: true },
    { label: 'About Driftboard', icon: 'info', onClick: about },
  ];
  return (
    <header className="top" data-undo-ignore="" data-area="top">
      <button type="button" className="logo" title="Driftboard menu" aria-label="Driftboard menu" aria-haspopup="menu" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom + 6 }); }}><Wordmark height={15} /></button>
      {menu && <Menu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} label="Driftboard menu" />}
      <span className="vsep" />
      <button type="button" className="topBtn" title="Projects: switch, open, new" onClick={openProjects}><Icon name="folder" /><b>{project ? project.name : 'Projects'}</b><Icon name="chev" size="s" /></button>
      {project && <FilmChip />}
      <span className="sp" />
      {project && <UndoButton notify={notify} />}
      <span className="vsep" />
      <ComfyPill comfy={comfy} refresh={refreshComfy} openSettings={openSettings} />
      <LlmPill openSettings={openSettings} notify={notify} />
      <span className="vsep" />
      <ThemeSwitch />
    </header>
  );
}

/** One Undo/Redo for the whole app. It acts on the area the pointer was over last and says which, like Ctrl+Z. */
function UndoButton({ notify }: { notify: (m: string) => void }) {
  const t = useUndoTarget();
  useContext(C);   // re-render when the project's history changes
  const info = undoInfo(t);
  const outline = (on: boolean) => { if (t?.el) t.el.classList.toggle('areaOutline', on); };
  useEffect(() => () => outline(false));
  const what = t ? `${t.area}${info?.undo ? `: ${info.undo}` : ''}` : 'point at an area first';
  const redoWhat = t ? `${t.area}${info?.redo ? `: ${info.redo}` : ''}` : '';
  return (
    <div className="undoBtn" onMouseEnter={() => outline(true)} onMouseLeave={() => outline(false)}>
      <button type="button" disabled={!info?.canUndo} title={`Undo (${bindOf('canvas.undo')}) acts on the area under the pointer: ${what}`} onClick={() => undoInLast(false, notify)}>
        <Icon name="undo" /><span className="scope">{info?.canUndo ? `Undo · ${what}` : t ? `Nothing to undo · ${t.area}` : 'Undo'}</span>
      </button>
      <button type="button" disabled={!info?.canRedo} title={`Redo (${bindOf('canvas.redo')})${redoWhat ? ': ' + redoWhat : ''}`} aria-label={`Redo${redoWhat ? ' · ' + redoWhat : ''}`} onClick={() => undoInLast(true, notify)}><Icon name="redo" /></button>
    </div>
  );
}

/* ---------- connection pills ---------- */
function ComfyPill({ comfy, refresh, openSettings }: { comfy: ComfyState; refresh: () => void; openSettings: (p?: SettingsPane) => void }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [health, setHealth] = useState<{ ready: number; broken: number } | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    if (!anchor || !comfy?.ok) { setHealth(null); return; }
    let live = true;
    void api.comfyHealth().then((h) => { if (live) setHealth({ ready: h.filter((x) => x.ok).length, broken: h.filter((x) => !x.ok).length }); }).catch(() => {});
    return () => { live = false; };
  }, [anchor, comfy?.ok]);
  const ok = !!comfy?.ok;
  return (
    <>
      <button type="button" className={'conn' + (anchor ? ' open' : '')} aria-haspopup="dialog" aria-expanded={!!anchor} title={ok ? `ComfyUI ${comfy?.version ?? ''} at ${comfy?.url}` : comfy?.error ?? 'ComfyUI not reachable'} onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}>
        <span className={'dot' + (ok ? ' ok' : '')} />ComfyUI{ok ? '' : ' offline'}
      </button>
      {anchor && <Popover anchor={anchor} align="end" onClose={() => setAnchor(null)} width={360}>
        <div className="row"><span className={'dot' + (ok ? ' ok' : '')} /><h4 style={{ margin: 0 }}>ComfyUI</h4><span className="sp" /><span className="xs dim">{comfy ? (ok ? `Connected · version ${comfy.version}` : 'Not reachable') : 'Checking…'}</span></div>
        {!ok && <div className="notice bad"><Icon name="warn" /><div className="nb small">{comfy?.error ? `${comfy.error}. ` : ''}Nothing answers at this address. Start ComfyUI, or change the address. Generations wait in the queue until it is back.</div></div>}
        <Field label="Server address">
          <div className="row">
            <input className="inp mono" defaultValue={comfy?.url} key={comfy?.url} onBlur={async (e) => { if (e.target.value && e.target.value !== comfy?.url) { await api.setComfyUrl(e.target.value); refresh(); } }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
            <Button size="sm" icon="regen" disabled={checking} onClick={async () => { setChecking(true); try { await refresh(); } finally { setChecking(false); } }}>{checking ? 'Checking…' : 'Check again'}</Button>
          </div>
        </Field>
        {health && <div className="row">{health.ready > 0 && <Chip tone="ok" icon="check">{health.ready} workflow{health.ready === 1 ? '' : 's'} ready</Chip>}{health.broken > 0 && <Chip tone="bad" icon="warn">{health.broken} need{health.broken === 1 ? 's' : ''} a model file or node</Chip>}</div>}
        <div className="row"><span className="sp" /><Button size="sm" onClick={() => { setAnchor(null); openSettings('comfy'); }}>Open settings</Button></div>
      </Popover>}
    </>
  );
}

function LlmPill({ openSettings, notify }: { openSettings: (p?: SettingsPane) => void; notify: (m: string) => void }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [st, setSt] = useState<LlmStatus | null>(null);
  const [prog, setProg] = useState<LlmProgress | null>(null);
  const [dir, setDir] = useState<DirectorProgress | null>(null);
  const load = useCallback(async () => { try { setSt(await api.llmStatus()); } catch { /* keep the last state */ } }, []);
  useEffect(() => { void load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, [load]);
  useEffect(() => { if (anchor) void load(); }, [anchor, load]);
  useEffect(() => api.onLlmProgress((p) => setProg(p.running ? p : null)), []);
  useEffect(() => api.onDirectorProgress((p) => setDir(p.running ? p : null)), []);
  const busy = prog ?? (dir ? { label: dir.label, done: dir.done, total: dir.total, running: true } : null);
  const loaded = st?.models.find((m) => m.loaded && !m.embedding);
  const kind = st?.caps?.kind === 'lmstudio' ? 'LM Studio' : st?.caps?.kind === 'ollama' ? 'Ollama' : st?.caps ? 'OpenAI-compatible server' : 'LLM server';
  return (
    <>
      <button type="button" className={'conn' + (anchor ? ' open' : '')} aria-haspopup="dialog" aria-expanded={!!anchor} title={st?.ok ? `${kind} at ${st.url}` : st?.error ?? 'LLM server not reachable'} onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}>
        <span className={'dot' + (busy ? ' busy' : st?.ok ? ' idle' : '')} />LLM{busy ? ' · writing' : st?.ok ? (loaded ? ' · loaded' : ' · idle') : ' offline'}
      </button>
      {anchor && <Popover anchor={anchor} align="end" onClose={() => setAnchor(null)} width={360}>
        <div className="row"><span className={'dot' + (busy ? ' busy' : st?.ok ? ' ok' : '')} /><h4 style={{ margin: 0 }}>LLM</h4><span className="sp" /><span className="xs dim">{st ? (st.ok ? `${kind} · connected` : 'Not reachable') : 'Checking…'}</span></div>
        {st && !st.ok && <div className="notice bad"><Icon name="warn" /><div className="nb small">{st.error ? `${st.error}. ` : ''}Start your LLM server (LM Studio, Ollama…) or change its address in Settings › LLM.</div></div>}
        <dl className="facts">
          <dt>Model</dt><dd>{loaded ? `${loaded.id} · loaded${loaded.context ? ` (${Math.round(loaded.context / 1024)}k)` : ''}` : st?.model ? `${st.model} · not loaded` : 'first available · not loaded'}</dd>
          <dt>GPU</dt><dd>{loaded ? 'in use by the LLM' : 'free for ComfyUI'}</dd>
        </dl>
        {busy && <div className="working"><div className="row"><Spinner /><b className="small" style={{ flex: 1 }}>{busy.label}{busy.total > 0 ? ` · ${busy.done} of ${busy.total}` : ''}</b><Button size="sm" onClick={() => void (prog ? api.llmCancel() : api.directorCancel())}>Cancel</Button></div><Progress value={busy.total > 0 ? busy.done / busy.total : undefined} label={busy.label} /></div>}
        <div className="row">
          <Button size="sm" icon="chip" title="Unload every loaded model to free GPU memory" onClick={async () => { const n = await api.llmUnload(); notify(`Unloaded ${n} model${n === 1 ? '' : 's'}`); void load(); }}>Free GPU</Button>
          <span className="sp" /><Button size="sm" onClick={() => { setAnchor(null); openSettings('llm'); }}>Open settings</Button>
        </div>
      </Popover>}
    </>
  );
}

/* ---------- rail ---------- */
const RAIL: { id: PanelId; icon: IconName; label: string }[] = [
  { id: 'create', icon: 'create', label: 'Create' }, { id: 'story', icon: 'story', label: 'Story' },
  { id: 'assistant', icon: 'assistant', label: 'Assistant' }, { id: 'library', icon: 'library', label: 'Library' },
];
export function Rail({ panel, onPanel, openSettings }: { panel: PanelId | null; onPanel: (p: PanelId) => void; openSettings: () => void }) {
  const { jobs } = useContext(C);
  const active = jobs.filter((j) => j.status === 'running' || j.status === 'queued').length;
  const item = (id: PanelId, icon: IconName, label: string, extra?: ReactNode) => (
    <button key={id} type="button" className={panel === id ? 'on' : ''} aria-pressed={panel === id} title={panel === id ? `Close ${label}` : label} onClick={() => onPanel(id)}><Icon name={icon} size={19} /><span>{label}</span>{extra}</button>
  );
  return (
    <nav className="rail" aria-label="Panels">
      {RAIL.map((r) => item(r.id, r.icon, r.label))}
      <span className="sp" />
      {item('activity', 'activity', 'Activity', active > 0 ? <i className="badge run" aria-label={`${active} running or queued`}>{active}</i> : undefined)}
      <button type="button" title="Settings" onClick={openSettings}><Icon name="settings" size={19} /><span>Settings</span></button>
    </nav>
  );
}

/* ---------- panel frame: a floating panel with fold / top buttons in its corner ---------- */
/** Fold every card, open every card, back to the top: for long lists (Story, Activity). Replaces the old floating FoldBar. */
export function PanelTools({ folds, scroller }: { folds: boolean; scroller: () => HTMLElement | null }) {
  const [top, setTop] = useState(true);
  useEffect(() => {
    const s = scroller(); if (!s) return;
    s.classList.remove('folded'); s.querySelectorAll('.unfold').forEach((e) => e.classList.remove('unfold'));
    const onScroll = () => setTop(s.scrollTop < 120);
    const onClick = (e: MouseEvent) => {
      if (!s.classList.contains('folded')) return;
      const t = e.target as HTMLElement; const card = t.closest('.vcard, .queueCard') as HTMLElement | null;
      if (!card || t.closest('button, input, select, textarea, a, summary, label, details')) return;
      if (card.firstElementChild?.contains(t)) card.classList.toggle('unfold');
    };
    s.addEventListener('scroll', onScroll); s.addEventListener('click', onClick); onScroll();
    return () => { s.removeEventListener('scroll', onScroll); s.removeEventListener('click', onClick); s.classList.remove('folded'); };
  }, [scroller]);
  const fold = (open: boolean) => { const s = scroller(); if (!s) return; s.classList.toggle('folded', !open); s.querySelectorAll('.unfold').forEach((e) => e.classList.remove('unfold')); window.dispatchEvent(new CustomEvent('driftboard-fold', { detail: { open } })); };
  return (
    <div className="ptools">
      {folds && <IconButton size="sm" icon="up" label="Fold every card" onClick={() => fold(false)} />}
      {folds && <IconButton size="sm" icon="chev" label="Open every card" onClick={() => fold(true)} />}
      {!top && <IconButton size="sm" icon="up" label="Back to the top" onClick={() => scroller()?.scrollTo({ top: 0, behavior: 'smooth' })} />}
    </div>
  );
}

/* ---------- status bar ---------- */
type Area = 'canvas' | 'timeline' | 'story' | 'library' | 'create' | 'assistant' | 'activity' | 'viewer';
function useAreaUnderPointer(): Area {
  const [area, setArea] = useState<Area>('canvas');
  useEffect(() => {
    const f = (e: PointerEvent) => { const a = (e.target as HTMLElement | null)?.closest?.('[data-area]')?.getAttribute('data-area') as Area | null; if (a && a !== ('top' as Area)) setArea((c) => (c === a ? c : a)); };
    window.addEventListener('pointermove', f, { passive: true }); return () => window.removeEventListener('pointermove', f);
  }, []);
  return area;
}
function hintsFor(area: Area): [string, string][] {
  switch (area) {
    case 'timeline': return [[bindOf('timeline.split'), 'split'], [bindOf('timeline.delete'), 'delete'], [bindOf('timeline.rippleDelete'), 'ripple delete'], [bindOf('timeline.play'), 'play'], ['Alt+click', 'one clip'], ['Ctrl+wheel', 'zoom']];
    case 'story': return [[bindOf('canvas.undo'), 'undo in Story'], ['Double-click', 'rename']];
    case 'library': return [[bindOf('library.selectAll'), 'select all'], [bindOf('library.delete'), 'to Trash'], ['Drag', 'onto the canvas']];
    case 'viewer': return [[bindOf('preview.play'), 'play'], [bindOf('preview.prevFrame') + ' / ' + bindOf('preview.nextFrame'), 'frame'], [bindOf('preview.fullscreen'), 'full screen']];
    default: return [['Drag', 'pan'], ['Shift+drag', 'select'], ['Right-click', 'menu']];
  }
}
/** One line along the bottom: what is running (with %), what is queued, LLM work, export, the latest error, messages, and keyboard hints for the area under the pointer. */
export function StatusBar({ openActivity, unread }: { openActivity: (tab: 'jobs' | 'messages' | 'log') => void; unread: number }) {
  const { jobs, progress } = useContext(C);
  const title = useProfileTitle();
  const area = useAreaUnderPointer();
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
  const running = jobs.find((j) => j.status === 'running');
  const queued = jobs.filter((j) => j.status === 'queued').length;
  const f = running ? progress[running.id] ?? running.progress ?? 0 : 0;
  const pct = (x: number) => `${Math.round(Math.max(0, Math.min(1, x)) * 100)}%`;
  const hints = hintsFor(area);
  const idle = !running && !queued && !llm && !dir && exp === null && !Object.keys(misc).length;
  const item = (key: string, body: ReactNode, open?: () => void, cancel?: { label: string; run: () => void }, cls = 'it', title?: string) => (
    <span key={key} className={cls}>
      {open ? <button type="button" className="itMain" title={title ?? 'Open Activity'} onClick={open}>{body}</button> : <span className="itMain">{body}</span>}
      {cancel && <button type="button" className="x" aria-label={cancel.label} title={cancel.label} onClick={cancel.run}><Icon name="x" size="s" /></button>}
    </span>
  );
  return (
    <footer className="status" role="status" data-undo-ignore="">
      {running && item('job', <><Spinner /><span className="lbl">Running · {title(running.profile_id)}</span><Progress value={f} label="Progress" style={{ width: 70 }} /><span className="mono">{pct(f)}</span></>, () => openActivity('jobs'), { label: 'Cancel this generation', run: () => void api.cancel(running.id) }, 'it', 'Open Activity › Jobs')}
      {queued > 0 && item('q', <>{queued} queued</>, () => openActivity('jobs'))}
      {llm && item('llm', <><Spinner /><span className="lbl">LLM · {llm.label}{llm.total > 0 ? ` ${llm.done}/${llm.total}` : ''}</span></>, () => openActivity('jobs'), { label: 'Cancel the LLM work', run: () => void api.llmCancel() })}
      {dir && item('dir', <><Spinner /><span className="lbl">Story plan · {dir.label}{dir.total > 0 ? ` ${dir.done}/${dir.total}` : ''}</span></>, () => openActivity('jobs'), { label: 'Cancel', run: () => void api.directorCancel() })}
      {Object.entries(misc).filter(([id]) => !(id.startsWith('director-') && dir)).map(([id, label]) => item(id, <><Spinner /><span className="lbl">{label}</span></>))}
      {exp !== null && item('exp', <><Spinner /><span className="lbl">Exporting the film</span><span className="mono">{pct(exp)}</span></>, undefined, { label: 'Cancel the export', run: () => void api.exportCancel() })}
      {idle && !alert && <span className="it faint"><span className="itMain">Idle</span></span>}
      {alert && item('err', <><Icon name="warn" size="s" /><span className="lbl">{alert.source}: {alert.msg.slice(0, 160)}</span></>, () => openActivity('log'), { label: 'Dismiss', run: () => setAlert(null) }, 'it err', `${alert.msg}

Click to open the log`)}
      {item('msg', <><Icon name="bell" size="s" />{unread ? `${unread > 99 ? '99+' : unread} new` : 'Messages'}</>, () => openActivity('messages'), undefined, 'it', 'Messages: everything that popped up')}
      <span className="hints" aria-label="Keyboard hints">{hints.map(([k, l]) => <span key={k + l}><b>{k}</b> {l}</span>)}</span>
    </footer>
  );
}

/** Drag handle between panels: drag to resize, double-click to reset. */
export function Gutter({ axis, onStart, onDrag, onReset, label }: { axis: 'x' | 'y'; onStart: () => void; onDrag: (delta: number) => void; onReset?: () => void; label: string }) {
  const start = useRef(0);
  return <div className={'gut ' + axis} role="separator" aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'} aria-label={label} title={`${label}: drag to resize${onReset ? ', double-click to reset' : ''}`} onDoubleClick={onReset}
    onPointerDown={(e) => {
      e.preventDefault(); start.current = axis === 'x' ? e.clientX : e.clientY; onStart();
      const move = (ev: PointerEvent) => onDrag((axis === 'x' ? ev.clientX : ev.clientY) - start.current);
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    }} />;
}
