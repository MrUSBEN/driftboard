import { hit } from './keys.ts';
import { ViewBar, UndoRedo, useView } from './View.tsx';
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { C, api, matches, thumbUrl } from './shared.tsx';
import { ContextMenu, ParamDialog, type Field, type MenuItem } from './CanvasMenu.tsx';

type Dlg = { title: string; fields: Field[]; ok: (v: Record<string, string>) => void; message?: string; okLabel?: string; danger?: boolean };

export function LibraryTab({ focusAssetId, focus, notify }: { focusAssetId: string | null; focus: (id: string) => void; notify: (m: string) => void }) {
  const { story, assets, jobs, usage, takeOf, board } = useContext(C);
  const [look, setLook] = useView('library');
  const [q, setQ] = useState('');
  const [view, setView] = useState<'all' | 'image' | 'video' | 'trash'>('all');   // one set of tabs: Trash is a view like the others
  const trashView = view === 'trash';
  const type = view === 'trash' ? 'all' : view;
  const [tag, setTag] = useState('');
  const [sel, setSel] = useState<string[]>([]);
  const anchor = useRef<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const [undoable, setUndoable] = useState('');

  const prompt = useMemo(() => { const m = new Map<string, string>(); for (const j of jobs) for (const o of j.outputs) { const p = JSON.parse(j.params).prompt; if (typeof p === 'string') m.set(o.assetId, p); } return m; }, [jobs]);
  const shotOf = useMemo(() => { const m = new Map<string, string>(); for (const { scene, shots } of story.all) for (const s of shots) for (const t of s.takes) m.set(t.assetId, `${scene.name} / ${s.name}`); return m; }, [story]);
  const onCanvas = useMemo(() => new Set(board.items.filter((i) => i.kind === 'asset' && i.ref).map((i) => i.ref!)), [board.items]);

  const trashedCount = [...assets.values()].filter((a) => story.meta[a.id]?.trashed).length;
  const found = (a: { id: string; original_name: string | null }) => (!tag || story.meta[a.id]?.tags?.includes(tag))
    && matches(q, story.meta[a.id]?.name, story.meta[a.id]?.tags?.join(' '), story.meta[a.id]?.note, prompt.get(a.id), shotOf.get(a.id), a.original_name ?? undefined, a.id.slice(0, 8));
  const pool = [...assets.values()].filter((a) => a.kind !== 'other' && found(a));
  const counts = { all: pool.filter((a) => !story.meta[a.id]?.trashed).length, image: pool.filter((a) => !story.meta[a.id]?.trashed && a.kind === 'image').length, video: pool.filter((a) => !story.meta[a.id]?.trashed && a.kind === 'video').length, trash: pool.filter((a) => story.meta[a.id]?.trashed).length };
  const list = pool.filter((a) => !!story.meta[a.id]?.trashed === trashView && (type === 'all' || a.kind === type));
  const shown = list.slice(0, 200);
  const selSet = new Set(sel);
  const nameOf = (id: string) => story.meta[id]?.name ?? assets.get(id)?.original_name ?? id.slice(0, 8);

  useEffect(() => { setSel((s) => s.filter((id) => assets.has(id))); }, [assets]);
  useEffect(() => { setSel([]); anchor.current = null; }, [view]);
  useEffect(() => { if (undoable) { const t = setTimeout(() => setUndoable(''), 12000); return () => clearTimeout(t); } }, [undoable]);

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
  const askDelete = () => {
    const ids = [...sel]; if (!ids.length) return;
    setDlg({
      title: `Delete ${ids.length} ${ids.length === 1 ? 'item' : 'items'} from the Library?`, okLabel: 'Delete', danger: true, fields: [],
      message: `${usageText(ids)}\n\nThey move to the Trash and come off the canvas. The files are kept, so the timeline and story takes still play. You can undo this (Undo button or Ctrl+Z) or restore from the Trash later.`,
      ok: async () => { setDlg(null); await api.libraryTrash(ids, true); setSel([]); setUndoable(`Deleted ${ids.length}`); },
    });
  };
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
    setDlg({
      title: `Rename ${ids.length} items in order`, okLabel: 'Rename',
      message: 'Names are numbered in the order the items appear in the Library (or the order you selected them). Example: Dance 001, Dance 002…',
      fields: [{ key: 'base', label: 'Base name', type: 'text', value: '' }, { key: 'start', label: 'Start at', type: 'number', value: 1 }, { key: 'pad', label: 'Digits', type: 'number', value: 3 }, { key: 'sep', label: 'Separator', type: 'text', value: ' ' }],
      ok: (v) => {
        setDlg(null); const base = v.base.trim(); if (!base) return notify('Give a base name first.');
        const order = shown.map((x) => x.id).filter((id) => ids.includes(id));
        const start = Number(v.start) || 1, pad = Math.max(1, Number(v.pad) || 3);
        void api.storyOp('renameMany', order.map((id, i) => ({ id, name: `${base}${v.sep}${String(start + i).padStart(pad, '0')}` })));
      },
    });
  };
  const askDetails = () => {
    const id = sel[0]; if (!id) return; const m = story.meta[id] ?? {};
    setDlg({
      title: 'Details', okLabel: 'Save',
      fields: [{ key: 'name', label: 'Name', type: 'text', value: m.name ?? '', placeholder: assets.get(id)?.original_name ?? id.slice(0, 8) }, { key: 'tags', label: 'Tags (comma separated)', type: 'text', value: (m.tags ?? []).join(', ') }, { key: 'note', label: 'Note', type: 'text', value: m.note ?? '' }],
      ok: (v) => { setDlg(null); void api.storyOp('setMeta', id, { name: v.name || undefined, tags: v.tags.split(',').map((t) => t.trim()).filter(Boolean), note: v.note }); },
    });
  };
  const askTags = () => setDlg({
    title: `Add tags to ${sel.length} items`, okLabel: 'Add', fields: [{ key: 'tags', label: 'Tags (comma separated)', type: 'text', value: '' }],
    ok: (v) => { setDlg(null); const tags = v.tags.split(',').map((t) => t.trim()).filter(Boolean); if (tags.length) void api.storyOp('tagMany', [...sel], tags); },
  });

  const download = async () => {
    const r = await api.assetsDownload([...sel]);
    if (r.ok) notify(r.count === 1 ? `Saved to ${r.path}` : `${r.count} files saved as ${r.path}`); else if (!r.cancelled) notify(r.error);
  };
  const items: MenuItem[] = trashView
    ? (sel.length ? [{ label: `Restore ${sel.length}`, onClick: () => void restore([...sel]) }, { label: `Delete forever…`, danger: true, onClick: () => askPurge([...sel]) }] : [{ label: 'Select all', onClick: () => setSel(shown.map((x) => x.id)) }])
    : sel.length ? [
      { label: sel.length === 1 ? 'Rename…' : `Rename ${sel.length} in order…`, onClick: askRename },
      ...(sel.length === 1 ? [{ label: 'Details (tags, note)…', onClick: askDetails }] : [{ label: 'Add tags…', onClick: askTags }]),
      { sep: true },
      ...(sel.length === 1 ? [{ label: 'Open in Explorer', onClick: () => void api.assetReveal(sel[0]!) }] : []),
      { label: sel.length === 1 ? 'Download…' : `Download ${sel.length} as zip…`, onClick: () => void download() },
      { sep: true },
      { label: sel.length === 1 ? 'Show on canvas' : 'Add to canvas', onClick: () => void api.boardAddAssets([...sel], 0, 0).then(() => { if (sel.length === 1) focus(sel[0]!); }) },
      { sep: true },
      { label: `Delete${sel.length > 1 ? ` ${sel.length}` : ''}…`, danger: true, hint: 'Del', onClick: askDelete },
    ] : [{ label: 'Select all', onClick: () => setSel(shown.map((x) => x.id)) }, { label: 'Import files…', onClick: () => void importFiles() }];
  const importFiles = async () => { const a = await api.importAssets(); if (a.length) await api.boardAddAssets(a.map((x) => x.id), 0, 0); };

  return (
    <div ref={wrapRef} tabIndex={-1} style={{ outline: 'none', minHeight: '100%' }}
      onKeyDown={(e) => { if (hit(e.nativeEvent, 'library.delete') && sel.length && !trashView && !['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) askDelete(); }}
      onContextMenu={(e) => ctx(e)}>
      <div className="row" style={{ margin: 0 }}><h2 style={{ flex: 1 }}>Library</h2><UndoRedo /><ViewBar value={look} onChange={setLook} noGrid /></div>
      <input type="text" placeholder="Search names, tags, notes, prompts…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="row" style={{ margin: '8px 0', flexWrap: 'wrap' }}>
        <div className="seg">
          {([['all', 'All'], ['image', 'Images'], ['video', 'Videos'], ['trash', 'Trash']] as const).map(([k, label]) =>
            <button key={k} className={(view === k ? 'on ' : '') + (k === 'trash' ? 'trashTab' : '')} onClick={() => setView(k)}>{label} <span className="count">{counts[k]}</span></button>)}
        </div>
        <button onClick={() => void importFiles()}>Import…</button>
      </div>
      {trashView && <div className="trashBanner">🗑 Trash: deleted items live here. Restore them, or delete forever. <button className="ghost" onClick={() => setView('all')}>Back to Library</button></div>}
      {undoable && <div className="card row" style={{ justifyContent: 'space-between', padding: '6px 10px' }}><span>{undoable}</span><button onClick={() => { setUndoable(''); void api.boardUndo(); }}>Undo</button></div>}
      {story.tags.length > 0 && !trashView && <div className="tags">{story.tags.map(({ tag: t, count }) => <span key={t} className={'tag' + (tag === t ? ' on' : '')} onClick={() => setTag(tag === t ? '' : t)}>{t} {count}</span>)}</div>}
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="note">{sel.length ? `${sel.length} selected · ` : ''}{list.length} shown</span>
        <span className="row">
          {sel.length === 1 && !trashView && <button className="ghost" title="Show this file in Windows Explorer" onClick={() => void api.assetReveal(sel[0]!)}>Open in Explorer</button>}
          {sel.length > 0 && !trashView && <button className="ghost" title={sel.length === 1 ? 'Save a copy of this file where you choose' : 'Save the selected files together as one zip'} onClick={() => void download()}>{sel.length === 1 ? 'Download' : `Download ${sel.length} (zip)`}</button>}
          {sel.length > 0 && <button className="ghost" onClick={() => setSel([])}>Clear</button>}
          {list.length > 0 && sel.length < shown.length && <button className="ghost" onClick={() => setSel(shown.map((x) => x.id))}>Select all</button>}
          {trashView && list.length > 0 && <button className="ghost" onClick={() => askPurge(sel.length ? [...sel] : list.map((a) => a.id))}>{sel.length ? 'Delete selected forever…' : 'Empty trash…'}</button>}
        </span>
      </div>
      {!list.length && <div className="empty">{trashView ? 'The trash is empty.' : 'Nothing here. Import files or generate something.'}</div>}
      <div className="takes lib" style={{ gridTemplateColumns: `repeat(auto-fill,minmax(${look.size === 'compact' ? 62 : look.size === 'large' ? 170 : 92}px,1fr))` }}>
        {shown.map((a) => (
          <div key={a.id} className={'take' + (selSet.has(a.id) ? ' picked' : '')} onClick={(e) => click(e, a.id)} onContextMenu={(e) => ctx(e, a.id)}
            draggable={!trashView} onDragStart={(e) => { e.dataTransfer.setData('application/x-driftboard-asset', a.id); e.dataTransfer.effectAllowed = 'copy'; }}>
            <img src={thumbUrl(a.id)} loading="lazy" title={`${nameOf(a.id)}${story.meta[a.id]?.note ? '\n' + story.meta[a.id]!.note : ''}`} />
            {a.kind === 'video' && <span className="dur">{a.duration_ms ? (a.duration_ms / 1000).toFixed(1) + 's' : '▶'}</span>}
            {shotOf.has(a.id) && <span className="inShot" title={shotOf.get(a.id)}>●</span>}
            {!trashView && !onCanvas.has(a.id) && <span className="offCanvas" title="Not on the canvas (right-click → Show on canvas, or drag it in)">◌</span>}
            {story.meta[a.id]?.name && <span className="libName">{story.meta[a.id]!.name}</span>}
          </div>
        ))}
      </div>
      {list.length > 200 && <div className="note">Showing 200. Narrow the search.</div>}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
      {dlg && <ParamDialog title={dlg.title} fields={dlg.fields} okLabel={dlg.okLabel} message={dlg.message} danger={dlg.danger} onOk={dlg.ok} onCancel={() => setDlg(null)} />}
    </div>
  );
}
