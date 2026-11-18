import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchScore, rankEntries, type PaletteEntry } from '../src/renderer/palette.ts';

const e = (group: string, label: string, keywords?: string): PaletteEntry => ({ id: group + label, group, label, keywords, run: () => {} });

test('matchScore: every word must fit, word starts beat inside-word hits', () => {
  assert.ok(matchScore('run all', e('Actions', 'Run all shots')) > 0);
  assert.equal(matchScore('run zebra', e('Actions', 'Run all shots')), 0);
  assert.ok(matchScore('exp', e('Actions', 'Export the film…')) > matchScore('exp', e('Files', 'An experiment.png')) - 1);
  assert.ok(matchScore('boat', e('Shots', 'The boat')) > matchScore('oat', e('Shots', 'The boat')));
  assert.equal(matchScore('', e('App', 'Anything')), 1);
});

test('matchScore: case and accents do not matter, keywords count, short queries stay strict', () => {
  assert.ok(matchScore('CAFE', e('Files', 'Café scene.png')) > 0);
  assert.ok(matchScore('comfy', e('Settings', 'Settings › ComfyUI')) > 0);
  assert.ok(matchScore('dark', e('App', 'Theme: night', 'dark mode')) > 0);
  assert.equal(matchScore('xq', e('Actions', 'Export the film')), 0);
  assert.ok(matchScore('rnal', e('Actions', 'Run all shots')) > 0, 'letters in order');
  assert.equal(matchScore('trash', e('Actions', 'Open the Story workspace')), 0, 'letters scattered over many words do not count');
  assert.equal(matchScore('trash', e('Shots', 'Shot 2', 'a tall ship rides the waves at sunset')), 0, 'keywords need the word itself');
  assert.ok(matchScore('sunset', e('Shots', 'Shot 2', 'a tall ship rides the waves at sunset')) > 0);
});

test('rankEntries: groups ordered, best first, capped, empty groups dropped', () => {
  const all = [e('Files', 'boat.png'), e('Shots', 'The boat'), e('Actions', 'Open Story'), e('Shots', 'Boat at dawn'), e('Settings', 'Settings › LLM')];
  const r = rankEntries(all, 'boat');
  assert.deepEqual(r.map((g) => g.group).sort(), ['Files', 'Shots']);
  assert.equal(r.find((g) => g.group === 'Shots')!.items[0]!.label, 'Boat at dawn', 'a label that starts with the query wins');
  const many = Array.from({ length: 20 }, (_, i) => e('Files', `clip ${i}.mp4`));
  assert.equal(rankEntries(many, 'clip', 5)[0]!.items.length, 5);
  assert.equal(rankEntries(all, 'nothing like this').length, 0);
  assert.deepEqual(rankEntries(all, '').map((g) => g.group), ['Actions', 'Shots', 'Files', 'Settings']);
  // with a query, the group with the best hit comes first
  const mixed = [e('Stories', 'Smoke story'), e('Settings', 'Settings › LLM'), e('Actions', 'Ask the Assistant')];
  assert.equal(rankEntries(mixed, 'set')[0]!.group, 'Settings');
});
