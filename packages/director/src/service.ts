import type { LlmClient } from '@driftboard/adapter-llm';
import { parseScript } from './parse.ts';
import { lintPrompt } from './enhance.ts';
import { compactBible, interpretScript, makeBible, makePrompt, makeScenes, makeShots, sceneInputFromIdea, sceneInputFromParsed, type SceneInput } from './stages.ts';
import type { GuideFn, Bible, ParsedScript, PromptResult, RefInfo, SceneIdea, ShotBrief, TargetProfile } from './types.ts';

export type Step = 'bible' | 'scenes' | 'shots' | 'prompts';
export interface ShotsEntry { shots: ShotBrief[]; warnings: string[] }
export interface PromptEntry { prompt: string; warnings: string[]; /** asset ids of the reference pictures, in <Picture n> order */ refs: string[]; /** asset ids of the voice samples sent along, in <Audio n> order */ audioRefs?: string[]; edited?: boolean }

export interface DirectorState {
  scriptText: string; style: string; targetId?: string;
  /** the user's text rewritten as a screenplay by the LLM, shown for checking and editing; "Use this script" parses it */ interpreted?: string;
  /** the name of this director project (editable; the LLM suggests one) and the story it was sent to */
  name?: string; storyId?: string;
  parsed?: ParsedScript; bible?: Bible; scenes?: SceneIdea[];
  /** by scene id */ shots: Record<string, ShotsEntry>;
  /** by "sceneId:shotIndex" */ prompts: Record<string, PromptEntry>;
  /** which steps the user has reviewed and accepted */ accepted: Partial<Record<Step, boolean>>;
  log: string[];
}
export interface Progress { step: Step; done: number; total: number; label: string; running: boolean; error?: string }
export interface DirectorDeps {
  llm: LlmClient;
  load(): string | null; save(json: string): void;
  target(id?: string): TargetProfile | undefined;
  emit(p: Progress): void;
  guides?: GuideFn;
  /** called before each LLM call group, e.g. to load the model */
  prepare?(): Promise<void>;
}
export const emptyState = (): DirectorState => ({ scriptText: '', style: '', shots: {}, prompts: {}, accepted: {}, log: [] });

const key = (sceneId: string, i: number) => `${sceneId}:${i}`;

/** Runs the pipeline one narrow LLM call at a time, keeps every result editable, and saves after each call. */
export class DirectorService {
  state: DirectorState;
  private abort: AbortController | null = null;
  constructor(private d: DirectorDeps) {
    let s = emptyState();
    try { const raw = d.load(); if (raw) s = { ...emptyState(), ...JSON.parse(raw) }; } catch { /* start clean */ }
    this.state = s;
  }

  private persist() { this.d.save(JSON.stringify(this.state)); }
  get running() { return !!this.abort; }
  cancel() { this.abort?.abort(); }

  /** New script: parse it (no LLM) and clear everything downstream. */
  setScript(text: string, style = this.state.style) {
    this.state = { ...emptyState(), scriptText: text, style, targetId: this.state.targetId, parsed: parseScript(text) };
    this.persist(); return this.state;
  }
  /** Ask the LLM to rewrite the user's text as a clean script. Nothing downstream changes until the user accepts it. */
  async interpret(text: string) {
    if (this.abort) throw new Error('The director is already working.');
    this.state.scriptText = text;
    const ac = new AbortController(); this.abort = ac; const prev = this.d.llm.signal; this.d.llm.signal = ac.signal;
    try { await this.d.prepare?.(); this.state.interpreted = await interpretScript(this.d.llm, text, this.d.guides); }
    catch (e) { throw new Error(ac.signal.aborted ? 'Cancelled' : (e as Error).message); }
    finally { this.d.llm.signal = prev; this.abort = null; }
    this.persist(); return this.state;
  }
  /** The user's edits of the interpreted script. */
  setInterpreted(text: string) { this.state.interpreted = text; this.persist(); return this.state; }
  /** Use the interpreted script: parse it (it is Fountain, so scenes, places and dialogue are exact) and clear everything downstream. */
  useInterpreted(style = this.state.style) {
    const t = this.state.interpreted ?? ''; if (!t.trim()) throw new Error('There is no interpreted script yet.');
    this.state = { ...emptyState(), scriptText: this.state.scriptText, interpreted: t, style, targetId: this.state.targetId, name: this.state.name, parsed: parseScript(t) };
    this.persist(); return this.state;
  }
  /** Start over (keeps the chosen video model), or load a saved state. */
  reset() { this.state = { ...emptyState(), targetId: this.state.targetId }; this.persist(); return this.state; }
  loadState(s: DirectorState) { this.state = { ...emptyState(), ...s, targetId: s.targetId ?? this.state.targetId }; this.persist(); return this.state; }
  setTarget(id: string) { this.state.targetId = id; this.persist(); }

