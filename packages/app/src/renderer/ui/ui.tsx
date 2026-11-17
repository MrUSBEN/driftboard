/* Shared components of the Sand Atelier design. Every panel builds on these, so a button, a menu or a dialog looks
   and behaves the same everywhere. Styles: ui.css. */
import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon.tsx';
import { useTheme, type ThemeChoice } from '../theme/theme.ts';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/* ---------- buttons ---------- */
export type ButtonKind = 'primary' | 'secondary' | 'quiet' | 'danger' | 'danger-solid';
type BtnProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> & { kind?: ButtonKind; size?: 'sm' | 'md'; icon?: IconName; iconRight?: IconName; on?: boolean; wide?: boolean; hint?: string; type?: 'button' | 'submit' };
const kindCls = (k: ButtonKind) => (k === 'primary' ? 'pri' : k === 'quiet' ? 'quiet' : k === 'danger' ? 'danger' : k === 'danger-solid' ? 'danger solid' : '');
/** A button with a clear weight: one primary per panel, secondary by default, quiet for rare actions, danger for removal. */
export function Button({ kind = 'secondary', size = 'md', icon, iconRight, on, wide, hint, className, children, type = 'button', ...rest }: BtnProps) {
  return <button type={type} className={cx('btn', kindCls(kind), size === 'sm' && 'sm', on && 'on', wide && 'wide', className)} aria-pressed={on === undefined ? undefined : on} {...rest}>
    {icon && <Icon name={icon} size={size === 'sm' ? 's' : 'm'} />}{children}{iconRight && <Icon name={iconRight} size="s" />}{hint && <span className="k">{hint}</span>}
  </button>;
}
/** A button with only an icon: the label is required and becomes the tooltip and the accessible name. */
export function IconButton({ icon, label, kind = 'quiet', size = 'md', on, className, ...rest }: Omit<BtnProps, 'children' | 'icon'> & { icon: IconName; label: string }) {
  return <button type="button" className={cx('btn icon', kindCls(kind), size === 'sm' && 'sm', on && 'on', className)} title={rest.title ?? label} aria-label={label} aria-pressed={on === undefined ? undefined : on} {...rest}><Icon name={icon} size={size === 'sm' ? 's' : 'm'} /></button>;
}

/* ---------- segmented control ---------- */
export interface SegOption<T extends string> { value: T; label?: ReactNode; icon?: IconName; count?: number; title?: string; ariaLabel?: string }
export function Seg<T extends string>({ options, value, onChange, label, size, className }: { options: SegOption<T>[]; value: T; onChange: (v: T) => void; label: string; size?: 'sm'; className?: string }) {
  return <div className={cx('seg', size, className)} role="radiogroup" aria-label={label}>
    {options.map((o) => <button key={o.value} type="button" role="radio" aria-checked={o.value === value} aria-label={o.ariaLabel} title={o.title ?? o.ariaLabel} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
      {o.icon && <Icon name={o.icon} size="s" />}{o.label}{o.count !== undefined && <span className="n">{o.count}</span>}
    </button>)}
  </div>;
}

/* ---------- ×N stepper (Results ×N, Takes ×N; ComfyUI calls it batch size) ---------- */
export function Stepper({ value, onChange, min = 1, max = 12, label = 'Results', size, title }: { value: number; onChange: (n: number) => void; min?: number; max?: number; label?: string; size?: 'sm'; title?: string }) {
  const set = (n: number) => onChange(Math.min(max, Math.max(min, n)));
  return <span className={cx('stepN', size)} role="group" aria-label={`${label}: ${value}`} title={title ?? `${label} ×${value}: how many to make, each with a new seed (ComfyUI calls this batch size)`}>
    <button type="button" aria-label={`Fewer ${label.toLowerCase()}`} disabled={value <= min} onClick={() => set(value - 1)}><Icon name="minus" size="s" /></button>
    <output aria-live="polite">×{value}</output>
    <button type="button" aria-label={`More ${label.toLowerCase()}`} disabled={value >= max} onClick={() => set(value + 1)}><Icon name="plus" size="s" /></button>
  </span>;
}

