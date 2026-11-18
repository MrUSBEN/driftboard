import { randomUUID } from 'node:crypto';
import type { DocStore } from './docs.ts';

export type TakeStatus = 'draft' | 'approved' | 'rejected';
export interface Take { assetId: string; status: TakeStatus; note?: string; addedAt: string }
/** A story: a named set of scenes (a project can hold several; each has its own scenes, shots and takes). */
export interface StoryInfo { id: string; name: string; order: number; created: string; note?: string }
export interface Scene { id: string; name: string; order: number; storyId?: string; notes?: string; /** director scene id this scene was made from */ sourceId?: string }
export interface DialogueLine { speaker: string; line: string }
/** What the director planned for a shot (the model-agnostic brief). */
export interface ShotBrief { framing: string; move: string; action: string; dialogue: DialogueLine[]; seconds: number; characterIds: string[]; placeId?: string; propIds?: string[];
  /** see director ShotBrief: the clip's moments, whether it continues the previous clip as the same take, which part of a long shot it is, the state at its end */
  beats?: { action: string; dialogue: DialogueLine[]; seconds: number }[]; continues?: boolean; part?: { index: number; count: number; shot: number }; endState?: string }
export interface BibleData {
  style: string;
  characters: { id: string; name: string; look: string; refAsset?: string; voiceAsset?: string }[];
  places: { id: string; name: string; look: string; refAsset?: string }[];
  props?: { id: string; name: string; look: string; refAsset?: string }[];
}
export interface PlanShot { sourceId: string; name: string; brief: ShotBrief; prompt?: string; warnings?: string[]; /** reference pictures in <Picture n> order, as the prompt was written */ refs?: string[] }
export interface PlanScene { sourceId: string; name: string; notes?: string; shots: PlanShot[] }
export interface Shot {
  id: string; sceneId: string; name: string; order: number; notes?: string; tags: string[]; pick?: string; takes: Take[];
  /** director source id, brief and the prompt written for the chosen video profile */
  sourceId?: string; brief?: ShotBrief; prompt?: string; promptWarnings?: string[];
  /** the last prompt the director wrote, to tell whether the user has edited `prompt` since */
  generatedPrompt?: string;
  /** pictures that start (and optionally end) the clip: used when generating a take */
  frames?: { first?: string; last?: string };
  /** reference pictures (bible characters, place, props) in <Picture n> order; set by the director, editable. Undefined = work them out from the bible. */
  refs?: string[]; generatedRefs?: string[];
  /** extra video / audio references added by the user (motion or look to copy, a voice); a character's voice sample comes from the bible on top of these */
  media?: string[];
}
export interface AssetMeta { name?: string; tags?: string[]; note?: string; /** hidden from the Library (in the trash); the file and everything that uses it keep working */ trashed?: boolean }
export type ShotStatus = 'empty' | 'draft' | 'approved' | 'rejected';
export interface SceneTree { scene: Scene; shots: Shot[] }
/** A part of every prompt decided once for a story: film look, location, camera style, sound, music... (see director/blocks.ts). */
export interface PromptBlock { id: string; name: string; text: string }
/** Named and empty: what a project starts with (an empty block is not used). */
export const STARTER_BLOCKS: PromptBlock[] = [
  { id: 'look', name: 'Film look', text: '' }, { id: 'place', name: 'Location', text: '' }, { id: 'characters', name: 'Characters', text: '' },
  { id: 'camera', name: 'Camera style', text: '' }, { id: 'sound', name: 'Sound and ambience', text: '' }, { id: 'music', name: 'Background music', text: '' },
  { id: 'language', name: 'Dialogue language', text: '' },
];
const PROJECT_BLOCKS = 'project';

const STORY = 'story', SCENE = 'scene', SHOT = 'shot', META = 'asset_meta', BIBLE = 'bible', BLOCKS = 'film_blocks';
const uid = () => randomUUID().slice(0, 10);
const norm = (t: string) => t.trim().toLowerCase().replace(/\s+/g, '-');

/** Scenes > shots > takes, plus names and tags for assets. Every edit goes through the shared undo history. */
export class StoryStore {
  constructor(private docs: DocStore) {}

