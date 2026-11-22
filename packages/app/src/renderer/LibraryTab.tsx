import { hit } from './keys.ts';
import { takeLibraryView } from './goto.ts';
import { assetName } from './Canvas.tsx';
import { sendToStory } from './sendToStory.ts';
import { showToast, Button, Dialog, Empty, Field as FieldBox, IconButton, Notice, Seg, Tile } from './ui/ui.tsx';
import { Icon } from './ui/Icon.tsx';
import { ViewBar, useView } from './View.tsx';
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { C, api, matches, thumbUrl } from './shared.tsx';
import { ContextMenu, ParamDialog, type Field, type MenuItem } from './CanvasMenu.tsx';

type Dlg = { title: string; fields: Field[]; ok: (v: Record<string, string>) => void; message?: string; okLabel?: string; danger?: boolean };

export function LibraryTab({ focusAssetId, focus, notify }: { focusAssetId: string | null; focus: (id: string) => void; notify: (m: string) => void }) {
  const { story, assets, jobs, usage, takeOf, board } = useContext(C);
  const [look, setLook] = useView('library');
  const [q, setQ] = useState('');
  const [view, setView] = useState<'all' | 'image' | 'video' | 'audio' | 'trash'>(() => takeLibraryView() ?? 'all');   // one set of tabs: Trash is a view like the others
  useEffect(() => { const f = () => { const v = takeLibraryView(); if (v) setView(v); }; window.addEventListener('driftboard-library-view', f); return () => window.removeEventListener('driftboard-library-view', f); }, []);
  const trashView = view === 'trash';
  const type = view === 'trash' ? 'all' : view;
  const [tag, setTag] = useState('');
  const [folder, setFolder] = useState('');   // the open folder ('' = the top level)
  const [fmenu, setFmenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [sel, setSel] = useState<string[]>([]);
  const anchor = useRef<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const [bulk, setBulk] = useState<string[] | null>(null);
  const [del, setDel] = useState<string[] | null>(null);

  const prompt = useMemo(() => { const m = new Map<string, string>(); for (const j of jobs) for (const o of j.outputs) { const p = JSON.parse(j.params).prompt; if (typeof p === 'string') m.set(o.assetId, p); } return m; }, [jobs]);
  const shotOf = useMemo(() => { const m = new Map<string, string>(); for (const { scene, shots } of story.all) for (const s of shots) for (const t of s.takes) m.set(t.assetId, `${scene.name} / ${s.name}`); return m; }, [story]);
  const onCanvas = useMemo(() => new Set(board.items.filter((i) => i.kind === 'asset' && i.ref).map((i) => i.ref!)), [board.items]);

  const trashedCount = [...assets.values()].filter((a) => story.meta[a.id]?.trashed).length;
  const found = (a: { id: string; original_name: string | null }) => (!tag || story.meta[a.id]?.tags?.includes(tag))
    && matches(q, story.meta[a.id]?.name, story.meta[a.id]?.tags?.join(' '), story.meta[a.id]?.note, prompt.get(a.id), shotOf.get(a.id), a.original_name ?? undefined, a.id.slice(0, 8));
  const pool = [...assets.values()].filter((a) => a.kind !== 'other' && found(a));
  const live = pool.filter((a) => !story.meta[a.id]?.trashed);
  const counts = { all: live.length, image: live.filter((a) => a.kind === 'image').length, video: live.filter((a) => a.kind === 'video').length, audio: live.filter((a) => a.kind === 'audio').length, trash: pool.filter((a) => story.meta[a.id]?.trashed).length };
  // a search or tag looks in every folder; otherwise the open folder shows what is filed directly in it
  const searching = !!q.trim() || !!tag;
  const inFolder = (a: { id: string }) => trashView || searching || (story.meta[a.id]?.folder ?? '') === folder;
  const list = pool.filter((a) => !!story.meta[a.id]?.trashed === trashView && (type === 'all' || a.kind === type) && inFolder(a));
  const allFolders = story.folders ?? [];
  const parentOf = (f: string) => f.split('/').slice(0, -1).join('/');
  const subfolders = allFolders.filter((f) => parentOf(f) === folder);
  const inside = (f: string) => live.filter((a) => { const x = story.meta[a.id]?.folder ?? ''; return x === f || x.startsWith(f + '/'); }).length;
  useEffect(() => { if (folder && !allFolders.includes(folder)) setFolder(parentOf(folder)); }, [allFolders.join('|')]);   // eslint-disable-line react-hooks/exhaustive-deps
  const shown = list.slice(0, 200);
  const selSet = new Set(sel);
  // the same name the canvas shows (a take without a name is "<shot> (take)")
  const nameOf = (id: string) => { const a = assets.get(id); return a ? assetName(a, story.meta, takeOf.get(id)?.shot.name) : id.slice(0, 8); };

  useEffect(() => { setSel((s) => s.filter((id) => assets.has(id))); }, [assets]);
  useEffect(() => { setSel([]); anchor.current = null; }, [view]);

  const click = (e: React.MouseEvent, id: string) => {
    if (e.shiftKey && anchor.current) {
      const a = shown.findIndex((x) => x.id === anchor.current), b = shown.findIndex((x) => x.id === id);
      if (a >= 0 && b >= 0) { const [lo, hi] = a < b ? [a, b] : [b, a]; setSel(shown.slice(lo, hi + 1).map((x) => x.id)); return; }
    }
    if (e.ctrlKey || e.metaKey) { setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id])); anchor.current = id; return; }
    setSel([id]); anchor.current = id; if (!trashView) focus(id);
  };
  const ctx = (e: React.MouseEvent, id?: string) => {
    e.preventDefault(); e.stopPropagation();
    if (id && !selSet.has(id)) { setSel([id]); anchor.current = id; }
    setMenu({ x: e.clientX, y: e.clientY });
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement; if (['TEXTAREA', 'INPUT', 'SELECT'].includes(t.tagName) || !wrapRef.current?.contains(document.activeElement) && document.activeElement !== document.body) return;
      if (hit(e, 'library.selectAll') && wrapRef.current?.matches(':hover')) { e.preventDefault(); setSel(shown.map((x) => x.id)); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  });
  const wrapRef = useRef<HTMLDivElement>(null);

  /* ------------------------------------------------ actions */
  const usageText = (ids: string[]) => {
    const tl = ids.filter((id) => (usage.get(id) ?? 0) > 0).length, shots = ids.filter((id) => takeOf.has(id)).length, cv = ids.filter((id) => onCanvas.has(id)).length;
    const parts = [cv && `${cv} on the canvas`, tl && `${tl} on the timeline`, shots && `${shots} used as story takes`].filter(Boolean);
    return parts.length ? `${parts.join(', ')}.` : 'None of them is used anywhere.';
  };
  const askDelete = () => { if (sel.length) setDel([...sel]); };
  const doDelete = async (ids: string[]) => { setDel(null); await api.libraryTrash(ids, true); setSel([]); showToast(`Moved ${ids.length} item${ids.length === 1 ? '' : 's'} to the Trash`, { undo: () => void api.boardUndo(), ms: 12000 }); };
  const restore = async (ids: string[]) => { await api.libraryTrash(ids, false); setSel([]); notify(`Restored ${ids.length}`); };
  const askPurge = (ids: string[]) => setDlg({
    title: `Delete ${ids.length} ${ids.length === 1 ? 'file' : 'files'} forever?`, okLabel: 'Delete forever', danger: true, fields: [],
    message: 'This removes the files from the disk and cannot be undone. Files that are part of the generation history (anything made by a job) cannot be removed and stay in the Trash.',
    ok: async () => { setDlg(null); const r = await api.libraryPurge(ids); setSel([]); notify(`${r.deleted} deleted forever${r.kept ? `, ${r.kept} kept (part of the history)` : ''}`); },
  });
  const askRename = () => {
    const ids = sel.length ? [...sel] : [];
    if (ids.length === 1) {
      const id = ids[0]!;
      setDlg({ title: 'Rename', okLabel: 'Rename', fields: [{ key: 'name', label: 'Name', type: 'text', value: story.meta[id]?.name ?? '', placeholder: assets.get(id)?.original_name ?? id.slice(0, 8) }], ok: (v) => { setDlg(null); void api.storyOp('renameMany', [{ id, name: v.name }]); } });
      return;
    }
    setBulk(shown.map((x) => x.id).filter((id) => ids.includes(id)));
  };
  const askDetails = () => {
    const id = sel[0]; if (!id) return; const m = story.meta[id] ?? {};
    setDlg({
      title: 'Details', okLabel: 'Save',
      fields: [{ key: 'name', label: 'Name', type: 'text', value: m.name ?? '', placeholder: assets.get(id)?.original_name ?? id.slice(0, 8) }, { key: 'tags', label: 'Tags (comma separated)', type: 'text', value: (m.tags ?? []).join(', ') }, { key: 'note', label: 'Note', type: 'text', value: m.note ?? '' }],
      ok: (v) => { setDlg(null); void api.storyOp('setMeta', id, { name: v.name || undefined, tags: v.tags.split(',').map((t) => t.trim()).filter(Boolean), note: v.note }); },
    });
  };
  const leaf = (f: string) => f.split('/').pop() ?? f;
  const askNewFolder = (parent = folder) => setDlg({ title: parent ? `New folder in ${parent}` : 'New folder', okLabel: 'Create', fields: [{ key: 'name', label: 'Name', type: 'text', value: '', placeholder: 'e.g. Opening scene' }],
    ok: (v) => { setDlg(null); const n = v.name.replace(/\//g, ' ').trim(); if (!n) return; const path = parent ? `${parent}/${n}` : n; void api.storyOp('addFolder', path); setFolder(path); } });
  const askRenameFolder = (f: string) => setDlg({ title: 'Rename folder', okLabel: 'Rename', fields: [{ key: 'name', label: 'Name', type: 'text', value: leaf(f) }],
    ok: (v) => { setDlg(null); const n = v.name.replace(/\//g, ' ').trim(); if (!n || n === leaf(f)) return; const to = parentOf(f) ? `${parentOf(f)}/${n}` : n; void api.storyOp('renameFolder', f, to); if (folder === f || folder.startsWith(f + '/')) setFolder(to + folder.slice(f.length)); } });
  const askDeleteFolder = (f: string) => setDlg({ title: `Delete the folder “${leaf(f)}”?`, okLabel: 'Delete folder', danger: true, fields: [], message: `Only the folder goes. The ${inside(f)} item${inside(f) === 1 ? '' : 's'} inside (and any subfolders) move up to ${parentOf(f) ? '“' + parentOf(f) + '”' : 'the top level'}. Undo brings the folder back.`,
    ok: () => { setDlg(null); void api.storyOp('removeFolder', f); if (folder === f || folder.startsWith(f + '/')) setFolder(parentOf(f)); } });
  const askMove = (ids: string[]) => setDlg({ title: `Move ${ids.length} ${ids.length === 1 ? 'item' : 'items'} to a folder`, okLabel: 'Move', message: 'Pick a folder, or type a new one (use / for a subfolder, like Film/Scene 1). Leave both empty to take them out of every folder.',
    fields: [{ key: 'pick', label: 'Existing folder', type: 'select', value: '', options: [{ value: '', label: '(top level, no folder)' }, ...allFolders.map((f) => ({ value: f, label: f }))] }, { key: 'name', label: 'Or a new folder', type: 'text', value: '', placeholder: 'e.g. Film/Scene 2' }],
    ok: (v) => { setDlg(null); const to = v.name.trim() || v.pick; void api.storyOp('moveMany', ids, to); setSel([]); notify(to ? `Moved ${ids.length} to ${to}` : `Took ${ids.length} out of their folders`); } });
  /** Dropping library items on a folder (or a breadcrumb) files them there. */
  const dropIds = (e: React.DragEvent) => { const id = e.dataTransfer.getData('application/x-driftboard-asset'); if (!id) return []; return selSet.has(id) ? [...sel] : [id]; };
  const dropTarget = (to: string) => ({
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes('application/x-driftboard-asset')) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropOn(to); } },
    onDragLeave: () => setDropOn((d) => (d === to ? null : d)),
    onDrop: (e: React.DragEvent) => { e.preventDefault(); setDropOn(null); const ids = dropIds(e); if (ids.length) { void api.storyOp('moveMany', ids, to); setSel([]); notify(`Moved ${ids.length} to ${to || 'the top level'}`); } },
  });
  const askTags = () => setDlg({
    title: `Add tags to ${sel.length} items`, okLabel: 'Add', fields: [{ key: 'tags', label: 'Tags (comma separated)', type: 'text', value: '' }],
    ok: (v) => { setDlg(null); const tags = v.tags.split(',').map((t) => t.trim()).filter(Boolean); if (tags.length) void api.storyOp('tagMany', [...sel], tags); },
  });

  const download = async () => {
    const r = await api.assetsDownload([...sel]);
    if (r.ok) notify(r.count === 1 ? `Saved to ${r.path}` : `${r.count} files saved as ${r.path}`); else if (!r.cancelled) notify(r.error);
  };
  const items: MenuItem[] = trashView
    ? (sel.length ? [{ label: `Restore ${sel.length}`, icon: 'restore', onClick: () => void restore([...sel]) }, { sep: true }, { label: 'Delete forever…', icon: 'trash', danger: true, onClick: () => askPurge([...sel]) }] : [{ label: 'Select all', icon: 'grid', onClick: () => setSel(shown.map((x) => x.id)) }])
    : sel.length ? [
      { header: 'Name' },
      { label: sel.length === 1 ? 'Rename…' : `Rename ${sel.length} in order…`, icon: 'pencil', onClick: askRename },
      ...(sel.length === 1 ? [{ label: 'Details (tags, note)…', icon: 'tag' as const, onClick: askDetails }] : [{ label: 'Add tags…', icon: 'tag' as const, onClick: askTags }]),
      { label: 'Move to folder…', icon: 'folder', onClick: () => askMove([...sel]) },
      { header: 'Canvas' },
      { label: sel.length === 1 ? (onCanvas.has(sel[0]!) ? 'Show on canvas' : 'Add to canvas') : 'Add to canvas', icon: 'views', onClick: () => void api.boardAddAssets([...sel], 0, 0).then(() => { if (sel.length === 1) focus(sel[0]!); }) },
      ...(sel.some((id) => assets.get(id)?.kind !== 'audio') ? [{ header: 'Story' }, { label: `Send ${sel.length > 1 ? sel.length + ' ' : ''}to the Story`, icon: 'story' as const, sub: 'Each becomes a shot with it picked', onClick: () => void sendToStory([...sel], assets, (a) => assetName(a, story.meta)).then((r) => notify(r.error ?? `Sent ${r.shots} shot${r.shots === 1 ? '' : 's'} to the Story`)) }] : []),
      { header: 'File' },
      ...(sel.length === 1 ? [{ label: 'Open in Explorer', icon: 'ext' as const, onClick: () => void api.assetReveal(sel[0]!) }] : []),
      { label: sel.length === 1 ? 'Download…' : `Download ${sel.length} as zip…`, icon: 'export', onClick: () => void download() },
      { sep: true },
      { label: `Delete${sel.length > 1 ? ` ${sel.length}` : ''}…`, icon: 'trash', danger: true, hint: 'Del', sub: 'To the Trash; Undo brings it back', onClick: askDelete },
    ] : [{ label: 'Select all', icon: 'grid', hint: 'Ctrl+A', onClick: () => setSel(shown.map((x) => x.id)) }, { label: 'Import files…', icon: 'import', onClick: () => void importFiles() }, { label: 'New folder…', icon: 'folder', onClick: () => askNewFolder() }];
  const importFiles = async () => { const a = await api.importAssets(); if (a.length) await api.boardAddAssets(a.map((x) => x.id), 0, 0); };

  const size = look.size === 'compact' ? 84 : look.size === 'large' ? 190 : 128;
  return (
    <div ref={wrapRef} tabIndex={-1} className="libPanel" style={{ outline: 'none', minHeight: '100%' }}
      onKeyDown={(e) => { if (hit(e.nativeEvent, 'library.delete') && sel.length && !trashView && !['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) askDelete(); }}
      onContextMenu={(e) => ctx(e)}>
      <div className="row"><h2 style={{ flex: 1, margin: 0 }}>Library</h2><ViewBar value={look} onChange={setLook} noGrid /><Button size="sm" icon="import" onClick={() => void importFiles()}>Import…</Button></div>
      <div className="row"><Icon name="search" size="s" style={{ color: 'var(--faint)' }} /><input className="inp" placeholder="Search names, tags, notes, prompts" aria-label="Search the Library" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      {story.tags.length > 0 && !trashView && <div className="tags">{story.tags.map(({ tag: t, count }) => <button type="button" key={t} className={'chip' + (tag === t ? ' on' : '')} aria-pressed={tag === t} onClick={() => setTag(tag === t ? '' : t)}><Icon name="tag" size={11} />{t} <span className="faint">{count}</span></button>)}</div>}
      {!trashView && <div className="folderBar" aria-label="Folders">
        <div className="row crumbs">
          {folder && <IconButton size="sm" icon="back" label={`Back to ${parentOf(folder) || 'the Library'}`} onClick={() => setFolder(parentOf(folder))} />}
          <button type="button" className={'crumb' + (dropOn === '' ? ' drop' : '')} aria-current={!folder} onClick={() => setFolder('')} {...dropTarget('')}><Icon name="library" size={12} />Library</button>
          {folder.split('/').filter(Boolean).map((part, i, arr) => { const path = arr.slice(0, i + 1).join('/'); return <span key={path} className="row" style={{ gap: 2 }}><Icon name="chevR" size={11} style={{ color: 'var(--faint)' }} /><button type="button" className={'crumb' + (dropOn === path ? ' drop' : '')} aria-current={i === arr.length - 1} onClick={() => setFolder(path)} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setFmenu({ x: e.clientX, y: e.clientY, path }); }} {...dropTarget(path)}>{part}</button></span>; })}
          <span className="sp" /><Button size="sm" kind="quiet" icon="plus" title={folder ? `New folder inside ${folder}` : 'New folder'} onClick={() => askNewFolder()}>New folder</Button>
        </div>
        {searching && <span className="xs faint">Searching every folder.</span>}
      </div>}
      <Seg label="Show" value={view} onChange={setView} options={([['all', 'All'], ['image', 'Images'], ['video', 'Videos'], ['audio', 'Sound'], ['trash', 'Trash']] as const).map(([k, label]) => ({ value: k, label, count: counts[k], icon: k === 'trash' ? 'trash' as const : undefined }))} />
      {trashView && <Notice><span>Deleted items wait here. Restore them, or delete them forever.</span><div className="row"><Button size="sm" kind="quiet" icon="back" onClick={() => setView('all')}>Back to the Library</Button>{list.length > 0 && <Button size="sm" kind="danger" onClick={() => askPurge(sel.length ? [...sel] : list.map((a) => a.id))}>{sel.length ? 'Delete selected forever…' : 'Empty the Trash…'}</Button>}</div></Notice>}
      {sel.length > 0 ? <div className="selBarP">
        <span className="small"><b>{sel.length}</b> selected</span><span className="sp" />
        {trashView ? <Button size="sm" icon="restore" onClick={() => void restore([...sel])}>Restore</Button> : <>
          <IconButton size="sm" icon="views" label={sel.length === 1 ? 'Show on canvas' : 'Add to canvas'} onClick={() => void api.boardAddAssets([...sel], 0, 0).then(() => { if (sel.length === 1) focus(sel[0]!); })} />
          <IconButton size="sm" icon="folder" label="Move to a folder…" onClick={() => askMove([...sel])} />
          <IconButton size="sm" icon="pencil" label={sel.length === 1 ? 'Rename…' : `Rename ${sel.length} in order…`} onClick={askRename} />
          {sel.length === 1 && <IconButton size="sm" icon="ext" label="Open in Explorer" onClick={() => void api.assetReveal(sel[0]!)} />}
          <IconButton size="sm" icon="export" label={sel.length === 1 ? 'Download: save a copy where you choose' : `Download ${sel.length} as one zip`} onClick={() => void download()} />
          <IconButton size="sm" icon="trash" kind="danger" label="Delete… (to the Trash)" onClick={askDelete} />
        </>}
        <IconButton size="sm" icon="x" label="Clear the selection" onClick={() => setSel([])} />
      </div> : <div className="row"><span className="xs faint" style={{ flex: 1 }}>{list.length} shown · click to select, Ctrl or Shift to add, right-click for more, drag onto the canvas</span>{list.length > 0 && <Button size="sm" kind="quiet" onClick={() => setSel(shown.map((x) => x.id))}>Select all</Button>}</div>}
      {!list.length && !(subfolders.length && !trashView && !searching) && <Empty icon={trashView ? 'trash' : 'library'} title={trashView ? 'The Trash is empty' : folder && !searching ? 'This folder is empty' : 'Nothing here'}>{trashView ? undefined : folder && !searching ? 'Select items in the Library and use Move to folder, or drag them onto a folder.' : 'Import files, or generate something in Create.'}</Empty>}
      <div className="lib" style={{ ['--libW' as string]: `${size}px` }}>
        {!trashView && !searching && subfolders.map((f) => { const first = live.find((a) => { const x = story.meta[a.id]?.folder ?? ''; return x === f || x.startsWith(f + '/'); }); const n = inside(f); const subs = allFolders.filter((x) => parentOf(x) === f).length;
          return <div key={'f:' + f} className={'libItem libFolder' + (dropOn === f ? ' drop' : '')} role="button" tabIndex={0} aria-label={`Folder ${leaf(f)}, ${n} items`} onClick={() => setFolder(f)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFolder(f); } }} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setFmenu({ x: e.clientX, y: e.clientY, path: f }); }} title="Open (right-click: rename, delete). Drop items here to file them." {...dropTarget(f)}>
            <div className="th folderTh">{first && <img src={thumbUrl(first.id)} loading="lazy" alt="" />}<Icon name="folder" size={34} /></div>
            <div className="bd"><b>{leaf(f)}</b><span className="mono xs faint">{n} item{n === 1 ? '' : 's'}{subs ? ` · ${subs} folder${subs === 1 ? '' : 's'}` : ''}</span></div>
          </div>; })}
        {shown.map((a) => (
          <div key={a.id} className={'libItem' + (selSet.has(a.id) ? ' sel' : '')} role="button" tabIndex={0} aria-pressed={selSet.has(a.id)} aria-label={nameOf(a.id)} onClick={(e) => click(e, a.id)} onContextMenu={(e) => ctx(e, a.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); click(e as unknown as React.MouseEvent, a.id); } }}
            draggable={!trashView} onDragStart={(e) => { e.dataTransfer.setData('application/x-driftboard-asset', a.id); e.dataTransfer.effectAllowed = 'copy'; }}>
            <div className={'th' + (a.kind === 'audio' ? ' audioTh' : '')}>
              <img src={thumbUrl(a.id)} loading="lazy" alt="" title={`${nameOf(a.id)}${story.meta[a.id]?.note ? '\n' + story.meta[a.id]!.note : ''}`} />
              <span className="flag">
                {a.kind === 'video' && <i><Icon name="video" size={10} />{a.duration_ms ? (a.duration_ms / 1000).toFixed(1) + ' s' : ''}</i>}
                {a.kind === 'audio' && <i><Icon name="sound" size={10} />{a.duration_ms ? (a.duration_ms / 1000).toFixed(1) + ' s' : ''}</i>}
                {shotOf.has(a.id) && <i title={`Take of ${shotOf.get(a.id)}`}><Icon name="story" size={10} /></i>}
                {!trashView && !onCanvas.has(a.id) && <i title="Not on the canvas (right-click › Add to canvas, or drag it in)">not on canvas</i>}
              </span>
              <span className="ck" aria-hidden="true">{selSet.has(a.id) && <Icon name="check" size={12} />}</span>
            </div>
            <div className="bd"><b>{nameOf(a.id)}</b>{a.width ? <span className="mono xs faint">{a.width}×{a.height}</span> : null}</div>
          </div>
        ))}
      </div>
      {list.length > 200 && <span className="xs faint">Showing 200. Narrow the search.</span>}
      {fmenu && <ContextMenu x={fmenu.x} y={fmenu.y} onClose={() => setFmenu(null)} items={[{ label: 'Open', icon: 'folder', onClick: () => setFolder(fmenu.path) }, { label: 'New folder inside…', icon: 'plus', onClick: () => askNewFolder(fmenu.path) }, { label: 'Rename…', icon: 'pencil', onClick: () => askRenameFolder(fmenu.path) }, { sep: true }, { label: 'Delete folder…', icon: 'trash', danger: true, sub: 'Its items move up one level', onClick: () => askDeleteFolder(fmenu.path) }]} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
      {dlg && <ParamDialog title={dlg.title} fields={dlg.fields} okLabel={dlg.okLabel} message={dlg.message} danger={dlg.danger} onOk={dlg.ok} onCancel={() => setDlg(null)} />}
      {bulk && <BulkRename ids={bulk} nameOf={nameOf} onCancel={() => setBulk(null)} onOk={(names) => { setBulk(null); void api.storyOp('renameMany', names); notify(`Renamed ${names.length} items`); }} />}
      {del && <Dialog title={`Move ${del.length} ${del.length === 1 ? 'item' : 'items'} to the Trash?`} icon="trash" onClose={() => setDel(null)} footer={<><Button onClick={() => setDel(null)}>Cancel</Button><Button kind="danger-solid" icon="trash" onClick={() => void doDelete(del)}>Move to Trash</Button></>}>
        <div className="row wrap">{del.slice(0, 6).map((id) => <Tile key={id} src={thumbUrl(id)} kind={assets.get(id)?.kind === 'audio' ? 'audio' : 'image'} />)}{del.length > 6 && <span className="xs faint">+{del.length - 6} more</span>}</div>
        <Notice tone={usageText(del).startsWith('None') ? 'info' : 'warn'}>{usageText(del)}</Notice>
        <span className="small dim">They come off the canvas and wait in the Trash. The files are kept, so the timeline and story takes still play. Undo (Ctrl+Z or the button in the message) brings them back, or restore them from the Trash.</span>
      </Dialog>}
    </div>
  );
}

/** Rename several items in order, with a live preview of the new names. */
function BulkRename({ ids, nameOf, onOk, onCancel }: { ids: string[]; nameOf: (id: string) => string; onOk: (names: { id: string; name: string }[]) => void; onCancel: () => void }) {
  const [base, setBase] = useState(''); const [start, setStart] = useState(1); const [pad, setPad] = useState(3); const [sep, setSep] = useState(' ');
  const names = ids.map((id, i) => ({ id, name: `${base.trim()}${sep}${String(start + i).padStart(Math.max(1, pad), '0')}` }));
  return (
    <Dialog title={`Rename ${ids.length} items in order`} icon="pencil" onClose={onCancel} footer={<><Button onClick={onCancel}>Cancel</Button><Button kind="primary" disabled={!base.trim()} onClick={() => onOk(names)}>Rename</Button></>}>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <FieldBox label="Base name" style={{ flex: 2 }}><input className="inp" autoFocus value={base} placeholder="e.g. Dance" onChange={(e) => setBase(e.target.value)} /></FieldBox>
        <FieldBox label="Start at" style={{ flex: 1 }}><input className="inp mono" type="number" value={start} onChange={(e) => setStart(Number(e.target.value) || 1)} /></FieldBox>
        <FieldBox label="Digits" style={{ flex: 1 }}><input className="inp mono" type="number" min={1} max={6} value={pad} onChange={(e) => setPad(Number(e.target.value) || 1)} /></FieldBox>
        <FieldBox label="Separator" style={{ flex: 1 }}><input className="inp mono" value={sep} onChange={(e) => setSep(e.target.value)} /></FieldBox>
      </div>
      <span className="small dim">In the order they appear in the Library.</span>
      <div className="lines">{names.slice(0, 8).map((n) => <div key={n.id} className="row"><span className="dim" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf(n.id)}</span><Icon name="chevR" size="s" /><b style={{ flex: 1 }}>{base.trim() ? n.name : '…'}</b></div>)}{names.length > 8 && <span className="xs faint">+{names.length - 8} more</span>}</div>
    </Dialog>
  );
}
