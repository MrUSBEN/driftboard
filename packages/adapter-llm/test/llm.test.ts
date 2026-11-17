import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { LlmClient, LlmError, parseLooseJson, snap, snapNumber } from '../src/index.ts';

test('loose JSON: fences, chatter, trailing commas, smart and single quotes, unquoted keys, cut-off replies', () => {
  assert.deepEqual(parseLooseJson('Sure!\n```json\n{"a": 1, "b": [1,2,],}\n```\nHope that helps'), { a: 1, b: [1, 2] });
  assert.deepEqual(parseLooseJson('{“a”: “x”}'), { a: 'x' });
  assert.deepEqual(parseLooseJson("{'a': 'x', b: 2}"), { a: 'x', b: 2 });
  assert.deepEqual(parseLooseJson('[{"x":1},{"x":2}]'), [{ x: 1 }, { x: 2 }]);
  assert.deepEqual(parseLooseJson('{"shots":[{"a":"one"},{"a":"two"},{"a":"thr'), { shots: [{ a: 'one' }, { a: 'two' }, { a: 'thr' }] });
  assert.deepEqual(parseLooseJson('{"k":"a } b ] c"}'), { k: 'a } b ] c' });          // brackets inside strings
  assert.throws(() => parseLooseJson('no json here'), /No JSON/);
});

test('snap picks the closest allowed value', () => {
  const sizes = ['wide', 'medium', 'close'] as const;
  assert.equal(snap('Medium', sizes, { fallback: 'wide' }), 'medium');
  assert.equal(snap('extreme close-up', sizes, { fallback: 'wide' }), 'close');
  assert.equal(snap('over the shoulder', sizes, { fallback: 'medium', words: [[/shoulder/i, 'close']] }), 'close');
  assert.equal(snap(undefined, sizes, { fallback: 'medium' }), 'medium');
  assert.equal(snapNumber(7, [3, 5, 8, 10]), 8); assert.equal(snapNumber(4, [3, 5]), 5); assert.equal(snapNumber('x', [3, 5], 5), 5);
});

