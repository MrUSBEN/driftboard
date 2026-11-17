// Child process for the kill test: does real work, then dies hard mid-operation.
import { writeFileSync, writeSync } from 'node:fs';
import * as path from 'node:path';
import { Project } from '../src/index.ts';

const dir = process.argv[2]!;
const p = await Project.open(dir);
const src = path.join(dir, 'in.png');
writeFileSync(src, 'fake image bytes');
const a = await p.assets.importFile(src);
p.docs.set('board', 'main', { nodes: [{ id: 'n1', asset: a.id }] }, 'Add node');        // committed
const j = p.jobs.create({ kind: 'generate', params: { seed: 1 }, inputs: [{ assetId: a.id, role: 'first_frame' }] });
p.jobs.transition(j.id, 'running');                                                         // committed, never finished
// half-written asset copy and an open transaction, then hard kill
writeFileSync(path.join(dir, 'assets', 'zz.partial.tmp'), 'half');
p.db.exec('BEGIN IMMEDIATE');
p.db.run("INSERT INTO docs (collection, id, json) VALUES ('board','uncommitted','{}')");
writeSync(1, 'READY\n');
process.kill(process.pid, 'SIGKILL');
