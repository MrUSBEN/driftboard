import { createContext, useContext, useState } from 'react';
import { Seg } from './ui/ui.tsx';

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
      {!noGrid && <Seg size="sm" label="Show as" value={value.mode} onChange={(m) => onChange({ ...value, mode: m })} options={[{ value: 'list', icon: 'list', ariaLabel: 'List' }, { value: 'grid', icon: 'grid', ariaLabel: 'Grid' }]} />}
      <Seg size="sm" label="Size" value={value.size} onChange={(z) => onChange({ ...value, size: z })} options={[{ value: 'compact', label: 'S', ariaLabel: 'Small' }, { value: 'normal', label: 'M', ariaLabel: 'Medium' }, { value: 'large', label: 'L', ariaLabel: 'Large' }]} />
    </span>
  );
}

/** The view of the surrounding pane; <Cards> lays its children out the way the user chose. */
export const ViewCtx = createContext<ViewState>({ mode: 'list', size: 'normal' });
export function Cards({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) { const v = useContext(ViewCtx); return <div className={viewClass(v)} style={style}>{children}</div>; }
