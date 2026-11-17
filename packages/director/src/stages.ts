import { z } from 'zod';
import { fill, snap, snapNumber, type LlmClient } from '@driftboard/adapter-llm';
import { enhancePrompt } from './enhance.ts';
import { FRAMINGS, MOVES, type GuideFn, type Bible, type DialogueLine, type ParsedScene, type ParsedScript, type PromptResult, type RefInfo, type SceneIdea, type ShotBrief, type TargetProfile } from './types.ts';
import { sceneText, uniqueId, slugify, spokenLines } from './parse.ts';

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
const schemaOf = (s: z.ZodType) => z.toJSONSchema(s, { target: 'draft-7' }) as object;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '\n[...]' : s);

export const FRAMING_WORDS: [RegExp, (typeof FRAMINGS)[number]][] = [
  [/extreme|ecu|macro|detail/i, 'extreme-close'], [/over.?the.?shoulder|ots/i, 'over-the-shoulder'], [/top.?down|overhead|bird/i, 'top-down'],
  [/low/i, 'low-angle'], [/high/i, 'high-angle'], [/close|cu\b/i, 'close'], [/medium|mid|waist|two.?shot/i, 'medium'], [/wide|establish|long|full/i, 'wide'],
];
export const MOVE_WORDS: [RegExp, (typeof MOVES)[number]][] = [
  [/push|dolly.?in|in\b|forward|approach|zoom in/i, 'push-in'], [/pull|back|reveal|retreat|zoom out/i, 'pull-back'], [/orbit|arc|circle/i, 'orbit'],
  [/crane|rise|boom|jib/i, 'crane'], [/track|truck|follow|lateral|dolly/i, 'tracking'], [/hand.?held|shaky/i, 'handheld'], [/rack|focus/i, 'rack-focus'],
  [/pan/i, 'pan'], [/tilt/i, 'tilt'], [/static|still|locked|tripod|none/i, 'static'],
];

const FALLBACK: Record<string, string> = {
  'director-bible': 'Write a short visual story bible (style, characters, places) for the script. Visual details only.',
  'director-scenes': 'Break the story into 3 to 12 scenes in story order.',
  'director-shots': 'Break the scene into at most {{maxShots}} shots. framing: one of {{framings}}. move: one of {{moves}}. seconds: one of {{seconds}}.',
};
/** Instruction text for a stage: the guide file if there is one, else a one-line fallback. */
export function guideText(guides: GuideFn | undefined, id: string, vars: Record<string, string | number> = {}): string {
  return fill(guides?.(id)?.body ?? FALLBACK[id] ?? '', vars);
}

/* ---------------------------------------------------------------- Bible */

const BibleOut = z.object({
  style: z.string().describe('One sentence: medium, palette, lighting, lens feel'),
  characters: z.array(z.object({ name: z.string(), look: z.string().describe('40-70 words, visual only') })),
  places: z.array(z.object({ name: z.string(), look: z.string().describe('30-60 words, visual only') })),
});

export async function makeBible(llm: LlmClient, script: ParsedScript, hint: { style?: string } = {}, guides?: GuideFn): Promise<{ bible: Bible; warnings: string[] }> {
  const places = [...new Set(script.scenes.map((s) => s.place).filter(Boolean))];
  const system = guideText(guides, 'director-bible');
  const user = [
    script.title ? `Title: ${script.title}` : '',
    hint.style ? `Requested style: ${hint.style}` : '',
    script.characters.length ? `Characters (use these names): ${script.characters.join(', ')}` : 'Characters: find the characters in the script and name them.',
    places.length ? `Places (use these names): ${places.join('; ')}` : 'Places: find the distinct locations in the script and name them.',
    '', 'SCRIPT:', clip(script.text, 12000),
  ].filter((x) => x !== '').join('\n');
  const { value, attempts } = await llm.json({
    system, user, schema: schemaOf(BibleOut), temperature: 0.5, maxTokens: 3000,
    validate: (raw) => {
      const p = BibleOut.safeParse(raw);
      if (!p.success) throw new Error('the JSON must have "style", "characters" and "places" with name and look');
      if (!p.data.style.trim()) throw new Error('"style" is empty');
      return p.data;
    },
  });
  const warnings: string[] = attempts > 1 ? ['The LLM needed a second try for the bible.'] : [];
  const take = new Set<string>(), tp = new Set<string>();
  const characters = value.characters.filter((c) => str(c.name)).map((c) => ({ id: uniqueId(c.name, take), name: str(c.name), look: str(c.look) }));
  for (const n of script.characters) if (!characters.some((c) => c.name.toLowerCase() === n.toLowerCase())) { characters.push({ id: uniqueId(n, take), name: n, look: '' }); warnings.push(`The LLM did not describe ${n}; write their look by hand.`); }
  const placesOut = value.places.filter((p) => str(p.name)).map((p) => ({ id: uniqueId(p.name, tp), name: str(p.name), look: str(p.look) }));
  for (const c of characters) if (c.look && (words(c.look) < 15 || words(c.look) > 120)) warnings.push(`${c.name}'s look is ${words(c.look)} words (40-70 works best).`);
  return { bible: { style: str(value.style), characters, places: placesOut }, warnings };
}

