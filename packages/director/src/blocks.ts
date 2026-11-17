/**
 * Film blocks: the parts of a prompt that are decided once for a story (film look, location, characters, camera
 * style, sound, music, dialogue language...). A shot is then only its action plus the blocks it uses, so Continue,
 * Bridge and new shots do not need the whole prompt typed again.
 */
export interface PromptBlock { id: string; name: string; text: string }
/** How one shot uses the story's blocks: some switched off, some with text changed for this shot only. */
export interface BlockUse { off?: string[]; override?: Record<string, string> }

/** What a new story starts with: named, empty (an empty block is simply not used). */
export const STARTER_BLOCKS: PromptBlock[] = [
  { id: 'look', name: 'Film look', text: '' },
  { id: 'place', name: 'Location', text: '' },
  { id: 'characters', name: 'Characters', text: '' },
  { id: 'camera', name: 'Camera style', text: '' },
  { id: 'sound', name: 'Sound and ambience', text: '' },
  { id: 'music', name: 'Background music', text: '' },
  { id: 'language', name: 'Dialogue language', text: '' },
];

/** The blocks a shot really uses: overrides applied, switched-off and empty ones left out, in the story's order. */
export function activeBlocks(blocks: PromptBlock[], use: BlockUse = {}): PromptBlock[] {
  const off = new Set(use.off ?? []);
  return blocks
    .filter((b) => !off.has(b.id))
    .map((b) => ({ ...b, text: (use.override?.[b.id] ?? b.text).trim() }))
    .filter((b) => b.text);
}

/** The request section the LLM gets: fixed decisions to carry, plus the previous shot for continuity. */
export function blocksSection(blocks: PromptBlock[], previousPrompt?: string): string {
  return [
    blocks.length ? `FILM BLOCKS (decided for the whole film; carry every one into the prompt with the same details, change nothing in them):\n${blocks.map((b) => `- ${b.name}: ${b.text}`).join('\n')}` : '',
    previousPrompt?.trim() ? `PREVIOUS SHOT'S PROMPT (for continuity only: its action already happened, do not repeat it; keep look, place, people and sound consistent with it unless the blocks or the idea say otherwise):\n${previousPrompt.trim()}` : '',
  ].filter(Boolean).join('\n\n');
}

/** The rule added to the system prompt when blocks or a previous shot are given. */
export const BLOCK_RULE = '- Only the IDEA is new: it is the action of this shot. The FILM BLOCKS are fixed decisions; keep all of them in the prompt, written into it naturally in the guide\'s format, without changing what they say. Do not invent a different look, place, sound or music.';

/** Without the LLM: the action first, then each block as its own line. Plain and predictable. */
export function assemblePrompt(action: string, blocks: PromptBlock[]): string {
  return [action.trim(), ...blocks.map((b) => `${b.name}: ${b.text}`)].filter(Boolean).join('\n\n');
}

/** What a generation records about how its prompt was made, so Continue/Bridge can carry it on. */
export interface PromptRecipe { action: string; blocks: PromptBlock[]; storyId?: string }

/** A shot that continues another one: the earlier shot's blocks become this shot's overrides (kept exactly as they were), anything it did not use is switched off. */
export function inheritUse(storyBlocks: PromptBlock[], earlier: PromptBlock[]): BlockUse {
  const had = new Map(earlier.map((b) => [b.id, b.text]));
  const override: Record<string, string> = {};
  for (const b of earlier) override[b.id] = b.text;
  return { off: storyBlocks.filter((b) => !had.has(b.id)).map((b) => b.id), override };
}
