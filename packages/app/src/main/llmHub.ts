import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { LlmClient, loadGuides, type Backend, type Guide, type Thinking } from '@driftboard/adapter-llm';

export type Task = 'director' | 'enhance' | 'chat';
export interface LlmSettings {
  url: string; model: string;
  /** which kind of server: 'auto' asks it (LM Studio, Ollama, or any other OpenAI-compatible one) */
  backend: Backend | 'auto';
  /** context length asked for when the app loads the model */
  contextLength: number;
  /** fail-safe: when a prompt does not fit, the model is reloaded with a bigger context, up to this many tokens */
  maxContext: number;
  /** reasoning level per kind of task */
  thinking: Record<Task, Thinking>;
  /** free the GPU before every ComfyUI job */
  unloadBeforeJob: boolean;
  /** free ComfyUI's models and cache before LLM work (ComfyUI keeps them in VRAM otherwise, which slows the LLM) */
  freeComfyBeforeLlm: boolean;
  /** free the GPU when a batch of LLM work (director step, "write all prompts") ends */
  unloadAfterBatch: boolean;
  /** free the GPU after this many idle minutes (0 = never) */
  idleMinutes: number;
  /** let LLM calls run while ComfyUI is generating (needs memory for both) */
  allowDuringJobs: boolean;
}
/** One LLM call or batch, kept for the Queue tab (memory only, newest last). */
export interface LlmTaskRec { id: string; kind: Task; label: string; status: 'running' | 'done' | 'failed' | 'cancelled'; started: number; ended?: number; error?: string; model: string }
export const DEFAULT_SETTINGS: LlmSettings = {
  url: 'http://127.0.0.1:1234/v1', model: '', backend: 'auto', contextLength: 16384, maxContext: 81920,
  thinking: { director: 'medium', enhance: 'medium', chat: 'low' },
  unloadBeforeJob: true, freeComfyBeforeLlm: true, unloadAfterBatch: true, idleMinutes: 1, allowDuringJobs: false,
};

const effortOf = (t: Thinking) => (t === 'off' ? 'none' : t);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Everything about using the LLM from the app: settings, guide files, loading the model with the right context,
 * and freeing the GPU at the right moments. One client lives for the whole run; settings change it in place.
 */
export class LlmHub {
  client = new LlmClient({ baseUrl: DEFAULT_SETTINGS.url });
  s: LlmSettings = structuredClone(DEFAULT_SETTINGS);
  guides = new Map<string, Guide>();
  /** returns true while ComfyUI is generating (set by the app) */
  gpuBusy: () => boolean = () => false;
  /** written to the app log (set by the app) */
  onLog: (level: 'info' | 'warn' | 'error', msg: string) => void = () => {};
  /** frees ComfyUI memory (set by the app) */
  freeComfy: () => Promise<boolean> = async () => false;
  /** LLM tasks for the Queue tab */
  tasks: LlmTaskRec[] = [];
  onTasks: (t: LlmTaskRec[]) => void = () => {};
  private seq = 0;
  /** One abort per running task, so Cancel stops any LLM work (Enhance, chat, director steps, batches). */
  private aborts = new Map<string, AbortController>();
  /** Stop every running LLM task. */
  cancelAll() { for (const a of this.aborts.values()) a.abort(); }
  private busy = 0;
  private idle: NodeJS.Timeout | null = null;

  constructor(private f: { settings: string; bundled: string; user: string }) {}

  async init() {
    try {
      const c = JSON.parse(await fs.readFile(this.f.settings, 'utf8')) as Partial<LlmSettings>;
      this.s = { ...DEFAULT_SETTINGS, ...c, thinking: { ...DEFAULT_SETTINGS.thinking, ...(c.thinking ?? {}) } };
    } catch { /* defaults */ }
    if (process.env.LLM_URL) this.s.url = process.env.LLM_URL;
    if (process.env.LLM_MODEL) this.s.model = process.env.LLM_MODEL;
    this.apply();
    await this.reloadGuides();
  }
  private apply() {
    this.client.baseUrl = this.s.url.replace(/\/+$/, '');
    this.client.model = this.s.model;
    this.client.backend = this.s.backend;
    this.client.contextLength = this.s.contextLength;
    this.client.maxContextLength = Math.max(this.s.maxContext, this.s.contextLength);
  }
  async set(patch: Partial<LlmSettings>) {
    this.s = { ...this.s, ...patch, thinking: { ...this.s.thinking, ...(patch.thinking ?? {}) } };
    this.apply();
    await fs.writeFile(this.f.settings, JSON.stringify(this.s, null, 2)).catch(() => {});
  }

