import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Graph, Manifest } from '@driftboard/profiles';

/** Loader node class -> the input that names its model file, and the model kind it loads. */
export const LOADER_FILE: Record<string, string> = { UNETLoader: 'unet_name', CLIPLoader: 'clip_name', VAELoader: 'vae_name', LoraLoader: 'lora_name', LoraLoaderModelOnly: 'lora_name', CheckpointLoaderSimple: 'ckpt_name' };
const LOADER_KIND: Record<string, string> = { UNETLoader: 'unet', CLIPLoader: 'clip', VAELoader: 'vae', LoraLoader: 'lora', LoraLoaderModelOnly: 'lora', CheckpointLoaderSimple: 'checkpoint' };
const KIND_LOADER: Record<string, string> = { unet: 'UNETLoader', clip: 'CLIPLoader', vae: 'VAELoader', lora: 'LoraLoader', checkpoint: 'CheckpointLoaderSimple' };

export interface OutputFile { filename: string; subfolder: string; type: string; nodeId: string; kind: 'images' | 'gifs' | 'videos' | 'audio' }
export type ComfyEvent =
  | { type: 'queued'; promptId: string }
  | { type: 'progress'; promptId: string; value: number; max: number; node?: string }
  | { type: 'executing'; promptId: string; node: string | null }
  | { type: 'success'; promptId: string }
  | { type: 'error'; promptId: string; message: string; nodeType?: string }
  | { type: 'interrupted'; promptId: string }
  | { type: 'lost' };

export class ComfyError extends Error {
  constructor(message: string, readonly detail?: unknown) { super(message); }
}

export interface ClientOptions { baseUrl?: string; clientId?: string; fetch?: typeof fetch; WebSocket?: typeof WebSocket }

/** Thin ComfyUI client: only what Driftboard needs. No model knowledge. */
export class ComfyClient {
  readonly baseUrl: string;
  readonly clientId: string;
  private f: typeof fetch;
  private WS: typeof WebSocket;
  constructor(o: ClientOptions = {}) {
    this.baseUrl = (o.baseUrl ?? 'http://127.0.0.1:8188').replace(/\/$/, '');
    this.clientId = o.clientId ?? `driftboard-${Math.random().toString(36).slice(2, 10)}`;
    this.f = o.fetch ?? fetch;
    this.WS = o.WebSocket ?? WebSocket;
  }

  private async json<T>(p: string, init?: RequestInit): Promise<T> {
    let r: Response;
    try { r = await this.f(this.baseUrl + p, init); }
    catch (e) { throw new ComfyError(`Cannot reach ComfyUI at ${this.baseUrl} (${(e as Error).message}). Is it running?`); }
    const text = await r.text();
    let body: unknown; try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
    if (!r.ok) throw new ComfyError(`ComfyUI ${p} failed (${r.status})`, body);
    return body as T;
  }

  async ping(): Promise<{ version?: string; devices?: unknown[] }> {
    const s = await this.json<{ system?: { comfyui_version?: string }; devices?: unknown[] }>('/system_stats');
    return { version: s.system?.comfyui_version, devices: s.devices };
  }

  async objectInfo(classes: string[]): Promise<Record<string, any>> {
    const out: Record<string, any> = {};
    await Promise.all(classes.map(async (c) => {
      try { Object.assign(out, await this.json(`/object_info/${encodeURIComponent(c)}`)); } catch { /* missing class = absent key */ }
    }));
    return out;
  }

  /** Upload bytes; returns the name to put in a LoadImage input. */
  async upload(data: Uint8Array, name: string): Promise<string> {
    const fd = new FormData();
    fd.append('image', new Blob([data as BlobPart]), name);
    fd.append('overwrite', 'true');
    const r = await this.json<{ name: string; subfolder?: string }>('/upload/image', { method: 'POST', body: fd });
    return r.subfolder ? `${r.subfolder}/${r.name}` : r.name;
  }
  async uploadFile(file: string, name = path.basename(file)): Promise<string> { return this.upload(await readFile(file), name); }

