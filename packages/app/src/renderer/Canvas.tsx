import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from './theme/theme.ts';
import {
  ReactFlow, Background, BackgroundVariant, Controls, MiniMap, Handle, Position, NodeResizer, applyNodeChanges, useReactFlow, useUpdateNodeInternals, ViewportPortal,
  type Node, type Edge, type NodeChange, type NodeProps, type OnSelectionChangeParams,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { BoardItem } from '../main/api.ts';
import { askUser } from './Ask.tsx';
import { EditorCtx, joinForTimeline } from './editorBridge.tsx';
import { openContinuity } from './Continuity.tsx';
import { appendToTimeline, replaceClip, getState as editorState, selectClips, selectSelectedClipIds } from '@driftboard/editor';
import { RegenerateDialog } from './Regenerate.tsx';
import { C, api, requestPlay, type JobView, thumbUrl, type Asset, type Draft, autoAssign, draftFromJob, profilesWithRoles, slotWithRole } from './shared.tsx';
import { hit, combo } from './keys.ts';
import { CropDialog, TrimDialog } from './MediaDialogs.tsx';
import { ContextMenu, ParamDialog, arrangeLinear, arrangeLineage, type Field, type MenuItem } from './CanvasMenu.tsx';
import type { MediaOp } from '@driftboard/media';

export interface CanvasActions {
  editor: import('@driftboard/editor').EditorStoreApi | null;
  /** ordered ids of selected board items (click order) */
  onSelect: (ids: string[]) => void;
  openDraft: (d: Draft) => void;
  /** frame the preview is showing, for Branch */
  previewFrame: () => { assetId: string; frame: number } | null;
  notify: (msg: string) => void;
}

const nodeTypes = { asset: memo(AssetNode), note: memo(NoteNode), group: memo(GroupNode), job: memo(JobNode) };
const fmt = (ms: number | null) => (ms ? `${(ms / 1000).toFixed(1)}s` : '');

/** The floating panels cover the left and right of the canvas: Fit and focus keep the free part in view. Set by App. */
const insets = { left: 0, right: 0 };
export const setCanvasInsets = (left: number, right: number) => { insets.left = left; insets.right = right; };
/** Padding for fitView: the panels' width on each side plus a share of the free width (frac like the old uniform padding). */
const px = (n: number) => `${Math.round(n)}px` as `${number}px`;
const fitPad = (frac: number) => ({ left: px(insets.left + 24), right: px(insets.right + 24), top: px(40 + frac * 200), bottom: px(60 + frac * 200) });

export function Canvas({ act, selected, focus }: { act: CanvasActions; selected: string[]; focus: { assetId: string; n: number } | null }) {
  const theme = useTheme().effective;
  const { board, jobs, assets, profiles, progress } = useContext(C);
  const rf = useReactFlow();
  const updateInternals = useUpdateNodeInternals();
  const wrap = useRef<HTMLDivElement>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const rfNodes = useRef<Node[]>([]); rfNodes.current = nodes;
  const [lineageOn, setLineageOn] = useState(true);
  const order = useRef<string[]>([]);

  // other panels can ask the canvas to show everything (after Arrange)
  useEffect(() => { const f = () => { setTimeout(() => void rf.fitView({ duration: 400, padding: fitPad(0.1) }), 150); }; window.addEventListener('driftboard-fit', f); return () => window.removeEventListener('driftboard-fit', f); }, [rf]);

  // jump to an asset (from the Story or Library tab): select its node and bring it into view
  useEffect(() => {
    if (!focus) return;
    const it = board.items.find((i) => i.kind === 'asset' && i.ref === focus.assetId);
    if (!it) return;   // browsing the Library never adds to the canvas: drag it in on purpose
    setNodes((cur) => cur.map((n) => ({ ...n, selected: n.id === it.id })));
    void rf.fitView({ nodes: [{ id: it.id }], duration: 300, maxZoom: 1, padding: fitPad(0.6) });
  }, [focus?.n]);

  // placeholders for jobs that started from a board item and have not finished
  const [dismissed, setDismissed] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem('driftboard.dismissedJobs') ?? '[]') as string[]); } catch { return new Set(); } });
  useEffect(() => {
    const f = (e: Event) => setDismissed((s) => { const n = new Set(s).add((e as CustomEvent<string>).detail); try { localStorage.setItem('driftboard.dismissedJobs', JSON.stringify([...n])); } catch { /* ignore */ } return n; });
    window.addEventListener('driftboard-dismiss-job', f); return () => window.removeEventListener('driftboard-dismiss-job', f);
  }, []);
  const placeholders = useMemo<Node[]>(() => {
    const byId = new Map(board.items.map((i) => [i.id, i]));
    const slots = new Map<string, number>();
    const out: Node[] = [];
    for (const j of jobs) {
      if (!j.origin || dismissed.has(j.id) || !(j.status === 'queued' || j.status === 'running')) continue;   // failures are announced in a toast and live in the Queue tab, not on the canvas
      const o = byId.get(j.origin); if (!o) continue;
      const k = slots.get(o.id) ?? 0; slots.set(o.id, k + 1);
      const ow = o.w ?? (o.kind === 'asset' ? 180 : 320);
      const used = board.items.filter((i) => i.kind === 'asset' && Math.abs(i.x - (o.x + ow + 60)) < 5 && i.y >= o.y - 5).length;
      out.push({ id: `job-${j.id}`, type: 'job', position: { x: o.x + ow + 60, y: o.y + (used + k) * 140 }, draggable: false, selectable: false, deletable: false, data: { jobId: j.id } });
    }
    return out;
  }, [board.items, jobs, dismissed]);

  useEffect(() => {
    setNodes((cur) => {
      const sel = new Set(cur.filter((n) => n.selected).map((n) => n.id));
      const old = new Map(cur.map((n) => [n.id, n]));
      // keep what the flow measured (size, link handles): rebuilding a node from scratch throws that away and the links then point at where it used to be
      return [...board.items.map((it) => { const n = toNode(it, sel.has(it.id)); const o = old.get(it.id); return o ? { ...o, ...n, measured: o.measured, width: o.width, height: o.height } : n; }), ...placeholders];
    });
    // nodes that moved or vanished (Arrange, delete, undo) leave their old link ends behind until the flow re-measures them: do it now
    const ids = board.items.map((i) => i.id);
    const t = setTimeout(() => updateInternals(ids), 60), t2 = setTimeout(() => updateInternals(ids), 500);
    return () => { clearTimeout(t); clearTimeout(t2); };
  }, [board.items, placeholders]);   // eslint-disable-line react-hooks/exhaustive-deps

  const edges = useMemo<Edge[]>(() => [], []);   // the lineage wires are drawn by LineageLayer straight from the node positions, so they can never point at where a node used to be

  const onNodesChange = useCallback((c: NodeChange[]) => setNodes((n) => applyNodeChanges(c, n)), []);
  const persist = useCallback((_: unknown, __: Node, dragged: Node[]) => {
    const moved = new Map(dragged.filter((n) => n.type !== 'job').map((n) => [n.id, n.position]));
    if (carry.current) { for (const n of rfNodes.current) if (carry.current.inside.has(n.id)) moved.set(n.id, n.position); carry.current = null; }   // what a group carried
    void api.boardPlace([...moved].map(([id, p]) => ({ id, x: Math.round(p.x), y: Math.round(p.y) })));
  }, []);

  const onSelection = useCallback(({ nodes: ns }: OnSelectionChangeParams) => {
    const ids = ns.filter((n) => n.type !== 'job').map((n) => n.id);
    const kept = order.current.filter((i) => ids.includes(i));
    for (const i of ids) if (!kept.includes(i)) kept.push(i);
    if (kept.join() !== order.current.join()) { order.current = kept; act.onSelect(kept); }
  }, [act]);

  /** + Group: wrap the selected nodes in a new group, or drop an empty one in the middle of the view */
  const addGroup = async () => {
    const chosen = rf.getNodes().filter((n) => n.selected && (n.type === 'asset' || n.type === 'note'));
    if (!chosen.length) { await api.boardAddGroup(center().x, center().y); return; }
    const pad = 30;
    const x0 = Math.min(...chosen.map((n) => n.position.x)), y0 = Math.min(...chosen.map((n) => n.position.y));
    const x1 = Math.max(...chosen.map((n) => n.position.x + (n.measured?.width ?? 180))), y1 = Math.max(...chosen.map((n) => n.position.y + (n.measured?.height ?? 130)));
    await api.boardAddGroup(Math.round(x0 - pad), Math.round(y0 - pad - 20), Math.round(x1 - x0 + 2 * pad), Math.round(y1 - y0 + 2 * pad + 20));
  };
  /** Dragging a group takes the nodes that sit inside it along (they get selected so React Flow moves them together). */
  const carry = useRef<{ start: { x: number; y: number }; inside: Map<string, { x: number; y: number }> } | null>(null);
  const onDragStart = useCallback((_: unknown, node: Node) => {
    carry.current = null;
    if (node.type !== 'group') return;
    const w = (node.style?.width as number) ?? 520, h = (node.style?.height as number) ?? 360;
    const inside = new Map<string, { x: number; y: number }>();
    for (const n of rf.getNodes()) {
      if (n.id === node.id || n.type === 'group' || n.type === 'job' || n.selected) continue;
      const cx = n.position.x + (n.measured?.width ?? 180) / 2, cy = n.position.y + (n.measured?.height ?? 130) / 2;
      if (cx > node.position.x && cx < node.position.x + w && cy > node.position.y && cy < node.position.y + h) inside.set(n.id, { ...n.position });
    }
    carry.current = { start: { ...node.position }, inside };
  }, [rf]);
  const onDrag = useCallback((_: unknown, node: Node) => {
    const c = carry.current; if (!c || node.type !== 'group' || !c.inside.size) return;
    const dx = node.position.x - c.start.x, dy = node.position.y - c.start.y;
    setNodes((cur) => cur.map((n) => { const o = c.inside.get(n.id); return o ? { ...n, position: { x: o.x + dx, y: o.y + dy } } : n; }));
  }, []);

  const center = () => { const r = wrap.current!.getBoundingClientRect(); const p = rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); return { x: Math.round(p.x - 100), y: Math.round(p.y - 60) }; };

  const onDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const libId = e.dataTransfer.getData('application/x-driftboard-asset');   // dragged from the Library tab
    if (libId) { await api.boardAddAssets([libId], Math.round(p.x), Math.round(p.y)); return; }
    const paths = Array.from(e.dataTransfer.files).map((f) => api.pathFor(f)).filter(Boolean);
    if (!paths.length) return;
    await api.boardImportPaths(paths, Math.round(p.x), Math.round(p.y));
  }, [rf]);


  // Delete/Backspace removes selected canvas items only while the pointer is over the canvas (a key press meant for the timeline or a list never reaches it)
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const t = e.target as HTMLElement | null; if (t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
      if (!wrap.current?.matches(':hover') || document.querySelector('.modalBack')) return;
      const ids = rfNodes.current.filter((n) => n.selected && n.type !== 'job').map((n) => n.id);
      if (ids.length) { e.preventDefault(); void api.boardRemove(ids); }
    };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, []);

  // ---- context actions for the selection ----
  const items = new Map(board.items.map((i) => [i.id, i]));
  const sel = selected.map((id) => items.get(id)).filter((x): x is BoardItem => !!x);
  const selAssets = sel.filter((i) => i.kind === 'asset' && i.ref).map((i) => ({ item: i, asset: assets.get(i.ref!) })).filter((x): x is { item: BoardItem; asset: Asset } => !!x.asset);
  const videos = selAssets.filter((x) => x.asset.kind === 'video');
  const [busy, setBusy] = useState('');
  const [regen, setRegen] = useState<{ job: JobView; origin: string } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; where: 'node' | 'pane' } | null>(null);
  const [dialog, setDialog] = useState<{ title: string; fields: Field[]; ok: (v: Record<string, string>) => void } | null>(null);
  const [media, setMedia] = useState<{ kind: 'crop' | 'trim'; item: BoardItem; asset: Asset } | null>(null);
  const [mapOpen, setMapOpen] = useState(() => { try { return localStorage.getItem('driftboard.minimap') !== '0'; } catch { return true; } });
  const toggleMap = () => setMapOpen((o) => { try { localStorage.setItem('driftboard.minimap', o ? '0' : '1'); } catch { /* ignore */ } return !o; });

  const selectOnly = (id: string) => setNodes((cur) => cur.some((n) => n.id === id && n.selected) ? cur : cur.map((n) => ({ ...n, selected: n.id === id })));
  const onNodeContextMenu = useCallback((e: React.MouseEvent, node: Node) => { e.preventDefault(); if (node.type === 'job') return; selectOnly(node.id); setMenu({ x: e.clientX, y: e.clientY, where: 'node' }); }, []);
  const onPaneContextMenu = useCallback((e: MouseEvent | React.MouseEvent) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, where: 'pane' }); }, []);
  useEffect(() => {   // the ▶ button on a node selects it, so the preview shows it
    const f = (e: Event) => selectOnly((e as CustomEvent<string>).detail);
    window.addEventListener('driftboard-node-select', f); return () => window.removeEventListener('driftboard-node-select', f);
  }, []);
  useEffect(() => {   // the ⋯ button on a node opens the same menu
    const f = (e: Event) => { const d = (e as CustomEvent<{ id: string; x: number; y: number }>).detail; selectOnly(d.id); setMenu({ x: d.x, y: d.y, where: 'node' }); };
    window.addEventListener('driftboard-node-menu', f); return () => window.removeEventListener('driftboard-node-menu', f);
  }, []);

  const jobOf = (assetId: string) => jobs.find((j) => j.profile_id && j.status === 'done' && j.outputs.some((o) => o.assetId === assetId));
  const doEdit = async (assetId: string, op: MediaOp, originItem: string, label: string) => {
    setBusy(label); const r = await api.mediaEdit(assetId, op, originItem); setBusy('');
    act.notify(r.ok ? `${label}: done, the result is on the canvas` : `${label} failed: ${r.error}`);
  };
  const ratios = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '2.39:1'].map((r) => ({ value: r, label: r }));
  const askResize = (x: { item: BoardItem; asset: Asset }) => setDialog({
    title: `Resize ${x.asset.kind}`, ok: (v) => { setDialog(null); const scale = Number(v.scale), w = Number(v.width), h = Number(v.height); void doEdit(x.asset.id, scale > 0 ? { op: 'resize', scale: scale / 100 } : { op: 'resize', width: w > 0 ? w : undefined, height: h > 0 ? h : undefined }, x.item.id, 'Resize'); },
    fields: [{ key: 'width', label: 'Width (px)', type: 'number', value: '', placeholder: String(x.asset.width ?? '') }, { key: 'height', label: 'Height (px)', type: 'number', value: '', placeholder: String(x.asset.height ?? ''), hint: 'Leave one empty to keep the proportions.' }, { key: 'scale', label: 'Or scale (%)', type: 'number', value: '', hint: 'If set, this wins over width and height.' }],
  });
  const askCrop = (x: { item: BoardItem; asset: Asset }) => setMedia({ kind: 'crop', ...x });
  const askTrim = (x: { item: BoardItem; asset: Asset }) => setMedia({ kind: 'trim', ...x });

  const arrangeSel = async (mode: 'grid' | 'row' | 'column') => {
    const chosen = rf.getNodes().filter((n) => n.selected && (n.type === 'asset' || n.type === 'note'));
    const byOrder = new Map(selected.map((id, i) => [id, i]));
    chosen.sort((a, b) => (byOrder.get(a.id) ?? 1e6) - (byOrder.get(b.id) ?? 1e6) || a.position.y - b.position.y || a.position.x - b.position.x);
    const moves = arrangeLinear(chosen.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y, w: n.measured?.width ?? 180, h: n.measured?.height ?? 130 })), mode);
    if (moves.length) { await api.boardPlace(moves); act.notify(`Arranged ${moves.length} nodes`); }
  };
  /** Lineage arrange: the selected nodes if two or more are selected, else every asset on the canvas. */
  const arrangeByLineage = async () => {
    const sel2 = rf.getNodes().filter((n) => n.selected && n.type === 'asset');
    // with nothing chosen, whatever sits inside a group you made is left alone; chosen nodes are moved even inside a group
    const mine = rf.getNodes().filter((g) => g.type === 'group' && !(g.data as unknown as BoardItem).ref);
    const inGroup = (n: { position: { x: number; y: number }; measured?: { width?: number; height?: number } }) => mine.some((g) => { const cx = n.position.x + (n.measured?.width ?? 180) / 2, cy = n.position.y + (n.measured?.height ?? 130) / 2; const w = Number(g.style?.width ?? g.measured?.width ?? 520), h = Number(g.style?.height ?? g.measured?.height ?? 360); return cx >= g.position.x && cx <= g.position.x + w && cy >= g.position.y && cy <= g.position.y + h; });
    const pool = (sel2.length >= 2 ? sel2 : rf.getNodes().filter((n) => n.type === 'asset' && !inGroup(n)));
    const moves = arrangeLineage(pool.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y, w: n.measured?.width ?? 180, h: n.measured?.height ?? 130 })), board.lineage);
    if (moves.length) { await api.boardPlace(moves); act.notify('Arranged by where each one came from'); setTimeout(() => void rf.fitView({ duration: 400, padding: fitPad(0.15) }), 200); }
  };
  /** video/image clips selected on the timeline (one per linked group) */
  const tlSel = () => { if (!act.editor) return []; const s = editorState(act.editor), ids = selectSelectedClipIds(s); return selectClips(s).filter((c) => ids.has(c.id) && c.type !== 'audio' && c.assetId && c.assetId !== one?.asset.id); };
  const addToTimeline = () => { if (!act.editor) return; void api.boardAddAssets(selAssets.map((x) => x.asset.id), 0, 0);   // idempotent: whatever goes on the timeline stays on the canvas
    void joinForTimeline(act.editor!, selAssets.filter((x) => x.asset.kind !== 'audio').map((x) => x.asset.id)).then((ids) => { appendToTimeline(act.editor!, ids); act.notify(`Added ${selAssets.length} to the timeline`); }); };

  const videoProfiles = profiles.filter((p) => p.kind === 'video');
  const generic = () => {
    const refs = selAssets.map((x) => x.asset.id);
    const p = (selAssets.length === 1 && selAssets[0]!.asset.kind === 'image' ? profilesWithRoles(videoProfiles, ['first_frame'])[0] : undefined) ?? videoProfiles[0] ?? profiles[0];
    if (!p) return;
    act.openDraft({ profileId: p.id, values: {}, inputs: autoAssign(p, refs), origin: selAssets[0]?.item.id, title: 'Generate' });
  };
  const frameDraft = async (roles: Record<string, [string, 'first' | 'last' | { frame: number }][]>, title: string, origin: string, need: string[]) => {
    const p = profilesWithRoles(videoProfiles, need)[0];
    if (!p) return act.notify(`No profile has ${need.join(' and ')} slots.`);
    setBusy(title);
    const inputs: Record<string, string[]> = {};
    for (const [role, list] of Object.entries(roles)) {
      const slot = slotWithRole(p, role)!;
      for (const [clip, which] of list) {
        const r = await api.frameExtract(clip, which, origin);
        if (!r.ok) { setBusy(''); return act.notify(r.error); }
        (inputs[slot.id] ??= []).push(r.assetId);
      }
    }
    setBusy('');
    act.openDraft({ profileId: p.id, values: {}, inputs, origin, title, kind: title === 'Continue' ? 'continue' : title === 'Bridge' ? 'bridge' : undefined });
  };
  const doContinuity = () => openContinuity({ title: `Continuity of ${videos.length} clip${videos.length === 1 ? '' : 's'}`, items: videos.map((v) => ({ assetId: v.asset.id })) });
  /** Held frames: the end of the clip (and for Bridge the start of the next one) goes in as a short clip, so motion, light and place carry over, not just one still. */
  const heldProfile = videoProfiles.find((p) => p.slots.some((s) => s.role === 'guide_start'));
  const heldDraft = async (bridge: boolean) => {
    const p = heldProfile; if (!p) return;
    const a = videos[0]!; const b = videos[1];
    const sId = p.slots.find((s) => s.role === 'guide_start')!.id, eId = p.slots.find((s) => s.role === 'guide_end')?.id;
    setBusy(bridge ? 'Preparing held frames for the bridge' : 'Preparing held frames');
    const g = await api.guideClip(a.asset.id, { side: 'tail', frames: 22, matchColor: true });
    if (!g.ok) { setBusy(''); return act.notify(g.error); }
    const inputs: Record<string, string[]> = { [sId]: [g.assetId] };
    const values: Record<string, unknown> = { guide_start_frames: g.frames };
    if (bridge && b && eId) {
      const e = await api.guideClip(b.asset.id, { side: 'head', frames: 22, matchColor: true });
      if (!e.ok) { setBusy(''); return act.notify(e.error); }
      inputs[eId] = [e.assetId]; values.guide_end_frames = e.frames;
    }
    const refSlot = p.slots.find((s) => s.type === 'image_list');
    if (g.keystone && refSlot) inputs[refSlot.id] = [g.keystone];
    setBusy('');
    act.openDraft({ profileId: p.id, values, inputs, origin: a.item.id, title: bridge ? 'Bridge (held frames)' : 'Continue (held frames)', kind: bridge ? 'bridge' : 'continue' });
  };
  const doContinue = () => { const v = videos[0]!; void frameDraft({ first_frame: [[v.asset.id, 'last']] }, 'Continue', v.item.id, ['first_frame']); };
  const doBranch = () => {
    const v = videos[0]!, pf = act.previewFrame();
    if (!pf || pf.assetId !== v.asset.id) return act.notify('Scrub the preview to the frame to branch from first.');
    void frameDraft({ first_frame: [[v.asset.id, { frame: pf.frame }]] }, `Branch at frame ${pf.frame}`, v.item.id, ['first_frame']);
  };
  const doBridge = () => { const [a, b] = videos; void frameDraft({ first_frame: [[a!.asset.id, 'last']], last_frame: [[b!.asset.id, 'first']] }, 'Bridge', a!.item.id, ['first_frame', 'last_frame']); };

  const importHere = async () => { const a = await api.importAssets(); const c = center(); if (a.length) await api.boardAddAssets(a.map((x) => x.id), c.x, c.y); };
  const one = selAssets.length === 1 ? selAssets[0]! : null;
  const arrangeItems: MenuItem[] = [
    { label: 'Arrange as grid', onClick: () => void arrangeSel('grid'), disabled: sel.length < 2 },
    { label: 'Arrange in a row', onClick: () => void arrangeSel('row'), disabled: sel.length < 2 },
    { label: 'Arrange in a column', onClick: () => void arrangeSel('column'), disabled: sel.length < 2 },
    { label: sel.length >= 2 ? 'Arrange selected by lineage' : 'Arrange all by lineage', onClick: () => void arrangeByLineage(), title: 'Left to right in the order things were made from each other' },
  ];
  const nodeItems: MenuItem[] = [
    ...(selAssets.length ? [{ label: `Generate${selAssets.length > 1 ? ` from ${selAssets.length}` : ''}…`, onClick: generic }] : []),
    ...(videos.length === 1 && selAssets.length === 1 ? [...(heldProfile ? [{ label: 'Continue with held frames (recommended)', title: 'The last 22 frames of this clip, matched to the look of the first picture of the chain, anchor the start of the new clip: motion, light and place carry over. The new clip repeats them; the timeline gets a copy with them trimmed.', onClick: () => void heldDraft(false) }] : []), { label: 'Continue from last frame only', onClick: doContinue }, { label: 'Branch at preview frame', onClick: doBranch }] : []),
    ...(videos.length === 2 && selAssets.length === 2 ? [...(heldProfile ? [{ label: 'Bridge with held frames (recommended)', title: 'The end of the first clip and the start of the second anchor both ends of the new clip.', onClick: () => void heldDraft(true) }] : []), { label: 'Bridge with first/last frame only', onClick: doBridge }] : []),
    ...(videos.length >= 1 && videos.length === selAssets.length ? [{ label: 'Check continuity…', title: 'Measures brightness, colour, exposure at each start and every join (clips in the order selected), lists what looks irregular and offers a fix for each', onClick: doContinuity }] : []),
    ...(selAssets.some((x) => x.asset.kind !== 'audio') ? [{ label: 'Add to timeline', onClick: addToTimeline }] : []),
    ...(one && one.asset.kind !== 'audio' && tlSel().length ? [{ label: 'Replace the selected timeline clip with this', title: 'The clip selected on the timeline is swapped for this one (same spot, its audio too). The old one stays on the canvas and in the Library.', onClick: () => { const ids = tlSel().map((c) => c.id); void joinForTimeline(act.editor!, [one.asset.id]).then(([jid]) => { for (const id of ids) replaceClip(act.editor!, id, jid!, true); act.notify('Replaced on the timeline'); }); } }] : []),
    ...(one ? [{ sep: true }, ...(one.asset.kind === 'video' ? [{ label: 'Trim…', onClick: () => askTrim(one) }] : []),
      ...(jobOf(one.asset.id) ? [{ label: 'Regenerate…', title: 'Make new results with the same settings: a quick batch, or open the whole form to change things', onClick: () => setRegen({ job: jobOf(one.asset.id)!, origin: one.item.id }) }] : []),
      { label: 'Crop…', onClick: () => askCrop(one) }, { label: 'Resize…', onClick: () => askResize(one) },
      { label: 'Upscale ×2', onClick: () => void doEdit(one.asset.id, { op: 'upscale', factor: 2 }, one.item.id, 'Upscale'), title: 'Lanczos resample (not AI)' }] : []),
    { sep: true }, ...(sel.length === 2 ? [{ label: 'Swap places', title: 'The two selected items trade places on the canvas (nothing is removed)', onClick: () => void api.boardPlace([{ id: sel[0]!.id, x: sel[1]!.x, y: sel[1]!.y }, { id: sel[1]!.id, x: sel[0]!.x, y: sel[0]!.y }]) }] : []), ...(sel.length > 1 ? [...arrangeItems, { label: 'Group selection', onClick: () => void addGroup() }, { sep: true }] : []),
    { label: `Delete${sel.length > 1 ? ` ${sel.length}` : ''}`, danger: true, hint: 'Del', title: 'Removes it from the canvas; the file stays in the Library. Ctrl+Z undoes.', onClick: () => void api.boardRemove(sel.map((i) => i.id)) },
  ];
  const paneItems: MenuItem[] = [
    { label: 'Add note', onClick: () => api.boardAddNote(center().x, center().y) },
    { label: 'Add group', onClick: () => void addGroup() },
    { label: 'Import files…', onClick: () => void importHere() },
    { sep: true }, ...arrangeItems, { sep: true },
    { label: 'Fit all in view', onClick: () => void rf.fitView({ duration: 300, padding: fitPad(0.1) }) },
  ];

  return (
    <div ref={wrap} style={{ height: '100%', position: 'relative' }} onDragOver={(e) => e.preventDefault()} onDrop={onDrop} onContextMenu={(e) => e.preventDefault()}>
      <div className="toolbar">
        <button onClick={() => api.boardAddNote(center().x, center().y)}>+ Note</button>
        <button title="New group; with nodes selected it wraps them" onClick={() => addGroup()}>+ Group</button>
        <button onClick={() => void importHere()}>Import…</button>
        <ViewsMenu />
        <label className="row" style={{ margin: 0, color: 'var(--text)' }}><input type="checkbox" checked={lineageOn} onChange={(e) => setLineageOn(e.target.checked)} />Lineage</label>
        {busy && <span className="note">{busy}…</span>}
      </div>
      <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onNodeDragStart={onDragStart} onNodeDrag={onDrag} onNodeDragStop={persist} elevateNodesOnSelect={false} onSelectionChange={onSelection}
        onNodeContextMenu={onNodeContextMenu} onPaneContextMenu={onPaneContextMenu} onSelectionContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, where: 'node' }); }}
        nodesConnectable={false} onlyRenderVisibleElements minZoom={0.1} maxZoom={2} fitView fitViewOptions={{ padding: fitPad(0.1) }} colorMode={theme} proOptions={{ hideAttribution: true }}
        deleteKeyCode={null} panOnDrag={[0, 1]} selectionKeyCode="Shift" panOnScroll={false} multiSelectionKeyCode={["Shift", "Control", "Meta"]}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.6} color="var(--dot)" />
        <Controls showInteractive={false} />
        {lineageOn && <ViewportPortal><LineageLayer nodes={nodes} lineage={board.lineage} /></ViewportPortal>}
        {mapOpen && <MiniMap pannable zoomable position="bottom-right" style={{ position: 'absolute', right: 0, bottom: 0, background: 'var(--s1)', border: '1px solid var(--line2)', borderRadius: 9, boxShadow: 'var(--shadow-sm)', width: 150, height: 100, margin: '0 12px 46px 0' }} maskColor="color-mix(in srgb, var(--text) 10%, transparent)" nodeColor="var(--s4)" />}
      </ReactFlow>
      <button className="mapToggle" title={mapOpen ? 'Hide the overview map' : 'Show the overview map'} onClick={toggleMap}>{mapOpen ? '▾ Map' : '▴ Map'}</button>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.where === 'node' && sel.length ? nodeItems : paneItems} onClose={() => setMenu(null)} />}
      {media?.kind === 'crop' && <CropDialog asset={media.asset} onCancel={() => setMedia(null)} onOk={(b) => { const m = media; setMedia(null); void doEdit(m.asset.id, { op: 'crop', ...b }, m.item.id, 'Crop'); }} />}
      {media?.kind === 'trim' && <TrimDialog asset={media.asset} onCancel={() => setMedia(null)} onOk={(st, en) => { const m = media; setMedia(null); void doEdit(m.asset.id, { op: 'trim', start: st, end: en }, m.item.id, 'Trim'); }} />}
      {regen && <RegenerateDialog job={regen.job} profiles={profiles} origin={regen.origin} openDraft={act.openDraft} notify={act.notify} onClose={() => setRegen(null)} />}
      {dialog && <ParamDialog title={dialog.title} fields={dialog.fields} onOk={dialog.ok} onCancel={() => setDialog(null)} />}
    </div>
  );
}

