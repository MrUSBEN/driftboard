import { useCallback, useEffect, useState } from 'react';
import { api, type PromptBlock } from './shared.tsx';
import { directorNow, updDirector } from './directorStore.ts';

/**
 * The story's film blocks: written once (film look, location, characters, camera, sound, music, language...) and
 * carried into every prompt of the story. A story uses the project's default set until it is given its own.
 */
export function FilmBlocksCard({ storyId, notify, open }: { storyId: string; notify: (m: string) => void; open?: boolean }) {
  const [sb, setSb] = useState<{ blocks: PromptBlock[]; source: 'story' | 'project' | 'starter' } | null>(null);
  const [draft, setDraft] = useState<PromptBlock[]>([]);
  const load = useCallback(async () => { const b = await api.storyBlocks(storyId); setSb(b); setDraft(b.blocks); }, [storyId]);
  // other changes (undo, Save to story from the Generate form) refresh the card, but never throw away text being typed
  useEffect(() => {
    void load();
    return api.onBoard(() => void api.storyBlocks(storyId).then((b) => {
      setSb((prev) => { setDraft((d) => (prev && JSON.stringify(d) !== JSON.stringify(prev.blocks) ? d : b.blocks)); return b; });
    }));
  }, [load, storyId]);
  if (!sb) return null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(sb.blocks);
  const set = (i: number, patch: Partial<PromptBlock>) => setDraft(draft.map((b, k) => (k === i ? { ...b, ...patch } : b)));
  const used = sb.blocks.filter((b) => b.text.trim()).length;
  const save = async (scope: string) => {
    await api.storySetBlocks(scope, draft); await load();
    // the Film look is also the bible's style (reference pictures and shot planning use it): keep the two the same
    const look = draft.find((b) => b.id === 'look')?.text.trim(); const st = directorNow();
    if (look && st?.bible && st.storyId === storyId && look !== st.bible.style.trim()) await updDirector({ bible: { ...st.bible, style: look } });
    notify(scope === 'project' ? 'Saved as the project default' : 'Film blocks saved for this story');
  };

  return (
    <details className="card filmBlocks" open={open}>
      <summary><b>Film blocks</b> <span className="note">· {used} in use · {sb.source === 'story' ? 'this story\'s own' : 'project default'}</span></summary>
      <div className="note">Decided once, carried into every shot prompt (Shots › Write prompts, and the Generate form). Writing the bible fills the Film look, which is also the style of the reference pictures. Empty blocks are not used.</div>
      {draft.map((b, i) => (
        <div className="blockRow" key={i}>
          <div className="row">
            <input type="text" value={b.name} style={{ flex: 1 }} onChange={(e) => set(i, { name: e.target.value })} />
            <button className="ghost" title="Remove this block" onClick={() => setDraft(draft.filter((_, k) => k !== i))}>×</button>
          </div>
          <textarea rows={2} value={b.text} placeholder={PLACEHOLDER[b.id] ?? 'What every shot should keep'} onChange={(e) => set(i, { text: e.target.value })} />
        </div>
      ))}
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="ghost" onClick={() => setDraft([...draft, { id: '', name: 'New block', text: '' }])}>+ Block</button>
        <span className="sp" />
        <button className="primary-sm" disabled={!dirty} onClick={() => void save(storyId)}>Save for this story</button>
        <button disabled={!dirty && sb.source !== 'story'} title="Every story without its own blocks uses these" onClick={() => void save('project')}>Save as project default</button>
        {sb.source === 'story' && <button className="ghost" title="Drop this story's own blocks and use the project default" onClick={async () => { await api.storyClearBlocks(storyId); await load(); notify('This story uses the project default again (Ctrl+Z to undo)'); }}>Use project default</button>}
        {dirty && <button className="ghost" onClick={() => setDraft(sb.blocks)}>Undo changes</button>}
      </div>
    </details>
  );
}

const PLACEHOLDER: Record<string, string> = {
  look: 'e.g. shot on 35mm film, warm dusk light, soft grain, muted teal and amber',
  place: 'e.g. a narrow harbour street with wet cobblestones and fishing boats',
  characters: 'e.g. Mara: woman in her 30s, short black hair, yellow raincoat',
  camera: 'e.g. handheld, close and intimate, slow push-ins',
  sound: 'e.g. steady rain, distant gulls, creaking ropes',
  music: 'e.g. a slow solo piano theme, sparse and melancholic',
  language: 'e.g. all dialogue in English, quiet and natural',
};
