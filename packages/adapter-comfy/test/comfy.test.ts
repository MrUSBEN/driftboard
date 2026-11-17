import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { Project } from '@driftboard/core';
import { loadProfiles } from '@driftboard/profiles';
import { ComfyClient, JobRunner } from '../src/index.ts';
import { startFake } from './fake-comfy.ts';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const profiles = await loadProfiles(path.join(import.meta.dirname, '../../../profiles'));
const tmp = () => mkdtemp(path.join(tmpdir(), 'driftboard-comfy-'));
const MODELS = { unet: ['minimax_h3_fl2va_pruned_int8_convrot.safetensors', 'minimax_h3_ref2va_pruned_int8_convrot.safetensors', 'minimax_h3_image_pruned_int8_convrot.safetensors', 'moss_image_sft_int8_convrot_attn.safetensors'], clip: ['qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', 'MOSS_qwen3.5_9b_int8_convrot.safetensors'], vae: ['minimax_h3_video_vae_int8_convrot.safetensors', 'minimax_h3_audio_vae_fp32.safetensors', 'minimax_h3_image_vae_fp16.safetensors', 'flux2-vae.safetensors'] };
const videoOut = (g: any) => Object.fromEntries(['141', '144', '121', '130'].filter((id) => g[id]).map((id) => [id, { images: [{ filename: `vid_${id}.mp4`, subfolder: '', type: 'temp' }] }]));

async function setup(fakeOpts = {}, runnerOpts = {}) {
  const fake = await startFake({ models: MODELS, outputs: videoOut, ...fakeOpts });
  fake.files.set('vid_141.mp4', Buffer.from('video-141')); fake.files.set('vid_144.mp4', Buffer.from('video-144')); fake.files.set('vid_121.mp4', Buffer.from('video-121')); fake.files.set('vid_130.mp4', Buffer.from('video-130'));
  const dir = await tmp();
  const project = await Project.create(path.join(dir, 'p'), 'T');
  const client = new ComfyClient({ baseUrl: fake.url });
  const runner = new JobRunner(project, client, profiles, { pollMs: 50, ...runnerOpts });
  const img = await project.assets.importBuffer(Buffer.from('png-bytes'), 'png');
  const img2 = await project.assets.importBuffer(Buffer.from('png-bytes-2'), 'png');
  const idle = () => new Promise<void>((r) => runner.once('idle', r));
  return { fake, project, client, runner, img, img2, idle, async done() { runner.removeAllListeners(); project.close(); await fake.close(); } };
}

test('client: ping, pre-flight finds missing models and nodes', async () => {
  const t = await setup({ models: { ...MODELS, unet: [] }, missingNodes: ['MiniMaxH3AddGuide'] });
  assert.equal((await t.client.ping()).version, 'fake');
  const r = await t.client.preflight(profiles.find((p) => p.manifest.id === 'h3-video-reference')!.manifest);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missingNodes, ['MiniMaxH3AddGuide']);
  assert.deepEqual(r.missingModels, [{ kind: 'unet', name: 'minimax_h3_ref2va_pruned_int8_convrot.safetensors' }]);
  await t.done();
});

test('video job with 2 refs: uploads once, builds graph, shows progress, imports output, records lineage', async () => {
  const t = await setup();
  const progress: number[] = [];
  t.runner.on('progress', (_id, f) => progress.push(f));
  const idle = t.idle();
  const job = await t.runner.enqueue({ profileId: 'h3-video-reference', values: { prompt: 'hello', seconds: 3, refs: [t.img.id, t.img2.id, t.img.id] } });
  await idle;
  const done = t.project.jobs.get(job.id)!;
  assert.equal(done.status, 'done', done.error ?? '');
  assert.equal(t.fake.uploads.length, 2);                                    // same asset uploaded once
  const g = t.fake.submitted[0]!.graph;
  assert.equal(t.fake.submitted[0]!.id, job.id);                              // our id is the prompt id
  assert.equal(Object.keys(g['136'].inputs).filter((k) => k.startsWith('ref_images.')).length, 3);
  assert.equal(g['138'].inputs.value, 'hello'); assert.equal(g['144'], undefined);
  assert.ok(progress.length >= 2 && progress.at(-1) === 1);
  const outs = t.project.jobs.outputs(job.id);
  assert.equal(outs.length, 1); assert.equal(outs[0]!.role, 'video');
  assert.equal(t.project.assets.get(outs[0]!.assetId)!.kind, 'video');
  assert.deepEqual(t.project.jobs.ancestors(outs[0]!.assetId).map((a) => a.assetId).sort(), [t.img.id, t.img2.id].sort());
  assert.ok(done.workflow_hash); assert.equal(done.profile_version, profiles.find((p) => p.manifest.id === 'h3-video-reference')!.manifest.version);
  assert.equal(JSON.parse(done.params).seed > 0, true);                       // seed fixed at enqueue
  await t.done();
});