interface Seen { body: any }
async function fake(handler: (b: any, n: number) => { status?: number; content?: string; empty?: boolean }) {
  const seen: Seen[] = []; const unloaded: string[] = []; let n = 0;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const json = (code: number, v: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    if (req.url === '/api/v1/models') return json(200, { models: [{ key: 'gemma', type: 'llm', loaded_instances: [{ id: 'gemma' }] }, { key: 'embed', type: 'embedding', loaded_instances: [] }] });
    if (req.url === '/api/v1/models/unload') { unloaded.push(body.instance_id); return json(200, { instance_id: body.instance_id }); }
    if (req.url === '/v1/chat/completions') {
      seen.push({ body }); const r = handler(body, ++n);
      if (r.status) return json(r.status, { error: { message: 'unsupported response_format' } });
      return json(200, { choices: [{ message: { content: r.empty ? '' : r.content }, finish_reason: 'stop' }] });
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return { url, seen, unloaded, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

test('chat sends reasoning_effort none and json_schema first; steps down when the server refuses; remembers', async () => {
  const s = await fake((b) => (b.response_format?.type === 'json_schema' ? { status: 400 } : { content: '{"ok":true}' }));
  const c = new LlmClient({ baseUrl: s.url, model: 'gemma' });
  assert.equal(await c.chat({ system: 's', user: 'u', schema: { type: 'object' } }), '{"ok":true}');
  assert.equal(s.seen[0]!.body.reasoning_effort, 'none'); assert.equal(s.seen[0]!.body.response_format.type, 'json_schema');
  assert.equal(s.seen[1]!.body.response_format.type, 'json_object');
  await c.chat({ system: 's', user: 'u', schema: { type: 'object' } });
  assert.equal(s.seen[2]!.body.response_format.type, 'json_object');   // started at what worked
  await s.close();
});

test('json: validates, retries once with the problem spelled out, then gives up clearly', async () => {
  const s = await fake((b, n) => ({ content: n === 1 ? '```json\n{"count": "many"}\n```' : '{"count": 3}' }));
  const c = new LlmClient({ baseUrl: s.url, model: 'gemma' });
  const r = await c.json({ system: 's', user: 'u', schema: {}, validate: (x) => { const n = (x as { count: unknown }).count; if (typeof n !== 'number') throw new Error('count must be a number'); return n; } });
  assert.deepEqual([r.value, r.attempts], [3, 2]);
  assert.match(s.seen[1]!.body.messages[1].content, /count must be a number/);
  await s.close();
  const bad = await fake(() => ({ content: 'nope' }));
  const c2 = new LlmClient({ baseUrl: bad.url, model: 'gemma' });
  await assert.rejects(c2.json({ system: 's', user: 'u', validate: () => 1 }), (e: unknown) => e instanceof LlmError && e.kind === 'invalid');
  await bad.close();
});

test('empty reply (reasoning ate the tokens) is reported plainly', async () => {
  const s = await fake(() => ({ empty: true }));
  await assert.rejects(new LlmClient({ baseUrl: s.url, model: 'm' }).chat({ system: 's', user: 'u' }), /empty reply/);
  await s.close();
});

test('LM Studio: lists models with loaded state and unloads every loaded instance', async () => {
  const s = await fake(() => ({ content: '{}' }));
  const c = new LlmClient({ baseUrl: s.url });
  assert.deepEqual((await c.models()).map((m) => [m.id, m.loaded, m.embedding]), [['gemma', true, false], ['embed', false, true]]);
  assert.equal(await c.unloadAll(), 1); assert.deepEqual(s.unloaded, ['gemma']);
  await s.close();
});

test('server not running gives a plain message', async () => {
  const c = new LlmClient({ baseUrl: 'http://127.0.0.1:1/v1', model: 'm' });
  await assert.rejects(c.chat({ system: 's', user: 'u' }), (e: unknown) => e instanceof LlmError && e.kind === 'unreachable' && /Is the LLM server running/.test(e.message));
});

import { mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { parseGuide, loadGuides, fill, stripThinking } from '../src/index.ts';

test('guides: header, body, override by a later folder, variables', async () => {
  const g = parseGuide('x', '---\ntitle: Hello\ndurationLine: recommended_duration\n---\nBody {{n}} seconds\n');
  assert.deepEqual([g.title, g.durationLine, g.body], ['Hello', 'recommended_duration', 'Body {{n}} seconds']);
  assert.equal(parseGuide('y', 'no header').title, 'y');
  assert.equal(fill('a {{n}} b {{missing}}.', { n: 5 }), 'a 5 b .');
  const a = mkdtempSync(nodePath.join(os.tmpdir(), 'g1-')), b = mkdtempSync(nodePath.join(os.tmpdir(), 'g2-'));
  writeFileSync(nodePath.join(a, 'one.md'), 'built-in one'); writeFileSync(nodePath.join(a, 'two.md'), 'built-in two');
  writeFileSync(nodePath.join(b, 'two.md'), 'MY two');
  const all = await loadGuides([a, b, nodePath.join(a, 'nope')]);
  assert.equal(all.get('one')!.body, 'built-in one'); assert.equal(all.get('one')!.custom, false);
  assert.equal(all.get('two')!.body, 'MY two'); assert.equal(all.get('two')!.custom, true);
});

test('thinking: level goes out as reasoning_effort, off as none; extra tokens are allowed; reasoning in the reply is removed', async () => {
  const seen: any[] = [];
  const f: typeof fetch = async (_u, init) => { const b = JSON.parse(String((init as RequestInit).body)); seen.push(b); return new Response(JSON.stringify({ choices: [{ message: { content: '<think>hmm, let me see</think>The answer.' } }] }), { status: 200 }); };
  const llm = new LlmClient({ baseUrl: 'http://x/v1', model: 'm', fetch: f });
  assert.equal(await llm.chat({ system: 's', user: 'u', thinking: 'high', maxTokens: 1000 }), 'The answer.');
  await llm.chat({ system: 's', user: 'u', thinking: 'off', maxTokens: 1000 });
  assert.deepEqual([seen[0].reasoning_effort, seen[0].max_tokens, seen[1].reasoning_effort, seen[1].max_tokens], ['high', 8000, 'none', 1000]);
  assert.equal(stripThinking('<thinking>a</thinking>\nok'), 'ok'); assert.equal(stripThinking('plan...</think>final'), 'final');
});

test('chat keeps earlier turns between the system prompt and the new message', async () => {
  let body: any;
  const f: typeof fetch = async (_u, init) => { body = JSON.parse(String((init as RequestInit).body)); return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }); };
  await new LlmClient({ baseUrl: 'http://x/v1', model: 'm', fetch: f }).chat({ system: 's', user: 'now', history: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] });
  assert.deepEqual(body.messages.map((m: any) => m.role + ':' + m.content), ['system:s', 'user:a', 'assistant:b', 'user:now']);
});

test('ensureLoaded loads the model with the wanted context, reloads on a different context, does nothing when right', async () => {
  const calls: string[] = []; let loaded: { id: string; config: { context_length: number } }[] = [];
  const f: typeof fetch = async (u, init) => {
    const url = String(u), body = (init as RequestInit | undefined)?.body ? JSON.parse(String((init as RequestInit).body)) : {};
    calls.push(`${(init as RequestInit | undefined)?.method ?? 'GET'} ${url.replace('http://x', '')}${body.context_length ? ' ctx=' + body.context_length : ''}`);
    if (url.endsWith('/api/v1/models')) return new Response(JSON.stringify({ models: [{ key: 'm', type: 'llm', max_context_length: 262144, loaded_instances: loaded }] }));
    if (url.endsWith('/models/load')) { loaded = [{ id: 'm', config: { context_length: body.context_length } }]; return new Response('{}'); }
    if (url.endsWith('/models/unload')) { loaded = []; return new Response('{}'); }
    return new Response('{}', { status: 404 });
  };
  const llm = new LlmClient({ baseUrl: 'http://x/v1', model: 'm', fetch: f }); llm.contextLength = 16384;
  await llm.ensureLoaded();
  assert.ok(calls.includes('POST /api/v1/models/load ctx=16384'));
  const n = calls.length; await llm.ensureLoaded(); assert.equal(calls.length, n + 1);          // only the listing
  llm.contextLength = 32768; const n2 = calls.length; await llm.ensureLoaded();
  assert.equal(calls.length, n2 + 1);   // a loaded model with at least 8k context is used as is (also when the user loaded it by hand)
  loaded = [{ id: 'm', config: { context_length: 4096 } }]; await llm.ensureLoaded();
  assert.ok(calls.includes('POST /api/v1/models/unload') && calls.includes('POST /api/v1/models/load ctx=32768'));   // too small: reload
});

test('chat frees, reloads and retries once after a 500 (bad allocation)', async () => {
  let chats = 0;
  const f: typeof fetch = async (u) => {
    const url = String(u);
    if (url.endsWith('/chat/completions')) { chats++; return chats === 1 ? new Response('bad allocation', { status: 500 }) : new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })); }
    if (url.endsWith('/api/v1/models')) return new Response(JSON.stringify({ models: [{ key: 'm', type: 'llm', loaded_instances: [{ id: 'm', config: { context_length: 16384 } }] }] }));
    return new Response('{}');
  };
  assert.equal(await new LlmClient({ baseUrl: 'http://x/v1', model: 'm', fetch: f }).chat({ system: 's', user: 'u' }), 'ok');
  assert.equal(chats, 2);
});

