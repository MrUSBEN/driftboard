import { useCallback, useEffect, useState } from 'react';
import { api, type Slot } from './shared.tsx';
import { SlotField } from './SlotField.tsx';

type ProfileInfo = Awaited<ReturnType<typeof api.profiles>>[number];
type Health = Awaited<ReturnType<typeof api.comfyHealth>>[number];
type Prefs = Awaited<ReturnType<typeof api.comfyPrefs>>;

const isInput = (s: Slot) => s.type === 'image' || s.type === 'image_list' || s.type === 'video' || s.type === 'video_list' || s.type === 'audio_list';
/** Settings that belong to the Generate form or the film (prompt, seed, length, size), not to a profile's defaults. */
const isPerShot = (s: Slot) => s.role === 'prompt' || s.role === 'seed' || s.role === 'duration' || s.role === 'aspect' || (s.type === 'enum' && !!s.customSize) || (s.type === 'number' && /megapixel/.test(s.id));
const announce = () => window.dispatchEvent(new Event('driftboard-profiles'));

/**
 * Settings → ComfyUI: the connection, then one card per profile (on/off, is everything installed, which model files,
 * defaults for every generation), then the user's own profiles folder. Everything here is saved in the user data folder.
 */
export function ComfyPane({ notify }: { notify: (m: string) => void }) {
  const [status, setStatus] = useState<{ ok: boolean; version?: string; error?: string; url: string } | null>(null);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [list, setList] = useState<ProfileInfo[]>([]);
  const [health, setHealth] = useState<Record<string, Health>>({});
  const [options, setOptions] = useState<Record<string, Record<string, string[]>>>({});
  const [has, setHas] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const st = await api.comfyStatus(); setStatus(st);
      const ps = await api.profiles(); setList(ps);
      if (!st.ok) { setHealth({}); return; }
      const need = [...new Set(ps.flatMap((p) => p.slots.flatMap((s) => (s.type === 'boolean' && s.needsNodes) || [])))];
      setHas(need.length ? await api.comfyHas(need) : {});
      setHealth(Object.fromEntries((await api.comfyHealth()).map((h) => [h.id, h])));
      const o: Record<string, Record<string, string[]>> = {};
      for (const p of ps) o[p.id] = await api.profileOptions(p.id);
      setOptions(o);
    } finally { setChecking(false); }
  }, []);
  const loadPrefs = useCallback(async () => setPrefs(await api.comfyPrefs()), []);
  useEffect(() => { void loadPrefs(); void check(); }, [loadPrefs, check]);
  if (!prefs) return <div className="empty">Loading…</div>;

  const setDefault = async (id: string, s: Slot, v: unknown) => {
    await api.comfySetDefault(id, s.id, v); await loadPrefs();
    if (s.type === 'enum' && s.model || s.type === 'boolean') setHealth(Object.fromEntries((await api.comfyHealth()).map((h) => [h.id, h])));
  };

  return (
    <>
      <h2>ComfyUI</h2>
      <div className="card">
        <div className="row"><span className={'dot' + (status?.ok ? ' ok' : '')} /><span className="note">{status ? (status.ok ? `Connected · ComfyUI ${status.version}` : status.error ?? 'Not reachable') : 'Checking…'}</span><span className="sp" />
          <button disabled={checking} onClick={check}>{checking ? 'Checking…' : '↻ Check again'}</button></div>
        <label>Server address</label>
        <input type="text" defaultValue={prefs.url} key={prefs.url} onBlur={async (e) => { if (e.target.value && e.target.value !== prefs.url) { await api.setComfyUrl(e.target.value); await loadPrefs(); await check(); } }} />
        <div className="note">Every workflow below runs on a plain ComfyUI install: no custom node packs are needed. Optional speed-ups appear only when ComfyUI has them.</div>
      </div>

      <h2 style={{ marginTop: 12 }}>Profiles</h2>
      <div className="note">A profile is one ComfyUI workflow plus what Driftboard may change in it. Defaults set here apply to every generation; the Generate form shows them under Advanced and can change them for one run.</div>
      {list.map((p) => {
        const h = health[p.id]; const on = p.enabled; const mine = prefs.profiles[p.id]?.defaults ?? {};
        const slots = (p.slots as Slot[]).filter((s) => !isInput(s) && !isPerShot(s) && !(s.type === 'boolean' && s.needsNodes?.some((n) => !has[n])));
        const models = slots.filter((s) => s.type === 'enum' && s.model);
        const rest = slots.filter((s) => !(s.type === 'enum' && s.model));
        const changed = Object.keys(mine).length;
        return (
          <div className={'card' + (on ? '' : ' off')} key={p.id}>
            <div className="row">
              <label className="row" style={{ color: 'var(--text)', margin: 0 }} title="Off hides this profile everywhere in the app"><input type="checkbox" checked={on} onChange={async (e) => { await api.comfySetEnabled(p.id, e.target.checked); setList(await api.profiles()); announce(); }} /><b>{p.title}</b></label>
              {p.source === 'user' && <span className="pill">your profile</span>}
              {changed > 0 && <span className="pill" title={Object.keys(mine).join(', ')}>{changed} default{changed === 1 ? '' : 's'} set</span>}
              <span className="sp" />
              {h && (h.ok ? <span className="note">✓ ready</span> : <span className="warn" title={h.error ?? ''}>{h.error ? 'cannot check' : 'missing parts'}</span>)}
              <button onClick={() => setOpen(open === p.id ? null : p.id)}>{open === p.id ? 'Close' : 'Settings'}</button>
            </div>
            {h && !h.ok && (h.missingNodes.length > 0 || h.missingModels.length > 0) && (
              <div className="note">{h.missingNodes.length > 0 && <>Nodes not in ComfyUI: {h.missingNodes.join(', ')}. </>}{h.missingModels.length > 0 && <>Model files not in ComfyUI: {h.missingModels.map((m) => `${m.name} (${m.kind})`).join(', ')}.</>}</div>
            )}
            {open === p.id && (
              <div style={{ marginTop: 6 }}>
                {models.length > 0 && <><b className="sub">Models</b><div className="note">Files come from ComfyUI's own folders. The stock file is marked; files that look like this model are listed first, any other file (a fine-tune) under "Other files".</div></>}
                {models.map((s) => <div key={s.id}><SlotField slot={{ ...s, wfDefault: s.wfDefault ?? (s.type === 'enum' ? s.default : undefined) } as Slot} value={mine[s.id]} onChange={(v) => setDefault(p.id, s, v)} options={options[p.id]?.[s.id]} />{mine[s.id] !== undefined && <button className="ghost" onClick={() => setDefault(p.id, s, undefined)}>↺ back to stock</button>}</div>)}
                {rest.length > 0 && <b className="sub">Defaults</b>}
                {rest.map((s) => <div key={s.id}><SlotField slot={s} value={mine[s.id]} onChange={(v) => setDefault(p.id, s, v)} options={options[p.id]?.[s.id]} />{mine[s.id] !== undefined && <button className="ghost" onClick={() => setDefault(p.id, s, undefined)}>↺ workflow value</button>}</div>)}
                {!models.length && !rest.length && <div className="note">This profile has no settings to set here.</div>}
                <div className="row" style={{ marginTop: 8 }}>
                  <button disabled={!changed} onClick={async () => { if (!window.confirm(`Put every setting of ${p.title} back to the stock value?`)) return; await api.comfyResetProfile(p.id); await loadPrefs(); setList(await api.profiles()); announce(); await check(); notify('Back to stock'); }}>Reset to stock</button>
                  <span className="note">id {p.id} · version {p.version}</span>
                </div>
              </div>
            )}
          </div>
        );
      })}

      <h2 style={{ marginTop: 12 }}>Your profiles</h2>
      <div className="card">
        <div className="note">Put a folder with a <code>manifest.json</code> and a <code>workflow.json</code> (ComfyUI "Export (API)") here to add a profile. A folder with the same id as a built-in profile replaces it.</div>
        <div className="row" style={{ marginTop: 6 }}><code style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{prefs.userDir}</code>
          <button onClick={() => void api.openProfilesFolder()}>Open folder</button>
          <button onClick={async () => { const r = await api.reloadProfiles(); await loadPrefs(); announce(); await check(); notify(`${r.count} profile${r.count === 1 ? '' : 's'} loaded${r.errors.length ? `, ${r.errors.length} with problems` : ''}`); }}>Reload profiles</button></div>
        {prefs.errors.map((e, i) => <div key={i} className="err">{e}</div>)}
      </div>
    </>
  );
}
