import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

export const tmpDir = () => mkdtemp(path.join(tmpdir(), 'driftboard-test-'));
export async function sampleFile(dir: string, name: string, content: string | Uint8Array) {
  const p = path.join(dir, name);
  await writeFile(p, content);
  return p;
}
