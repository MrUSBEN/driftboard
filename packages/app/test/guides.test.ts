import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { LlmHub } from '../src/main/llmHub.ts';
import { loadGuides } from '@driftboard/adapter-llm';
import { enhancePrompt, guideText } from '@driftboard/director';

const GUIDES = path.resolve(import.meta.dirname, '../../../guides');
const PROFILES = path.resolve(import.meta.dirname, '../../../profiles');
const ALL_IDS = ['assistant', 'bridge-shot', 'continue-shot', 'dialogue-polish', 'director-bible', 'director-continue', 'director-interpret', 'director-scenes', 'director-shots', 'h3-image-edit', 'h3-video', 'moss-image', 'script-from-idea', 'storyboard-describe', 'storyboard-notes', 'storyboard-story'];
const hashDir = (d: string) => createHash('sha1').update(readdirSync(d).sort().map((n) => n + readFileSync(path.join(d, n), 'utf8')).join('\n')).digest('hex');

/** A tiny LM Studio that records the messages of every chat call. */
async function server() {
  const chats: string[] = [];
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => (body += d)); req.on('end', () => {
      const j = body ? JSON.parse(body) : {};
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/v1/models') return void res.end(JSON.stringify({ models: [{ key: 'qwen', type: 'llm', max_context_length: 100000, loaded_instances: [{ id: 'qwen', config: { context_length: 16384 } }] }] }));
      if (req.url === '/v1/chat/completions') { chats.push(JSON.stringify(j.messages)); return void res.end(JSON.stringify({ choices: [{ message: { content: 'A woman stands on a rain-wet quay at dusk while a ferry horn sounds in the distance.' } }] })); }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { chats, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`, close: () => srv.close() };
}
async function makeHub(dir: string, url: string) {
  writeFileSync(path.join(dir, 'llm.json'), JSON.stringify({ url, idleMinutes: 0, unloadAfterBatch: false }));
  const hub = new LlmHub({ settings: path.join(dir, 'llm.json'), bundled: GUIDES, user: path.join(dir, 'user') });
  await hub.init();
  return hub;
}
const enhance = (hub: LlmHub, id: string) => hub.use('enhance', () => enhancePrompt(hub.client, { idea: 'woman on a quay in the rain', guide: hub.guide(id)!, seconds: 5, thinking: 'off' }));

test('shipped guides: all 16 exist, are non-empty, only use known {{variables}}, every manifest guide resolves', async () => {
  const g = await loadGuides([GUIDES]);
  assert.deepEqual([...g.keys()].sort(), ALL_IDS);
  for (const id of ALL_IDS) assert.ok(g.get(id)!.body.length > 100, `${id} is empty`);
  const known = new Set(['framings', 'maxPart', 'maxShots', 'moves', 'seconds']);
  for (const id of ALL_IDS) for (const m of g.get(id)!.body.matchAll(/\{\{(\w+)\}\}/g)) assert.ok(known.has(m[1]!), `${id} uses unknown {{${m[1]}}}`);
  for (const d of readdirSync(PROFILES)) {
    const m = JSON.parse(readFileSync(path.join(PROFILES, d, 'manifest.json'), 'utf8')) as { guide?: string };
    if (m.guide) assert.ok(g.has(m.guide), `${d} points to missing guide ${m.guide}`);
  }
  assert.equal(g.get('h3-video')!.durationLine, 'recommended_duration');
  assert.match(g.get('h3-video')!.body, /recommended_duration/);
});

test('public safety: shipped guides and profile workflows hold no explicit sample content', () => {
  const bad = /erotic|explicit adult|\bnude\b|penis|vagina|breasts|genital|sexual|twerk/i;
  for (const n of readdirSync(GUIDES)) assert.doesNotMatch(readFileSync(path.join(GUIDES, n), 'utf8'), bad, `guide ${n}`);
  for (const d of readdirSync(PROFILES)) for (const f of ['workflow.json', 'manifest.json']) assert.doesNotMatch(readFileSync(path.join(PROFILES, d, f), 'utf8'), bad, `${d}/${f}`);
});

test('an edited guide reaches the LLM, survives a restart, and Reset brings the built-in one back', async () => {
  const srv = await server(), dir = mkdtempSync(path.join(os.tmpdir(), 'gd-')), before = hashDir(GUIDES);
  const hub = await makeHub(dir, srv.url);
  const userFile = path.join(dir, 'user', 'h3-video.md');

  // built-in first
  assert.equal(hub.guide('h3-video')!.custom, false);
  await enhance(hub, 'h3-video');
  assert.match(srv.chats.at(-1)!, /MINIMAX H3 VIDEO PROMPT ENHANCER/); assert.doesNotMatch(srv.chats.at(-1)!, /MY OVERRIDE/);

  // edit: saved in the user folder, header kept, used by the next call, final line still written by the app
  await hub.saveGuide('h3-video', 'MY OVERRIDE TEXT for the video model');
  assert.ok(existsSync(userFile)); assert.match(readFileSync(userFile, 'utf8'), /^---\ntitle: [^\n]+\ndurationLine: recommended_duration\n---\nMY OVERRIDE TEXT/);
  assert.equal(hub.guide('h3-video')!.custom, true); assert.equal(hub.guide('h3-video')!.durationLine, 'recommended_duration');
  const r = await enhance(hub, 'h3-video');
  assert.match(srv.chats.at(-1)!, /MY OVERRIDE TEXT/); assert.doesNotMatch(srv.chats.at(-1)!, /MINIMAX H3 VIDEO PROMPT ENHANCER/);
  assert.match(r.prompt, /recommended_duration: 5 seconds\s*$/);

  // restart: a new hub on the same folders still uses the edit
  const hub2 = await makeHub(dir, srv.url);
  assert.equal(hub2.guide('h3-video')!.body, 'MY OVERRIDE TEXT for the video model'); assert.equal(hub2.guide('h3-video')!.custom, true);

  // other guides are untouched and still built-in
  assert.equal(hub2.guide('moss-image')!.custom, false);

  // reset
  await hub2.resetGuide('h3-video');
  assert.ok(!existsSync(userFile)); assert.equal(hub2.guide('h3-video')!.custom, false);
  await enhance(hub2, 'h3-video'); assert.match(srv.chats.at(-1)!, /MINIMAX H3 VIDEO PROMPT ENHANCER/);

  assert.equal(hashDir(GUIDES), before, 'saving and resetting must never modify the bundled guides');
  srv.close();
});

test('every guide round-trips through Save and Reset, and the director/assistant lookups follow the edit', async () => {
  const srv = await server(), dir = mkdtempSync(path.join(os.tmpdir(), 'gd-')), before = hashDir(GUIDES);
  const hub = await makeHub(dir, srv.url);
  for (const id of ALL_IDS) {
    const built = hub.guide(id)!;
    await hub.saveGuide(id, `EDITED ${id}`);
    const g = hub.guide(id)!;
    assert.equal(g.body, `EDITED ${id}`, id); assert.equal(g.custom, true, id); assert.equal(g.durationLine, built.durationLine, `${id} keeps its duration line`); assert.equal(g.title, built.title, `${id} keeps its title`);
    if (id.startsWith('director-')) assert.equal(guideText(hub.guide, id), `EDITED ${id}`);           // the Director reads guides through this
    await hub.resetGuide(id);
    assert.equal(hub.guide(id)!.body, built.body, `${id} reset`); assert.equal(hub.guide(id)!.custom, false, `${id} reset flag`);
  }
  assert.equal(readdirSync(path.join(dir, 'user')).length, 0, 'reset removes every user file');
  assert.equal(hashDir(GUIDES), before);
  srv.close();
});

test('a hand-written user guide with CRLF line endings and a BOM parses and overrides', async () => {
  const srv = await server(), dir = mkdtempSync(path.join(os.tmpdir(), 'gd-'));
  const hub = await makeHub(dir, srv.url);
  const fs = await import('node:fs/promises'); await fs.mkdir(path.join(dir, 'user'), { recursive: true });
  writeFileSync(path.join(dir, 'user', 'h3-video.md'), '﻿---\r\ntitle: Mine\r\ndurationLine: recommended_duration\r\n---\r\nHand written body\r\n');
  await hub.reloadGuides();
  const g = hub.guide('h3-video')!; assert.equal(g.title, 'Mine'); assert.equal(g.body, 'Hand written body'); assert.equal(g.durationLine, 'recommended_duration'); assert.equal(g.custom, true);
  srv.close();
});
