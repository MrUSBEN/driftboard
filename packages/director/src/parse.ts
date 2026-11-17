import type { ParsedScene, ParsedScript, ScriptElement } from './types.ts';

const SLUG = /^\s*(?:\.(?=[A-Za-z0-9])|(INT\.?\/EXT\.?|EXT\.?\/INT\.?|INT\.?|EXT\.?|I\/E\.?|EST\.?)(?=[\s.]))\s*(.*)$/i;
const TRANSITION = /^\s*[A-Z ]+ TO:\s*$|^\s*FADE (IN|OUT)[.:]?\s*$|^\s*CUT TO BLACK\.?\s*$/;
const isCue = (l: string) => { const t = l.replace(/\s*\(.*?\)\s*$/, '').replace(/\^$/, '').trim(); return t.length > 0 && t.length < 40 && t === t.toUpperCase() && /[A-Z]/.test(t) && !SLUG.test(l) && !TRANSITION.test(l); };
const clean = (c: string) => c.replace(/\s*\(.*?\)\s*$/, '').replace(/\^$/, '').trim();

/**
 * Fountain-style screenplay (scene headings INT./EXT., CHARACTER cues, dialogue) into scenes with elements.
 * Anything without scene headings is "loose": the text is kept whole and the Scenes stage (LLM) splits it.
 * No LLM here, so the structure of a real screenplay is never guessed.
 */
export function parseScript(text: string): ParsedScript {
  const src = text.replace(/\r\n?/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').trim();
  const lines = src.split('\n');
  let title: string | undefined;
  let i = 0;
  const titleM = /^Title:\s*(.+)$/im.exec(lines.slice(0, 8).join('\n'));
  if (titleM) { title = titleM[1]!.trim(); while (i < lines.length && /^[A-Za-z ]+:\s*.*$/.test(lines[i]!)) i++; }
  const scenes: ParsedScene[] = [];
  let cur: ParsedScene | null = null;
  const chars = new Set<string>();
  const push = (el: ScriptElement) => { if (cur) { cur.elements.push(el); cur.text += (cur.text ? '\n' : '') + (el.type === 'dialogue' ? `${el.character}: ${el.text}` : el.type === 'parenthetical' ? `(${el.text})` : el.text); } };

  for (; i < lines.length; i++) {
    const raw = lines[i]!; const l = raw.trim();
    if (!l) continue;
    const sm = SLUG.exec(l);
    if (sm) {
      const heading = l.replace(/^\./, '').trim();
      const [placePart, ...rest] = heading.replace(/^(INT\.?\/EXT\.?|EXT\.?\/INT\.?|INT\.?|EXT\.?|I\/E\.?|EST\.?)\s*/i, '').split(/\s+-\s+/);
      cur = { id: `s${scenes.length + 1}`, heading, place: (placePart ?? '').trim(), time: rest.join(' - ').trim(), text: '', elements: [], characters: [] };
      scenes.push(cur); continue;
    }
    if (TRANSITION.test(l)) continue;
    if (!cur) { cur = { id: 's1', heading: '', place: '', time: '', text: '', elements: [], characters: [] }; scenes.push(cur); }
    const next = lines[i + 1]?.trim();
    if (isCue(l) && next) {
      const name = clean(l); chars.add(name); if (!cur.characters.includes(name)) cur.characters.push(name);
      let j = i + 1;
      while (j < lines.length && lines[j]!.trim()) {
        const d = lines[j]!.trim();
        if (/^\(.*\)$/.test(d)) push({ type: 'parenthetical', character: name, text: d.slice(1, -1) });
        else push({ type: 'dialogue', character: name, text: d });
        j++;
      }
      i = j - 1; continue;
    }
    push({ type: 'action', text: l });
  }
  const hasHeadings = scenes.some((s) => s.heading);
  if (!hasHeadings) return { title, mode: 'loose', scenes: [], characters: [...chars], text: src };
  return { title, mode: 'screenplay', scenes: scenes.filter((s) => s.elements.length || s.heading), characters: [...chars], text: src };
}

/** Render a parsed scene back to plain text for a prompt. */
export const sceneText = (s: ParsedScene) => `${s.heading}\n${s.text}`.trim();

export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'x';
export function uniqueId(base: string, taken: Set<string>): string {
  let id = slugify(base), n = 2;
  while (taken.has(id)) id = `${slugify(base)}-${n++}`;
  taken.add(id); return id;
}

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
/** Lines someone speaks in plain text ("name: line") or Fountain form (CUE line then dialogue). */
export function spokenLines(text: string): { speaker: string; line: string }[] {
  const out: { speaker: string; line: string }[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.trim(); if (!l) continue;
    const m = /^([A-Za-z][A-Za-z0-9 ._'-]{0,28}?)\s*:\s*(.{3,})$/.exec(l);
    if (m && !/^(title|int|ext|scene|location|note)\b/i.test(m[1]!)) { out.push({ speaker: m[1]!.trim(), line: m[2]!.trim() }); continue; }
    if (isCue(l) && lines[i + 1]?.trim() && !SLUG.test(l)) { let j = i + 1; while (j < lines.length && lines[j]!.trim()) { const d = lines[j]!.trim(); if (!/^\(.*\)$/.test(d)) out.push({ speaker: clean(l), line: d }); j++; } i = j - 1; }
  }
  return out;
}
/** Spoken lines of the source text that the interpreted script does not contain (word for word, ignoring case and punctuation). */
export function missingDialogue(source: string, interpreted: string): { speaker: string; line: string; /** the line is there but said by someone else */ saidBy?: string }[] {
  const hay = norm(interpreted); const there = spokenLines(interpreted);
  const out: { speaker: string; line: string; saidBy?: string }[] = [];
  for (const d of spokenLines(source)) {
    const n = norm(d.line); if (!n) continue;
    if (!hay.includes(n)) { out.push(d); continue; }
    const m = there.find((x) => norm(x.line) === n || norm(x.line).includes(n));
    if (m && norm(m.speaker).replace(/ /g, '') !== norm(d.speaker).replace(/ /g, '')) out.push({ ...d, saidBy: m.speaker });
  }
  return out;
}
