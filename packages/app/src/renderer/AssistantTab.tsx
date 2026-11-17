import { PrepInput } from "./PrepInput.tsx";
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { activity } from './shared.tsx';
import { C, api, thumbUrl, autoAssign, valuesOfDraft, imageSlots, type Draft, type Manifest } from './shared.tsx';
import { SizeChooser, resolveSize, sizeInfo, useSizeChoice, withSize } from './size.tsx';
import type { ChatMsg, Proposal } from '../main/api.ts';

const ACTIONS: { id: string; label: string; hint: string }[] = [
  { id: '', label: 'Chat', hint: 'Ask anything about your film, or ask it to make a picture or video' },
  { id: 'script-from-idea', label: 'Script from idea', hint: 'Turn a premise into a short Fountain script' },
  { id: 'dialogue-polish', label: 'Polish dialogue', hint: 'Make lines sound natural' },
];

/** Pick the profile for what the assistant proposed, given how many pictures are attached. */
export function profileFor(kind: Proposal['kind'], profiles: Manifest[], hasInputs: boolean): Manifest | undefined {
  const needs = (p: Manifest) => imageSlots(p).some((s) => s.type === 'image' && s.required);
  const hasPrompt = (p: Manifest) => p.slots.some((s) => s.role === 'prompt' && s.type === 'text');
  const pool = profiles.filter(hasPrompt);
  if (kind === 'image') return pool.find((p) => p.kind === 'image' && !needs(p) && !imageSlots(p).length) ?? pool.find((p) => p.kind === 'image' && !needs(p));
  if (kind === 'edit') return pool.find((p) => p.kind === 'image' && imageSlots(p).length) ?? pool.find((p) => p.kind === 'image');
  const vids = pool.filter((p) => p.kind === 'video');
  return hasInputs ? (vids.find((p) => needs(p)) ?? vids[0]) : (vids.find((p) => !needs(p) && !imageSlots(p).length) ?? vids.find((p) => !needs(p)) ?? vids[0]);
}

/** The prompt part of an ordinary reply: a fenced or quoted block if there is one, else the text without a leading "Here is…:" line. */
export function promptOf(m: ChatMsg): string {
  if (m.proposal) return m.proposal.prompt;
  const code = /```(?:\w+)?\n([\s\S]*?)```/.exec(m.content); if (code) return code[1]!.trim();
  const quote = /^[>"“]\s*([\s\S]+?)["”]?$/m.exec(m.content); if (quote && quote[1]!.length > 40) return quote[1]!.trim();
  const lines = m.content.trim().split('\n'); if (lines.length > 1 && /:\s*$/.test(lines[0]!)) return lines.slice(1).join('\n').trim();
  return m.content.trim();
}

