/* A prompt box where typing @ opens a list of the shot's pictures, and the pick becomes a small chip with its thumbnail.
   The chip is tied to the picture, not its name: it is stored as @[inputId] and turned into "Picture N" when the step runs. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { thumbUrl } from './shared.tsx';
import { Icon } from './ui/Icon.tsx';

export interface Cand { id: string; asset: string; label: string; /** its number in this step, when it takes part */ n?: number | string | null; sub?: string; /** a picture not in the shot yet: adds it, then returns the new input id */ add?: () => Promise<string | undefined> }
export const MENTION = /@\[([\w-]+)\]/g;

/** What the box holds, as text: chips become @[id]. */
function ser(el: Node): string {
  let s = '';
  el.childNodes.forEach((n) => {
    if (n.nodeType === 3) s += n.nodeValue ?? '';
    else if (n.nodeName === 'BR') s += '\n';
    else if ((n as HTMLElement).dataset?.id) s += `@[${(n as HTMLElement).dataset.id}]`;
    else s += ser(n);
  });
  return s;
}
function chipEl(id: string, c: { asset: string; label: string } | undefined): HTMLElement {
  const s = document.createElement('span');
  s.className = 'mMention' + (c ? '' : ' gone'); s.contentEditable = 'false'; s.dataset.id = id;
  if (c) { const i = document.createElement('img'); i.src = thumbUrl(c.asset); i.alt = ''; i.draggable = false; i.onerror = () => i.remove(); s.appendChild(i); }
  s.appendChild(document.createTextNode(c ? c.label : 'removed picture'));
  return s;
}
function paint(el: HTMLElement, value: string, known: Record<string, { asset: string; label: string }>) {
  el.textContent = '';
  let at = 0; MENTION.lastIndex = 0; let m: RegExpExecArray | null;
  while ((m = MENTION.exec(value))) {
    if (m.index > at) el.appendChild(document.createTextNode(value.slice(at, m.index)));
    el.appendChild(chipEl(m[1]!, known[m[1]!])); at = m.index + m[0].length;
  }
  if (at < value.length) el.appendChild(document.createTextNode(value.slice(at)));
}