/* ---------------------------------------------------------------- Scenes (loose ideas) */

const ScenesOut = z.object({ scenes: z.array(z.object({ title: z.string(), summary: z.string(), place: z.string().optional(), characters: z.array(z.string()).optional() })).min(1) });

export async function makeScenes(llm: LlmClient, script: ParsedScript, bible: Bible, guides?: GuideFn): Promise<{ scenes: SceneIdea[]; warnings: string[] }> {
  const system = guideText(guides, 'director-scenes');
  const user = [`Characters: ${bible.characters.map((c) => c.name).join(', ') || '(none given)'}`, `Places: ${bible.places.map((p) => p.name).join('; ') || '(none given)'}`, '', 'STORY:', clip(script.text, 12000)].join('\n');
  const { value } = await llm.json({
    system, user, schema: schemaOf(ScenesOut), temperature: 0.4, maxTokens: 2500,
    validate: (raw) => { const p = ScenesOut.safeParse(Array.isArray(raw) ? { scenes: raw } : raw); if (!p.success) throw new Error('the JSON must be {"scenes":[{"title","summary","place","characters"}]}'); return p.data; },
  });
  const warnings: string[] = [];
  const idOf = (name: string | undefined, list: { id: string; name: string }[]) => list.find((x) => x.name.toLowerCase() === (name ?? '').toLowerCase())?.id;
  const taken = new Set<string>();
  const scenes: SceneIdea[] = value.scenes.slice(0, 20).map((s, i) => ({
    id: uniqueId(`s${i + 1}`, taken), title: str(s.title) || `Scene ${i + 1}`, summary: str(s.summary),
    placeId: idOf(s.place, bible.places),
    characterIds: (s.characters ?? []).map((n) => idOf(n, bible.characters)).filter((x): x is string => !!x),
  }));
  if (scenes.some((s) => !s.summary)) warnings.push('Some scenes have no summary.');
  return { scenes, warnings };
}

/* ---------------------------------------------------------------- Shots */

const ShotsOut = z.object({
  shots: z.array(z.object({
    framing: z.string(), move: z.string(), action: z.string(),
    dialogue: z.array(z.object({ speaker: z.string(), line: z.string() })).optional(),
    seconds: z.union([z.number(), z.string()]), characters: z.array(z.string()).optional(), props: z.array(z.string()).optional(),
  })).min(1),
});

export interface SceneInput { id: string; heading: string; text: string; placeId?: string; characterIds?: string[] }
export function sceneInputFromParsed(s: ParsedScene, bible: Bible): SceneInput {
  const place = bible.places.find((p) => p.name.toLowerCase() === s.place.toLowerCase());
  return { id: s.id, heading: s.heading, text: sceneText(s), placeId: place?.id, characterIds: s.characters.map((n) => bible.characters.find((c) => c.name.toLowerCase() === n.toLowerCase())?.id).filter((x): x is string => !!x) };
}
export function sceneInputFromIdea(s: SceneIdea): SceneInput { return { id: s.id, heading: s.title, text: s.summary, placeId: s.placeId, characterIds: s.characterIds }; }

