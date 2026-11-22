import { randomUUID } from 'node:crypto';
import type { DocStore } from './docs.ts';

/* The manual story: shots written and made by hand, one after the other. Each shot has two steps, a start frame (made by an
   image model from pictures the user chose) and a clip (a video model that starts from it). Nothing here is automatic: the app
   only stores what the user set and what they picked. The takes of a step are the finished jobs made for it (job params __ms). */

/** How a shot joins the one before it: a cut (new start frame), the last frame of the clip before, or held frames of that clip. */
export type Seam = 'cut' | 'last' | 'held';
export interface FrameInput {
  id: string; asset: string;
  /** a reference picture from the shelf, a picture used for this shot only */
  source: 'shelf' | 'once'; refId?: string;
  /** one word for the prompt writer: place, person, prop, style, other */
  role: string; on: boolean;
  /** which steps use it: both (the default), only the start frame, only the clip */
  use?: 'both' | 'frame' | 'clip';
}
interface Step { prompt: string; /** settings of the model for this step (the same keys as the Generate form), kept per shot */ values?: Record<string, unknown>; /** the take chosen for the shot */ pick?: string; /** pictures / clips dropped in by hand as tries */ extra: string[] }
export interface MFrame extends Step {
  /** the pictures of the shot, shared by both steps (each says which steps use it) */
  inputs: FrameInput[];
  /** the image model chosen for the frame (undefined = chosen for you) */
  profileId?: string;
  /** the last frame of the clip before (seam = last / held), taken once and remembered with the clip it came from */
  seamAsset?: string; seamFrom?: string; seamOn: boolean; /** the user replaced the extracted last frame (Prepare): held frames then carry it pinned, the last-frame seam starts from it */ seamEnhanced?: boolean;
}
export interface MClip extends Step { /** reference pictures for this clip only (the model's reference slot), same tiles as the frame's inputs */ inputs: FrameInput[]; seconds?: number; profileId?: string; /** the clip is given the frame's reference pictures too */ withRefs: boolean }
export interface MShot { kind: 'shot'; id: string; storyId: string; order: number; name: string; seam: Seam; frame: MFrame; clip: MClip; note?: string }
export interface MDivider { kind: 'divider'; id: string; storyId: string; order: number; name: string; folded: boolean }
export type MItem = MShot | MDivider;
export interface MStory { id: string; name: string; order: number }
export interface MRef { id: string; storyId: string; name: string; group: string; asset: string; order: number }
export interface ManualView { stories: MStory[]; items: MItem[]; refs: MRef[] }

const STORY = 'ms_story', ITEM = 'ms_item', REF = 'ms_ref';
const uid = () => randomUUID().slice(0, 10);

export const newShot = (storyId: string, name: string): MShot => ({
  kind: 'shot', id: uid(), storyId, order: 0, name, seam: 'cut',
  frame: { prompt: '', inputs: [], extra: [], seamOn: true },
  clip: { prompt: '', extra: [], inputs: [], withRefs: false },
});

export class ManualStore {
  constructor(private docs: DocStore) {}

  view(): ManualView {
    return {
      stories: this.docs.list<MStory>(STORY).map((r) => r.value).sort((a, b) => a.order - b.order),
      items: this.docs.list<MItem>(ITEM).map((r) => r.value).sort((a, b) => a.order - b.order),
      refs: this.docs.list<MRef>(REF).map((r) => r.value).sort((a, b) => a.order - b.order),
    };
  }
  stories(): MStory[] { return this.view().stories; }
  items(storyId: string): MItem[] { return this.docs.list<MItem>(ITEM).map((r) => r.value).filter((i) => i.storyId === storyId).sort((a, b) => a.order - b.order); }
  item(id: string): MItem | undefined { return this.docs.get<MItem>(ITEM, id); }
  shot(id: string): MShot | undefined { const i = this.item(id); return i?.kind === 'shot' ? i : undefined; }

