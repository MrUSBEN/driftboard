import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createDriftboardEditor, getState, getModel, syncAssets, usage as usageOf, type EditorStoreApi, type EditorState, type EditorModel } from '@driftboard/editor';
import { api, type Asset } from './shared.tsx';

export const EditorCtx = createContext<EditorStoreApi | null>(null);
export const useStore = () => useContext(EditorCtx)!;

/** Re-render when anything in the editor state changes. */
export function useEditorState(): EditorState {
  const store = useStore();
  return useSyncExternalStore((cb) => store.subscribe(cb), () => store.getState().state);
}

/** Create the editor for the open project, load its saved model, and save changes back (debounced). */
export function useEditor(projectKey: string | null, assets: Asset[]): EditorStoreApi | null {
  const [store, setStore] = useState<EditorStoreApi | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!projectKey) { setStore(null); return; }
    let cancelled = false, unsub = () => {};
    void (async () => {
      let model: EditorModel | undefined;
      try { const raw = await api.timelineLoad(); if (raw) model = JSON.parse(raw) as EditorModel; } catch { /* start fresh */ }
      if (cancelled) return;
      const s = createDriftboardEditor(model);
      let last = getModel(s);
      unsub = s.subscribe(() => {
        const m = getModel(s);
        if (m === last) return;
        last = m; clearTimeout(timer.current);
        timer.current = setTimeout(() => { void api.timelineSave(JSON.stringify(m)); }, 700);
      });
      setStore(s);
    })();
    return () => { cancelled = true; unsub(); clearTimeout(timer.current); };
  }, [projectKey]);

  useEffect(() => { if (store) syncAssets(store, assets); }, [store, assets]);
  return store;
}

export { getState };

/** Which assets the timeline uses. Only recomputes when the editor model itself changes (not on playhead moves). */
export function useUsage(store: EditorStoreApi | null): Map<string, number> {
  const model = useSyncExternalStore(
    (cb) => (store ? store.subscribe(cb) : () => {}),
    () => (store ? getModel(store) : null),
  );
  return useMemo(() => (model ? usageOf(model) : new Map<string, number>()), [model]);
}

/** Tell the editor about assets made since it last looked (e.g. a colour-matched copy) so a clip can be swapped for one. */
export async function syncEditorAssets(store: EditorStoreApi) { syncAssets(store, (await window.driftboard.assets()) as never); }

/** Assets to put on the timeline: clips made with held frames are swapped for their trimmed copy, and the editor is told about any new copy first. */
export async function joinForTimeline(store: EditorStoreApi, ids: string[]): Promise<string[]> {
  const out = await window.driftboard.joinAssets(ids);
  if (out.some((x, i) => x !== ids[i])) syncAssets(store, (await window.driftboard.assets()) as never);
  return out;
}
