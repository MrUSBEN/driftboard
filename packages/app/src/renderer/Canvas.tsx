import { memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from './theme/theme.ts';
import {
  ReactFlow, Background, BackgroundVariant, MiniMap, Handle, Position, NodeResizer, applyNodeChanges, useReactFlow, useUpdateNodeInternals, ViewportPortal, useViewport,
  type Node, type Edge, type NodeChange, type NodeProps, type OnSelectionChangeParams,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { BoardItem } from '../main/api.ts';
import { askText, confirmUser } from './Ask.tsx';
import { Icon, type IconName } from './ui/Icon.tsx';
import { Button, IconButton, Progress, Menu } from './ui/ui.tsx';
import { useProfileTitle } from './Shell.tsx';
import { EditorCtx, joinForTimeline } from './editorBridge.tsx';
import { openContinuity } from './Continuity.tsx';
import { appendToTimeline, replaceClip, getState as editorState, selectClips, selectSelectedClipIds } from '@driftboard/editor';
import { RegenerateDialog } from './Regenerate.tsx';
import { C, api, requestPlay, type JobView, thumbUrl, type Asset, type Draft, autoAssign, draftFromJob, profilesWithRoles, slotWithRole, sourcePictures } from './shared.tsx';
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

/** The floating panels cover the left and right of the canvas: Fit and focus keep the free part in view. Set by App. */
const insets = { left: 0, right: 0 };
export const setCanvasInsets = (left: number, right: number) => { insets.left = left; insets.right = right; window.dispatchEvent(new Event('driftboard-insets')); };
/** Width of the canvas not covered by the floating panels; follows window resizes and panel changes. */
function useFreeWidth() {
  const calc = () => (document.querySelector('.cvLayer')?.clientWidth ?? window.innerWidth) - insets.left - insets.right;
  const [w, setW] = useState(calc);
  useEffect(() => { const f = () => setW(calc()); f(); window.addEventListener('resize', f); window.addEventListener('driftboard-insets', f); return () => { window.removeEventListener('resize', f); window.removeEventListener('driftboard-insets', f); }; }, []);
  return w;
}
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
  // all lineage wires, or only those of the selection (default: less clutter); remembered
  const [lineageOn, setLineageOnS] = useState(() => { try { return localStorage.getItem('driftboard.lineage') === 'all'; } catch { return false; } });
  const setLineageOn = (v: boolean) => { setLineageOnS(v); try { localStorage.setItem('driftboard.lineage', v ? 'all' : 'sel'); } catch { /* ignore */ } };
  const order = useRef<string[]>([]);

  // other panels can ask the canvas to show everything (after Arrange)
  useEffect(() => { const f = () => { setTimeout(() => void rf.fitView({ duration: 400, padding: fitPad(0.1) }), 150); }; window.addEventListener('driftboard-fit', f); return () => window.removeEventListener('driftboard-fit', f); }, [rf]);

  // jump to an asset (from the Story or Library tab): select its node and bring it into view
  // a focus waits for its node when the asset was only just put on the canvas (Show on canvas in Activity), then runs once
  const focusDone = useRef(0);
  useEffect(() => {
    if (!focus || focusDone.current === focus.n) return;
    const it = board.items.find((i) => i.kind === 'asset' && i.ref === focus.assetId);
    if (!it) return;   // browsing the Library never adds to the canvas: drag it in on purpose
    focusDone.current = focus.n;
    // a node put on the canvas a moment ago may not be drawn yet: wait for it (up to 3 s)
    let tries = 0;
    const go = () => {
      if (!rf.getNode(it.id) && tries++ < 30) { setTimeout(go, 100); return; }
      setNodes((cur) => cur.map((n) => ({ ...n, selected: n.id === it.id })));
      void rf.fitView({ nodes: [{ id: it.id }], duration: 300, maxZoom: 1, padding: fitPad(0.6) });
    };
    go();
  }, [focus?.n, board.items]);

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
      if (!wrap.current?.matches(':hover') || document.querySelector('.modalBack, .dscrim, .dmenu')) return;
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
    // the pictures the clip(s) were made from come along, so characters, clothing and place stay; then the held clip's own still
    if (refSlot) { const pics = [...sourcePictures(bridge && b ? [a.asset.id, b.asset.id] : [a.asset.id], jobs, assets), ...(g.keystone ? [g.keystone] : [])]; const max = (refSlot as { max?: number }).max ?? 9; if (pics.length) inputs[refSlot.id] = [...new Set(pics)].slice(0, max); }
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
  const fitAll = () => void rf.fitView({ duration: 300, padding: fitPad(0.1) });
  const arrangeByScene = async () => { const r = await api.boardArrange(); act.notify(`Arranged ${r.scenes} scene${r.scenes === 1 ? '' : 's'}, moved ${r.moved} item${r.moved === 1 ? '' : 's'}`); if (r.moved) setTimeout(fitAll, 200); };
  const arrangeItems: MenuItem[] = [
    { label: 'Arrange as grid', icon: 'arrange', onClick: () => void arrangeSel('grid'), disabled: sel.length < 2, title: sel.length < 2 ? 'Select two or more items first' : undefined },
    { label: 'Arrange in a row', icon: 'arrange', onClick: () => void arrangeSel('row'), disabled: sel.length < 2, title: sel.length < 2 ? 'Select two or more items first' : undefined },
    { label: 'Arrange in a column', icon: 'arrange', onClick: () => void arrangeSel('column'), disabled: sel.length < 2, title: sel.length < 2 ? 'Select two or more items first' : undefined },
    { label: sel.length >= 2 ? 'Arrange selected by lineage' : 'Arrange all by lineage', icon: 'lineage', onClick: () => void arrangeByLineage(), sub: 'Left to right in the order things were made from each other' },
    { label: 'Arrange canvas by scene', icon: 'scene', onClick: () => void arrangeByScene(), sub: 'Lays the canvas out by scene and shot; groups you made stay' },
  ];
  const replaceTl = () => { const ids = tlSel().map((c) => c.id); void joinForTimeline(act.editor!, [one!.asset.id]).then(([jid]) => { for (const id of ids) replaceClip(act.editor!, id, jid!, true); act.notify('Replaced on the timeline; the old clip stays on the canvas'); }); };
  const regenJob = one ? jobOf(one.asset.id) : undefined;
  const swap = () => void api.boardPlace([{ id: sel[0]!.id, x: sel[1]!.x, y: sel[1]!.y }, { id: sel[1]!.id, x: sel[0]!.x, y: sel[0]!.y }]);
  const removeSel = () => void api.boardRemove(sel.map((i) => i.id));
  const nodeItems: MenuItem[] = [
    ...(selAssets.length ? [{ header: 'Create' }, { label: `Generate ${selAssets.length > 1 ? `from ${selAssets.length}` : 'from this'}…`, icon: 'create' as IconName, onClick: generic },
      ...(regenJob ? [{ label: 'Regenerate…', icon: 'regen' as IconName, sub: 'Same settings, new seeds; or change settings', onClick: () => setRegen({ job: regenJob, origin: one!.item.id }) }] : [])] : []),
    ...(videos.length === 1 && selAssets.length === 1 ? [{ header: 'Chain' },
      ...(heldProfile ? [{ label: 'Continue with held frames', icon: 'cont' as IconName, recommended: true, sub: 'Last 22 frames anchor the start: motion, light and place carry over', title: 'The last 22 frames of this clip, matched to the look of the first picture of the chain, anchor the start of the new clip. The new clip repeats them; the timeline gets a copy with them trimmed.', onClick: () => void heldDraft(false) }] : []),
      { label: 'Continue from last frame only', icon: 'cont' as IconName, onClick: doContinue }, { label: 'Branch at the viewer frame', icon: 'branch' as IconName, onClick: doBranch }] : []),
    ...(videos.length === 2 && selAssets.length === 2 ? [{ header: 'Chain' },
      ...(heldProfile ? [{ label: 'Bridge with held frames', icon: 'bridge' as IconName, recommended: true, sub: 'The end of the first and the start of the second anchor the new clip', onClick: () => void heldDraft(true) }] : []),
      { label: 'Bridge with first/last frame only', icon: 'bridge' as IconName, onClick: doBridge }] : []),
    ...(selAssets.some((x) => x.asset.kind !== 'audio') ? [{ header: 'Timeline' }, { label: 'Add to timeline', icon: 'film' as IconName, onClick: addToTimeline },
      ...(one && one.asset.kind !== 'audio' && tlSel().length ? [{ label: 'Replace the selected timeline clip with this', icon: 'restore' as IconName, title: 'The clip selected on the timeline is swapped for this one (same spot, its audio too). The old one stays on the canvas and in the Library.', onClick: replaceTl }] : [])] : []),
    ...(one && one.asset.kind !== 'audio' ? [{ header: 'Edit media' }, ...(one.asset.kind === 'video' ? [{ label: 'Trim…', icon: 'trim' as IconName, onClick: () => askTrim(one) }] : []),
      { label: 'Crop…', icon: 'crop' as IconName, onClick: () => askCrop(one) }, { label: 'Resize…', icon: 'resize' as IconName, onClick: () => askResize(one) },
      { label: 'Upscale ×2', icon: 'upscale' as IconName, sub: 'Lanczos resample, not AI', onClick: () => void doEdit(one.asset.id, { op: 'upscale', factor: 2 }, one.item.id, 'Upscale') }] : []),
    ...(videos.length >= 1 && videos.length === selAssets.length ? [{ header: 'Check' }, { label: 'Check continuity…', icon: 'chart' as IconName, sub: 'Brightness, colour, exposure and sound at every join', title: 'Clips in the order selected', onClick: doContinuity }] : []),
    { header: 'Arrange' },
    ...(sel.length > 1 ? [{ label: 'Group selection', icon: 'group' as IconName, onClick: () => void addGroup() }] : []),
    ...(sel.length === 2 ? [{ label: 'Swap places', icon: 'arrange' as IconName, title: 'The two selected items trade places on the canvas (nothing is removed)', onClick: swap }] : []),
    ...arrangeItems,
    { sep: true },
    { label: `Delete${sel.length > 1 ? ` ${sel.length}` : ''}`, icon: 'trash', danger: true, hint: 'Del', sub: 'From the canvas; the file stays in the Library', title: 'Ctrl+Z undoes.', onClick: removeSel },
  ];
  const paneItems: MenuItem[] = [
    { header: 'Add' },
    { label: 'Add note', icon: 'note', onClick: () => api.boardAddNote(center().x, center().y) },
    { label: 'Add group', icon: 'group', onClick: () => void addGroup() },
    { label: 'Import files…', icon: 'import', onClick: () => void importHere() },
    { header: 'Arrange' }, ...arrangeItems,
    { header: 'View' },
    { label: 'Fit all in view', icon: 'fit', onClick: fitAll },
  ];
  // actions asked for from outside the canvas (the Inspector): they act on the current selection
  const acts: Record<string, () => void> = {
    continueBest: () => (heldProfile ? void heldDraft(false) : doContinue()),
    generate: generic, regenerate: () => { if (regenJob && one) setRegen({ job: regenJob, origin: one.item.id }); }, continueHeld: () => void heldDraft(false), continue: doContinue,
    branch: doBranch, bridgeHeld: () => void heldDraft(true), bridge: doBridge, addToTimeline, trim: () => one && askTrim(one), crop: () => one && askCrop(one), resize: () => one && askResize(one),
    upscale: () => one && void doEdit(one.asset.id, { op: 'upscale', factor: 2 }, one.item.id, 'Upscale'), continuity: doContinuity,
    fitAll, arrangeLineage: () => void arrangeByLineage(),
  };
  const actsRef = useRef(acts); actsRef.current = acts;
  useEffect(() => { const f = (e: Event) => actsRef.current[(e as CustomEvent<string>).detail]?.(); window.addEventListener('driftboard-canvas-act', f); return () => window.removeEventListener('driftboard-canvas-act', f); }, []);
  // what the selection bar offers: the 4–5 actions that fit the selection
  const barActions: { icon: IconName; label: string; run: () => void; title?: string }[] = one?.asset.kind === 'video'
    ? [...(heldProfile ? [{ icon: 'cont' as IconName, label: 'Continue', run: () => void heldDraft(false), title: 'Continue with held frames' }] : [{ icon: 'cont' as IconName, label: 'Continue', run: doContinue }]), ...(regenJob ? [{ icon: 'regen' as IconName, label: 'Regenerate…', run: acts.regenerate! }] : []), { icon: 'film', label: 'Add to timeline', run: addToTimeline }, { icon: 'trim', label: 'Trim…', run: () => askTrim(one) }]
    : one?.asset.kind === 'image' ? [{ icon: 'create', label: 'Generate from this…', run: generic }, ...(regenJob ? [{ icon: 'regen' as IconName, label: 'Regenerate…', run: acts.regenerate! }] : []), { icon: 'crop', label: 'Crop…', run: () => askCrop(one) }, { icon: 'upscale', label: 'Upscale ×2', run: acts.upscale! }]
    : one?.asset.kind === 'audio' ? [{ icon: 'play', label: 'Play', run: () => requestPlay(one.asset.id) }]
    : videos.length === 2 && selAssets.length === 2 ? [{ icon: 'bridge', label: 'Bridge', run: () => (heldProfile ? void heldDraft(true) : doBridge()), title: heldProfile ? 'Bridge with held frames' : 'Bridge with first/last frame' }, { icon: 'chart', label: 'Check continuity…', run: doContinuity }, { icon: 'film', label: 'Add to timeline', run: addToTimeline }, { icon: 'arrange', label: 'Swap places', run: swap }]
    : selAssets.length > 1 ? [{ icon: 'create', label: `Generate from ${selAssets.length}…`, run: generic }, ...(selAssets.some((x) => x.asset.kind !== 'audio') ? [{ icon: 'film' as IconName, label: 'Add to timeline', run: addToTimeline }] : []), { icon: 'group', label: 'Group', run: () => void addGroup() }]
    : [];

  const selIds = useMemo(() => new Set(selected), [selected]);
  return (
    <div ref={wrap} style={{ height: '100%', position: 'relative' }} onDragOver={(e) => e.preventDefault()} onDrop={onDrop} onContextMenu={(e) => e.preventDefault()}>
      <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onNodeDragStart={onDragStart} onNodeDrag={onDrag} onNodeDragStop={persist} elevateNodesOnSelect={false} onSelectionChange={onSelection}
        onNodeContextMenu={onNodeContextMenu} onPaneContextMenu={onPaneContextMenu} onSelectionContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, where: 'node' }); }}
        nodesConnectable={false} onlyRenderVisibleElements minZoom={0.1} maxZoom={2} fitView fitViewOptions={{ padding: fitPad(0.1) }} colorMode={theme} proOptions={{ hideAttribution: true }}
        deleteKeyCode={null} panOnDrag={[0, 1]} selectionKeyCode="Shift" panOnScroll={false} multiSelectionKeyCode={["Shift", "Control", "Meta"]}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.6} color="var(--dot)" />
        {<ViewportPortal><LineageLayer nodes={nodes} lineage={board.lineage} sel={selIds} all={lineageOn} /></ViewportPortal>}
        {mapOpen && <MiniMap pannable zoomable position="bottom-right" className="dbMap" maskColor="color-mix(in srgb, var(--text) 10%, transparent)" nodeColor="var(--s4)" />}
        {sel.length > 0 && !menu && <SelectionBar nodes={nodes} selected={selected} count={sel.length} actions={barActions} onMore={(x, y) => setMenu({ x, y, where: 'node' })} onDelete={removeSel} />}
      </ReactFlow>
      {!board.items.length && <div className="cvEmpty"><div className="box"><Icon name="import" size="l" /><b>Your board is empty</b>Drop pictures, clips or sound here, start a generation in Create, or plan a film in Story. Everything you make lands here.
        <div className="row" style={{ justifyContent: 'center', marginTop: 14, flexWrap: 'wrap' }}><Button kind="primary" icon="import" onClick={() => void importHere()}>Import files</Button></div></div></div>}
      <Dock busy={busy} lineageOn={lineageOn} setLineageOn={setLineageOn} mapOpen={mapOpen} toggleMap={toggleMap} addNote={() => void api.boardAddNote(center().x, center().y)} addGroup={() => void addGroup()} importHere={() => void importHere()} arrangeItems={arrangeItems} fitAll={fitAll} />
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.where === 'node' && sel.length ? nodeItems : paneItems} onClose={() => setMenu(null)} />}
      {media?.kind === 'crop' && <CropDialog asset={media.asset} onCancel={() => setMedia(null)} onOk={(b) => { const m = media; setMedia(null); void doEdit(m.asset.id, { op: 'crop', ...b }, m.item.id, 'Crop'); }} />}
      {media?.kind === 'trim' && <TrimDialog asset={media.asset} onCancel={() => setMedia(null)} onOk={(st, en) => { const m = media; setMedia(null); void doEdit(m.asset.id, { op: 'trim', start: st, end: en }, m.item.id, 'Trim'); }} />}
      {regen && <RegenerateDialog job={regen.job} profiles={profiles} origin={regen.origin} openDraft={act.openDraft} notify={act.notify} onClose={() => setRegen(null)} />}
      {dialog && <ParamDialog title={dialog.title} fields={dialog.fields} onOk={dialog.ok} onCancel={() => setDialog(null)} />}
    </div>
  );
}