  /* ----------------------------------------------------------- guides */
  async reloadGuides() { this.guides = await loadGuides([this.f.bundled, this.f.user]); }
  guide = (id: string) => this.guides.get(id);
  async saveGuide(id: string, body: string) {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error('Bad guide id');
    const g = this.guides.get(id);
    await fs.mkdir(this.f.user, { recursive: true });
    await fs.writeFile(path.join(this.f.user, `${id}.md`), `---\ntitle: ${g?.title ?? id}\n${g?.durationLine ? `durationLine: ${g.durationLine}\n` : ''}---\n${body.trim()}\n`);
    await this.reloadGuides();
  }
  async resetGuide(id: string) { await fs.rm(path.join(this.f.user, `${id}.md`), { force: true }); await this.reloadGuides(); }

  /* ----------------------------------------------------------- GPU handling */
  /** Run LLM work: wait for/refuse during ComfyUI jobs, load the model with the wanted context, then free it when appropriate. */
  async use<T>(task: Task, fn: () => Promise<T>, o: { batch?: boolean; label?: string } = {}): Promise<T> {
    if (!this.s.allowDuringJobs && this.gpuBusy()) throw new Error('ComfyUI is generating. LLM work waits for the queue so the two do not fight for GPU memory (change this in Settings).');
    if (o.label && this.tasks.some((t) => t.status === 'running' && t.label === o.label)) throw new Error(`“${o.label}” is already running.`);
    const rec: LlmTaskRec = { id: `llm-${++this.seq}`, kind: task, label: o.label ?? task, status: 'running', started: Date.now(), model: this.s.model };
    this.tasks.push(rec); if (this.tasks.length > 200) this.tasks.splice(0, this.tasks.length - 200); this.onTasks(this.tasks);
    this.busy++;
    const ac = new AbortController(); this.aborts.set(rec.id, ac);
    const prevSignal = this.client.signal; this.client.signal = prevSignal ? AbortSignal.any([prevSignal, ac.signal]) : ac.signal;
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    const t0 = Date.now();
    this.onLog('info', `${task}${o.batch ? ' (batch)' : ''}: start, model ${this.s.model || '(first available)'}`);
    try {
      if (!this.s.model) {
        const m = (await this.client.models()).find((x) => !x.embedding);
        if (!m) throw new Error('The LLM server has no models. Start LM Studio and download or load one.');
        this.s.model = m.id; this.apply();
      }
      this.client.contextLength = this.s.contextLength;   // back to the default after a fail-safe growth
      this.client.reasoningEffort = effortOf(this.s.thinking[task]);
      if (this.s.freeComfyBeforeLlm && !this.gpuBusy() && !(await this.llmLoaded())) await this.freeComfy();
      await this.client.ensureLoaded();
      const r = await fn();
      rec.status = 'done'; rec.ended = Date.now(); rec.model = this.s.model; this.onTasks(this.tasks);
      this.onLog('info', `${task}: done in ${Math.round((Date.now() - t0) / 1000)}s`);
      return r;
    } catch (e) {
      if (ac.signal.aborted) e = new Error('Cancelled');
      rec.status = /^Cancelled$/.test((e as Error).message) ? 'cancelled' : 'failed'; rec.ended = Date.now(); rec.error = (e as Error).message; this.onTasks(this.tasks);
      if (rec.status === 'cancelled') this.onLog('info', `${task}: cancelled after ${Math.round((Date.now() - t0) / 1000)}s`);
      else this.onLog('error', `${task}: failed after ${Math.round((Date.now() - t0) / 1000)}s: ${(e as Error).message}`);
      throw e;
    } finally {
      this.aborts.delete(rec.id); this.client.signal = prevSignal;
      this.busy--;
      if (this.busy === 0) await this.finished(!!o.batch);
    }
  }
  private async llmLoaded() { return (await this.client.models().catch(() => [])).some((m) => m.loaded && !m.embedding); }
  private async finished(batch: boolean) {
    if (batch && this.s.unloadAfterBatch) { await this.client.unloadAll().catch(() => 0); return; }
    if (this.s.idleMinutes > 0) {
      this.idle = setTimeout(() => { this.idle = null; if (this.busy === 0) void this.client.unloadAll().catch(() => 0); }, this.s.idleMinutes * 60_000);
    }
  }
  /** Called before each ComfyUI job: wait for running LLM work, then free the GPU. */
  async beforeJob() {
    while (this.busy > 0) await sleep(400);
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    if (this.s.unloadBeforeJob && (await this.client.models().catch(() => [])).some((m) => m.loaded)) await this.client.unloadAll();
  }
}
