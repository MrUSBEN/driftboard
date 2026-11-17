import { useState } from 'react';
import type { BlockUse, PromptBlock } from './shared.tsx';
import { Icon } from './ui/Icon.tsx';
import { Button, Chip, IconButton } from './ui/ui.tsx';

/**
 * The film blocks one generation uses: the story's look, location, sound, music... Each is a toggle chip; Edit changes one
 * for this clip only (↺ Story text puts it back, Save to story keeps the change for every shot). The prompt box is then just the action.
 */
export function BlocksPanel({ blocks, source, use, onUse, onSaveToStory, storyName }: {
  blocks: PromptBlock[]; source: 'story' | 'project' | 'starter';
  use: BlockUse; onUse: (u: BlockUse) => void;
  onSaveToStory: (id: string, text: string) => void; storyName?: string;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const off = new Set(use.off ?? []);
  const textOf = (b: PromptBlock) => use.override?.[b.id] ?? b.text;
  const shown = blocks.filter((b) => textOf(b).trim());
  const inUse = shown.filter((b) => !off.has(b.id)).length;
  const setText = (id: string, t: string) => onUse({ ...use, override: { ...(use.override ?? {}), [id]: t } });
  const resetText = (id: string) => { const o = { ...(use.override ?? {}) }; delete o[id]; onUse({ ...use, override: o }); };
  const toggle = (id: string, on: boolean) => onUse({ ...use, off: on ? (use.off ?? []).filter((x) => x !== id) : [...(use.off ?? []), id] });
  const changed = (b: PromptBlock) => use.override?.[b.id] !== undefined && use.override[b.id] !== b.text;
  const ed = shown.find((b) => b.id === editing);
  const from = source === 'story' ? `from “${storyName ?? 'this story'}”` : source === 'project' ? 'project default' : 'starter set';
  if (!shown.length) return <span className="xs faint">No film blocks yet. Set the film look, location, sound and music once in Story (the story's Bible); every prompt then carries them.</span>;
  return (
    <div className="blocks">
      <span className="lbl">Film blocks <span className="xs faint">· {from} · {inUse} on</span></span>
      <div className="row wrap" style={{ gap: 5 }}>
        {shown.map((b) => <Chip key={b.id} on={!off.has(b.id)} icon={!off.has(b.id) ? 'check' : undefined} title={textOf(b)} onClick={() => toggle(b.id, off.has(b.id))}>{b.name}{changed(b) ? ' ·' : ''}</Chip>)}
        <Chip icon="pencil" onClick={() => setEditing(editing ? null : shown.find((b) => !off.has(b.id))?.id ?? shown[0]!.id)} title="Change a block for this generation only">Edit…</Chip>
      </div>
      {ed && (
        <div className="dcard" style={{ padding: 9, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="row">
            <select className="selc" style={{ width: 'auto', height: 28 }} aria-label="Block to change" value={ed.id} onChange={(e) => setEditing(e.target.value)}>{shown.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
            {changed(ed) && <span className="chip warn">changed for this clip</span>}
            <span className="sp" /><IconButton size="sm" icon="x" label="Close" onClick={() => setEditing(null)} />
          </div>
          <textarea className="ta" style={{ minHeight: 56 }} aria-label={`${ed.name} for this clip`} value={textOf(ed)} disabled={off.has(ed.id)} onChange={(e) => setText(ed.id, e.target.value)} />
          {off.has(ed.id) && <span className="xs faint">This block is off for this clip: click its chip to use it.</span>}
          <div className="row">
            <Button size="sm" kind="quiet" icon="restore" disabled={!changed(ed)} onClick={() => resetText(ed.id)}>Story text</Button>
            <span className="sp" />
            <Button size="sm" disabled={!changed(ed)} title="Use this text for every shot of the story" onClick={() => { onSaveToStory(ed.id, textOf(ed)); resetText(ed.id); }}><Icon name="check" size="s" />Save to story</Button>
          </div>
        </div>
      )}
    </div>
  );
}