export function MentionBox({ value, onSave, placeholder, rows = 3, cands, known }: {
  value: string; onSave: (v: string) => void; placeholder: string; rows?: number; cands: Cand[]; known: Record<string, { asset: string; label: string }>;
}) {
  const box = useRef<HTMLDivElement>(null);
  const last = useRef(value);
  const [empty, setEmpty] = useState(!value);
  const [pick, setPick] = useState<{ node: Text; start: number; end: number; q: string } | null>(null);
  const [hi, setHi] = useState(0);
  const [fold, setFold] = useState(() => { try { return localStorage.getItem('driftboard.msPromptFold') === '1'; } catch { return false; } });
  const toggleFold = () => setFold((f) => { try { localStorage.setItem('driftboard.msPromptFold', f ? '0' : '1'); } catch { /* ignore */ } return !f; });
  const knownKey = JSON.stringify(known);
  useLayoutEffect(() => { if (box.current && (value !== last.current || !box.current.firstChild && value)) { last.current = value; paint(box.current, value, known); setEmpty(!value); } }, [value]);   // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { if (box.current && document.activeElement !== box.current) paint(box.current, value, known); }, [knownKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  const q = pick?.q.toLowerCase() ?? '';
  const items = !pick ? [] : cands.filter((c) => {
    if (!q) return true;
    if (/^\d+$/.test(q)) return String(c.n ?? '') === q;
    return c.label.toLowerCase().includes(q);
  }).slice(0, 12);
  useEffect(() => { setHi(0); }, [pick?.q]);

  const detect = () => {
    const sel = window.getSelection(); const n = sel?.anchorNode;
    if (!sel || !n || n.nodeType !== 3 || !box.current?.contains(n)) return setPick(null);
    const before = (n.nodeValue ?? '').slice(0, sel.anchorOffset); const m = /(^|\s)@([^\s@\[\]]*)$/.exec(before);
    if (!m) return setPick(null);
    setPick({ node: n as Text, start: sel.anchorOffset - m[2]!.length - 1, end: sel.anchorOffset, q: m[2]! });
  };
  const commit = (v?: string) => { const s = v ?? ser(box.current!); setEmpty(!s); if (s !== last.current) { last.current = s; onSave(s); } };
  const insert = async (c: Cand) => {
    if (!pick || !box.current) return;
    const id = c.add ? await c.add() : c.id; if (!id) return setPick(null);
    const { node, start, end } = pick; if (!node.isConnected) return setPick(null);
    const r = document.createRange(); r.setStart(node, start); r.setEnd(node, Math.min(end, node.length)); r.deleteContents();
    const chip = chipEl(id, { asset: c.asset, label: c.label }); r.insertNode(chip);
    const sp = document.createTextNode(' '); chip.after(sp);
    const sel = window.getSelection()!; const nr = document.createRange(); nr.setStart(sp, 1); nr.collapse(true); sel.removeAllRanges(); sel.addRange(nr);
    setPick(null); commit(); box.current.focus();
  };
  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (pick && items.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => (h + 1) % items.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => (h + items.length - 1) % items.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); void insert(items[hi]!); return; }
    }
    if (pick && e.key === 'Escape') { e.preventDefault(); setPick(null); return; }
    if (e.key === 'Enter') { e.preventDefault(); document.execCommand('insertText', false, '\n'); }
  };
  const inShot = items.filter((c) => !c.add), more = items.filter((c) => c.add);
  const row = (c: Cand, i: number) => (
    <button key={c.id + i} type="button" role="option" aria-selected={i === hi} className={'mOpt' + (i === hi ? ' hi' : '')} onMouseDown={(e) => { e.preventDefault(); void insert(c); }} onMouseEnter={() => setHi(i)}>
      <img src={thumbUrl(c.asset)} alt="" draggable={false} onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} /><span className="tx">{c.label}<small>{c.sub}</small></span><span className="nu">{c.add ? '+' : c.n ?? 'off'}</span>
    </button>
  );
  return (
    <div className={'mMention-wrap' + (fold ? ' folded' : '')}>
      <button type="button" className="mFoldB" aria-expanded={!fold} title={fold ? 'Show the whole prompt' : 'Fold the prompt to two lines'} aria-label={fold ? 'Show the whole prompt' : 'Fold the prompt'} onClick={toggleFold}><Icon name="chev" size={12} /></button>
      <div ref={box} className={'ta mPrompt mEdit' + (empty ? ' empty' : '')} role="textbox" aria-multiline="true" aria-label={placeholder} data-ph={placeholder} contentEditable suppressContentEditableWarning spellCheck style={{ minHeight: `${rows * 1.45 + 1.2}em` }}
        onInput={() => { setEmpty(!ser(box.current!)); detect(); }} onKeyUp={(e) => { if (e.key.length === 1 || e.key === 'Backspace') detect(); }} onClick={detect} onKeyDown={onKey}
        onPaste={(e) => { e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain')); }}
        onBlur={() => { setTimeout(() => setPick(null), 120); commit(); }} />
      {pick && items.length > 0 && <div className="mPicker" role="listbox" aria-label="Pictures of this shot">
        {inShot.length > 0 && <div className="sec">In this shot</div>}
        {inShot.map((c, i) => row(c, i))}
        {more.length > 0 && <div className="sec">Add to this shot</div>}
        {more.map((c, i) => row(c, inShot.length + i))}
        <div className="foot"><span>↑↓ move</span><span>Enter insert</span><span>Esc close</span><span>Type to filter, or a number</span></div>
      </div>}
      {pick && !items.length && <div className="mPicker"><div className="sec">{q ? 'No picture matches' : 'This shot has no pictures yet: add some above'}</div></div>}
    </div>
  );
}

/** Turn the @[id] chips of a prompt into plain words for the model: "Picture 2" / "Video 1" / "Audio 1" (what `number` returns) when it takes part, else its name. */
export function resolveMentions(text: string, number: (id: string) => string | undefined, label: (id: string) => string | undefined): string {
  return text.replace(MENTION, (_m, id: string) => number(id) ?? label(id) ?? '').replace(/[ \t]{2,}/g, ' ').trim();
}
/** The same prompt for a person to read (names, not numbers). */
export function plainMentions(text: string, label: (id: string) => string | undefined): string { return text.replace(MENTION, (_m, id: string) => label(id) ?? ''); }
