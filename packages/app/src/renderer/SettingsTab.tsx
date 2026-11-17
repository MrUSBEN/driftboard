import { useCallback, useEffect, useState } from 'react';
import { api } from './shared.tsx';
import { ComfyPane } from './ComfyPane.tsx';
import { KEY_ACTIONS, allBinds, combo, saveBinds, resetBinds } from './keys.ts';
import type { GuideInfo, LlmSettings, LlmStatus } from '../main/api.ts';

const LEVELS = ['off', 'low', 'medium', 'high'] as const;
/** Usual local addresses; one click fills the address in. */
const SERVERS = [{ name: 'LM Studio', url: 'http://127.0.0.1:1234/v1' }, { name: 'Ollama', url: 'http://127.0.0.1:11434/v1' }, { name: 'llama.cpp', url: 'http://127.0.0.1:8080/v1' }, { name: 'KoboldCpp', url: 'http://127.0.0.1:5001/v1' }];
const KIND_NAME = { lmstudio: 'LM Studio', ollama: 'Ollama', openai: 'an OpenAI-compatible server' } as const;
const CTX = [8192, 16384, 32768, 65536];

function LlmPane({ notify }: { notify: (m: string) => void }) {
  const [s, setS] = useState<LlmSettings | null>(null);
  const [st, setSt] = useState<LlmStatus | null>(null);
  const [guides, setGuides] = useState<GuideInfo[]>([]);
  const [edit, setEdit] = useState<string | null>(null);
  const [text, setText] = useState('');

  const refresh = useCallback(async () => { setSt(await api.llmStatus()); }, []);
  const load = useCallback(async () => { setS(await api.llmSettings()); setGuides(await api.guides()); await refresh(); }, [refresh]);
  useEffect(() => { void load(); }, [load]);
  if (!s) return <div className="empty">Loading…</div>;

  const set = async (patch: Parameters<typeof api.llmSet>[0]) => { await api.llmSet(patch); setS(await api.llmSettings()); };
  const check = (key: 'unloadBeforeJob' | 'freeComfyBeforeLlm' | 'unloadAfterBatch' | 'allowDuringJobs', label: string, hint: string) => (
    <label className="row" style={{ color: 'var(--text)', margin: '6px 0' }} title={hint}><input type="checkbox" checked={s[key]} onChange={(e) => set({ [key]: e.target.checked })} />{label}</label>
  );
  const cur = st?.models.find((m) => m.id === s.model) ?? st?.models.find((m) => m.loaded && !m.embedding);
  const onOffOnly = !!cur?.reasoning && cur.reasoning.includes('on') && !cur.reasoning.includes('low');   // e.g. Gemma: only on/off
  const g = guides.find((x) => x.id === edit);

  return (
    <>
      <h2>LLM</h2>
      <div className="card">
        <div className="row"><span className={'dot' + (st?.ok ? ' ok' : '')} /><span className="note">{st?.ok ? 'Server connected' : (st?.error ?? 'Server not reachable')}</span><span className="sp" />
          <button onClick={refresh}>↻</button>
          <button title="Unload every loaded model to free GPU memory" onClick={async () => { const n = await api.llmUnload(); notify(`Unloaded ${n} model${n === 1 ? '' : 's'}`); void refresh(); }}>Free GPU</button></div>
        <label>Server</label>
        <div className="row">
          <select value={s.backend} onChange={(e) => set({ backend: e.target.value as LlmSettings['backend'] }).then(refresh)} title="Auto asks the server what it is">
            <option value="auto">Auto-detect</option><option value="lmstudio">LM Studio</option><option value="ollama">Ollama</option><option value="openai">Other OpenAI-compatible (llama.cpp, KoboldCpp, Jan…)</option>
          </select>
          {SERVERS.map((x) => <button key={x.url} className="ghost" title={`Use ${x.url}`} onClick={() => set({ url: x.url }).then(refresh)}>{x.name}</button>)}
        </div>
        <label>Server address (OpenAI-compatible, ends in /v1)</label>
        <input type="text" defaultValue={s.url} key={s.url} onBlur={(e) => e.target.value !== s.url && set({ url: e.target.value }).then(refresh)} />
        {st?.ok && st.caps && <div className="note">Found: {KIND_NAME[st.caps.kind]}. {st.caps.loadUnload ? 'The app loads the model with the context below and frees the GPU before ComfyUI runs.' : ''}</div>}
        {st?.ok && st.caps && !st.caps.loadUnload && <div className="warn">This server cannot load or unload models on request, so the app cannot free the GPU before a generation. Unload the model yourself (or give ComfyUI and the LLM enough memory together), and set its context size in the server itself.</div>}
        <label>Model</label>
        <select value={s.model} onChange={(e) => set({ model: e.target.value }).then(refresh)}>
          <option value="">(first available)</option>
          {st?.models.filter((m) => !m.embedding).map((m) => <option key={m.id} value={m.id}>{m.id}{m.loaded ? ` • loaded${m.context ? ` (${Math.round(m.context / 1024)}k)` : ''}` : ''}</option>)}
        </select>
        <label>Context length {cur?.maxContext ? <span className="note">(this model allows up to {Math.round(cur.maxContext / 1024)}k)</span> : null}</label>
        <div className="row">
          <select value={CTX.includes(s.contextLength) ? s.contextLength : 'custom'} onChange={(e) => e.target.value !== 'custom' && set({ contextLength: Number(e.target.value) })}>
            {CTX.map((n) => <option key={n} value={n}>{n / 1024}k tokens{n === 16384 ? ' (default)' : ''}</option>)}
            {!CTX.includes(s.contextLength) && <option value="custom">{s.contextLength} tokens</option>}
          </select>
          <input type="number" style={{ width: 110 }} value={s.contextLength} min={2048} step={1024} onChange={(e) => set({ contextLength: Math.max(2048, Number(e.target.value) || 16384) })} />
        </div>
        <div className="note">Default context: the app loads the model with this before LLM work (a model you loaded yourself is used as is if it has at least 8k). A project call uses about 2–4k tokens, so 16k leaves plenty of room.</div>
        <label>Maximum context (fail-safe)</label>
        <div className="row">
          <input type="number" style={{ width: 110 }} value={s.maxContext} min={s.contextLength} step={1024} onChange={(e) => set({ maxContext: Math.max(s.contextLength, Number(e.target.value) || 81920) })} />
          <span className="note">tokens · 80k = 81920</span>
        </div>
        <div className="note">If a prompt does not fit, the model is reloaded with a bigger context, doubling up to this limit, and the call is retried. Uses more GPU memory while it is bigger.</div>
      </div>

      <h2 style={{ marginTop: 12 }}>Thinking</h2>
      <div className="card">
        {(['director', 'enhance', 'chat'] as const).map((t) => (
          <div className="row" key={t} style={{ margin: '4px 0' }}>
            <span style={{ width: 110 }}>{t === 'director' ? 'Director' : t === 'enhance' ? 'Enhance / prompts' : 'Chat'}</span>
            {onOffOnly
              ? <select value={s.thinking[t] === 'off' ? 'off' : 'on'} onChange={(e) => set({ thinking: { [t]: e.target.value === 'on' ? 'medium' : 'off' } as never })}><option value="off">off</option><option value="on">on</option></select>
              : <select value={s.thinking[t]} onChange={(e) => set({ thinking: { [t]: e.target.value } as never })}>{LEVELS.map((l) => <option key={l}>{l}</option>)}</select>}
          </div>
        ))}
        <div className="note">More thinking gives better creative decisions but takes longer. Models that only have thinking on/off treat low, medium and high the same. The app allows extra tokens for thinking so answers are not cut off.</div>
      </div>

      <h2 style={{ marginTop: 12 }}>Freeing the GPU</h2>
      <div className="card">
        {check('unloadAfterBatch', 'Unload when a batch of LLM work ends', 'After a director step or "Write all prompts", free the GPU straight away')}
        {check('freeComfyBeforeLlm', 'Free ComfyUI memory before LLM work', 'ComfyUI keeps its models in VRAM after a job; this empties them so the LLM loads fast and runs at full speed')}
        {check('unloadBeforeJob', 'Unload before each ComfyUI job', 'Safety net: the model is always gone when image/video jobs start')}
        <div className="row" style={{ margin: '6px 0' }}>Unload after <input type="number" style={{ width: 64 }} min={0} value={s.idleMinutes} onChange={(e) => set({ idleMinutes: Math.max(0, Number(e.target.value) || 0) })} /> idle minutes <span className="note">(0 = never; for single Enhance and chat)</span></div>
        {check('allowDuringJobs', 'Allow LLM work while ComfyUI is generating', 'Needs memory for both models at once')}
        <div className="note">Tip: write all prompts first ("Write prompts" / Run all in the Story tab), then generate. The model is loaded once, used for everything, and unloaded before the first video starts.</div>
      </div>

      <h2 style={{ marginTop: 12 }}>Guides</h2>
      <div className="note">Each LLM task follows a guide: a plain text file you can edit. Edits are saved in your user folder and override the built-in one.</div>
      {guides.map((x) => (
        <div className="card" key={x.id}>
          <div className="row"><b style={{ flex: 1 }}>{x.title}</b>{x.custom && <span className="pill">edited</span>}
            <button onClick={() => { setEdit(edit === x.id ? null : x.id); setText(x.body); }}>{edit === x.id ? 'Close' : 'Edit'}</button></div>
          <div className="note">{x.id}{x.durationLine ? ` · the app writes the final “${x.durationLine}” line` : ''}</div>
        </div>
      ))}
      {g && (
        <div className="card">
          <label>{g.title}</label>
          <textarea style={{ minHeight: 320, fontFamily: 'monospace', fontSize: 12 }} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="row" style={{ marginTop: 6 }}>
            <button className="primary-sm" onClick={async () => { await api.guideSave(g.id, text); notify('Guide saved'); setGuides(await api.guides()); }}>Save</button>
            {g.custom && <button onClick={async () => { await api.guideReset(g.id); const gs = await api.guides(); setGuides(gs); setText(gs.find((y) => y.id === g.id)?.body ?? ''); notify('Back to the built-in guide'); }}>Reset to built-in</button>}
          </div>
        </div>
      )}
    </>
  );
}

