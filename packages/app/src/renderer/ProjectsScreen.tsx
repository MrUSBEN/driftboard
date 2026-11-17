import { useCallback, useContext, useEffect, useState } from 'react';
import { C, api } from './shared.tsx';
import { useView } from './View.tsx';
import { confirmUser } from './Ask.tsx';
import { ParamDialog } from './CanvasMenu.tsx';
import { Icon } from './ui/Icon.tsx';
import { Button, IconButton, Menu, Seg, Sheet, Empty, type MenuItem } from './ui/ui.tsx';
import { Wordmark } from './ui/Wordmark.tsx';
import type { ComfyState } from './Shell.tsx';
import type { LlmStatus } from '../main/api.ts';

type Row = Awaited<ReturnType<typeof api.projectList>>[number];
interface Props { onClose: () => void; onSwitch: (dir: string) => Promise<void>; onNew: () => void; onOpenFolder: () => void; notify: (m: string) => void; hasProject: boolean; comfy?: ComfyState }

/** Every project the app knows: switch, rename, relink a moved folder, forget, or delete (to the Recycle Bin). A sheet over the app, or the first-start screen when no project is open. */
export function ProjectsScreen(props: Props) {
  const { hasProject, onClose } = props;
  if (!hasProject) return <Welcome {...props} />;
  return <Sheet title="Projects" onClose={onClose}><ProjectsBody {...props} /></Sheet>;
}

function Welcome(props: Props) {
  const [llm, setLlm] = useState<LlmStatus | null>(null);
  useEffect(() => { void api.llmStatus().then(setLlm).catch(() => {}); }, []);
  const c = props.comfy;
  return (
    <div className="welcome" role="main">
      <div className="wbox">
        <Wordmark height={30} />
        <ProjectsBody {...props} first />
        <div className="row" style={{ marginTop: 6, flexWrap: 'wrap', gap: 14 }}>
          <span className="row"><span className={'dot' + (c?.ok ? ' ok' : '')} /><span className="small">{c ? (c.ok ? `ComfyUI found at ${c.url.replace(/^https?:\/\//, '')}` : `ComfyUI not found at ${c.url.replace(/^https?:\/\//, '')}: start it, or change the address in Settings later`) : 'Looking for ComfyUI…'}</span></span>
          <span className="row"><span className={'dot' + (llm?.ok ? ' ok' : '')} /><span className="small">{llm ? (llm.ok ? `LLM server found at ${llm.url.replace(/^https?:\/\//, '')}` : 'No LLM server found yet (optional: for writing stories and prompts)') : 'Looking for an LLM server…'}</span></span>
        </div>
      </div>
    </div>
  );
}