test('queue runs jobs in order, one at a time', async () => {
  const t = await setup({ runMs: 40 });
  const order: string[] = [];
  t.runner.on('job', (j) => { if (j.status === 'running') order.push(j.id); });
  const idle = t.idle();
  const a = await t.runner.enqueue({ profileId: 'h3-video-reference', values: { prompt: 'a' } });
  const b = await t.runner.enqueue({ profileId: 'h3-video-reference', values: { prompt: 'b' } });
  const c = await t.runner.enqueue({ profileId: 'h3-video-reference', values: { prompt: 'c' } });
  await idle;
  assert.deepEqual(order, [a.id, b.id, c.id]);
  assert.deepEqual(t.project.jobs.list().map((j) => j.status), ['done', 'done', 'done']);
  await t.done();
});

test('ComfyUI rejects the workflow: job fails with node-level message', async () => {
  const t = await setup({ onPrompt: () => ({ nodeErrors: { '136': { class_type: 'MiniMaxH3ReferenceToVideo', errors: [{ message: 'Value not in list', details: 'ref_image_size' }] } } }) });
  const idle = t.idle();
  const job = await t.runner.enqueue({ profileId: 'h3-video-reference', values: { prompt: 'x' } });
  await idle;
  const j = t.project.jobs.get(job.id)!;
  assert.equal(j.status, 'failed'); assert.match(j.error!, /node 136 \(MiniMaxH3ReferenceToVideo\): Value not in list/);
  await t.done();
});

test('execution error is reported with node type', async () => {
  const t = await setup({ onPrompt: () => 'execError' });
  const idle = t.idle();
  const job = await t.runner.enqueue({ profileId: 'h3-video-reference', values: { prompt: 'x' } });
  await idle;
  const j = t.project.jobs.get(job.id)!;
  assert.equal(j.status, 'failed'); assert.match(j.error!, /KSampler: out of memory/);
  await t.done();
});

test('pre-flight failure stops before upload and names what is missing', async () => {
  const t = await setup({ models: { ...MODELS, clip: [] } });
  const idle = t.idle();
  const job = await t.runner.enqueue({ profileId: 'h3-video-reference', values: { prompt: 'x', refs: [t.img.id] } });
  await idle;
  const j = t.project.jobs.get(job.id)!;
  assert.equal(j.status, 'failed'); assert.match(j.error!, /missing model\(s\): qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors \(clip\)/);
  assert.equal(t.fake.uploads.length, 0); assert.equal(t.fake.submitted.length, 0);
  await t.done();
});

test('cancel a running job interrupts ComfyUI; cancel a queued job never reaches it', async () => {
  const t = await setup({ runMs: 2000 });
  const idle = t.idle();
  const a = await t.runner.enqueue({ profileId: 'h3-video-reference', values: { prompt: 'a' } });
  const b = await t.runner.enqueue({ profileId: 'h3-video-reference', values: { prompt: 'b' } });
  await new Promise((r) => setTimeout(r, 300));
  await t.runner.cancel(b.id);                           // still queued in Driftboard
  await t.runner.cancel(a.id);                           // running in ComfyUI
  await idle;
  assert.equal(t.project.jobs.get(a.id)!.status, 'cancelled');
  assert.equal(t.project.jobs.get(b.id)!.status, 'cancelled');
  assert.deepEqual(t.fake.interrupted, [a.id]);
  assert.equal(t.fake.submitted.length, 1);
  await t.done();
});

test('websocket unavailable: polling /history still finishes the job', async () => {
  const t = await setup({ noWs: true });
  const idle = t.idle();
  const job = await t.runner.enqueue({ profileId: 'h3-video-reference', values: { prompt: 'x' } });
  await idle;
  assert.equal(t.project.jobs.get(job.id)!.status, 'done');
  await t.done();
});

test('websocket misses the final message: polling catches it', async () => {
  const t = await setup({ dropWsFinal: true });
  const idle = t.idle();
  const job = await t.runner.enqueue({ profileId: 'h3-video-reference', values: { prompt: 'x' } });
  await idle;
  assert.equal(t.project.jobs.get(job.id)!.status, 'done');
  await t.done();
});