  /** Queue a graph. Server echoes our prompt_id. Throws ComfyError with node errors spelled out. */
  async submit(graph: Graph, promptId: string): Promise<void> {
    let r: Response;
    try {
      r = await this.f(this.baseUrl + '/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: graph, client_id: this.clientId, prompt_id: promptId }) });
    } catch (e) { throw new ComfyError(`Cannot reach ComfyUI at ${this.baseUrl} (${(e as Error).message}).`); }
    const body = await r.json().catch(() => ({})) as { error?: { message?: string }; node_errors?: Record<string, { errors?: { message: string; details?: string }[]; class_type?: string }> };
    const nodeErrs = Object.entries(body.node_errors ?? {});
    if (!r.ok || body.error || nodeErrs.length) {
      const parts = nodeErrs.flatMap(([id, e]) => (e.errors ?? []).map((x) => `node ${id} (${e.class_type}): ${x.message}${x.details ? ` ${x.details}` : ''}`));
      throw new ComfyError(`ComfyUI rejected the workflow: ${body.error?.message ?? ''} ${parts.join('; ')}`.trim(), body);
    }
  }

  async interrupt(promptId: string): Promise<void> {
    await this.json('/interrupt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt_id: promptId }) });
  }
  async dequeue(promptId: string): Promise<void> {
    await this.json('/queue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ delete: [promptId] }) });
  }
  /** 'running' | 'pending' | 'unknown' from /queue. */
  async queueState(promptId: string): Promise<'running' | 'pending' | 'unknown'> {
    const q = await this.json<{ queue_running: unknown[][]; queue_pending: unknown[][] }>('/queue');
    if (q.queue_running.some((i) => i[1] === promptId)) return 'running';
    if (q.queue_pending.some((i) => i[1] === promptId)) return 'pending';
    return 'unknown';
  }
  async free(unloadModels = true): Promise<void> {
    await this.json('/free', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ unload_models: unloadModels, free_memory: true }) });
  }

  /** History entry, or undefined while not finished. */
  async history(promptId: string): Promise<{ status: string; files: OutputFile[]; error?: string } | undefined> {
    const h = await this.json<Record<string, any>>(`/history/${promptId}`);
    const e = h[promptId];
    if (!e) return undefined;
    const files: OutputFile[] = [];
    for (const [nodeId, out] of Object.entries<any>(e.outputs ?? {}))
      for (const kind of ['images', 'gifs', 'videos', 'audio'] as const)
        for (const f of out[kind] ?? []) files.push({ filename: f.filename, subfolder: f.subfolder ?? '', type: f.type ?? 'output', nodeId, kind });
    let error: string | undefined;
    if (e.status?.status_str === 'error') {
      const m = (e.status.messages ?? []).find((x: any[]) => x[0] === 'execution_error');
      error = m ? `${m[1].node_type}: ${m[1].exception_message}` : 'ComfyUI reported an error';
    }
    return { status: e.status?.status_str ?? 'unknown', files, error };
  }