  scenes(storyId?: string): Scene[] { return this.docs.list<Scene>(SCENE).map((r) => r.value).filter((x) => !storyId || x.storyId === storyId).sort((a, b) => a.order - b.order); }

  /** The stories. Scenes made before stories existed are adopted into "Story 1" the first time this is called. */
  stories(): StoryInfo[] {
    const all = () => this.docs.list<StoryInfo>(STORY).map((r) => r.value).sort((a, b) => a.order - b.order);
    const orphans = this.docs.list<Scene>(SCENE).map((r) => r.value).filter((x) => !x.storyId);
    if (orphans.length) this.docs.batch('Group scenes into a story', () => {
      const st = all()[0] ?? this.addStory('Story 1');
      for (const sc of orphans) this.docs.set(SCENE, sc.id, { ...sc, storyId: st.id });
    });
    return all();
  }
  story(id: string): StoryInfo | undefined { return this.docs.get<StoryInfo>(STORY, id); }
  addStory(name = 'New story'): StoryInfo {
    const order = this.docs.list<StoryInfo>(STORY).reduce((m, r) => Math.max(m, r.value.order), 0) + 1;
    const st: StoryInfo = { id: uid(), name: name.trim() || 'New story', order, created: new Date().toISOString() };
    this.docs.set(STORY, st.id, st, 'Add story'); return st;
  }
  renameStory(id: string, name: string) { const c = this.story(id); if (c && name.trim()) this.docs.set(STORY, id, { ...c, name: name.trim() }, 'Rename story'); }
  /** Delete a story with its scenes and shots (the picture and video files stay in the Library). One undo step. */
  removeStory(id: string) {
    this.docs.batch('Delete story', () => {
      const ids = new Set(this.scenes(id).map((x) => x.id));
      for (const sh of this.shots().filter((x) => ids.has(x.sceneId))) this.docs.set(SHOT, sh.id, undefined);
      for (const sid of ids) this.docs.set(SCENE, sid, undefined);
      this.docs.set(STORY, id, undefined);
      if (this.docs.get(BLOCKS, id)) this.docs.set(BLOCKS, id, undefined);
    });
  }
  /** Story id to use when none is given: the first story, created if there is none. */
  private defaultStory(): string { return this.stories()[0]?.id ?? this.addStory('Story 1').id; }
  shots(): Shot[] { return this.docs.list<Shot>(SHOT).map((r) => r.value).sort((a, b) => a.order - b.order); }
  scene(id: string) { return this.docs.get<Scene>(SCENE, id); }
  shot(id: string) { return this.docs.get<Shot>(SHOT, id); }

  tree(storyId?: string): SceneTree[] {
    const shots = this.shots();
    return this.scenes(storyId).map((scene) => ({ scene, shots: shots.filter((s) => s.sceneId === scene.id) }));
  }

  addScene(name = 'New scene', storyId?: string): Scene {
    const order = this.scenes().reduce((m, s) => Math.max(m, s.order), 0) + 1;
    const scene: Scene = { id: uid(), name, order, storyId: storyId ?? this.defaultStory() };
    this.docs.set(SCENE, scene.id, scene, 'Add scene');
    return scene;
  }
  updateScene(id: string, patch: Partial<Omit<Scene, 'id'>>) { const c = this.scene(id); if (c) this.docs.set(SCENE, id, { ...c, ...patch }, 'Edit scene'); }

  /** Remove a scene. Its shots move to the previous scene, or are removed when it is the only one and has no takes. */
  removeScene(id: string) {
    this.docs.batch('Delete scene', () => {
      const scenes = this.scenes(this.scene(id)?.storyId); const i = scenes.findIndex((s) => s.id === id);
      const target = scenes[i - 1] ?? scenes[i + 1];
      for (const sh of this.shots().filter((s) => s.sceneId === id)) {
        if (target) this.docs.set(SHOT, sh.id, { ...sh, sceneId: target.id, order: this.nextShotOrder() });
        else this.docs.set(SHOT, sh.id, undefined);
      }
      this.docs.set(SCENE, id, undefined);
    });
  }

