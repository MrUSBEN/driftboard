/* Settings › Defaults: where each step of the Story gets its size from. Four levels, most specific first:
   the shot's own choice → the model's default → the media type's default (Image / Video) → the project size. */
import { useContext } from 'react';
import { C } from './shared.tsx';
import { SizeChooser, resolveSize, sizeInfo, useSizeChoice, type SizeChoice } from './size.tsx';
import { loadDefaults, saveDefaults, useDefaults } from './defaults.ts';
import { Button } from './ui/ui.tsx';
import { Icon } from './ui/Icon.tsx';

export function DefaultsPane() {
  const { profiles, film } = useContext(C);
  const d = useDefaults();
  const [project, setProject] = useSizeChoice('manual', 'film');
  const set = (patch: Partial<typeof d>) => saveDefaults({ ...loadDefaults(), ...patch });
  const setModel = (id: string, c: SizeChoice | undefined) => { const m = { ...loadDefaults().models }; if (c) m[id] = c; else delete m[id]; set({ models: m }); };
  const text = (c: SizeChoice, step = 8) => { try { const r = resolveSize(c, film, null, step); return `${r.w}×${r.h}`; } catch { return ''; } };
  const sized = (kind: 'image' | 'video') => profiles.filter((p) => p.kind === kind && sizeInfo(p).ok);
  const row = (kind: 'image' | 'video', title: string) => {
    const cur = d[kind];
    return (
      <div className="card" key={kind}>
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
      <h2>Defaults</h2>
      <div className="note">Each step looks for its size in this order: the shot's own choice, then the model, then Image or Video, then the project. You only fill in what you need.</div>
      <div className="card">
        <div className="row"><Icon name="story" size="s" /><b style={{ flex: 1 }}>Project size</b><span className="chip">{text(project)}</span></div>
        <SizeChooser value={project} onChange={setProject} />
        <div className="note">The same as the Size chip in the Story. Aspect, resolution and megapixels for everything that has no more specific default.</div>
      </div>
      {row('image', 'Pictures and frames')}
      {row('video', 'Clips')}
    </>
  );
}