  /** The first story, made when there is none (safe to call twice). */
  ensureStory(): MStory {
    this.migrate();
    return this.stories()[0] ?? this.addStory('Story 1');
  }
  /** Older shots kept their clip's reference pictures apart; they now live in the shot's one list, marked for the clip. */
  private migrate() {
    const old = this.docs.list<MItem>(ITEM).map((r) => r.value).filter((i): i is MShot => i.kind === 'shot' && (i.clip.inputs?.length ?? 0) > 0);
    if (!old.length) return;
    this.docs.batch('Update shots', () => {
      for (const sh of old) {
        const have = new Set(sh.frame.inputs.map((i) => i.asset));
        const add = sh.clip.inputs.filter((i) => !have.has(i.asset)).map((i) => ({ ...i, use: 'clip' as const }));
        const both = sh.frame.inputs.map((i) => (sh.clip.withRefs ? i : { ...i, use: 'frame' as const }));
        this.docs.set(ITEM, sh.id, { ...sh, frame: { ...sh.frame, inputs: [...both, ...add] }, clip: { ...sh.clip, inputs: [], withRefs: true } });
      }
    });
  }
  addStory(name = 'Story'): MStory {
    const order = this.stories().reduce((m, s) => Math.max(m, s.order), 0) + 1;
    const st: MStory = { id: uid(), name: name.trim() || 'Story', order };
    this.docs.set(STORY, st.id, st, 'Add story');
    return st;
  }
  renameStory(id: string, name: string) { const c = this.docs.get<MStory>(STORY, id); if (c && name.trim()) this.docs.set(STORY, id, { ...c, name: name.trim() }, 'Rename story'); }
  removeStory(id: string) {
    this.docs.batch('Delete story', () => {
      for (const i of this.items(id)) this.docs.set(ITEM, i.id, undefined);
      for (const r of this.docs.list<MRef>(REF).map((x) => x.value).filter((r) => r.storyId === id)) this.docs.set(REF, r.id, undefined);
      this.docs.set(STORY, id, undefined);
    });
  }

  /** Write a new order (0..n) for a list of items. */
  private renumber(list: MItem[]) { list.forEach((it, i) => { if (it.order !== i) this.docs.set(ITEM, it.id, { ...it, order: i }); }); }

