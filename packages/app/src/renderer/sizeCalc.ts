/** Film properties: what the size chooser PRESELECTS. Nothing here is applied behind the user's back. */
export interface Film { aspect: string; mp: number; seconds: number; target?: number }
export const DEFAULT_FILM: Film = { aspect: '16:9', mp: 0.1, seconds: 5 };
export const FILM_ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '2:3', '3:2'];
export const QUALITY = [{ label: 'Draft', mp: 0.1 }, { label: 'Test', mp: 0.25 }, { label: 'Normal', mp: 0.5 }, { label: 'Final', mp: 1 }];

export type Purpose = 'film' | 'match' | 'same' | 'character' | 'wide' | 'square' | 'vertical' | 'ultra' | 'aspect' | 'custom';
export const PURPOSES: { id: Purpose; label: string; ratio?: string }[] = [
  { id: 'film', label: 'Film aspect' },
  { id: 'match', label: 'Match input (same aspect)' },
  { id: 'same', label: 'Same size as input' },
  { id: 'character', label: 'Character reference (2:3)', ratio: '2:3' },
  { id: 'wide', label: 'Wide / location (16:9)', ratio: '16:9' },
  { id: 'square', label: 'Square (1:1)', ratio: '1:1' },
  { id: 'vertical', label: 'Vertical (9:16)', ratio: '9:16' },
  { id: 'ultra', label: 'Ultrawide (21:9)', ratio: '21:9' },
  { id: 'aspect', label: 'Aspect ratio' },
  { id: 'custom', label: 'Custom width × height' },
];
/** What the user picked for one place that can order a generation. mp undefined = follow the film's quality. */
export interface SizeChoice { purpose: Purpose; mp?: number; w?: number; h?: number; /** purpose 'aspect': the ratio, e.g. '4:3' */ aspect?: string; /** the short side in pixels; when set it decides the size instead of mp */ res?: number }
/** Short-side sizes the Resolution dropdown offers (720 = 1280×720 at 16:9). */
export const RESOLUTIONS = [240, 360, 480, 540, 576, 720, 864, 1080, 1440];
/** Megapixel sizes the MP dropdown offers. */
export const MPS = [0.05, 0.1, 0.25, 0.5, 1, 2];

export const ratioOf = (s: string): number => { const m = /(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)/.exec(s); return m ? Number(m[1]) / Number(m[2]) : 16 / 9; };
const gcd = (x: number, y: number): number => (y ? gcd(y, x % y) : x);
export const ratioText = (w: number, h: number) => { const k = gcd(w, h); return w / k <= 32 && h / k <= 32 ? `${w / k}:${h / k}` : `${(w / h).toFixed(2)}:1`; };
const hasSize = (a?: { width: number | null; height: number | null } | null): a is { width: number; height: number } => !!a?.width && !!a.height;

/** The explicit width and height for a choice. `src` = the first input picture/clip (for the "match" purposes). */
export function resolveSize(c: SizeChoice, film: Film, src: { width: number | null; height: number | null } | null | undefined, step = 8): { w: number; h: number; mp: number; note?: string } {
  const snap = (n: number) => Math.max(step, Math.round(n / step) * step);
  const mp = c.mp ?? film.mp;
  const fromRatio = (r: number, m: number) => { const area = m * 1e6; const h = Math.sqrt(area / r); return { w: snap(h * r), h: snap(h) }; };
  if (c.purpose === 'custom') { const w = snap(c.w ?? 1280), h = snap(c.h ?? 720); return { w, h, mp: (w * h) / 1e6 }; }
  if (c.purpose === 'same' && hasSize(src)) { const w = snap(src.width), h = snap(src.height); return { w, h, mp: (w * h) / 1e6 }; }
  let r: number;
  if (c.purpose === 'match' || c.purpose === 'same') r = hasSize(src) ? src.width / src.height : ratioOf(film.aspect);
  else if (c.purpose === 'film') r = ratioOf(film.aspect);
  else if (c.purpose === 'aspect') r = ratioOf(c.aspect ?? film.aspect);
  else r = ratioOf(PURPOSES.find((p) => p.id === c.purpose)?.ratio ?? film.aspect);
  if (c.res) { const w = snap(r >= 1 ? c.res * r : c.res), h = snap(r >= 1 ? c.res : c.res / r); return { w, h, mp: (w * h) / 1e6 }; }
  const s = fromRatio(r, mp);
  return { ...s, mp: (s.w * s.h) / 1e6 };
}


/** Put an explicit size into the values for a profile that can take one (every size-related slot is replaced, nothing falls back to a workflow default). */
export function withSize(values: Record<string, unknown>, size: { w: number; h: number }): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) if (!/aspect|megapixel|^__(size|match)$/.test(k)) rest[k] = v;   // other __ notes (how the prompt was made) stay with the job
  return { ...rest, custom_width: size.w, custom_height: size.h };
}