  async view(f: OutputFile): Promise<Uint8Array> {
    const q = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder, type: f.type });
    let r: Response;
    try { r = await this.f(`${this.baseUrl}/view?${q}`); } catch (e) { throw new ComfyError(`Cannot reach ComfyUI (${(e as Error).message})`); }
    if (!r.ok) throw new ComfyError(`Could not download ${f.filename} (${r.status})`);
    return new Uint8Array(await r.arrayBuffer());
  }

  /**
   * Wait for a prompt to finish. Uses the websocket for live progress and polls /history every few seconds
   * as a safety net (websocket can drop or miss the final message). Resolves with the final event.
   */
  waitFor(promptId: string, onEvent: (e: ComfyEvent) => void, opts: { pollMs?: number; signal?: AbortSignal } = {}): Promise<ComfyEvent> {
    const pollMs = opts.pollMs ?? 3000;
    return new Promise((resolve) => {
      let done = false, ws: WebSocket | undefined, timer: ReturnType<typeof setInterval> | undefined;
      const finish = (e: ComfyEvent) => { if (done) return; done = true; clearInterval(timer); try { ws?.close(); } catch { /* ignore */ } onEvent(e); resolve(e); };
      try {
        ws = new this.WS(`${this.baseUrl.replace(/^http/, 'ws')}/ws?clientId=${this.clientId}`);
        ws.onmessage = (m: MessageEvent) => {
          if (typeof m.data !== 'string') return;
          let d: any; try { d = JSON.parse(m.data); } catch { return; }
          if (d.data?.prompt_id && d.data.prompt_id !== promptId) return;
          if (d.type === 'progress') onEvent({ type: 'progress', promptId, value: d.data.value, max: d.data.max, node: d.data.node });
          else if (d.type === 'executing' && d.data.prompt_id) onEvent({ type: 'executing', promptId, node: d.data.node });
          else if (d.type === 'execution_success') finish({ type: 'success', promptId });
          else if (d.type === 'execution_error') finish({ type: 'error', promptId, message: d.data.exception_message, nodeType: d.data.node_type });
          else if (d.type === 'execution_interrupted') finish({ type: 'interrupted', promptId });
        };
        ws.onerror = () => { /* polling still covers us */ };
      } catch { /* no websocket: polling only */ }
      const poll = async () => {
        if (done) return;
        try {
          const h = await this.history(promptId);
          if (!h) return;
          if (h.status === 'success') finish({ type: 'success', promptId });
          else if (h.status === 'error') finish({ type: 'error', promptId, message: h.error ?? 'error' });
        } catch { /* ComfyUI unreachable right now; keep trying */ }
      };
      timer = setInterval(poll, pollMs);
      opts.signal?.addEventListener('abort', () => finish({ type: 'lost' }));
    });
  }

  /** Pre-flight: which node classes and models the profile needs are missing on this ComfyUI. */
  /**
   * Is everything this profile needs installed? With `graph` (the applied graph of a real job) it checks exactly the
   * nodes and model files that job sends; without, the profile's declared stock requirements.
   */
  async preflight(m: Manifest, graph?: Graph): Promise<{ ok: boolean; missingNodes: string[]; missingModels: { kind: string; name: string }[] }> {
    await this.ping();   // unreachable ComfyUI must not look like "everything is missing"
    const wanted: { kind: string; name: string }[] = [];
    let nodeClasses: string[];
    if (graph) {
      nodeClasses = [...new Set(Object.values(graph).map((n) => n.class_type))];
      for (const n of Object.values(graph)) {
        const input = LOADER_FILE[n.class_type], v = input ? n.inputs[input] : undefined;
        if (typeof v === 'string' && v) wanted.push({ kind: LOADER_KIND[n.class_type]!, name: v });
      }
    } else {
      nodeClasses = m.requires.nodeClasses;
      for (const [kind, names] of Object.entries(m.requires.models)) for (const name of names) wanted.push({ kind, name });
    }
    const loaderClasses = [...new Set(wanted.map((w) => KIND_LOADER[w.kind]).filter((x): x is string => !!x))];
    const info = await this.objectInfo([...new Set([...nodeClasses, ...loaderClasses])]);
    const missingNodes = nodeClasses.filter((c) => !info[c]);
    const missingModels = wanted.filter((w) => {
      const l = KIND_LOADER[w.kind]; if (!l || !info[l]) return false;   // a missing loader node is already reported
      const have: string[] = info[l]?.input?.required?.[LOADER_FILE[l]!]?.[0] ?? [];
      return !have.includes(w.name);
    });
    return { ok: !missingNodes.length && !missingModels.length, missingNodes, missingModels };
  }

  /** Model files ComfyUI offers for one kind (unet, clip, vae, lora, checkpoint): the loader node's own list. */
  async modelFiles(kind: string): Promise<string[]> {
    const l = KIND_LOADER[kind]; if (!l) return [];
    const info = await this.objectInfo([l]);
    const v = info[l]?.input?.required?.[LOADER_FILE[l]!]?.[0];
    return Array.isArray(v) ? v.filter((x: unknown): x is string => typeof x === 'string') : [];
  }
}
