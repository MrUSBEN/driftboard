import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';

export interface FakeOpts {
  runMs?: number;
  /** model names the fake "has" */
  models?: Record<string, string[]>;
  missingNodes?: string[];
  /** called with submitted graph; return 'ok' | {nodeErrors} | 'execError' */
  onPrompt?: (graph: any, id: string) => 'ok' | 'execError' | { nodeErrors: any };
  /** outputs by node id for a finished prompt */
  outputs?: (graph: any) => Record<string, any>;
  noWs?: boolean;
  dropWsFinal?: boolean;
}

export async function startFake(o: FakeOpts = {}) {
  const uploads: { name: string; bytes: number }[] = [];
  const submitted: { id: string; graph: any }[] = [];
  const history: Record<string, any> = {};
  const files = new Map<string, Buffer>();
  let running: string | null = null; const pending: string[] = [];
  const sockets = new Set<WebSocket>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const interrupted: string[] = [];
  const send = (m: unknown) => { for (const s of sockets) s.send(JSON.stringify(m)); };

  const finish = (id: string, graph: any, mode: 'ok' | 'execError') => {
    running = null;
    if (mode === 'execError') {
      history[id] = { outputs: {}, status: { status_str: 'error', messages: [['execution_error', { node_type: 'KSampler', exception_message: 'out of memory' }]] } };
      send({ type: 'execution_error', data: { prompt_id: id, node_type: 'KSampler', exception_message: 'out of memory' } });
    } else {
      history[id] = { outputs: (o.outputs ?? (() => ({})))(graph), status: { status_str: 'success', messages: [] } };
      if (!o.dropWsFinal) send({ type: 'execution_success', data: { prompt_id: id } });
    }
    next();
  };
  const start = (id: string) => {
    running = id; const g = submitted.find((s) => s.id === id)!.graph;
    const steps = 4;
    for (let i = 1; i <= steps; i++) setTimeout(() => { if (running === id) send({ type: 'progress', data: { prompt_id: id, value: i, max: steps, node: '1' } }); }, ((o.runMs ?? 60) / (steps + 1)) * i);
    const mode = (o.onPrompt?.(g, id) === 'execError') ? 'execError' : 'ok';
    timers.set(id, setTimeout(() => finish(id, g, mode), o.runMs ?? 60));
  };
  const next = () => { const n = pending.shift(); if (n) start(n); };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x');
    const body = await new Promise<Buffer>((r) => { const c: Buffer[] = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
    const json = (code: number, v: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    const p = url.pathname;
    if (p === '/system_stats') return json(200, { system: { comfyui_version: 'fake' }, devices: [] });
    if (p.startsWith('/object_info/')) {
      const c = decodeURIComponent(p.slice('/object_info/'.length));
      const loaders: Record<string, [string, string]> = { UNETLoader: ['unet', 'unet_name'], CLIPLoader: ['clip', 'clip_name'], VAELoader: ['vae', 'vae_name'] };
      if (o.missingNodes?.includes(c)) return json(200, {});
      if (loaders[c]) return json(200, { [c]: { input: { required: { [loaders[c][1]]: [o.models?.[loaders[c][0]] ?? []] } } } });
      return json(200, { [c]: { input: { required: {} } } });
    }
    if (p === '/upload/image' && req.method === 'POST') {
      const m = /name="image"; filename="([^"]+)"/.exec(body.toString('latin1'));
      uploads.push({ name: m?.[1] ?? '?', bytes: body.length });
      return json(200, { name: m?.[1] ?? '?', subfolder: '', type: 'input' });
    }
    if (p === '/prompt' && req.method === 'POST') {
      const b = JSON.parse(body.toString());
      const verdict = o.onPrompt?.(b.prompt, b.prompt_id) ?? 'ok';
      if (typeof verdict === 'object') return json(400, { error: { message: 'Prompt outputs failed validation' }, node_errors: verdict.nodeErrors });
      submitted.push({ id: b.prompt_id, graph: b.prompt });
      if (running) pending.push(b.prompt_id); else start(b.prompt_id);
      return json(200, { prompt_id: b.prompt_id, number: submitted.length, node_errors: {} });
    }
    if (p === '/queue' && req.method === 'GET') return json(200, { queue_running: running ? [[0, running]] : [], queue_pending: pending.map((x) => [0, x]) });
    if (p === '/queue' && req.method === 'POST') { for (const id of JSON.parse(body.toString()).delete ?? []) { const i = pending.indexOf(id); if (i >= 0) pending.splice(i, 1); } return json(200, {}); }
    if (p === '/interrupt') {
      const id = JSON.parse(body.toString()).prompt_id; interrupted.push(id);
      if (running === id) { clearTimeout(timers.get(id)); running = null; history[id] = { outputs: {}, status: { status_str: 'error', messages: [['execution_interrupted', {}]] } }; send({ type: 'execution_interrupted', data: { prompt_id: id } }); next(); }
      return json(200, {});
    }
    if (p.startsWith('/history/')) { const id = p.slice(9); return json(200, history[id] ? { [id]: history[id] } : {}); }
    if (p === '/view') { const f = files.get(url.searchParams.get('filename')!); if (!f) { res.writeHead(404); return res.end(); } res.writeHead(200); return res.end(f); }
    res.writeHead(404); res.end();
  });
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (s) => { if (o.noWs) return s.close(); sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`, uploads, submitted, interrupted, files, history,
    async close() { for (const s of sockets) s.terminate(); wss.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)); },
  };
}