  /** The user's edits (bible text, scene summaries, shot briefs, prompts). Edited prompts are marked so a re-run can skip them. */
  update(patch: Partial<Pick<DirectorState, 'bible' | 'scenes' | 'shots' | 'prompts' | 'style' | 'accepted' | 'name' | 'storyId'>>) {
    if (patch.prompts) for (const [k, v] of Object.entries(patch.prompts)) {
      const old = this.state.prompts[k];
      if (old && old.prompt !== v.prompt) {
        v.edited = true;
        const [sid, idx] = [k.slice(0, k.lastIndexOf(':')), Number(k.slice(k.lastIndexOf(':') + 1))];
        v.warnings = lintPrompt(v.prompt, { dialogue: this.state.shots[sid]?.shots[idx]?.dialogue ?? [] }, []).warnings.filter((w) => /missing from the prompt/.test(w));   // the old warnings were about the old text
      }
    }
    Object.assign(this.state, patch); this.persist(); return this.state;
  }

  private sceneInputs(): SceneInput[] {
    const s = this.state; const bible = this.bible();
    if (s.parsed?.mode === 'screenplay') return s.parsed.scenes.map((x) => sceneInputFromParsed(x, bible));
    if (!s.scenes?.length && s.parsed) return [{ id: 's1', heading: s.parsed.title ?? 'Story', text: s.parsed.text, characterIds: [] }];   // no scene split yet: the whole text is one scene
    return (s.scenes ?? []).map(sceneInputFromIdea);
  }
  sceneList() { return this.sceneInputs(); }
  /** The bible, or an empty one with just the style: no step is blocked because the bible was not written. */
  private bible(): Bible { return this.state.bible ?? { style: this.state.style, characters: [], places: [] }; }

  private refsFor(shot: ShotBrief, target: TargetProfile): { refs: RefInfo[]; assets: string[]; audios: string[] } {
    const b = this.bible(); const refs: RefInfo[] = [], assets: string[] = [];
    if (target.firstFrame) refs.push({ n: 1, role: 'the literal first frame of the shot (supplied by the user later)' });
    const audios: string[] = [];
    if (shot.promptMode === 'text') return { refs, assets, audios };   // asked for a pure text prompt
    // what is in the shot, best first: its characters, then the place, then props (a model that takes no reference pictures gets none; the looks are in the prompt text)
    const els: { name: string; role: string; asset?: string }[] = [
      ...shot.characterIds.map((id) => b.characters.find((x) => x.id === id)).filter((x) => !!x).map((c) => ({ name: c!.name, role: 'reference picture of the character', asset: c!.refAsset })),
      ...(shot.placeId ? [b.places.find((x) => x.id === shot.placeId)].filter((x) => !!x).map((p) => ({ name: p!.name, role: 'reference picture of the place', asset: p!.refAsset })) : []),
      ...(shot.propIds ?? []).map((id) => (b.props ?? []).find((x) => x.id === id)).filter((x) => !!x).map((p) => ({ name: p!.name, role: 'reference picture of the prop', asset: p!.refAsset })),
    ];
    for (const e of els) if (e.asset && !assets.includes(e.asset) && assets.length < target.maxRefs) { refs.push({ n: refs.length + 1, name: e.name, role: e.role }); assets.push(e.asset); }
    // a character's voice sample goes along as <Audio n> when the model takes reference audio, so the voice stays the same in every shot
    for (const id of shot.characterIds) {
      const c = b.characters.find((x) => x.id === id);
      if (c?.voiceAsset && !audios.includes(c.voiceAsset) && audios.length < (target.maxAudioRefs ?? 0)) { audios.push(c.voiceAsset); refs.push({ n: audios.length, tag: 'Audio', name: c.name, role: `the voice of ${c.name}: every line ${c.name} speaks must be in exactly this voice (name <Audio ${audios.length}> where that voice is introduced)` }); }
    }
    return { refs, assets, audios };
  }