function ViewsMenu() {
  const { board } = useContext(C);
  const rf = useReactFlow();
  return (
    <select title="Saved views" value="" onChange={(e) => {
      const v = e.target.value;
      if (v === '__save') { const name = window.prompt('Name this view'); if (name) { const vp = rf.getViewport(); void api.viewSave(name, vp.x, vp.y, vp.zoom); } }
      else if (v.startsWith('del:')) void api.viewDelete(v.slice(4));
      else { const x = board.views.find((w) => w.id === v); if (x) void rf.setViewport({ x: x.x, y: x.y, zoom: x.zoom }, { duration: 300 }); }
    }}>
      <option value="">Views…</option>
      <option value="__save">＋ Save current view…</option>
      {board.views.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
      {board.views.map((v) => <option key={'d' + v.id} value={'del:' + v.id}>✕ delete “{v.name}”</option>)}
    </select>
  );
}

/** The dotted lineage wires: parent's right edge to child's left edge, from where the nodes are right now. */
function LineageLayer({ nodes, lineage }: { nodes: Node[]; lineage: { from: string; to: string }[] }) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const size = (n: Node) => ({ w: n.measured?.width ?? 180, h: n.measured?.height ?? 130 });
  const paths: string[] = [];
  for (const l of lineage) {
    const a = byId.get(l.from), b = byId.get(l.to); if (!a || !b || a.type === 'group' || b.type === 'group') continue;
    const sa = size(a), x1 = a.position.x + sa.w, y1 = a.position.y + sa.h / 2, x2 = b.position.x, y2 = b.position.y + size(b).h / 2;
    const d = Math.max(30, Math.abs(x2 - x1) / 2);
    paths.push(`M${x1},${y1} C${x1 + d},${y1} ${x2 - d},${y2} ${x2},${y2}`);
  }
  return <svg style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, overflow: 'visible', pointerEvents: 'none' }}><path d={paths.join(' ')} fill="none" stroke="var(--faint)" strokeWidth={1.5} strokeDasharray="5 4" /></svg>;
}

