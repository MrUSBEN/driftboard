import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { loadProfiles, applySlots, SlotError } from '../src/index.ts';

const ROOT = path.join(import.meta.dirname, '../../../profiles');
const profiles = await loadProfiles(ROOT);
const P = (id: string) => profiles.find((p) => p.manifest.id === id)!;

test('all shipped profiles load and match their workflows', () => {
  assert.deepEqual(profiles.map((p) => p.manifest.id), ['h3-image-edit', 'h3-video-i2v', 'h3-video-reference', 'h3-video-t2v', 'moss-image']);
});

test('video refs: 0, 1 and 9 images build valid graphs with no dangling links', () => {
  for (const n of [0, 1, 9]) {
    const { graph } = applySlots(P('h3-video-reference'), { prompt: 'x', seconds: 2, refs: Array.from({ length: n }, (_, i) => `img${i}.png`) });
    const inputs = graph['136']!.inputs;
    assert.equal(Object.keys(inputs).filter((k) => k.startsWith('ref_images.')).length, n);
    assert.equal(graph['150'], undefined);
    assert.equal(Object.values(graph).filter((x) => x._meta && JSON.stringify(x._meta).includes('Driftboard refs')).length, n);
  }
});

test('limits and types are enforced with clear messages', () => {
  const p = P('h3-video-reference');
  assert.throws(() => applySlots(p, { prompt: 'x', refs: Array(10).fill('a.png') }), /at most 9/);
  assert.throws(() => applySlots(p, { prompt: '' }), /prompt is required/);
  assert.throws(() => applySlots(p, { prompt: 'x', seconds: 1 }), /at least 2/);
  assert.throws(() => applySlots(p, { prompt: 'x', seconds: 99 }), /at most 15/);
  assert.throws(() => applySlots(p, { prompt: 'x', seed: 1.5 }), /whole number/);
  assert.throws(() => applySlots(p, { prompt: 'x', bogus: 1 }), /Unknown slot/);
  assert.throws(() => applySlots(p, { prompt: 'x', ref_videos: ['a.mp4', 'b.mp4', 'c.mp4', 'd.mp4'] }), /at most 3/);
});

test('seed: random when missing, kept when given; values returned for recording', () => {
  const p = P('h3-video-reference');
  const a = applySlots(p, { prompt: 'x' }), b = applySlots(p, { prompt: 'x' }), c = applySlots(p, { prompt: 'x', seed: 42 });
  assert.notEqual(a.values.seed, b.values.seed);
  assert.equal(c.graph['129']!.inputs.noise_seed, 42);
  assert.equal(a.graph['129']!.inputs.noise_seed, a.values.seed);
});

test('no profile needs NVIDIA-only nodes or has an upscale switch; each video profile returns one video', () => {
  for (const id of ['h3-video-i2v', 'h3-video-t2v', 'h3-video-reference']) {
    const p = P(id);
    assert.ok(!JSON.stringify(p.manifest).includes('RTX'), id); assert.ok(!p.manifest.slots.some((s) => s.id === 'upscale'), id);
    const a = applySlots(p, id === 'h3-video-i2v' ? { prompt: 'x', first_frame: 'f.png' } : { prompt: 'x' });
    assert.ok(!Object.values(a.graph).some((n) => n.class_type === 'RTXVideoSuperResolution'), id);
    assert.deepEqual(a.outputs.map((o) => o.id), ['video'], id);
  }
});

test('i2v: first frame binds, last frame adds a linked loader only when given', () => {
  const p = P('h3-video-i2v');
  assert.throws(() => applySlots(p, { prompt: 'x' }), /first_frame is required/);
  const a = applySlots(p, { prompt: 'x', first_frame: 'f.png' });
  assert.equal(a.graph['114']!.inputs.image, 'f.png');
  assert.equal(a.graph['105:104']!.inputs.last_frame, undefined);
  const b = applySlots(p, { prompt: 'x', first_frame: 'f.png', last_frame: 'l.png' });
  const link = b.graph['105:104']!.inputs.last_frame as [string, number];
  assert.equal(b.graph[link[0]]!.class_type, 'LoadImage'); assert.equal(b.graph[link[0]]!.inputs.image, 'l.png');
});

