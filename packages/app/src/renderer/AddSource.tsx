/* One "add" control for the whole app. Press a + / Add button and get the same three ways in, wherever you are:
   the pictures selected on the canvas, picking on the canvas (the app waits while you click), or the Library in a small picker.
   Upload from the computer is the fourth row. Nothing is ever silently ignored when nothing is selected. */
import { useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { C, api, thumbUrl, type Asset } from './shared.tsx';
import { assetName } from './Canvas.tsx';
import { Icon } from './ui/Icon.tsx';
import { Button, Menu, Popover, type MenuItem } from './ui/ui.tsx';
import './addsource.css';

export type Kind = 'image' | 'video' | 'audio';

/* ---- pick on the canvas: a small shared state, shown as a banner by the app ---- */
interface Pick { kinds: Kind[]; max: number; what: string; resolve: (ids: string[] | null) => void }
let current: Pick | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
export function startCanvasPick(kinds: Kind[], max: number, what: string): Promise<string[] | null> {
  current?.resolve(null);
  return new Promise((resolve) => { current = { kinds, max, what, resolve }; emit(); });
}
export function finishPick(ids: string[] | null) { const c = current; current = null; emit(); c?.resolve(ids); }
export function usePick(): Pick | null { return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => current); }

const word = (kinds: Kind[]) => kinds.length === 1 ? (kinds[0] === 'image' ? 'picture' : kinds[0] === 'video' ? 'clip' : 'sound') : 'item';

/** The bar shown over the canvas while the app waits for a pick. Mounted once, in the app. */
export function PickBanner({ selected }: { selected: string[] }) {
  const p = usePick(); const { assets } = useContext(C);
  useEffect(() => {
    if (!p) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); finishPick(null); } };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [p]);
  if (!p) return null;
  const ok = selected.filter((id) => { const a = assets.get(id); return a && p.kinds.includes(a.kind as Kind); }).slice(0, p.max);
  return (
    <div className="pickBar" role="status" aria-live="polite">
      <Icon name="pin" size="s" />
      <span><b>{p.what}</b> Click {word(p.kinds)}s on the canvas{p.max > 1 ? ' (Shift or a box to take several)' : ''}.</span>
      <span className="pn">{ok.length} selected</span>
      <Button size="sm" kind="primary" disabled={!ok.length} onClick={() => finishPick(ok)}>Done</Button>
      <Button size="sm" kind="quiet" onClick={() => finishPick(null)}>Cancel</Button>
    </div>
  );
}

/* ---- the Library in a small picker ---- */
function LibraryPicker({ anchor, kinds, max, exclude, onPick, onClose }: { anchor: HTMLElement | null; kinds: Kind[]; max: number; exclude: Set<string>; onPick: (ids: string[]) => void; onClose: () => void }) {
  const { assets, story } = useContext(C);
  const [q, setQ] = useState(''); const [chosen, setChosen] = useState<string[]>([]);
  const list = useMemo(() => {
    const all = [...assets.values()].filter((a) => kinds.includes(a.kind as Kind) && !story.meta[a.id]?.trashed && !exclude.has(a.id));
    const n = q.trim().toLowerCase();
    return (n ? all.filter((a) => assetName(a, story.meta).toLowerCase().includes(n)) : all).reverse();
  }, [assets, story.meta, kinds, exclude, q]);
  const toggle = (id: string) => setChosen((c) => c.includes(id) ? c.filter((x) => x !== id) : max === 1 ? [id] : [...c, id].slice(0, max));
  const shown = list.slice(0, 120);
  return (
    <Popover anchor={anchor} onClose={onClose} width={340} title={`Library · ${word(kinds)}s`}>
      <input className="inp" autoFocus placeholder="Search by name" aria-label="Search the Library" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose(); if (e.key === 'Enter' && chosen.length) { onPick(chosen); onClose(); } }} />
      <div className="addGrid" role="listbox" aria-multiselectable={max > 1}>
        {shown.map((a: Asset) => {
          const on = chosen.includes(a.id);
          return <button key={a.id} type="button" role="option" aria-selected={on} className={'addCell' + (on ? ' on' : '')} title={assetName(a, story.meta)} onClick={() => toggle(a.id)} onDoubleClick={() => { onPick([a.id]); onClose(); }}>
            {a.kind === 'audio' ? <span className="snd"><Icon name="sound" size="l" /></span> : <img src={thumbUrl(a.id)} alt="" loading="lazy" draggable={false} />}
            <span className="nm">{assetName(a, story.meta)}</span>{on && <span className="ck"><Icon name="check" size={12} /></span>}
          </button>;
        })}
        {!shown.length && <span className="xs faint addNone">{q ? 'Nothing matches.' : `No ${word(kinds)}s in the Library yet.`}</span>}
      </div>
      {list.length > shown.length && <span className="xs faint">Showing the newest {shown.length} of {list.length}: search to narrow.</span>}
      <div className="row"><span className="xs faint">{max > 1 ? 'Click to tick several. Double-click adds one.' : 'Double-click adds it.'}</span><span className="sp" />
        <Button size="sm" kind="primary" disabled={!chosen.length} onClick={() => { onPick(chosen); onClose(); }}>Add{chosen.length ? ` ${chosen.length}` : ''}</Button></div>
    </Popover>
  );
}