  /** Move a scene up (-1) or down (+1) by swapping order with its neighbour. */
  moveScene(id: string, dir: -1 | 1) {
    const s = this.scenes(this.scene(id)?.storyId); const i = s.findIndex((x) => x.id === id); const j = i + dir;
    if (i < 0 || j < 0 || j >= s.length) return;
    this.docs.batch('Move scene', () => { this.docs.set(SCENE, s[i]!.id, { ...s[i]!, order: s[j]!.order }); this.docs.set(SCENE, s[j]!.id, { ...s[j]!, order: s[i]!.order }); });
  }

  private nextShotOrder() { return this.shots().reduce((m, s) => Math.max(m, s.order), 0) + 1; }

  addShot(sceneId: string, name?: string): Shot | undefined {
    if (!this.scene(sceneId)) return undefined;
    const inScene = this.shots().filter((s) => s.sceneId === sceneId).length;
    const shot: Shot = { id: uid(), sceneId, name: name ?? `Shot ${inScene + 1}`, order: this.nextShotOrder(), tags: [], takes: [] };
    this.docs.set(SHOT, shot.id, shot, 'Add shot');
    return shot;
  }
  updateShot(id: string, patch: Partial<Pick<Shot, 'name' | 'notes' | 'tags' | 'prompt' | 'brief' | 'promptWarnings' | 'generatedPrompt' | 'frames' | 'refs' | 'generatedRefs' | 'media'>>, label = 'Edit shot') { const c = this.shot(id); if (c) this.docs.set(SHOT, id, { ...c, ...patch, ...(patch.tags ? { tags: [...new Set(patch.tags.map(norm).filter(Boolean))] } : {}) }, label); }
  removeShot(id: string) { this.docs.set(SHOT, id, undefined, 'Delete shot'); }

  /** Move a shot to another scene (or position inside the scene): index counts among that scene's shots. */
  moveShot(id: string, sceneId: string, index?: number) {
    const sh = this.shot(id); if (!sh || !this.scene(sceneId)) return;
    this.docs.batch('Move shot', () => {
      const others = this.shots().filter((s) => s.sceneId === sceneId && s.id !== id);
      const at = index === undefined ? others.length : Math.max(0, Math.min(index, others.length));
      const list = [...others.slice(0, at), { ...sh, sceneId }, ...others.slice(at)];
      // re-number the whole scene using the global order slots it already occupies
      const slots = [...list.map((s) => s.order)].sort((a, b) => a - b);
      const max = this.nextShotOrder();
      list.forEach((s, k) => this.docs.set(SHOT, s.id, { ...s, sceneId, order: slots[k] === undefined ? max + k : slots[k]! }));
    });
  }

  /** Make an asset a take of a shot (also removes it from any other shot: an asset belongs to one shot). */
  addTake(shotId: string, assetId: string, status: TakeStatus = 'draft') {
    if (!this.shot(shotId)) return;
    this.docs.batch('Add take', () => {
      for (const s of this.shots()) if (s.id !== shotId && s.takes.some((t) => t.assetId === assetId)) this.dropTake(s, assetId);
      const sh = this.shot(shotId)!;
      if (sh.takes.some((t) => t.assetId === assetId)) return;
      // the first take of a shot is its pick until the user chooses another (so a generated story can go straight to the timeline)
      this.docs.set(SHOT, shotId, { ...sh, takes: [...sh.takes, { assetId, status, addedAt: new Date().toISOString() }], pick: sh.pick ?? (status === 'rejected' ? undefined : assetId) });
    });
  }
  private dropTake(s: Shot, assetId: string) {
    this.docs.set(SHOT, s.id, { ...s, takes: s.takes.filter((t) => t.assetId !== assetId), pick: s.pick === assetId ? undefined : s.pick });
  }
  removeTake(shotId: string, assetId: string) { const s = this.shot(shotId); if (s) { this.docs.batch('Remove take', () => this.dropTake(s, assetId)); } }

