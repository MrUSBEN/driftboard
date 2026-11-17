import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Project, projectFile } from '@driftboard/core';
import { applySlots, loadProfileSet, type Profile } from '@driftboard/profiles';
import { ComfyPrefs } from './comfyPrefs.ts';
import { analyzeChain, colorMatchClip, seamMatchClip, clipEndStats, cutFrames, validGuideFrames, frameStats, probe, makePoster, makeProxy, frameAt, lastFrame, renderTimeline, transformMedia, type MediaOp, type RenderPlan } from '@driftboard/media';
import { existsSync, createReadStream, statSync, cpSync, renameSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { ComfyClient, JobRunner } from '@driftboard/adapter-comfy';
import { LlmHub } from './llmHub.ts';
import { logger, log } from './logger.ts';
import { zipStore } from './zip.ts';
import { registerLlm } from './llmApi.ts';
import { DirectorService, lintPrompt, type TargetProfile } from '@driftboard/director';
import type { JobView } from './api.ts';

const MIME: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac' };
/**
 * Serve a file with real byte-range support (206 + Content-Range). Without it the player cannot seek into a part of a clip
 * it has not downloaded yet: the seek silently stays at 0 until the whole clip was played once.
 */
function serveFile(file: string, req: Request): Response {
  let size: number; try { size = statSync(file).size; } catch { return new Response('not found', { status: 404 }); }
  const type = MIME[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream';
  const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  const m = /^bytes=(d*)-(d*)$/.exec((req.headers.get('range') ?? '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return new Response(Readable.toWeb(createReadStream(file)) as unknown as ReadableStream, { status: 200, headers: { ...base, 'Content-Length': String(size) } });
  let start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
  let end = m[1] === '' || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || start > end) return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } });
  return new Response(Readable.toWeb(createReadStream(file, { start, end })) as unknown as ReadableStream, { status: 206, headers: { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) } });
}

const priv = { standard: true, secure: true, stream: true, supportFetchAPI: true, bypassCSP: true };
protocol.registerSchemesAsPrivileged([{ scheme: 'driftboard-asset', privileges: priv }, { scheme: 'driftboard-thumb', privileges: priv }, { scheme: 'driftboard-proxy', privileges: priv }]);

let win: BrowserWindow | null = null;
let project: Project | null = null;
let runner: JobRunner | null = null;
let profiles: Profile[] = [];
let comfyUrl = process.env.COMFY_URL ?? 'http://127.0.0.1:8188';
// User data lives in %APPDATA%/Driftboard. A build from before the rename kept it in %APPDATA%/@meldreel/app: copy it over once (the old folder stays).
{
  const dst = path.join(app.getPath('appData'), 'Driftboard'), old = path.join(app.getPath('appData'), '@meldreel', 'app');
  if (!existsSync(dst) && existsSync(old)) {
    try { rmSync(dst + '.tmp', { recursive: true, force: true }); cpSync(old, dst + '.tmp', { recursive: true }); renameSync(dst + '.tmp', dst); } catch { /* start fresh if the old folder cannot be copied */ }
  }
  app.setPath('userData', dst);
}
const prefs = new ComfyPrefs(path.join(app.getPath('userData'), 'comfy.json')).load();
if (!process.env.COMFY_URL && prefs.s.url) comfyUrl = prefs.s.url;
/** Profiles that failed to load (a broken user profile is skipped, not fatal). */
let profileErrors: string[] = [];
let hasNodes: (classes: string[]) => Promise<Record<string, boolean>> = async (c) => Object.fromEntries(c.map((x) => [x, false]));
const userProfilesDir = () => path.join(app.getPath('userData'), 'profiles');
const bundledProfilesDir = () => (app.isPackaged ? path.join(process.resourcesPath, 'profiles') : path.resolve(__dirname, '../../../profiles'));
async function reloadProfiles() {
  const r = await loadProfileSet([{ dir: bundledProfilesDir(), source: 'bundled' }, { dir: userProfilesDir(), source: 'user' }]);
  profiles = r.profiles; profileErrors = r.errors;
  for (const e of r.errors) log.warn('profiles', e);
}
/** A recipe from an older profile version may name settings that no longer exist (e.g. the removed upscale switch): drop them so it still runs. */
const keepKnown = (profileId: string, values: Record<string, unknown>) => {
  const p = profiles.find((x) => x.manifest.id === profileId); if (!p) return values;
  const known = new Set([...p.manifest.slots.map((s) => s.id), 'custom_width', 'custom_height']);
  return Object.fromEntries(Object.entries(values).filter(([k]) => known.has(k) || k.startsWith('__')));
};
if (app.isPackaged && !process.env.DRIFTBOARD_FFMPEG) process.env.DRIFTBOARD_FFMPEG = path.join(process.resourcesPath, 'ffmpeg.exe');   // ffmpeg ships next to the app, not inside app.asar
const hub = new LlmHub({ settings: path.join(app.getPath('userData'), 'llm.json'), bundled: app.isPackaged ? path.join(process.resourcesPath, 'guides') : path.resolve(__dirname, '../../../guides'), user: path.join(app.getPath('userData'), 'guides') });
let director: DirectorService | null = null;

/** What the director needs to know about each video profile: allowed lengths, reference count, prompt guide. */
function targets(): TargetProfile[] {
  return profiles.filter((p) => p.manifest.kind === 'video' && p.manifest.slots.some((s) => s.type === 'text' && s.role === 'prompt')).map((p) => {
    const sec = p.manifest.slots.find((s) => s.type === 'number' && s.role === 'duration') as { min?: number; max?: number } | undefined;
    const base = p.manifest.director?.seconds ?? [3, 5, 8, 10];
    const seconds = base.filter((n) => (sec?.min === undefined || n >= sec.min) && (sec?.max === undefined || n <= sec.max));
    const g = hub.guide(p.manifest.guide ?? '');
    return { id: p.manifest.id, title: p.manifest.title, seconds: seconds.length ? seconds : base, maxRefs: p.manifest.director?.maxRefs ?? 0, maxAudioRefs: (p.manifest.slots.find((s) => s.type === 'audio_list') as { max?: number } | undefined)?.max ?? 0, maxVideoRefs: (p.manifest.slots.find((s) => s.type === 'video_list') as { max?: number } | undefined)?.max ?? 0, promptGuide: g?.body ?? p.guide, durationLine: g?.durationLine, firstFrame: p.manifest.director?.firstFrame, lastFrame: p.manifest.director?.lastFrame };
  });
}
function makeDirector() {
  const p = project!;
  director = new DirectorService({ llm: hub.client, guides: hub.guide, load: () => p.loadBlob('director'), save: (j) => p.saveBlob('director', j), target: (id) => { const t = targets(); return t.find((x) => x.id === id) ?? t[0]; }, emit: (pr) => send('directorProgress', pr) });
}
let client = new ComfyClient({ baseUrl: comfyUrl });
const lastProject = () => path.join(app.getPath('userData'), 'last-project.txt');

const jobView = (j: import('@driftboard/core').Job): JobView => ({ ...j, inputs: project!.jobs.inputs(j.id), outputs: project!.jobs.outputs(j.id) });
const send = (ch: string, ...a: unknown[]) => win?.webContents.send(ch, ...a);

function makeRunner() {
  runner?.removeAllListeners();
  const r = new JobRunner(project!, client, profiles, { beforeJob: () => hub.beforeJob(), defaults: (id) => prefs.defaults(id) });
  runner = r;
  hub.gpuBusy = () => r.busy;
  hub.freeComfy = () => client.free().then(() => true, () => false);
  const seen = new Map<string, string>(), started = new Map<string, number>();
  r.on('job', (j) => {
    send('job', jobView(j)); if (j.status === 'done') void onJobDone(j.id);
    if (seen.get(j.id) !== j.status) {
      seen.set(j.id, j.status);
      if (j.status === 'running') started.set(j.id, Date.now());
      const secs = started.has(j.id) && j.status !== 'running' && j.status !== 'queued' ? ` after ${Math.round((Date.now() - started.get(j.id)!) / 1000)}s` : '';
      (j.status === 'failed' ? log.error : log.info)('comfy', `job ${j.id.slice(0, 8)} ${j.profile_id ?? ''} ${j.status}${secs}${j.error ? ': ' + j.error : ''}`);
    }
  });
  r.on('progress', (id, f) => send('progress', id, f));
}

