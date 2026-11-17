import { parseLooseJson } from './json.ts';

export type Format = 'json_schema' | 'json_object' | 'none';
const LADDER: Format[] = ['json_schema', 'json_object', 'none'];

export type Thinking = 'off' | 'low' | 'medium' | 'high';
/** Extra tokens to allow for hidden reasoning, so the answer is not cut off. */
const THINK_TOKENS: Record<Thinking, number> = { off: 0, low: 1500, medium: 3500, high: 7000 };
/** Remove reasoning a model wrote into its reply. */
export const stripThinking = (t: string) => t.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').replace(/^[\s\S]*<\/think(?:ing)?>/i, '').trim();

export class LlmError extends Error {
  constructor(message: string, readonly kind: 'unreachable' | 'http' | 'empty' | 'invalid' = 'http') { super(message); }
}

/**
 * Which kind of local server answers. LM Studio and Ollama can list, load (with a context size) and unload models,
 * so the app can free the GPU before ComfyUI runs. Any other OpenAI-compatible server (llama.cpp server, KoboldCpp,
 * text-generation-webui, Jan, vLLM, LocalAI...) can chat, usually list, but not load or unload.
 */
export type Backend = 'lmstudio' | 'ollama' | 'openai';
export interface BackendCaps { kind: Backend; listModels: boolean; loadUnload: boolean; setContext: boolean }
export const capsOf = (kind: Backend): BackendCaps => ({ kind, listModels: true, loadUnload: kind !== 'openai', setContext: kind !== 'openai' });

export interface LlmOptions {
  baseUrl?: string;          // OpenAI-compatible root, e.g. http://127.0.0.1:1234/v1
  /** 'auto' (default) asks the server what it is */
  backend?: Backend | 'auto';
  model?: string;
  apiKey?: string;
  /** Sent as reasoning_effort. Gemma 4 in LM Studio burns its whole token budget on hidden reasoning without "none". */
  reasoningEffort?: string | null;
  fetch?: typeof fetch;
}

export interface ChatRequest {
  system: string; user: string;
  /** earlier turns of a conversation, between the system prompt and the new user message */
  history?: { role: 'user' | 'assistant'; content: string }[];
  /** pictures for the user message, as data URLs (needs a vision model) */
  images?: string[];
  schema?: object;
  /** Reasoning for this request; defaults to the client's setting. */
  thinking?: Thinking;
  temperature?: number; maxTokens?: number; timeoutMs?: number; signal?: AbortSignal;
}

/** OpenAI-compatible chat plus the LM Studio calls Driftboard needs (list, unload). No model knowledge. */
export class LlmClient {
  baseUrl: string; model: string; reasoningEffort: string | null;
  /** Context length asked for when this client loads a model (LM Studio). */
  contextLength = 16384;
  /** the most the client may grow the context to when a prompt does not fit (reloads the model) */
  maxContextLength = 81920;
  /** reasoning settings the loaded model accepts (LM Studio reports them; e.g. [off, on] for Gemma). Undefined = unknown, send as asked. */
  reasoningOptions?: string[];
  /** Applied to every request that has no signal of its own (lets a caller cancel a whole pipeline run). */
  signal?: AbortSignal;
  private apiKey?: string;
  private f: typeof fetch;
  private format = new Map<string, Format>();   // what each server/model accepted last time
  /** 'auto' detects the server once per address */
  backend: Backend | 'auto';
  private detected = new Map<string, Backend>();
  /** Ollama: models that refused the think switch (not a thinking model), so it is left out next time */
  private noThink = new Set<string>();

  constructor(o: LlmOptions = {}) {
    this.baseUrl = (o.baseUrl ?? 'http://127.0.0.1:1234/v1').replace(/\/+$/, '');
    this.model = o.model ?? '';
    this.apiKey = o.apiKey;
    this.reasoningEffort = o.reasoningEffort === undefined ? 'none' : o.reasoningEffort;
    this.f = o.fetch ?? fetch;
    this.backend = o.backend ?? 'auto';
  }