  setTakeStatus(shotId: string, assetId: string, status: TakeStatus) {
    const s = this.shot(shotId); if (!s) return;
    this.docs.set(SHOT, shotId, { ...s, takes: s.takes.map((t) => (t.assetId === assetId ? { ...t, status } : t)), pick: status === 'rejected' && s.pick === assetId ? undefined : s.pick }, 'Take status');
  }
  setTakeNote(shotId: string, assetId: string, note: string) {
    const s = this.shot(shotId); if (s) this.docs.set(SHOT, shotId, { ...s, takes: s.takes.map((t) => (t.assetId === assetId ? { ...t, note } : t)) }, 'Take note');
  }

  /** The pick is the take that feeds the timeline. Picking approves it. One per shot; pass undefined to clear. */
  setPick(shotId: string, assetId: string | undefined) {
    const s = this.shot(shotId); if (!s || (assetId && !s.takes.some((t) => t.assetId === assetId))) return;
    this.docs.set(SHOT, shotId, { ...s, pick: assetId, takes: s.takes.map((t) => (t.assetId === assetId ? { ...t, status: 'approved' as const } : t)) }, 'Pick take');
  }

  status(s: Shot): ShotStatus {
    if (!s.takes.length) return 'empty';
    if (s.pick) return 'approved';
    if (s.takes.every((t) => t.status === 'rejected')) return 'rejected';
    return 'draft';
  }

  shotOfAsset(assetId: string): Shot | undefined { return this.shots().find((s) => s.takes.some((t) => t.assetId === assetId)); }

  /** Picked assets in story order (scene order, then shot order): what the timeline should contain. */
  picks(): { shotId: string; assetId: string }[] {
    const out: { shotId: string; assetId: string }[] = [];
    for (const { shots } of this.tree()) for (const s of shots) if (s.pick) out.push({ shotId: s.id, assetId: s.pick });
    return out;
  }

  // ---- story bible (style, character and place looks) ----
  bible(): BibleData | undefined { return this.docs.get<BibleData>(BIBLE, 'main'); }
  setBible(b: BibleData) { this.docs.set(BIBLE, 'main', b, 'Edit bible'); }

  // ---- film blocks: each story may have its own set; otherwise it uses the project's default ----
  blocks(storyId?: string): { blocks: PromptBlock[]; source: 'story' | 'project' | 'starter' } {
    const own = storyId ? this.docs.get<PromptBlock[]>(BLOCKS, storyId) : undefined;
    if (own) return { blocks: own, source: 'story' };
    const proj = this.docs.get<PromptBlock[]>(BLOCKS, PROJECT_BLOCKS);
    if (proj) return { blocks: proj, source: 'project' };
    return { blocks: STARTER_BLOCKS.map((b) => ({ ...b })), source: 'starter' };
  }
  /** `scope` is a story id, or 'project' for the default every story without its own set uses. */
  setBlocks(scope: string, blocks: PromptBlock[]) {
    const seen = new Set<string>();
    const clean = blocks.map((b) => ({ id: (b.id || norm(b.name) || uid()).slice(0, 40), name: b.name.trim() || 'Block', text: b.text ?? '' }))
      .filter((b) => (seen.has(b.id) ? false : (seen.add(b.id), true)));
    this.docs.set(BLOCKS, scope, clean, scope === PROJECT_BLOCKS ? 'Edit project film blocks' : 'Edit film blocks');
  }
  /** The story goes back to the project's default blocks. */
  clearBlocks(storyId: string) { this.docs.set(BLOCKS, storyId, undefined, 'Use the project film blocks'); }