  /**
   * Run one step. `only` limits shots/prompts to one scene id, or one "sceneId:index" prompt.
   * Existing results are replaced, except prompts the user edited (kept unless `force`).
   */
  async run(step: Step, opts: { only?: string | string[]; force?: boolean } = {}): Promise<DirectorState> {
    const only = Array.isArray(opts.only) ? opts.only : opts.only ? [opts.only] : null;   // scene ids, or "sceneId:index" prompt keys
    if (this.abort) throw new Error('The director is already working.');
    const s = this.state, ac = new AbortController(); this.abort = ac;
    const prevSignal = this.d.llm.signal; this.d.llm.signal = ac.signal;
    const emit = (p: Partial<Progress> & Pick<Progress, 'done' | 'total' | 'label'>) => this.d.emit({ step, running: true, ...p });
    try {
      if (!s.parsed) throw new Error('Paste or import a script first.');
      await this.d.prepare?.();
      if (step === 'bible') {
        emit({ done: 0, total: 1, label: 'Writing the story bible' });
        const r = await makeBible(this.d.llm, s.parsed, { style: s.style }, this.d.guides);
        const old = s.bible;
        // keep reference pictures the user already attached to characters
        for (const c of r.bible.characters) { const o = old?.characters.find((x) => x.id === c.id); if (o?.refAsset) c.refAsset = o.refAsset; if (o?.voiceAsset) c.voiceAsset = o.voiceAsset; if (o?.gen) c.gen = o.gen; }
        for (const c of r.bible.places) { const o = old?.places?.find((x) => x.id === c.id); if (o?.refAsset) c.refAsset = o.refAsset; if (o?.gen) c.gen = o.gen; }
        if (old?.props?.length) r.bible.props = old.props;
        s.bible = r.bible; s.log = [...r.warnings]; s.accepted.bible = false; this.persist();
      } else if (step === 'scenes') {
        if (s.parsed.mode === 'screenplay') throw new Error('This script already has scenes.');
        emit({ done: 0, total: 1, label: 'Splitting the story into scenes' });
        const r = await makeScenes(this.d.llm, s.parsed, this.bible(), this.d.guides);
        s.scenes = r.scenes; s.log = r.warnings; s.shots = {}; s.prompts = {}; this.persist();
      } else if (step === 'shots') {
        const target = this.d.target(s.targetId); if (!target) throw new Error('Choose the video model first.');
        const list = this.sceneInputs().filter((x) => !only || only.includes(x.id));
        if (!list.length) throw new Error('There are no scenes yet.');
        for (const [i, sc] of list.entries()) {
          emit({ done: i, total: list.length, label: `Planning shots: ${sc.heading || sc.id}` });
          const r = await makeShots(this.d.llm, sc, this.bible(), target, this.d.guides);
          s.shots[sc.id] = { shots: r.shots, warnings: r.warnings };
          for (const k of Object.keys(s.prompts)) if (k.startsWith(sc.id + ':')) delete s.prompts[k];
          this.persist();
        }
      } else {
        const target = this.d.target(s.targetId); if (!target) throw new Error('Choose the video model first.');
        const jobs: { sc: SceneInput; i: number }[] = [];
        for (const sc of this.sceneInputs()) {
          (s.shots[sc.id]?.shots ?? []).forEach((_, i) => { if (!only || only.includes(sc.id) || only.includes(key(sc.id, i))) jobs.push({ sc, i }); });
        }
        if (!jobs.length) throw new Error('Plan the shots first.');
        let n = 0;
        for (const { sc, i } of jobs) {
          const k = key(sc.id, i), cur = s.prompts[k];
          emit({ done: n++, total: jobs.length, label: `Writing prompt ${n} of ${jobs.length}` });
          if (cur?.edited && !opts.force) continue;
          const shots = s.shots[sc.id]!.shots, shot = shots[i]!;
          const { refs, assets, audios } = this.refsFor(shot, target);
          if (shot.promptMode === 'refs' && (target.maxRefs === 0 || !assets.length)) {   // asked for reference pictures but there are none: say so instead of guessing
            s.prompts[k] = { prompt: '', warnings: [target.maxRefs === 0 ? 'This model takes no reference pictures: choose "text only" or another model.' : 'This shot is set to use reference pictures, but its characters have none: add pictures in the Bible (or choose "text only").'], refs: [] };
            this.persist(); continue;
          }
          let r: PromptResult;
          try { r = await makePrompt(this.d.llm, { shot, scene: sc, bible: this.bible(), target, refs, previous: shots[i - 1], index: i }); }
          catch (e) { if (ac.signal.aborted) throw e; s.prompts[k] = { prompt: '', warnings: [(e as Error).message], refs: assets, audioRefs: audios }; this.persist(); continue; }
          s.prompts[k] = { prompt: r.prompt, warnings: r.warnings, refs: assets, audioRefs: audios };
          this.persist();
        }
      }
      this.d.emit({ step, running: false, done: 1, total: 1, label: 'Done' });
    } catch (e) {
      const msg = ac.signal.aborted ? 'Cancelled' : (e as Error).message;
      this.d.emit({ step, running: false, done: 0, total: 1, label: msg, error: msg });
      throw new Error(msg);
    } finally { this.d.llm.signal = prevSignal; this.abort = null; }
    return this.state;
  }

  /** What to put into the story: scenes with shots (brief and prompt), ready for StoryStore.importPlan. */
  buildPlan() {
    const s = this.state;
    return this.sceneInputs().map((sc) => ({
      sourceId: sc.id, name: sc.heading || sc.id, notes: s.parsed?.mode === 'loose' ? sc.text : undefined,
      shots: (s.shots[sc.id]?.shots ?? []).map((b, i) => ({
        sourceId: `${sc.id}-${i + 1}`, name: `Shot ${i + 1}`, brief: b,
        prompt: s.prompts[key(sc.id, i)]?.prompt || undefined, warnings: s.prompts[key(sc.id, i)]?.warnings, refs: s.prompts[key(sc.id, i)]?.refs?.length ? s.prompts[key(sc.id, i)]!.refs : undefined,
      })),
    }));
  }
  /** Reference asset ids written into a shot's prompt, in <Picture n> order. */
  refsOf(sceneId: string, i: number): string[] { return this.state.prompts[key(sceneId, i)]?.refs ?? []; }
  bibleSummary() { return this.state.bible ? compactBible(this.state.bible) : ''; }
}