function toNode(it: BoardItem, selected: boolean): Node {
  const base = { id: it.id, type: it.kind, position: { x: it.x, y: it.y }, selected, data: it as unknown as Record<string, unknown> };
  if (it.kind === 'group') return { ...base, style: { width: it.w ?? 520, height: it.h ?? 360 }, zIndex: -1 };
  if (it.kind === 'note') return { ...base, style: { width: it.w ?? 220, height: it.h ?? 120 } };
  return base;
}

function AssetNode({ data, selected }: NodeProps) {
  const it = data as unknown as BoardItem;
  const { assets, usage, takeOf, story } = useContext(C);
  const a = assets.get(it.ref!);
  const used = a ? usage.get(a.id) ?? 0 : 0;
  const tk = a ? takeOf.get(a.id) : undefined;
  const nm = a ? story.meta[a.id]?.name : undefined;
  if (!a) return <div className="nodeAsset"><div className="note" style={{ padding: 10 }}>Missing asset</div><Handle type="source" position={Position.Right} id="out" /></div>;
  return (
    <div className={'nodeAsset' + (a.kind === 'audio' ? ' audio' : '') + (selected ? ' selected' : '')}>
      <Handle type="target" position={Position.Left} id="in" className="lin" isConnectable={false} />
      <button className="nodeMenuBtn nodrag" title="Options (or right-click)" onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('driftboard-node-menu', { detail: { id: it.id, x: e.clientX, y: e.clientY } })); }}>⋯</button>
      <img src={thumbUrl(a.id)} loading="lazy" draggable={false} />
      {a.kind === 'audio' && <div className="kindBadge" title="Sound">♪</div>}
      {(a.kind === 'video' || a.kind === 'audio') && <button className="play nodrag" title="Play in the preview" onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('driftboard-node-select', { detail: it.id })); requestPlay(a.id); }}>▶</button>}
      {tk && <div className={'takeChip ' + (tk.picked ? 'picked' : tk.status)} title={`${tk.shot.name}: ${tk.picked ? 'picked' : tk.status}`}>{tk.picked ? '★' : tk.status === 'approved' ? '✓' : tk.status === 'rejected' ? '✗' : '·'} {tk.shot.name}</div>}
      {used > 0 && <div className="usedBadge" title="Used in the timeline">▤ {used}</div>}
      <div className="cap"><span>{nm ?? (a.width ? `${a.width}×${a.height}` : a.kind)}</span><span>{fmt(a.duration_ms)}{a.has_audio ? ' ♪' : ''}</span></div>
      <Handle type="source" position={Position.Right} id="out" isConnectable={false} />
    </div>
  );
}