  /**
   * Put a director plan into the story in one undo step. Scenes and shots are matched by their source ids:
   * existing ones keep their takes, pick, notes and tags and only get the new brief and prompt (a prompt the user
   * edited is kept when `keepEditedPrompts` is set and it differs from the last generated one); new ones are added.
   */
  importPlan(scenes: PlanScene[], opts: { keepEditedPrompts?: boolean; storyId?: string } = {}): { scenesAdded: number; shotsAdded: number; shotsUpdated: number } {
    const res = { scenesAdded: 0, shotsAdded: 0, shotsUpdated: 0 };
    this.docs.batch('Import director plan', () => {
      for (const ps of scenes) {
        let scene = this.scenes(opts.storyId).find((s) => s.sourceId === ps.sourceId);
        if (!scene) { scene = this.addScene(ps.name, opts.storyId); this.docs.set(SCENE, scene.id, { ...scene, sourceId: ps.sourceId, notes: ps.notes ?? scene.notes }); scene = this.scene(scene.id)!; res.scenesAdded++; }
        else this.docs.set(SCENE, scene.id, { ...scene, name: ps.name, notes: ps.notes ?? scene.notes });
        ps.shots.forEach((p, i) => {
          const cur = this.shots().find((s) => s.sceneId === scene!.id && s.sourceId === p.sourceId);
          if (!cur) {
            const sh = this.addShot(scene!.id, p.name)!;
            this.docs.set(SHOT, sh.id, { ...this.shot(sh.id)!, sourceId: p.sourceId, brief: p.brief, prompt: p.prompt, generatedPrompt: p.prompt, promptWarnings: p.warnings, refs: p.refs, generatedRefs: p.refs });
            res.shotsAdded++;
          } else {
            const keep = opts.keepEditedPrompts && cur.prompt && cur.prompt !== cur.generatedPrompt;
            this.docs.set(SHOT, cur.id, { ...cur, name: !cur.name || /^Shot \d+( · part \d+\/\d+| \(continued\))?$/.test(cur.name) ? p.name : cur.name, brief: p.brief, prompt: keep ? cur.prompt : p.prompt ?? cur.prompt, generatedPrompt: p.prompt ?? cur.generatedPrompt, promptWarnings: p.warnings, ...(p.refs ? (JSON.stringify(cur.refs ?? null) === JSON.stringify(cur.generatedRefs ?? null) ? { refs: p.refs } : {}) : {}), generatedRefs: p.refs ?? cur.generatedRefs });
            res.shotsUpdated++;
          }
        });
      }
    });
    return res;
  }

  // ---- names and tags for any asset ----
  meta(assetId: string): AssetMeta { return this.docs.get<AssetMeta>(META, assetId) ?? {}; }
  allMeta(): Map<string, AssetMeta> { return new Map(this.docs.list<AssetMeta>(META).map((r) => [r.id, r.value])); }
  setMeta(assetId: string, patch: AssetMeta) {
    const cur = this.meta(assetId);
    const next: AssetMeta = { ...cur, ...patch, ...(patch.tags ? { tags: [...new Set(patch.tags.map(norm).filter(Boolean))] } : {}) };
    const empty = !next.name && !next.note && !(next.tags?.length) && !next.trashed;
    this.docs.set(META, assetId, empty ? undefined : next, 'Edit asset');
  }
  /** Library delete / restore: one undo step for any number of assets. */
  trashAssets(ids: string[], on: boolean) { this.docs.batch(on ? 'Delete from library' : 'Restore from library', () => { for (const id of ids) this.setMeta(id, { trashed: on }); }); }
  /** Sequential bulk rename: names are given in order, one undo step. */
  renameMany(items: { id: string; name: string }[]) { this.docs.batch('Rename assets', () => { for (const it of items) this.setMeta(it.id, { name: it.name.trim() || undefined }); }); }
  /** Add tags to many assets at once, one undo step. */
  tagMany(ids: string[], tags: string[]) { this.docs.batch('Tag assets', () => { for (const id of ids) this.setMeta(id, { tags: [...(this.meta(id).tags ?? []), ...tags] }); }); }
  addTag(assetId: string, tag: string) { const t = norm(tag); if (t) this.setMeta(assetId, { tags: [...(this.meta(assetId).tags ?? []), t] }); }
  removeTag(assetId: string, tag: string) { this.setMeta(assetId, { tags: (this.meta(assetId).tags ?? []).filter((x) => x !== tag) }); }
  allTags(): { tag: string; count: number }[] {
    const m = new Map<string, number>();
    for (const v of this.allMeta().values()) for (const t of v.tags ?? []) m.set(t, (m.get(t) ?? 0) + 1);
    for (const s of this.shots()) for (const t of s.tags) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }
}

/** Plain-text search helper: every word must appear somewhere in the haystack (case-insensitive). */
export function matches(query: string, ...parts: (string | undefined)[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = parts.filter(Boolean).join(' ').toLowerCase();
  return words.every((w) => hay.includes(w));
}
