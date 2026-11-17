import { useContext, useState } from 'react';
import { C, type Asset, type Manifest, type Slot } from './shared.tsx';
import { Icon } from './ui/Icon.tsx';
import { Field, Popover } from './ui/ui.tsx';
import { DEFAULT_FILM as _D } from './sizeCalc.ts';

import { QUALITY, FILM_ASPECTS, PURPOSES, RESOLUTIONS, MPS, resolveSize, ratioText, type Film, type Purpose, type SizeChoice } from './sizeCalc.ts';
export * from './sizeCalc.ts';
const hasSize = (a?: { width: number | null; height: number | null } | null): a is { width: number; height: number } => !!a?.width && !!a.height;

/** Remember the last choice per place (e.g. "gen", "story", "bible"). */
export function useSizeChoice(key: string, preset?: Purpose): [SizeChoice, (c: SizeChoice) => void] {
  const [c, setC] = useState<SizeChoice>(() => { try { const v = localStorage.getItem('driftboard.size.' + key); if (v) return JSON.parse(v) as SizeChoice; } catch { /* ignore */ } return { purpose: preset ?? 'film' }; });
  return [c, (n) => { setC(n); try { localStorage.setItem('driftboard.size.' + key, JSON.stringify(n)); } catch { /* ignore */ } }];
}

/**
 * The one size chooser used everywhere something can be generated: Aspect, Resolution and MP dropdowns side by side plus the exact
 * width × height, all pre-filled with the values closest to the default or the input. Changing one updates the others; the exact
 * result in pixels is what is sent. Defaults only preselect.
 */
