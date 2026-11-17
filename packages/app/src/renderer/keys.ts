/** Every keyboard shortcut in one table, so Settings can list them and change them. Overrides live in localStorage. */
export interface KeyAction { id: string; label: string; group: string; def: string }
export const KEY_ACTIONS: KeyAction[] = [
  { id: 'canvas.undo', label: 'Undo (canvas, story, library)', group: 'Canvas', def: 'Ctrl+Z' },
  { id: 'canvas.redo', label: 'Redo (canvas, story, library)', group: 'Canvas', def: 'Ctrl+Y' },
  { id: 'timeline.split', label: 'Split clip at the playhead', group: 'Timeline', def: 'S' },
  { id: 'timeline.delete', label: 'Delete selected clips', group: 'Timeline', def: 'Delete' },
  { id: 'timeline.rippleDelete', label: 'Delete and close the gap', group: 'Timeline', def: 'Shift+Delete' },
  { id: 'timeline.grab', label: 'Grab frame at the playhead to the canvas', group: 'Timeline', def: 'G' },
  { id: 'preview.fullscreen', label: 'Preview full screen', group: 'Timeline', def: 'P' },
  { id: 'timeline.play', label: 'Play / pause timeline', group: 'Timeline', def: 'Space' },
  { id: 'timeline.prevFrame', label: 'One frame back', group: 'Timeline', def: 'Left' },
  { id: 'timeline.nextFrame', label: 'One frame forward', group: 'Timeline', def: 'Right' },
  { id: 'timeline.prevSecond', label: 'One second back', group: 'Timeline', def: 'Shift+Left' },
  { id: 'timeline.nextSecond', label: 'One second forward', group: 'Timeline', def: 'Shift+Right' },
  { id: 'timeline.undo', label: 'Undo (timeline)', group: 'Timeline', def: 'Ctrl+Z' },
  { id: 'timeline.redo', label: 'Redo (timeline)', group: 'Timeline', def: 'Ctrl+Y' },
  { id: 'preview.play', label: 'Play / pause the clip preview', group: 'Preview', def: 'Space' },
  { id: 'preview.prevFrame', label: 'Preview: one frame back', group: 'Preview', def: 'Alt+Left' },
  { id: 'preview.nextFrame', label: 'Preview: one frame forward', group: 'Preview', def: 'Alt+Right' },
  { id: 'library.selectAll', label: 'Library: select all', group: 'Library', def: 'Ctrl+A' },
  { id: 'library.delete', label: 'Library: delete selected', group: 'Library', def: 'Delete' },
];
const STORE = 'driftboard.keys';
const load = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(STORE) ?? '{}') as Record<string, string>; } catch { return {}; } };
let over = load();
export const bindOf = (id: string) => over[id] ?? KEY_ACTIONS.find((a) => a.id === id)?.def ?? '';
export const allBinds = () => Object.fromEntries(KEY_ACTIONS.map((a) => [a.id, bindOf(a.id)]));
export function saveBinds(b: Record<string, string>) {
  over = {}; for (const a of KEY_ACTIONS) if (b[a.id] && b[a.id] !== a.def) over[a.id] = b[a.id]!;
  try { localStorage.setItem(STORE, JSON.stringify(over)); } catch { /* ignore */ }
}
export const resetBinds = () => saveBinds({});

const NAMES: Record<string, string> = { ' ': 'Space', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Escape: 'Esc' };
/** "Ctrl+Shift+Z" style text for a key event; null for a bare modifier. */
export function combo(e: KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  const k = NAMES[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  return [e.ctrlKey || e.metaKey ? 'Ctrl' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : '', k].filter(Boolean).join('+');
}
/** Does this key event trigger the action? */
export const hit = (e: KeyboardEvent, id: string) => combo(e) === bindOf(id);
