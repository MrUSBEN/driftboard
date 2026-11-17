import { useEffect, useState } from 'react';

export interface AskButton { id: string; label: string; kind?: 'primary' | 'danger' | 'plain' }
interface AskReq { title: string; message?: string; lines?: string[]; buttons: AskButton[]; resolve: (id: string | null) => void }

/** Ask the user to choose (several buttons, optional list of lines). Resolves with the button id, or null when dismissed. */
export const askUser = (o: Omit<AskReq, 'resolve'>): Promise<string | null> => new Promise((resolve) => window.dispatchEvent(new CustomEvent('driftboard-ask', { detail: { ...o, resolve } })));
/** Yes/no with a clear name for the action. */
export const confirmUser = async (title: string, message: string, ok = 'Yes', danger = false) => (await askUser({ title, message, buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: ok, kind: danger ? 'danger' : 'primary' }] })) === 'ok';

/** Mounted once in the app: shows the question dialogs asked through askUser. */
export function AskHost() {
  const [q, setQ] = useState<AskReq[]>([]);
  useEffect(() => { const f = (e: Event) => setQ((x) => [...x, (e as CustomEvent<AskReq>).detail]); window.addEventListener('driftboard-ask', f); return () => window.removeEventListener('driftboard-ask', f); }, []);
  const cur = q[0];
  const done = (id: string | null) => { cur?.resolve(id); setQ((x) => x.slice(1)); };
  useEffect(() => { if (!cur) return; const k = (e: KeyboardEvent) => { if (e.key === 'Escape') done(null); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); });
  if (!cur) return null;
  return (
    <div className="modalBack" style={{ zIndex: 200 }} onMouseDown={(e) => { if (e.target === e.currentTarget) done(null); }}>
      <div className="modal" style={{ maxWidth: 560 }}>
        <h3>{cur.title}</h3>
        {cur.message && <div className="note" style={{ margin: '0 0 8px', whiteSpace: 'pre-wrap', color: 'var(--text)' }}>{cur.message}</div>}
        {cur.lines?.length ? <div className="askLines">{cur.lines.map((l, i) => <div key={i} className="note">• {l}</div>)}</div> : null}
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12, flexWrap: 'wrap' }}>
          {cur.buttons.map((b) => <button key={b.id} className={b.kind === 'primary' ? 'primary-sm' : b.kind === 'danger' ? 'danger-sm' : ''} onClick={() => done(b.id)}>{b.label}</button>)}
        </div>
      </div>
    </div>
  );
}
