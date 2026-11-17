/**
 * Forgiving JSON for small local models: code fences, chatter around the object, trailing commas, smart quotes,
 * single quotes, unquoted keys, and replies cut off mid-way (open brackets are closed). The repair steps follow the
 * kinds of slips seen from 12B models (pattern adapted from OpenField shotlist.ts, MIT).
 */
export function parseLooseJson(text: string): unknown {
  const body = text.replace(/```(?:json|JSON)?/g, '').trim();
  const start = firstOpen(body);
  if (start < 0) throw new Error('No JSON found in the reply');
  const candidate = body.slice(start);
  const attempts = [balanced(candidate), repair(balanced(candidate)), repair(closeOpen(candidate)), repair(closeOpen(candidate.replace(/,\s*[^,{}\[\]]*$/, '')))];
  let lastErr: unknown;
  for (const a of attempts) {
    if (!a) continue;
    try { return JSON.parse(a); } catch (e) { lastErr = e; }
  }
  throw new Error(`Could not read the reply as JSON (${(lastErr as Error)?.message ?? 'unknown'})`);
}

function firstOpen(s: string): number {
  const a = s.indexOf('{'), b = s.indexOf('[');
  return a < 0 ? b : b < 0 ? a : Math.min(a, b);
}

/** From the first bracket to its matching close, ignoring brackets inside strings. */
function balanced(s: string): string {
  const stack: string[] = []; let inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') { stack.pop(); if (!stack.length) return s.slice(0, i + 1); }
  }
  return '';
}

/** Close whatever a cut-off reply left open (strings, objects, arrays). */
function closeOpen(s: string): string {
  const stack: string[] = []; let inStr = false, esc = false;
  for (const c of s) {
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') stack.push('}'); else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') stack.pop();
  }
  let out = s;
  if (inStr) out += '"';
  out = out.replace(/,\s*$/, '').replace(/:\s*$/, ': null');
  return out + stack.reverse().join('');
}

function repair(s: string): string {
  if (!s) return s;
  return s
    .replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'")
    .replace(/\/\/[^\n]*$/gm, '')
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')          // unquoted keys
    .replace(/'([^'\n]*)'(\s*[:,}\]])/g, '"$1"$2')                          // single-quoted strings
    .replace(/,\s*([}\]])/g, '$1');                                          // trailing commas
}

/** Pick the closest allowed value for a free-text answer: exact, then by label, then by keyword table, then fallback. */
export function snap<T extends string>(value: unknown, allowed: readonly T[], opts: { words?: [RegExp, T][]; fallback: T }): T {
  const s = String(value ?? '').trim();
  const exact = allowed.find((a) => a === s) ?? allowed.find((a) => a.toLowerCase() === s.toLowerCase());
  if (exact) return exact;
  for (const [re, v] of opts.words ?? []) if (re.test(s)) return v;
  const loose = allowed.find((a) => s.toLowerCase().includes(a.toLowerCase()));
  return loose ?? opts.fallback;
}

/** Nearest allowed number (for shot lengths). */
export function snapNumber(value: unknown, allowed: readonly number[], fallback?: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback ?? allowed[0]!;
  // ties go to the longer value: a shot that is a little too long is safer than one that is too short
  return allowed.reduce((best, a) => { const d = Math.abs(a - n), bd = Math.abs(best - n); return d < bd || (d === bd && a > best) ? a : best; }, allowed[0]!);
}
