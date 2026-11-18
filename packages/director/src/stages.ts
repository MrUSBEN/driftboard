import { z } from 'zod';
import { fill, snap, snapNumber, type LlmClient } from '@driftboard/adapter-llm';
import { enhancePrompt } from './enhance.ts';
import { FRAMINGS, MOVES, type Beat, type GuideFn, type Bible, type DialogueLine, type ParsedScene, type ParsedScript, type PromptResult, type RefInfo, type SceneIdea, type ShotBrief, type TargetProfile } from './types.ts';
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
  camera: z.string().optional().describe('One sentence: camera style for the whole film'),
  sound: z.string().optional().describe('One sentence: ambience and sound design'),
  music: z.string().optional().describe('One sentence: background music, or empty for none'),
  language: z.string().optional().describe('The language of the dialogue'),
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
  const blocks: Record<string, string> = {};
  for (const k of ['camera', 'sound', 'music', 'language'] as const) { const v = str(value[k]); if (v && !/^(none|n\/a|-)$/i.test(v)) blocks[k] = v; }
  return { bible: { style: str(value.style), characters, places: placesOut, ...(Object.keys(blocks).length ? { blocks } : {}) }, warnings };
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

const LineOut = z.object({ speaker: z.string(), line: z.string() });
const ShotsOut = z.object({
  shots: z.array(z.object({
    framing: z.string(), move: z.string(),
    beats: z.array(z.object({ action: z.string(), dialogue: z.array(LineOut).optional(), seconds: z.union([z.number(), z.string()]) })).optional(),
    // older answer shape: one action per shot
    action: z.string().optional(), dialogue: z.array(LineOut).optional(), seconds: z.union([z.number(), z.string()]).optional(),
    characters: z.array(z.string()).optional(), props: z.array(z.string()).optional(), endState: z.string().optional(),
  })).min(1),
});

/**
 * Cut a shot's beats into clips the model can make: each clip at most `first` seconds (later parts at most `next`, since a
 * continuing clip also repeats the held frames). Beats are never split, so a spoken line stays whole; a beat longer than
 * the limit becomes its own clip. Returns the beats of each clip.
 */
export function packBeats<B extends { seconds: number }>(beats: B[], first: number, next = first): B[][] {
  const parts: B[][] = []; let cur: B[] = []; let sum = 0;
  for (const b of beats) {
    const cap = parts.length ? next : first;
    if (cur.length && sum + b.seconds > cap + 0.01) { parts.push(cur); cur = []; sum = 0; }
    cur.push(b); sum += b.seconds;
  }
  if (cur.length) parts.push(cur);
  return parts;
}
/** A clip's action as one text: its beats with their time marks when there is more than one. */
export function beatsText(beats: Beat[]): string {
  if (beats.length < 2) return beats[0]?.action ?? '';
  let t = 0;
  return beats.map((b) => { const from = t; t += b.seconds; return `${fmtSec(from)}-${fmtSec(t)} s: ${b.action}`; }).join(' ');
}
const fmtSec = (n: number) => String(Math.round(n * 10) / 10);

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