/** Probe new outputs (size, duration) and put them on the board next to the gen item that made them. */
async function onJobDone(jobId: string) {
  const p = project; if (!p) return;
  const outs = p.jobs.outputs(jobId);
  for (const o of outs) await probeAsset(p, o.assetId);
  const job = p.jobs.get(jobId);
  if (job?.origin && p.board.item(job.origin)) p.board.placeResults(job.origin, outs.map((o) => o.assetId));
  else if (job) {
    // no origin (Run again, Generate, Story runs): put results next to their first input on the board, else on a free spot
    const parent = p.jobs.inputs(jobId).map((i) => p.board.items().find((b) => b.kind === 'asset' && b.ref === i.assetId)).find(Boolean);
    if (parent) p.board.placeResults(parent.id, outs.map((o) => o.assetId));
    else p.docs.batch('Add results', () => outs.forEach((o) => p.board.addAsset(o.assetId, 0, 0)));
  }
  if (job?.shot_id && p.story.shot(job.shot_id)) for (const o of outs) p.story.addTake(job.shot_id, o.assetId);
  send('board');
}

async function probeAsset(p: Project, id: string) {
  const a = p.assets.get(id);
  if (!a || a.width !== null || a.kind === 'other') return;
  const info = await probe(p.assets.pathFor(a));
  p.db.run('UPDATE assets SET width = ?, height = ?, duration_ms = ?, fps = ?, has_audio = ? WHERE id = ?',
    info.width ?? null, info.height ?? null, info.durationMs ?? null, info.fps ?? null, info.hasAudio ? 1 : 0, id);
}

const posters = new Map<string, Promise<void>>();
function posterFor(p: Project, id: string): Promise<string | null> {
  const a = p.assets.get(id); if (!a) return Promise.resolve(null);
  const dest = path.join(p.dir, 'thumbs', `${id}.jpg`);
  if (existsSync(dest)) return Promise.resolve(dest);
  let job = posters.get(id);
  if (!job) { job = makePoster(p.assets.pathFor(a), dest).finally(() => posters.delete(id)); posters.set(id, job); }
  return job.then(() => dest, () => null);
}

const proxies = new Map<string, Promise<void>>();
function proxyFor(p: Project, id: string): Promise<string | null> {
  const a = p.assets.get(id); if (!a || a.kind !== 'video') return Promise.resolve(null);
  const dest = path.join(p.dir, 'proxies', `${id}.mp4`);
  if (existsSync(dest)) return Promise.resolve(dest);
  let job = proxies.get(id);
  if (!job) { job = makeProxy(p.assets.pathFor(a), dest).finally(() => proxies.delete(id)); proxies.set(id, job); }
  return job.then(() => dest, () => null);
}

const boardView = () => ({ items: project!.board.items(), edges: project!.board.edges(), lineage: project!.board.lineage(), views: project!.board.views(), canUndo: project!.docs.canUndo, canRedo: project!.docs.canRedo, undoLabel: project!.docs.undoLabel, redoLabel: project!.docs.redoLabel });

/* ---- known projects: a list kept in the user folder so any project can be reopened, relinked or deleted from one screen ---- */
interface Recent { dir: string; name: string; opened: number }
const recentsFile = () => path.join(app.getPath('userData'), 'projects.json');
const readRecents = async (): Promise<Recent[]> => { try { return JSON.parse(await import('node:fs/promises').then((fs) => fs.readFile(recentsFile(), 'utf8'))) as Recent[]; } catch { return []; } };
const writeRecents = (l: Recent[]) => import('node:fs/promises').then((fs) => fs.writeFile(recentsFile(), JSON.stringify(l, null, 2))).catch(() => {});
const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
async function remember(dir: string, name: string) { const l = (await readRecents()).filter((r) => !same(r.dir, dir)); l.unshift({ dir, name, opened: Date.now() }); await writeRecents(l.slice(0, 100)); }

async function attach(p: Project) {
  // switching is safe: every edit is already in the project's database; a backup is taken and the old project closed cleanly before the new one opens
  if (project && project !== p) { runner?.removeAllListeners(); await project.backup().catch(() => {}); log.info('project', `saved and closed ${project.info.name}`); }
  runner?.removeAllListeners(); if (project && project !== p) project.close();
  project = p; await remember(p.dir, p.info.name);
  makeRunner();
  makeDirector();
  await import('node:fs/promises').then((fs) => fs.writeFile(lastProject(), p.dir)).catch(() => {});
  void runner?.kick();   // resume anything still queued from last time
  return { dir: p.dir, name: p.info.name };
}

