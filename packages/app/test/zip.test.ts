import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { crc32 } from 'node:zlib';
import { zipStore } from '../src/main/zip.ts';

test('zip: stored archive has every file with the right name, size and crc', async () => {
  const d = mkdtempSync(path.join(tmpdir(), 'zip-'));
  const a = path.join(d, 'a.bin'), b = path.join(d, 'b.txt');
  const da = Buffer.alloc(200_000, 7), db = Buffer.from('héllo wörld');
  writeFileSync(a, da); writeFileSync(b, db);
  const out = path.join(d, 'out.zip');
  await zipStore([{ name: 'first.bin', path: a }, { name: 'dir ünï.txt', path: b }], out);
  const z = readFileSync(out);
  const eocd = z.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.equal(z.readUInt16LE(eocd + 10), 2);
  let p = z.readUInt32LE(eocd + 16);
  const got: { name: string; data: Buffer; crc: number }[] = [];
  for (let i = 0; i < 2; i++) {
    assert.equal(z.readUInt32LE(p), 0x02014b50);
    const crc = z.readUInt32LE(p + 16), size = z.readUInt32LE(p + 20), nl = z.readUInt16LE(p + 28), off = z.readUInt32LE(p + 42);
    const name = z.subarray(p + 46, p + 46 + nl).toString('utf8');
    const lnl = z.readUInt16LE(off + 26), start = off + 30 + lnl;
    got.push({ name, data: z.subarray(start, start + size), crc });
    p += 46 + nl;
  }
  assert.deepEqual(got.map((g) => g.name), ['first.bin', 'dir ünï.txt']);
  assert.ok(got[0]!.data.equals(da)); assert.ok(got[1]!.data.equals(db));
  assert.equal(got[0]!.crc, crc32(da)); assert.equal(got[1]!.crc, crc32(db));
});
