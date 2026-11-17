import { useEffect, useState } from 'react';

/**
 * The app's look: System (follows Windows, live), Light (default) or Dark. The choice is a UI preference kept in
 * localStorage like the other ones, so no IPC is involved. Electron's renderer reports Windows' light/dark setting
 * through prefers-color-scheme, which changes live when Windows changes.
 */
export type ThemeChoice = 'system' | 'light' | 'dark';
const KEY = 'driftboard.theme';
const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export const loadTheme = (): ThemeChoice => { if (typeof localStorage === 'undefined') return 'light'; try { const v = localStorage.getItem(KEY); return v === 'system' || v === 'dark' || v === 'light' ? v : 'light'; } catch { return 'light'; } };
export const effectiveTheme = (c: ThemeChoice): 'light' | 'dark' => (c === 'system' ? (media?.matches ? 'dark' : 'light') : c);

let current: ThemeChoice = loadTheme();
const apply = () => { if (typeof document !== 'undefined') document.documentElement.dataset.theme = effectiveTheme(current); };
apply();
media?.addEventListener('change', () => { if (current === 'system') { apply(); window.dispatchEvent(new Event('driftboard-theme')); } });

export const getTheme = () => current;
export function setTheme(c: ThemeChoice) {
  current = c; try { localStorage.setItem(KEY, c); } catch { /* storage unavailable: the choice lasts for this session */ }
  apply(); if (typeof window !== 'undefined') window.dispatchEvent(new Event('driftboard-theme'));
}
/** The current choice and the theme it resolves to; re-renders when either changes. */
export function useTheme(): { choice: ThemeChoice; effective: 'light' | 'dark'; set: (c: ThemeChoice) => void } {
  const [, tick] = useState(0);
  useEffect(() => { const f = () => tick((n) => n + 1); window.addEventListener('driftboard-theme', f); return () => window.removeEventListener('driftboard-theme', f); }, []);
  return { choice: current, effective: effectiveTheme(current), set: setTheme };
}
