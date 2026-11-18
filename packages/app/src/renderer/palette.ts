/* Matching for the command palette (Ctrl+K). Pure functions, no DOM, so they can be tested on their own. */

export interface PaletteEntry { id: string; group: string; label: string; keywords?: string; icon?: string; hint?: string; run: () => void }

/** The groups in the order the palette shows them. */
export const GROUP_ORDER = ['Actions', 'Stories', 'Shots', 'Files', 'Settings', 'App'];

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

/** How well one word of the query fits a text: 0 = not at all. Whole word start > inside a word > (labels only) letters in order. */
function wordScore(w: string, text: string, loose: boolean): number {
  const at = text.indexOf(w);
  if (at === 0) return 100;
  if (at > 0) return /[^a-z0-9]/.test(text[at - 1]!) ? 80 : 50;
  // letters in order (e.g. "rnal" for "run all"): 3 letters and more, starting at a word start, at most 2 jumps, so it stays a typo helper
  if (!loose || w.length < 3) return 0;
  for (let s = 0; s < text.length; s++) {
    if (text[s] !== w[0] || (s > 0 && /[a-z0-9]/.test(text[s - 1]!))) continue;
    let i = 1, gaps = 0, last = s;
    for (let k = s + 1; k < text.length && i < w.length && gaps <= 2; k++) if (text[k] === w[i]) { if (k > last + 1) gaps++; last = k; i++; }
    if (i === w.length && gaps <= 2) return 30 - gaps * 5;
  }
  return 0;
}

/** Score of an entry for a query: every word of the query must fit the label or the keywords (or the group). 0 = hide it. */
export function matchScore(query: string, e: Pick<PaletteEntry, 'label' | 'keywords' | 'group'>): number {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const label = norm(e.label), extra = norm(`${e.keywords ?? ''} ${e.group}`);
  let total = 0;
  for (const w of words) {
    const s = Math.max(wordScore(w, label, true), wordScore(w, extra, false) * 0.6);
    if (!s) return 0;
    total += s;
  }
  // the whole query at the start of the label wins, shorter labels win ties
  if (label.startsWith(norm(query).trim())) total += 60;
  return total - label.length * 0.05;
}

/** The entries that fit the query, grouped (in GROUP_ORDER, or with a query the group with the best hit first), best first within each group; each group capped at `perGroup`. */
export function rankEntries<T extends PaletteEntry>(entries: T[], query: string, perGroup = 8): { group: string; items: T[] }[] {
  const q = query.trim();
  const scored = entries.map((e, i) => ({ e, i, s: matchScore(q, e) })).filter((x) => x.s > 0);
  const groups = new Map<string, { e: T; i: number; s: number }[]>();
  for (const x of scored) { const g = groups.get(x.e.group) ?? []; g.push(x); groups.set(x.e.group, g); }
  const order = [...GROUP_ORDER, ...[...groups.keys()].filter((g) => !GROUP_ORDER.includes(g))].filter((g) => groups.has(g));
  const best = (g: string) => Math.max(...groups.get(g)!.map((x) => x.s));
  if (q) order.sort((a, b) => best(b) - best(a) || order.indexOf(a) - order.indexOf(b));
  return order.map((g) => {
    const list = groups.get(g)!;
    // with no query keep the given order; with one, best match first
    if (q) list.sort((a, b) => b.s - a.s || a.i - b.i);
    return { group: g, items: list.slice(0, q ? perGroup : Math.min(perGroup, 6)).map((x) => x.e) };
  });
}
