import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomInt } from 'node:crypto';
import { hashJson, type Job, type Project, type IoRef } from '@driftboard/core';
import { applySlots, type Graph, type Profile, type SlotValues } from '@driftboard/profiles';
import { ComfyClient, ComfyError, LOADER_FILE } from './client.ts';

export interface EnqueueRequest {
  profileId: string;
  /** Slot values. Image slots hold Driftboard asset ids (string, or string[] for lists). */
  values: SlotValues;
  kind?: string;
  /** board item the job was started from; results are placed beside it */
  origin?: string;
  /** shot the results belong to */
  shotId?: string;
}

export interface RunnerEvents {
  job: [Job];
  progress: [jobId: string, fraction: number];
  idle: [];
}

const VIDEO_EXT = /\.(mp4|webm|mov|mkv|gif)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const AUDIO_EXT = /\.(wav|mp3|flac|ogg|m4a)$/i;

/** Runs queued Driftboard jobs on ComfyUI, one at a time, in order. */
export class JobRunner extends EventEmitter<RunnerEvents> {
  private profiles = new Map<string, Profile>();
  private uploaded = new Map<string, string>();
  private preflightCache = new Map<string, { at: number; msg: string | null }>();
  private current: { jobId: string; promptId: string; cancelled: boolean } | null = null;
  private running = false;

  constructor(private project: Project, private client: ComfyClient, profiles: Profile[], private opts: { preflightTtlMs?: number; pollMs?: number; /** called before each job (e.g. to unload the LLM and free the GPU); errors are ignored */ /** the user's saved defaults for a profile (Settings → ComfyUI); the request's own values win, and the merged set is what the job records */ defaults?: (profileId: string) => SlotValues; beforeJob?: () => Promise<unknown> } = {}) {
    super();
    for (const p of profiles) this.profiles.set(p.manifest.id, p);
  }

  /** Validate, record the recipe (with a fixed seed so retries reproduce), and queue. */
  async enqueue(req: EnqueueRequest): Promise<Job> {
    const profile = this.profiles.get(req.profileId);
    if (!profile) throw new Error(`Unknown profile ${req.profileId}`);
    const saved = this.opts.defaults?.(req.profileId) ?? {};
    const known = new Set(profile.manifest.slots.filter((s) => !['image', 'image_list', 'video', 'video_list', 'audio_list'].includes(s.type)).map((s) => s.id));
    const values: SlotValues = { ...Object.fromEntries(Object.entries(saved).filter(([k, v]) => known.has(k) && v !== undefined && v !== null && v !== '')), ...req.values };
    // set-once settings nobody chose: record the workflow's own value, so the job says exactly what ran
    for (const s of profile.manifest.slots) {
      if (!s.advanced || values[s.id] !== undefined) continue;
      if (s.type === 'boolean') { values[s.id] = s.default; continue; }
      const b = 'bind' in s ? s.bind?.[0] : undefined; const v = b ? profile.workflow[b.node]?.inputs[b.input] : undefined;
      if ((s.type === 'number' && typeof v === 'number') || (s.type === 'enum' && typeof v === 'string')) values[s.id] = v;
    }
    for (const s of profile.manifest.slots) if (s.type === 'number' && s.role === 'seed' && values[s.id] === undefined) values[s.id] = randomInt(0, 2 ** 47);
    // fail now, not later: check values with placeholder image names
    applySlots(profile, mapImages(profile, values, (id) => `${id}.png`));
    const inputs: IoRef[] = [];
    for (const s of profile.manifest.slots) {
      const v = values[s.id];
      if (s.type === 'image' && typeof v === 'string') inputs.push({ assetId: v, role: s.id, idx: 0 });
      if (s.type === 'video' && typeof v === 'string') inputs.push({ assetId: v, role: s.id, idx: 0 });
      if ((s.type === 'image_list' || s.type === 'video_list' || s.type === 'audio_list') && Array.isArray(v)) (v as string[]).forEach((a, i) => inputs.push({ assetId: a, role: s.id, idx: i }));
    }
    for (const i of inputs) if (!this.project.assets.get(i.assetId)) throw new Error(`Asset ${i.assetId.slice(0, 8)} is not in this project`);
    await this.saveProfileCopy(profile);
    const job = this.project.jobs.create({ kind: req.kind ?? 'generate', profileId: profile.manifest.id, profileVersion: profile.manifest.version, params: values, inputs, origin: req.origin, shotId: req.shotId });
    this.emit('job', job);
    void this.kick();
    return job;
  }

