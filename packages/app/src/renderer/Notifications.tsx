export interface Note { id: number; ts: number; msg: string; level: 'info' | 'warn' | 'error' }

/** Bell in the header with a history of everything that was shown as a toast, plus warnings and errors from the log. */
export function NotesPanel({ notes, onClear, onClose, openLog }: { notes: Note[]; onClear: () => void; onClose: () => void; openLog: () => void }) {
  return (
    <div className="card notesPanel" onMouseLeave={onClose}>
      <div className="row"><b style={{ flex: 1 }}>Notifications</b><button className="ghost" onClick={openLog}>Open log</button><button className="ghost" onClick={onClear} disabled={!notes.length}>Clear</button></div>
      <div className="notesList">
        {!notes.length && <div className="note">Nothing yet. Messages that pop up at the bottom are kept here.</div>}
        {[...notes].reverse().map((n) => (
          <div key={n.id} className={'noteRow ' + n.level}><span className="t">{new Date(n.ts).toLocaleTimeString([], { hour12: false })}</span><span className="m">{n.msg}</span></div>
        ))}
      </div>
    </div>
  );
}
