import type { Project } from '@driftboard/core';
import type { Profile } from '@driftboard/profiles';
import { activeBlocks, enhancePrompt, makePrompt, type Bible, type PromptBlock, type RefInfo, type ShotBrief, type TargetProfile } from '@driftboard/director';
import type { LlmHub } from './llmHub.ts';

/** What the assistant proposes to generate; the user decides (fill the form or generate right there). */
export interface Proposal { kind: 'image' | 'video' | 'edit'; prompt: string; seconds?: number; aspect?: string }
/** One picture of a storyboard: what the user dumped, in the order they arranged it. */
export interface Frame { id: string; assetId: string; /** the user's own title for this shot */ name?: string; role: 'keyframe' | 'reference'; /** the user's own words about this shot (or written by the app when `auto`) */ note: string; auto?: boolean; description?: string; prompt?: string; warnings?: string[]; seconds?: number; /** the next picture is this shot's last frame */ chain?: boolean }
export interface Storyboard { frames: Frame[]; idea: string; targetId?: string }
export interface ChatMsg { role: 'user' | 'assistant'; content: string; ts: number; action?: string; /** asset ids attached to a user message */ images?: string[]; proposal?: Proposal }

const TOOLS_NOTE = `YOU CAN START GENERATIONS. When the user asks you to make or edit a picture or a video (or you offer one and they agree), write your normal short reply and then end it with exactly one fenced block like this, nothing after it:
\`\`\`driftboard
{"kind":"image","prompt":"the full prompt text","aspect":"16:9"}
\`\`\`
kind is "image" (new picture), "video" (new clip; add "seconds" if the user said a length) or "edit" (change the attached picture(s)). prompt is ONLY the text for the generator, with no intro, no quotes, no explanation. Add aspect only if the user named one. Use the block only when the user wants something generated; for ideas and discussion just chat. Pictures the user attaches are visible to you: describe, compare or reason about them when asked.`;
/** Pull the proposal block out of a reply. Returns the text without the block. */
export function splitProposal(reply: string): { text: string; proposal?: Proposal } {
  const m = /```driftboard\s*([\s\S]*?)```/i.exec(reply);
  if (!m) return { text: reply.trim() };
  const text = (reply.slice(0, m.index) + reply.slice(m.index + m[0].length)).trim();
  try {
    const j = JSON.parse(m[1]!.trim()) as Record<string, unknown>;
    const kind = j.kind === 'video' || j.kind === 'edit' ? j.kind : 'image';
    const prompt = typeof j.prompt === 'string' ? j.prompt.trim() : '';
    if (!prompt) return { text };
    return { text, proposal: { kind, prompt, ...(typeof j.seconds === 'number' ? { seconds: j.seconds } : {}), ...(typeof j.aspect === 'string' ? { aspect: j.aspect } : {}) } };
  } catch { return { text }; }
}

interface Deps {
  h: (name: string, fn: (...a: any[]) => unknown) => void;
  hub: LlmHub;
  project: () => Project | null;
  profiles: () => Profile[];
  targets: () => TargetProfile[];
  send: (channel: string, ...a: unknown[]) => void;
  /** a picture asset as a small data URL for the LLM (null if it cannot be made) */
  imageData: (assetId: string) => Promise<string | null>;
}

