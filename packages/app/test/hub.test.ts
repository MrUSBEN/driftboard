import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { LlmHub } from '../src/main/llmHub.ts';

/** A tiny LM Studio: lists one model, loads/unloads it, answers chat. Records every call. */
async function fakeServer() {
  const calls: string[] = []; let loaded: { id: string; config: { context_length: number } }[] = [];
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => (body += d)); req.on('end', () => {
      const j = body ? JSON.parse(body) : {};
      calls.push(`${req.method} ${req.url}${j.context_length ? ' ctx=' + j.context_length : ''}${j.reasoning_effort ? ' think=' + j.reasoning_effort : ''}`);
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/v1/models') return void res.end(JSON.stringify({ models: [{ key: 'qwen', type: 'llm', max_context_length: 100000, loaded_instances: loaded }, { key: 'embed', type: 'embedding', loaded_instances: [] }] }));
      if (req.url === '/api/v1/models/load') { loaded = [{ id: 'qwen', config: { context_length: j.context_length } }]; return void res.end('{}'); }
      if (req.url === '/api/v1/models/unload') { loaded = []; return void res.end('{}'); }
      if (req.url === '/v1/chat/completions') return void res.end(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }));
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { calls, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`, close: () => srv.close(), loaded: () => loaded.length > 0 };
}
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'hub-'));
async function mk(patch: object = {}) {
  const srv = await fakeServer(), dir = tmp(), bundled = path.join(dir, 'bundled'), user = path.join(dir, 'user');
  (await import('node:fs/promises')).mkdir(bundled, { recursive: true });
  writeFileSync(path.join(dir, 'llm.json'), JSON.stringify({ url: srv.url, ...patch }));
  writeFileSync(path.join(bundled, 'assistant.md'), '---\ntitle: Assistant\n---\nbuilt-in');
  const hub = new LlmHub({ settings: path.join(dir, 'llm.json'), bundled, user });
  await hub.init();
  return { hub, srv, dir };
}

test('settings: defaults, saved merge, per-task thinking', async () => {
  const { hub, dir, srv } = await mk({ contextLength: 32768, thinking: { chat: 'off' } });
  assert.equal(hub.s.contextLength, 32768); assert.deepEqual(hub.s.thinking, { director: 'medium', enhance: 'medium', chat: 'off' });
  await hub.set({ thinking: { director: 'high' }, idleMinutes: 0 });
  const saved = JSON.parse((await import('node:fs')).readFileSync(path.join(dir, 'llm.json'), 'utf8'));
  assert.deepEqual([saved.thinking.director, saved.thinking.chat, saved.idleMinutes], ['high', 'off', 0]); srv.close();
});

test('a batch loads the model with the context and thinking, then frees the GPU once', async () => {
  const { hub, srv } = await mk({ idleMinutes: 0 });
  const out = await hub.use('director', async () => { assert.ok(srv.loaded()); await hub.client.chat({ system: 's', user: 'u' }); await hub.client.chat({ system: 's', user: 'u' }); return 42; }, { batch: true });
  assert.equal(out, 42);
  assert.ok(srv.calls.includes('POST /api/v1/models/load ctx=16384'));
  assert.ok(srv.calls.some((c) => c.includes('think=medium')));
  assert.equal(srv.calls.filter((c) => c.includes('/models/load')).length, 1);          // loaded once for both calls
  assert.equal(srv.calls.filter((c) => c.includes('/models/unload')).length, 1);        // and freed once
  assert.equal(srv.loaded(), false); assert.equal(hub.s.model, 'qwen'); srv.close();      // first non-embedding model was chosen
});

test('without unload-after-batch and idle time the model stays loaded; a single call is not a batch', async () => {
  const { hub, srv } = await mk({ unloadAfterBatch: false, idleMinutes: 0 });
  await hub.use('enhance', async () => 1, { batch: true });
  assert.equal(srv.loaded(), true);
  const { hub: h2, srv: s2 } = await mk({ idleMinutes: 0 });
  await h2.use('chat', async () => 1);
  assert.equal(s2.loaded(), true); srv.close(); s2.close();
});

test('LLM work is refused while ComfyUI generates (unless allowed); a job waits for LLM work and then frees the GPU', async () => {
  const { hub, srv } = await mk({ idleMinutes: 0, unloadAfterBatch: false });
  hub.gpuBusy = () => true;
  await assert.rejects(hub.use('chat', async () => 1), /ComfyUI is generating/);
  await hub.set({ allowDuringJobs: true }); await hub.use('chat', async () => 1);       // allowed now
  hub.gpuBusy = () => false; await hub.set({ allowDuringJobs: false });
  let release!: () => void; const gate = new Promise<void>((r) => (release = r));
  const work = hub.use('director', () => gate);
  await new Promise((r) => setTimeout(r, 50));
  let jobStarted = false; const job = hub.beforeJob().then(() => { jobStarted = true; });
  await new Promise((r) => setTimeout(r, 600)); assert.equal(jobStarted, false);        // waiting for the LLM
  release(); await work; await job;
  assert.equal(jobStarted, true); assert.equal(srv.loaded(), false); srv.close();         // and the model was freed for the job
});

test('guide edits override the built-in one and can be reset', async () => {
  const { hub, srv } = await mk();
  assert.equal(hub.guide('assistant')!.body, 'built-in');
  await hub.saveGuide('assistant', 'my version'); assert.equal(hub.guide('assistant')!.body, 'my version'); assert.equal(hub.guide('assistant')!.custom, true);
  await hub.resetGuide('assistant'); assert.equal(hub.guide('assistant')!.body, 'built-in');
  await assert.rejects(hub.saveGuide('../evil', 'x'), /Bad guide id`?/); srv.close();
});
