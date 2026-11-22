import { AddSource } from './AddSource.tsx';
import { PrepInput } from './PrepInput.tsx';
import { confirmUser } from './Ask.tsx';
import { Button, Chip, Empty, Notice, Progress, Seg, Spinner, Tile } from './ui/ui.tsx';
import { PromptText } from './Inspector.tsx';
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

  const KIND: Record<Proposal['kind'], { icon: 'video' | 'image' | 'wand'; label: string }> = { video: { icon: 'video', label: 'Video' }, image: { icon: 'image', label: 'Picture' }, edit: { icon: 'wand', label: 'Edit' } };
  return (
    <div className="chatP">
      <div className="ph"><h2>Assistant</h2><span className="sp" /><Button size="sm" kind="quiet" disabled={!msgs.length || busy} onClick={async () => { if (await confirmUser('Clear the conversation?', 'Every message here is removed. Pictures and notes made from it stay.', 'Clear', true)) { await api.chatClear(); setMsgs([]); } }}>Clear</Button></div>
      <div className="pb chatLog" data-area="assistant">
        <span className="small dim">Knows your story bible and scenes. Ask it to make a picture or a video and it offers the prompt with a Generate button. Attach pictures to talk about them or edit them.</span>
        {!msgs.length && <Empty icon="assistant" title="Ask for anything">Ideas, a shot list, a rewrite, a character look… or “make a picture of …”. Pick “Script from idea” to get a script you can paste in Story › Script.</Empty>}
        {msgs.map((m, i) => (
          <div key={i} className={'msg' + (m.role === 'user' ? ' me' : '')}>
            <span className="xs faint">{m.role === 'user' ? 'You' : 'Assistant'}{m.action ? ` · ${ACTIONS.find((x) => x.id === m.action)?.label ?? m.action}` : ''}</span>
            {m.images?.length ? <div className="row wrap">{m.images.map((id) => <Tile key={id} src={thumbUrl(id)} />)}</div> : null}
            <div className="bubble">{m.content}</div>
            {m.proposal && (() => {
              const x = draftFor(m.proposal, i); const si = x ? sizeInfo(x.p) : null;
              const ins = inputsFor(i); const k = KIND[m.proposal.kind];
              return (
                <div className="dcard proposal">
                  <div className="row"><Chip on icon={k.icon}>{k.label}</Chip>{x && <span className="xs dim">{x.p.title}</span>}</div>
                  <div className="prompt full"><PromptText text={m.proposal.prompt} /></div>
                  {ins.length > 0 && <div className="row wrap">{ins.map((id) => <Tile key={id} src={thumbUrl(id)}><PrepInput id={id} selected={selectedAssets} openDraft={openDraft} onReplace={(n) => setMsgs((mm) => mm.map((y, kk) => (kk === i - 1 && y.images ? { ...y, images: y.images.map((z) => (z === id ? n : z)) } : y)))} /></Tile>)}</div>}
                  {x ? <>
                    {si?.ok && <SizeChooser value={size} onChange={setSize} src={ins.length ? assets.get(ins[0]!) : undefined} step={si.step} />}
                    <div className="row">
                      <Button kind="primary" icon="create" onClick={() => void generate(m.proposal!, i)}>Generate</Button>
                      <Button title="Open it in Create to change settings first" onClick={() => openDraft(x.d)}>Open in Create</Button>
                    </div>
                  </> : <Notice tone="warn">No matching model is turned on. Turn one on in Settings › ComfyUI.</Notice>}
                </div>
              );
            })()}
            {m.role === 'assistant' && (
              <div className="acts">
                <Button size="sm" kind="quiet" icon="copy" onClick={() => { void navigator.clipboard.writeText(m.content); notify('Copied'); }}>Copy</Button>
                <Button size="sm" kind="quiet" icon="note" title="Put it on the canvas as a note" onClick={() => { void api.chatToNote(m.content); notify('Note added to the canvas'); }}>To note</Button>
                {!m.proposal && <>
                  <Button size="sm" kind="quiet" icon="image" title="Use the prompt part of this message for a new picture" disabled={cleaning} onClick={() => void toForm(m, 'image')}>To picture</Button>
                  <Button size="sm" kind="quiet" icon="video" title="Use the prompt part of this message for a new video" disabled={cleaning} onClick={() => void toForm(m, 'video')}>To video</Button>
                </>}
              </div>
            )}
          </div>
        ))}
        {busy && <div className="row"><Spinner /><span className="small dim">Thinking…</span></div>}
        {cleaning && <div className="working"><div className="row"><Spinner /><b className="small">Cleaning up the prompt…</b></div><Progress label="Cleaning up the prompt" /><span className="xs dim">The LLM keeps only the part a generator needs; Create opens when it is done.</span></div>}
        <div ref={end} />
      </div>
      <div className="pf">
        {err && <Notice tone="bad"><span>{err}</span><span>Check that the LLM server is running (top bar), then send again.</span></Notice>}
        <Seg label="Mode" value={action} onChange={setAction} options={ACTIONS.map((x) => ({ value: x.id, label: x.label, title: x.hint }))} />
        {attach.length > 0 && <div className="row wrap">{attach.map((id) => <Tile key={id} src={thumbUrl(id)} onRemove={() => setAttach(attach.filter((x) => x !== id))} removeLabel="Remove this attachment"><PrepInput id={id} selected={selectedAssets} openDraft={openDraft} onReplace={(n) => setAttach(attach.map((x) => (x === id ? n : x)))} /></Tile>)}</div>}
        <textarea className="ta" aria-label="Message" value={text} placeholder="Message… (Ctrl+Enter sends)" style={{ minHeight: 70 }} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }} />
        <div className="row">
          <AddSource kinds={['image']} max={6} selected={selectedAssets} exclude={attach} className="btn sm" label="Attach pictures" what="Attach pictures to your next message." title="Attach pictures to your next message: from the canvas, the Library or your computer" onPick={(p) => setAttach([...new Set([...attach, ...p])].slice(0, 6))} />
          <span className="sp" />
          <Button kind="primary" icon="send" disabled={busy || !text.trim()} onClick={() => void send()}>Send</Button>
        </div>
      </div>
    </div>
  );
}