/** IPC for everything the LLM does outside the director: settings, guides, Enhance, writing prompts for story shots, chat. */
export function registerLlm({ h, hub, project, profiles, targets, send, imageData }: Deps) {
  const P = () => { const p = project(); if (!p) throw new Error('Open or create a project first.'); return p; };

  /* ------------------------------------------------------------ status, settings, guides */
  h('llmStatus', async () => {
    try {
      const models = await hub.client.models();
      return { ok: true, caps: await hub.client.caps(), url: hub.client.baseUrl, model: hub.s.model, models: models.map((m) => ({ id: m.id, loaded: m.loaded, embedding: m.embedding, context: m.context, maxContext: m.maxContext, reasoning: m.reasoning })) };
    } catch (e) { return { ok: false, url: hub.client.baseUrl, model: hub.s.model, models: [], error: (e as Error).message }; }
  });
  h('llmSettings', () => hub.s);
  h('llmSet', (patch: object) => hub.set(patch));
  h('llmUnload', () => hub.client.unloadAll());
  h('guides', () => [...hub.guides.values()].map((g) => ({ id: g.id, title: g.title, custom: !!g.custom, body: g.body, durationLine: g.durationLine })));
  h('guideSave', (id: string, body: string) => hub.saveGuide(id, body));
  h('guideReset', (id: string) => hub.resetGuide(id));

  const guideOf = (pr: Profile) => hub.guide(pr.manifest.guide ?? '');

  /* ------------------------------------------------------------ Enhance */
  h('llmEnhance', async (req: { profileId: string; idea: string; seconds?: number; inputs?: RefInfo[]; kind?: 'continue' | 'bridge'; /** film blocks this shot uses, resolved */ blocks?: PromptBlock[]; /** prompt of the clip this one continues */ previousPrompt?: string }) => {
    try {
      const pr = profiles().find((x) => x.manifest.id === req.profileId);
      if (!pr) throw new Error('Unknown profile');
      if (!req.idea.trim()) throw new Error('Write the idea in the prompt box first.');
      const g = guideOf(pr);
      const addon = req.kind === 'continue' ? hub.guide('continue-shot')?.body : req.kind === 'bridge' ? hub.guide('bridge-shot')?.body : undefined;
      const r = await hub.use('enhance', () => enhancePrompt(hub.client, {
        idea: req.idea, guide: { body: g?.body ?? pr.guide, durationLine: g?.durationLine }, seconds: req.seconds, inputs: req.inputs, addon, thinking: hub.s.thinking.enhance,
        blocks: req.blocks, previousPrompt: req.previousPrompt,
      }), { label: 'Enhance prompt' });
      return { ok: true, ...r };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  });

  /* ------------------------------------------------------------ write prompts for story shots, as one LLM batch */
  let abort: AbortController | null = null;
  h('llmCancel', () => { abort?.abort(); hub.cancelAll(); });
  h('llmTasks', () => hub.tasks);
  h('llmWritePrompts', async (shotIds: string[], profileId: string, force = false) => {
    try {
      const p = P();
      const target = targets().find((t) => t.id === profileId);
      if (!target) throw new Error('Choose a video model first.');
      if (abort) throw new Error('Prompts are already being written.');
      const tree = p.story.tree();
      const bible: Bible = p.story.bible() ?? { style: '', characters: [], places: [] };
      const want = new Set(shotIds);
      const todo = tree.flatMap(({ scene, shots }) => shots.map((s, i) => ({ scene, s, prev: shots[i - 1] }))).filter((x) => want.has(x.s.id) && x.s.brief && (force || !x.s.prompt?.trim()));
      const ac = new AbortController(); abort = ac;
      const out = await hub.use('enhance', async () => {
        hub.client.signal = ac.signal;
        const failed: string[] = []; let written = 0;
        try {
          for (const [i, { scene, s, prev }] of todo.entries()) {
            send('llmProgress', { running: true, done: i, total: todo.length, label: `Writing prompt ${i + 1} of ${todo.length}: ${scene.name} / ${s.name}` });
            const refs: RefInfo[] = [];
            if (target.firstFrame) refs.push({ n: 1, role: 'the literal first frame of the shot (supplied by the user later)' });
            const seen = new Set<string>(); let pics = 0;
            const mode = (s.brief as ShotBrief).promptMode ?? 'auto';
            if (mode !== 'text') for (const id of s.brief!.characterIds) {
              const c = bible.characters.find((x) => x.id === id);
              if (c?.refAsset && !seen.has(c.refAsset) && pics < target.maxRefs) { seen.add(c.refAsset); pics++; refs.push({ n: refs.length + 1, name: c.name, role: 'reference picture of the character' }); }
            }
            // a character's voice sample goes along as <Audio n> when the model takes reference audio
            { const vs = new Set<string>(); for (const id of s.brief!.characterIds) { const c = bible.characters.find((x) => x.id === id); if (c?.voiceAsset && !vs.has(c.voiceAsset) && vs.size < (target.maxAudioRefs ?? 0)) { vs.add(c.voiceAsset); refs.push({ n: vs.size, tag: 'Audio', name: c.name, role: `the voice of ${c.name}: every line ${c.name} speaks must be in exactly this voice (name <Audio ${vs.size}> where that voice is introduced)` }); } } }
            // video and audio references the user put on the shot: <Video n> (motion or look to copy), more <Audio n>
            { const kinds = (id: string) => p.assets.get(id)?.kind; const own = (s.media ?? []).filter((a) => !!kinds(a));
              let nv = 0, na = refs.filter((r) => r.tag === 'Audio').length;
              for (const a of own) { if (kinds(a) === 'video' && nv < (target.maxVideoRefs ?? 0)) { nv++; refs.push({ n: nv, tag: 'Video', role: 'reference video: copy its camera work, motion and look as the prompt describes' }); } else if (kinds(a) === 'audio' && na < (target.maxAudioRefs ?? 0)) { na++; refs.push({ n: na, tag: 'Audio', role: 'reference audio (a voice or sound to use)' }); } } }
            if (mode === 'refs' && (target.maxRefs === 0 || !pics)) {   // asked for reference pictures but there are none: an error, not a silent text prompt
              failed.push(`${scene.name} / ${s.name}: ${target.maxRefs === 0 ? 'this model takes no reference pictures' : 'set to use reference pictures but its characters have none'} (change the shot to "text only" or add pictures)`);
              continue;
            }
            try {
              const r = await makePrompt(hub.client, { shot: s.brief as ShotBrief, scene: { id: scene.id, heading: scene.name, text: '' }, bible, target, refs, previous: prev?.brief as ShotBrief | undefined, blocks: activeBlocks(p.story.blocks(scene.storyId).blocks) });
              p.story.updateShot(s.id, { prompt: r.prompt, promptWarnings: r.warnings, generatedPrompt: r.prompt }, 'LLM: write prompt'); written++;
            } catch (e) { if (ac.signal.aborted) break; failed.push(`${scene.name} / ${s.name}: ${(e as Error).message}`); }
          }
        } finally { hub.client.signal = undefined; }
        return { written, failed, cancelled: ac.signal.aborted };
      }, { batch: true, label: 'Write prompts for shots' });
      send('board');
      return { ok: true, ...out };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
    finally { abort = null; send('llmProgress', { running: false, done: 1, total: 1, label: 'Done' }); }
  });

  /** The vision LLM reads a bible reference picture and writes its look, so the written look matches what the picture really shows. */
  h('llmReadLook', async (assetId: string, kind: 'character' | 'place' | 'prop') => {
    try {
      const img = await imageData(assetId); if (!img) throw new Error('The picture could not be read.');
      const what = kind === 'character' ? 'person: age range, build, hair, face, clothing and colours, accessories (glasses, watch, jewellery), expression' : kind === 'place' ? 'location: architecture, materials, colours, light, mood, notable objects' : 'object: what it is, shape, material, colour, size, condition, markings';
      const out = await hub.use('enhance', () => hub.client.chat({
        system: `You write the "look" entry of a story bible from a reference picture. Describe only what is actually visible in this picture, as one paragraph of 40 to 70 words, visual details only (the ${what}). Do not mention the picture itself, the background style or any text. Never add anything that is not visible. Output only the paragraph.`,
        user: 'Write the look of this ' + kind + '.', images: [img], temperature: 0.2, maxTokens: 400, thinking: 'off',
      }), { label: 'Read reference picture' });
      return { ok: true, look: out.trim().replace(/^look:\s*/i, '') };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  });

  /** Turn a chat message (intro, headings, explanations) into only the text a generator should get. */
  h('llmDistil', async (text: string, kind: 'image' | 'video') => {
    try {
      const out = await hub.use('enhance', () => hub.client.chat({
        system: `You get a message from a chat assistant. Extract from it ONE ${kind} generation prompt: only the description of what should be generated, merging character look and shot description into flowing prompt text. Remove greetings, mentions of the app, explanations, headings and anything that is not part of the picture or clip. Do not add new content. Output only the prompt.`,
        user: text, temperature: 0.2, maxTokens: 900, thinking: 'off',
      }), { label: 'Clean up chat prompt' });
      return { ok: true, prompt: out.trim().replace(/^```[a-z]*\s*|```$/g, '').trim() };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  });

  /* ------------------------------------------------------------ chat */
  const loadChat = (): ChatMsg[] => { try { return JSON.parse(P().loadBlob('chat') ?? '[]') as ChatMsg[]; } catch { return []; } };
  const saveChat = (m: ChatMsg[]) => P().saveBlob('chat', JSON.stringify(m.slice(-200)));
  const projectContext = () => {
    const p = P(), b = p.story.bible(), tree = p.story.tree();
    const lines: string[] = [];
    if (b) { lines.push(`Style: ${b.style}`); for (const c of b.characters) lines.push(`Character ${c.name}: ${c.look}`); for (const x of b.places) lines.push(`Place ${x.name}: ${x.look}`); }
    for (const { scene, shots } of tree.slice(0, 40)) lines.push(`Scene "${scene.name}": ${shots.length} shots${shots.length ? ' — ' + shots.slice(0, 8).map((s) => s.brief?.action ?? s.name).join(' | ').slice(0, 400) : ''}`);
    return lines.join('\n');
  };
  h('chatState', () => loadChat());
  h('chatClear', () => saveChat([]));
  h('chatSend', async (text: string, action?: string, assetIds: string[] = []) => {
    try {
      if (!text.trim()) throw new Error('Write a message first.');
      const msgs = loadChat();
      const g = hub.guide(action && hub.guide(action) ? action : 'assistant');
      const ctx = projectContext();
      const system = `${g?.body ?? 'You are a helpful creative assistant for short films.'}${ctx ? `\n\nPROJECT CONTEXT (from the user's project; may be empty):\n${ctx}` : ''}`;
      // keep as much history as fits in about half of the context (roughly 3 characters per token)
      let budget = Math.floor(hub.s.contextLength * 1.5) - system.length - text.length;
      const history: { role: 'user' | 'assistant'; content: string }[] = [];
      for (let i = msgs.length - 1; i >= 0 && budget > 0; i--) { budget -= msgs[i]!.content.length; if (budget > 0) history.unshift({ role: msgs[i]!.role, content: msgs[i]!.content }); }
      const images = (await Promise.all(assetIds.slice(0, 6).map(imageData))).filter((x): x is string => !!x);
      let reply: string;
      try { reply = await hub.use('chat', () => hub.client.chat({ system, user: text, history, images, temperature: 0.7, maxTokens: 2000, thinking: hub.s.thinking.chat }), { label: 'Assistant chat' }); }
      catch (e) { throw new Error(images.length && /image|vision|multimodal/i.test((e as Error).message) ? `${(e as Error).message} (this model may not understand pictures: pick a vision model in Settings)` : (e as Error).message); }
      const now = Date.now();
      const { text: shown, proposal } = splitProposal(reply);
      const next = [...msgs, { role: 'user' as const, content: text, ts: now, action, ...(assetIds.length ? { images: assetIds } : {}) }, { role: 'assistant' as const, content: shown || (proposal ? 'Here is what I would generate:' : reply.trim()), ts: now + 1, ...(proposal ? { proposal } : {}) }];
      saveChat(next);
      return { ok: true, messages: next };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  });
  h('chatToNote', (text: string) => {
    const p = P(); const n = p.board.items().filter((i) => i.kind === 'note').length;
    p.board.addItem({ kind: 'note', x: 40 + (n % 6) * 40, y: 40 + (n % 6) * 40, w: 280, h: 180, text }, 'Add note'); send('board');
  });

  /* ------------------------------------------------------------ storyboard: pictures the user already has */
  const loadSb = (): Storyboard => { try { const o = JSON.parse(P().loadBlob('storyboard') ?? 'null') as Storyboard | null; if (o?.frames) return o; } catch { /* fresh */ } return { frames: [], idea: '' }; };
  const saveSb = (sb: Storyboard) => P().saveBlob('storyboard', JSON.stringify(sb));
  h('sbGet', () => loadSb());
  h('sbSet', (sb: Storyboard) => { saveSb(sb); });
  /** Run one LLM batch with progress, cancel and the usual model handling. */
  const sbBatch = async <T,>(label: string, fn: (ac: AbortController, step: (i: number, total: number, what: string) => void) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> => {
    if (abort) return { ok: false, error: 'The LLM is already working.' };
    const ac = new AbortController(); abort = ac;
    try {
      const value = await hub.use('enhance', async () => {
        hub.client.signal = ac.signal;
        try { return await fn(ac, (i, total, what) => send('llmProgress', { running: true, done: i, total, label: `${label}: ${what}` })); }
        finally { hub.client.signal = undefined; }
      }, { batch: true, label });
      return { ok: true, value };
    } catch (e) { return { ok: false, error: ac.signal.aborted ? 'Cancelled' : (e as Error).message }; }
    finally { abort = null; send('llmProgress', { running: false, done: 1, total: 1, label: 'Done' }); }
  };
  const DESCRIBE = 'Describe exactly what is visible in this picture in 2 to 4 plain sentences (people, clothing, pose, place, light, camera framing). Say only what you see. Output only the description.';
  h('sbDescribe', (ids?: string[], force = false) => sbBatch('Describing pictures', async (ac, step) => {
    const sb = loadSb(); const todo = sb.frames.filter((f) => (!ids || ids.includes(f.id)) && (force || !f.description));
    let done = 0; const failed: string[] = [];
    for (const [i, f] of todo.entries()) {
      step(i, todo.length, `picture ${i + 1} of ${todo.length}`);
      const img = await imageData(f.assetId); if (!img) { failed.push(`picture ${sb.frames.indexOf(f) + 1}: could not be read`); continue; }
      try {
        const t = await hub.client.chat({ system: hub.guide('storyboard-describe')?.body ?? DESCRIBE, user: 'Describe this picture.', images: [img], temperature: 0.2, maxTokens: 500, thinking: 'off' });
        f.description = t.trim().replace(/^description:\s*/i, ''); done++; saveSb(sb);
      } catch (e) { if (ac.signal.aborted) break; failed.push(`picture ${sb.frames.indexOf(f) + 1}: ${(e as Error).message}`); }
    }
    return { done, failed };
  }));
  /** The LLM reads all descriptions in order and writes what happens in each shot that has no note of the user. */
  h('sbStory', () => sbBatch('Building the story', async (_ac, step) => {
    const sb = loadSb(); const keys = sb.frames.filter((f) => f.role === 'keyframe');
    if (!keys.length) throw new Error('Add pictures first.');
    if (keys.some((f) => !f.description)) throw new Error('Describe the pictures first (the LLM needs to know what they show).');
    const need = keys.filter((f) => !f.note.trim() || f.auto);
    if (!need.length) return { filled: 0 };
    step(0, 1, 'reading all pictures in order');
    const list = keys.map((f, i) => `Picture ${i + 1}: ${f.description}${f.note.trim() && !f.auto ? `\nAuthor note: ${f.note.trim()}` : ''}`).join('\n\n');
    const user = `${sb.idea.trim() ? `The author's idea for the story: ${sb.idea.trim()}\n\n` : ''}${list}\n\nPictures that need an action: ${need.map((f) => keys.indexOf(f) + 1).join(', ')}`;
    const { value } = await hub.client.json({
      system: hub.guide('storyboard-story')?.body ?? 'Write one sentence of action for each listed picture so the pictures tell a short story in order. Answer {"frames":[{"n":1,"action":"...","seconds":5}]}.',
      user, temperature: 0.6, maxTokens: 2500, thinking: hub.s.thinking.enhance,
      schema: { type: 'object', properties: { frames: { type: 'array', items: { type: 'object', properties: { n: { type: 'number' }, action: { type: 'string' }, seconds: { type: 'number' } }, required: ['n', 'action'] } } }, required: ['frames'] },
      validate: (raw: unknown) => { const a = (raw as { frames?: { n: number; action: string; seconds?: number }[] })?.frames; if (!Array.isArray(a) || !a.length) throw new Error('the JSON must be {"frames":[{"n","action","seconds"}]}'); return a; },
    });
    let filled = 0;
    for (const r of value) { const f = keys[Math.round(Number(r.n)) - 1]; if (f && String(r.action ?? '').trim() && need.includes(f)) { f.note = String(r.action).trim(); f.auto = true; if (r.seconds) f.seconds = Math.max(2, Math.min(15, Math.round(r.seconds))); filled++; } }
    saveSb(sb); return { filled };
  }));
  /** Write the video prompt of each picture from the user's note, faithfully, in the model's format. */
  h('sbPrompts', (ids: string[] | undefined, profileId: string, force = false) => sbBatch('Writing prompts', async (ac, step) => {
    const target = targets().find((t) => t.id === profileId); if (!target) throw new Error('Choose a video model first.');
    const sb = loadSb(); const keys = sb.frames.filter((f) => f.role === 'keyframe');
    const todo = keys.filter((f) => (!ids || ids.includes(f.id)) && (force || !f.prompt?.trim()));
    let written = 0; const failed: string[] = [];
    const near = (n: number) => target.seconds.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a), target.seconds[0] ?? 5);
    for (const [i, f] of todo.entries()) {
      step(i, todo.length, `shot ${keys.indexOf(f) + 1} (${i + 1} of ${todo.length})`);
      const k = keys.indexOf(f), next = keys[k + 1], prev = keys[k - 1];
      const useLast = !!f.chain && !!next && !!target.lastFrame;
      const inputs: RefInfo[] = [];
      if (target.firstFrame) inputs.push({ n: 1, role: 'the literal first frame of the video (the picture of this shot)' });
      if (useLast) inputs.push({ n: 2, role: 'the literal last frame of the video (the picture of the next shot)' });
      const context = [
        sb.idea.trim() ? `Overall story: ${sb.idea.trim()}` : '',
        f.description ? `The ${target.firstFrame ? 'first frame (<Picture 1>)' : 'starting picture'} shows: ${f.description}` : '',
        useLast && next?.description ? `The last frame (<Picture 2>) shows: ${next.description}` : '',
        prev ? `Previous shot: ${prev.note || prev.description || ''}` : '',
        ...sb.frames.filter((x) => x.role === 'reference' && x.description).map((x) => `Reference picture (look to match): ${x.description}`),
      ].filter(Boolean).join('\n');
      const idea = f.note.trim() ? `The author's notes for this shot. Follow them faithfully and add no events of your own: ${f.note.trim()}` : 'No notes: continue naturally from the first frame with small, believable motion.';
      try {
        const r = await enhancePrompt(hub.client, { idea, guide: { body: target.promptGuide, durationLine: target.durationLine }, seconds: f.seconds ?? near(5), inputs, context, addon: hub.guide('storyboard-notes')?.body, thinking: 'off' });
        f.prompt = r.prompt; f.warnings = r.warnings; written++; saveSb(sb);
      } catch (e) { if (ac.signal.aborted) break; failed.push(`shot ${k + 1}: ${(e as Error).message}`); }
    }
    return { written, failed };
  }));
  /** Put the storyboard into the Story tab: one scene, one shot per picture, each with its prompt and its first (and last) frame. */
  h('sbToStory', (sceneName = 'Storyboard') => {
    const p = P(); const sb = loadSb(); const keys = sb.frames.filter((f) => f.role === 'keyframe');
    if (!keys.length) throw new Error('Add pictures first.');
    let shots = 0;
    p.docs.batch('Storyboard to story', () => {
      const st = newStory(sceneName, keys.map((f) => f.note || f.description || '').join('\n'));
      const sc = p.story.addScene('Scene 1', st.id); if (!sc) return;
      keys.forEach((f, i) => {
        const sh = p.story.addShot(sc.id, f.name?.trim() || `Shot ${i + 1}`); if (!sh) return;
        const next = keys[i + 1];
        const brief: ShotBrief = { framing: 'medium', move: 'static', action: f.note || f.description || '', dialogue: [], seconds: f.seconds ?? 5, characterIds: [], promptMode: 'text' };
        p.story.updateShot(sh.id, { brief, prompt: f.prompt || undefined, generatedPrompt: f.prompt || undefined, promptWarnings: f.warnings, frames: { first: f.assetId, ...(f.chain && next ? { last: next.assetId } : {}) }, notes: f.note || undefined });
        shots++;
      });
    });
    send('board'); return { shots };
  });
  /** Prompts the user already has (one per shot): become shots of a new scene, optionally starting from the storyboard pictures in order. */
  h('promptsToStory', (list: string[], sceneName = 'Imported prompts', withFrames = false) => {
    const p = P(); const keys = withFrames ? loadSb().frames.filter((f) => f.role === 'keyframe') : [];
    const clean = list.map((x) => x.trim()).filter(Boolean); if (!clean.length) throw new Error('No prompts found.');
    p.docs.batch('Import prompts', () => {
      const st = newStory(sceneName, clean.join('\n'));
      const sc = p.story.addScene('Scene 1', st.id); if (!sc) return;
      clean.forEach((t, i) => { const sh = p.story.addShot(sc.id, `Shot ${i + 1}`); if (sh) p.story.updateShot(sh.id, { prompt: t, generatedPrompt: t, ...(keys[i] ? { frames: { first: keys[i]!.assetId } } : {}) }); });
    });
    send('board'); return { shots: clean.length };
  });

  /** A short title (2 to 5 words) for a story, project or picture set. null when the LLM is not available: callers keep their fallback name. */
  const suggestName = async (kind: string, text: string): Promise<string | null> => {
    try {
      if (!text.trim() || abort) return null;
      const out = await hub.use('enhance', () => hub.client.chat({ system: `Give a short title (2 to 5 words, no quotes, no trailing punctuation) for this ${kind}. Output only the title.`, user: text.slice(0, 3000), temperature: 0.5, maxTokens: 40, thinking: 'off' }), { label: `Name suggestion (${kind})` });
      const t = out.trim().split('\n')[0]!.replace(/^["'“]|["'”.]+$/g, '').trim();
      return t && t.length <= 60 ? t : null;
    } catch { return null; }
  };
  h('llmName', (kind: string, text: string) => suggestName(kind, text));
  /** A new story with this name, opened, and renamed by the LLM in the background if the name was only a placeholder. */
  const newStory = (name: string, about: string, auto = true) => {
    const p = P(); const st = p.story.addStory(name); p.saveBlob('active_story', st.id);
    if (auto) void suggestName('film story', about).then((n) => { if (n && p.story.story(st.id)?.name === name) { p.story.renameStory(st.id, n); send('board'); } });
    return st;
  };
  return { suggestName, newStory };
}