/**
 * The add button. `selected` is what is selected on the canvas (any kind: it is filtered here). `onPick` gets the asset ids.
 * `exclude` hides what is already in the field. Pass `children` to use your own look for the button.
 */
export function AddSource({ kinds, max = 99, selected, onPick, exclude, label, what, className, title, disabled, children }: {
  kinds: Kind[]; max?: number; selected: string[]; onPick: (ids: string[]) => void; exclude?: string[]; label?: string; what?: string; className?: string; title?: string; disabled?: boolean; children?: ReactNode;
}) {
  const { assets } = useContext(C);
  const btn = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [lib, setLib] = useState(false);
  const skip = useMemo(() => new Set(exclude ?? []), [exclude]);
  const usable = selected.filter((id) => { const a = assets.get(id); return a && kinds.includes(a.kind as Kind) && !skip.has(id); }).slice(0, max);
  const give = (ids: string[]) => { const u = [...new Set(ids)].filter((id) => !skip.has(id)); if (u.length) onPick(u.slice(0, max)); };
  const items: MenuItem[] = [
    { header: 'Add from' },
    ...(usable.length ? [{ label: `Use ${usable.length} selected on the canvas`, icon: 'check' as const, recommended: true, onClick: () => give(usable) }] : []),
    { label: 'Select on the canvas…', icon: 'pin', sub: `The app waits while you click ${word(kinds)}s there`, onClick: () => void startCanvasPick(kinds, max, what ?? label ?? `Add ${word(kinds)}${max > 1 ? 's' : ''}.`).then((ids) => { if (ids?.length) give(ids); }) },
    { label: 'From the Library…', icon: 'image', sub: 'A small picker with search', onClick: () => setLib(true) },
    { label: 'Upload from your computer…', icon: 'import', sub: 'Imported into the Library, then added', onClick: () => void api.importAssets().then((list) => give(list.filter((a) => kinds.includes(a.kind as Kind)).map((a) => a.id))) },
  ];
  return <>
    <button ref={btn} type="button" className={className ?? 'mAddIn'} disabled={disabled} title={title ?? 'Add: from the canvas, the Library or your computer'} aria-haspopup="menu"
      onClick={() => { const r = btn.current!.getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom + 4 }); }}>
      {children ?? <><Icon name="plus" size="s" />{label ?? 'Add'}</>}
    </button>
    {menu && <Menu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} label="Add from" />}
    {lib && <LibraryPicker anchor={btn.current} kinds={kinds} max={max} exclude={skip} onPick={give} onClose={() => setLib(false)} />}
  </>;
}