export function AssistantTab({ notify, openDraft, selectedAssets }: { notify: (m: string) => void; openDraft: (d: Draft) => void; selectedAssets: string[] }) {
  const { profiles, assets, film } = useContext(C);
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [text, setText] = useState('');
  const [action, setAction] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [cleaning, setCleaning] = useState(false);
  const [attach, setAttach] = useState<string[]>([]);
  const [size, setSize] = useSizeChoice('chat');
  const end = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => setMsgs(await api.chatState()), []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs, busy]);

  const send = async () => {
    if (!text.trim() || busy) return;
    setErr(''); setBusy(true);
    const t = text, att = attach; setMsgs((m) => [...m, { role: 'user', content: t, ts: Date.now(), action: action || undefined, images: att.length ? att : undefined }]); setText(''); setAttach([]);
    const r = await api.chatSend(t, action || undefined, att);
    setBusy(false);
    if (r.ok) setMsgs(r.messages); else { setErr(r.error); setText(t); setAttach(att); void load(); }
  };

  /** Inputs for a proposal: the pictures attached to the message it answers, else the canvas selection. */
  const inputsFor = (i: number): string[] => { const prev = msgs[i - 1]; const own = prev?.role === 'user' ? prev.images ?? [] : []; return (own.length ? own : selectedAssets).filter((id) => assets.get(id)?.kind === 'image' || assets.get(id)?.kind === 'video'); };
  const draftFor = (pr: Proposal, i: number): { p: Manifest; d: Draft } | null => {
    const ins = inputsFor(i);
    const p = profileFor(pr.kind, profiles, ins.length > 0); if (!p) return null;
    const values: Record<string, unknown> = { prompt: pr.prompt };
    if (pr.seconds && p.slots.some((s) => s.role === 'duration')) values.seconds = pr.seconds; else if (p.kind === 'video' && p.slots.some((s) => s.role === 'duration')) values.seconds = film.seconds;
    return { p, d: { profileId: p.id, values, inputs: autoAssign(p, ins), title: pr.kind === 'edit' ? 'Edit' : 'Generate' } };
  };
  /** Message → Generate form: the LLM keeps only the part a generator should get (no intro, no headings). */
  const toForm = async (m: ChatMsg, kind: 'image' | 'video') => {
    const p = profileFor(kind, profiles, false); if (!p) return notify('No suitable model profile is installed.');
    setCleaning(true); activity('distil', 'Cleaning up the prompt…');
    const r = await api.llmDistil(m.content, kind).finally(() => { setCleaning(false); activity('distil', null); });
    openDraft({ profileId: p.id, values: { prompt: r.ok ? r.prompt : promptOf(m) }, inputs: {}, title: kind === 'image' ? 'Generate image' : 'Generate video' });
    if (!r.ok) notify(`Could not clean the prompt with the LLM (${r.error}); the text was cleaned roughly.`);
  };
  const generate = async (pr: Proposal, i: number) => {
    const x = draftFor(pr, i); if (!x) return notify('No suitable model profile is installed for that.');
    const si = sizeInfo(x.p);
    const first = Object.values(x.d.inputs).flat()[0]; const src = first ? assets.get(first) : undefined;
    let values = valuesOfDraft(x.p, x.d); if (si.ok) values = withSize(values, resolveSize(size, film, src, si.step));
    const r = await api.generate(x.p.id, values);
    notify(r.ok ? `Queued with ${x.p.title}. The result lands on the canvas.` : r.error);
  };

  return (
    <div className="chat">
      <h2>Assistant</h2>
      <div className="note">Knows your story bible and scenes. Ask it to make a picture or video and it offers the prompt with a Generate button. Attach pictures to brainstorm about them or edit them.</div>
      <div className="chatLog">
        {!msgs.length && <div className="note" style={{ marginTop: 12 }}>Ask for ideas, a shot list, a rewrite, a character look… or “make a picture of …”. Pick “Script from idea” to get a Fountain script you can paste in the Director tab.</div>}
        {msgs.map((m, i) => (
          <div key={i} className={'msg ' + m.role}>
            <div className="who">{m.role === 'user' ? 'You' : 'Assistant'}{m.action ? ` · ${ACTIONS.find((a) => a.id === m.action)?.label ?? m.action}` : ''}</div>
            {m.images?.length ? <div className="refstrip">{m.images.map((id) => <div className="ref" key={id}><img src={thumbUrl(id)} /></div>)}</div> : null}
            <div className="body">{m.content}</div>
            {m.proposal && (() => {
              const x = draftFor(m.proposal, i); const si = x ? sizeInfo(x.p) : null;
              const ins = inputsFor(i);
              return (
                <div className="card proposal">
                  <b>{m.proposal.kind === 'video' ? '🎬 Video' : m.proposal.kind === 'edit' ? '✏ Edit' : '🖼 Image'}</b>{x && <span className="note"> · {x.p.title}</span>}
                  <div className="propText">{m.proposal.prompt}</div>
                  {ins.length > 0 && <div className="refstrip">{ins.map((id) => <div className="ref" key={id}><img src={thumbUrl(id)} /><PrepInput id={id} selected={selectedAssets} openDraft={openDraft} onReplace={(n) => setMsgs((m) => m.map((x, k) => (k === i - 1 && x.images ? { ...x, images: x.images.map((y) => (y === id ? n : y)) } : x)))} /></div>)}</div>}
                  {x ? <>
                    {si?.ok && <SizeChooser value={size} onChange={setSize} src={ins.length ? assets.get(ins[0]!) : undefined} step={si.step} />}
                    <div className="row" style={{ marginTop: 6 }}>
                      <button className="primary-sm" onClick={() => void generate(m.proposal!, i)}>Generate</button>
                      <button title="Open it in the Generate tab to change settings first" onClick={() => openDraft(x.d)}>Open in Generate</button>
                    </div>
                  </> : <div className="warn">No matching model profile is installed.</div>}
                </div>
              );
            })()}
            {m.role === 'assistant' && (
              <div className="row" style={{ marginTop: 4, flexWrap: 'wrap' }}>
                <button className="ghost" onClick={() => { void navigator.clipboard.writeText(m.content); notify('Copied'); }}>Copy</button>
                <button className="ghost" title="Put it on the canvas as a note" onClick={() => { void api.chatToNote(m.content); notify('Note added to the canvas'); }}>→ Note</button>
                {!m.proposal && <>
                  <button className="ghost" title="Use the prompt part of this message for a new picture" disabled={cleaning} onClick={() => void toForm(m, 'image')}>{cleaning ? 'Cleaning…' : '→ Image'}</button>
                  <button className="ghost" title="Use the prompt part of this message for a new video" disabled={cleaning} onClick={() => void toForm(m, 'video')}>{cleaning ? 'Cleaning…' : '→ Video'}</button>
                </>}
              </div>
            )}
          </div>
        ))}
        {busy && <div className="note">Thinking…</div>}
        {cleaning && <div className="card working"><div className="row"><span className="spin" /><b>Cleaning up the prompt…</b></div><div className="bar indet"><div /></div><div className="note">The LLM keeps only the part a generator needs; the form opens when it is done.</div></div>}
        <div ref={end} />
      </div>
      {err && <div className="err">{err}</div>}
      {attach.length > 0 && <div className="refstrip">{attach.map((id) => <div className="ref" key={id}><img src={thumbUrl(id)} /><button title="Remove" onClick={() => setAttach(attach.filter((x) => x !== id))}>×</button><PrepInput id={id} selected={selectedAssets} openDraft={openDraft} onReplace={(n) => setAttach(attach.map((x) => (x === id ? n : x)))} /></div>)}</div>}
      <div className="row" style={{ margin: '6px 0', flexWrap: 'wrap' }}>
        {ACTIONS.map((a) => <button key={a.id} title={a.hint} className={action === a.id ? 'primary-sm' : ''} onClick={() => setAction(a.id)}>{a.label}</button>)}
        <button disabled={!selectedAssets.length} title="Attach the pictures selected on the canvas to your next message" onClick={() => setAttach([...new Set([...attach, ...selectedAssets])].slice(0, 6))}>📎 selected{selectedAssets.length ? ` (${selectedAssets.length})` : ''}</button>
        <span className="sp" /><button className="ghost" disabled={!msgs.length || busy} onClick={async () => { await api.chatClear(); setMsgs([]); }}>Clear</button>
      </div>
      <textarea value={text} placeholder="Message… (Ctrl+Enter to send)" style={{ minHeight: 70 }} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }} />
      <button className="primary" disabled={busy || !text.trim()} onClick={send}>Send</button>
    </div>
  );
}
