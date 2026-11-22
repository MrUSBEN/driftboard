/* Send a clip or a picture to the manual Story from anywhere (canvas, Library, timeline cut): each one becomes a shot with it
   already picked, like any take you chose yourself. Prompts and references can be added afterwards if wanted. */
import { api, type Asset } from './shared.tsx';

export async function sendToStory(ids: string[], assets: Map<string, Asset>, nameOf: (a: Asset) => string): Promise<{ shots: number; error?: string }> {
  const list = ids.map((id) => assets.get(id)).filter((a): a is Asset => !!a && (a.kind === 'video' || a.kind === 'image'));
  if (!list.length) return { shots: 0, error: 'Pick a clip or a picture to send.' };
  let story = (await api.msOp('ensureStory')) as { id: string };
  try { const want = localStorage.getItem('driftboard.msStory'); const all = (await api.story()).ms.stories; if (want && all.some((s) => s.id === want)) story = { id: want }; } catch { /* the first story */ }
  let n = 0;
  for (const a of list) {
    const stage = a.kind === 'video' ? 'clip' : 'frame';
    const sh = (await api.msOp('addShot', story.id, nameOf(a))) as { id: string };
    await api.msOp('addExtra', sh.id, stage, a.id);
    await api.msOp('setPick', sh.id, stage, a.id);
    n++;
  }
  window.dispatchEvent(new CustomEvent('driftboard-open-panel', { detail: 'story' }));
  return { shots: n };
}