export async function makeShots(llm: LlmClient, scene: SceneInput, bible: Bible, target: TargetProfile, guides?: GuideFn, opts: { maxPart?: number } = {}): Promise<{ shots: ShotBrief[]; warnings: string[] }> {
  const maxShots = target.maxShotsPerCall ?? 6;
  const longest = Math.max(...target.seconds);
  const maxPart = Math.min(longest, Math.max(3, opts.maxPart ?? 10));
  const minSec = Math.min(...target.seconds);
  const held = target.heldSec ?? 0;
  const system = guideText(guides, 'director-shots', { maxShots, framings: FRAMINGS.join(', '), moves: MOVES.join(', '), seconds: target.seconds.join(', '), maxPart });
  const chunks = chunkScene(scene.text);
  type Planned = { framing: ShotBrief['framing']; move: ShotBrief['move']; beats: Beat[]; characterIds: string[]; propIds: string[]; endState: string };
  const planned: Planned[] = []; const warnings: string[] = [];
  let carry = '';
  for (const [ci, chunk] of chunks.entries()) {
    const user = [
      compactBible(bible, scene.characterIds, scene.placeId), '',
      `Longest clip the video model makes: ${maxPart} seconds. A shot may be longer: it is cut into clips of at most ${maxPart} s between beats.`,
      chunks.length > 1 ? `SCENE "${scene.heading}" (part ${ci + 1} of ${chunks.length})${carry ? `\nPrevious shot: ${carry}` : ''}:` : `SCENE "${scene.heading}":`,
      chunk,
    ].join('\n');
    const { value } = await llm.json({
      system, user, schema: schemaOf(ShotsOut), temperature: 0.4, maxTokens: 3500,
      validate: (raw) => {
        const arr = Array.isArray(raw) ? { shots: raw } : raw;
        const p = ShotsOut.safeParse(arr); if (!p.success) throw new Error('the JSON must be {"shots":[{"framing","move","beats":[{"action","dialogue","seconds"}],"characters","props","endState"}]}');
        if (!p.data.shots.some((s) => s.beats?.some((b) => str(b.action)) || str(s.action))) throw new Error('no shot has a beat with an "action"');
        return p.data;
      },
    });
    for (const s of value.shots.slice(0, maxShots)) {
      const raw = s.beats?.length ? s.beats : [{ action: s.action ?? '', dialogue: s.dialogue, seconds: s.seconds ?? 5 }];
      const beats: Beat[] = raw.filter((b) => str(b.action)).map((b) => {
        const dialogue: DialogueLine[] = (b.dialogue ?? []).filter((d) => str(d.line)).map((d) => ({ speaker: str(d.speaker), line: str(d.line) }));
        const want = Number(typeof b.seconds === 'string' ? parseFloat(b.seconds) : b.seconds);
        return { action: str(b.action).replace(/\s+/g, ' '), dialogue, seconds: Math.max(Number.isFinite(want) && want > 0 ? want : 4, 1.5) };
      });
      if (!beats.length) continue;
      const ids = (s.characters ?? []).map((n) => bible.characters.find((c) => c.name.toLowerCase() === n.toLowerCase() || c.id === n)?.id).filter((x): x is string => !!x);
      planned.push({
        framing: snap(s.framing, FRAMINGS, { fallback: ['wide', 'medium', 'close'][planned.length % 3] as 'wide', words: FRAMING_WORDS }),
        move: snap(s.move, MOVES, { fallback: 'static', words: MOVE_WORDS }),
        beats, characterIds: ids.length ? ids : (scene.characterIds ?? []).slice(0, 2),
        propIds: (s.props ?? []).map((n) => (bible.props ?? []).find((c) => c.name.toLowerCase() === n.toLowerCase() || c.id === n)?.id).filter((x): x is string => !!x),
        endState: str(s.endState).replace(/\s+/g, ' '),
      });
    }
    carry = planned.at(-1)?.beats.at(-1)?.action ?? '';
  }
  // dialogue must come from the scene text: lines the LLM invented are removed (and said so)
  const hay = scene.text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ');
  const nrm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [i, s] of planned.entries()) for (const b of s.beats) {
    const keep: DialogueLine[] = [];
    for (const d of b.dialogue) { const n = nrm(d.line); if (n && !hay.includes(n)) warnings.push(`Shot ${i + 1}: the invented line "${d.line.slice(0, 40)}" was removed (it is not in the script).`); else keep.push(d); }
    b.dialogue = keep;
    // spoken lines need time: about 1 s per 3 words plus 1
    const spoken = keep.reduce((n, d) => n + words(d.line), 0);
    b.seconds = Math.round(Math.max(b.seconds, spoken ? spoken / 3 + 1 : 0) * 10) / 10;
  }
  // and every spoken line of the scene should be in some shot
  const covered = planned.flatMap((s) => s.beats.flatMap((b) => b.dialogue.map((d) => nrm(d.line)))).join(' | ');
  for (const d of spokenLines(scene.text)) { const n = nrm(d.line); if (n && !covered.includes(n)) warnings.push(`The line "${d.line.slice(0, 50)}" (${d.speaker}) is in the script but in no shot yet: add it to a shot.`); }
  // each shot becomes one or more clips of at most maxPart seconds; parts after the first continue the same take
  const shots: ShotBrief[] = [];
  for (const [i, s] of planned.entries()) {
    for (const b of s.beats) if (b.seconds > maxPart) warnings.push(`Shot ${i + 1}: one moment needs about ${b.seconds.toFixed(0)} s, longer than the longest clip (${maxPart} s). Consider splitting its dialogue.`);
    const parts = packBeats(s.beats, maxPart, held > 0 ? Math.max(minSec, maxPart - held) : maxPart);
    parts.forEach((pb, k) => {
      const sum = pb.reduce((n, b) => n + b.seconds, 0);
      shots.push({
        framing: s.framing, move: s.move, action: beatsText(pb), beats: pb, dialogue: pb.flatMap((b) => b.dialogue),
        seconds: target.freeSeconds ? Math.min(longest, Math.max(minSec, Math.ceil(sum))) : target.seconds.find((x) => x >= sum - 0.01) ?? longest, characterIds: s.characterIds, placeId: scene.placeId, propIds: s.propIds,
        ...(parts.length > 1 ? { part: { index: k + 1, count: parts.length, shot: i + 1 } } : {}),
        ...(k > 0 ? { continues: true } : {}),
        ...(k === parts.length - 1 && s.endState ? { endState: s.endState } : {}),
      });
    });
  }
  if (!shots.length) warnings.push('No shots were produced for this scene.');
  return { shots, warnings };
}

