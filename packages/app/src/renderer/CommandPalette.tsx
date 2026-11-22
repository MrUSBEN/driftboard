/* The command palette (Ctrl+K): one search box over actions that already exist elsewhere in the app,
   the stories, their shots, the library's files and the settings pages. It runs nothing of its own. */
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { C } from './shared.tsx';
import { Icon, type IconName } from './ui/Icon.tsx';
import { rankEntries, type PaletteEntry } from './palette.ts';
import { assetName } from './Canvas.tsx';
import { setTheme } from './theme/theme.ts';
import { requestExport } from './Timeline.tsx';
import { bindOf, hit } from './keys.ts';
import type { PanelId, SettingsPane } from './Shell.tsx';
import type { Asset } from '../main/api.ts';
import { requestLibraryView, requestStoryGoto } from './goto.ts';

export interface PaletteHost {
  setPanel: (p: PanelId | null) => void;
  openSettings: (p?: SettingsPane) => void;
  openProjects: () => void;
  openActivity: (t: 'jobs' | 'messages' | 'log') => void;
  focusAsset: (assetId: string) => void;
  /** asset ids selected on the canvas (the canvas actions act on them) */
  selectedAssets: string[];
}


const canvasAct = (a: string) => window.dispatchEvent(new CustomEvent('driftboard-canvas-act', { detail: a }));
const isTyping = (t: EventTarget | null) => { const el = t as HTMLElement | null; return !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable); };

/** Ctrl+K anywhere except while typing in a text field opens the palette. */
export function CommandPaletteHost(host: PaletteHost) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!hit(e, 'app.palette') || isTyping(e.target)) return;
      e.preventDefault(); setOpen((o) => !o);
    };
    const ev = () => setOpen(true);
    window.addEventListener('keydown', k); window.addEventListener('driftboard-palette', ev);
    return () => { window.removeEventListener('keydown', k); window.removeEventListener('driftboard-palette', ev); };
  }, []);
  return open ? <CommandPalette host={host} onClose={() => setOpen(false)} /> : null;
}
export const openPalette = () => window.dispatchEvent(new Event('driftboard-palette'));

type Entry = PaletteEntry & { icon: IconName; sub?: string };

