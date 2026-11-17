import { useEffect, useState } from 'react';
import { combo, hit } from './keys.ts';

/**
 * One place decides what Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y do: only the area under the mouse pointer is undone
 * (the timeline, the project's canvas/story/library, or the Director). Everything else is left alone,
 * so an undo meant for one place can never reach into another.
 *
 * The Undo/Redo button in the top bar follows the same rule: it acts on the area the pointer was over last
 * (before it moved up to the top bar) and names it ("Undo · Canvas: Move 2 items").
 */
export interface UndoInfo { canUndo: boolean; canRedo: boolean; undo?: string; redo?: string }
type Handlers = { undo: () => void; redo: () => void; info?: () => UndoInfo };
const reg = new Map<string, Handlers>();
const changed = () => window.dispatchEvent(new Event('driftboard-undo'));
export const registerUndo = (scope: string, h: Handlers) => { reg.set(scope, h); changed(); return () => { if (reg.get(scope) === h) { reg.delete(scope); changed(); } }; };
/** Call when an area's history changed (so the top bar can update its label). */
export const undoChanged = changed;

/** The area the pointer is over (or was over last, while it is on the top bar): its undo scope and its name. */
export interface UndoTarget { scope: string; area: string; el: HTMLElement }
let target: UndoTarget | null = null;
const AREA_NAMES: Record<string, string> = { canvas: 'Canvas', story: 'Story', library: 'Library', timeline: 'Timeline', director: 'Story plan', create: 'Canvas', assistant: 'Canvas', activity: 'Canvas' };
function targetAt(x: number, y: number): UndoTarget | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const u = el?.closest<HTMLElement>('[data-undo]'); if (!u) return null;
  const area = el?.closest<HTMLElement>('[data-area]')?.dataset.area ?? u.dataset.undo!;
  return { scope: u.dataset.undo!, area: AREA_NAMES[area] ?? area, el: u };
}
export const undoTarget = () => target;
export const undoInfo = (t: UndoTarget | null = target): UndoInfo | null => { const h = t ? reg.get(t.scope) : undefined; return h ? (h.info?.() ?? { canUndo: true, canRedo: true }) : null; };
/** Undo or redo in the area the pointer was over last (the top bar button). */
export function undoInLast(redo: boolean, notify: (m: string) => void) {
  const h = target ? reg.get(target.scope) : undefined;
  if (!h) { notify('Undo works on the area under the mouse pointer: point at the canvas, timeline, story or library first, then press Undo.'); return; }
  if (redo) h.redo(); else h.undo();
}
/** Re-renders when the area under the pointer changes or an area's history changes. */
export function useUndoTarget(): UndoTarget | null {
  const [, tick] = useState(0);
  useEffect(() => { const f = () => tick((n) => n + 1); window.addEventListener('driftboard-undo', f); return () => window.removeEventListener('driftboard-undo', f); }, []);
  return target;
}

export function installUndoRouter(notify: (m: string) => void): () => void {
  let x = 0, y = 0;
  const track = (e: PointerEvent | MouseEvent) => {
    x = e.clientX; y = e.clientY;
    if ((e.target as HTMLElement | null)?.closest?.('[data-undo-ignore]')) return;   // over the top bar: keep the area it came from
    const t = targetAt(x, y);
    if (t && (t.scope !== target?.scope || t.area !== target?.area || t.el !== target?.el)) { target = t; changed(); }
  };
  const key = (e: KeyboardEvent) => {
    const c = combo(e);
    const redo = c === 'Ctrl+Shift+Z' || c === 'Ctrl+Y' || hit(e, 'canvas.redo') || hit(e, 'timeline.redo');
    const undo = !redo && (c === 'Ctrl+Z' || hit(e, 'canvas.undo') || hit(e, 'timeline.undo'));
    if (!undo && !redo) return;
    const t = e.target as HTMLElement | null;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;   // typing: the box's own undo
    e.preventDefault(); e.stopImmediatePropagation();
    const scope = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('[data-undo]')?.dataset.undo;
    const h = scope ? reg.get(scope) : undefined;
    if (!h) { notify('Undo works on the area under the mouse pointer: move it over the timeline, canvas, story or director first.'); return; }
    if (redo) h.redo(); else h.undo();
  };
  window.addEventListener('pointermove', track, true); window.addEventListener('pointerdown', track, true); window.addEventListener('keydown', key, true);
  return () => { window.removeEventListener('pointermove', track, true); window.removeEventListener('pointerdown', track, true); window.removeEventListener('keydown', key, true); };
}