/* ---------------------------------------------------------------- Prompt */

/** The add-on for a clip that continues the previous one as the same take (guide "director-continue" overrides it). */
export const CONTINUE_PART = "This clip continues the previous clip as one unbroken camera take. It begins exactly where the previous clip's prompt ends: the same people in the same positions and clothing, the same place, light and camera position, with any motion already under way. Do not introduce or re-establish the scene and do not repeat what already happened; carry on from that moment. Describe looks, place and light with the same words as the previous clip's prompt.";

export async function makePrompt(llm: LlmClient, o: {
  shot: ShotBrief; scene: SceneInput; bible: Bible; target: TargetProfile; refs?: RefInfo[]; previous?: ShotBrief; index?: number;
  /** the story's film blocks (look, sound, music...), carried into every prompt */
  blocks?: import('./blocks.ts').PromptBlock[];
  /** the prompt written for the previous clip of the scene: carried when this clip continues it */
  previousPrompt?: string;
  guides?: GuideFn;
}): Promise<PromptResult> {
  const { shot, scene, bible, target } = o;
  const all = o.refs ?? [];
  const refs = [...all.filter((r) => (r.tag ?? 'Picture') === 'Picture').slice(0, Math.max(target.maxRefs, target.firstFrame ? 1 : 0)), ...all.filter((r) => r.tag === 'Video').slice(0, target.maxVideoRefs ?? 0), ...all.filter((r) => r.tag === 'Audio').slice(0, target.maxAudioRefs ?? 0)];
  const chars = bible.characters.filter((c) => shot.characterIds.includes(c.id));
  const place = bible.places.find((p) => p.id === shot.placeId);
  const hasLook = (o.blocks ?? []).some((b) => b.id === 'look' && b.text.trim());   // the Film look block says it already
  const cont = !!shot.continues && !!o.previous;
  const context = [
    hasLook ? '' : `Style: ${bible.style}`,
    ...chars.map((c) => `Character ${c.name}: ${c.look}`),
    place ? `Place ${place.name}: ${place.look}` : '',
    ...(bible.props ?? []).filter((p) => (shot.propIds ?? []).includes(p.id)).map((p) => `Prop ${p.name}: ${p.look}`),
    // a cut inside the scene: the facts carry over (who is where, holding what), the picture does not
    !cont && o.previous ? `Previous shot of this scene (a cut: new angle, for story flow only): ${o.previous.action}` : '',
    !cont && o.previous?.endState ? `How things stand now (from the end of the previous shot; keep it true unless this shot changes it): ${o.previous.endState}` : '',
    shot.part ? `This clip is part ${shot.part.index} of ${shot.part.count} of one continuous shot.` : '',
    `Scene: ${scene.heading}`,
  ].filter((x) => x !== '').join('\n');
  const beats = shot.beats?.length ? shot.beats : null;
  let t = 0;
  const moments = beats && (beats.length > 1 || cont)
    ? `Moments of this clip in order (seconds from its start${cont && target.heldSec ? ', after the held opening frames from the previous clip' : ''}):
${beats.map((b) => { const from = t; t += b.seconds; return `${Math.round(from * 10) / 10}-${Math.round(t * 10) / 10} s: ${b.action}${b.dialogue.length ? ` (${b.dialogue.map((d) => `${d.speaker}: "${d.line}"`).join(' ')})` : ''}`; }).join('\n')}`
    : `Action: ${shot.action}`;
  const idea = [`Framing: ${shot.framing}. Camera move: ${shot.move}.`, moments].join('\n');
  return enhancePrompt(llm, {
    idea, guide: { body: target.promptGuide, durationLine: target.durationLine }, seconds: shot.seconds, inputs: refs, context, dialogue: shot.dialogue, blocks: o.blocks,
    ...(cont ? { addon: o.guides?.('director-continue')?.body ?? CONTINUE_PART, previousPrompt: o.previousPrompt } : {}),
  });
}

export { slugify };


/* ---------------------------------------------------------------- Interpret (the user's own words into a clean script) */

/** Rewrite whatever the user wrote (notes, "name: line" dialogue, loose ideas) as a Fountain screenplay they can check and edit. */
export async function interpretScript(llm: LlmClient, text: string, guides?: GuideFn): Promise<string> {
  const system = guides?.('director-interpret')?.body ?? 'Rewrite the text as a Fountain screenplay: scene headings (INT./EXT. PLACE - TIME), action lines, character cues in CAPITALS followed directly by the spoken line. Keep every spoken line word for word. Add no events. Output only the script.';
  const out = await llm.chat({ system, user: clip(text, 12000), temperature: 0.2, maxTokens: Math.min(8000, Math.max(1500, Math.round(text.length / 1.5))), thinking: 'off' });
  return out.trim().replace(/^```[a-z]*\s*|```$/g, '').trim();
}
