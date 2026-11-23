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
  const project: SizeChoice = { purpose: 'film' };
  const set = (patch: Partial<typeof d>) => saveDefaults({ ...loadDefaults(), ...patch });
  const setModel = (id: string, c: SizeChoice | undefined) => { const m = { ...loadDefaults().models }; if (c) m[id] = c; else delete m[id]; set({ models: m }); };
  const text = (c: SizeChoice, step = 8) => { try { const r = resolveSize(c, film, null, step); return `${r.w}×${r.h}`; } catch { return ''; } };
  const sized = (kind: 'image' | 'video') => profiles.filter((p) => p.kind === kind && sizeInfo(p).ok);
  const row = (kind: 'image' | 'video', title: string) => {
    const cur = d[kind];
    return (
      <div key={kind} style={{ borderTop: '1px solid var(--line)', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div className="row"><Icon name={kind} size="s" /><b style={{ flex: 1 }}>{title}</b>
          {cur ? <><span className="chip">{text(cur)}</span><Button size="sm" kind="quiet" onClick={() => set({ [kind]: undefined })}>Use the project size</Button></> : <span className="xs faint">uses the project size</span>}</div>
        <SizeChooser value={cur ?? project} onChange={(c) => set({ [kind]: c })} />
        <div className="note">Every {kind === 'image' ? 'frame' : 'clip'} in the Story is made at this size unless its model or the shot says otherwise.</div>
        {sized(kind).length > 0 && <details style={{ marginTop: 8 }}>
          <summary className="small"><b>Models</b> · a size for one model overrides the above</summary>
          {sized(kind).map((p) => {
            const m = d.models[p.id];
            return <div key={p.id} style={{ padding: '8px 0', borderTop: '1px solid var(--line)' }}>
              <div className="row"><b className="small" style={{ flex: 1 }}>{p.title}</b>{m ? <><span className="chip coral">{text(m, sizeInfo(p).step)}</span><Button size="sm" kind="quiet" onClick={() => setModel(p.id, undefined)}>Clear</Button></> : <span className="xs faint">follows the {kind === 'image' ? 'Image' : 'Video'} default</span>}</div>
              <SizeChooser value={m ?? cur ?? project} onChange={(c) => setModel(p.id, c)} step={sizeInfo(p).step} />
            </div>;
          })}
          <div className="note">Other settings of a model (steps, sampler, models files...) are in Settings › ComfyUI.</div>
        </details>}
      </div>
    );
  };
  return (
    <>
      <FilmForm />
      <span className="note" style={{ margin: '4px 0 0' }}>Each step takes its size from: the shot, then its model, then Pictures or Clips, then the project above. Fill in only what you need.</span>
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