export function SizeChooser({ value, onChange, src, frame, step = 8, label = 'Size' }: { value: SizeChoice; onChange: (c: SizeChoice) => void; src?: Asset | null; frame?: Asset | null; step?: number; label?: string }) {
  const { film } = useContext(C);
  const hasSrc = hasSize(src);
  const legacy = PURPOSES.find((p) => p.id === value.purpose)?.ratio;   // old presets (character, wide, ...) are plain aspects now
  let purpose: Purpose = value.purpose;
  if ((purpose === 'match' || purpose === 'same') && !hasSrc) purpose = 'film';
  const choice: SizeChoice = { ...value, purpose, ...(legacy ? { purpose: 'aspect' as Purpose, aspect: legacy } : {}) };
  const r = resolveSize(choice, film, src, step);
  const aspectVal = choice.purpose === 'aspect' ? 'a:' + choice.aspect : choice.purpose;
  const aspects = [...new Set([...FILM_ASPECTS, ...(choice.purpose === 'aspect' && choice.aspect ? [choice.aspect] : [])])];
  const short = Math.min(r.w, r.h);
  const resVal = String(RESOLUTIONS.includes(short) ? short : 'x');
  const mpClosest = MPS.find((m) => Math.abs(m - r.mp) / m < 0.04);
  const mpVal = mpClosest !== undefined ? String(mpClosest) : 'x';
  const fr = frame && hasSize(frame) ? frame.width / frame.height : null;
  const fixedRatio = choice.purpose === 'film' || choice.purpose === 'aspect';
  const mismatch = fr !== null && fixedRatio && Math.abs(fr / r.w * r.h - 1) > 0.05;
  const { res: _res, ...noRes } = value;
  /** Size-from-input and custom sizes become a plain aspect when the user then picks a resolution or MP. */
  const asAspect = value.purpose === 'custom' || value.purpose === 'same' ? { purpose: 'aspect' as Purpose, aspect: ratioText(r.w, r.h) } : {};
  const setAspect = (v: string) => {
    if (v === 'custom') onChange({ ...noRes, purpose: 'custom', w: r.w, h: r.h });
    else if (v === 'film' || v === 'match' || v === 'same') onChange({ ...value, purpose: v as Purpose });
    else onChange({ ...value, purpose: 'aspect', aspect: v.slice(2) });
  };
  const setRes = (v: string) => onChange({ ...value, ...asAspect, res: Number(v), mp: undefined });
  const setMp = (v: string) => onChange({ ...noRes, ...asAspect, mp: Number(v) });
  const setExact = (w: number, h: number) => onChange({ ...noRes, purpose: 'custom', w, h });
  return (
    <div className="sizeBox">
      <label>{label}</label>
      <div className="row" style={{ flexWrap: 'wrap', margin: '2px 0', alignItems: 'flex-end', gap: 6 }}>
        <span><div className="note">Aspect</div>
          <select value={aspectVal} onChange={(e) => setAspect(e.target.value)}>
            <option value="film">Film ({film.aspect})</option>
            {hasSrc && <option value="match">Match input ({ratioText(src.width, src.height)})</option>}
            {hasSrc && <option value="same">Same size as input ({src.width}×{src.height})</option>}
            {aspects.map((x) => <option key={x} value={'a:' + x}>{x}</option>)}
            <option value="custom">Custom{choice.purpose === 'custom' ? ' (' + ratioText(r.w, r.h) + ')' : ''}</option>
          </select></span>
        <span><div className="note">Resolution</div>
          <select title="The short side in pixels (720 = 1280×720 at 16:9)" value={resVal} onChange={(e) => setRes(e.target.value)}>
            {resVal === 'x' && <option value="x">{short}p (current)</option>}
            {RESOLUTIONS.map((x) => <option key={x} value={x}>{x}p</option>)}
          </select></span>
        <span><div className="note">Megapixels</div>
          <select title="Draft is fast; Final is slow and memory hungry." value={mpVal} onChange={(e) => setMp(e.target.value)}>
            {mpVal === 'x' && <option value="x">{r.mp.toFixed(2)} MP (current)</option>}
            {MPS.map((m) => { const q = QUALITY.find((x) => x.mp === m); return <option key={m} value={m}>{q ? q.label + ' · ' : ''}{m} MP</option>; })}
          </select></span>
      </div>
      <div className="row" style={{ margin: '4px 0' }}>
        <input type="number" style={{ width: 84 }} min={step} step={step} value={r.w} onChange={(e) => setExact(Number(e.target.value) || r.w, r.h)} />×
        <input type="number" style={{ width: 84 }} min={step} step={step} value={r.h} onChange={(e) => setExact(r.w, Number(e.target.value) || r.h)} />
        <input type="number" style={{ width: 84 }} min={0.02} step={0.05} title="Megapixels: type any value, the width and height follow (aspect kept)" key={'mp' + r.w + 'x' + r.h} defaultValue={Number(r.mp.toFixed(2))} onBlur={(e) => { const v = Number(e.target.value); if (v > 0 && Math.abs(v - r.mp) > 0.005) setMp(String(v)); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />MP
        <span className="note">rounded to {step} px · {ratioText(r.w, r.h)}{r.mp > 2.5 ? ' (large: slow and memory hungry)' : ''}</span></div>
      {mismatch && frame && <div className="warn">The first frame is {ratioText(frame.width!, frame.height!)} but this size is {ratioText(r.w, r.h)}.
        <div className="row" style={{ margin: '4px 0' }}><button onClick={() => onChange({ ...value, purpose: 'match' })}>Follow the frame</button><span className="note">or keep this size and the frame is fitted to it</span></div></div>}
    </div>
  );
}

/** The step a profile's size snaps to, and whether it takes an explicit size at all. */
export const sizeInfo = (p: Manifest) => ({ ok: p.slots.some((s) => s.type === 'enum' && !!(s as { customSize?: unknown }).customSize), step: (p.slots.find((s) => (s as Slot).customMultiple) as Slot | undefined)?.customMultiple ?? 8 });

/** Header chip + small panel for the film's properties. */
export function FilmChip() {
  const { film, setFilm } = useContext(C);
  const q = QUALITY.find((x) => x.mp === film.mp);
  const r = resolveSize({ purpose: 'film' }, film, null, 8), short = Math.min(r.w, r.h);
  const setShort = (sh: number) => { if (!(sh > 0)) return; const ratio = r.w / r.h; const w = ratio >= 1 ? sh * ratio : sh, h = ratio >= 1 ? sh : sh / ratio; setFilm({ ...film, mp: Math.round((w * h) / 1e4) / 100 }); };
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  return (
    <>
      <button className={'topBtn boxed' + (anchor ? ' open' : '')} title="Film properties: what every size chooser preselects" aria-haspopup="dialog" aria-expanded={!!anchor} onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}>
        <Icon name="film" /><span>{film.aspect}</span><span className="sub">· {q?.label ?? film.mp + ' MP'} · {film.seconds} s</span><Icon name="chev" size="s" />
      </button>
      {anchor && <Popover anchor={anchor} onClose={() => setAnchor(null)} title="Film properties" width={380}>
        <span className="note" style={{ margin: 0 }}>These only preselect the size and length boxes. Every generation shows its exact size before it runs.</span>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <Field label="Aspect ratio" style={{ flex: 1 }}><select className="selc" value={FILM_ASPECTS.includes(film.aspect) ? film.aspect : 'custom'} onChange={(e) => e.target.value !== 'custom' && setFilm({ ...film, aspect: e.target.value })}>{FILM_ASPECTS.map((a) => <option key={a}>{a}</option>)}<option value="custom">Custom{FILM_ASPECTS.includes(film.aspect) ? '' : ' (' + film.aspect + ')'}</option></select></Field>
          <Field label="Custom ratio" style={{ flex: 1 }}><input type="text" className="inp" key={'asp' + film.aspect} defaultValue={film.aspect} title="Any ratio, like 2.39:1 or 5:4" onBlur={(e) => { const m = /^s*(d+(?:.d+)?)s*[:x/]s*(d+(?:.d+)?)s*$/.exec(e.target.value); if (m && Number(m[1]) > 0 && Number(m[2]) > 0) setFilm({ ...film, aspect: m[1] + ':' + m[2] }); else e.target.value = film.aspect; }} /></Field>
        </div>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <Field label="Resolution" hint="The short side in pixels" style={{ flex: 1 }}><select className="selc" title="The short side in pixels" value={RESOLUTIONS.includes(short) ? short : 'x'} onChange={(e) => setShort(Number(e.target.value))}>
              {!RESOLUTIONS.includes(short) && <option value="x">{short}p (current)</option>}{RESOLUTIONS.map((x) => <option key={x} value={x}>{x}p</option>)}</select></Field>
          <Field label="Megapixels" style={{ flex: 1 }}><select className="selc" value={q ? film.mp : 'x'} onChange={(e) => e.target.value !== 'x' && setFilm({ ...film, mp: Number(e.target.value) })}>{!q && <option value="x">{film.mp} MP (custom)</option>}{QUALITY.map((x) => <option key={x.mp} value={x.mp}>{x.label} · {x.mp} MP</option>)}{MPS.filter((m) => !QUALITY.some((x) => x.mp === m)).map((m) => <option key={m} value={m}>{m} MP</option>)}</select></Field>
        </div>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <Field label="Custom resolution" hint="Short side in pixels, any value" style={{ flex: 1 }}><input type="number" className="inp mono" min={64} step={8} title="Short side in pixels, any value" key={'sh' + short} defaultValue={short} onBlur={(e) => { const v = Number(e.target.value); if (v >= 64 && v !== short) setShort(v); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} /></Field>
          <Field label="Custom MP" style={{ flex: 1 }}><input type="number" className="inp mono" min={0.02} step={0.05} key={'mp' + film.mp} defaultValue={film.mp} onBlur={(e) => { const v = Number(e.target.value); if (v > 0 && v !== film.mp) setFilm({ ...film, mp: v }); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} /></Field>
        </div>
        <div className="mono" style={{ color: 'var(--text)' }}>= {r.w} × {r.h} px ({r.mp.toFixed(2)} MP)</div>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <Field label="Default shot length (s)" style={{ flex: 1 }}><input type="number" className="inp mono" min={1} max={30} value={film.seconds} onChange={(e) => setFilm({ ...film, seconds: Math.max(1, Number(e.target.value) || 5) })} /></Field>
          <Field label="Target film length (s, optional)" style={{ flex: 1 }}><input type="number" className="inp mono" min={0} value={film.target ?? ''} onChange={(e) => setFilm({ ...film, target: e.target.value ? Number(e.target.value) : undefined })} /></Field>
        </div>
        <span className="note" style={{ margin: 0 }}>Draft is fast; Final is slow and needs a lot of GPU memory.</span>
      </Popover>}
    </>
  );
}
