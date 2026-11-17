import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Write via temp file + fsync + rename so a crash never leaves a half-written file. */
export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID().slice(0, 8)}.tmp`);
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

/** Remove leftover temp files from a crash. Returns how many were removed. */
export async function cleanTemps(dir: string): Promise<number> {
  let n = 0;
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    if (name.endsWith('.tmp')) { await fs.rm(path.join(dir, name), { force: true }); n++; }
  }
  return n;
}
