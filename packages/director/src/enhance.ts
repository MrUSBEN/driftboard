import type { LlmClient, Thinking } from '@driftboard/adapter-llm';
import type { DialogueLine, PromptResult, RefInfo, ShotBrief } from './types.ts';
import { BLOCK_RULE, blocksSection, type PromptBlock } from './blocks.ts';

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Checks that need no model. Hard problems are errors (they trigger a retry), soft ones are warnings. */
export function lintPrompt(prompt: string, shot: Pick<ShotBrief, 'dialogue'> | { dialogue: DialogueLine[] }, refs: RefInfo[]): { errors: string[]; warnings: string[] } {
  const errors: string[] = [], warnings: string[] = [];
  if (prompt.trim().length < 30) errors.push('the prompt is too short');
  if (/```/.test(prompt)) errors.push('the prompt contains code fences');
  if (/(^|\s)(\.{3}|…)(\s|$)/.test(prompt)) errors.push('the prompt contains a "..." placeholder copied from the guide; write the real content instead');
  const picRefs = refs.filter((r) => (r.tag ?? 'Picture') === 'Picture');
  if (!picRefs.length && /<Picture \d+>/.test(prompt)) errors.push('the prompt mentions <Picture n> but there are no input pictures; remove those mentions');
  if (/^\s*(sure|here is|here's|certainly|okay|ok,)\b/i.test(prompt)) errors.push('the prompt starts with chatter instead of the prompt itself');
  if (prompt.length > 5000) warnings.push(`The prompt is long (${prompt.length} characters).`);
  for (const d of shot.dialogue) if (!norm(prompt).includes(norm(d.line))) warnings.push(`The line "${d.line.slice(0, 40)}" is missing from the prompt.`);
  for (const r of refs) { const tag = r.tag ?? 'Picture'; if (!new RegExp(`<${tag} ${r.n}>`).test(prompt)) warnings.push(`<${tag} ${r.n}>${r.name ? ` (${r.name})` : ''} is not used in the prompt.`); }
  return { errors, warnings };
}

export interface EnhanceInput {
  /** what the user wants, in their own words */
  idea: string;
  guide: { body: string; durationLine?: string };
  /** length of the clip, seconds. Goes to the model as the target, and into the duration line if the guide has one */
  seconds?: number;
  /** pictures the model will receive: n = <Picture n>; role says what each one is, e.g. "the literal first frame" */
  inputs?: RefInfo[];
  /** extra background: style, characters, place, previous shot */
  context?: string;
  /** extra guide text for a kind of task (continue, bridge) */
  addon?: string;
  dialogue?: DialogueLine[];
  thinking?: Thinking;
  /** film blocks this shot uses (already resolved: overrides applied, switched-off ones left out) */
  blocks?: PromptBlock[];
  /** the prompt of the shot this one continues or bridges from */
  previousPrompt?: string;
}

/** Clean what a model wrote around the prompt: code fences, a leading "Here is..." line, surrounding quotes. */
export function cleanPrompt(raw: string): string {
  let t = raw.trim();
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(t);
  if (fence) t = fence[1]!.trim();
  t = t.replace(/^(sure|here is|here's|certainly|okay)[^\n]*:\s*\n+/i, '').trim();
  if (/^".*"$/s.test(t) && !t.slice(1, -1).includes('"')) t = t.slice(1, -1).trim();
  return t;
}

/** Make the last line say the real length, whatever the model wrote. */
export function setDurationLine(prompt: string, name: string, seconds: number): string {
  const re = new RegExp(`^[ \\t]*${name}[ \\t]*:.*$`, 'gim');
  return `${prompt.replace(re, '').trimEnd()}\n\n${name}: ${seconds} seconds`;
}

/**
 * Turn an idea into a finished prompt with a profile's guide. The guide is the system prompt; the request lists
 * the idea, the target length and the input pictures. The reply is plain text (no JSON), checked by lintPrompt.
 */
export async function enhancePrompt(llm: LlmClient, o: EnhanceInput): Promise<PromptResult> {
  const inputs = o.inputs ?? [];
  const system = [
    o.guide.body.trim() || 'Turn the idea into one clear, detailed prompt for the generator. Output only the prompt.',
    o.addon?.trim() ?? '',
    'APP RULES (they override the guide where they differ):',
    '- Output only the finished prompt text. No explanations, no markdown fences, no alternatives.',
    '- Use <Picture n> only for the input pictures listed in the request. If none are listed, never write <Picture n>, even if the guide shows it.',
    '- Never copy placeholders or "..." from the guide: fill in real content.',
    o.seconds ? `- The target duration is ${o.seconds} seconds. Use exactly that.` : '',
    o.dialogue?.length ? '- Include every dialogue line word for word, attributed to its speaker, in the format the guide uses.' : '',
    o.blocks?.length || o.previousPrompt?.trim() ? BLOCK_RULE : '',
  ].filter(Boolean).join('\n\n');
  const user = [
    `IDEA:\n${o.idea.trim()}`,
    o.seconds ? `Target duration: ${o.seconds} seconds` : '',
    inputs.length ? `Inputs (refer to them exactly like this):\n${inputs.map((r) => `<${r.tag ?? 'Picture'} ${r.n}> = ${r.role ?? (r.tag === 'Video' ? 'reference video' : r.tag === 'Audio' ? 'reference audio' : 'reference picture')}${r.name ? `: ${r.name}` : ''}`).join('\n')}` : 'Input pictures: none.',
    o.dialogue?.length ? `Dialogue:\n${o.dialogue.map((d) => `${d.speaker}: ${d.line}`).join('\n')}` : '',
    o.context?.trim() ? `STORY CONTEXT:\n${o.context.trim()}` : '',
    blocksSection(o.blocks ?? [], o.previousPrompt),
  ].filter(Boolean).join('\n\n');

  let problem = '', text = '', warnings: string[] = [], attempts = 0;
  for (; attempts < 2; attempts++) {
    const raw = await llm.chat({ system, user: problem ? `${user}\n\nYour previous answer could not be used: ${problem}\nWrite the prompt again.` : user, temperature: 0.7, maxTokens: 2500, thinking: o.thinking });
    text = cleanPrompt(raw);
    const l = lintPrompt(text, { dialogue: o.dialogue ?? [] }, inputs);
    warnings = l.warnings;
    if (!l.errors.length) { problem = ''; break; }
    problem = l.errors.join('; ');
  }
  if (problem) throw new Error(`The LLM kept giving unusable prompts (${problem}).`);
  if (attempts > 0) warnings = [...warnings, 'The LLM needed a second try for this prompt.'];
  if (o.guide.durationLine && o.seconds) text = setDurationLine(text, o.guide.durationLine, o.seconds);
  return { prompt: text, warnings };
}