function CommandPalette({ host, onClose }: { host: PaletteHost; onClose: () => void }) {
  const { story, assets } = useContext(C);
  const [q, setQ] = useState('');
  const [cur, setCur] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { const prev = document.activeElement as HTMLElement | null; input.current?.focus(); return () => prev?.focus?.(); }, []);

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    const add = (group: string, label: string, icon: IconName, run: () => void, keywords?: string, hint?: string, sub?: string) => out.push({ id: `${group}:${label}:${out.length}`, group, label, icon, run, keywords, hint, sub });
    // actions on what is selected on the canvas (the same ones its selection bar offers)
    const one = host.selectedAssets.length === 1 ? assets.get(host.selectedAssets[0]!) : undefined;
    if (one?.kind === 'video') {
      add('Actions', 'Continue the selected clip', 'cont', () => canvasAct('continueBest'), 'next shot');
      add('Actions', 'Add the selected clip to the timeline', 'film', () => canvasAct('addToTimeline'));
      add('Actions', 'Trim the selected clip…', 'trim', () => canvasAct('trim'), 'cut');
      add('Actions', 'Regenerate the selected clip…', 'regen', () => canvasAct('regenerate'), 'again');
    } else if (one?.kind === 'image') {
      add('Actions', 'Generate from the selected picture…', 'create', () => canvasAct('generate'), 'image to video');
      add('Actions', 'Crop the selected picture…', 'crop', () => canvasAct('crop'));
      add('Actions', 'Upscale the selected picture ×2', 'upscale', () => canvasAct('upscale'), 'bigger');
    }
    if (host.selectedAssets.length > 1) add('Actions', 'Check continuity of the selected clips…', 'chart', () => canvasAct('continuity'), 'drift');
    add('Actions', 'Create a picture or a clip', 'create', () => host.setPanel('create'), 'generate new');
    add('Actions', 'Export the film…', 'export', () => requestExport(), 'render mp4 timeline');
    add('Actions', 'Fit the canvas in view', 'fit', () => canvasAct('fitAll'), 'zoom all');
    add('Actions', 'Arrange the canvas by lineage', 'lineage', () => canvasAct('arrangeLineage'), 'tidy');
    add('Actions', 'Open the Story', 'story', () => host.setPanel('story'), 'script scenes shots');
    add('Actions', 'Open Auto (experimental: script, bible, board, shots, LLM director)', 'auto', () => host.setPanel('auto'), 'story director script bible board shots automatic');
    add('Actions', 'Ask the Assistant', 'assistant', () => host.setPanel('assistant'), 'chat llm');
    add('Actions', 'Open the Library', 'library', () => host.setPanel('library'), 'files assets');
    add('Actions', 'Open the Trash', 'trash', () => { requestLibraryView('trash'); host.setPanel('library'); }, 'deleted restore');
    add('Actions', 'Show running jobs', 'activity', () => host.openActivity('jobs'), 'queue activity');
    add('Actions', 'Show messages', 'bell', () => host.openActivity('messages'), 'notifications');
    add('Actions', 'Show the log', 'list', () => host.openActivity('log'), 'errors');
    // stories and their shots
    for (const s of story.stories) add('Stories', s.name || 'Untitled story', 'story', () => { requestStoryGoto(s.id); host.setPanel('auto'); }, 'story');
    const storyName = new Map(story.stories.map((s) => [s.id, s.name]));
    for (const t of story.all) for (const sh of t.shots) {
      const sid = t.scene.storyId;
      add('Shots', sh.name, 'scene', () => { if (sid) requestStoryGoto(sid, sh.id); host.setPanel('auto'); }, `${t.scene.name} ${sh.prompt ?? ''}`.slice(0, 300), undefined, [sid ? storyName.get(sid) : '', t.scene.name].filter(Boolean).join(' › '));
    }
    // files that are not in the Trash
    const files = [...assets.values()].filter((a) => !story.meta[a.id]?.trashed).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    const icon = (a: Asset): IconName => (a.kind === 'video' ? 'video' : a.kind === 'audio' ? 'sound' : 'image');
    for (const a of files) add('Files', assetName(a, story.meta), icon(a), () => host.focusAsset(a.id), `${a.original_name ?? ''} ${(story.meta[a.id]?.tags ?? []).join(' ')} ${a.kind === 'audio' ? 'sound' : a.kind}`, undefined, a.width ? `${a.width}×${a.height}` : undefined);
    // settings pages and the app
    const pages: [SettingsPane, string, IconName, string][] = [['comfy', 'ComfyUI', 'chip', 'server models profiles'], ['llm', 'LLM', 'llm', 'lm studio ollama model'], ['guides', 'Guides', 'story', 'prompt guide'], ['keys', 'Keyboard', 'keyboard', 'shortcuts keys'], ['look', 'Appearance', 'sun', 'theme dark light']];
    for (const [p, l, i, k] of pages) add('Settings', `Settings › ${l}`, i, () => host.openSettings(p), k);
    add('App', 'Projects…', 'folder', host.openProjects, 'open switch new project');
    add('App', 'Theme: light', 'sun', () => setTheme('light'));
    add('App', 'Theme: dark', 'moon', () => setTheme('dark'), 'night');
    add('App', 'Theme: follow Windows', 'monitor', () => setTheme('system'), 'system auto');
    return out;
  }, [story, assets, host]);

  const groups = useMemo(() => rankEntries(entries, q, q ? 8 : 6), [entries, q]);
  const flat = groups.flatMap((g) => g.items);
  useEffect(() => { setCur(0); }, [q]);
  useEffect(() => { list.current?.querySelector('.mi.act')?.scrollIntoView({ block: 'nearest' }); }, [cur]);
  const run = (e: Entry | undefined) => { if (!e) return; onClose(); setTimeout(e.run, 0); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCur((c) => (flat.length ? (c + 1) % flat.length : 0)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCur((c) => (flat.length ? (c - 1 + flat.length) % flat.length : 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); run(flat[cur]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
  };
  let n = -1;
  return createPortal(
    <div className="dscrim cmdkScrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKey}>
        <div className="q"><Icon name="search" />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type an action, a shot, a story or a file name" aria-label="Search actions, stories, shots, files and settings" role="combobox" aria-expanded="true" aria-controls="cmdkList" aria-activedescendant={flat[cur] ? `cmdk-${cur}` : undefined} />
          <span className="kbd">Esc</span>
        </div>
        <div className="res dmenu" id="cmdkList" role="listbox" ref={list}>
          {groups.map((g) => <div key={g.group} role="group" aria-label={g.group}>
            <div className="mh">{g.group}</div>
            {g.items.map((it) => { n++; const i = n; return (
              <div key={it.id} id={`cmdk-${i}`} role="option" aria-selected={i === cur} className={'mi' + (i === cur ? ' act' : '')} onMouseMove={() => { if (cur !== i) setCur(i); }} onClick={() => run(it)}>
                <Icon name={it.icon} /><span className="mt">{it.label}{it.sub && <span className="sub2">{it.sub}</span>}</span>{it.hint && <span className="hk">{it.hint}</span>}
              </div>); })}
          </div>)}
          {!flat.length && <div className="mh">Nothing found. Try another word.</div>}
        </div>
        <div className="cmdkFoot xs dim"><span><span className="kbd">↑</span> <span className="kbd">↓</span> choose</span><span><span className="kbd">Enter</span> run</span><span><span className="kbd">{bindOf('app.palette')}</span> open or close</span></div>
      </div>
    </div>, document.body);
}