/* ---------- fields ---------- */
export function Field({ label, hint, children, style }: { label: ReactNode; hint?: string; children: ReactNode; style?: CSSProperties }) {
  return <label className="field" style={style}><span className="lbl" title={hint}>{label}</span>{children}</label>;
}
export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} title={label} disabled={disabled} className={cx('toggle', on && 'on')} onClick={() => onChange(!on)} />;
}

/* ---------- chips and status ---------- */
export type Tone = 'ok' | 'warn' | 'bad' | 'coral';
/** A small label. With onClick it is a toggle chip; with onRemove it gets a × to take it away. */
export function Chip({ children, tone, on, onClick, onRemove, removeLabel, icon, title }: { children: ReactNode; tone?: Tone; on?: boolean; onClick?: () => void; onRemove?: () => void; removeLabel?: string; icon?: IconName; title?: string }) {
  const inner = <>{icon && <Icon name={icon} size={12} />}{children}{onRemove && <button type="button" className="x" aria-label={removeLabel ?? 'Remove'} title={removeLabel ?? 'Remove'} onClick={(e) => { e.stopPropagation(); onRemove(); }}><Icon name="x" size={11} /></button>}</>;
  const cls = cx('chip', tone, on && 'on');
  return onClick ? <button type="button" className={cls} aria-pressed={on} title={title} onClick={onClick}>{inner}</button> : <span className={cls} title={title}>{inner}</span>;
}

/** Job status words, the same everywhere: Queued, Running %, Done, Failed, Cancelled, Interrupted. */
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted' | string;
export function jobStatusWord(status: JobStatus, pct?: number): string {
  switch (status) {
    case 'queued': return 'Queued';
    case 'running': return pct !== undefined && pct > 0 ? `Running ${Math.round(pct * 100)}%` : 'Running';
    case 'done': return 'Done';
    case 'failed': return 'Failed';
    case 'cancelled': return 'Cancelled';
    case 'interrupted': return 'Interrupted';
    default: return status ? status[0]!.toUpperCase() + status.slice(1) : '';
  }
}
const jobTone = (s: JobStatus) => (s === 'running' ? 'run' : s === 'done' ? 'ok' : s === 'failed' ? 'bad' : s === 'queued' ? 'q' : 'cx');
export function StatusPill({ status, pct, title }: { status: JobStatus; pct?: number; title?: string }) {
  return <span className={cx('pill', jobTone(status))} title={title}>{jobStatusWord(status, pct)}</span>;
}
/** Take status words: Pick ★, Approved ✓, Rejected ✗, Draft. */
export type TakeStatus = 'pick' | 'approved' | 'rejected' | 'draft';
export const TAKE_WORD: Record<TakeStatus, string> = { pick: 'Pick', approved: 'Approved', rejected: 'Rejected', draft: 'Draft' };
export const TAKE_ICON: Record<TakeStatus, IconName | null> = { pick: 'starf', approved: 'check', rejected: 'x', draft: null };
export function TakePill({ status }: { status: TakeStatus }) {
  const ic = TAKE_ICON[status];
  return <span className={cx('pill', status === 'pick' ? 'pick' : status === 'approved' ? 'ok' : status === 'rejected' ? 'bad' : 'q')}>{ic && <Icon name={ic} size={11} />}{TAKE_WORD[status]}</span>;
}

/* ---------- progress ---------- */
/** Determinate (value 0..1) or working (no value). */
export function Progress({ value, label, style }: { value?: number; label?: string; style?: CSSProperties }) {
  const pct = value === undefined ? undefined : Math.round(Math.min(1, Math.max(0, value)) * 100);
  return <div className={cx('prog', pct === undefined && 'indet')} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} style={style}><i style={pct === undefined ? undefined : { width: `${pct}%` }} /></div>;
}
export const Spinner = ({ label }: { label?: string }) => <span className="spin" role={label ? 'status' : undefined} aria-label={label} />;

/* ---------- notices and empty states ---------- */
export function Notice({ tone = 'info', children, icon, style }: { tone?: 'info' | 'warn' | 'bad'; children: ReactNode; icon?: IconName; style?: CSSProperties }) {
  return <div className={cx('notice', tone)} role={tone === 'bad' ? 'alert' : undefined} style={style}><Icon name={icon ?? (tone === 'info' ? 'info' : 'warn')} /><div className="nb">{children}</div></div>;
}
export function Empty({ icon = 'info', title, children }: { icon?: IconName; title?: string; children?: ReactNode }) {
  return <div className="dempty"><Icon name={icon} size={28} />{title && <b>{title}</b>}{children}</div>;
}

