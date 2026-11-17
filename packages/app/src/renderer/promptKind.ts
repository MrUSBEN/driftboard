/** What kind of prompt a text is (from its wording), and whether it fits the inputs that come with it. Pure, no UI. */
export type PromptKind = 'text' | 'first' | 'first-last' | 'refs';
export interface Provided { first: boolean; last: boolean; refs: number; /** any other picture input (e.g. an image to edit) */ other: number }
export interface SlotLike { id: string; type: string; role?: string }

export const KIND_LABEL: Record<PromptKind, string> = { text: 'text only', first: 'first frame', 'first-last': 'first + last frame', refs: 'pictures' };

/** Which <Picture n> numbers the prompt uses, and the kind it reads as. */
export function detectPromptKind(prompt: string): { kind: PromptKind; pictures: number[] } {
  const pictures = [...new Set([...prompt.matchAll(/<Picture\s*(\d+)>/gi)].map((m) => Number(m[1])))].sort((a, b) => a - b);
  const last = /\blast frame\b|\bfinal frame\b|ends? (?:exactly )?(?:on|at|as) <picture/i.test(prompt);
  const first = /\bfirst frame\b|\bopening frame\b|\bstarting frame\b|begins? (?:exactly )?(?:as|with|from) (?:shown in )?<picture/i.test(prompt);
  if (!pictures.length && !first) return { kind: 'text', pictures };
  if (last && (first || pictures.length)) return { kind: 'first-last', pictures };
  if (first || (pictures.length === 1 && /(?:from|as shown in|exactly as depicted in) <picture 1>/i.test(prompt))) return { kind: 'first', pictures };
  return { kind: 'refs', pictures };
}

/** The inputs a draft/shot provides, from the profile's slots and the chosen assets (slot id -> asset ids). */
export function providedOf(slots: SlotLike[], inputs: Record<string, string[] | undefined>): Provided {
  const p: Provided = { first: false, last: false, refs: 0, other: 0 };
  for (const s of slots) {
    const n = inputs[s.id]?.length ?? 0; if (!n) continue;
    if (s.role === 'first_frame') p.first = true; else if (s.role === 'last_frame') p.last = true; else if (s.type === 'image_list') p.refs += n; else if (s.type === 'image') p.other += n;
  }
  return p;
}

/** Problems between a prompt and the inputs it will be sent with. Empty = fits. */
export function checkPrompt(prompt: string, have: Provided, slots: SlotLike[]): string[] {
  if (!prompt.trim()) return [];
  const { kind, pictures } = detectPromptKind(prompt);
  const canFirst = slots.some((s) => s.role === 'first_frame'), canLast = slots.some((s) => s.role === 'last_frame');
  const total = (have.first ? 1 : 0) + (have.last ? 1 : 0) + have.refs + have.other;
  const out: string[] = [];
  if (kind === 'text') { if (total > 0 && pictures.length === 0 && (have.refs || have.other)) out.push('Pictures are attached but the prompt does not mention any <Picture n>.'); return out; }
  if (total === 0) out.push(`The prompt is written for ${KIND_LABEL[kind]} (it mentions ${pictures.length ? pictures.map((n) => `<Picture ${n}>`).join(', ') : 'a first frame'}) but no input picture is attached.`);
  else {
    const top = pictures.length ? pictures[pictures.length - 1]! : 0;
    if (top > total) out.push(`The prompt uses <Picture ${top}> but only ${total} picture${total === 1 ? ' is' : 's are'} attached.`);
    if ((kind === 'first' || kind === 'first-last') && canFirst && !have.first) out.push('The prompt starts from a first frame but no first-frame picture is attached.');
    if (kind === 'first-last' && canLast && !have.last) out.push('The prompt ends on a last frame but no last-frame picture is attached.');
    if (kind === 'first' && have.last) out.push('A last frame is attached but the prompt only describes a first frame.');
  }
  return out;
}
