import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { Project } from '../src/index.ts';

test('library trash, restore, bulk rename and tags are single undo steps', async () => {
  const p = await Project.create(path.join(mkdtempSync(path.join(os.tmpdir(), 'mld-')), 'p'), 't');
  const st = p.story;
  st.trashAssets(['a', 'b'], true);
  assert.ok(st.meta('a').trashed && st.meta('b').trashed);
  p.docs.undo(); assert.ok(!st.meta('a').trashed && !st.meta('b').trashed);
  st.renameMany([{ id: 'a', name: 'Dance 001' }, { id: 'b', name: 'Dance 002' }]);
  assert.equal(st.meta('b').name, 'Dance 002');
  st.tagMany(['a', 'b'], ['Hero']); assert.deepEqual(st.meta('a').tags, ['hero']);
  p.docs.undo(); assert.equal(st.meta('a').tags, undefined);
  p.close();
});

test('stories: scenes belong to a story, old scenes are adopted, delete is one undo step', async () => {
  const p = await Project.create(path.join(mkdtempSync(path.join(os.tmpdir(), 'mld-')), 'p'), 't');
  const st = p.story;
  const old = st.addScene('Old scene'); assert.ok(old.storyId);   // a first scene creates "Story 1"
  const a = st.addStory('Second'); const sc = st.addScene('B1', a.id); st.addShot(sc.id);
  assert.deepEqual(st.stories().map((x) => x.name), ['Story 1', 'Second']);
  assert.equal(st.tree(a.id).length, 1); assert.equal(st.tree(st.stories()[0]!.id).length, 1);
  st.renameStory(a.id, 'Dance'); assert.equal(st.story(a.id)!.name, 'Dance');
  st.removeStory(a.id); assert.equal(st.scenes().length, 1); assert.equal(st.shots().length, 0);
  p.docs.undo(); assert.equal(st.scenes().length, 2); assert.equal(st.shots().length, 1);
  p.close();
});
