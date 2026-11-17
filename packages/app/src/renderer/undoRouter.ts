import { combo, hit } from './keys.ts';

/**
 * One place decides what Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y do: only the area under the mouse pointer is undone
 * (the timeline, the project's canvas/story/library, or the Director). Everything else is left alone,
 * so an undo meant for one place can never reach into another.
 */
type Handlers = { undo: () => void; redo: () => void };
const reg = new Map<string, Handlers>();
export const registerUndo = (scope: string, h: Handlers) => { reg.set(scope, h); return () => { if (reg.get(scope) === h) reg.delete(scope); }; };

export function installUndoRouter(notify: (m: string) => void): () => void {
  let x = 0, y = 0;
  const track = (e: PointerEvent | MouseEvent) => { x = e.clientX; y = e.clientY; };
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