/** The floating dock at the bottom of the canvas: add, arrange, lineage, saved views, zoom, fit, map. */
function Dock({ busy, lineageOn, setLineageOn, mapOpen, toggleMap, addNote, addGroup, importHere, arrangeItems, fitAll }: { busy: string; lineageOn: boolean; setLineageOn: (v: boolean) => void; mapOpen: boolean; toggleMap: () => void; addNote: () => void; addGroup: () => void; importHere: () => void; arrangeItems: MenuItem[]; fitAll: () => void }) {
  const rf = useReactFlow();
  const { zoom } = useViewport();
  const { board } = useContext(C);
  const [pop, setPop] = useState<{ kind: 'arrange' | 'views'; x: number; y: number } | null>(null);
  const open = (kind: 'arrange' | 'views') => (e: React.MouseEvent<HTMLButtonElement>) => { const r = e.currentTarget.getBoundingClientRect(); setPop({ kind, x: r.left, y: r.top - 8 - (kind === 'views' ? 60 + board.views.length * 34 : 210) }); };
  const saveView = async () => { const name = await askText('Save this view', 'Name', { placeholder: 'e.g. Opening scene', ok: 'Save view' }); if (name) { const vp = rf.getViewport(); await api.viewSave(name, vp.x, vp.y, vp.zoom); } };
  const viewItems: MenuItem[] = [
    ...(board.views.length ? [{ header: 'Saved views' }, ...board.views.map((v) => ({ label: v.name, icon: 'views' as IconName, onClick: () => void rf.setViewport({ x: v.x, y: v.y, zoom: v.zoom }, { duration: 300 }) }))] : []),
    { label: 'Save current view…', icon: 'plus', onClick: () => void saveView() },
    ...(board.views.length ? [{ header: 'Delete' }, ...board.views.map((v) => ({ label: `Delete “${v.name}”`, icon: 'trash' as IconName, danger: true, onClick: async () => { if (await confirmUser(`Delete the view “${v.name}”?`, 'Only the saved position goes; nothing on the canvas changes.', 'Delete view', true)) void api.viewDelete(v.id); } }))] : []),
  ];
  // a narrow free area: icons only, each keeps its name as tooltip and label
  const compact = useFreeWidth() < 760;
  const B = ({ icon, label, title, ...rest }: { icon: IconName; label: string; title?: string; on?: boolean; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; menu?: boolean }) => compact
    ? <IconButton size="sm" icon={icon} label={title ? `${label}: ${title}` : label} on={rest.on} aria-haspopup={rest.menu ? 'menu' : undefined} onClick={rest.onClick} />
    : <Button size="sm" icon={icon} iconRight={rest.menu ? 'chev' : undefined} title={title} on={rest.on} aria-haspopup={rest.menu ? 'menu' : undefined} onClick={rest.onClick}>{label}</Button>;
  return (
    <div className={'dock' + (compact ? ' compact' : '')} role="toolbar" aria-label="Canvas">
      {B({ icon: 'note', label: 'Note', title: 'Add a note', onClick: addNote })}
      {B({ icon: 'group', label: 'Group', title: 'New group; with items selected it wraps them', onClick: addGroup })}
      {B({ icon: 'import', label: 'Import', title: 'Import pictures, clips or sound', onClick: importHere })}
      <span className="vsep" />
      {B({ icon: 'arrange', label: 'Arrange', menu: true, onClick: open('arrange') })}
      {B({ icon: 'lineage', label: 'Lineage', title: 'Show every wire of what was made from what (off: only the wires of the selection)', on: lineageOn, onClick: () => setLineageOn(!lineageOn) })}
      {B({ icon: 'views', label: 'Views', title: 'Saved views', menu: true, onClick: open('views') })}
      <span className="vsep" />
      <IconButton size="sm" icon="minus" label="Zoom out (Ctrl+wheel)" onClick={() => void rf.zoomOut({ duration: 150 })} />
      <span className="zoom mono" aria-live="polite">{Math.round(zoom * 100)}%</span>
      <IconButton size="sm" icon="plus" label="Zoom in" onClick={() => void rf.zoomIn({ duration: 150 })} />
      <IconButton size="sm" icon="fit" label="Fit all in view" onClick={fitAll} />
      <IconButton size="sm" icon="map" label={mapOpen ? 'Hide the overview map' : 'Show the overview map'} on={mapOpen} onClick={toggleMap} />
      {busy && <span className="dockBusy"><span className="spin" />{busy}…</span>}
      {pop && <ContextMenu x={pop.x} y={Math.max(60, pop.y)} items={pop.kind === 'arrange' ? arrangeItems : viewItems} onClose={() => setPop(null)} />}
    </div>
  );
}

