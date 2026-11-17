/** Generated clips that should land in a gap on the timeline when their job is done (kept across restarts). */
export interface Place { start: number; gap: number; track: number }
const KEY = 'driftboard.pendingPlace';
export const loadPending = (): Record<string, Place> => { try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Place>; } catch { return {}; } };
export const savePending = (p: Record<string, Place>) => { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ } };
export const addPending = (jobId: string, pl: Place) => savePending({ ...loadPending(), [jobId]: pl });
