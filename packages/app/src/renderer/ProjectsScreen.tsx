import { useCallback, useContext, useEffect, useState } from 'react';
import { C, api } from './shared.tsx';
import { Cards, ViewBar, ViewCtx, useView } from './View.tsx';
import { confirmUser } from './Ask.tsx';
import { ParamDialog } from './CanvasMenu.tsx';

type Row = Awaited<ReturnType<typeof api.projectList>>[number];

/** Every project the app knows: switch, rename, relink a moved folder, forget, or delete (to the Recycle Bin). */
export function ProjectsScreen({ onClose, onSwitch, onNew, onOpenFolder, notify, hasProject }: { onClose: () => void; onSwitch: (dir: string) => Promise<void>; onNew: () => void; onOpenFolder: () => void; notify: (m: string) => void; hasProject: boolean }) {
  const { jobs } = useContext(C);
  const [rows, setRows] = useState<Row[]>([]);
  const [view, setView] = useView('projects', { mode: 'grid' });
  const [renaming, setRenaming] = useState<string | null>(null);
  const [del, setDel] = useState<Row | null>(null);
  const load = useCallback(async () => setRows(await api.projectList()), []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (!hasProject) return; const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !del) onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose, del, hasProject]);
  const busyJobs = jobs.filter((j) => j.status === 'running' || j.status === 'queued').length;

  const open = async (r: Row) => {
    if (r.current) return onClose();
    if (busyJobs && !(await confirmUser('Generations are still running', `${busyJobs} job${busyJobs === 1 ? ' is' : 's are'} running or queued in the open project. Switching stops watching them; unfinished ones are marked interrupted and can be run again from the Queue when you come back. The current project is saved first.`, 'Switch anyway', true))) return;
    await onSwitch(r.dir); onClose();
  };
  const relink = async (r: Row) => { const x = await api.projectRelink(r.dir); if (x.ok) { notify('Project relinked'); void load(); } else if (x.error !== 'Cancelled') notify(x.error ?? 'Could not relink'); };
  const forget = async (r: Row) => { if (await confirmUser(`Remove “${r.name}” from the list?`, 'Only the list entry goes. The project folder and its files are not touched, and you can open the folder again later.', 'Remove from list')) { await api.projectForget(r.dir); void load(); } };

  return (
    <div className="modalBack" style={{ zIndex: 150 }} onMouseDown={(e) => { if (e.target === e.currentTarget && hasProject) onClose(); }}>
      <div className="modal" style={{ width: 'min(900px, 94vw)', maxHeight: '86vh', overflow: 'auto' }}>
        <div className="row"><h3 style={{ flex: 1, margin: 0 }}>Projects</h3><ViewBar value={view} onChange={setView} />{hasProject && <button onClick={onClose}>Close</button>}</div>
        <div className="row" style={{ margin: '8px 0' }}>
          <button className="primary-sm" onClick={onNew}>New project…</button>
          <button onClick={onOpenFolder}>Open a project folder…</button>
          <span className="note">Everything you do is saved as you go. Switching saves a backup and closes the project cleanly.</span>
        </div>
        <ViewCtx.Provider value={view}>
          <Cards>
            {rows.map((r) => (
              <div className={'card vcard projCard' + (r.current ? ' current' : '') + (r.missing ? ' missing' : '')} key={r.dir}>
                <div className="row">
                  {renaming === r.dir
                    ? <input autoFocus defaultValue={r.name} onBlur={async (e) => { if (e.target.value.trim() && e.target.value !== r.name) { await api.projectRename(r.dir, e.target.value); void load(); } setRenaming(null); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); else if (e.key === 'Escape') setRenaming(null); }} />
                    : <b style={{ flex: 1 }} title="Double-click to rename" onDoubleClick={() => !r.missing && setRenaming(r.dir)}>{r.name}</b>}
                  {r.current && <span className="pill ok">open</span>}
                  {r.missing && <span className="pill bad">missing</span>}
                </div>
                <div className="note vdetail" title={r.dir} style={{ wordBreak: 'break-all' }}>{r.dir}</div>
                <div className="note vdetail">{r.missing ? 'The folder was not found: moved, renamed or on a drive that is not connected.' : `last opened ${new Date(r.opened).toLocaleString()}`}</div>
                <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                  {r.missing ? <button className="primary-sm" onClick={() => void relink(r)}>Relink…</button> : <button className="primary-sm" onClick={() => void open(r)}>{r.current ? 'Continue' : 'Open'}</button>}
                  {!r.missing && <button className="ghost" onClick={() => setRenaming(r.dir)}>Rename</button>}
                  <button className="ghost" title="Take it off this list (files stay)" onClick={() => void forget(r)}>Remove from list</button>
                  {!r.current && <button className="ghost danger" onClick={() => setDel(r)}>Delete…</button>}
                </div>
              </div>
            ))}
          </Cards>
        </ViewCtx.Provider>
        {!rows.length && <div className="empty">No projects yet. Create one, or open an existing project folder.</div>}
      </div>
      {del && <ParamDialog title={`Delete “${del.name}” from disk?`} danger okLabel="Move to Recycle Bin"
        message={`This moves the whole folder to the Recycle Bin:\n${del.dir}\nIt holds this project's pictures, videos and database. You can restore it from the Recycle Bin.\n\nType the project name to confirm.`}
        fields={[{ key: 'name', label: 'Project name', type: 'text', value: '', placeholder: del.name }]}
        onCancel={() => setDel(null)}
        onOk={async (v) => { if (v.name.trim() !== del.name) return notify('The name did not match, nothing was deleted.'); const r = await api.projectDelete(del.dir); setDel(null); notify(r.ok ? `Moved “${del.name}” to the Recycle Bin` : r.error ?? 'Could not delete'); void load(); }} />}
    </div>
  );
}