/** Floats above the selection with the actions that fit it, plus every other action (⋯) and delete. */
function SelectionBar({ nodes, selected, count, actions, onMore, onDelete }: { nodes: Node[]; selected: string[]; count: number; actions: { icon: IconName; label: string; run: () => void; title?: string }[]; onMore: (x: number, y: number) => void; onDelete: () => void }) {
  const { x, y, zoom } = useViewport();
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => { const el = ref.current; if (el && el.offsetWidth !== w) setW(el.offsetWidth); });
  const chosen = nodes.filter((n) => selected.includes(n.id));
  if (!chosen.length) return null;
  const minX = Math.min(...chosen.map((n) => n.position.x)), minY = Math.min(...chosen.map((n) => n.position.y));
  const room = (ref.current?.closest('.cvLayer')?.clientWidth ?? window.innerWidth) - insets.right - 8;
  const compact = room - insets.left - 8 < 470;   // a narrow free area: icons only (each keeps its name as a tooltip)
  const left = Math.max(insets.left + 8, Math.min(minX * zoom + x, room - w)), top = Math.max(8, minY * zoom + y - 48);
  return (
    <div ref={ref} className="selbar nodrag nopan" style={{ left, top }} role="toolbar" aria-label="Selection">
      <span className="cnt">{count}{compact ? '' : ' selected'}</span>
      {actions.map((a) => compact ? <IconButton key={a.label} size="sm" icon={a.icon} label={a.title ?? a.label} onClick={a.run} /> : <Button key={a.label} size="sm" kind="quiet" icon={a.icon} title={a.title} onClick={a.run}>{a.label}</Button>)}
      <IconButton size="sm" icon="more" label="All actions (or right-click)" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); onMore(r.left, r.bottom + 4); }} />
      <IconButton size="sm" icon="trash" kind="danger" label="Delete from the canvas (Del); the files stay in the Library" onClick={onDelete} />
    </div>
  );
}

