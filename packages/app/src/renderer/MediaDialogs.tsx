import { useEffect, useRef, useState } from 'react';
import { thumbUrl, proxyUrl, getVolume, VolumeSlider, type Asset } from './shared.tsx';
import { ratioOf } from './size.tsx';

import { clamp, fit, dragBox, RATIOS, type Box, type Handle } from './cropMath.ts';

/** Drag a rectangle over the picture (or the video's poster) and crop to it. */
export function CropDialog({ asset, onOk, onCancel }: { asset: Asset; onOk: (box: Box) => void; onCancel: () => void }) {
  const W = asset.width ?? 1280, H = asset.height ?? 720;
  const sc = Math.min(680 / W, 420 / H, 1.5), dw = W * sc, dh = H * sc;
  const [lock, setLock] = useState('free');
  const [box, setBox] = useState<Box>({ x: 0, y: 0, w: W, h: H });
  const ratio = lock === 'free' ? null : lock === 'orig' ? W / H : ratioOf(lock);
  const drag = useRef<{ h: Handle; x0: number; y0: number; b: Box } | null>(null);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onCancel]);
  const start = (h: Handle) => (e: React.PointerEvent) => { e.preventDefault(); e.stopPropagation(); (e.target as HTMLElement).setPointerCapture(e.pointerId); drag.current = { h, x0: e.clientX, y0: e.clientY, b: box }; };
  const move = (e: React.PointerEvent) => { const d = drag.current; if (d) setBox(dragBox(d.b, d.h, (e.clientX - d.x0) / sc, (e.clientY - d.y0) / sc, W, H, ratio)); };
  const end = () => { drag.current = null; };
  const setLockTo = (v: string) => { setLock(v); if (v !== 'free') setBox(fit(W, H, v === 'orig' ? W / H : ratioOf(v))); };
  const num = (k: keyof Box) => <input type="number" style={{ width: 80 }} value={Math.round(box[k])} onChange={(e) => setBox((b) => { const n = { ...b, [k]: Number(e.target.value) || 0 }; return { x: clamp(n.x, 0, W - 16), y: clamp(n.y, 0, H - 16), w: clamp(n.w, 16, W - clamp(n.x, 0, W - 16)), h: clamp(n.h, 16, H - clamp(n.y, 0, H - 16)) }; })} />;
  const handles: [Handle, React.CSSProperties][] = [['nw', { left: -6, top: -6, cursor: 'nwse-resize' }], ['ne', { right: -6, top: -6, cursor: 'nesw-resize' }], ['sw', { left: -6, bottom: -6, cursor: 'nesw-resize' }], ['se', { right: -6, bottom: -6, cursor: 'nwse-resize' }],
    ['n', { left: 'calc(50% - 6px)', top: -6, cursor: 'ns-resize' }], ['s', { left: 'calc(50% - 6px)', bottom: -6, cursor: 'ns-resize' }], ['w', { left: -6, top: 'calc(50% - 6px)', cursor: 'ew-resize' }], ['e', { right: -6, top: 'calc(50% - 6px)', cursor: 'ew-resize' }]];
  return (
    <div className="modalBack" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal" style={{ width: 'auto', maxWidth: 760 }}>
        <h3>Crop {asset.kind}{asset.kind === 'video' ? ' (the whole clip is cropped to this box)' : ''}</h3>
        <div className="cropStage" style={{ width: dw, height: dh }} onPointerMove={move} onPointerUp={end}>
          <img src={thumbUrl(asset.id)} draggable={false} style={{ width: dw, height: dh }} />
          <div className="cropShade" style={{ left: 0, top: 0, width: dw, height: box.y * sc }} />
          <div className="cropShade" style={{ left: 0, top: (box.y + box.h) * sc, width: dw, height: dh - (box.y + box.h) * sc }} />
          <div className="cropShade" style={{ left: 0, top: box.y * sc, width: box.x * sc, height: box.h * sc }} />
          <div className="cropShade" style={{ left: (box.x + box.w) * sc, top: box.y * sc, width: dw - (box.x + box.w) * sc, height: box.h * sc }} />
          <div className="cropBox" style={{ left: box.x * sc, top: box.y * sc, width: box.w * sc, height: box.h * sc }} onPointerDown={start('move')}>
            {handles.map(([h, st]) => <i key={h} className="cropHandle" style={st} onPointerDown={start(h)} />)}
          </div>
        </div>
        <div className="row" style={{ margin: '8px 0', flexWrap: 'wrap' }}>
          <span className="note">Shape</span>
          <div className="seg">{RATIOS.map(([k, label]) => <button key={k} className={lock === k ? 'on' : ''} onClick={() => setLockTo(k)}>{label}</button>)}</div>
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>x {num('x')} y {num('y')} w {num('w')} h {num('h')}<span className="note">px · result {Math.round(box.w)}×{Math.round(box.h)} (of {W}×{H})</span></div>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <button onClick={() => { setBox({ x: 0, y: 0, w: W, h: H }); setLock('free'); }}>Reset</button>
          <button onClick={onCancel}>Cancel</button>
          <button className="primary-sm" onClick={() => onOk({ x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) })}>Crop</button>
        </div>
      </div>
    </div>
  );
}