  /** What kind of server this is: the setting, or found out by asking (LM Studio's /api/v1/models, Ollama's /api/version). */
  async kind(): Promise<Backend> {
    if (this.backend !== 'auto') return this.backend;
    const hit = this.detected.get(this.baseUrl); if (hit) return hit;
    let k: Backend = 'openai';
    const lms = await this.req(`${this.root()}/api/v1/models`, { timeoutMs: 3000 }).catch(() => null);
    if (lms?.ok && Array.isArray(((await lms.json().catch(() => ({}))) as { models?: unknown }).models)) k = 'lmstudio';
    else {
      const ol = await this.req(`${this.root()}/api/version`, { timeoutMs: 3000 }).catch(() => null);
      if (ol?.ok && typeof ((await ol.json().catch(() => ({}))) as { version?: unknown }).version === 'string') k = 'ollama';
    }
    // only remember an answer from a server that is up (else the next try may find it)
    if (k !== 'openai' || (await this.req(`${this.baseUrl}/models`, { timeoutMs: 3000 }).catch(() => null))?.ok) this.detected.set(this.baseUrl, k);
    return k;
  }
  async caps(): Promise<BackendCaps> { return capsOf(await this.kind()); }

  private root() { return this.baseUrl.replace(/\/v1$/, ''); }
  private headers(): Record<string, string> { return { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) }; }

  private async req(url: string, init: RequestInit & { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Response> {
    const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(init.timeoutMs ?? 600_000)]) : AbortSignal.timeout(init.timeoutMs ?? 600_000);
    try { return await this.f(url, { ...init, signal, headers: { ...this.headers(), ...(init.headers as Record<string, string> | undefined) } }); }
    catch (e) {
      if (init.signal?.aborted) throw new LlmError('Cancelled', 'http');
      throw new LlmError(`Nothing answered at ${this.baseUrl}${(e as Error).name === 'TimeoutError' ? ' (it took too long)' : ''}. Is the LLM server running?`, 'unreachable');
    }
  }

  /** Models the server offers. For LM Studio this also says which are loaded. */
  async models(): Promise<{ id: string; loaded: boolean; instances: string[]; embedding: boolean; context?: number; maxContext?: number; reasoning?: string[] }[]> {
    const kind = await this.kind();
    if (kind === 'ollama') {
      const t = await this.req(`${this.root()}/api/tags`, { timeoutMs: 5000 });
      if (!t.ok) throw new LlmError(`The LLM server answered ${t.status} on /api/tags`);
      const tags = ((await t.json().catch(() => ({}))) as { models?: { name: string; details?: { family?: string; families?: string[] } }[] }).models ?? [];
      const ps = ((await (await this.req(`${this.root()}/api/ps`, { timeoutMs: 5000 }).catch(() => null))?.json().catch(() => ({})) ?? {}) as { models?: { name: string; context_length?: number }[] }).models ?? [];
      return tags.map((m) => {
        const run = ps.find((x) => x.name === m.name);
        const fam = [m.details?.family ?? '', ...(m.details?.families ?? [])].join(' ');
        return { id: m.name, loaded: !!run, instances: run ? [m.name] : [], embedding: /embed|bert/i.test(m.name + ' ' + fam), context: run?.context_length };
      });
    }
    const lms = kind === 'lmstudio' ? await this.req(`${this.root()}/api/v1/models`, { timeoutMs: 5000 }).catch(() => null) : null;
    if (lms?.ok) {
      const j = await lms.json().catch(() => ({})) as { models?: { key: string; type?: string; capabilities?: { reasoning?: { allowed_options?: string[] } }; loaded_instances?: { id?: string; instance_id?: string; config?: { context_length?: number } }[]; max_context_length?: number }[] };
      if (Array.isArray(j.models)) return j.models.map((m) => ({
        id: m.key, embedding: m.type === 'embedding', loaded: (m.loaded_instances?.length ?? 0) > 0,
        instances: (m.loaded_instances ?? []).map((i) => i.id ?? i.instance_id ?? m.key),
        context: m.loaded_instances?.[0]?.config?.context_length, maxContext: m.max_context_length, reasoning: m.capabilities?.reasoning?.allowed_options,
      }));
    }
    const r = await this.req(`${this.baseUrl}/models`, { timeoutMs: 5000 });
    if (!r.ok) throw new LlmError(`The LLM server answered ${r.status} on /models`);
    const j = await r.json().catch(() => ({})) as { data?: { id: string }[] };
    return (j.data ?? []).map((m) => ({ id: m.id, loaded: false, instances: [], embedding: /embed/i.test(m.id) }));
  }

  /** Free the memory: unload every loaded model (LM Studio). Returns how many were unloaded. */
  async unloadAll(keep?: string): Promise<number> {
    const kind = await this.kind().catch(() => 'openai' as Backend);
    if (kind === 'openai') return 0;   // this kind of server cannot unload on request
    let n = 0;
    for (const m of await this.models().catch(() => [])) for (const id of m.instances) {
      if (keep && m.id === keep) continue;
      const r = kind === 'ollama'
        ? await this.req(`${this.root()}/api/generate`, { method: 'POST', body: JSON.stringify({ model: m.id, keep_alive: 0 }), timeoutMs: 30_000 }).catch(() => null)
        : await this.req(`${this.root()}/api/v1/models/unload`, { method: 'POST', body: JSON.stringify({ instance_id: id }), timeoutMs: 30_000 }).catch(() => null);
      if (r?.ok) n++;
    }
    return n;
  }

  /**
   * Make sure the chosen model is loaded with the wanted context length (LM Studio). Loads it if it is not,
   * reloads it if the context differs. Does nothing on servers without the load call (they load on demand).
   */
  async ensureLoaded(force = false): Promise<void> {
    if (!this.model) return;
    const all = await this.models().catch(() => []);
    const m = all.find((x) => x.id === this.model);
    if (!m) return;
    if (await this.kind() === 'openai') return;   // loads on demand; nothing to ask for
    this.reasoningOptions = m.reasoning;
    if (force && m.loaded && m.context !== undefined && m.context >= this.contextLength) return;
    if (force) { /* reload with the bigger context below */ } else
    // Already loaded (by us or by hand): use it as is when its context is big enough (a call needs only 2-4k).
    // Free any OTHER loaded model: two models at once is what runs the GPU out of memory.
    if (m.loaded && (m.context === undefined || m.context >= Math.min(this.contextLength, 8192))) {
      if (all.some((x) => x.id !== m.id && x.loaded)) await this.unloadAll(m.id);
      return;
    }
    await this.unloadAll();
    if (await this.kind() === 'ollama') {
      const r = await this.req(`${this.root()}/api/generate`, { method: 'POST', body: JSON.stringify({ model: this.model, keep_alive: '30m', options: { num_ctx: this.contextLength } }), timeoutMs: 300_000 }).catch(() => null);
      if (r && !r.ok) throw new LlmError(`Could not load ${this.model}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
      return;
    }
    if (await this.kind() !== 'lmstudio') return;
    const body = (extra: object) => JSON.stringify({ model: this.model, context_length: Math.min(this.contextLength, m.maxContext ?? this.contextLength), ...extra });
    const tryLoad = async () => {
      let r = await this.req(`${this.root()}/api/v1/models/load`, { method: 'POST', body: body({ parallel: 1 }), timeoutMs: 300_000 }).catch(() => null);
      if (r && !r.ok) r = await this.req(`${this.root()}/api/v1/models/load`, { method: 'POST', body: body({}), timeoutMs: 300_000 }).catch(() => null);
      return r;
    };
    let r = await tryLoad();
    if (r && !r.ok) { await new Promise((x) => setTimeout(x, 2000)); await this.unloadAll(); r = await tryLoad(); }   // memory may still be settling
    if (r && !r.ok) throw new LlmError(`Could not load ${this.model}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  }

  /** One reply as text. With a schema it walks json_schema -> json_object -> plain and remembers what worked. */
  async chat(r: ChatRequest): Promise<string> {
    try { return await this.chatOnce(r); }
    catch (e) {
      // Prompt too long for the loaded context: reload with a bigger one (up to the maximum) and retry.
      const m0 = (e as Error).message;
      if (e instanceof LlmError && /context|n_ctx|too long|exceed/i.test(m0) && !/bad allocation/i.test(m0) && this.contextLength < this.maxContextLength) {
        this.contextLength = Math.min(this.maxContextLength, this.contextLength * 2);
        await this.unloadAll().catch(() => 0);
        await this.ensureLoaded(true);
        return await this.chatOnce(r);
      }
      // "bad allocation" (500) or a dropped connection usually means the server ran out of memory or reloaded: free, reload and try once more.
      const msg = (e as Error).message;
      if (!(e instanceof LlmError) || (r.signal ?? this.signal)?.aborted || msg === 'Cancelled' || !/ 5\d\d:|bad allocation|fetch failed|Nothing answered/.test(msg)) throw e;
      await this.unloadAll().catch(() => 0);
      await new Promise((x) => setTimeout(x, 3000));
      await this.ensureLoaded();
      return await this.chatOnce(r);
    }
  }

  private async chatOnce(r: ChatRequest): Promise<string> {
    if (!this.model) throw new LlmError('No model is chosen for the LLM.');
    const key = `${this.baseUrl}|${this.model}`;
    let effort: string | null | undefined = r.thinking ? (r.thinking === 'off' ? 'none' : r.thinking) : this.reasoningEffort;
    const onOff = !!this.reasoningOptions && this.reasoningOptions.includes('on') && !this.reasoningOptions.includes('low');
    const askedThinking = !!effort && effort !== 'none';
    // models with only on/off: the OpenAI-style endpoint only knows none/minimal/low/.., so "on" = leave the setting out (the model's own default is on) and "off" = none
    if (onOff) effort = askedThinking ? undefined : 'none';
    let extra = askedThinking ? THINK_TOKENS[(onOff ? 'medium' : effort) as Thinking] ?? 3500 : 0;
    const start = r.schema ? Math.max(0, LADDER.indexOf(this.format.get(key) ?? 'json_schema')) : 2;
    const note = r.schema ? `\n\nAnswer with one JSON object that matches this JSON schema and nothing else:\n${JSON.stringify(r.schema)}` : '';
    let last: LlmError | undefined;
    let thinkingOff = !askedThinking;   // an empty reply with thinking on is retried once with thinking off (and some room), before stepping down the format ladder
    if (await this.kind() === 'ollama') return this.chatOllama(r, { start, note, key, askedThinking });
    for (let i = start; i < LADDER.length; i++) {
      const f = LADDER[i]!;
      const body: Record<string, unknown> = {
        model: this.model, temperature: r.temperature ?? 0.4, max_tokens: (r.maxTokens ?? 2500) + extra, stream: false,
        messages: [{ role: 'system', content: r.system + (f === 'json_schema' ? '' : note) }, ...(r.history ?? []), { role: 'user', content: r.images?.length ? [{ type: 'text', text: r.user }, ...r.images.map((u) => ({ type: 'image_url', image_url: { url: u } }))] : r.user }],
      };
      if (effort) body.reasoning_effort = effort;
      if (f === 'json_schema' && r.schema) body.response_format = { type: 'json_schema', json_schema: { name: 'answer', schema: r.schema, strict: false } };
      else if (f === 'json_object') body.response_format = { type: 'json_object' };
      const res = await this.req(`${this.baseUrl}/chat/completions`, { method: 'POST', body: JSON.stringify(body), timeoutMs: r.timeoutMs, signal: r.signal ?? this.signal });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        last = new LlmError(`LLM error ${res.status}: ${t.slice(0, 300)}`);
        if (res.status === 400 && f !== 'none') continue;   // this server does not take that response_format: step down
        throw last;
      }
      const j = await res.json().catch(() => ({})) as { choices?: { message?: { content?: string }; finish_reason?: string }[] };
      const text = stripThinking(j.choices?.[0]?.message?.content ?? '');
      if (!text.trim()) {
        last = new LlmError('The LLM returned an empty reply even with thinking turned off (the model may have failed to produce output; check LM Studio).', 'empty');
        if (!thinkingOff) {   // the model spent its whole budget on hidden reasoning: ask again without it, same format
          thinkingOff = true; effort = 'none'; extra = 1000; i--; continue;
        }
        if (f !== 'none') continue;
        throw last;
      }
      if (r.schema) this.format.set(key, f);   // a plain reply says nothing about which JSON format the server takes
      return text;
    }
    throw last ?? new LlmError('No reply');
  }

  /**
   * Ollama's own chat call: it takes the context size per request (the OpenAI-style call would use the model's small
   * default and silently cut long guides), pictures as base64, a JSON schema as `format`, and thinking as on/off.
   */
  private async chatOllama(r: ChatRequest, o: { start: number; note: string; key: string; askedThinking: boolean }): Promise<string> {
    let last: LlmError | undefined;
    let think: boolean | undefined = this.noThink.has(this.model) ? undefined : o.askedThinking;
    let extra = o.askedThinking ? THINK_TOKENS[(r.thinking ?? 'medium') as Thinking] ?? 3500 : 0;
    const images = (r.images ?? []).map((u) => u.replace(/^data:[^,]*,/, ''));
    for (let i = o.start; i < LADDER.length; i++) {
      const f = LADDER[i]!;
      const body: Record<string, unknown> = {
        model: this.model, stream: false, keep_alive: '30m',
        options: { temperature: r.temperature ?? 0.4, num_ctx: this.contextLength, num_predict: (r.maxTokens ?? 2500) + extra },
        messages: [{ role: 'system', content: r.system + (f === 'json_schema' ? '' : o.note) }, ...(r.history ?? []), { role: 'user', content: r.user, ...(images.length ? { images } : {}) }],
      };
      if (think !== undefined) body.think = think;
      if (f === 'json_schema' && r.schema) body.format = r.schema; else if (f === 'json_object') body.format = 'json';
      const res = await this.req(`${this.root()}/api/chat`, { method: 'POST', body: JSON.stringify(body), timeoutMs: r.timeoutMs, signal: r.signal ?? this.signal });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        last = new LlmError(`LLM error ${res.status}: ${t.slice(0, 300)}`);
        if (res.status === 400 && think !== undefined && /think/i.test(t)) { this.noThink.add(this.model); think = undefined; i--; continue; }   // not a thinking model
        if (res.status === 400 && f !== 'none') continue;
        throw last;
      }
      const j = await res.json().catch(() => ({})) as { message?: { content?: string } };
      const text = stripThinking(j.message?.content ?? '');
      if (!text.trim()) {
        last = new LlmError('The LLM returned an empty reply even with thinking turned off (the model may have failed to produce output; check Ollama).', 'empty');
        if (think) { think = false; extra = 1000; i--; continue; }
        if (f !== 'none') continue;
        throw last;
      }
      if (r.schema) this.format.set(o.key, f);
      return text;
    }
    throw last ?? new LlmError('No reply');
  }

  /**
   * A validated object. Reads the reply forgivingly, checks it with `validate`, and on failure asks once more with
   * the problem spelled out. `validate` throws a plain-language message on bad data.
   */
  async json<T>(r: ChatRequest & { validate: (raw: unknown) => T; retries?: number }): Promise<{ value: T; attempts: number }> {
    let user = r.user, problem = '';
    const tries = (r.retries ?? 1) + 1;
    for (let attempt = 1; attempt <= tries; attempt++) {
      const text = await this.chat({ ...r, user });
      try { return { value: r.validate(parseLooseJson(text)), attempts: attempt }; }
      catch (e) {
        problem = (e as Error).message;
        user = `${r.user}\n\nYour previous answer could not be used: ${problem}\nAnswer again with only the corrected JSON.`;
      }
    }
    throw new LlmError(`The LLM kept giving unusable answers (${problem}).`, 'invalid');
  }
}