export const compactBible = (bible: Bible, charIds?: string[], placeId?: string) => [
  `Style: ${bible.style}`,
  ...bible.characters.filter((c) => !charIds || !charIds.length || charIds.includes(c.id)).map((c) => `Character ${c.name}: ${c.look}`),
  ...bible.places.filter((p) => !placeId || p.id === placeId).map((p) => `Place ${p.name}: ${p.look}`),
  ...(bible.props ?? []).map((p) => `Prop ${p.name}: ${p.look}`),
].join('\n');

/** Split long scene text into chunks that fit one call; split on line boundaries. */
export function chunkScene(text: string, maxChars = 2200): string[] {
  if (text.length <= maxChars) return [text];
  const out: string[] = []; let cur = '';
  for (const line of text.split('\n')) { if (cur && cur.length + line.length > maxChars) { out.push(cur); cur = ''; } cur += (cur ? '\n' : '') + line; }
  if (cur) out.push(cur);
  return out;
}

export async function makeShots(llm: LlmClient, scene: SceneInput, bible: Bible, target: TargetProfile, guides?: GuideFn): Promise<{ shots: ShotBrief[]; warnings: string[] }> {
  const maxShots = target.maxShotsPerCall ?? 6;
  const system = guideText(guides, 'director-shots', { maxShots, framings: FRAMINGS.join(', '), moves: MOVES.join(', '), seconds: target.seconds.join(', ') });
  const chunks = chunkScene(scene.text);
  const shots: ShotBrief[] = []; const warnings: string[] = [];
  let carry = '';
  for (const [ci, chunk] of chunks.entries()) {
    const user = [
      compactBible(bible, scene.characterIds, scene.placeId), '',
      chunks.length > 1 ? `SCENE "${scene.heading}" (part ${ci + 1} of ${chunks.length})${carry ? `\nPrevious shot: ${carry}` : ''}:` : `SCENE "${scene.heading}":`,
      chunk,
    ].join('\n');
    const { value } = await llm.json({
      system, user, schema: schemaOf(ShotsOut), temperature: 0.4, maxTokens: 2500,
      validate: (raw) => {
        const arr = Array.isArray(raw) ? { shots: raw } : raw;
        const p = ShotsOut.safeParse(arr); if (!p.success) throw new Error('the JSON must be {"shots":[{"framing","move","action","dialogue","seconds","characters"}]}');
        if (!p.data.shots.some((s) => str(s.action))) throw new Error('no shot has an "action"');
        return p.data;
      },
    });
    for (const s of value.shots.filter((x) => str(x.action)).slice(0, maxShots)) {
      const dialogue: DialogueLine[] = (s.dialogue ?? []).filter((d) => str(d.line)).map((d) => ({ speaker: str(d.speaker), line: str(d.line) }));
      const ids = (s.characters ?? []).map((n) => bible.characters.find((c) => c.name.toLowerCase() === n.toLowerCase() || c.id === n)?.id).filter((x): x is string => !!x);
      const secs = snapNumber(s.seconds, target.seconds, target.seconds[Math.floor(target.seconds.length / 2)]);
      shots.push({
        framing: snap(s.framing, FRAMINGS, { fallback: ['wide', 'medium', 'close'][shots.length % 3] as 'wide', words: FRAMING_WORDS }),
        move: snap(s.move, MOVES, { fallback: 'static', words: MOVE_WORDS }),
        action: str(s.action).replace(/\s+/g, ' '), dialogue, seconds: secs, characterIds: ids.length ? ids : (scene.characterIds ?? []).slice(0, 2), placeId: scene.placeId,
        propIds: (s.props ?? []).map((n) => (bible.props ?? []).find((c) => c.name.toLowerCase() === n.toLowerCase() || c.id === n)?.id).filter((x): x is string => !!x),
      });
    }
    carry = shots.at(-1)?.action ?? '';
  }
  // dialogue must come from the scene text: lines the LLM invented are removed (and said so)
  const hay = scene.text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ');
  const nrm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [i, s] of shots.entries()) {
    const keep: DialogueLine[] = [];
    for (const d of s.dialogue) { const n = nrm(d.line); if (n && !hay.includes(n)) warnings.push(`Shot ${i + 1}: the invented line "${d.line.slice(0, 40)}" was removed (it is not in the script).`); else keep.push(d); }
    s.dialogue = keep;
  }
  // and every spoken line of the scene should be in some shot
  const covered = shots.map((s) => s.dialogue.map((d) => nrm(d.line)).join(' | ')).join(' | ');
  for (const d of spokenLines(scene.text)) { const n = nrm(d.line); if (n && !covered.includes(n)) warnings.push(`The line "${d.line.slice(0, 50)}" (${d.speaker}) is in the script but in no shot yet: add it to a shot.`); }
  // spoken lines need time
  for (const [i, s] of shots.entries()) {
    const spoken = s.dialogue.reduce((n, d) => n + words(d.line), 0);
    const need = spoken ? spoken / 3 + 1 : 0;
    if (need > s.seconds) { const longer = target.seconds.find((x) => x >= need); if (longer) s.seconds = longer; else warnings.push(`Shot ${i + 1}: the dialogue needs about ${need.toFixed(0)} s, longer than the model allows. Consider splitting it.`); }
  }
  if (!shots.length) warnings.push('No shots were produced for this scene.');
  return { shots, warnings };
}