  /** A new shot after `afterId` (an item of the story), or at the end. */
  addShot(storyId: string, name = '', afterId?: string | null): MShot {
    const sh = newShot(storyId, name.trim() || `Shot ${this.items(storyId).filter((i) => i.kind === 'shot').length + 1}`);
    this.docs.batch('Add shot', () => {
      const list = this.items(storyId); const at = afterId ? list.findIndex((i) => i.id === afterId) + 1 : list.length;
      // a new shot starts with the models, sizes, settings and length of the shot before it, so a 9:16 story stays 9:16
      const before = list.slice(0, at < 0 ? list.length : at).reverse().find((i): i is MShot => i.kind === 'shot');
      if (before) {
        const copy = <T,>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)) as T);
        sh.frame.profileId = before.frame.profileId; sh.frame.values = copy(before.frame.values);
        sh.clip.profileId = before.clip.profileId; sh.clip.values = copy(before.clip.values); sh.clip.seconds = before.clip.seconds;
      }
      list.splice(at < 0 ? list.length : at, 0, sh);
      list.forEach((it, i) => this.docs.set(ITEM, it.id, { ...it, order: i }));
    });
    return this.shot(sh.id)!;
  }
  /** A divider after `afterId` (null = at the very top, undefined = at the end). */
  addDivider(storyId: string, name: string, afterId?: string | null): MDivider {
    const dv: MDivider = { kind: 'divider', id: uid(), storyId, order: 0, name: name.trim() || 'Part', folded: false };
    this.docs.batch('Add divider', () => {
      const list = this.items(storyId);
      const at = afterId === null ? 0 : afterId ? list.findIndex((i) => i.id === afterId) + 1 : list.length;
      list.splice(at, 0, dv);
      list.forEach((it, i) => this.docs.set(ITEM, it.id, { ...it, order: i }));
    });
    return this.item(dv.id) as MDivider;
  }
  /** Divider from selected shots: a divider right above the first of them. */
  removeItem(id: string) {
    const it = this.item(id); if (!it) return;
    this.docs.batch(it.kind === 'divider' ? 'Delete divider' : 'Delete shot', () => { this.docs.set(ITEM, id, undefined); this.renumber(this.items(it.storyId)); });
  }
  /** Move an item before `beforeId` (null = to the end). A divider takes the shots under it (up to the next divider) along. */
  moveItem(id: string, beforeId: string | null) {
    const it = this.item(id); if (!it || id === beforeId) return;
    const list = this.items(it.storyId); const from = list.findIndex((i) => i.id === id);
    let span = 1;
    if (it.kind === 'divider') while (from + span < list.length && list[from + span]!.kind !== 'divider') span++;
    const moving = list.slice(from, from + span);
    if (beforeId && moving.some((m) => m.id === beforeId)) return;
    const rest = list.filter((i) => !moving.includes(i));
    const at = beforeId ? rest.findIndex((i) => i.id === beforeId) : rest.length;
    rest.splice(at < 0 ? rest.length : at, 0, ...moving);
    this.docs.batch('Move', () => this.renumber(rest));
  }
  setFolded(id: string, folded: boolean) { const it = this.item(id); if (it?.kind === 'divider') this.docs.set(ITEM, id, { ...it, folded }, folded ? 'Fold part' : 'Open part'); }
  renameItem(id: string, name: string) { const it = this.item(id); if (it && name.trim()) this.docs.set(ITEM, id, { ...it, name: name.trim() }, 'Rename'); }

  /** Change a shot: top-level fields, and the frame / clip steps field by field. */
  patchShot(id: string, patch: { name?: string; note?: string; seam?: Seam; frame?: Partial<MFrame>; clip?: Partial<MClip> }, label = 'Edit shot') {
    const sh = this.shot(id); if (!sh) return;
    const next: MShot = { ...sh, ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.note !== undefined ? { note: patch.note } : {}), ...(patch.seam ? { seam: patch.seam } : {}),
      frame: { ...sh.frame, ...(patch.frame ?? {}) }, clip: { ...sh.clip, ...(patch.clip ?? {}) } };
    this.docs.set(ITEM, id, next, label);
  }
  private inputsOf(sh: MShot, stage: 'frame' | 'clip'): FrameInput[] { return (stage === 'frame' ? sh.frame.inputs : sh.clip.inputs) ?? []; }
  private setInputs(shotId: string, stage: 'frame' | 'clip', inputs: FrameInput[], label: string) { this.patchShot(shotId, stage === 'frame' ? { frame: { inputs } } : { clip: { inputs } }, label); }
  addInput(shotId: string, inp: Omit<FrameInput, 'id' | 'on' | 'role'> & { role?: string }, stage: 'frame' | 'clip' = 'frame'): string | undefined {
    const sh = this.shot(shotId); if (!sh) return undefined;
    const cur = this.inputsOf(sh, stage);
    const have = cur.find((i) => i.asset === inp.asset); if (have) return have.id;
    const id = uid();
    this.setInputs(shotId, stage, [...cur, { id, on: true, role: inp.role ?? 'other', asset: inp.asset, source: inp.source, refId: inp.refId, ...(inp.use ? { use: inp.use } : {}) }], 'Add input');
    return id;
  }
  updateInput(shotId: string, inputId: string, patch: Partial<Pick<FrameInput, 'on' | 'role' | 'use' | 'asset'>>, stage: 'frame' | 'clip' = 'frame') {
    const sh = this.shot(shotId); if (!sh) return;
    this.setInputs(shotId, stage, this.inputsOf(sh, stage).map((i) => (i.id === inputId ? { ...i, ...patch } : i)), 'Edit input');
  }
  moveInput(shotId: string, inputId: string, dir: -1 | 1, stage: 'frame' | 'clip' = 'frame') {
    const sh = this.shot(shotId); if (!sh) return;
    const a = [...this.inputsOf(sh, stage)]; const i = a.findIndex((x) => x.id === inputId), j = i + dir;
    if (i < 0 || j < 0 || j >= a.length) return;
    [a[i], a[j]] = [a[j]!, a[i]!]; this.setInputs(shotId, stage, a, 'Reorder inputs');
  }
  removeInput(shotId: string, inputId: string, stage: 'frame' | 'clip' = 'frame') { const sh = this.shot(shotId); if (sh) this.setInputs(shotId, stage, this.inputsOf(sh, stage).filter((i) => i.id !== inputId), 'Remove input'); }
  /** The take chosen for a step (undefined = none). */
  setPick(shotId: string, stage: 'frame' | 'clip', asset: string | undefined) { this.patchShot(shotId, stage === 'frame' ? { frame: { pick: asset } } : { clip: { pick: asset } }, 'Pick'); }
  /** A picture or clip added by hand as a try of a step. */
  addExtra(shotId: string, stage: 'frame' | 'clip', asset: string) {
    const sh = this.shot(shotId); if (!sh) return; const st = stage === 'frame' ? sh.frame : sh.clip;
    if (st.extra.includes(asset)) return;
    this.patchShot(shotId, stage === 'frame' ? { frame: { extra: [...st.extra, asset] } } : { clip: { extra: [...st.extra, asset] } }, 'Add to shot');
  }
  removeExtra(shotId: string, stage: 'frame' | 'clip', asset: string) {
    const sh = this.shot(shotId); if (!sh) return; const st = stage === 'frame' ? sh.frame : sh.clip;
    const patch = { extra: st.extra.filter((a) => a !== asset), pick: st.pick === asset ? undefined : st.pick };
    this.patchShot(shotId, stage === 'frame' ? { frame: patch } : { clip: patch }, 'Remove from shot');
  }
  /** A divider above the first of these shots. */
  groupShots(storyId: string, shotIds: string[], name: string) {
    const list = this.items(storyId); const first = list.find((i) => shotIds.includes(i.id)); if (!first) return;
    const at = list.indexOf(first);
    this.addDivider(storyId, name, at === 0 ? null : list[at - 1]!.id);
  }

  addRef(storyId: string, name: string, group: string, asset: string): MRef | undefined {
    if (this.docs.list<MRef>(REF).some((r) => r.value.storyId === storyId && r.value.asset === asset)) return undefined;
    const order = this.docs.list<MRef>(REF).reduce((m, r) => Math.max(m, r.value.order), 0) + 1;
    const ref: MRef = { id: uid(), storyId, name: name.trim() || 'Reference', group: group.trim() || 'References', asset, order };
    this.docs.set(REF, ref.id, ref, 'Add to the shelf'); return ref;
  }
  updateRef(id: string, patch: Partial<Pick<MRef, 'name' | 'group'>>) { const r = this.docs.get<MRef>(REF, id); if (r) this.docs.set(REF, id, { ...r, ...patch }, 'Edit reference'); }
  removeRef(id: string) { this.docs.set(REF, id, undefined, 'Remove from the shelf'); }
  renameGroup(storyId: string, from: string, to: string) {
    const t = to.trim(); if (!t || t === from) return;
    this.docs.batch('Rename shelf group', () => { for (const r of this.docs.list<MRef>(REF).map((x) => x.value).filter((r) => r.storyId === storyId && r.group === from)) this.docs.set(REF, r.id, { ...r, group: t }); });
  }
}
