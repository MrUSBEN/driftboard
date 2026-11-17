import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaOpArgs } from '../src/index.ts';

test('mediaOpArgs: resize, crop, trim, upscale build the right filters and reject bad input', () => {
  assert.equal(mediaOpArgs({ op: 'resize', width: 1280 }, 'image', {}).vf, 'scale=1280:-2:flags=lanczos');
  assert.equal(mediaOpArgs({ op: 'resize', scale: 0.5 }, 'video', { width: 1056, height: 608 }).vf, 'scale=528:304:flags=lanczos');
  assert.match(mediaOpArgs({ op: 'crop', aspect: '16:9' }, 'video', {}).vf!, /^crop=/);
  assert.equal(mediaOpArgs({ op: 'crop', x: 10, y: 20, w: 100, h: 50 }, 'image', {}).vf, 'crop=100:50:10:20');
  assert.deepEqual(mediaOpArgs({ op: 'trim', start: 1, end: 3 }, 'video', {}).pre, ['-ss', '1', '-to', '3']);
  assert.equal(mediaOpArgs({ op: 'upscale' }, 'image', {}).vf, 'scale=iw*2:ih*2:flags=lanczos');
  assert.throws(() => mediaOpArgs({ op: 'trim', start: 3, end: 1 }, 'video', {}));
  assert.throws(() => mediaOpArgs({ op: 'trim', start: 0, end: 1 }, 'image', {}));
  assert.throws(() => mediaOpArgs({ op: 'crop', aspect: 'wide' }, 'image', {}));
  assert.throws(() => mediaOpArgs({ op: 'upscale', factor: 9 }, 'image', {}));
});

test('mediaOpArgs: upscale to a size in megapixels keeps the ratio and refuses pictures that are already big enough', () => {
  assert.equal(mediaOpArgs({ op: 'upscale', toMp: 1 }, 'image', { width: 640, height: 360 }).vf, 'scale=1334:750:flags=lanczos');   // 16:9 at ~1 MP
  assert.throws(() => mediaOpArgs({ op: 'upscale', toMp: 1 }, 'image', { width: 1920, height: 1080 }), /already/);
  assert.throws(() => mediaOpArgs({ op: 'upscale', toMp: 1 }, 'image', {}), /not known/);
  assert.throws(() => mediaOpArgs({ op: 'upscale', toMp: 40 }, 'image', { width: 64, height: 64 }));
});