/* ---------------------------------------------------------------- Prompt */

export async function makePrompt(llm: LlmClient, o: {
  shot: ShotBrief; scene: SceneInput; bible: Bible; target: TargetProfile; refs?: RefInfo[]; previous?: ShotBrief; index?: number;
  /** the story's film blocks (look, sound, music...), carried into every prompt */
  blocks?: import('./blocks.ts').PromptBlock[];
}): Promise<PromptResult> {
  const { shot, scene, bible, target } = o;
  const all = o.refs ?? [];
  const refs = [...all.filter((r) => (r.tag ?? 'Picture') === 'Picture').slice(0, Math.max(target.maxRefs, target.firstFrame ? 1 : 0)), ...all.filter((r) => r.tag === 'Video').slice(0, target.maxVideoRefs ?? 0), ...all.filter((r) => r.tag === 'Audio').slice(0, target.maxAudioRefs ?? 0)];
  const chars = bible.characters.filter((c) => shot.characterIds.includes(c.id));
  const place = bible.places.find((p) => p.id === shot.placeId);
  const context = [
    `Style: ${bible.style}`,
    ...chars.map((c) => `Character ${c.name}: ${c.look}`),
    place ? `Place ${place.name}: ${place.look}` : '',
    ...(bible.props ?? []).filter((p) => (shot.propIds ?? []).includes(p.id)).map((p) => `Prop ${p.name}: ${p.look}`),
    o.previous ? `Previous shot (for continuity): ${o.previous.action}` : '',
    `Scene: ${scene.heading}`,
  ].filter((x) => x !== '').join('\n');
  const idea = [`Framing: ${shot.framing}. Camera move: ${shot.move}.`, `Action: ${shot.action}`].join('\n');
  return enhancePrompt(llm, { idea, guide: { body: target.promptGuide, durationLine: target.durationLine }, seconds: shot.seconds, inputs: refs, context, dialogue: shot.dialogue, blocks: o.blocks });
}

export { slugify };


/* ---------------------------------------------------------------- Interpret (the user's own words into a clean script) */

/** Rewrite whatever the user wrote (notes, "name: line" dialogue, loose ideas) as a Fountain screenplay they can check and edit. */
export async function interpretScript(llm: LlmClient, text: string, guides?: GuideFn): Promise<string> {
  const system = guides?.('director-interpret')?.body ?? 'Rewrite the text as a Fountain screenplay: scene headings (INT./EXT. PLACE - TIME), action lines, character cues in CAPITALS followed directly by the spoken line. Keep every spoken line word for word. Add no events. Output only the script.';
  const out = await llm.chat({ system, user: clip(text, 12000), temperature: 0.2, maxTokens: Math.min(8000, Math.max(1500, Math.round(text.length / 1.5))), thinking: 'off' });
  return out.trim().replace(/^```[a-z]*\s*|```$/g, '').trim();
}