function JobNode({ data }: NodeProps) {
  const { jobsById, progress } = useContext(C);
  const j = jobsById.get((data as { jobId: string }).jobId);
  if (!j) return null;
  const f = j.status === 'running' ? progress[j.id] ?? j.progress ?? 0 : 0;
  return (
    <div className={'nodeJob ' + j.status}>
      <div className="note">{j.profile_id}</div>
      <div className={'status ' + j.status}>{j.status === 'running' ? `generating ${Math.round(f * 100)}%` : j.status}</div>
      <div className="bar"><div style={{ width: `${Math.round(f * 100)}%` }} /></div>
      {j.error && <div className="err" style={{ fontSize: 11 }}>{j.error.slice(0, 120)}</div>}
      <Handle type="target" position={Position.Left} id="in" className="lin" isConnectable={false} />
    </div>
  );
}

function NoteNode({ data, selected }: NodeProps) {
  const it = data as unknown as BoardItem;
  const [text, setText] = useState(it.text ?? '');
  useEffect(() => setText(it.text ?? ''), [it.text]);
  return (
    <div className="nodeNote">
      <NodeResizer isVisible={selected} minWidth={120} minHeight={60} onResizeEnd={(_, p) => void api.boardPlace([{ id: it.id, x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.width), h: Math.round(p.height) }])} />
      <textarea className="nodrag nowheel" value={text} placeholder="Note…" onChange={(e) => setText(e.target.value)} onBlur={() => text !== it.text && api.boardUpdate(it.id, { text })} />
    </div>
  );
}

function GroupNode({ data, selected }: NodeProps) {
  const it = data as unknown as BoardItem;
  const [t, setT] = useState(it.text ?? '');
  useEffect(() => setT(it.text ?? ''), [it.text]);
  return (
    <div className="nodeGroup">
      <NodeResizer isVisible={selected} minWidth={200} minHeight={120} onResizeEnd={(_, p) => void api.boardPlace([{ id: it.id, x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.width), h: Math.round(p.height) }])} />
      <input className="nodrag groupTitle" value={t} placeholder="Group name" onChange={(e) => setT(e.target.value)} onBlur={() => t !== it.text && api.boardUpdate(it.id, { text: t })} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); e.stopPropagation(); }} />
    </div>
  );
}