/** Watch the clip, drag the two handles (or press the buttons while it plays) and keep only that part. */
export function TrimDialog({ asset, onOk, onCancel }: { asset: Asset; onOk: (start: number, end: number) => void; onCancel: () => void }) {
  const dur = (asset.duration_ms ?? 0) / 1000 || 1;
  const [range, setRange] = useState<[number, number]>([0, dur]);
  const [pos, setPos] = useState(0);
  const vid = useRef<HTMLVideoElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const drag = useRef<'a' | 'b' | 'p' | null>(null);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onCancel]);
  const at = (e: { clientX: number }) => { const r = bar.current!.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1) * dur; };
  const seek = (t: number) => { if (vid.current) vid.current.currentTime = t; setPos(t); };
  const down = (w: 'a' | 'b' | 'p') => (e: React.PointerEvent) => { e.preventDefault(); e.stopPropagation(); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); drag.current = w; if (w === 'p') seek(at(e)); };
  const move = (e: React.PointerEvent) => {
    const w = drag.current; if (!w) return; const t = at(e);
    if (w === 'a') { const s = Math.min(t, range[1] - 0.1); setRange([s, range[1]]); seek(s); }
    else if (w === 'b') { const en = Math.max(t, range[0] + 0.1); setRange([range[0], en]); seek(en); }
    else seek(t);
  };
  const playRange = () => { const v = vid.current; if (!v) return; v.volume = getVolume(); v.currentTime = range[0]; void v.play(); };
  useEffect(() => { const f = () => { if (vid.current) vid.current.volume = getVolume(); }; f(); window.addEventListener('driftboard-volume', f); return () => window.removeEventListener('driftboard-volume', f); }, []);
  useEffect(() => { const v = vid.current; if (!v) return; const f = () => { setPos(v.currentTime); if (!v.paused && v.currentTime >= range[1]) v.pause(); else if (!v.paused && v.currentTime < range[0] - 0.05) v.currentTime = range[0]; }; v.addEventListener('timeupdate', f); return () => v.removeEventListener('timeupdate', f); }, [range]);
  const pct = (t: number) => `${(t / dur) * 100}%`;
  const fmt = (t: number) => t.toFixed(2) + 's';
  return (
    <div className="modalBack" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal" style={{ width: 'min(720px, 92vw)' }}>
        <h3>Trim video</h3>
        <video ref={vid} src={proxyUrl(asset.id)} style={{ width: '100%', maxHeight: 360, background: 'var(--media)' }} onClick={() => { const v = vid.current!; if (v.paused) { if (v.currentTime < range[0] || v.currentTime >= range[1] - 0.05) v.currentTime = range[0]; v.volume = getVolume(); void v.play(); } else v.pause(); }} />
        <div className="trimBar" ref={bar} onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerDown={down('p')}>
          <div className="trimKeep" style={{ left: pct(range[0]), width: `${((range[1] - range[0]) / dur) * 100}%` }} />
          <i className="trimPos" style={{ left: pct(pos) }} />
          <b className="trimHandle" style={{ left: pct(range[0]) }} onPointerDown={down('a')} title="Start" />
          <b className="trimHandle" style={{ left: pct(range[1]) }} onPointerDown={down('b')} title="End" />
        </div>
        <div className="row" style={{ margin: '8px 0', flexWrap: 'wrap' }}>
          <button onClick={() => setRange([Math.min(pos, range[1] - 0.1), range[1]])}>Start here</button>
          <button onClick={() => setRange([range[0], Math.max(pos, range[0] + 0.1)])}>End here</button>
          <button onClick={playRange}>▶ Play selection</button><VolumeSlider />
          <span className="sp" />
          <span className="note">keep {fmt(range[0])} → {fmt(range[1])} · {fmt(range[1] - range[0])} of {fmt(dur)}</span>
        </div>
        <div className="note">Click the bar to move the playhead; drag the two handles to set where the new clip starts and ends. The original stays.</div>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <button onClick={() => setRange([0, dur])}>Reset</button>
          <button onClick={onCancel}>Cancel</button>
          <button className="primary-sm" onClick={() => onOk(+range[0].toFixed(3), +range[1].toFixed(3))}>Trim</button>
        </div>
      </div>
    </div>
  );
}
