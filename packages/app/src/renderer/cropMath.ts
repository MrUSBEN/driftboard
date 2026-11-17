export type Box = { x: number; y: number; w: number; h: number };
export type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';
export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export const RATIOS = [['free', 'Free'], ['orig', 'Original'], ['16:9', '16:9'], ['9:16', '9:16'], ['1:1', '1:1'], ['4:3', '4:3'], ['3:4', '3:4'], ['2:3', '2:3'], ['21:9', '21:9']];

/** Largest box of a ratio that fits inside the image, centred. */
export const fit = (W: number, H: number, r: number): Box => { let w = W, h = W / r; if (h > H) { h = H; w = H * r; } return { x: (W - w) / 2, y: (H - h) / 2, w, h }; };

/** Move or resize the box by (dx, dy) source pixels; with a ratio the box keeps it. */
export function dragBox(b: Box, handle: Handle, dx: number, dy: number, W: number, H: number, ratio: number | null, min = 16): Box {
  if (handle === 'move') return { ...b, x: clamp(b.x + dx, 0, W - b.w), y: clamp(b.y + dy, 0, H - b.h) };
  let l = b.x, t = b.y, r = b.x + b.w, bt = b.y + b.h;
  if (handle.includes('w')) l = clamp(l + dx, 0, r - min);
  if (handle.includes('e')) r = clamp(r + dx, l + min, W);
  if (handle.includes('n')) t = clamp(t + dy, 0, bt - min);
  if (handle.includes('s')) bt = clamp(bt + dy, t + min, H);
  if (!ratio) return { x: l, y: t, w: r - l, h: bt - t };
  const corner = handle.length === 2, vertical = handle === 'n' || handle === 's';
  let w = r - l, h = bt - t;
  if (vertical) w = h * ratio; else h = w / ratio;
  if (corner && !vertical) h = w / ratio;
  // anchor: the side opposite to the dragged handle stays; edge handles stay centred on the other axis
  let x = handle.includes('w') ? b.x + b.w - w : handle.includes('e') ? b.x : b.x + (b.w - w) / 2;
  let y = handle.includes('n') ? b.y + b.h - h : handle.includes('s') ? b.y : b.y + (b.h - h) / 2;
  const k = Math.min(1, (x < 0 ? (w + x) / w : 1), (y < 0 ? (h + y) / h : 1), x + w > W ? (W - x) / w : 1, y + h > H ? (H - y) / h : 1);
  if (k < 1) { const w2 = w * k, h2 = h * k; x = handle.includes('w') ? x + (w - w2) : x; y = handle.includes('n') ? y + (h - h2) : y; w = w2; h = h2; }
  return { x: clamp(x, 0, W - w), y: clamp(y, 0, H - h), w: Math.max(min, w), h: Math.max(min, h) };
}

