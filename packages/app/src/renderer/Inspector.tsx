/* The Inspector under the viewer: everything about the selected item (facts, prompt, lineage, take, actions),
   or a summary of the film when the viewer shows the timeline. Was a scrolling text block under the preview. */
import { useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { C, api, thumbUrl, type Asset } from './shared.tsx';
import { EditorCtx, useEditorState } from './editorBridge.tsx';
import { selectClips, timelineEnd } from '@driftboard/editor';
import { Icon, type IconName } from './ui/Icon.tsx';
import { Button, Empty, Notice, Tile } from './ui/ui.tsx';
import { assetName } from './Canvas.tsx';
import { requestExport } from './Timeline.tsx';
import { useProfileTitle } from './Shell.tsx';
import type { BoardItem } from '../main/api.ts';

const ratio = (w: number, h: number) => { const g = (a: number, b: number): number => (b ? g(b, a % b) : a); const k = g(w, h); return w / k <= 32 && h / k <= 32 ? `${w / k}:${h / k}` : `${(w / h).toFixed(2)}:1`; };
const secs = (s: number) => { const m = Math.floor(s / 60), r = s - m * 60; return `${m}:${r.toFixed(2).padStart(5, '0')}`; };
/** Prompt text with <Picture n>, <Video n>, <Audio n> tags shown as tags. */
export function PromptText({ text }: { text: string }) {
  const parts = text.split(/(<(?:Picture|Video|Audio) \d+>)/g);
  return <>{parts.map((p, i) => (/^<(Picture|Video|Audio) \d+>$/.test(p) ? <span key={i} className="tagk">{p}</span> : p))}</>;
}
const act = (a: string) => window.dispatchEvent(new CustomEvent('driftboard-canvas-act', { detail: a }));
const selectItem = (id: string) => window.dispatchEvent(new CustomEvent('driftboard-node-select', { detail: id }));

export function Inspector({ item, asset, showInLibrary, notify }: { item: BoardItem | null; asset: Asset | null; showInLibrary: (assetId: string) => void; notify: (m: string) => void }) {
  const { jobs, board, assets, story, takeOf, usage } = useContext(C);
  const title = useProfileTitle();
  const [name, setName] = useState('');
  useEffect(() => { setName(asset ? assetName(asset, story.meta, takeOf.get(asset.id)?.shot.name) : ''); }, [asset?.id, story.meta, takeOf]);   // eslint-disable-line react-hooks/exhaustive-deps
  const made = useMemo(() => (asset ? jobs.find((j) => j.outputs.some((o) => o.assetId === asset.id)) : undefined), [asset, jobs]);
  if (!asset || !item) return <div className="insp"><Empty icon="info" title="Nothing selected">Details, prompt, lineage and actions of the selected item show here.</Empty></div>;
  let params: Record<string, unknown> = {}; try { params = made ? JSON.parse(made.params) : {}; } catch { /* none */ }
  const prompt = typeof params.prompt === 'string' ? params.prompt : '';
  const tk = takeOf.get(asset.id);
  const byItem = new Map(board.items.map((i) => [i.id, i]));
  const assetOfItem = (id: string) => { const it = byItem.get(id); return it?.ref ? assets.get(it.ref) : undefined; };
  const parents = board.lineage.filter((l) => l.to === item.id).map((l) => ({ id: l.from, a: assetOfItem(l.from) })).filter((x) => x.a);
  const kids = board.lineage.filter((l) => l.from === item.id).map((l) => ({ id: l.to, a: assetOfItem(l.to) })).filter((x) => x.a);
  const used = usage.get(asset.id) ?? 0;
  const fps = asset.fps ?? 24;
  const btn = (icon: IconName, label: string, run: () => void, t?: string): ReactNode => <Button key={label} size="sm" icon={icon} title={t} onClick={run}>{label}</Button>;
  const shownName = assetName(asset, story.meta, tk?.shot.name);
  const rename = () => { const n = name.trim(); if (n && n !== shownName) void api.storyOp('setMeta', asset.id, { name: n }); else setName(shownName); };
  return (
    <div className="insp">
      <input className="name" aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} onBlur={rename} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setName(shownName); (e.target as HTMLInputElement).blur(); } }} />
      <dl className="facts">
        {asset.width ? <><dt>Size</dt><dd>{asset.width}×{asset.height} · {((asset.width * (asset.height ?? 0)) / 1e6).toFixed(2)} MP · {ratio(asset.width, asset.height ?? 1)}</dd></> : null}
        {asset.duration_ms ? <><dt>Length</dt><dd>{(asset.duration_ms / 1000).toFixed(2)} s{asset.kind === 'video' ? ` · ${fps} fps · ${Math.round((asset.duration_ms / 1000) * fps)} frames` : ''}</dd></> : null}
        {asset.kind === 'video' && <><dt>Sound</dt><dd>{asset.has_audio ? 'yes' : 'no'}</dd></>}
        <dt>Made with</dt><dd>{made ? <>{title(made.profile_id)} <span className="faint">({made.profile_id})</span></> : made === undefined && asset.original_name ? 'imported' : 'edit or import'}</dd>
        {typeof params.seed === 'number' && <><dt>Seed</dt><dd>{params.seed}</dd></>}
        <dt>Made</dt><dd>{new Date(asset.created_at).toLocaleString()}</dd>
        <dt>File</dt><dd title={asset.original_name ?? undefined}>{asset.original_name ?? `${asset.id}.${asset.ext}`}</dd>
      </dl>
      {tk && <>
        <div className="ilabel"><Icon name="story" size="s" />Take of “{tk.shot.name}”</div>
        <div className="row">
          <Button size="sm" icon="star" on={tk.picked} title="The pick goes to the timeline (Picks → timeline)" onClick={() => void api.storyOp('setPick', tk.shot.id, tk.picked ? undefined : asset.id)}>Pick</Button>
          <Button size="sm" icon="check" on={tk.status === 'approved'} onClick={() => void api.storyOp('setTakeStatus', tk.shot.id, asset.id, tk.status === 'approved' ? 'draft' : 'approved')}>Approve</Button>
          <Button size="sm" icon="x" on={tk.status === 'rejected'} onClick={() => void api.storyOp('setTakeStatus', tk.shot.id, asset.id, tk.status === 'rejected' ? 'draft' : 'rejected')}>Reject</Button>
        </div>
      </>}
      {prompt && <>
        <div className="ilabel">Prompt<span className="sp" /><Button size="sm" kind="quiet" icon="copy" onClick={() => { void navigator.clipboard.writeText(prompt); notify('Prompt copied'); }}>Copy</Button></div>
        <div className="prompt full"><PromptText text={prompt} /></div>
      </>}
      {(parents.length > 0 || kids.length > 0) && <>
        <div className="ilabel"><Icon name="lineage" size="s" />Lineage</div>
        <div className="lineageStrip">
          {parents.map((p) => <button key={p.id} type="button" className="tileBtn" title={`Made from: ${assetName(p.a!, story.meta)}`} onClick={() => selectItem(p.id)}><Tile src={thumbUrl(p.a!.id)} kind={p.a!.kind === 'audio' ? 'audio' : 'image'} /></button>)}
          {parents.length > 0 && <Icon name="chevR" size="s" />}
          <Tile src={thumbUrl(asset.id)} kind={asset.kind === 'audio' ? 'audio' : 'image'} style={{ borderColor: 'var(--select)' }} />
          {kids.length > 0 && <Icon name="chevR" size="s" />}
          {kids.map((k) => <button key={k.id} type="button" className="tileBtn" title={`Made from this: ${assetName(k.a!, story.meta)}`} onClick={() => selectItem(k.id)}><Tile src={thumbUrl(k.a!.id)} kind={k.a!.kind === 'audio' ? 'audio' : 'image'} /></button>)}
        </div>
      </>}
      {asset.kind !== 'audio' && <><div className="ilabel">Used</div><div className="small dim">{used ? `On the timeline ${used}×` : 'Not on the timeline'} · on the canvas</div></>}
      <div className="ilabel">Actions</div>
      <div className="actGrid">
        {asset.kind === 'video' ? [btn('cont', 'Continue…', () => act('continueBest'), 'Continue with held frames when the model can, else from the last frame'), ...(made ? [btn('regen', 'Regenerate…', () => act('regenerate'))] : []), btn('film', 'Add to timeline', () => act('addToTimeline')), btn('trim', 'Trim…', () => act('trim')), btn('chart', 'Check continuity…', () => act('continuity'))]
          : asset.kind === 'image' ? [btn('create', 'Generate from this…', () => act('generate')), ...(made ? [btn('regen', 'Regenerate…', () => act('regenerate'))] : []), btn('crop', 'Crop…', () => act('crop')), btn('resize', 'Resize…', () => act('resize')), btn('upscale', 'Upscale ×2', () => act('upscale'), 'Lanczos resample, not AI')]
          : [btn('create', 'Generate from this…', () => act('generate'))]}
        {btn('library', 'Show in Library', () => showInLibrary(asset.id))}
        {btn('ext', 'Open in Explorer', () => void api.assetReveal(asset.id))}
      </div>
    </div>
  );
}

