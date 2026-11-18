/* The story plan (the Director's state) shared by every stage of the Story workspace: Script, Bible and Board edit it,
   the shot cards in Shots read and mirror it. Changes to the plan reach the story automatically through the existing
   accept path (api.directorAccept), which keeps takes, picks and prompts edited in the story. Both stores stay as they are. */
import { useEffect, useState } from 'react';
import { api } from './shared.tsx';
import type { DirectorState, DirectorTarget } from '../main/api.ts';

type Snap = Pick<DirectorState, 'bible' | 'scenes' | 'shots' | 'prompts' | 'style' | 'accepted' | 'name'>;
let st: DirectorState | null = null;
let targets: DirectorTarget[] = [];
const undoStack: Snap[] = [], redoStack: Snap[] = [];
const EV = 'driftboard-director';
const emit = () => window.dispatchEvent(new Event(EV));
const snap = (s: DirectorState): Snap => structuredClone({ bible: s.bible, scenes: s.scenes, shots: s.shots, prompts: s.prompts, style: s.style, accepted: s.accepted, name: s.name });

/** The plan changed (an edit here, an LLM step): show it, and bring the story up to date shortly after. */
export function setDirector(s: DirectorState) { st = s; emit(); scheduleSync(); }
/** The plan changed in a way the story already has (a shot card edited both): show it, no sync. */
export function setDirectorQuiet(s: DirectorState) { st = s; emit(); }
// the main process changed the plan (a reference picture arrived): show it, and the story gets it too
let unsubMain: (() => void) | null = null;
function listenMain() { if (!unsubMain) unsubMain = api.onDirector((s) => { if (st && s.storyId === st.storyId) setDirector(s); }); }
export async function loadDirector() { listenMain(); const r = await api.directorState(); st = r.state; targets = r.targets; emit(); return r; }
export const directorNow = () => st;
export function resetDirectorHistory() { undoStack.length = 0; redoStack.length = 0; emit(); }
export function useDirector() {
  const [, tick] = useState(0);
  useEffect(() => { const f = () => tick((n) => n + 1); window.addEventListener(EV, f); return () => window.removeEventListener(EV, f); }, []);
  return { st, targets, undoN: undoStack.length, redoN: redoStack.length };
}
/** Every edit of the plan can be undone (the last 40), also removed characters, places and props. */
export async function updDirector(patch: Parameters<typeof api.directorUpdate>[0]) {
  if (st) { undoStack.push(snap(st)); if (undoStack.length > 40) undoStack.shift(); redoStack.length = 0; }
  setDirector(await api.directorUpdate(patch));
}
export async function undoDirector(notify: (m: string) => void) {
  const prev = undoStack.pop(); if (!prev || !st) { emit(); return notify('Nothing to undo in the story plan.'); }
  redoStack.push(snap(st)); setDirector(await api.directorUpdate(prev)); notify('Undone');
}
export async function redoDirector(notify: (m: string) => void) {
  const next = redoStack.pop(); if (!next || !st) { emit(); return notify('Nothing to redo in the story plan.'); }
  undoStack.push(snap(st)); setDirector(await api.directorUpdate(next)); notify('Redone');
}

/* ---------- automatic sync: plan → story ---------- */
let syncFor: string | null = null;   // the story the open plan belongs to; null = do not sync
let timer: ReturnType<typeof setTimeout> | undefined;
let afterSync: (() => Promise<void>) | null = null;
const hasPlan = (s: DirectorState) => !!s.bible || Object.values(s.shots).some((x) => x.shots.length > 0);
/** Turn syncing on for the open story (its plan is the open run), or off. `after` runs after each sync (it removes shots the user deleted). */
export function setSyncTarget(storyId: string | null, after?: () => Promise<void>) { syncFor = storyId; afterSync = after ?? null; if (!storyId) clearTimeout(timer); }
function scheduleSync() {
  if (!syncFor || !st || st.storyId !== syncFor || !hasPlan(st)) return;
  clearTimeout(timer);
  timer = setTimeout(() => void syncNow(), 900);
}
/** Bring the story up to date with the plan now. Takes, picks and prompts edited in the story are kept. */
export async function syncNow() {
  clearTimeout(timer);
  if (!syncFor || !st || st.storyId !== syncFor || !hasPlan(st)) return;
  try { await api.directorAccept(); await afterSync?.(); } catch { /* the story stays as it was; the next change tries again */ }
}

/* ---------- LLM steps of the plan, with one "working" label every stage can show ---------- */
let working = '';
export const workingNow = () => working;
const setWorking = (w: string) => { working = w; emit(); };
const WORK: Record<string, string> = { bible: 'Writing the story bible', scenes: 'Splitting the story into scenes', shots: 'Planning the shots', prompts: 'Writing prompts', interpret: 'Interpreting the script' };
/** Run one step of the plan with the LLM. Resolves with an error text, or '' when it worked. */
export async function runStep(step: 'bible' | 'scenes' | 'shots' | 'prompts', opts?: { only?: string | string[]; force?: boolean }): Promise<string> {
  if (working) return 'The LLM is already working on this story: wait for it, or cancel it.';
  setWorking(WORK[step]!); activityLabel('director-' + step, WORK[step]! + '…');
  try { const r = await api.directorRun(step, opts); if (!r.ok) return r.error; setDirector(r.state); return ''; }
  finally { setWorking(''); activityLabel('director-' + step, null); }
}
export async function interpretScript(text: string): Promise<string> {
  if (working) return 'The LLM is already working on this story: wait for it, or cancel it.';
  setWorking(WORK.interpret!); activityLabel('director-interpret', WORK.interpret! + '…');
  try { const r = await api.directorInterpret(text); if (!r.ok) return r.error; setDirector(r.state); return ''; }
  finally { setWorking(''); activityLabel('director-interpret', null); }
}
const activityLabel = (id: string, label: string | null) => window.dispatchEvent(new CustomEvent('driftboard-activity', { detail: { id, label } }));