/* ---------- tiles (input pictures, takes, lineage) ---------- */
export function Tile({ src, alt = '', kind = 'image', badge, onRemove, removeLabel, onPrepare, small, smallTitle, big, title, onClick, style, children }: { src?: string; alt?: string; kind?: 'image' | 'video' | 'audio'; badge?: ReactNode; onRemove?: () => void; removeLabel?: string; onPrepare?: () => void; small?: boolean; smallTitle?: string; big?: boolean; title?: string; onClick?: () => void; style?: CSSProperties; children?: ReactNode }) {
  return <div className={cx('tile', kind === 'audio' && 'audio', big && 'big')} title={title} style={style} onClick={onClick}>
    {kind === 'audio' ? <Icon name="sound" size="l" /> : src ? <img src={src} alt={alt} draggable={false} /> : null}
    {badge !== undefined && <span className="num">{badge}</span>}
    {onRemove && <button type="button" className="rm" aria-label={removeLabel ?? 'Remove'} title={removeLabel ?? 'Remove'} onClick={(e) => { e.stopPropagation(); onRemove(); }}><Icon name="x" size={11} /></button>}
    {onPrepare && <button type="button" className={cx('prepB', small && 'small')} title={small ? (smallTitle ?? 'Smaller than the size this job runs at: Prepare can upscale it') : 'Prepare this input'} onClick={(e) => { e.stopPropagation(); onPrepare(); }}><Icon name="prep" size={10} />Prepare</button>}
    {children}
  </div>;
}
export const AddTile = ({ label, onClick, icon = 'plus' }: { label: string; onClick: () => void; icon?: IconName }) => <button type="button" className="tile add" onClick={onClick}><Icon name={icon} />{label}</button>;

/* ---------- card, section ---------- */
export const Card = ({ children, sel, onClick, className, style }: { children: ReactNode; sel?: boolean; onClick?: () => void; className?: string; style?: CSSProperties }) =>
  <div className={cx('dcard', sel && 'sel', onClick && 'hover', className)} style={style} onClick={onClick}>{children}</div>;
/** A section with a header (icon, title, count, actions). With fold it opens and closes; foldKey remembers the state. */
export function Section({ title, icon, count, actions, fold, foldKey, defaultOpen = true, children, style }: { title: ReactNode; icon?: IconName; count?: ReactNode; actions?: ReactNode; fold?: boolean; foldKey?: string; defaultOpen?: boolean; children: ReactNode; style?: CSSProperties }) {
  const [open, setOpenS] = useState(() => { if (!foldKey) return defaultOpen; try { const v = localStorage.getItem('driftboard.fold.' + foldKey); return v === null ? defaultOpen : v === '1'; } catch { return defaultOpen; } });
  const setOpen = (o: boolean) => { setOpenS(o); if (foldKey) try { localStorage.setItem('driftboard.fold.' + foldKey, o ? '1' : '0'); } catch { /* ignore */ } };
  const head = <>{icon && <Icon name={icon} />}<span>{title}</span>{count !== undefined && <span className="n">{count}</span>}</>;
  return <div className={cx('sect', fold && 'fold', fold && !open && 'closed')} style={style}>
    {fold ? <div className="sh" role="button" tabIndex={0} aria-expanded={open} onClick={() => setOpen(!open)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!open); } }}>{head}<span className="acts" onClick={(e) => e.stopPropagation()}>{actions}<Icon name="chev" size="s" className="chev" /></span></div>
      : <div className="sh">{head}{actions && <span className="acts">{actions}</span>}</div>}
    {(!fold || open) && <div className="sbody">{children}</div>}
  </div>;
}

