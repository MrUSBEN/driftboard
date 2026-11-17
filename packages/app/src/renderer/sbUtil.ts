/** Split pasted prompts: blank-line separated blocks, or one per line when it is a numbered list; leading "1." / "Shot 1:" is dropped. */
export function splitPrompts(text: string): string[] {
  const t = text.replace(/\r\n/g, '\n').trim(); if (!t) return [];
  let parts = t.split(/\n\s*\n/);
  if (parts.length === 1 && /^\s*(\d+[.)]|shot\s*\d+\s*[:.-])/im.test(t)) parts = t.split(/\n(?=\s*(?:\d+[.)]|shot\s*\d+\s*[:.-]))/i);
  return parts.map((p) => p.trim().replace(/^(?:shot\s*)?\d+\s*[.):-]\s*/i, '').trim()).filter(Boolean);
}