/** The Film tab: what the timeline holds, and the way to export it. */
export function FilmInspector() {
  const editor = useContext(EditorCtx);
  if (!editor) return <div className="insp"><Empty icon="film" title="No timeline yet" /></div>;
  return <FilmFacts />;
}
function FilmFacts() {
  const { assets, story } = useContext(C);
  const state = useEditorState();
  const clips = selectClips(state);
  const end = timelineEnd(state);
  const t = state.session.transport.currentTime ?? 0;
  const vids = clips.filter((c) => c.type !== 'audio'), sounds = clips.filter((c) => c.type === 'audio');
  const at = vids.filter((c) => t >= c.startTime && t < c.startTime + c.duration).sort((a, b) => b.trackIndex - a.trackIndex)[0];
  const atAsset = at?.assetId ? assets.get(at.assetId) : undefined;
  const first = vids.map((c) => (c.assetId ? assets.get(c.assetId) : undefined)).find((a) => a?.width);
  return (
    <div className="insp">
      <div className="ilabel"><Icon name="film" size="s" />Film</div>
      <dl className="facts">
        <dt>Length</dt><dd>{secs(end)}</dd>
        {first && <><dt>Size</dt><dd>{first.width}×{first.height}{first.fps ? ` · ${first.fps} fps` : ''} (first clip)</dd></>}
        <dt>Clips</dt><dd>{vids.length} video · {sounds.length} sound</dd>
        <dt>At playhead</dt><dd>{atAsset ? assetName(atAsset, story.meta) : '—'}</dd>
      </dl>
      <Notice>The film plays from preview copies made for smooth seeking; the export uses the full files. Space plays, P is full screen.</Notice>
      <Button kind="primary" icon="export" onClick={requestExport}>Export the film…</Button>
    </div>
  );
}