test('models that only have on/off thinking get the setting left out (on) or none (off), never an invalid value', async () => {
  const sent: string[] = [];
  const f: typeof fetch = async (u, init) => {
    const url = String(u);
    if (url.endsWith('/api/v1/models')) return new Response(JSON.stringify({ models: [{ key: 'm', type: 'llm', capabilities: { reasoning: { allowed_options: ['off', 'on'] } }, loaded_instances: [{ id: 'm', config: { context_length: 16384 } }] }] }));
    if (url.endsWith('/chat/completions')) { sent.push(JSON.parse(String((init as RequestInit).body)).reasoning_effort); return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })); }
    return new Response('{}');
  };
  const llm = new LlmClient({ baseUrl: 'http://x/v1', model: 'm', fetch: f });
  await llm.ensureLoaded();
  await llm.chat({ system: 's', user: 'u', thinking: 'medium' });
  await llm.chat({ system: 's', user: 'u', thinking: 'off' });
  assert.deepEqual(sent, [undefined, 'none']);   // on = setting left out (model default), off = none; never the invalid value 'on'
});

/** A small Ollama: native /api/* plus nothing else. Records what it was asked. */
async function fakeOllama(opts: { thinkingModel?: boolean } = {}) {
  const chats: any[] = [], generates: any[] = []; let loaded: { name: string; context_length: number }[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const json = (code: number, v: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    if (req.url === '/api/version') return json(200, { version: '0.12.0' });
    if (req.url === '/api/tags') return json(200, { models: [{ name: 'gemma3:12b', details: { family: 'gemma3' } }, { name: 'nomic-embed-text:latest', details: { family: 'nomic-bert' } }] });
    if (req.url === '/api/ps') return json(200, { models: loaded });
    if (req.url === '/api/generate') {
      generates.push(body);
      if (body.keep_alive === 0) loaded = loaded.filter((m) => m.name !== body.model); else loaded = [{ name: body.model, context_length: body.options?.num_ctx ?? 4096 }];
      return json(200, { done: true });
    }
    if (req.url === '/api/chat') {
      chats.push(body);
      if (body.think !== undefined && !opts.thinkingModel) return json(400, { error: `"${body.model}" does not support thinking` });
      return json(200, { message: { role: 'assistant', content: body.format ? '{"ok": true}' : 'A woman walks along the quay in the rain.' }, done: true });
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, chats, generates, loaded: () => loaded, close: () => server.close() };
}

test('Ollama is detected and driven through its own API: list, load with the context size, chat with that size, pictures, schema, unload', async () => {
  const o = await fakeOllama();
  const c = new LlmClient({ baseUrl: o.url, model: 'gemma3:12b' }); c.contextLength = 16384;
  assert.equal(await c.kind(), 'ollama');
  assert.deepEqual(await c.caps(), { kind: 'ollama', listModels: true, loadUnload: true, setContext: true });
  const ms = await c.models();
  assert.deepEqual(ms.map((m) => [m.id, m.embedding, m.loaded]), [['gemma3:12b', false, false], ['nomic-embed-text:latest', true, false]]);
  await c.ensureLoaded();
  assert.equal(o.generates.at(-1).options.num_ctx, 16384); assert.equal(o.loaded()[0]!.context_length, 16384);
  const text = await c.chat({ system: 's', user: 'describe', images: ['data:image/png;base64,AAAA'], thinking: 'off' });
  assert.match(text, /quay/);
  const sent = o.chats.at(-1);
  assert.equal(sent.options.num_ctx, 16384);                                  // same size as loaded, so Ollama does not reload with its small default
  assert.deepEqual(sent.messages.at(-1).images, ['AAAA']);                    // base64 without the data: prefix
  const j = await c.json({ system: 's', user: 'u', schema: { type: 'object' }, validate: (x) => x as { ok: boolean } });
  assert.deepEqual(j.value, { ok: true }); assert.deepEqual(o.chats.at(-1).format, { type: 'object' });
  assert.equal(await c.unloadAll(), 1); assert.equal(o.loaded().length, 0); assert.equal(o.generates.at(-1).keep_alive, 0);
  o.close();
});

test('Ollama: thinking asked of a model that cannot think is retried without the switch, and remembered', async () => {
  const o = await fakeOllama({ thinkingModel: false });
  const c = new LlmClient({ baseUrl: o.url, model: 'gemma3:12b' });
  assert.match(await c.chat({ system: 's', user: 'u', thinking: 'high' }), /quay/);
  assert.equal(o.chats.length, 2); assert.equal(o.chats[0].think, true); assert.equal('think' in o.chats[1], false);
  await c.chat({ system: 's', user: 'u', thinking: 'high' });
  assert.equal(o.chats.length, 3); assert.equal('think' in o.chats[2], false);
  o.close();
});

test('any other OpenAI-compatible server (llama.cpp, KoboldCpp, Jan...): chats and lists, never tries to load or unload', async () => {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') return void res.end(JSON.stringify({ data: [{ id: 'local-model' }] }));
    if (req.url === '/v1/chat/completions') return void res.end(JSON.stringify({ choices: [{ message: { content: 'A prompt that is long enough to pass.' } }] }));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const c = new LlmClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, model: 'local-model' });
  assert.equal(await c.kind(), 'openai');
  assert.deepEqual((await c.models()).map((m) => m.id), ['local-model']);
  await c.ensureLoaded(); assert.equal(await c.unloadAll(), 0);
  assert.match(await c.chat({ system: 's', user: 'u' }), /long enough/);
  assert.ok(!calls.some((x) => /load|unload|\/api\/generate/.test(x)), calls.join(', '));
  server.close();
});

test('the backend can be set by hand instead of detected', async () => {
  const c = new LlmClient({ baseUrl: 'http://127.0.0.1:9/v1', backend: 'ollama' });
  assert.equal(await c.kind(), 'ollama');
});
