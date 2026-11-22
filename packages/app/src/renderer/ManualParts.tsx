/* Small building blocks of the manual Story: thumbnails that scrub on hover and peek large while Alt is held, the status capsule,
   the one split button that generates and sets the batch, and the number-and-menu chips. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { assetUrl, proxyUrl, thumbUrl, type Asset } from './shared.tsx';
import { Icon } from './ui/Icon.tsx';
import { Popover } from './ui/ui.tsx';

/** Hold Alt over a picture or clip to see it large next to the pointer; nothing opens without Alt. */
function Peek({ asset, x, y }: { asset: Asset; x: number; y: number }) {
  const w = Math.min(window.innerWidth * 0.34, 640), right = x + 24 + w < window.innerWidth;
  const left = right ? x + 24 : Math.max(8, x - 24 - w), top = Math.max(8, Math.min(y - 60, window.innerHeight - 8 - w * 0.6));
  return createPortal(
    <div className="mPeek" style={{ left, top, width: w }} aria-hidden="true">
      {asset.kind === 'video' ? <video src={proxyUrl(asset.id)} autoPlay muted loop playsInline /> : <img src={asset.kind === 'image' ? assetUrl(asset.id) : thumbUrl(asset.id)} alt="" />}
    </div>, document.body);
}

/**
 * A picture, clip or sound as a small tile. A clip scrubs under the pointer (no click); with Alt held, a large peek follows the pointer.
 * Clicking selects it (the right viewer shows it).
 */
export function Thumb({ asset, selected, picked, onClick, onRemove, w = 84, h = 48, label, children }: {
  asset: Asset | undefined; selected?: boolean; picked?: boolean; onClick?: () => void; onRemove?: () => void; w?: number; h?: number; label?: string; children?: ReactNode;
}) {
  const vid = useRef<HTMLVideoElement>(null);
  const [hot, setHot] = useState(false);
  const [frac, setFrac] = useState<number | null>(null);
  const [peek, setPeek] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!peek) return;
    const up = (e: KeyboardEvent) => { if (e.key === 'Alt') setPeek(null); };
    window.addEventListener('keyup', up); window.addEventListener('blur', () => setPeek(null), { once: true });
    return () => window.removeEventListener('keyup', up);
  }, [peek]);
  if (!asset) return <div className="mThumb missing" style={{ width: w, height: h }} title="Missing file" />;
  const isVideo = asset.kind === 'video';
  return (
    <div className={'mThumb' + (selected ? ' sel' : '') + (picked ? ' pk' : '')} style={{ width: w, height: h }} role="button" tabIndex={0} aria-label={label ?? 'Open in the viewer'} aria-pressed={selected}
      onClick={onClick} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(); } }}
      onMouseEnter={() => isVideo && setHot(true)} onMouseLeave={() => { setFrac(null); setPeek(null); }}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect(); const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
        if (isVideo && !e.altKey) { setFrac(f); const v = vid.current; if (v && Number.isFinite(v.duration)) v.currentTime = f * v.duration; }
        setPeek(e.altKey ? { x: e.clientX, y: e.clientY } : null);
      }}>
      <img src={thumbUrl(asset.id)} alt="" draggable={false} loading="lazy" />
      {isVideo && hot && <video ref={vid} src={proxyUrl(asset.id)} muted preload="auto" playsInline className={frac === null ? 'off' : ''} />}
      {frac !== null && <span className="ph" style={{ left: `${frac * 100}%` }} />}
      {isVideo && <span className="vid">{asset.duration_ms ? `${(asset.duration_ms / 1000).toFixed(1)} s` : ''}</span>}
      {asset.kind === 'audio' && <span className="vid"><Icon name="sound" size={10} /></span>}
      {picked && <span className="star" aria-label="Picked"><Icon name="starf" size={11} /></span>}
      {onRemove && <button type="button" className="rm" aria-label="Remove" title="Remove" onClick={(e) => { e.stopPropagation(); onRemove(); }}><Icon name="x" size={10} /></button>}
      {children}
      {peek && <Peek asset={asset} x={peek.x} y={peek.y} />}
    </div>
  );
}

export interface StepState { running: number; queued: number; pct?: number; done: number; failed?: string }
/** One capsule that shows where a step is: Ready, Running 42%, N takes, Failed. */
export function Capsule({ s, takes }: { s: StepState; takes: number }) {
  const cls = s.running || s.queued ? 'run' : s.failed && !takes ? 'bad' : takes ? 'done' : '';
  const text = s.running ? `Running${s.pct !== undefined ? ` ${Math.round(s.pct * 100)}%` : ''}${s.running + s.queued > 1 ? ` · ${s.running + s.queued} left` : ''}`
    : s.queued ? `Queued ${s.queued}` : s.failed && !takes ? 'Failed' : takes ? `${takes} ${takes === 1 ? 'take' : 'takes'}` : 'Ready';
  return <span className={'mCap ' + cls} title={s.failed ?? undefined}>{cls === 'done' && <Icon name="check" size={11} />}{text}</span>;
}

/** Generate with the batch count in one control: the main button says what runs, the arrow opens presets and a typed number. */
export function GenButton({ n, setN, running, hasTakes, onGo, onCancel, disabled, title }: {
  n: number; setN: (n: number) => void; running: boolean; hasTakes: boolean; onGo: () => void; onCancel: () => void; disabled?: boolean; title?: string;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <span className={'mSplit' + (running ? ' stop' : '')}>
      <button type="button" className="main" disabled={disabled && !running} title={title} onClick={running ? onCancel : onGo}>{running ? 'Cancel' : `${hasTakes ? 'Another' : 'Generate'} ×${n}`}</button>
      {!running && <button type="button" className="arr" aria-label="How many tries" onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}><Icon name="chev" size="s" /></button>}
      {anchor && <Popover anchor={anchor} onClose={() => setAnchor(null)} width={200} title="How many tries">
        <div className="mPresets">{[1, 2, 4, 8].map((v) => <button key={v} type="button" className={v === n ? 'on' : ''} onClick={() => { setN(v); setAnchor(null); }}>{v}</button>)}</div>
        <input className="inp mono" type="number" min={1} max={24} placeholder="Type a number" aria-label="Number of tries" value={[1, 2, 4, 8].includes(n) ? '' : n} onChange={(e) => setN(Math.max(1, Math.min(24, Math.round(Number(e.target.value)) || 1)))} />
        <span className="xs faint">Each try gets a new seed.</span>
      </Popover>}
    </span>
  );
}