/* ---------- overlays: shared closing behaviour ---------- */
function useDismiss(ref: React.RefObject<HTMLElement | null>, onClose: () => void, ignore?: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const down = (e: MouseEvent) => { const t = e.target as Node; if (ref.current?.contains(t) || ignore?.current?.contains(t)) return; onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const t = setTimeout(() => window.addEventListener('mousedown', down, true), 0);
    window.addEventListener('keydown', key, true);
    return () => { clearTimeout(t); window.removeEventListener('mousedown', down, true); window.removeEventListener('keydown', key, true); };
  }, [ref, onClose, ignore]);
}
/** Keep a fixed box inside the window. */
function useFit(ref: React.RefObject<HTMLElement | null>, x: number, y: number) {
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) });
  }, [ref, x, y]);
  return pos;
}

/* ---------- menu ---------- */
export type MenuItem =
  | { header: string }
  | { sep: true }
  | { label: string; icon?: IconName; hint?: string; sub?: string; danger?: boolean; disabled?: boolean; recommended?: boolean; title?: string; onClick: () => void };
/** A right-click or ⋯ menu: labelled groups, shortcut hints, danger items, disabled items with a reason, a "recommended" tag. ↑ ↓ Enter Esc work. */
export function Menu({ x, y, items, onClose, label = 'Menu' }: { x: number; y: number; items: MenuItem[]; onClose: () => void; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);
  const pos = useFit(ref, x, y);
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>('.mi:not(:disabled)')?.focus(); }, []);
  const nav = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const list = [...(ref.current?.querySelectorAll<HTMLButtonElement>('.mi:not(:disabled)') ?? [])];
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
  };
  return createPortal(<div ref={ref} className="dmenu" role="menu" aria-label={label} style={pos} onKeyDown={nav} onContextMenu={(e) => e.preventDefault()}>
    {items.map((it, i) => 'header' in it ? <div key={i} className="mh">{it.header}</div> : 'sep' in it ? <div key={i} className="msep" role="separator" /> :
      <button key={i} type="button" role="menuitem" className={cx('mi', it.danger && 'danger')} disabled={it.disabled} title={it.title} onClick={() => { onClose(); it.onClick(); }}>
        {it.icon ? <Icon name={it.icon} /> : <span style={{ width: 16, flex: 'none' }} />}
        <span className="mt">{it.label}{it.recommended && <span className="rec">recommended</span>}{it.sub && <span className="sub2">{it.sub}</span>}</span>
        {it.hint && <span className="hk">{it.hint}</span>}
      </button>)}
  </div>, document.body);
}

/* ---------- popover ---------- */
/** A floating card under (or beside) an anchor element. Closes on Esc or a click outside. */
export function Popover({ anchor, onClose, children, width = 340, title, align = 'start', style }: { anchor: HTMLElement | null; onClose: () => void; children: ReactNode; width?: number; title?: string; align?: 'start' | 'end'; style?: CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  const aRef = useRef<HTMLElement | null>(anchor); aRef.current = anchor;
  useDismiss(ref, onClose, aRef);
  const r = anchor?.getBoundingClientRect();
  const pos = useFit(ref, r ? (align === 'end' ? r.right - width : r.left) : 100, r ? r.bottom + 6 : 100);
  return createPortal(<div ref={ref} className="dpop" role="dialog" aria-label={title} style={{ ...pos, width, ...style }}>{title && <h4>{title}</h4>}{children}</div>, document.body);
}

/* ---------- dialog ---------- */
/** The app's own dialog: title, body, right-aligned buttons. Esc and a click outside cancel. */
export function Dialog({ title, children, footer, onClose, width, icon, labelledBy }: { title: ReactNode; children?: ReactNode; footer?: ReactNode; onClose: () => void; width?: 'w2' | 'w3' | number; icon?: IconName; labelledBy?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useRef(labelledBy ?? 'dlg' + Math.random().toString(36).slice(2, 8)).current;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current?.querySelector<HTMLElement>('.df .btn.pri, .df .btn.danger, .df .btn, input, textarea, select');
    el?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('keydown', key, true); prev?.focus?.(); };
  }, [onClose]);
  return createPortal(<div className="dscrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={ref} className={cx('dlg', typeof width === 'string' && width)} style={typeof width === 'number' ? { width } : undefined} role="dialog" aria-modal="true" aria-labelledby={id}>
      <div className="dh">{icon && <Icon name={icon} size="l" />}<h3 id={id}>{title}</h3></div>
      {children !== undefined && <div className="db">{children}</div>}
      {footer && <div className="df">{footer}</div>}
    </div>
  </div>, document.body);
}