/** Click a shortcut, press the new keys. Nothing changes until Save; "Set defaults" is the way back. */
function KeysPane({ notify }: { notify: (m: string) => void }) {
  const [b, setB] = useState<Record<string, string>>(allBinds);
  const [saved, setSaved] = useState<Record<string, string>>(allBinds);
  const [rec, setRec] = useState<string | null>(null);
  useEffect(() => {
    if (!rec) return;
    const k = (e: KeyboardEvent) => { e.preventDefault(); e.stopPropagation(); if (e.key === 'Escape') { setRec(null); return; } const c = combo(e); if (c) { setB((x) => ({ ...x, [rec]: c })); setRec(null); } };
    window.addEventListener('keydown', k, true); return () => window.removeEventListener('keydown', k, true);
  }, [rec]);
  const dirty = KEY_ACTIONS.some((a) => b[a.id] !== saved[a.id]);
  const clash = (id: string) => { const a = KEY_ACTIONS.find((x) => x.id === id)!; return KEY_ACTIONS.filter((x) => x.id !== id && x.group === a.group && b[x.id] === b[id]).map((x) => x.label); };
  const groups = [...new Set(KEY_ACTIONS.map((a) => a.group))];
  return (
    <>
      <h2>Keyboard shortcuts</h2>
      <div className="note">Click a shortcut, then press the new keys (Esc cancels). Changes apply when you press Save.</div>
      <div className="row" style={{ margin: '8px 0' }}>
        <button className="primary-sm" disabled={!dirty} onClick={() => { saveBinds(b); setSaved(b); notify('Shortcuts saved'); }}>Save</button>
        <button disabled={!dirty} onClick={() => setB(saved)}>Undo changes</button>
        <button title="Put every shortcut back to the built-in one" onClick={() => { if (window.confirm('Set every shortcut back to its default?')) { resetBinds(); const d = allBinds(); setB(d); setSaved(d); notify('Shortcuts reset to defaults'); } }}>Set defaults</button>
      </div>
      {groups.map((g) => (
        <div className="card" key={g}>
          <b>{g}</b>
          {KEY_ACTIONS.filter((a) => a.group === g).map((a) => {
            const c = clash(a.id);
            return (
              <div className="row keyRow" key={a.id}>
                <span style={{ flex: 1 }}>{a.label}</span>
                {b[a.id] !== a.def && <button className="ghost" title={`Back to ${a.def}`} onClick={() => setB({ ...b, [a.id]: a.def })}>↺</button>}
                <button className={'keyBtn' + (rec === a.id ? ' rec' : '')} onClick={() => setRec(rec === a.id ? null : a.id)}>{rec === a.id ? 'Press keys…' : b[a.id]}</button>
                {c.length > 0 && <span className="warn" title={c.join(', ')}>also: {c[0]}</span>}
              </div>
            );
          })}
        </div>
      ))}
      <div className="note">Mouse: middle button or left-drag on empty canvas pans; Shift-drag selects; right-click opens menus.</div>
    </>
  );
}

type Pane = 'keys' | 'llm' | 'comfy';
export function SettingsTab({ notify }: { notify: (m: string) => void }) {
  const [pane, setPane] = useState<Pane>(() => { try { const v = localStorage.getItem('driftboard.settingsPane'); return v === 'llm' || v === 'comfy' ? v : 'keys'; } catch { return 'keys'; } });
  const pick = (p: Pane) => { setPane(p); try { localStorage.setItem('driftboard.settingsPane', p); } catch { /* ignore */ } };
  return (
    <>
      <h2>Settings</h2>
      <div className="seg" style={{ marginBottom: 10 }}>
        <button className={pane === 'keys' ? 'on' : ''} onClick={() => pick('keys')}>Keyboard</button>
        <button className={pane === 'llm' ? 'on' : ''} onClick={() => pick('llm')}>LLM and guides</button>
        <button className={pane === 'comfy' ? 'on' : ''} onClick={() => pick('comfy')}>ComfyUI</button>
      </div>
      {pane === 'keys' ? <KeysPane notify={notify} /> : pane === 'llm' ? <LlmPane notify={notify} /> : <ComfyPane notify={notify} />}
    </>
  );
}