/** The dotted lineage wires: parent's right edge to child's left edge, from where the nodes are right now. */
/* They run under the nodes (never across a picture); with Lineage off only the wires of the selection show. */
function LineageLayer({ nodes, lineage, sel, all }: { nodes: Node[]; lineage: { from: string; to: string }[]; sel: Set<string>; all: boolean }) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const size = (n: Node) => ({ w: n.measured?.width ?? 180, h: n.measured?.height ?? 130 });
  const paths: string[] = [], hi: string[] = [];
  for (const l of lineage) {
    const a = byId.get(l.from), b = byId.get(l.to); if (!a || !b || a.type === 'group' || b.type === 'group') continue;
    const sa = size(a), x1 = a.position.x + sa.w, y1 = a.position.y + sa.h / 2, x2 = b.position.x, y2 = b.position.y + size(b).h / 2;
    const d = Math.max(30, Math.abs(x2 - x1) / 2);
    const mine = sel.has(l.from) || sel.has(l.to); if (!mine && !all) continue;
    (mine ? hi : paths).push(`M${x1},${y1} C${x1 + d},${y1} ${x2 - d},${y2} ${x2},${y2}`);
  }
  return <svg className="lineage" style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, overflow: 'visible', pointerEvents: 'none', zIndex: -1 }}>
    <path d={paths.join(' ')} fill="none" stroke="var(--faint)" strokeWidth={1.25} strokeDasharray="3 5" opacity={sel.size ? 0.3 : 0.55} />
    {hi.length > 0 && <path d={hi.join(' ')} fill="none" stroke="var(--select)" strokeWidth={2} />}
  </svg>;
}

