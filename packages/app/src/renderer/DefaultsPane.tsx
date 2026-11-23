/* Settings › Defaults: where each step of the Story gets its size from. Four levels, most specific first:
   the shot's own choice → the model's default → the media type's default (Image / Video) → the project size. */
import { useContext, useState } from 'react';
import { C } from './shared.tsx';
import { FilmForm, QUALITY, SizeChooser, resolveSize, sizeInfo, useSizeChoice, type SizeChoice } from './size.tsx';
import { loadDefaults, saveDefaults, useDefaults } from './defaults.ts';
import { Button, Popover } from './ui/ui.tsx';
import { Icon } from './ui/Icon.tsx';

function ProjectDefaults() {
  const { profiles, film } = useContext(C);
  const d = useDefaults();
  const [open, setOpen] = useState('');
  const project: SizeChoice = { purpose: 'film' };
  const set = (patch: Partial<typeof d>) => saveDefaults({ ...loadDefaults(), ...patch });
  const setModel = (id: string, c: SizeChoice | undefined) => { const m = { ...loadDefaults().models }; if (c) m[id] = c; else delete m[id]; set({ models: m }); };
  const text = (c: SizeChoice, step = 8) => { try { const r = resolveSize(c, film, null, step); return `${r.w}×${r.h}`; } catch { return ''; } };
  const sized = (kind: 'image' | 'video') => profiles.filter((p) => p.kind === kind && sizeInfo(p).ok);
  /** One line (name, the size it gives, a Change button) that opens its size chooser below it. */
  const line = (key: string, icon: 'image' | 'video' | 'chip', title: string, cur: SizeChoice | undefined, fallback: string, onSet: (c: SizeChoice) => void, onClear: () => void, step = 8) => (
    <div className="dfLine" key={key}>
      <div className="dfHead">
        <Icon name={icon} size="s" /><b>{title}</b><span className="sp" />
        <span className={'chip' + (cur ? ' coral' : '')} title={cur ? 'Set here' : fallback}>{cur ? text(cur, step) : 'follows ' + fallback}</span>
        <Button size="sm" kind="quiet" on={open === key} onClick={() => setOpen(open === key ? '' : key)}>{open === key ? 'Done' : 'Change'}</Button>
        {cur && <Button size="sm" kind="quiet" title={'Back to: ' + fallback} onClick={onClear}>Clear</Button>}
      </div>
      {open === key && <div className="dfBody"><SizeChooser value={cur ?? (fallbackChoice(key))} onChange={onSet} step={step} /></div>}
    </div>
  );
  const fallbackChoice = (key: string): SizeChoice => { const [k, id] = key.split(':'); const kind = k === 'm' ? profiles.find((p) => p.id === id)?.kind : k; return (kind === 'video' ? d.video : kind === 'image' ? d.image : undefined) ?? project; };
  const row = (kind: 'image' | 'video', title: string) => (
    <div className="dfCard" key={kind}>
      {line(kind, kind, title, d[kind], 'the project size', (c) => set({ [kind]: c }), () => set({ [kind]: undefined }))}
      {sized(kind).length > 0 && <div className="dfModels"><span className="dfSub">Models · a size for one model wins over the line above</span>
        {sized(kind).map((p) => line('m:' + p.id, 'chip', p.title, d.models[p.id], title.toLowerCase().includes('clip') ? 'Clips' : 'Pictures', (c) => setModel(p.id, c), () => setModel(p.id, undefined), sizeInfo(p).step))}</div>}
    </div>
  );
  return (
    <>
      <div className="dfCard"><div className="dfHead"><Icon name="film" size="s" /><b>Project</b><span className="sp" /><span className="xs faint">preselects every size and length</span></div><FilmForm /></div>
      <span className="dfSub">A step takes its size from: the shot → its model → Pictures or Clips → the project. Set only what you need.</span>
      {row('image', 'Pictures and frames')}
      {row('video', 'Clips')}
    </>
  );
}

/** Settings › Defaults: the same panel as the film chip in the top bar. */
export function DefaultsPane() {
  return (
    <>
      <h2>Defaults</h2>
      <div className="note">The project's size and length, and a size for pictures, for clips and for single models. The same panel opens from the film chip in the top bar.</div>
      <div className="card"><ProjectDefaults /></div>
    </>
  );
}

/** The film chip of the top bar: the project's properties and the per-type and per-model sizes in one popup. */
export function FilmChip() {
  const { film } = useContext(C);
  const q = QUALITY.find((x) => x.mp === film.mp);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  return (
    <>
      <button className={'topBtn boxed' + (anchor ? ' open' : '')} title="Project defaults: size and length, per picture / clip / model" aria-haspopup="dialog" aria-expanded={!!anchor} onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}>
        <Icon name="film" /><span>{film.aspect}</span><span className="sub">· {q?.label ?? film.mp + ' MP'} · {film.seconds} s</span><Icon name="chev" size="s" />
      </button>
      {anchor && <Popover anchor={anchor} onClose={() => setAnchor(null)} title="Project defaults" width={480}><div style={{ maxHeight: '72vh', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 8, paddingRight: 4 }}><ProjectDefaults /></div></Popover>}
    </>
  );
}
