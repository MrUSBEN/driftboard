import type { BlockUse, PromptBlock } from './shared.tsx';

/**
 * The film blocks one generation uses: the story's look, location, sound, music... each can be switched off or
 * changed for this shot only (or saved back to the story). The prompt box above is then just the action.
 */
export function BlocksPanel({ blocks, source, use, onUse, previous, onDropPrevious, onSaveToStory }: {
  blocks: PromptBlock[]; source: 'story' | 'project' | 'starter';
  use: BlockUse; onUse: (u: BlockUse) => void;
  previous?: string; onDropPrevious: () => void;
  onSaveToStory: (id: string, text: string) => void;
}) {
  const off = new Set(use.off ?? []);
  const textOf = (b: PromptBlock) => use.override?.[b.id] ?? b.text;
  const shown = blocks.filter((b) => textOf(b).trim());
  const inUse = shown.filter((b) => !off.has(b.id)).length;
  const setText = (id: string, t: string) => onUse({ ...use, override: { ...(use.override ?? {}), [id]: t } });
  const resetText = (id: string) => { const o = { ...(use.override ?? {}) }; delete o[id]; onUse({ ...use, override: o }); };
  const toggle = (id: string, on: boolean) => onUse({ ...use, off: on ? (use.off ?? []).filter((x) => x !== id) : [...(use.off ?? []), id] });
  return (
    <details className="blocks" open={inUse > 0 || !!previous}>
      <summary title="Decided once for the story; write only the action in the prompt box">
        Film blocks · {inUse ? `${inUse} in use` : 'none set'}{previous ? ' · continues the previous clip' : ''}
      </summary>
      {previous && (
        <div className="blockRow">
          <div className="row"><b style={{ flex: 1 }}>Previous clip's prompt</b><button className="ghost" title="Do not use the previous prompt" onClick={onDropPrevious}>×</button></div>
          <div className="note clamp">{previous}</div>
        </div>
      )}
      {shown.map((b) => {
        const changed = use.override?.[b.id] !== undefined && use.override[b.id] !== b.text;
        return (
          <div className={'blockRow' + (off.has(b.id) ? ' off' : '')} key={b.id}>
            <label className="row" style={{ color: 'var(--text)', margin: 0 }}><input type="checkbox" checked={!off.has(b.id)} onChange={(e) => toggle(b.id, e.target.checked)} /><b>{b.name}</b>{changed && <span className="note"> · changed for this shot</span>}</label>
            <textarea rows={2} value={textOf(b)} disabled={off.has(b.id)} onChange={(e) => setText(b.id, e.target.value)} />
            {changed && <div className="row"><button className="ghost" onClick={() => resetText(b.id)}>↺ story text</button><button className="ghost" title="Use this text for every shot of the story" onClick={() => { onSaveToStory(b.id, textOf(b)); resetText(b.id); }}>Save to story</button></div>}
          </div>
        );
      })}
      {!shown.length && <div className="note">No film blocks yet. Set the film look, location, sound and music once in the Story tab ({source === 'story' ? 'this story' : 'project default'}); every prompt then carries them.</div>}
    </details>
  );
}