function toNode(it: BoardItem, selected: boolean): Node {
  const base = { id: it.id, type: it.kind, position: { x: it.x, y: it.y }, selected, data: it as unknown as Record<string, unknown> };
  if (it.kind === 'group') return { ...base, style: { width: it.w ?? 520, height: it.h ?? 360 }, zIndex: -1 };
  if (it.kind === 'note') return { ...base, style: { width: it.w ?? 220, height: it.h ?? 120 } };
  return base;
}

const secs = (ms: number | null) => (ms ? `${(ms / 1000).toFixed(1)} s` : '');
const KIND_IC: Record<string, IconName> = { video: 'video', audio: 'sound', image: 'image' };
/** The display name of an asset: the name given to it, else its file name, else its kind. */
export const assetName = (a: Asset, meta?: Record<string, { name?: string }>, shot?: string) => meta?.[a.id]?.name ?? a.original_name?.replace(/\.[^.]+$/, '') ?? (shot ? `${shot} (take)` : a.kind === 'video' ? 'Clip' : a.kind === 'audio' ? 'Sound' : 'Picture');

function AssetNode({ data, selected }: NodeProps) {
  const it = data as unknown as BoardItem;
  const { assets, usage, takeOf, story } = useContext(C);
  const a = assets.get(it.ref!);
  const used = a ? usage.get(a.id) ?? 0 : 0;
  const tk = a ? takeOf.get(a.id) : undefined;
  if (!a) return <div className="dnode"><div className="cap"><b>Missing file</b></div><Handle type="source" position={Position.Right} id="out" /></div>;
  const status = tk ? (tk.picked ? 'pick' : tk.status) : null;
  return (
    <div className={'dnode' + (a.kind === 'audio' ? ' audio' : '') + (selected ? ' sel' : '')}>
      <Handle type="target" position={Position.Left} id="in" className="lin" isConnectable={false} />
      <div className="th">
        <img src={thumbUrl(a.id)} loading="lazy" draggable={false} alt="" />
        <span className="kind"><Icon name={KIND_IC[a.kind] ?? 'image'} size={12} />{a.kind === 'image' ? 'Picture' : secs(a.duration_ms)}</span>
        <button type="button" className="more nodrag" title="Options (or right-click)" aria-label="Options" onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('driftboard-node-menu', { detail: { id: it.id, x: e.clientX, y: e.clientY } })); }}><Icon name="more" size={14} /></button>
        {(a.kind === 'video' || a.kind === 'audio') && <button type="button" className="playb nodrag" title="Play in the viewer" aria-label="Play in the viewer" onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('driftboard-node-select', { detail: it.id })); requestPlay(a.id); }}><Icon name="play" /></button>}
        {tk && <span className={'take ' + (status === 'pick' ? '' : status === 'approved' ? 'ok' : status === 'rejected' ? 'no' : 'dr')} title={`Take of shot “${tk.shot.name}”: ${status === 'pick' ? 'Pick' : status === 'approved' ? 'Approved' : status === 'rejected' ? 'Rejected' : 'Draft'}`}>
          {status === 'pick' ? <Icon name="starf" size={11} /> : status === 'approved' ? <Icon name="check" size={11} /> : status === 'rejected' ? <Icon name="x" size={11} /> : null}<span className="tn">{tk.shot.name}</span></span>}
        {used > 0 && <span className="used" title={`Used on the timeline ${used}×`}><Icon name="film" size={11} />{used}</span>}
      </div>
      <div className="cap"><b>{assetName(a, story.meta, tk?.shot.name)}</b><span className="m">{a.width ? `${a.width}×${a.height}` : ''}{a.has_audio && a.kind === 'video' ? <Icon name="sound" size={11} /> : null}</span></div>
      <Handle type="source" position={Position.Right} id="out" isConnectable={false} />
    </div>
  );
}

