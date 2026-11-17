import type { Slot } from './shared.tsx';
import { IconButton, Notice, Toggle } from './ui/ui.tsx';

/** Model files: the ones of this profile's family first, then the rest, so a fine-tune with any name can still be picked. */
export function modelOrder(s: Slot, list: string[]): { mine: string[]; rest: string[] } {
  if (s.type !== 'enum' || !s.model || !s.family) return { mine: list, rest: [] };
  let re: RegExp; try { re = new RegExp(s.family, 'i'); } catch { return { mine: list, rest: [] }; }
  return { mine: list.filter((x) => re.test(x)), rest: list.filter((x) => !re.test(x)) };
}

/**
 * One setting of a profile. `saved` is the user's default from Settings → ComfyUI: shown (and used) when the form
 * leaves the setting alone, so what will run is always visible.
 */
export function SlotField({ slot: s, value, onChange, options, saved, installed }: {
  slot: Slot; value: unknown; onChange: (v: unknown) => void; options?: string[]; saved?: unknown;
  /** for a model choice: the files ComfyUI has, to flag a choice that is not installed */ installed?: boolean;
}) {
  const label = s.label ?? s.id.replace(/_/g, ' ');
  const mark = value === undefined && saved !== undefined ? <span className="xs faint">· your default</span> : null;
  const head = (extra?: React.ReactNode) => <span className="lbl">{label}{'required' in s && s.required && <span className="req" aria-label="required">*</span>}{mark}{extra}</span>;
  if (s.type === 'text') return <label className="field">{head()}<textarea className="ta" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} /></label>;
  if (s.type === 'number') {
    const shown = (value as number | undefined) ?? (saved as number | undefined) ?? (s.role === 'seed' ? undefined : (s.wfDefault as number | undefined));
    if (s.role === 'seed') return <div className="field">{head()}<div className="row"><input className="inp mono" type="number" aria-label={label} placeholder="new for each result" value={shown ?? ''} min={s.min} max={s.max} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />
      <IconButton kind="secondary" icon="dice" label="Roll a seed" onClick={() => onChange(Math.floor(Math.random() * 2 ** 31))} />{shown !== undefined && <IconButton icon="x" label="Back to a new seed for each result" onClick={() => onChange(undefined)} />}</div></div>;
    return <label className="field">{head()}<input className="inp mono" type="number" value={shown ?? ''} min={s.min} max={s.max} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} /></label>;
  }
  if (s.type === 'enum') {
    const list = options ?? s.options;
    const shown = (value as string | undefined) ?? (saved as string | undefined) ?? (s.wfDefault as string | undefined) ?? '';
    const missing = !!list && !!shown && !list.includes(shown);
    const opt = (o: string) => <option key={o} value={o}>{o}{o === (s.default ?? s.wfDefault) ? ' (stock)' : ''}</option>;
    const { mine, rest } = list ? modelOrder(s, list) : { mine: [], rest: [] };
    return <div className="field">{head()}
      {list ? <select className="selc" aria-label={label} value={shown} onChange={(e) => onChange(e.target.value)}>
        {missing && <option value={shown}>{shown}{s.model ? ' (not in ComfyUI)' : ''}</option>}
        {mine.map(opt)}
        {rest.length > 0 && <optgroup label="Other files">{rest.map(opt)}</optgroup>}
      </select> : <input className="inp" type="text" aria-label={label} value={(value as string) ?? ''} placeholder={String(saved ?? s.wfDefault ?? '(workflow default)')} onChange={(e) => onChange(e.target.value || undefined)} />}
      {s.model && (missing || installed === false) && <Notice tone="bad">This file is not in ComfyUI's {s.model} folder, so the job would stop before it starts. Choose another file, or put it in that folder.</Notice>}</div>;
  }
  if (s.type === 'boolean') { const on = (value as boolean | undefined) ?? (saved as boolean | undefined) ?? !!s.default; return <div className="row"><Toggle on={on} label={label} onChange={onChange} /><span className="small">{label}</span>{mark}</div>; }
  return <div className="note">{label}: not supported yet</div>;
}