function ProjectsBody({ onClose, onSwitch, onNew, onOpenFolder, notify, first }: Props & { first?: boolean }) {
  const { jobs } = useContext(C);
  const [rows, setRows] = useState<Row[]>([]);
  const [view, setView] = useView('projects', { mode: 'grid' });
  const [renaming, setRenaming] = useState<string | null>(null);
  const [del, setDel] = useState<Row | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; r: Row } | null>(null);
  const load = useCallback(async () => setRows(await api.projectList()), []);
  useEffect(() => { void load(); }, [load]);
  const busyJobs = jobs.filter((j) => j.status === 'running' || j.status === 'queued').length;

  const open = async (r: Row) => {
    if (r.current) return onClose();
    if (busyJobs && !(await confirmUser('Generations are still running', `${busyJobs} job${busyJobs === 1 ? ' is' : 's are'} running or queued in the open project. Switching stops watching them; unfinished ones are marked interrupted and can be run again from Activity › Jobs when you come back. The current project is saved first.`, 'Switch anyway', true))) return;
    await onSwitch(r.dir); onClose();
  };
  const relink = async (r: Row) => { const x = await api.projectRelink(r.dir); if (x.ok) { notify('Project relinked'); void load(); } else if (x.error !== 'Cancelled') notify(`Could not relink: ${x.error ?? 'unknown error'}. Choose the folder that holds the project file (project.driftboard.json).`); };
  const forget = async (r: Row) => { if (await confirmUser(`Remove “${r.name}” from the list?`, 'Only the list entry goes. The project folder and its files are not touched, and you can open the folder again later.', 'Remove from list')) { await api.projectForget(r.dir); void load(); } };
  const menuItems = (r: Row): MenuItem[] => [
    { label: 'Rename', icon: 'pencil', disabled: r.missing, onClick: () => setRenaming(r.dir) },
    ...(r.missing ? [{ label: 'Relink…', icon: 'folder' as const, onClick: () => void relink(r) }] : []),
    { label: 'Remove from list', icon: 'x', sub: 'The folder and files stay', onClick: () => void forget(r) },
    { sep: true },
    { label: 'Delete…', icon: 'trash', danger: true, disabled: r.current, title: r.current ? 'Switch to another project first' : undefined, onClick: () => setDel(r) },
  ];
  const nameEl = (r: Row) => renaming === r.dir
    ? <input className="inp" autoFocus aria-label="Project name" defaultValue={r.name} onBlur={async (e) => { if (e.target.value.trim() && e.target.value !== r.name) { await api.projectRename(r.dir, e.target.value); void load(); } setRenaming(null); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); else if (e.key === 'Escape') setRenaming(null); }} />
    : <b className="h3" title="Double-click to rename" onDoubleClick={() => !r.missing && setRenaming(r.dir)} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</b>;
  const actions = (r: Row) => <>
    {r.missing ? <Button size="sm" kind="primary" onClick={() => void relink(r)}>Relink…</Button> : <Button size="sm" kind="primary" onClick={() => void open(r)}>{r.current ? 'Continue' : 'Open'}</Button>}
    {!r.missing && <Button size="sm" kind="quiet" onClick={() => setRenaming(r.dir)}>Rename</Button>}
    <span className="sp" />
    <IconButton size="sm" icon="more" label={`More for ${r.name}`} onClick={(e) => { const b = e.currentTarget.getBoundingClientRect(); setMenu({ x: b.right - 240, y: b.bottom + 4, r }); }} />
  </>;
  const when = (r: Row) => (r.missing ? 'Folder not found: moved, renamed, or on a drive that is not connected.' : `Last opened ${new Date(r.opened).toLocaleString()}`);

  return (
    <>
      <div className="row"><h2 style={{ flex: 1, margin: 0 }}>{first ? 'Welcome to Driftboard' : 'Projects'}</h2>
        <Seg label="View" value={view.mode} onChange={(m) => setView({ ...view, mode: m })} options={[{ value: 'grid', label: 'Cards', icon: 'grid' }, { value: 'list', label: 'List', icon: 'list' }]} /></div>
      {first && <span className="small dim">A project is a folder that holds your pictures, clips, stories and timeline. Everything is saved as you go.</span>}
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <Button kind="primary" icon="plus" onClick={onNew}>New project…</Button>
        <Button icon="folder" onClick={onOpenFolder}>Open a project folder…</Button>
        <span className="sp" /><span className="xs faint">Switching saves a backup and closes the project cleanly.</span>
      </div>
      {view.mode === 'grid'
        ? <div className="projGrid">{rows.map((r) => (
          <div key={r.dir} className={'projCard' + (r.current ? ' current' : '') + (r.missing ? ' missing' : '')}>
            <div className="th"><Icon name="film" size={30} />{r.current && <span className="imgBadge ok"><Icon name="check" size="s" />Open now</span>}{r.missing && <span className="imgBadge bad"><Icon name="warn" size="s" />Folder not found</span>}</div>
            <div className="bd">{nameEl(r)}<span className="mono xs faint" title={r.dir} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.dir}</span><span className="xs dim">{when(r)}</span>
              <div className="row" style={{ marginTop: 4 }}>{actions(r)}</div></div>
          </div>))}</div>
        : <div className="col" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{rows.map((r) => (
          <div key={r.dir} className={'dcard row projRow' + (r.missing ? ' missing' : '')}>
            <Icon name={r.missing ? 'warn' : r.current ? 'check' : 'folder'} style={{ color: r.missing ? 'var(--bad)' : r.current ? 'var(--ok)' : 'var(--dim)' }} />
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>{nameEl(r)}<span className="mono xs faint" title={r.dir} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.dir} · {when(r)}</span></div>
            {actions(r)}
          </div>))}</div>}
      {!rows.length && <Empty icon="folder" title="No projects yet">Create one, or open an existing project folder.</Empty>}
      {menu && <Menu x={menu.x} y={menu.y} items={menuItems(menu.r)} onClose={() => setMenu(null)} />}
      {del && <ParamDialog title={`Delete “${del.name}” from disk?`} danger okLabel="Move to Recycle Bin"
        message={`This moves the whole folder to the Recycle Bin:\n${del.dir}\nIt holds this project's pictures, videos and database. You can restore it from the Recycle Bin.\n\nType the project name to confirm.`}
        fields={[{ key: 'name', label: 'Project name', type: 'text', value: '', placeholder: del.name }]}
        onCancel={() => setDel(null)}
        onOk={async (v) => { if (v.name.trim() !== del.name) return notify('The name did not match, nothing was deleted.'); const r = await api.projectDelete(del.dir); setDel(null); notify(r.ok ? `Moved “${del.name}” to the Recycle Bin` : `Could not delete: ${r.error ?? 'unknown error'}. Close any program that uses files in that folder and try again.`); void load(); }} />}
    </>
  );
}