function JobNode({ data }: NodeProps) {
  const { jobsById, progress } = useContext(C);
  const title = useProfileTitle();
  const j = jobsById.get((data as { jobId: string }).jobId);
  if (!j) return null;
  const f = j.status === 'running' ? progress[j.id] ?? j.progress ?? 0 : 0;
  let p: Record<string, unknown> = {}; try { p = JSON.parse(j.params); } catch { /* none */ }
  const size = p.custom_width ? `${p.custom_width}×${p.custom_height}` : '';
  return (
    <div className={'dnode job' + (j.status === 'queued' ? ' queued' : '')}>
      <div className="th">
        {j.status === 'running' ? <><span className="pct mono">{Math.round(f * 100)}%</span><Progress value={f} label="Progress" style={{ width: '70%' }} /><span className="xs dim">Running</span></> : <><span className="small dim">Queued</span><Progress value={0} label="Queued" style={{ width: '60%' }} /></>}
        <button type="button" className="more nodrag" style={{ opacity: 1 }} title="Cancel this generation" aria-label="Cancel this generation" onClick={(e) => { e.stopPropagation(); void api.cancel(j.id); }}><Icon name="x" size={14} /></button>
      </div>
      <div className="cap"><b title={j.profile_id ?? undefined}>{title(j.profile_id)}</b><span className="m">{size}</span></div>
      <Handle type="target" position={Position.Left} id="in" className="lin" isConnectable={false} />
    </div>
  );
}

function NoteNode({ data, selected }: NodeProps) {
  const it = data as unknown as BoardItem;
  const [text, setText] = useState(it.text ?? '');
  useEffect(() => setText(it.text ?? ''), [it.text]);
  return (
    <div className={'nodeNote' + (selected ? ' sel' : '')}>
      <NodeResizer isVisible={selected} minWidth={120} minHeight={60} onResizeEnd={(_, p) => void api.boardPlace([{ id: it.id, x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.width), h: Math.round(p.height) }])} />
      <div className="nh"><Icon name="note" size={12} />Note</div>
      <textarea className="nodrag nowheel" aria-label="Note" value={text} placeholder="Write a note…" onChange={(e) => setText(e.target.value)} onBlur={() => text !== it.text && api.boardUpdate(it.id, { text })} />
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
