/* Size defaults, in the order a step looks for its size: the shot's own choice, then the model's default, then the media type's default
   (Image / Video), then the project size (the chip in the Story). Saved in this app's storage and shared by every window. */
import { useSyncExternalStore } from 'react';
import type { SizeChoice } from './sizeCalc.ts';

export interface Defaults { image?: SizeChoice; video?: SizeChoice; models: Record<string, SizeChoice> }
const KEY = 'driftboard.defaults.v1', EVT = 'driftboard-defaults';
let cache: Defaults | null = null;

export function loadDefaults(): Defaults {
  if (cache) return cache;
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Defaults> | null; cache = { image: v?.image, video: v?.video, models: v?.models ?? {} }; } catch { cache = { models: {} }; }
  return cache;
}
export function saveDefaults(d: Defaults) {
  cache = d; try { localStorage.setItem(KEY, JSON.stringify(d)); } catch { /* ignore */ }
  window.dispatchEvent(new Event(EVT));
}
export function useDefaults(): Defaults {
  return useSyncExternalStore((f) => { window.addEventListener(EVT, f); return () => window.removeEventListener(EVT, f); }, loadDefaults);
}
/** Which default sets the size of a step made with `profile` (kind 'image' | 'video'), or the project size when none is set. */
export function defaultSize(d: Defaults, profile: { id: string; kind: string } | undefined, project: SizeChoice): { choice: SizeChoice; from: 'model' | 'type' | 'project' } {
  if (profile && d.models[profile.id]) return { choice: d.models[profile.id]!, from: 'model' };
  const t = profile?.kind === 'video' ? d.video : profile?.kind === 'image' ? d.image : undefined;
  return t ? { choice: t, from: 'type' } : { choice: project, from: 'project' };
}