test('image edit: 1, 4 images; loaders keep the size links', () => {
  for (const n of [1, 4]) {
    const { graph } = applySlots(P('h3-image-edit'), { prompt: 'x', images: Array.from({ length: n }, (_, i) => `i${i}.png`) });
    const ks = Object.keys(graph['32']!.inputs).filter((k) => k.startsWith('images.'));
    assert.equal(ks.length, n);
    const l = graph['32']!.inputs[ks[0]!] as [string, number];
    const resize = graph[l[0]]!; assert.equal(resize.class_type, 'ResizeImageMaskNode'); assert.deepEqual(resize.inputs['resize_type.longer_size'], ['71', 0]);
    const load = graph[(resize.inputs.input as [string, number])[0]]!; assert.equal(load.class_type, 'LoadImage'); assert.equal(load.inputs.image, 'i0.png');
    assert.equal(Object.values(graph).filter((x) => x.class_type === 'LoadImage').length, n, 'the example loaders are gone');
    assert.ok(graph['71'], 'the shared size box stays');
  }
});

test('input workflow is not mutated', () => {
  const p = P('h3-video-reference');
  const before = JSON.stringify(p.workflow);
  applySlots(p, { prompt: 'x', refs: ['a.png'] });
  assert.equal(JSON.stringify(p.workflow), before);
});

test('moss text to image binds prompt, negative and size', () => {
  const { graph } = applySlots(P('moss-image'), { prompt: 'a cat', seed: 7, aspect: '16:9 (Widescreen)', megapixels: 0.5 });
  assert.equal(graph['4']!.inputs.text, 'a cat'); assert.equal(graph['16']!.inputs.seed, 7); assert.equal(graph['30']!.inputs.megapixels, 0.5);
});

test('SlotError is exported', () => { assert.ok(new SlotError('x') instanceof Error); });

test('director info and prompt guide come from the profile', () => {
  assert.deepEqual(P('h3-video-reference').manifest.director, { seconds: [3, 5, 8, 10, 12, 15], maxRefs: 9 });
  assert.match(P('h3-video-reference').guide, /\[Shot k\]/);               // the short guide on the prompt slot is the fallback
  assert.equal(P('moss-image').guide, '');
});

test('held frames: with no guide clip the graph is exactly the old one (both anchor nodes cut out, guider reads the reference node)', () => {
  const { graph } = applySlots(P('h3-video-reference'), { prompt: 'x' });
  for (const id of ['900', '901', '902', '903', '900_parts', '900_size', '900_count', '902_parts', '902_size', '902_count']) assert.equal(graph[id], undefined, id);
  assert.deepEqual(graph['126']!.inputs.conditioning, ['136', 0]);
});

test('held frames: a start guide is anchored at frame 0 with its sound, an end guide at minus its length, chained in order', () => {
  const { graph, values } = applySlots(P('h3-video-reference'), { prompt: 'x', guide_start: 'g.mp4', guide_start_frames: 39, guide_end: 'e.mp4', guide_end_frames: 22 });
  assert.equal(graph['900']!.class_type, 'LoadVideo'); assert.equal(graph['900']!.inputs.file, 'g.mp4'); assert.equal(graph['900_count']!.inputs.length, 39);
  assert.equal(graph['901']!.inputs.frame_idx, 0); assert.deepEqual(graph['901']!.inputs.image, ['900_count', 0]); assert.deepEqual(graph['901']!.inputs.audio, ['900_parts', 1]);
  assert.deepEqual(graph['900_size']!.inputs['resize_type.width'], ['115', 0]);                     // held frames are scaled to the film size
  assert.equal(graph['902']!.inputs.file, 'e.mp4'); assert.equal(graph['902_count']!.inputs.length, 22); assert.equal(graph['903']!.inputs.frame_idx, -22);
  assert.deepEqual(graph['903']!.inputs.positive, ['901', 0]); assert.deepEqual(graph['126']!.inputs.conditioning, ['903', 0]);
  assert.equal(values.guide_start, 'g.mp4');
});

test('held frames: only a start guide, or only an end guide, still gives a connected graph; sound can be left out', () => {
  const s = applySlots(P('h3-video-reference'), { prompt: 'x', guide_start: 'g.mp4', guide_audio: false }).graph;
  assert.equal(s['903'], undefined); assert.deepEqual(s['126']!.inputs.conditioning, ['901', 0]);
  assert.equal('audio' in s['901']!.inputs, false); assert.equal('audio_vae' in s['901']!.inputs, false);
  const e = applySlots(P('h3-video-reference'), { prompt: 'x', guide_end: 'e.mp4' }).graph;
  assert.equal(e['901'], undefined); assert.deepEqual(e['903']!.inputs.positive, ['136', 0]); assert.deepEqual(e['126']!.inputs.conditioning, ['903', 0]);
});

