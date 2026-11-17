import { hit } from './keys.ts';
import { forwardRef, useCallback, useContext, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { C, api, assetUrl, proxyUrl, thumbUrl, fmtTime, getVolume, takePendingPlay, type Asset } from './shared.tsx';

export interface PreviewHandle { frame(): { assetId: string; frame: number } | null }

/**
 * One player. While playing or scrubbing it shows a short-GOP proxy (smooth, frame-exact);
 * when paused it shows the full-quality file at the same frame.
 */
export const Preview = forwardRef<PreviewHandle, { asset: Asset | null; notify: (m: string) => void }>(function Preview({ asset, notify }, ref) {
  const { jobs } = useContext(C);
  const proxy = useRef<HTMLVideoElement>(null), full = useRef<HTMLVideoElement>(null);
  const [frame, setFrameState] = useState(0);
  const frameRef = useRef(0);
  const setFrame = (f: number) => { frameRef.current = f; setFrameState(f); };
  const [playing, setPlaying] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const [busy, setBusy] = useState(false);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fps = asset?.fps ?? 24;
  const [vidDur, setVidDur] = useState(0);
  const total = asset?.duration_ms ? Math.max(1, Math.round((asset.duration_ms / 1000) * fps)) : Math.max(1, Math.round(vidDur * fps));
  const isVideo = asset?.kind === 'video';
  const isAudio = asset?.kind === 'audio';
  const aud = useRef<HTMLAudioElement>(null);
  const [aPlaying, setAPlaying] = useState(false);
  const [aTime, setATime] = useState(0), [aDur, setADur] = useState(0);
  /** the ▶ in a canvas node asks for this asset to play: play it now, or as soon as it is loaded */
  const wantPlay = useRef(false);
  const playNow = () => { if (isAudio) { const a = aud.current; if (a) { a.volume = getVolume(); void a.play(); setAPlaying(true); } } else if (isVideo) play(); };
  const toggleNow = () => { if (isAudio) { const a = aud.current; if (a && !a.paused) { a.pause(); setAPlaying(false); } else playNow(); } else if (isVideo) { if (playing) pause(); else play(); } };
  useEffect(() => { wantPlay.current = !!asset && takePendingPlay(asset.id); setAPlaying(false); setATime(0); }, [asset?.id]);
  useEffect(() => {
    const f = (e: Event) => { const id = (e as CustomEvent<string>).detail; if (asset?.id === id) { takePendingPlay(id); toggleNow(); } else if (asset) wantPlay.current = false; };
    window.addEventListener('driftboard-play', f); return () => window.removeEventListener('driftboard-play', f);
  });
  const ready = () => { if (wantPlay.current) { wantPlay.current = false; playNow(); } };

  useImperativeHandle(ref, () => ({ frame: () => (asset && isVideo ? { assetId: asset.id, frame } : null) }), [asset, isVideo, frame]);

  useEffect(() => { setFrame(0); setPlaying(false); setShowFull(false); }, [asset?.id]);
  useEffect(() => {
    const apply = () => { if (proxy.current) proxy.current.volume = getVolume(); };
    apply(); window.addEventListener('driftboard-volume', apply); return () => window.removeEventListener('driftboard-volume', apply);
  }, [asset?.id]);

  const step = (d: number) => seek(frameRef.current + d);
  const seek = useCallback((f: number) => {
    const n = Math.min(Math.max(0, f), total - 1);
    const v = proxy.current; if (!v) return;
    setShowFull(false); setFrame(n);
    v.currentTime = (n + 0.5) / fps;
    clearTimeout(idle.current);
    idle.current = setTimeout(() => {   // settle on the full-quality file, but only once it really is at this frame (else keep the proxy frame)
      const o = full.current; if (!o) return;
      const target = (n + 0.5) / fps;
      const go = () => {
        const done = () => { o.removeEventListener('seeked', done); if (frameRef.current === n && Math.abs(o.currentTime - target) < 1.5 / fps) setShowFull(true); };
        o.addEventListener('seeked', done); o.currentTime = target;
      };
      if (o.readyState < 1) o.addEventListener('loadedmetadata', go, { once: true }); else go();
    }, 250);
  }, [fps, total]);

  const play = () => {
    const v = proxy.current; if (!v) return;
    clearTimeout(idle.current); setShowFull(false);
    if (frame >= total - 1) v.currentTime = 0;
    void v.play(); setPlaying(true);
  };
  const pause = () => { const v = proxy.current; if (!v) return; v.pause(); setPlaying(false); seek(Math.floor(v.currentTime * fps)); };

  // frame counter while playing
  useEffect(() => {
    if (!playing) return; let raf = 0;
    const tick = () => { const v = proxy.current; if (v) { setFrame(Math.min(total - 1, Math.floor(v.currentTime * fps))); if (v.ended) { setPlaying(false); return; } } raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf);
  }, [playing, fps, total]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement; if (['TEXTAREA', 'INPUT', 'SELECT'].includes(t.tagName) || !isVideo) return;
      if (hit(e, 'preview.play')) { e.preventDefault(); playing ? pause() : play(); }
      else if (hit(e, 'preview.nextFrame')) { e.preventDefault(); step(1); }
      else if (hit(e, 'preview.prevFrame')) { e.preventDefault(); step(-1); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  });

  const grab = async () => {
    if (!asset || !isVideo) return;
    setBusy(true);
    const r = await api.frameExtract(asset.id, { frame });
    setBusy(false);
    notify(r.ok ? `Frame ${frame} saved to the canvas` : r.error);
  };

  if (!asset) return <div className="previewEmpty">Select an image or clip on the canvas to preview it.</div>;
  const made = jobs.find((j) => j.outputs.some((o) => o.assetId === asset.id));
  const params = made ? (JSON.parse(made.params) as Record<string, unknown>) : null;
  const ar = asset.width && asset.height ? `${asset.width} / ${asset.height}` : '16 / 9';

  return (
    <div className="previewCol">
      <div className="stage">
        <button className="fsBtn" title="Full screen (P)" onClick={(e) => { const st = e.currentTarget.closest('.stage') as HTMLElement; void (document.fullscreenElement ? document.exitFullscreen() : st.requestFullscreen()); }}>⛶</button>
        <div className="frame" style={{ aspectRatio: ar }}>
          {isVideo ? <>
            <video ref={proxy} src={proxyUrl(asset.id)} preload="auto" playsInline onCanPlay={ready} onLoadedMetadata={(e) => setVidDur(e.currentTarget.duration)} onEnded={() => setPlaying(false)} style={{ visibility: showFull ? 'hidden' : 'visible' }} />
            <video ref={full} src={assetUrl(asset.id)} preload="auto" muted playsInline style={{ visibility: showFull ? 'visible' : 'hidden' }} />
          </> : isAudio ? <div className="audioPrev"><img src={thumbUrl(asset.id)} /><audio ref={aud} src={assetUrl(asset.id)} preload="auto" onCanPlay={ready} onLoadedMetadata={(e) => setADur(e.currentTarget.duration)} onTimeUpdate={(e) => setATime(e.currentTarget.currentTime)} onEnded={() => setAPlaying(false)} /></div> : <img src={assetUrl(asset.id)} />}
        </div>
      </div>
      {isAudio && <div className="transport">
        <div className="row">
          <button onClick={toggleNow}>{aPlaying ? '❚❚' : '▶'}</button>
          <span className="mono">{fmtTime(aTime)} / {fmtTime(aDur)}</span>
        </div>
        <input type="range" min={0} max={Math.max(0.01, aDur)} step={0.01} value={aTime} onChange={(e) => { const a = aud.current; if (a) { a.currentTime = Number(e.target.value); setATime(a.currentTime); } }} />
      </div>}
      {isVideo && <div className="transport">
        <div className="row">
          <button onClick={playing ? pause : play}>{playing ? '❚❚' : '▶'}</button>
          <button title="Previous frame (Alt+←)" onClick={() => step(-1)}>◀︎</button>
          <button title="Next frame (Alt+→)" onClick={() => step(1)}>▶︎</button>
          <span className="mono">{fmtTime(frame / fps)} · f{frame}/{total - 1}</span>
          <span className="sp" />
          <button disabled={busy} onClick={grab}>Grab frame</button>
        </div>
        <input type="range" min={0} max={total - 1} value={frame} onChange={(e) => { if (playing) { proxy.current?.pause(); setPlaying(false); } seek(Number(e.target.value)); }} />
      </div>}
      <div className="details">
        <div className="note">{asset.width ? `${asset.width}×${asset.height}` : asset.kind}{isVideo ? ` · ${fps} fps${asset.has_audio ? ' · audio' : ''}` : ''}</div>
        {made && <div className="note">{made.profile_id}{params && typeof params.seed === 'number' ? ` · seed ${params.seed}` : ''}</div>}
        {typeof params?.prompt === 'string' && <div className="prompt full">{params.prompt}</div>}
      </div>
    </div>
  );
});
