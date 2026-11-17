import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySlots } from '../src/apply.ts';
import type { Profile } from '../src/manifest.ts';

const profile = (): Profile => ({
  manifest: { id: 'p', version: 1, title: 'p', workflow: 'w.json', kind: 'image', outputs: [{ id: 'o', type: 'image', node: '9' }],
    slots: [{ id: 'prompt', type: 'text', bind: [{ node: '1', input: 'value' }], required: true },
      { id: 'aspect', type: 'enum', bind: [{ node: '5', input: 'aspect_ratio' }], customSize: { node: '5' } },
      { id: 'megapixels', type: 'number', bind: [{ node: '5', input: 'megapixels' }] }] },
  workflow: { '1': { class_type: 'T', inputs: { value: '' } }, '5': { class_type: 'ResolutionSelector', inputs: { aspect_ratio: '1:1 (Square)', megapixels: 1, multiple: 32 } },
    '8': { class_type: 'Empty', inputs: { width: ['5', 0], height: ['5', 1] } }, '9': { class_type: 'Save', inputs: { images: ['8', 0] } } },
} as unknown as Profile);

test('custom size replaces the size node with numbers snapped to its multiple', () => {
  const a = applySlots(profile(), { prompt: 'x', aspect: '16:9', megapixels: 2, custom_width: 1000, custom_height: 563 });
  assert.equal(a.graph['5'], undefined);
  assert.deepEqual([a.graph['8']!.inputs.width, a.graph['8']!.inputs.height], [992, 576]);
  assert.throws(() => applySlots(profile(), { prompt: 'x', custom_width: 1000 }), /custom size/i);
  const b = applySlots(profile(), { prompt: 'x', aspect: '1:1 (Square)' });
  assert.ok(b.graph['5'] && Array.isArray(b.graph['8']!.inputs.width));
});
