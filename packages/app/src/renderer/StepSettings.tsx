/* The Generate form's settings, folded small, for one step of a shot: the same fields from the same model, so nothing
   important is lost and nobody has to leave the Story to change a sampler, a size or a seed. Changes are saved on the shot. */
import { useEffect, useState } from 'react';
import { api, type Manifest, type Slot } from './shared.tsx';
import { SlotField } from './SlotField.tsx';
import { SizeChooser, sizeInfo, type SizeChoice } from './size.tsx';
import { Button, Section } from './ui/ui.tsx';

const IO = new Set(['image', 'image_list', 'video', 'video_list', 'audio_list']);

/** The settings of a model that are neither inputs, the prompt nor the size: what the Generate form shows under Settings and Advanced. */
export function settingsOf(p: Manifest, has: Record<string, boolean>): Slot[] {
  const sizeUi = sizeInfo(p).ok;
  const isSize = (s: Slot) => sizeUi && ((s.type === 'enum' && !!s.customSize) || (s.type === 'number' && /megapixel/.test(s.id)));
  const inputIds = new Set((p.slots as Slot[]).filter((s) => IO.has(s.type)).map((s) => s.id));
  return (p.slots as Slot[]).filter((s) => !IO.has(s.type) && !isSize(s) && s.role !== 'prompt' && s.role !== 'duration'
    && !(s.type === 'boolean' && s.needsNodes?.some((n) => !has[n]))
    && !(s.role === 'guide_frames' || s.role === 'guide_still_frame' || s.id === 'guide_audio')
    && !(/_frames?$/.test(s.id) && inputIds.has(s.id.replace(/_frames?$/, ''))));   // frame counts of held frames and storyboard anchors are set by the seam, not here
}

export function StepSettings({ profile, values, onChange, onReset, size, onSize, foldKey }: {
  profile: Manifest; values: Record<string, unknown>; onChange: (id: string, v: unknown) => void; onReset: () => void;
  /** the size this step uses, and a way to change it for this step only */ size?: SizeChoice; onSize?: (c: SizeChoice) => void; foldKey: string;
}) {
  const [options, setOptions] = useState<Record<string, string[]>>({});
  const [saved, setSaved] = useState<Record<string, unknown>>({});
  const [has, setHas] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let live = true;
    const need = [...new Set(profile.slots.flatMap((s) => (s.type === 'boolean' && s.needsNodes) || []))];
    void api.profileOptions(profile.id).then((o) => { if (live) setOptions(o); }).catch(() => {});
    void api.comfyPrefs().then((p) => { if (live) setSaved(p.profiles[profile.id]?.defaults ?? {}); }).catch(() => {});
    void (need.length ? api.comfyHas(need) : Promise.resolve({})).then((h) => { if (live) setHas(h); }).catch(() => {});
    return () => { live = false; };
  }, [profile.id]);
  const all = settingsOf(profile, has);
  const main = all.filter((s) => !s.advanced), adv = all.filter((s) => s.advanced);
  const changed = Object.keys(values).filter((k) => !k.startsWith('__') && values[k] !== undefined).length + (values.__size ? 1 : 0);
  const field = (s: Slot) => <SlotField key={profile.id + s.id} slot={s} value={values[s.id]} onChange={(v) => onChange(s.id, v)} options={options[s.id]} saved={saved[s.id]} />;
  const sizeUi = sizeInfo(profile).ok && !!onSize && !!size;
  if (!main.length && !adv.length && !sizeUi) return null;
  return (
    <Section title="Settings" icon="settings" count={changed ? `· ${changed} changed` : undefined} fold foldKey={foldKey} defaultOpen={false}
      actions={changed ? <Button size="sm" kind="quiet" title="Back to the model's defaults" onClick={onReset}>Reset</Button> : undefined}>
      {sizeUi && <div className="field"><span className="lbl">Size for this {profile.kind === 'video' ? 'clip' : 'frame'}</span><SizeChooser value={size!} onChange={onSize!} /></div>}
      {main.map(field)}
      {adv.length > 0 && <>
        <span className="xs faint">Advanced</span>
        {adv.map(field)}
      </>}
      <span className="xs faint">{profile.title}. Your defaults live in Settings › ComfyUI; a change here is for this shot only.</span>
    </Section>
  );
}
