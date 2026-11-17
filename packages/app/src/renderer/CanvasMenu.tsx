import { useEffect, useState } from 'react';
import { Button, Dialog, Field as FieldBox, Menu, type MenuItem as UiMenuItem } from './ui/ui.tsx';
import type { IconName } from './ui/Icon.tsx';

/** One entry of a right-click / "⋯" menu: an action, a group header, or a separator. */
export interface MenuItem { label?: string; onClick?: () => void; disabled?: boolean; danger?: boolean; sep?: boolean; hint?: string; title?: string; header?: string; icon?: IconName; recommended?: boolean; sub?: string }

/** A right-click / "⋯" menu at a screen position, in labelled groups. Closes on outside click, Escape, scroll or after an item runs. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  useEffect(() => { window.addEventListener('wheel', onClose, { passive: true }); return () => window.removeEventListener('wheel', onClose); }, [onClose]);
  // drop separators and headers that end up with nothing under them
  const list: UiMenuItem[] = [];
  items.forEach((it, i) => {
    if (it.header !== undefined) { const next = items.slice(i + 1).find((n) => n.header !== undefined || n.sep || n.label); if (next?.label) list.push({ header: it.header }); return; }
    if (it.sep) { if (list.length && !('sep' in list[list.length - 1]!)) list.push({ sep: true }); return; }
    list.push({ label: it.label ?? '', icon: it.icon, hint: it.hint, sub: it.sub, danger: it.danger, disabled: it.disabled, recommended: it.recommended, title: it.title, onClick: () => it.onClick?.() });
  });
  while (list.length && 'sep' in list[list.length - 1]!) list.pop();
  return <Menu x={x} y={y} items={list} onClose={onClose} />;
}

export interface Field { key: string; label: string; type: 'number' | 'text' | 'select'; value?: string | number; options?: { value: string; label: string }[]; placeholder?: string; hint?: string }

/** A small form dialog for operations that need numbers or a name (resize, speed, rename, delete with a typed name). Resolves with the values as strings. */
export function ParamDialog({ title, fields, okLabel = 'Apply', message, danger, onOk, onCancel }: { title: string; fields: Field[]; okLabel?: string; message?: string; danger?: boolean; onOk: (v: Record<string, string>) => void; onCancel: () => void }) {
  const [v, setV] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, f.value === undefined ? '' : String(f.value)])));
  return (
    <Dialog title={title} onClose={onCancel} footer={<><Button onClick={onCancel}>Cancel</Button><Button kind={danger ? 'danger-solid' : 'primary'} onClick={() => onOk(v)}>{okLabel}</Button></>}>
      {message && <div className="msgT">{message}</div>}
      <form className="col" style={{ display: 'flex', flexDirection: 'column', gap: 10 }} onSubmit={(e) => { e.preventDefault(); onOk(v); }}>
        {fields.map((f) => (
          <FieldBox key={f.key} label={f.label}>
            {f.type === 'select'
              ? <select className="selc" value={v[f.key]} onChange={(e) => setV({ ...v, [f.key]: e.target.value })}>{f.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
              : <input className={'inp' + (f.type === 'number' ? ' mono' : '')} type={f.type === 'number' ? 'number' : 'text'} autoFocus={f === fields[0]} value={v[f.key]} placeholder={f.placeholder} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />}
            {f.hint && <span className="xs faint">{f.hint}</span>}
          </FieldBox>
        ))}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------ arranging */
export interface Box { id: string; x: number; y: number; w: number; h: number }
export interface Move { id: string; x: number; y: number }

/** Lay boxes out in a grid, a row or a column, starting at their current top-left corner, in the order given. */
export function arrangeLinear(boxes: Box[], mode: 'grid' | 'row' | 'column', gap = 24): Move[] {
  if (!boxes.length) return [];
  const x0 = Math.min(...boxes.map((b) => b.x)), y0 = Math.min(...boxes.map((b) => b.y));
  const cw = Math.max(...boxes.map((b) => b.w)) + gap, ch = Math.max(...boxes.map((b) => b.h)) + gap;
  const cols = mode === 'row' ? boxes.length : mode === 'column' ? 1 : Math.max(1, Math.ceil(Math.sqrt((boxes.length * ch) / cw * 1.6)));   // roughly a landscape block
  return boxes.map((b, i) => ({ id: b.id, x: Math.round(x0 + (i % cols) * cw), y: Math.round(y0 + Math.floor(i / cols) * ch) }));
}

/**
 * Lay boxes out by where they came from, so every link is readable: columns by generation (left to right), each box vertically
 * level with its parents, siblings stacked, and links that skip a column get an empty lane so they never run behind another box.
 * Separate families are stacked top to bottom and loose boxes go in a row at the bottom.
 * (A small layered layout: layers, crossing reduction by barycentre sweeps, then y positions pulled towards neighbours without overlap.)
 */
export function arrangeLineage(boxes: Box[], edges: { from: string; to: string }[], gap = 70): Move[] {
  if (!boxes.length) return [];
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const es = edges.filter((e) => byId.has(e.from) && byId.has(e.to) && e.from !== e.to);
  const kids = new Map<string, string[]>(), parents = new Map<string, string[]>();
  for (const e of es) { (kids.get(e.from) ?? kids.set(e.from, []).get(e.from)!).push(e.to); (parents.get(e.to) ?? parents.set(e.to, []).get(e.to)!).push(e.from); }
  const connected = (id: string) => !!(kids.get(id)?.length || parents.get(id)?.length);

  // depth = longest path from a root (cycle-safe)
  const depth = new Map<string, number>();
  const visit = (id: string, d: number, path: Set<string>) => {
    if (path.has(id) || (depth.get(id) ?? -1) >= d) return;
    depth.set(id, d); path.add(id);
    for (const k of kids.get(id) ?? []) visit(k, d + 1, path);
    path.delete(id);
  };
  for (const b of boxes) if (connected(b.id) && !parents.get(b.id)?.length) visit(b.id, 0, new Set());
  for (const b of boxes) if (connected(b.id) && !depth.has(b.id)) visit(b.id, 0, new Set());   // members of cycles

  // families = connected components
  const comp = new Map<string, number>(); let nc = 0;
  for (const b of boxes) {
    if (comp.has(b.id) || !connected(b.id)) continue;
    const stack = [b.id]; comp.set(b.id, nc);
    while (stack.length) { const c = stack.pop()!; for (const n of [...(kids.get(c) ?? []), ...(parents.get(c) ?? [])]) if (!comp.has(n)) { comp.set(n, nc); stack.push(n); } }
    nc++;
  }
  const x0 = Math.min(...boxes.map((b) => b.x)), y0 = Math.min(...boxes.map((b) => b.y));
  const cw = Math.max(...boxes.map((b) => b.w)) + gap, vgap = 28;
  const out: Move[] = []; let top = y0;

  for (let c = 0; c < nc; c++) {
    const members = boxes.filter((b) => comp.get(b.id) === c);
    // nodes = real boxes + dummy nodes that reserve a lane for links skipping columns
    interface N { id: string; layer: number; h: number; real: boolean; up: string[]; down: string[]; y: number }
    const nodes = new Map<string, N>();
    for (const m of members) nodes.set(m.id, { id: m.id, layer: depth.get(m.id) ?? 0, h: m.h, real: true, up: [], down: [], y: m.y });
    let dn = 0;
    for (const e of es) {
      const a = nodes.get(e.from), b = nodes.get(e.to); if (!a || !b || b.layer <= a.layer) continue;
      let prev = a;
      for (let l = a.layer + 1; l < b.layer; l++) {
        const d: N = { id: `~${dn++}`, layer: l, h: 60, real: false, up: [], down: [], y: (a.y + b.y) / 2 };
        nodes.set(d.id, d); prev.down.push(d.id); d.up.push(prev.id); prev = d;
      }
      prev.down.push(b.id); b.up.push(prev.id);
    }
    const maxL = Math.max(...[...nodes.values()].map((n) => n.layer));
    const layers: N[][] = Array.from({ length: maxL + 1 }, () => []);
    for (const n of [...nodes.values()].sort((p, q) => p.y - q.y)) layers[n.layer]!.push(n);
    // order inside each layer: depth-first from the roots (in their current top-to-bottom order), so every family branch stays together
    // and a source's derivatives sit next to it instead of between other sources' rows
    const ord = new Map<string, number>(); let oc = 0;
    const dfs = (n: N) => { if (ord.has(n.id)) return; ord.set(n.id, oc++); for (const k of [...n.down].map((id) => nodes.get(id)!).sort((p, q) => p.y - q.y)) dfs(k); };
    for (const n of [...nodes.values()].filter((x) => !x.up.length).sort((p, q) => p.y - q.y)) dfs(n);
    for (const n of nodes.values()) if (!ord.has(n.id)) dfs(n);
    for (const l of layers) l.sort((p, q) => ord.get(p.id)! - ord.get(q.id)!);
    // y positions: stack each layer, then pull every node towards the middle of its neighbours without overlapping, a few passes
    const place = (l: number, want: (n: N) => number | null) => {
      let cursor = -Infinity;
      for (const n of layers[l]!) { const w = want(n); n.y = Math.max(cursor, w ?? n.y); cursor = n.y + n.h + vgap; }
    };
    layers.forEach((_, l) => place(l, () => null));
    for (let l = 0, y = 0; l <= maxL; l++, y = 0) for (const n of layers[l]!) { n.y = y; y += n.h + vgap; }
    const mid = (ids: string[], h: number) => (ids.length ? ids.reduce((s, id) => { const m = nodes.get(id)!; return s + m.y + m.h / 2; }, 0) / ids.length - h / 2 : null);
    const all = (n: N) => mid([...n.up, ...n.down], n.h);
    for (let it = 0; it < 10; it++) {
      for (let l = 1; l <= maxL; l++) place(l, all);
      for (let l = maxL - 1; l >= 0; l--) place(l, all);
    }
    // Finish top-down. A box with one parent sits at its own offset around that parent, so siblings fan out (one above, one below…)
    // and every link leaves the parent in its own direction instead of lying on top of its sibling's link.
    const fan = (n: N) => {
      if (n.up.length === 1) {
        const p = nodes.get(n.up[0]!)!;
        const sibs = p.down.map((id) => nodes.get(id)!).sort((a, b) => layers[a.layer]!.indexOf(a) - layers[b.layer]!.indexOf(b));
        if (sibs.length > 1) return p.y + p.h / 2 + (sibs.indexOf(n) - (sibs.length - 1) / 2) * (130 + vgap) - n.h / 2;
      }
      return mid(n.up, n.h);
    };
    for (let it = 0; it < 2; it++) for (let l = 1; l <= maxL; l++) place(l, fan);
    const minY = Math.min(...[...nodes.values()].map((n) => n.y)), maxY = Math.max(...[...nodes.values()].map((n) => n.y + n.h));
    for (const n of nodes.values()) if (n.real) out.push({ id: n.id, x: Math.round(x0 + n.layer * cw), y: Math.round(top + (n.y - minY)) });
    top += maxY - minY + 56;
  }
  boxes.filter((b) => !comp.has(b.id)).forEach((b, i) => out.push({ id: b.id, x: Math.round(x0 + i * cw), y: Math.round(top) }));
  return out;
}
