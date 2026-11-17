/** Saved UI settings from before the rename used the old app-name prefix: copy them once to the new prefix. Imported first, before any module reads localStorage. */
const LEGACY_KEY_PREFIX = 'meldreel.';
const PREFIX = 'driftboard.';
try {
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(LEGACY_KEY_PREFIX)) continue;
    const nk = PREFIX + k.slice(LEGACY_KEY_PREFIX.length);
    if (nk !== k && localStorage.getItem(nk) === null) localStorage.setItem(nk, localStorage.getItem(k)!);
  }
} catch { /* storage unavailable: nothing to migrate */ }
export {};
