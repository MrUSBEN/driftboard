import { useContext, useEffect, useMemo, useState } from 'react';
import { C, api, assetUrl, thumbUrl, autoAssign, elementsOfShot, imageSlots, valuesOfDraft, type Draft, type Manifest, type Shot } from './shared.tsx';
import { SizeChooser, resolveSize, sizeInfo, useSizeChoice, withSize } from './size.tsx';
import { Button, Chip, IconButton, Notice, Tile } from './ui/ui.tsx';
import { Icon } from './ui/Icon.tsx';
import { AddSource } from './AddSource.tsx';
import { ViewBar, useView } from './View.tsx';

/**
 * The storyboard of a planned story: one picture per cut (a shot that does not continue the one before), made from the
 * bible's reference pictures and, inside a scene, from the frame of the shot before, so people, clothing and light match
 * across the cut. Each frame becomes its shot's first frame: the video starts from it. Check them here before any video
 * is made: make again, take your own picture, or edit one in Create.
 */
export function ShotFrames({ storyId, selectedAssets, notify, openDraft, goShots }: { storyId: string; selectedAssets: string[]; notify: (m: string) => void; openDraft?: (d: Draft) => void; goShots: () => void }) {
  const { story, profiles, film, assets, jobs } = useContext(C);
  const makers = profiles.filter((x) => x.kind === 'image' && x.slots.some((s) => s.type === 'image_list') && x.slots.some((s) => s.type === 'text' && s.role === 'prompt'));
  const capacity = (x: Manifest) => imageSlots(x).reduce((n, s) => n + (s.type === 'image_list' ? s.max : 1), 0);
  const [makerId, setMakerId] = useState<string>(() => { try { return localStorage.getItem('driftboard.frameMaker') ?? ''; } catch { return ''; } });
  const maker = makers.find((x) => x.id === makerId) ?? [...makers].sort((a, b) => capacity(b) - capacity(a))[0];
  const [size, setSize] = useSizeChoice('startframe', 'film');
  const [view, setView] = useView('frames', { mode: 'grid' });
  const [big, setBig] = useState<string | null>(null);   // a frame shown full size
  useEffect(() => { if (!big) return; const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setBig(null); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [big]);
  const [look, setLook] = useState('');
  const [coming, setComing] = useState<Set<string>>(new Set());
  useEffect(() => {
    const f = () => { void api.storyBlocks(storyId).then((b) => setLook(b.blocks.find((x) => x.id === 'look')?.text.trim() ?? '')); void api.framesComing().then((l) => setComing(new Set(l))); };
    f(); return api.onBoard(f);
  }, [storyId]);
  useEffect(() => { void api.framesComing().then((l) => setComing(new Set(l))); }, [jobs]);

  const scenes = useMemo(() => story.all.filter((t) => t.scene.storyId === storyId), [story, storyId]);
  const bible = story.bible;
  const style = look || bible?.style || '';
  const cuts = scenes.flatMap((t) => t.shots.filter((s) => !s.brief?.continues));
  const missingPics = [...(bible?.characters ?? []), ...(bible?.places ?? []), ...(bible?.props ?? [])].filter((e) => !e.refAsset).length;
  const refSlot = maker?.slots.find((s) => s.type === 'image_list') as (Manifest['slots'][number] & { max: number }) | undefined;

  /** The prompt of one frame: the first moment of the shot, how things stand after the shot before, the pictures by number. */
  const promptOf = (s: Shot, els: ReturnType<typeof elementsOfShot>, before: Shot | undefined, withPrev: boolean) => {
    const b = s.brief!;
    const first = b.beats?.[0]?.action ?? b.action;
    const pics = [...els.map((e, i) => `<Picture ${i + 1}> is ${e.name} (the ${e.role})`), ...(withPrev ? [`<Picture ${els.length + 1}> is the previous shot of this scene: keep the same people, clothing, light and place, seen from this shot's new camera angle`] : [])];
    return [
      style ? `${style.replace(/[.\s]+$/, '')}.` : '',
      `A single still frame from a film: the first moment of this shot, ${b.framing} framing.`,
      first,
      before?.brief?.endState ? `How things stand at this moment: ${before.brief.endState}` : '',
      pics.length ? `${pics.join('; ')}.` : '',
      els.length ? 'Keep each person, the place and every object exactly as in its reference picture: same face, hair, clothing, colours and materials.' : '',
      'Photographic film still, no text, no captions, no borders.',
    ].filter(Boolean).join(' ');
  };

  /** Make frames for these shots in story order; a frame inside a scene waits for the frame of the cut before it. */
  const make = async (list: Shot[]) => {
    if (!maker || !refSlot) return notify('No image model that takes reference pictures: turn one on in Settings › ComfyUI.');
    const si = sizeInfo(maker); let made = 0, waiting = 0; const bad: string[] = [];
    const making = new Set(list.map((s) => s.id));
    for (const t of scenes) {
      let prevCut: Shot | undefined; let before: Shot | undefined;
      for (const s of t.shots) {
        if (s.brief?.continues) { before = s; continue; }
        if (making.has(s.id) && s.brief) {
          const prevHas = !!prevCut && (making.has(prevCut.id) || coming.has(prevCut.id) || !!prevCut.frames?.first);
          const els = elementsOfShot(s, bible).slice(0, Math.max(0, capacity(maker) - (prevHas ? 1 : 0)));
          const d: Draft = { profileId: maker.id, values: { prompt: promptOf(s, els, before, prevHas) }, inputs: autoAssign(maker, els.map((e) => e.asset)), title: `Storyboard frame for ${s.name}` };
          const v0 = valuesOfDraft(maker, d);
          const v = si.ok ? withSize(v0, resolveSize(size, film, null, si.step)) : v0;
          const r = await api.frameMake(s.id, maker.id, v, prevHas ? { shotId: prevCut!.id, refSlot: refSlot.id, max: refSlot.max } : undefined);
          if (r.ok) { made++; if (r.waiting) waiting++; } else bad.push(`${s.name}: ${r.error}`);
        }
        prevCut = s; before = s;
      }
    }
    setComing(new Set(await api.framesComing()));
    notify(`Making ${made} storyboard frame${made === 1 ? '' : 's'}${waiting ? ` (${waiting} wait for the frame before them, to match it)` : ''}${bad.length ? `; ${bad.length} could not be queued (${bad[0]})` : ''}`);
  };
  const setFrame = (s: Shot, first: string | undefined) => api.storyOp('updateShot', s.id, { frames: { ...(s.frames ?? {}), first } });
  const editInCreate = (s: Shot) => {
    if (!maker || !s.frames?.first || !openDraft) return;
    openDraft({ profileId: maker.id, values: { prompt: 'Change <Picture 1>: ' }, inputs: autoAssign(maker, [s.frames.first, ...elementsOfShot(s, bible).map((e) => e.asset)].slice(0, capacity(maker))), title: `Edit the frame of ${s.name}` });
    notify('Edit the frame in Create; then select the result on the canvas and use “From selection” on the shot.');
  };
  const pick = [...selectedAssets].reverse().find((a) => assets.get(a)?.kind === 'image');
  const hiRes = view.mode === 'list' ? view.size !== 'compact' : view.size === 'large';
  /** All moments of a shot with their times, and the lines spoken in them. */
  const beatLines = (s: Shot) => { let t = 0; return (s.brief?.beats ?? []).map((b) => { const a = t; t += b.seconds; return `${Math.round(a)}-${Math.round(t)} s: ${b.action}${b.dialogue ? ` “${b.dialogue}”` : ''}`; }); };
  const missing = cuts.filter((s) => s.brief && !s.frames?.first && !coming.has(s.id));

  if (!cuts.length) return <Notice>No shots yet: plan the shots first (Shots › Plan shots). Then each cut gets a storyboard frame here.</Notice>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="dcard" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <b className="small">Storyboard frames</b>
        <span className="xs dim">One picture per cut, made from the bible's reference pictures and the frame of the shot before, so the look holds across cuts. Each frame becomes its shot's first frame: the video starts from it. Parts that continue a shot need none (they start from the last frames of the part before).</span>
        {missingPics > 0 && <Notice tone="warn">{missingPics} bible {missingPics === 1 ? 'entry has' : 'entries have'} no reference picture yet: frames are more consistent with them (Bible › Make the missing pictures).</Notice>}
        {makers.length > 1 && <label className="row" style={{ margin: 0 }}><span className="lbl">Image model</span><select className="selc" value={maker?.id ?? ''} onChange={(e) => { setMakerId(e.target.value); try { localStorage.setItem('driftboard.frameMaker', e.target.value); } catch { /* ignore */ } }}>{makers.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}</select></label>}
        {maker && sizeInfo(maker).ok && <details><summary className="xs dim" style={{ cursor: 'pointer' }}>Frame size · {(() => { try { const r = resolveSize(size, film, null, sizeInfo(maker).step); return `${r.w}×${r.h}`; } catch { return ''; } })()}</summary>
          <SizeChooser value={size} onChange={setSize} step={sizeInfo(maker).step} label="Frame size" /></details>}
        <div className="row wrap">
          <Button size="sm" kind="primary" icon="create" disabled={!maker || !missing.length} onClick={() => void make(missing)}>Make the missing frames ({missing.length})</Button>
          <Button size="sm" disabled={!maker || !cuts.some((s) => s.frames?.first)} title="Make every frame again (in order, each matching the one before)" onClick={() => void make(cuts.filter((s) => s.brief))}>Make all again</Button>
          <span className="sp" />
          <ViewBar value={view} onChange={setView} />
          <Button size="sm" kind="quiet" onClick={goShots}>Go to Shots</Button>
        </div>
      </div>
      {scenes.map((t) => (
        <div key={t.scene.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="row"><Icon name="scene" /><b className="small" style={{ flex: 1 }}>{t.scene.name}</b></div>
          <div className={`frameGrid fv-${view.mode} fv-${view.size}`}>
            {t.shots.map((s) => s.brief?.continues
              ? <div key={s.id} className="frameCont xs faint" title="Continues the shot before as the same take: it starts from the last frames of the part before, so it needs no frame"><Icon name="cont" size={12} />{s.name}</div>
              : <div key={s.id} className="dcard frameCard">
                {s.frames?.first
                  ? <Tile src={hiRes ? assetUrl(s.frames.first) : thumbUrl(s.frames.first)} style={{ aspectRatio: '16 / 9', cursor: 'zoom-in' }} title="Show full size" onClick={() => setBig(s.frames!.first!)} />
                  : <div className="tile noPic" style={{ aspectRatio: '16 / 9' }}>{coming.has(s.id) ? <span className="spin" /> : <Icon name="image" size="l" />}</div>}
                <div className="frameInfo">
                  <div className="row" style={{ gap: 4 }}><b className="small" style={{ flex: 1 }}>{s.name}</b>{s.brief && view.mode === 'list' && <span className="xs dim">{s.brief.framing} · {s.brief.move} · {s.brief.seconds} s</span>}{coming.has(s.id) && <Chip>making…</Chip>}</div>
                  {view.mode === 'list' && s.brief?.beats?.length
                    ? <div className="xs dim" style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>{beatLines(s).map((l, i) => <span key={i}>{l}</span>)}</div>
                    : <span className="xs dim frameAct" title={s.brief?.action}>{s.brief?.beats?.[0]?.action ?? s.brief?.action ?? ''}</span>}
                  {view.mode === 'list' && s.brief?.endState && <span className="xs faint">Ends: {s.brief.endState}</span>}
                  <div className="row" style={{ gap: 2, flexWrap: 'wrap' }}>
                    <IconButton size="sm" icon="create" label={s.frames?.first ? 'Make this frame again' : 'Make this frame'} disabled={!maker || !s.brief || coming.has(s.id)} onClick={() => void make([s])} />
                    <AddSource kinds={['image']} max={1} selected={selectedAssets} className="btn icon sm" title="Use a picture you already have as this frame: from the canvas, the Library or your computer" what={`Pick the frame for ${s.name}.`} onPick={(p) => void setFrame(s, p[0])}><Icon name="import" size="s" /></AddSource>
                    {s.frames?.first && openDraft && <IconButton size="sm" icon="pencil" label="Edit this frame in Create" onClick={() => editInCreate(s)} />}
                    {s.frames?.first && <IconButton size="sm" icon="x" label="Remove this frame (the picture stays in the Library)" onClick={() => void setFrame(s, undefined)} />}
                  </div>
                </div>
              </div>)}
          </div>
        </div>
      ))}
      {big && <div className="frameBig" onClick={() => setBig(null)} title="Click or Esc to close"><img src={assetUrl(big)} alt="" /></div>}
    </div>
  );
}