  /** Cancel a queued or running job. */
  async cancel(jobId: string): Promise<void> {
    const job = this.project.jobs.get(jobId);
    if (!job) return;
    if (job.status === 'queued') { this.emit('job', this.project.jobs.transition(jobId, 'cancelled')); return; }
    if (job.status === 'running' && this.current?.jobId === jobId) {
      this.current.cancelled = true;
      const pid = this.current.promptId;
      if ((await this.client.queueState(pid).catch(() => 'unknown')) === 'pending') await this.client.dequeue(pid).catch(() => {});
      else await this.client.interrupt(pid).catch(() => {});
    }
  }

  /** Process the queue until empty. Safe to call repeatedly. */
  async kick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let job = this.project.jobs.claimNext(); job; job = this.project.jobs.claimNext()) {
        this.emit('job', job);
        try { await this.opts.beforeJob?.(); } catch { /* freeing memory is best effort */ }
        await this.runOne(job);
      }
    } finally { this.running = false; this.emit('idle'); }
  }

  get busy() { return this.running; }

  private async runOne(job: Job): Promise<void> {
    const jobs = this.project.jobs;
    const fail = (msg: string): void => { this.emit('job', jobs.transition(job.id, 'failed', { error: msg })); };
    const promptId = job.id;
    this.current = { jobId: job.id, promptId, cancelled: false };
    try {
      const profile = this.profiles.get(job.profile_id ?? '');
      if (!profile) return fail(`Profile ${job.profile_id} is not installed`);
      if (profile.manifest.version !== job.profile_version) {
        // recipe was made with another version; run with the installed one but say so
        job = { ...job };
      }
      const values = JSON.parse(job.params) as SlotValues;
      // check the graph this job will really send (chosen models, optional nodes switched on), before uploading anything
      const pre = await this.preflight(profile, applySlots(profile, mapImages(profile, values, (id) => `preflight_${id}`)).graph);
      if (pre) return fail(pre);

      const names = new Map<string, string>();
      for (const id of assetIds(profile, values)) names.set(id, await this.uploadAsset(id));
      const applied = applySlots(profile, mapImages(profile, values, (id) => names.get(id)!));
      const wfHash = hashJson(applied.graph);
      await this.project.saveWorkflow(wfHash, JSON.stringify(applied.graph));
      this.project.db.run('UPDATE jobs SET workflow_hash = ? WHERE id = ?', wfHash, job.id);

      await this.client.submit(applied.graph, promptId);
      this.project.db.run('UPDATE jobs SET external_id = ? WHERE id = ?', promptId, job.id);

      let last = 0;
      const end = await this.client.waitFor(promptId, (e) => {
        if (e.type === 'progress' && e.max > 0) {
          const f = e.value / e.max;
          if (f - last >= 0.01 || f === 1) { last = f; jobs.setProgress(job.id, f); this.emit('progress', job.id, f); }
        }
      }, { pollMs: this.opts.pollMs });

      if (this.current.cancelled || end.type === 'interrupted') { this.emit('job', jobs.transition(job.id, 'cancelled')); return; }
      if (end.type === 'error') return fail(end.nodeType ? `${end.nodeType}: ${end.message}` : end.message);
      if (end.type !== 'success') return fail('Lost contact with ComfyUI');

      const h = await this.client.history(promptId);
      if (!h) return fail('ComfyUI finished but returned no history');
      const outputs: IoRef[] = [];
      for (const o of applied.outputs) {
        const re = o.type === 'video' ? VIDEO_EXT : o.type === 'audio' ? AUDIO_EXT : IMAGE_EXT;
        const f = h.files.find((x) => x.nodeId === o.node && re.test(x.filename));
        if (!f) { if (o.optional) continue; return fail(`ComfyUI produced no ${o.type} from node ${o.node}`); }
        const asset = await this.project.assets.importBuffer(await this.client.view(f), path.extname(f.filename).slice(1) || 'bin', { meta: { comfy: { node: o.node, file: f.filename } } });
        outputs.push({ assetId: asset.id, role: o.id, idx: 0 });
      }
      this.emit('job', jobs.transition(job.id, 'done', { outputs }));
    } catch (e) {
      const cancelled = this.current?.cancelled;
      if (jobs.get(job.id)?.status === 'running') {
        if (cancelled) this.emit('job', jobs.transition(job.id, 'cancelled'));
        else fail(e instanceof ComfyError ? e.message : (e as Error).message);
      }
    } finally { this.current = null; }
  }

  /** null when fine, otherwise a message for the user. Cached briefly. */
  private async preflight(profile: Profile, graph?: Graph): Promise<string | null> {
    const key = profile.manifest.id + (graph ? '|' + JSON.stringify(Object.values(graph).map((n) => [n.class_type, LOADER_FILE[n.class_type] ? n.inputs[LOADER_FILE[n.class_type]!] : '']).sort()) : '');
    const hit = this.preflightCache.get(key);
    if (hit && Date.now() - hit.at < (this.opts.preflightTtlMs ?? 30_000)) return hit.msg;
    let msg: string | null = null;
    try {
      const r = await this.client.preflight(profile.manifest, graph);
      if (!r.ok) msg = [
        r.missingNodes.length ? `ComfyUI is missing node(s): ${r.missingNodes.join(', ')}` : '',
        r.missingModels.length ? `missing model(s): ${r.missingModels.map((m) => `${m.name} (${m.kind})`).join(', ')}` : '',
      ].filter(Boolean).join('; ');
    } catch (e) { msg = (e as Error).message; }
    this.preflightCache.set(key, { at: Date.now(), msg });
    return msg;
  }

  private async uploadAsset(assetId: string): Promise<string> {
    const hit = this.uploaded.get(assetId);
    if (hit) return hit;
    const a = this.project.assets.get(assetId);
    if (!a) throw new Error(`Asset ${assetId.slice(0, 8)} is missing from the project`);
    const name = await this.client.uploadFile(this.project.assets.pathFor(a), `driftboard_${a.id.slice(0, 24)}.${a.ext}`);
    this.uploaded.set(assetId, name);
    return name;
  }

  private async saveProfileCopy(p: Profile) {
    const dir = path.join(this.project.dir, 'profiles', `${p.manifest.id}@${p.manifest.version}`);
    if (await fs.access(dir).then(() => true, () => false)) return;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(p.manifest, null, 2));
    await fs.writeFile(path.join(dir, 'workflow.json'), JSON.stringify(p.workflow));
  }
}

function assetIds(profile: Profile, values: SlotValues): string[] {
  const ids: string[] = [];
  for (const s of profile.manifest.slots) {
    const v = values[s.id];
    if ((s.type === 'image' || s.type === 'video') && typeof v === 'string') ids.push(v);
    if ((s.type === 'image_list' || s.type === 'video_list' || s.type === 'audio_list') && Array.isArray(v)) ids.push(...(v as string[]));
  }
  return [...new Set(ids)];
}

function mapImages(profile: Profile, values: SlotValues, fn: (assetId: string) => string): SlotValues {
  const out: SlotValues = { ...values };
  for (const s of profile.manifest.slots) {
    const v = values[s.id];
    if ((s.type === 'image' || s.type === 'video') && typeof v === 'string') out[s.id] = fn(v);
    if ((s.type === 'image_list' || s.type === 'video_list' || s.type === 'audio_list') && Array.isArray(v)) out[s.id] = (v as string[]).map(fn);
  }
  return out;
}