test('reference videos and audios: loaders are added with the clip sound on the paired input', () => {
  const { graph } = applySlots(P('h3-video-reference'), { prompt: 'x', ref_videos: ['v1.mp4', 'v2.mp4'], ref_audios: ['a1.wav'] });
  const i = graph['136']!.inputs;
  assert.ok(i['ref_videos.ref_video_0'] && i['ref_videos.ref_video_1'] && !i['ref_videos.ref_video_2']);
  const parts = (i['ref_videos.ref_video_1'] as [string, number])[0];
  assert.deepEqual(i['ref_videos.ref_video_1'], [parts, 0]); assert.deepEqual(i['ref_video_audios.ref_video_audio_1'], [parts, 1]);   // frames and sound from the same split
  assert.equal(graph[parts]!.class_type, 'GetVideoComponents');
  const load = graph[(graph[parts]!.inputs.video as [string, number])[0]]!; assert.equal(load.class_type, 'LoadVideo'); assert.equal(load.inputs.file, 'v2.mp4');
  const a = graph[(i['ref_audios.ref_audio_0'] as string[])[0]!]!; assert.equal(a.class_type, 'LoadAudio'); assert.equal(a.inputs.audio, 'a1.wav');
});

test('still pictures anchored at chosen frames: absent they vanish cleanly, present they chain after the clip guides', () => {
  const none = applySlots(P('h3-video-reference'), { prompt: 'x' }).graph;
  for (const id of ['904', '905', '906', '907']) assert.equal(none[id], undefined);
  assert.deepEqual(none['126']!.inputs.conditioning, ['136', 0]);
  const g = applySlots(P('h3-video-reference'), { prompt: 'x', guide_start: 'g.mp4', guide_still_a: 'a.png', guide_still_a_frame: -1, guide_still_b: 'b.png', guide_still_b_frame: 60 }).graph;
  assert.equal(g['904']!.inputs.image, 'a.png'); assert.equal(g['905']!.inputs.frame_idx, -1); assert.equal(g['907']!.inputs.frame_idx, 60);
  assert.deepEqual(g['905']!.inputs.positive, ['901', 0]); assert.deepEqual(g['907']!.inputs.positive, ['905', 0]); assert.deepEqual(g['126']!.inputs.conditioning, ['907', 0]);
  const onlyB = applySlots(P('h3-video-reference'), { prompt: 'x', guide_still_b: 'b.png' }).graph;
  assert.equal(onlyB['905'], undefined); assert.deepEqual(onlyB['907']!.inputs.positive, ['136', 0]);
});

test('stock ComfyUI: no profile needs a custom node pack; SageAttention is an optional bypass, off by default', () => {
  const custom = /^(VHS_|RTX|LoadAndResizeImage|PathchSageAttentionKJ)/;
  for (const id of ['h3-video-i2v', 'h3-video-t2v', 'h3-video-reference', 'h3-image-edit', 'moss-image']) {
    const p = P(id);
    assert.ok(!p.manifest.requires.nodeClasses.some((c) => custom.test(c)), `${id} requires ${p.manifest.requires.nodeClasses.join(', ')}`);
    const off = applySlots(p, id === 'h3-video-i2v' ? { prompt: 'x', first_frame: 'f.png' } : { prompt: 'x' }).graph;
    assert.ok(!Object.values(off).some((n) => custom.test(n.class_type)), `${id} still sends a custom node`);
  }
  const p = P('h3-video-reference');
  const sage = p.manifest.slots.find((s) => s.id === 'sage_attention')!;
  assert.equal(sage.type, 'boolean'); assert.deepEqual(sage.type === 'boolean' && sage.needsNodes, ['PathchSageAttentionKJ']);
  const off = applySlots(p, { prompt: 'x' }).graph;
  assert.deepEqual(off['124']!.inputs.model, ['127', 0]);                     // the sampler reads the model loader directly
  const on = applySlots(p, { prompt: 'x', sage_attention: true }).graph;
  assert.equal(on['165']!.class_type, 'PathchSageAttentionKJ'); assert.deepEqual(on['124']!.inputs.model, ['165', 0]);
});

test('video profiles default to the official H3 model files', () => {
  assert.deepEqual(P('h3-video-i2v').manifest.requires.models.unet, ['minimax_h3_fl2va_pruned_int8_convrot.safetensors']);
  assert.deepEqual(P('h3-video-reference').manifest.requires.models.unet, ['minimax_h3_ref2va_pruned_int8_convrot.safetensors']);
  for (const id of ['h3-video-i2v', 'h3-video-t2v', 'h3-video-reference']) {
    const unet = Object.values(P(id).workflow).find((n) => n.class_type === 'UNETLoader')!;
    assert.deepEqual([unet.inputs.unet_name], P(id).manifest.requires.models.unet, id);   // the workflow itself names the official file
  }
});
