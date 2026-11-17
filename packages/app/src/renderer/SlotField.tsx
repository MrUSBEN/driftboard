import type { Slot } from './shared.tsx';

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
  const mark = value === undefined && saved !== undefined ? <span className="note"> · your default</span> : null;
  if (s.type === 'text') return <><label>{label}{s.required ? ' *' : ''}</label><textarea value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} /></>;
  if (s.type === 'number') {
    const shown = (value as number | undefined) ?? (saved as number | undefined) ?? (s.role === 'seed' ? undefined : (s.wfDefault as number | undefined));
    return <><label>{label}{s.role === 'seed' ? ' (blank = random)' : ''}{mark}</label><input type="number" value={shown ?? ''} min={s.min} max={s.max} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} /></>;
  }
  if (s.type === 'enum') {
    const list = options ?? s.options;
    const shown = (value as string | undefined) ?? (saved as string | undefined) ?? (s.wfDefault as string | undefined) ?? '';
    const missing = !!list && !!shown && !list.includes(shown);
    const opt = (o: string) => <option key={o} value={o}>{o}{o === (s.default ?? s.wfDefault) ? ' (stock)' : ''}</option>;
    const { mine, rest } = list ? modelOrder(s, list) : { mine: [], rest: [] };
    return <><label>{label}{mark}</label>
      {list ? <select value={shown} onChange={(e) => onChange(e.target.value)}>
        {missing && <option value={shown}>{shown}{s.model ? ' (not in ComfyUI)' : ''}</option>}
        {mine.map(opt)}
        {rest.length > 0 && <optgroup label="Other files">{rest.map(opt)}</optgroup>}
      </select> : <input type="text" value={(value as string) ?? ''} placeholder={String(saved ?? s.wfDefault ?? '(workflow default)')} onChange={(e) => onChange(e.target.value || undefined)} />}
      {s.model && (missing || installed === false) && <div className="warn">This file is not in ComfyUI's {s.model} folder: the job will stop before it starts.</div>}</>;
  }
  if (s.type === 'boolean') return <label className="row" style={{ color: 'var(--text)' }}><input type="checkbox" checked={(value as boolean | undefined) ?? (saved as boolean | undefined) ?? s.default} onChange={(e) => onChange(e.target.checked)} />{label}{mark}</label>;
  return <div className="note">{label}: not supported yet</div>;
}