test('ComfyUI not running: job fails with a plain message, retry works once it is up', async () => {
  const dir = await tmp();
  const project = await Project.create(path.join(dir, 'p'), 'T');
  const dead = new ComfyClient({ baseUrl: 'http://127.0.0.1:1' });
  const runner = new JobRunner(project, dead, profiles, { pollMs: 50 });
  const idle = new Promise<void>((r) => runner.once('idle', r));
  const job = await runner.enqueue({ profileId: 'h3-video-reference', values: { prompt: 'x', seed: 5 } });
  await idle;
  const j = project.jobs.get(job.id)!;
  assert.equal(j.status, 'failed'); assert.match(j.error!, /Cannot reach ComfyUI/);
  const retry = project.jobs.retry(job.id);
  assert.equal(JSON.parse(retry.params).seed, 5);
  project.close();
});

test('bad values are rejected at enqueue, before anything is queued', async () => {
  const t = await setup();
  await assert.rejects(t.runner.enqueue({ profileId: 'h3-video-reference', values: { prompt: 'x', seconds: 99 } }), /at most 15/);
  await assert.rejects(t.runner.enqueue({ profileId: 'nope', values: {} }), /Unknown profile/);
  assert.equal(t.project.jobs.list().length, 0);
  await t.done();
});

test('profile copy is saved in the project and i2v bridge adds the last-frame loader', async () => {
  const t = await setup();
  const idle = t.idle();
  const job = await t.runner.enqueue({ profileId: 'h3-video-i2v', values: { prompt: 'x', first_frame: t.img.id, last_frame: t.img2.id } });
  await idle;
  assert.equal(t.project.jobs.get(job.id)!.status, 'done', t.project.jobs.get(job.id)!.error ?? '');
  const g = t.fake.submitted[0]!.graph;
  const link = g['105:104'].inputs.last_frame;
  assert.equal(g[link[0]].class_type, 'LoadImage');
  const { readdir } = await import('node:fs/promises');
  assert.ok((await readdir(path.join(t.project.dir, 'profiles'))).includes(`h3-video-i2v@${profiles.find((p) => p.manifest.id === 'h3-video-i2v')!.manifest.version}`));
  await t.done();
});

test('beforeJob runs once per job, before anything is sent to ComfyUI, and its failure does not stop the job', async () => {
  const t = await setup({}, { beforeJob: async () => { calls.push(t0.fake.submitted.length); throw new Error('unload failed'); } });
  const calls: number[] = []; const t0 = t;
  const idle = t.idle();
  await t.runner.enqueue({ profileId: 'h3-video-reference', values: { prompt: 'a' } });
  await t.runner.enqueue({ profileId: 'h3-video-reference', values: { prompt: 'b' } });
  await idle;
  assert.deepEqual(calls, [0, 1]);                                           // each call saw only the earlier submissions
  assert.deepEqual(t.project.jobs.list().map((j) => j.status), ['done', 'done']);
  await t.done();
});

test('saved defaults (Settings → ComfyUI) fill in what the request leaves out, the request wins, and the job records the merged values', async () => {
  const t = await setup({}, { defaults: (id: string) => id === 'h3-video-reference' ? { steps: 12, model: 'minimax_h3_ref2va_pruned_int8_convrot.safetensors', refs: ['ignored'], nope: 1 } : {} });
  const idle = t.idle();
  const job = await t.runner.enqueue({ profileId: 'h3-video-reference', values: { prompt: 'x', steps: 20 } });
  await idle;
  const p = JSON.parse(t.project.jobs.get(job.id)!.params);
  assert.equal(p.steps, 20); assert.equal(p.model, 'minimax_h3_ref2va_pruned_int8_convrot.safetensors');
  assert.equal(p.refs, undefined); assert.equal(p.nope, undefined);            // inputs and unknown keys never come from defaults
  await t.done();
});

test('a chosen model that ComfyUI does not have fails the job by name, before anything is uploaded', async () => {
  const t = await setup();
  const idle = t.idle();
  const job = await t.runner.enqueue({ profileId: 'h3-video-reference', values: { prompt: 'x', refs: [t.img.id], model: 'my_finetune.safetensors' } });
  await idle;
  const j = t.project.jobs.get(job.id)!;
  assert.equal(j.status, 'failed'); assert.match(j.error ?? '', /my_finetune\.safetensors \(unet\)/);
  assert.equal(t.fake.uploads.length, 0);
  await t.done();
});

test('set-once settings nobody chose are recorded with the workflow value, so a job says exactly which model and steps ran', async () => {
  const t = await setup();
  const idle = t.idle();
  const job = await t.runner.enqueue({ profileId: 'h3-video-reference', values: { prompt: 'x' } });
  await idle;
  const p = JSON.parse(t.project.jobs.get(job.id)!.params);
  assert.equal(p.model, 'minimax_h3_ref2va_pruned_int8_convrot.safetensors'); assert.equal(p.sage_attention, false); assert.equal(typeof p.steps, 'number');
  await t.done();
});
