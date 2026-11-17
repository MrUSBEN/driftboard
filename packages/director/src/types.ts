export type ElementType = 'action' | 'dialogue' | 'parenthetical';
export interface ScriptElement { type: ElementType; character?: string; text: string }
export interface ParsedScene { id: string; heading: string; place: string; time: string; text: string; elements: ScriptElement[]; characters: string[] }
export interface ParsedScript { title?: string; mode: 'screenplay' | 'loose'; scenes: ParsedScene[]; characters: string[]; text: string }

/** Output settings of one element's reference picture (size as the app's size choice, takes per click). */
export interface ElementGen { size?: { purpose: string; mp?: number; w?: number; h?: number }; batch?: number }
export interface BibleCharacter { id: string; name: string; look: string; /** Driftboard asset id of a reference picture */ refAsset?: string; /** Driftboard asset id of a short audio clip of the character's voice: it goes along wherever the character's picture is sent, to keep the voice the same */ voiceAsset?: string; gen?: ElementGen }
export interface BiblePlace { id: string; name: string; look: string; refAsset?: string; gen?: ElementGen }
/** Anything else the film needs a reference for (an object, a vehicle, a costume...). Written by the user, not the LLM. */
export interface BibleProp { id: string; name: string; look: string; refAsset?: string; gen?: ElementGen }
export interface Bible { style: string; characters: BibleCharacter[]; places: BiblePlace[]; props?: BibleProp[] }

export interface SceneIdea { id: string; title: string; summary: string; placeId?: string; characterIds: string[] }

export const FRAMINGS = ['wide', 'medium', 'close', 'extreme-close', 'over-the-shoulder', 'low-angle', 'high-angle', 'top-down'] as const;
export const MOVES = ['static', 'push-in', 'pull-back', 'pan', 'tilt', 'tracking', 'orbit', 'crane', 'handheld', 'rack-focus'] as const;
export type Framing = (typeof FRAMINGS)[number];
export type Move = (typeof MOVES)[number];

export interface DialogueLine { speaker: string; line: string }
/** promptMode: auto = use the characters' reference pictures when there are any; text = never (pure text prompt); refs = must have them (an error if missing) */
export type PromptMode = 'auto' | 'text' | 'refs';
export interface ShotBrief { framing: Framing; move: Move; action: string; dialogue: DialogueLine[]; seconds: number; characterIds: string[]; placeId?: string; /** bible props visible in the shot */ propIds?: string[]; promptMode?: PromptMode }

/** What the director needs to know about the model it is writing for. All of it comes from profile data. */
export interface TargetProfile {
  id: string; title: string;
  /** shot lengths the model can make, seconds */
  seconds: number[];
  /** how many reference pictures the prompt may use (0 = none) */
  maxRefs: number;
  /** how many reference audio clips (a character's voice sample) the model takes: <Audio n> (0 or missing = none) */
  maxAudioRefs?: number;
  /** how many reference videos (motion or look to copy) the model takes: <Video n> (0 or missing = none) */
  maxVideoRefs?: number;
  /** the model's prompt format rules and examples (profile prompt guide) */
  promptGuide: string;
  /** if set, the prompt must end with a '<name>: N seconds' line (written by the app) */
  durationLine?: string;
  /** the model always receives the shot's first frame as <Picture 1> (image-to-video) */
  firstFrame?: boolean;
  /** the model can also take a last frame (first-to-last-frame video) */
  lastFrame?: boolean;
  /** upper bound of shots asked for in one call */
  maxShotsPerCall?: number;
}

export interface RefInfo { n: number; /** which tag the prompt uses for it: <Picture n> (default), <Video n> or <Audio n> */ tag?: 'Picture' | 'Video' | 'Audio'; name?: string; /** what the picture is, e.g. the literal first frame */ role?: string }
/** Looks up a guide by id (see adapter-llm guides). */
export type GuideFn = (id: string) => { body: string; durationLine?: string } | undefined;
export interface PromptResult { prompt: string; warnings: string[] }
