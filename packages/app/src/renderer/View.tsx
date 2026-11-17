import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { C, api } from './shared.tsx';

/** How a list of entries is shown: as rows or as cards, and how big. Remembered per list. */
export interface ViewState { mode: 'list' | 'grid'; size: 'compact' | 'normal' | 'large' }
export function useView(key: string, def: Partial<ViewState> = {}): [ViewState, (v: ViewState) => void] {
  const [v, setV] = useState<ViewState>(() => { try { const x = localStorage.getItem('driftboard.view.' + key); if (x) return { mode: 'list', size: 'normal', ...def, ...JSON.parse(x) }; } catch { /* ignore */ } return { mode: 'list', size: 'normal', ...def }; });
  return [v, (n) => { setV(n); try { localStorage.setItem('driftboard.view.' + key, JSON.stringify(n)); } catch { /* ignore */ } }];
}
export const viewClass = (v: ViewState) => `vw vw-${v.mode} vw-${v.size}`;

export function ViewBar({ value, onChange, noGrid = false }: { value: ViewState; onChange: (v: ViewState) => void; noGrid?: boolean }) {
  return (
    <span className="viewBar" title="How the entries are shown">
      {!noGrid && <span className="seg">{(['list', 'grid'] as const).map((m) => <button key={m} className={value.mode === m ? 'on' : ''} onClick={() => onChange({ ...value, mode: m })}>{m === 'list' ? '☰ List' : '▦ Grid'}</button>)}</span>}
      <span className="seg">{(['compact', 'normal', 'large'] as const).map((s) => <button key={s} className={value.size === s ? 'on' : ''} onClick={() => onChange({ ...value, size: s })}>{s === 'compact' ? 'S' : s === 'normal' ? 'M' : 'L'}</button>)}</span>
    </span>
  );
}

/** The view of the surrounding pane; <Cards> lays its children out the way the user chose. */
export const ViewCtx = createContext<ViewState>({ mode: 'list', size: 'normal' });
export function Cards({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) { const v = useContext(ViewCtx); return <div className={viewClass(v)} style={style}>{children}</div>; }

/** Undo and Redo for the project's shared history (canvas, stories, library), for tabs that have no canvas toolbar. */
export function UndoRedo() {
  const { board } = useContext(C);
  return <span className="row" style={{ gap: 4 }}>
    <button className="ghost" disabled={!board.canUndo} title="Undo (Ctrl+Z)" onClick={() => void api.boardUndo()}>↶ Undo</button>
    <button className="ghost" disabled={!board.canRedo} title="Redo (Ctrl+Shift+Z)" onClick={() => void api.boardRedo()}>↷ Redo</button>
  </span>;
}

/**
 * Floating helper at the bottom of a scrolling tab: collapse every card, expand every card, jump to the top.
 * Cards (.vcard, .queueCard) collapse to their first row; a click on that row opens one card. Tabs with their own
 * open/closed state (Story) listen to the 'driftboard-fold' event.
 */
export function FoldBar({ folds = true }: { folds?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(true);
  const side = () => ref.current?.closest('section') as HTMLElement | null;
  useEffect(() => {
    const s = side(); if (!s) return;
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
  }, []);
  const fold = (open: boolean) => { const s = side(); if (!s) return; s.classList.toggle('folded', !open); s.querySelectorAll('.unfold').forEach((e) => e.classList.remove('unfold')); window.dispatchEvent(new CustomEvent('driftboard-fold', { detail: { open } })); };
  return (
    <div className="foldBar" ref={ref}>
      {folds && <button title="Collapse every card in this list" onClick={() => fold(false)}>▴ Collapse all</button>}
      {folds && <button title="Expand every card in this list" onClick={() => fold(true)}>▾ Expand all</button>}
      <button title="Back to the top" disabled={top} onClick={() => side()?.scrollTo({ top: 0, behavior: 'smooth' })}>↑ Top</button>
    </div>
  );
}