/* ---------- sheet ---------- */
export interface SheetNav<T extends string> { id: T; label: string; icon?: IconName }
/** A full sheet over the app (Settings, Projects) with its own side navigation. */
export function Sheet<T extends string>({ title, nav, current, onNav, onClose, children }: { title: string; nav?: SheetNav<T>[]; current?: T; onNav?: (id: T) => void; onClose: () => void; children: ReactNode }) {
  useEffect(() => { const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.dscrim, .dmenu, .dpop')) { e.stopPropagation(); onClose(); } }; window.addEventListener('keydown', key, true); return () => window.removeEventListener('keydown', key, true); }, [onClose]);
  return createPortal(<div className="dscrim" style={{ zIndex: 1100 }} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className={cx('dsheet', !nav && 'single')} role="dialog" aria-modal="true" aria-label={title}>
      {nav && <nav aria-label={title}><div className="navT">{title}</div>{nav.map((n) => <button key={n.id} type="button" className={n.id === current ? 'on' : ''} aria-current={n.id === current ? 'page' : undefined} onClick={() => onNav?.(n.id)}>{n.icon && <Icon name={n.icon} />}{n.label}</button>)}</nav>}
      <div className="sc">{children}</div>
      <IconButton className="close" icon="x" label="Close" onClick={onClose} />
    </div>
  </div>, document.body);
}

/* ---------- toasts with Undo ---------- */
interface ToastReq { id: number; msg: string; tone?: 'ok' | 'bad'; undo?: () => void; ms: number }
let toastN = 0;
/** Show a short message at the bottom right; with undo it gets an Undo button. Messages are also kept in Activity › Messages by the app. */
export const showToast = (msg: string, o: { tone?: 'ok' | 'bad'; undo?: () => void; ms?: number } = {}) => window.dispatchEvent(new CustomEvent('driftboard-toast', { detail: { id: ++toastN, msg, tone: o.tone, undo: o.undo, ms: o.ms ?? (o.undo ? 7000 : 4000) } satisfies ToastReq }));
export function ToastHost() {
  const [list, setList] = useState<ToastReq[]>([]);
  useEffect(() => {
    const f = (e: Event) => { const t = (e as CustomEvent<ToastReq>).detail; setList((l) => [...l.filter((x) => x.msg !== t.msg).slice(-3), t]); setTimeout(() => setList((l) => l.filter((x) => x.id !== t.id)), t.ms); };
    window.addEventListener('driftboard-toast', f); return () => window.removeEventListener('driftboard-toast', f);
  }, []);
  if (!list.length) return null;
  return createPortal(<div className="dtoasts" role="status" aria-live="polite">{list.map((t) => <div key={t.id} className={cx('dtoast', t.tone === 'bad' && 'bad')}>
    <Icon name={t.tone === 'bad' ? 'warn' : 'check'} /><span className="tm">{t.msg}</span>
    {t.undo && <button type="button" className="btn sm" onClick={() => { t.undo!(); setList((l) => l.filter((x) => x.id !== t.id)); }}><Icon name="undo" size="s" />Undo</button>}
    <button type="button" className="btn sm icon" aria-label="Dismiss" title="Dismiss" onClick={() => setList((l) => l.filter((x) => x.id !== t.id))}><Icon name="x" size="s" /></button>
  </div>)}</div>, document.body);
}

/* ---------- theme switch ---------- */
const THEMES: SegOption<ThemeChoice>[] = [{ value: 'system', icon: 'monitor', ariaLabel: 'System: follow Windows' }, { value: 'light', icon: 'sun', ariaLabel: 'Light' }, { value: 'dark', icon: 'moon', ariaLabel: 'Dark' }];
/** System / Light / Dark. Lives at the right end of the top bar and in Settings › Appearance. */
export function ThemeSwitch({ withLabels }: { withLabels?: boolean }) {
  const t = useTheme();
  return <Seg className="themeSw" label="Theme" value={t.choice} onChange={t.set} options={withLabels ? THEMES.map((o) => ({ ...o, label: o.value === 'system' ? 'System' : o.value === 'light' ? 'Light' : 'Dark' })) : THEMES} />;
}