function register() {
  /** Every IPC call goes through here: thrown errors and {ok:false} answers are written to the log (the user sees them in the Log tab). */
  const h = (name: string, fn: (...a: any[]) => unknown) => ipcMain.handle(name, async (_e, ...a) => {
    try {
      const r = await fn(...a);
      if (r && typeof r === 'object' && (r as { ok?: unknown }).ok === false && !(r as { cancelled?: unknown }).cancelled) log.warn('ipc', `${name}: ${(r as { error?: string }).error ?? 'failed'}`);
      return r;
    } catch (e) { log.error('ipc', `${name} threw: ${(e as Error).stack ?? (e as Error).message}`); throw e; }
  });
  h('logList', () => logger.list());
  h('logClear', () => logger.clear());
  h('logAdd', (level: 'info' | 'warn' | 'error', source: string, msg: string) => { logger.add(level, source, msg); });
  h('logReveal', () => { if (logger.path) shell.showItemInFolder(logger.path); return logger.path; });
  h('comfyStatus', async () => { try { const s = await client.ping(); return { ok: true, version: s.version, url: comfyUrl }; } catch (e) { return { ok: false, error: (e as Error).message, url: comfyUrl }; } });
  h('setComfyUrl', async (url: string) => { comfyUrl = url; client = new ComfyClient({ baseUrl: url }); optionCache.clear(); hasCache.clear(); await prefs.setUrl(url); if (project) makeRunner(); });

  /* ------------------------------------------------------------ Settings → ComfyUI */
  h('comfyPrefs', () => ({ url: comfyUrl, profiles: prefs.s.profiles, userDir: userProfilesDir(), errors: profileErrors }));
  h('comfySetDefault', async (id: string, key: string, value: unknown) => { await prefs.setDefault(id, key, value); });
  h('comfySetEnabled', async (id: string, on: boolean) => { await prefs.setEnabled(id, on); });
  h('comfyResetProfile', async (id: string) => { await prefs.reset(id); });
  h('comfyHas', async (classes: string[]) => hasNodes(classes));
  /** Per profile: is everything it would send right now (your models and switches included) installed in ComfyUI? */
  h('comfyHealth', async () => {
    const out: { id: string; ok: boolean; missingNodes: string[]; missingModels: { kind: string; name: string }[]; error?: string }[] = [];
    for (const p of profiles) {
      try {
        const v: Record<string, unknown> = { ...prefs.defaults(p.manifest.id) };
        for (const s of p.manifest.slots) {
          if (s.type === 'text' && s.required && v[s.id] === undefined) v[s.id] = 'x';
          if ((s.type === 'image' || s.type === 'video') && s.required) v[s.id] = s.type === 'image' ? 'x.png' : 'x.mp4';
          if ((s.type === 'image' || s.type === 'video' || s.type === 'image_list' || s.type === 'video_list' || s.type === 'audio_list') && !('required' in s && s.required)) delete v[s.id];
        }
        const r = await client.preflight(p.manifest, applySlots(p, keepKnown(p.manifest.id, v)).graph);
        out.push({ id: p.manifest.id, ...r });
      } catch (e) { out.push({ id: p.manifest.id, ok: false, missingNodes: [], missingModels: [], error: (e as Error).message }); }
    }
    return out;
  });
  h('openProfilesFolder', async () => { await import('node:fs/promises').then((fs) => fs.mkdir(userProfilesDir(), { recursive: true })); await shell.openPath(userProfilesDir()); return userProfilesDir(); });
  h('reloadProfiles', async () => { await reloadProfiles(); optionCache.clear(); if (project) makeRunner(); return { count: profiles.length, errors: profileErrors }; });
  h('projectCurrent', () => (project ? { dir: project.dir, name: project.info.name } : null));
  h('projectNew', async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Choose an empty folder for the new project', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const dir = r.filePaths[0];
    return attach(await Project.create(dir, path.basename(dir)));
  });
  h('projectList', async () => {
    const fs = await import('node:fs/promises');
    const out = [];
    for (const r of await readRecents()) {
      const ok = await fs.access(await projectFile(r.dir)).then(() => true, () => false);
      out.push({ ...r, missing: !ok, current: !!project && same(project.dir, r.dir) });
    }
    return out;
  });
  h('projectSwitch', async (dir: string) => {
    try { return { ok: true, project: await attach(await Project.open(dir)) }; } catch (e) { return { ok: false, error: (e as Error).message }; }
  });
  h('projectForget', async (dir: string) => { await writeRecents((await readRecents()).filter((r) => !same(r.dir, dir))); });
  /** The folder moved: point the entry at the new place (it must hold a Driftboard project). */
  h('projectRelink', async (oldDir: string) => {
    const fs = await import('node:fs/promises');
    const r = await dialog.showOpenDialog(win!, { title: 'Find the project folder (the one containing project.driftboard.json)', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, error: 'Cancelled' };
    const dir = r.filePaths[0];
    try {
      const info = JSON.parse(await fs.readFile(await projectFile(dir), 'utf8')) as { name: string };
      const l = (await readRecents()).filter((x) => !same(x.dir, oldDir) && !same(x.dir, dir)); l.unshift({ dir, name: info.name, opened: Date.now() }); await writeRecents(l);
      return { ok: true };
    } catch { return { ok: false, error: 'That folder is not a Driftboard project (no project.driftboard.json).' }; }
  });
  /** Delete a project folder: to the Recycle Bin (recoverable). The open project cannot be deleted. */
  h('projectDelete', async (dir: string) => {
    if (project && same(project.dir, dir)) return { ok: false, error: 'This project is open. Open another one first.' };
    try { await shell.trashItem(path.resolve(dir)); } catch (e) { if (await import('node:fs/promises').then((fs) => fs.access(dir).then(() => true, () => false))) return { ok: false, error: (e as Error).message }; }
    await writeRecents((await readRecents()).filter((r) => !same(r.dir, dir))); log.info('project', `moved ${dir} to the Recycle Bin`); return { ok: true };
  });
  h('projectRename', async (dir: string, name: string) => {
    const fs = await import('node:fs/promises'); const nm = name.trim(); if (!nm) return;
    if (project && same(project.dir, dir)) await project.rename(nm);
    else { const f = await projectFile(dir); const info = JSON.parse(await fs.readFile(f, 'utf8')); info.name = nm; await fs.writeFile(f, JSON.stringify(info, null, 2)); }
    await writeRecents((await readRecents()).map((r) => (same(r.dir, dir) ? { ...r, name: nm } : r)));
  });
  h('projectOpen', async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Open a Driftboard project folder', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return attach(await Project.open(r.filePaths[0]));
  });
  const llmx = registerLlm({ h, hub, project: () => project, profiles: () => profiles, targets, send, imageData: async (id) => {
    // a picture (or a clip's poster) at most 768 px wide as a JPEG data URL, small enough for a vision model's context
    const p = project; const a = p?.assets.get(id); if (!p || !a) return null;
    const tmp = path.join(p.dir, 'thumbs', `vis-${id.slice(0, 8)}-${Date.now()}.jpg`);
    try {
      const src = a.kind === 'video' ? await posterFor(p, id) : p.assets.pathFor(a);
      if (!src) return null;
      await transformMedia(src, tmp, { op: 'resize', width: Math.min(768, a.width ?? 768) }, 'image', {});
      return 'data:image/jpeg;base64,' + (await import('node:fs/promises').then((fs) => fs.readFile(tmp))).toString('base64');
    } catch (e) { log.warn('llm', `could not prepare picture ${id.slice(0, 8)}: ${(e as Error).message}`); return null; }
    finally { await import('node:fs/promises').then((fs) => fs.rm(tmp, { force: true })); }
  } });
  const D = () => { if (!director) throw new Error('Open or create a project first.'); return director; };
  h('directorState', () => ({ state: D().state, targets: targets().map((t) => ({ id: t.id, title: t.title, seconds: t.seconds, maxRefs: t.maxRefs, maxAudioRefs: t.maxAudioRefs, maxVideoRefs: t.maxVideoRefs })) }));
  h('directorSetScript', (text: string, style?: string) => D().setScript(text, style));
  h('directorSetTarget', (id: string) => D().setTarget(id));
  h('directorInterpret', async (text: string) => {
    try { return { ok: true, state: await hub.use('director', () => D().interpret(text), { batch: true, label: 'Interpret script' }) }; }
    catch (e) { return { ok: false, error: (e as Error).message }; }
  });
  h('directorSetInterpreted', (text: string) => D().setInterpreted(text));
  h('directorUseInterpreted', () => D().useInterpreted());
  h('directorMissing', async (source: string, interpreted: string) => (await import('@driftboard/director')).missingDialogue(source, interpreted));
  h('directorUpdate', (patch: any) => D().update(patch));
  h('directorCancel', () => D().cancel());
  h('directorRun', async (step: any, opts?: { only?: string | string[]; force?: boolean }) => {
    try {
      return { ok: true, state: await hub.use('director', () => D().run(step, opts), { batch: true }) };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  });
  h('directorAccept', () => {
    const d = D(), p = project!;
    if (d.state.bible) p.story.setBible(d.state.bible);
    // running it again updates the same story; the first time makes a new one (named by the user, else by the LLM in the background)
    let sid = d.state.storyId && p.story.story(d.state.storyId) ? d.state.storyId : undefined;
    if (!sid) {
      const name = d.state.name?.trim() || `Story ${p.story.stories().length + 1}`;
      sid = llmx.newStory(name, d.state.scriptText || d.state.parsed?.text || '', !d.state.name?.trim()).id;
      d.update({ storyId: sid });
    } else p.saveBlob('active_story', sid);
    const r = p.story.importPlan(d.buildPlan(), { keepEditedPrompts: true, storyId: sid });
    send('board'); return r;
  });
  /* director runs: each run is its own project (state + storyboard). The open run is the live director state; it is written back to its slot whenever the list is read or the user switches. */
  type RunRec = { id: string; name: string; ts: number; summary: string; state: unknown; storyboard: unknown };
  const runs = (): RunRec[] => {
    try { const raw = project?.loadBlob('director_runs'); if (raw) return JSON.parse(raw) as RunRec[]; } catch { /* below */ }
    // first time: old "Saved" snapshots become runs, and so does whatever is open now
    let l: RunRec[] = []; try { l = (JSON.parse(project?.loadBlob('director_snapshots') ?? '[]') as RunRec[]).map((x) => ({ id: x.id, name: x.name, ts: x.ts, summary: x.summary, state: x.state, storyboard: x.storyboard })); } catch { /* none */ }
    if (director && !dirEmpty()) { const r = recOf(Math.random().toString(36).slice(2, 10), ''); l.push(r); }
    saveRuns(l); return l;
  };
  const saveRuns = (l: RunRec[]) => project?.saveBlob('director_runs', JSON.stringify(l));
  const sbNow = () => { try { return JSON.parse(project?.loadBlob('storyboard') ?? 'null'); } catch { return null; } };
  const dirEmpty = () => { const s = D().state, sb = sbNow() as { frames?: unknown[] } | null; return !s.scriptText.trim() && !s.bible && !s.scenes?.length && !Object.keys(s.shots).length && !(sb?.frames?.length); };
  const recOf = (id: string, oldName: string): RunRec => { const s = D().state; const sb = sbNow() as { frames?: unknown[] } | null; return { id, name: s.name?.trim() || oldName || s.parsed?.title || (s.scriptText.trim().slice(0, 30) || 'Untitled run'), ts: Date.now(), summary: `${s.parsed ? (s.parsed.mode === 'screenplay' ? s.parsed.scenes.length + ' scenes' : 'story text') : 'no script'} · ${s.bible ? s.bible.characters.length + ' characters · ' : ''}${Object.values(s.shots).reduce((n, x) => n + x.shots.length, 0)} shots · ${sb?.frames?.length ?? 0} pictures`, state: JSON.parse(JSON.stringify(s)), storyboard: sb }; };
  const activeRun = (): string | null => project?.loadBlob('director_active') || null;
  const setActiveRun = (id: string | null) => project?.saveBlob('director_active', id ?? '');
  const syncRun = () => { const id = activeRun(); const l = runs(); const i = l.findIndex((x) => x.id === id); if (!id || i < 0) return l; l[i] = recOf(id, l[i]!.name); saveRuns(l); return l; };
  const cards = (l: RunRec[]) => l.map(({ id, name, ts, summary }) => ({ id, name, ts, summary })).reverse();
  h('directorRuns', () => { const l = syncRun(); const a = activeRun(); return { activeId: l.some((x) => x.id === a) ? a : null, runs: cards(l) }; });
  h('directorNewRun', () => {
    syncRun();
    project!.saveBlob('storyboard', JSON.stringify({ frames: [], idea: '' })); D().reset();
    const l = runs(); const r = recOf(Math.random().toString(36).slice(2, 10), `Run ${l.length + 1}`); l.push(r); saveRuns(l); setActiveRun(r.id); return D().state;
  });
  h('directorOpenRun', (id: string) => {
    syncRun(); const l = runs(), r = l.find((x) => x.id === id); if (!r) throw new Error('That run is gone.');
    project!.saveBlob('storyboard', JSON.stringify(r.storyboard ?? { frames: [], idea: '' })); setActiveRun(id);
    return D().loadState(r.state as never);
  });
  h('directorBack', () => { syncRun(); setActiveRun(null); });
  h('directorRunEdit', (id: string, patch: { name?: string; remove?: boolean }) => {
    syncRun(); let l = runs();
    if (patch.remove) { l = l.filter((x) => x.id !== id); if (activeRun() === id) setActiveRun(null); }
    else { l = l.map((x) => (x.id === id ? { ...x, name: patch.name?.trim() || x.name } : x)); if (activeRun() === id && patch.name?.trim()) D().update({ name: patch.name.trim() }); }
    saveRuns(l); return cards(l);
  });
  h('directorClearAll', () => { project!.saveBlob('storyboard', JSON.stringify({ frames: [], idea: '' })); return D().reset(); });
  h('directorImportFile', async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Import a script', properties: ['openFile'], filters: [{ name: 'Script', extensions: ['fountain', 'txt', 'md'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    return (await import('node:fs/promises')).readFile(r.filePaths[0], 'utf8');
  });
  h('timelineLoad', () => project?.loadTimeline() ?? null);
  h('timelineSave', (json: string) => { project?.saveTimeline(json); });
  h('reveal', (p: string) => { shell.showItemInFolder(p); });
  h('exportsDir', () => { const d = path.join(project!.dir, 'exports'); void import('node:fs/promises').then((fs) => fs.mkdir(d, { recursive: true })); return d; });
  h('assetReveal', (id: string) => { const a = project?.assets.get(id); if (a) shell.showItemInFolder(project!.assets.pathFor(a)); });
  /** Save media outside the project: one file as it is, several as one zip. The user picks where. */
  h('assetsDownload', async (ids: string[]) => {
    try {
      if (!project) throw new Error('Open or create a project first.');
      const fsp = await import('node:fs/promises');
      const files = ids.map((id) => project!.assets.get(id)).filter((a): a is NonNullable<typeof a> => !!a).map((a) => ({ a, p: project!.assets.pathFor(a) }));
      if (!files.length) throw new Error('Nothing to download.');
      const nameOf = (x: { a: { id: string; original_name?: string | null }; p: string }) => { const ext = path.extname(x.p); const base = (x.a.original_name ?? '').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_') || x.a.id.slice(0, 8); return base + ext; };
      if (files.length === 1) {
        const f = files[0]!;
        const r = await dialog.showSaveDialog(win!, { title: 'Download media', defaultPath: path.join(app.getPath('downloads'), nameOf(f)) });
        if (r.canceled || !r.filePath) return { ok: false, error: 'Cancelled', cancelled: true };
        await fsp.copyFile(f.p, r.filePath); return { ok: true, path: r.filePath, count: 1 };
      }
      const r = await dialog.showSaveDialog(win!, { title: `Download ${files.length} files as a zip`, defaultPath: path.join(app.getPath('downloads'), `${project.info.name} media.zip`), filters: [{ name: 'Zip archive', extensions: ['zip'] }] });
      if (r.canceled || !r.filePath) return { ok: false, error: 'Cancelled', cancelled: true };
      const seen = new Map<string, number>();
      const entries = files.map((f) => { let n = nameOf(f); const k = n.toLowerCase(); const c = seen.get(k) ?? 0; seen.set(k, c + 1); if (c) n = n.replace(/(\.[^.]*)?$/, ` (${c + 1})$1`); return { name: n, path: f.p }; });
      await zipStore(entries, r.filePath); return { ok: true, path: r.filePath, count: files.length };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  });
  let exportAbort: AbortController | null = null;
  h('exportCancel', () => { exportAbort?.abort(); });
  h('exportTimeline', async (plan: RenderPlan, opts: { name?: string; ask?: boolean; dir?: string } = {}) => {
    if (!project) return { ok: false, error: 'Open or create a project first.' };
    if (exportAbort) return { ok: false, error: 'An export is already running.' };
    const fsp = await import('node:fs/promises');
    const safe = (opts.name?.trim() || project.info.name).replace(/[\\/:*?"<>|]/g, '_');
    let pick: { canceled: boolean; filePath?: string };
    if (process.env.DRIFTBOARD_EXPORT_PATH) pick = { canceled: false, filePath: process.env.DRIFTBOARD_EXPORT_PATH };
    else if (opts.ask) pick = await dialog.showSaveDialog(win!, { title: 'Export film', defaultPath: path.join(opts.dir || path.join(project.dir, 'exports'), `${safe}.mp4`), filters: [{ name: 'MP4 video', extensions: ['mp4'] }] });
    else {   // straight into the project's exports folder, never overwriting an earlier export
      const dir = opts.dir || path.join(project.dir, 'exports'); await fsp.mkdir(dir, { recursive: true });
      let f = path.join(dir, `${safe}.mp4`), n = 2; while (await fsp.access(f).then(() => true, () => false)) f = path.join(dir, `${safe} (${n++}).mp4`);
      pick = { canceled: false, filePath: f };
    }
    if (pick.canceled || !pick.filePath) return { ok: false, error: 'Cancelled', cancelled: true };
    const mapped: RenderPlan = { ...plan, clips: plan.clips.map((c) => { const a = project!.assets.get(c.file); if (!a) throw new Error(`Asset ${c.file.slice(0, 8)} is missing`); return { ...c, file: project!.assets.pathFor(a) }; }) };
    exportAbort = new AbortController();
    try {
      log.info('export', `start: ${plan.clips.length} clips → ${pick.filePath}`); const t0 = Date.now();
      await renderTimeline(mapped, pick.filePath, { onProgress: (f) => send('exportProgress', f), signal: exportAbort.signal });
      log.info('export', `done in ${Math.round((Date.now() - t0) / 1000)}s`);
      return { ok: true, path: pick.filePath };
    } catch (e) { return { ok: false, error: (e as Error).message, cancelled: exportAbort.signal.aborted }; }
    finally { exportAbort = null; }
  });
  /** Manifests plus what the form needs: each slot's current value in the workflow (shown as the default), and the size node's step. */
  h('profiles', () => profiles.map((p) => ({
    ...p.manifest, source: p.source ?? 'bundled', enabled: prefs.enabled(p.manifest.id),
    slots: p.manifest.slots.map((s) => {
      const t = 'bind' in s && s.bind?.[0] ? p.workflow[s.bind[0].node]?.inputs[s.bind[0].input] : undefined;
      const wfDefault = (s.type === 'number' || s.type === 'enum') && (typeof t === 'number' || typeof t === 'string') ? t : undefined;
      const cs = s.type === 'enum' ? s.customSize : undefined;
      const customMultiple = cs ? (p.workflow[cs.node]?.inputs.multiple as number | undefined) ?? 8 : undefined;
      return { ...s, ...(wfDefault !== undefined ? { wfDefault } : {}), ...(customMultiple ? { customMultiple } : {}) };
    }),
  })));
  /** Allowed values of each enum slot, read from the running ComfyUI (so dropdowns always match the installed nodes). */
  const optionCache = new Map<string, Record<string, string[]>>();
  /** Which node classes ComfyUI has (for optional speed-ups such as SageAttention). */
  const hasCache = new Map<string, boolean>();
  hasNodes = async (classes: string[]) => {
    const ask = classes.filter((c) => !hasCache.has(c));
    if (ask.length) { try { const info = await client.objectInfo(ask); for (const c of ask) hasCache.set(c, !!info[c]); } catch { return Object.fromEntries(classes.map((c) => [c, false])); } }
    return Object.fromEntries(classes.map((c) => [c, hasCache.get(c) ?? false]));
  };
  const optionsOf = async (profileId: string): Promise<Record<string, string[]>> => {
    const p = profiles.find((x) => x.manifest.id === profileId); if (!p) return {};
    const hit = optionCache.get(profileId); if (hit) return hit;
    const out: Record<string, string[]> = {};
    try {
      const enums = p.manifest.slots.filter((s) => s.type === 'enum' && s.bind?.length);
      const classes = [...new Set(enums.map((s) => p.workflow[(s as { bind: { node: string }[] }).bind[0]!.node]?.class_type).filter(Boolean) as string[])];
      const info = await client.objectInfo(classes);
      for (const s of enums) {
        const b = (s as { bind: { node: string; input: string }[] }).bind[0]!;
        const spec = (info[p.workflow[b.node]?.class_type ?? ''] as { input?: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]> } } | undefined)?.input;
        const def = spec?.required?.[b.input] ?? spec?.optional?.[b.input];
        const opts = Array.isArray(def?.[0]) ? (def![0] as string[]) : ((def?.[1] as { options?: string[] } | undefined)?.options);
        if (Array.isArray(opts) && opts.length) out[s.id] = opts.map(String);
      }
      if (Object.keys(out).length) optionCache.set(profileId, out);
    } catch { /* ComfyUI not reachable: the form falls back to a plain field */ }
    return out;
  };
  h('profileOptions', (profileId: string) => optionsOf(profileId));
  const B = () => project!.board;
  const changed = <T,>(fn: () => T) => { const r = fn(); send('board'); return r; };
  h('board', () => (project ? boardView() : { items: [], edges: [], lineage: [], views: [], canUndo: false, canRedo: false }));
  h('story', () => {
    if (!project) return { tree: [], all: [], stories: [], activeId: null, meta: {}, tags: [] };
    const st = project.story, stories = st.stories(), all = st.tree();
    let active = project.loadBlob('active_story'); if (active && !stories.some((s) => s.id === active)) active = null;
    if (!active && stories.length === 1) active = stories[0]!.id;
    const cards = stories.map((s) => { const t = all.filter((x) => x.scene.storyId === s.id); const shots = t.flatMap((x) => x.shots); return { id: s.id, name: s.name, created: s.created, scenes: t.length, shots: shots.length, takes: shots.reduce((n, x) => n + x.takes.length, 0), picked: shots.filter((x) => x.pick).length }; });
    return { tree: active ? st.tree(active) : [], all, stories: cards, activeId: active, meta: Object.fromEntries(st.allMeta()), tags: st.allTags(), bible: st.bible() };
  });
  /* film blocks: per story, with the project's default for stories without their own */
  h('storyBlocks', (storyId?: string) => (project ? project.story.blocks(storyId || undefined) : { blocks: [], source: 'starter' as const }));
  h('storySetBlocks', (scope: string, blocks: import('@driftboard/core').PromptBlock[]) => { project?.story.setBlocks(scope, blocks); send('board'); });
  h('storyClearBlocks', (storyId: string) => { project?.story.clearBlocks(storyId); send('board'); });
  h('storyActive', (id: string | null) => { project?.saveBlob('active_story', id ?? ''); send('board'); });
  const STORY_OPS = new Set(['addStory', 'renameStory', 'removeStory', 'addScene', 'updateScene', 'removeScene', 'moveScene', 'addShot', 'updateShot', 'removeShot', 'moveShot', 'addTake', 'removeTake', 'setTakeStatus', 'setTakeNote', 'setPick', 'setMeta', 'addTag', 'removeTag', 'renameMany', 'tagMany']);
  h('storyOp', (op: string, ...args: unknown[]) => {
    if (!project || !STORY_OPS.has(op)) throw new Error(`Unknown story operation ${op}`);
    // a prompt the user edited: check its spoken lines again (the warnings written with the old text no longer apply)
    if (op === 'updateShot' && args[1] && typeof args[1] === 'object' && 'prompt' in (args[1] as object)) {
      const patch = args[1] as { prompt?: string; promptWarnings?: string[] }; const sh = project.story.shot(args[0] as string);
      patch.promptWarnings = lintPrompt(patch.prompt ?? '', { dialogue: sh?.brief?.dialogue ?? [] }, []).warnings.filter((w) => /missing from the prompt/.test(w));
    }
    const r = (project.story as unknown as Record<string, (...a: unknown[]) => unknown>)[op]!(...args);
    send('board'); return r;
  });
  h('boardArrange', () => changed(() => project!.board.arrangeScenes(project!.story)));
  h('viewSave', (name: string, x: number, y: number, zoom: number) => changed(() => project!.board.saveView(name, x, y, zoom)));
  h('viewDelete', (id: string) => changed(() => project!.board.deleteView(id)));
  h('boardPlace', (c: any[]) => changed(() => B().place(c)));
  h('boardAddNote', (x: number, y: number) => changed(() => B().addItem({ kind: 'note', x, y, w: 220, h: 120, text: '' }, 'Add note')));
  h('boardAddGroup', (x: number, y: number, w = 520, h = 360) => changed(() => B().addItem({ kind: 'group', x, y, w, h, text: 'Group' }, 'Add group')));
  h('boardAddAssets', (ids: string[], x: number, y: number) => changed(() => project!.docs.batch('Add assets', () => ids.forEach((id, i) => B().addAsset(id, x + (i % 5) * 200, y + Math.floor(i / 5) * 150)))));
  h('boardRemove', (ids: string[]) => changed(() => B().remove(ids)));
  /** Library delete: hide the assets (trash) and take them off the canvas, one undo step. Files and everything that uses them keep working. */
  h('libraryTrash', (ids: string[], on: boolean) => changed(() => project!.docs.batch(on ? 'Delete from library' : 'Restore from library', () => {
    project!.story.trashAssets(ids, on);
    if (on) { const set = new Set(ids); const items = B().items().filter((i) => i.kind === 'asset' && i.ref && set.has(i.ref)).map((i) => i.id); if (items.length) B().remove(items); }
  })));
  /** Empty the trash: delete the files of trashed assets that nothing refers to (imports). Generated files are part of the lineage and stay hidden. */
  h('libraryPurge', async (ids: string[]) => {
    if (!project) return { deleted: 0, kept: 0 };
    const p = project; const want = new Set(ids); const free = new Set(p.assets.unreferenced().map((a) => a.id));
    let deleted = 0, kept = 0;
    for (const id of want) {
      if (!p.story.meta(id).trashed) continue;
      const a = p.assets.get(id); if (!a) continue;
      if (!free.has(id)) { kept++; continue; }
      await import('node:fs/promises').then((fs) => fs.rm(p.assets.pathFor(a), { force: true }));
      p.db.run('DELETE FROM assets WHERE id = ?', id); p.docs.set('asset_meta', id, undefined, 'Purge'); deleted++;
    }
    send('board'); return { deleted, kept };
  });
  h('boardConnect', (f: string, t: string, slot?: string) => changed(() => B().connect(f, t, slot)));
  h('boardDisconnect', (id: string) => changed(() => B().disconnect(id)));
  h('boardUpdate', (id: string, patch: any) => changed(() => B().update(id, patch)));
  h('boardUndo', () => changed(() => project?.docs.undo()));
  h('boardRedo', () => changed(() => project?.docs.redo()));
  h('boardImportPaths', async (paths: string[], x: number, y: number) => {
    if (!project) return;
    const ids: string[] = [];
    for (const f of paths) {
      const info = await probe(f);
      if (!info.hasVideo && !info.hasAudio) continue;   // not media
      ids.push((await project.assets.importFile(f, { width: info.width, height: info.height, durationMs: info.durationMs, fps: info.fps, hasAudio: info.hasAudio })).id);
    }
    changed(() => project!.docs.batch('Import', () => ids.forEach((id, i) => B().addAsset(id, x + (i % 5) * 200, y + Math.floor(i / 5) * 150))));
  });
  h('generate', async (profileId: string, values: Record<string, unknown>, origin?: string, shotId?: string, _opts?: { ignoreWarnings?: boolean }) => {
    if (!runner) return { ok: false, error: 'Open or create a project first.' };
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) if (v !== '' && v !== undefined && !(Array.isArray(v) && !v.length)) clean[k] = v;
    // a typed-in value that ComfyUI's list does not have would only fail later with a cryptic node error: say it now
    const opts = await optionsOf(profileId);
    for (const [slot, list] of Object.entries(opts)) { const v = clean[slot]; if (typeof v === 'string' && !list.includes(v)) return { ok: false, error: `${slot}: "${v}" is not one of: ${list.join(', ')}` }; }
    try { return { ok: true, job: jobView(await runner.enqueue({ profileId, values: clean, origin, shotId })) }; } catch (e) { return { ok: false, error: (e as Error).message }; }
  });
  /** Image/video edit (resize, crop, trim, upscale): writes a NEW asset, leaves the original, puts it on the canvas next to the original. */
  h('mediaEdit', async (assetId: string, op: MediaOp, originItemId?: string) => {
    if (!project) return { ok: false, error: 'Open or create a project first.' };
    const p = project; const a = p.assets.get(assetId);
    if (!a || (a.kind !== 'image' && a.kind !== 'video')) return { ok: false, error: 'Only images and videos can be edited.' };
    const tmp = path.join(p.dir, 'thumbs', `edit-${Date.now()}.${a.kind === 'video' ? 'mp4' : (a.ext === 'jpg' || a.ext === 'jpeg' ? 'jpg' : 'png')}`);
    try {
      await transformMedia(p.assets.pathFor(a), tmp, op, a.kind, { width: a.width ?? undefined, height: a.height ?? undefined });
      const out = await p.assets.importFile(tmp, {});
      await probeAsset(p, out.id);
      await import('node:fs/promises').then((fs) => fs.rm(tmp, { force: true }));
      p.jobs.recordDone('edit', [{ assetId, role: 'source' }], [{ assetId: out.id, role: 'result' }], { ...op });
      const origin = (originItemId && p.board.item(originItemId)) || p.board.items().find((i) => i.kind === 'asset' && i.ref === assetId);
      const item = origin ? p.board.placeResults(origin.id, [out.id])[0]! : p.board.addAsset(out.id, 0, 0);
      send('board');
      return { ok: true, assetId: out.id, itemId: item.id };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  });
  /** The picture or clip a chain started from (follow "made from" links back): its first frame is the look every later clip is held to. */
  const lineageRoot = (assetId: string): string => {
    const jobs = project!.jobs.list().map(jobView);
    let cur = assetId;
    for (let i = 0; i < 300; i++) {
      const j = jobs.find((x) => x.status === 'done' && x.outputs.some((o) => o.assetId === cur));
      const next = j?.inputs.find((x) => x.role === 'guide_start' || x.role === 'first_frame' || x.role === 'clip' || x.role === 'source')?.assetId;
      if (!next || next === cur) break;
      cur = next;
    }
    return cur;
  };
  /**
   * The finished version of a clip made with held frames: its start is seam-matched to the end of the clip it continues (which is itself the finished
   * version of that clip), fading to nothing over 2 s, so the join shows no step and the rest of the clip follows the story. Made once and remembered.
   * A clip that does not continue another one is returned as it is.
   */
  const SEAM_FADE_S = 2;
  const finalOf = async (assetId: string): Promise<string> => {
    const p = project!; const fsp = await import('node:fs/promises');
    const a = p.assets.get(assetId); if (!a || a.kind !== 'video') return assetId;
    const jobs = p.jobs.list().map(jobView);
    const made = jobs.find((j) => j.status === 'done' && j.outputs.some((o) => o.assetId === assetId));
    const guide = made?.inputs.find((x) => x.role === 'guide_start');
    if (!made || !guide) return assetId;
    const have = jobs.find((j) => j.kind === 'edit' && j.inputs.some((x) => x.assetId === assetId) && JSON.parse(j.params).op === 'seamMatch');
    if (have?.outputs[0]) return have.outputs[0].assetId;
    const prevId = jobs.find((j) => j.kind === 'guide' && j.outputs.some((o) => o.assetId === guide.assetId))?.inputs.find((x) => x.role === 'clip')?.assetId;
    if (!prevId) return assetId;   // the held frames were not made by the app: nothing to match to
    const prevFinal = p.assets.get(await finalOf(prevId)); if (!prevFinal) return assetId;
    const thumbs = path.join(p.dir, 'thumbs');
    const prevLast = await clipEndStats(p.assets.pathFor(prevFinal), 'last', thumbs);
    const held = Number((JSON.parse(made.params) as Record<string, unknown>).guide_start_frames ?? 22);
    const tmp = path.join(thumbs, `seam-${Date.now()}.mp4`);
    await seamMatchClip(p.assets.pathFor(a), tmp, prevLast, { trimFrames: held, fadeSec: SEAM_FADE_S }, thumbs);
    const out = await p.assets.importFile(tmp, {}); await probeAsset(p, out.id); await fsp.rm(tmp, { force: true });
    p.jobs.recordDone('edit', [{ assetId, role: 'source' }], [{ assetId: out.id, role: 'result' }], { op: 'seamMatch', held, fade: SEAM_FADE_S });
    return out.id;
  };
  h('seamMatch', async (assetId: string, prevAssetId: string, opts?: { fadeSec?: number }) => {
    if (!project) return { ok: false, error: 'Open or create a project first.' };
    const p = project; const fsp = await import('node:fs/promises');
    const a = p.assets.get(assetId), prev = p.assets.get(prevAssetId);
    if (!a || a.kind !== 'video' || !prev || prev.kind !== 'video') return { ok: false, error: 'Both must be video clips.' };
    try {
      const thumbs = path.join(p.dir, 'thumbs'); const tmp = path.join(thumbs, `seam-${Date.now()}.mp4`);
      const prevLast = await clipEndStats(p.assets.pathFor(prev), 'last', thumbs);
      await seamMatchClip(p.assets.pathFor(a), tmp, prevLast, { trimFrames: 0, fadeSec: opts?.fadeSec ?? SEAM_FADE_S }, thumbs);
      const out = await p.assets.importFile(tmp, {}); await probeAsset(p, out.id); await fsp.rm(tmp, { force: true });
      p.jobs.recordDone('edit', [{ assetId, role: 'source' }], [{ assetId: out.id, role: 'result' }], { op: 'seamMatchManual', prev: prevAssetId });
      const origin = p.board.items().find((i) => i.kind === 'asset' && i.ref === assetId);
      if (origin) p.board.placeResults(origin.id, [out.id]); else p.board.addAsset(out.id, 0, 0);
      send('board');
      return { ok: true, assetId: out.id };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  });
  h('guideClip', async (clipId: string, opts: { side: 'tail' | 'head'; frames: number; matchColor: boolean }) => {
    if (!project) return { ok: false, error: 'Open or create a project first.' };
    const p = project; const fsp = await import('node:fs/promises');
    const clip = p.assets.get(clipId);
    if (!clip || clip.kind !== 'video') return { ok: false, error: 'Not a video clip' };
    try {
      const fps = clip.fps ?? 24; const total = Math.round(((clip.duration_ms ?? (await probe(p.assets.pathFor(clip))).durationMs ?? 0) / 1000) * fps);
      const frames = validGuideFrames(opts.frames);
      if (total < frames) return { ok: false, error: `The clip has only ${total} frames; ${frames} are needed.` };
      const thumbs = path.join(p.dir, 'thumbs'); const cut = path.join(thumbs, `guide-${Date.now()}.mp4`);
      // the held frames come from the finished version of the clip (the one the film uses), so film and held frames agree
      const srcId = opts.side === 'tail' ? await finalOf(clipId) : clipId; const src = p.assets.get(srcId)!;
      await cutFrames(p.assets.pathFor(src), cut, opts.side === 'tail' ? total - frames : 0, frames, fps);
      const made = await p.assets.importFile(cut, {}); await probeAsset(p, made.id); await fsp.rm(cut, { force: true });
      p.jobs.recordDone('guide', [{ assetId: clipId, role: 'clip' }], [{ assetId: made.id, role: 'result' }], { side: opts.side, frames, matched: srcId !== clipId });
      send('board');
      const rootId = lineageRoot(clipId); const rootA = p.assets.get(rootId);
      return { ok: true, assetId: made.id, frames, matched: srcId !== clipId, keystone: rootA?.kind === 'image' ? rootId : undefined };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  });
  h('joinAssets', async (assetIds: string[]) => {
    if (!project) return assetIds;
    const p = project; const fsp = await import('node:fs/promises');
    const out: string[] = [];
    for (const id of assetIds) {
      try {
        const jobs = p.jobs.list().map(jobView);
        const made = jobs.find((j) => j.status === 'done' && j.outputs.some((o) => o.assetId === id));
        const held = made && made.inputs.some((x) => x.role === 'guide_start') ? Number((JSON.parse(made.params) as Record<string, unknown>).guide_start_frames ?? 22) : 0;
        const a = p.assets.get(id);
        if (!held || !a || a.kind !== 'video') { out.push(id); continue; }
        const base = await finalOf(id);   // seam-matched to the clip before it
        const done = jobs.find((j) => j.kind === 'edit' && j.inputs.some((x) => x.assetId === base) && JSON.parse(j.params).op === 'joinTrim');
        if (done?.outputs[0]) { out.push(done.outputs[0].assetId); continue; }
        const baseA = p.assets.get(base)!; const tmp = path.join(p.dir, 'thumbs', `join-${Date.now()}.mp4`);
        const fps = baseA.fps ?? 24; const dur = (baseA.duration_ms ?? 0) / 1000;
        await transformMedia(p.assets.pathFor(baseA), tmp, { op: 'trim', start: held / fps, end: dur }, 'video', {});
        const copy = await p.assets.importFile(tmp, {}); await probeAsset(p, copy.id); await fsp.rm(tmp, { force: true });
        p.jobs.recordDone('edit', [{ assetId: base, role: 'source' }], [{ assetId: copy.id, role: 'result' }], { op: 'joinTrim', frames: held });
        send('board'); out.push(copy.id);
      } catch { out.push(id); }
    }
    return out;
  });
  h('driftCheck', async (assetIds: string[]) => {
    if (!project) return { ok: false, error: 'Open or create a project first.' };
    const p = project; const fsp = await import('node:fs/promises');
    try {
      const clips = assetIds.map((id) => p.assets.get(id)).filter((a) => a?.kind === 'video');
      if (clips.length < 1) return { ok: false, error: 'Select one or more video clips.' };
      const rep = await analyzeChain(clips.map((a) => p.assets.pathFor(a!)), path.join(p.dir, 'thumbs'));
      const nm = (i: number) => p.docs ? (p.assets.get(assetIds[i]!)?.id ?? '').slice(0, 6) : '';
      const lines = [
        'Clip | brightness vs clip 1 | colour vs clip 1 | sharpness vs clip 1 | join jump (bright / colour) | flags',
        ...rep.clips.map((c, i) => `${c.index} (${nm(i)}) | ${c.brightnessPct}% | ${c.saturationPct}% | ${c.sharpnessPct}% | ${c.seamBrightness ?? '-'} / ${c.seamColor ?? '-'} | ${c.flags.join('; ') || 'ok'}`),
        rep.ok ? 'Result: no visible drift.' : 'Result: ' + rep.worst + ' (first problem).',
      ];
      const dir = path.join(p.dir, 'exports'); await fsp.mkdir(dir, { recursive: true });
      const file = path.join(dir, `drift-check-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
      await fsp.writeFile(file, lines.join('\n') + '\n');
      const rows = rep.clips.map((c, i) => ({ index: c.index, assetId: clips[i]!.id, problems: c.problems, flags: c.flags, brightnessPct: c.brightnessPct, saturationPct: c.saturationPct, startShiftPct: c.startShiftPct, audioJumpDb: c.audioJumpDb, seamBrightness: c.seamBrightness, seamColor: c.seamColor, seamSharpness: c.seamSharpness }));
      return { ok: true, lines, clean: rep.ok, file, rows };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  });
  h('colorMatch', async (assetIds: string[], refAssetId?: string) => {
    if (!project) return { ok: false, error: 'Open or create a project first.' };
    const p = project; const fsp = await import('node:fs/promises');
    try {
      const clips = assetIds.map((id) => p.assets.get(id)).filter((a) => a?.kind === 'video');
      if (!clips.length) return { ok: false, error: 'Select one or more video clips.' };
      const refAsset = refAssetId ? p.assets.get(refAssetId) : clips[0]!;
      if (!refAsset) return { ok: false, error: 'The reference was not found.' };
      const thumbs = path.join(p.dir, 'thumbs');
      let ref;
      if (refAsset.kind === 'image') { const { frameStats } = await import('@driftboard/media'); ref = await frameStats(p.assets.pathFor(refAsset)); }
      else ref = await clipEndStats(p.assets.pathFor(refAsset), 'first', thumbs);
      const out: string[] = [];
      for (const a of clips) {
        if (a!.id === refAsset.id) continue;   // the reference itself is the look to match
        const tmp = path.join(thumbs, `cm-${Date.now()}-${out.length}.mp4`);
        await colorMatchClip(p.assets.pathFor(a!), tmp, ref, thumbs);
        const made = await p.assets.importFile(tmp, {}); await probeAsset(p, made.id); await fsp.rm(tmp, { force: true });
        p.jobs.recordDone('edit', [{ assetId: a!.id, role: 'source' }], [{ assetId: made.id, role: 'result' }], { op: 'colorMatch', ref: refAsset.id });
        const origin = p.board.items().find((i) => i.kind === 'asset' && i.ref === a!.id);
        if (origin) p.board.placeResults(origin.id, [made.id]); else p.board.addAsset(made.id, 0, 0);
        out.push(made.id);
      }
      send('board');
      return { ok: true, assetIds: out };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  });
  h('frameExtract', async (clipId: string, which: 'first' | 'last' | { frame: number }, origin?: string) => {
    if (!project) return { ok: false, error: 'Open or create a project first.' };
    const p = project;
    const clip = p.assets.get(clipId);
    if (!clip || clip.kind !== 'video') return { ok: false, error: 'Not a video clip' };
    const tmp = path.join(p.dir, 'thumbs', `frame-${Date.now()}.png`);
    try {
      const src = p.assets.pathFor(clip);
      if (which === 'last') await lastFrame(src, tmp);
      else await frameAt(src, tmp, which === 'first' ? 0 : which.frame, clip.fps ?? 24);
      const info = await probe(tmp);
      const frame = await p.assets.importFile(tmp, { width: info.width, height: info.height });
      const label = which === 'last' ? 'last' : which === 'first' ? 'first' : `f${which.frame}`;
      p.jobs.recordDone('extract', [{ assetId: clipId, role: 'clip' }], [{ assetId: frame.id, role: 'frame' }], { which: label });
      let itemId = p.board.items().find((i) => i.kind === 'asset' && i.ref === frame.id)?.id;
      if (!itemId) {
        const src2 = (origin && p.board.item(origin)) || p.board.items().find((i) => i.kind === 'asset' && i.ref === clipId);
        itemId = src2 ? p.board.placeResults(src2.id, [frame.id])[0]!.id : p.board.addAsset(frame.id, 0, 0).id;
      }
      send('board');
      return { ok: true, assetId: frame.id, itemId };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
    finally { await import('node:fs/promises').then((fs) => fs.rm(tmp, { force: true })); }
  });
  h('assets', async () => {
    if (!project) return [];
    // older imports may lack size/duration: fill them in once
    for (const a of project.db.all<{ id: string }>("SELECT id FROM assets WHERE width IS NULL AND kind IN ('image','video')")) await probeAsset(project, a.id);
    return project.db.all('SELECT * FROM assets ORDER BY created_at DESC');
  });
  h('importAssets', async () => {
    if (!project) return [];
    const r = await dialog.showOpenDialog(win!, { title: 'Import images', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Images and video', extensions: ['png', 'jpg', 'jpeg', 'webp', 'mp4', 'webm', 'mov'] }] });
    if (r.canceled) return [];
    const out = [];
    for (const f of r.filePaths) { const i = await probe(f); out.push(await project.assets.importFile(f, { width: i.width, height: i.height, durationMs: i.durationMs, fps: i.fps, hasAudio: i.hasAudio })); }
    return out;
  });
  h('blobGet', (k: string) => project?.loadBlob(k) ?? null);
  h('blobSet', (k: string, v: string) => { project?.saveBlob(k, v); });
  h('jobs', () => (project ? project.jobs.list().map(jobView).reverse() : []));
  h('enqueue', async (profileId: string, values: Record<string, unknown>) => {
    if (!runner) return { ok: false, error: 'Open or create a project first.' };
    try { return { ok: true, job: jobView(await runner.enqueue({ profileId, values })) }; } catch (e) { return { ok: false, error: (e as Error).message }; }
  });
  /** Batch size: n more runs of a finished job with the same settings, each with a fresh random seed. Results land next to the original. */
  h('variations', async (jobId: string, n: number) => {
    if (!runner || !project) return { ok: false, error: 'No project' };
    const j = project.jobs.get(jobId); if (!j?.profile_id) return { ok: false, error: 'That result was not made by a generation, so there is nothing to repeat.' };
    const p = profiles.find((x) => x.manifest.id === j.profile_id); let queued = 0;
    try {
      for (let i = 0; i < Math.max(1, Math.min(12, n)); i++) {
        const values = keepKnown(j.profile_id, JSON.parse(j.params) as Record<string, unknown>);
        if (p?.manifest.slots.some((s) => s.role === 'seed')) values.seed = Math.floor(Math.random() * 2 ** 31); else delete values.seed;
        await runner.enqueue({ profileId: j.profile_id, values, origin: j.origin ?? undefined, shotId: j.shot_id ?? undefined }); queued++;
      }
      return { ok: true, queued };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  });
  h('cancel', (id: string) => runner?.cancel(id));
  h('retry', async (id: string, nudgeSeed: boolean) => {
    if (!runner || !project) return { ok: false, error: 'No project' };
    const j = project.jobs.get(id);
    if (!j?.profile_id) return { ok: false, error: 'Job has no profile' };
    const values = keepKnown(j.profile_id, JSON.parse(j.params) as Record<string, unknown>);
    if (nudgeSeed && typeof values.seed === 'number') values.seed = values.seed + 1;
    try { await runner.enqueue({ profileId: j.profile_id, values }); return { ok: true }; } catch (e) { return { ok: false, error: (e as Error).message }; }
  });
}

app.whenReady().then(async () => {
  await hub.init();
  await reloadProfiles();
  protocol.handle('driftboard-asset', (req) => {
    if (!project) return new Response('no project', { status: 404 });
    const id = new URL(req.url).hostname;
    const a = project.assets.get(id);
    if (!a) return new Response('not found', { status: 404 });
    return serveFile(project.assets.pathFor(a), req);
  });
  protocol.handle('driftboard-thumb', async (req) => {
    if (!project) return new Response('no project', { status: 404 });
    const f = await posterFor(project, new URL(req.url).hostname);
    return f ? net.fetch(pathToFileURL(f).toString()) : new Response('no poster', { status: 404 });
  });
  protocol.handle('driftboard-proxy', async (req) => {
    if (!project) return new Response('no project', { status: 404 });
    const f = await proxyFor(project, new URL(req.url).hostname);
    return f ? serveFile(f, req) : new Response('no proxy', { status: 404 });
  });
  logger.init(path.join(app.getPath('userData'), 'logs'), (e) => send('log', e));
  hub.onLog = (level, msg) => { logger.add(level, 'llm', msg); };
  hub.onTasks = (t) => send('llmTasks', t);
  log.info('app', `started (${app.getVersion()}, electron ${process.versions.electron})`);
  process.on('uncaughtException', (e) => log.error('app', `uncaught: ${e.stack ?? e.message}`));
  process.on('unhandledRejection', (e) => log.error('app', `unhandled rejection: ${(e as Error)?.stack ?? String(e)}`));
  register();
  win = new BrowserWindow({ width: 1280, height: 860, backgroundColor: '#14161a', title: 'Driftboard', icon: existsSync(path.join(__dirname, '../build/icon.png')) ? path.join(__dirname, '../build/icon.png') : undefined, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: false } });
  if (process.env.DRIFTBOARD_SMOKE) win.webContents.on('console-message', (e: any) => { void import('node:fs/promises').then((fs) => fs.appendFile(process.env.DRIFTBOARD_SMOKE + '.console.txt', `[${e.level ?? ''}] ${e.message ?? ''}
`)); });
  await win.loadFile(path.join(__dirname, 'renderer/index.html'));
  try {
    const dir = process.env.DRIFTBOARD_PROJECT ?? (await import('node:fs/promises').then((fs) => fs.readFile(lastProject(), 'utf8'))).trim();
    if (dir) await attach(await Project.open(dir));
  } catch { /* no previous project */ }
  // Dev/test hook: save a screenshot and the page text, then quit.
  if (process.env.DRIFTBOARD_SMOKE && process.env.DRIFTBOARD_SCRIPT) {
    // Dev/test hook: run a script inside the page (drives the real UI), save its result, then fall through to the screenshot.
    await new Promise((r) => setTimeout(r, 2000));
    const fs = await import('node:fs/promises');
    const code = await fs.readFile(process.env.DRIFTBOARD_SCRIPT, 'utf8');
    let out: unknown;
    try { out = await win.webContents.executeJavaScript(`(async () => { ${code} })()`); } catch (e) { out = { scriptError: String(e) }; }
    await fs.writeFile(process.env.DRIFTBOARD_SMOKE + '.script.json', JSON.stringify(out, null, 2));
  }
  if (process.env.DRIFTBOARD_SMOKE) {
    await new Promise((r) => setTimeout(r, 2500));
    const fs = await import('node:fs/promises');
    await fs.writeFile(process.env.DRIFTBOARD_SMOKE + '.png', (await win.webContents.capturePage()).toPNG());
    if (process.env.DRIFTBOARD_PERF) await fs.writeFile(process.env.DRIFTBOARD_SMOKE + '.perf.json', JSON.stringify(await win.webContents.executeJavaScript('window.__perf()'), null, 2));
    await fs.writeFile(process.env.DRIFTBOARD_SMOKE + '.txt', await win.webContents.executeJavaScript('document.body.innerText'));
    app.quit();
  }
});
app.on('window-all-closed', () => { project?.close(); app.quit(); });
