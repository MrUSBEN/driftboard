import { useEffect, useRef, useState } from 'react';
import { Button, Dialog, Field } from './ui/ui.tsx';

export interface AskButton { id: string; label: string; kind?: 'primary' | 'danger' | 'plain' }
interface AskReq { title: string; message?: string; lines?: string[]; buttons: AskButton[]; input?: { label: string; value?: string; placeholder?: string }; resolve: (id: string | null, text?: string) => void }

/** Ask the user to choose (several buttons, optional list of lines). Resolves with the button id, or null when dismissed. */
export const askUser = (o: Omit<AskReq, 'resolve'>): Promise<string | null> => new Promise((resolve) => window.dispatchEvent(new CustomEvent('driftboard-ask', { detail: { ...o, resolve } })));
/** Yes/no with a clear name for the action. */
export const confirmUser = async (title: string, message: string, ok = 'Yes', danger = false) => (await askUser({ title, message, buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: ok, kind: danger ? 'danger' : 'primary' }] })) === 'ok';
/** Tell the user something went wrong (what, and how to fix it) and wait until they close it. Replaces window.alert. */
export const tellUser = async (title: string, message: string) => { await askUser({ title, message, buttons: [{ id: 'ok', label: 'OK', kind: 'primary' }] }); };

/** Ask for a short text (a name). Resolves with the text, or null when cancelled or left empty. Replaces window.prompt. */
export const askText = (title: string, label: string, o: { value?: string; placeholder?: string; ok?: string; message?: string } = {}): Promise<string | null> =>
  new Promise((resolve) => window.dispatchEvent(new CustomEvent('driftboard-ask', { detail: { title, message: o.message, input: { label, value: o.value, placeholder: o.placeholder }, buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: o.ok ?? 'OK', kind: 'primary' }], resolve: (id: string | null, text?: string) => resolve(id === 'ok' && text?.trim() ? text.trim() : null) } satisfies AskReq })));

/** Mounted once in the app: shows the question dialogs asked through askUser. */
export function AskHost() {
  const [q, setQ] = useState<AskReq[]>([]);
  useEffect(() => { const f = (e: Event) => setQ((x) => [...x, (e as CustomEvent<AskReq>).detail]); window.addEventListener('driftboard-ask', f); return () => window.removeEventListener('driftboard-ask', f); }, []);
  const cur = q[0];
  const text = useRef('');
  useEffect(() => { text.current = cur?.input?.value ?? ''; }, [cur]);
  const done = (id: string | null) => { cur?.resolve(id, text.current); setQ((x) => x.slice(1)); };
  if (!cur) return null;
  return (
    <Dialog key={q.length + cur.title} title={cur.title} width={560} onClose={() => done(null)}
      footer={cur.buttons.map((b) => <Button key={b.id} kind={b.kind === 'primary' ? 'primary' : b.kind === 'danger' ? 'danger-solid' : 'secondary'} onClick={() => done(b.id)}>{b.label}</Button>)}>
      {cur.message && <div className="msgT">{cur.message}</div>}
      {cur.lines?.length ? <div className="lines">{cur.lines.map((l, i) => <div key={i}>• {l}</div>)}</div> : null}
      {cur.input && <form onSubmit={(e) => { e.preventDefault(); done('ok'); }}><Field label={cur.input.label}><input className="inp" autoFocus defaultValue={cur.input.value} placeholder={cur.input.placeholder} onChange={(e) => { text.current = e.target.value; }} /></Field></form>}
    </Dialog>
  );
}
