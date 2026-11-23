/* Settings › Defaults: where each step of the Story gets its size from. Four levels, most specific first:
   the shot's own choice → the model's default → the media type's default (Image / Video) → the project size. */
import { useContext } from 'react';
import { C } from './shared.tsx';
import { FilmForm, SizeChooser, resolveSize, sizeInfo, useSizeChoice, type SizeChoice } from './size.tsx';
import { loadDefaults, saveDefaults, useDefaults } from './defaults.ts';
import { Button } from './ui/ui.tsx';
import { Icon } from './ui/Icon.tsx';

export function DefaultsPane() {
  const { profiles, film } = useContext(C);
  const d = useDefaults();
  const [story, setStory] = useSizeChoice('manual', 'film');
  const project: SizeChoice = story.purpose === 'film' ? { purpose: 'film' } : story;
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
        <div className="row"><Icon name="film" size="s" /><b style={{ flex: 1 }}>Project</b><span className="chip">{text({ purpose: 'film' })}</span></div>
        <div className="note" style={{ marginTop: 0 }}>The same as the film chip in the top bar: it preselects the size and length everywhere that has no more specific default.</div>
        <FilmForm />
        {story.purpose !== 'film' && <div className="row" style={{ marginTop: 6 }}><span className="small">The Story has its own size ({text(story)}), so it ignores the project.</span><Button size="sm" onClick={() => setStory({ purpose: 'film' })}>Follow the project</Button></div>}
      </div>
      {row('image', 'Pictures and frames')}
      {row('video', 'Clips')}
    </>
  );
}
