// Shared between main, preload and renderer (types only).
import type { DirectorState, Progress as DirectorProgress, Step as DirectorStep } from '@driftboard/director';
import type { Asset, Job, IoRef, BoardItem, BoardEdge, LineageEdge, SceneTree, AssetMeta, BoardViewPos, Shot, BibleData, PromptBlock } from '@driftboard/core';
import type { Manifest } from '@driftboard/profiles';
import type { LlmSettings } from './llmHub.ts';
import type { ChatMsg, Proposal, Frame, Storyboard } from './llmApi.ts';

export type { Asset, Job, IoRef, Manifest, BoardItem, BoardEdge, LineageEdge, SceneTree, AssetMeta, BoardViewPos, Shot, BibleData, PromptBlock };
export interface ProjectView { dir: string; name: string }
export interface JobView extends Job { inputs: IoRef[]; outputs: IoRef[] }
export interface BoardView { items: BoardItem[]; edges: BoardEdge[]; lineage: LineageEdge[]; views: BoardViewPos[]; canUndo: boolean; canRedo: boolean; undoLabel?: string; redoLabel?: string }
export interface StoryCard { id: string; name: string; created: string; scenes: number; shots: number; takes: number; picked: number }
export interface StoryView { /** the open story's scenes */ tree: SceneTree[]; /** every scene of every story */ all: SceneTree[]; stories: StoryCard[]; activeId: string | null; meta: Record<string, AssetMeta>; tags: { tag: string; count: number }[]; bible?: BibleData }
export type { DirectorState, DirectorProgress, DirectorStep };
export interface DirectorRunCard { id: string; name: string; ts: number; summary: string }
export type { LlmSettings, ChatMsg, Proposal, Frame, Storyboard };
type Batch<T> = Promise<{ ok: true; value: T } | { ok: false; error: string }>;
export interface LlmStatus { ok: boolean; /** what the server can do: LM Studio and Ollama load/unload, others only chat */ caps?: import('@driftboard/adapter-llm').BackendCaps; url: string; model: string; models: { id: string; loaded: boolean; embedding: boolean; context?: number; maxContext?: number; reasoning?: string[] }[]; error?: string }
export interface GuideInfo { id: string; title: string; custom: boolean; body: string; durationLine?: string }
/** One clip of an analysis: what is wrong with it (problems: drift, start, join, soft) and the measurements. */
export interface DriftRow { index: number; assetId: string; problems: ('drift' | 'start' | 'join' | 'soft' | 'audio' | 'flash')[]; flashes?: { from: number; to: number; peak: number }[]; /** set when the clip is a timeline copy made by the older join fix (Remake fixes it) */ oldJoin?: string; flags: string[]; audioJumpDb?: number; brightnessPct: number; saturationPct: number; startShiftPct?: number; seamBrightness?: number; seamColor?: number; seamSharpness?: number }
export interface EnhanceInput { n: number; tag?: 'Picture' | 'Video' | 'Audio'; role: string; name?: string }
export type { LlmTaskRec as LlmTask } from './llmHub.ts';
import type { LlmTaskRec as LlmTask } from './llmHub.ts';
export interface LlmProgress { running: boolean; done: number; total: number; label: string }
export interface DirectorTarget { id: string; title: string; seconds: number[]; maxRefs: number; maxAudioRefs?: number; maxVideoRefs?: number; firstFrame?: boolean; lastFrame?: boolean }
export type StoryOp = 'addStory' | 'renameStory' | 'removeStory' | 'addScene' | 'updateScene' | 'removeScene' | 'moveScene' | 'addShot' | 'updateShot' | 'removeShot' | 'moveShot' | 'addTake' | 'removeTake' | 'setTakeStatus' | 'setTakeNote' | 'setPick' | 'setMeta' | 'addTag' | 'removeTag' | 'renameMany' | 'tagMany';
export interface AppApi {
  board(): Promise<BoardView>;
  boardPlace(changes: { id: string; x: number; y: number; w?: number; h?: number }[]): Promise<void>;
  boardAddNote(x: number, y: number): Promise<void>;
  boardAddGroup(x: number, y: number, w?: number, h?: number): Promise<void>;
  boardAddAssets(assetIds: string[], x: number, y: number): Promise<void>;
  boardRemove(ids: string[]): Promise<void>;
  libraryTrash(ids: string[], on: boolean): Promise<void>;
  libraryPurge(ids: string[]): Promise<{ deleted: number; kept: number }>;
  boardConnect(from: string, to: string, slot?: string): Promise<void>;
  boardDisconnect(edgeId: string): Promise<void>;
  boardUpdate(id: string, patch: Record<string, unknown>): Promise<void>;
  boardUndo(): Promise<void>;
  boardRedo(): Promise<void>;
  /** Import files by path (drag from Explorer) and put them on the board. */
  boardImportPaths(paths: string[], x: number, y: number): Promise<void>;
  pathFor(file: File): string;
  llmStatus(): Promise<LlmStatus>;
  llmSettings(): Promise<LlmSettings>;
  llmSet(patch: Partial<Omit<LlmSettings, 'thinking'>> & { thinking?: Partial<LlmSettings['thinking']> }): Promise<void>;
  guides(): Promise<GuideInfo[]>;
  guideSave(id: string, body: string): Promise<void>;
  guideReset(id: string): Promise<void>;
  /** Turn an idea into a prompt with the profile's guide. */
  llmEnhance(req: { profileId: string; idea: string; seconds?: number; inputs?: EnhanceInput[]; kind?: 'continue' | 'bridge'; blocks?: PromptBlock[]; previousPrompt?: string }): Promise<{ ok: true; prompt: string; warnings: string[] } | { ok: false; error: string }>;
  /** Write prompts for story shots as one LLM batch (the model is freed afterwards if the setting says so). */
  llmWritePrompts(shotIds: string[], profileId: string, force?: boolean): Promise<{ ok: true; written: number; failed: string[]; cancelled: boolean } | { ok: false; error: string }>;
  llmCancel(): Promise<void>;
  llmReadLook(assetId: string, kind: 'character' | 'place' | 'prop'): Promise<{ ok: true; look: string } | { ok: false; error: string }>;
  llmTasks(): Promise<LlmTask[]>;
  onLlmTasks(cb: (t: LlmTask[]) => void): () => void;
  onLlmProgress(cb: (p: LlmProgress) => void): () => void;
  chatState(): Promise<ChatMsg[]>;
  chatSend(text: string, action?: string, assetIds?: string[]): Promise<{ ok: true; messages: ChatMsg[] } | { ok: false; error: string }>;
  chatClear(): Promise<void>;
  chatToNote(text: string): Promise<void>;
  llmUnload(): Promise<number>;
  llmDistil(text: string, kind: 'image' | 'video'): Promise<{ ok: true; prompt: string } | { ok: false; error: string }>;
  sbGet(): Promise<Storyboard>;
  sbSet(sb: Storyboard): Promise<void>;
  sbDescribe(ids?: string[], force?: boolean): Batch<{ done: number; failed: string[] }>;
  sbStory(): Batch<{ filled: number }>;
  sbPrompts(ids: string[] | undefined, profileId: string, force?: boolean): Batch<{ written: number; failed: string[] }>;
  sbToStory(sceneName?: string): Promise<{ shots: number }>;
  promptsToStory(list: string[], sceneName?: string, withFrames?: boolean): Promise<{ shots: number }>;
  blobGet(key: string): Promise<string | null>;
  blobSet(key: string, json: string): Promise<void>;
  directorState(): Promise<{ state: DirectorState; targets: DirectorTarget[] }>;
  directorSetScript(text: string, style?: string): Promise<DirectorState>;
  directorSetTarget(id: string): Promise<void>;
  directorUpdate(patch: Partial<Pick<DirectorState, 'bible' | 'scenes' | 'shots' | 'prompts' | 'style' | 'accepted' | 'name' | 'storyId' | 'maxPart'>>): Promise<DirectorState>;
  directorRun(step: DirectorStep, opts?: { only?: string | string[]; force?: boolean }): Promise<{ ok: true; state: DirectorState } | { ok: false; error: string }>;
  directorCancel(): Promise<void>;
  directorAccept(): Promise<{ scenesAdded: number; shotsAdded: number; shotsUpdated: number }>;
  directorImportFile(): Promise<string | null>;
  onDirectorProgress(cb: (p: DirectorProgress) => void): () => void;
  story(): Promise<StoryView>;
  storyActive(id: string | null): Promise<void>;
  llmName(kind: string, text: string): Promise<string | null>;
  directorInterpret(text: string): Promise<{ ok: true; state: DirectorState } | { ok: false; error: string }>;
  directorSetInterpreted(text: string): Promise<DirectorState>;
  directorUseInterpreted(): Promise<DirectorState>;
  directorMissing(source: string, interpreted: string): Promise<{ speaker: string; line: string; saidBy?: string }[]>;
  directorRuns(): Promise<{ activeId: string | null; runs: DirectorRunCard[] }>;
  directorNewRun(): Promise<DirectorState>;
  directorOpenRun(id: string): Promise<DirectorState>;
  directorBack(): Promise<void>;
  directorRunEdit(id: string, patch: { name?: string; remove?: boolean }): Promise<DirectorRunCard[]>;
  directorClearAll(): Promise<DirectorState>;
  storyOp(op: StoryOp, ...args: unknown[]): Promise<unknown>;
  boardArrange(): Promise<{ moved: number; scenes: number }>;
  viewSave(name: string, x: number, y: number, zoom: number): Promise<void>;
  viewDelete(id: string): Promise<void>;
  timelineLoad(): Promise<string | null>;
  timelineSave(json: string): Promise<void>;
  /** Render the timeline plan (file fields hold asset ids) to an mp4 the user picks. */
  exportTimeline(plan: unknown, opts?: { name?: string; ask?: boolean; dir?: string }): Promise<{ ok: true; path: string } | { ok: false; error: string; cancelled?: boolean }>;
  exportCancel(): Promise<void>;
  reveal(path: string): Promise<void>;
  exportsDir(): Promise<string>;
  assetReveal(id: string): Promise<void>;
  assetsDownload(ids: string[]): Promise<{ ok: true; path: string; count: number } | { ok: false; error: string; cancelled?: boolean }>;
  onExportProgress(cb: (fraction: number) => void): () => void;
  /** Start a job from the Generate tab. Image slots hold asset ids. */
  generate(profileId: string, values: Record<string, unknown>, originItemId?: string, shotId?: string, opts?: { ignoreWarnings?: boolean }): Promise<{ ok: true; job: JobView } | { ok: false; error: string }>;
  /** A part that continues the shot before it as the same take: starts from that shot's take now (useExisting and it has one) or as soon as its next take arrives. */
  /** Make a shot's storyboard frame (it becomes the shot's first frame when done); `after`: the frame of that shot goes along as the last reference picture (waits for it while it is being made). */
  frameMake(shotId: string, profileId: string, values: Record<string, unknown>, after?: { shotId: string; refSlot: string; max: number }): Promise<{ ok: true; waiting: boolean } | { ok: false; error: string }>;
  /** Shots whose storyboard frame is being made. */
  framesComing(): Promise<string[]>;
  /** Make a reference picture for a bible element; the first finished picture of the batch becomes its reference. */
  bibleRefMake(profileId: string, values: Record<string, unknown>, cat: 'characters' | 'places' | 'props', id: string, batch: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** The plan changed in the main process (a bible picture arrived). */
  onDirector(cb: (s: DirectorState) => void): () => void;
  generateAfter(prevShotId: string, profileId: string, values: Record<string, unknown>, shotId: string, count?: number, useExisting?: boolean): Promise<{ ok: true; waiting: boolean } | { ok: false; error: string }>;
  /** Cut a frame out of a clip, store it as an asset (lineage: clip -> frame) and put it beside the clip on the board. */
  mediaEdit(assetId: string, op: import('@driftboard/media').MediaOp, originItemId?: string): Promise<{ ok: true; assetId: string; itemId: string } | { ok: false; error: string }>;
  /** Measure brightness, colour and sharpness of clips (in the order given) and report drift and join jumps. Also saved as a text file in the exports folder. */
  driftCheck(assetIds: string[]): Promise<{ ok: true; lines: string[]; clean: boolean; file: string; rows: DriftRow[] } | { ok: false; error: string }>;
  /** Make colour-matched copies of clips so they look like the first frame of the first clip (or of refAssetId). The originals stay. */
  colorMatch(assetIds: string[], refAssetId?: string, opts?: { place?: boolean }): Promise<{ ok: true; assetIds: string[] } | { ok: false; error: string }>;
  /** Cut the last (tail) or first (head) frames of a clip into a new clip for the "held frames" inputs. Frames snap to 17k+5. matchColor pulls it toward the look of the chain's very first picture. */
  /** A copy of a clip whose start is matched to the end of the previous clip, fading out over `fadeSec`: the join shows no step, the rest of the clip is untouched. */
  seamMatch(assetId: string, prevAssetId: string, opts?: { fadeSec?: number; place?: boolean }): Promise<{ ok: true; assetId: string } | { ok: false; error: string }>;
  smoothFlashes(assetId: string, flashes: { from: number; to: number }[], opts?: { place?: boolean }): Promise<{ ok: true; assetId: string } | { ok: false; error: string }>;
  refreshJoin(assetId: string): Promise<{ ok: true; assetId: string } | { ok: false; error: string }>;
  guideClip(clipAssetId: string, opts: { side: 'tail' | 'head'; frames: number; matchColor: boolean }): Promise<{ ok: true; assetId: string; frames: number; matched: boolean; /** the chain's first picture, when it is a picture: it goes in as <Picture 1> so identity and look are held too */ keystone?: string } | { ok: false; error: string }>;
  /** Clips made with held frames repeat those frames at their start. This returns, for each asset, the asset to put on the timeline: a copy without the repeated frames (made once), or the asset itself. */
  joinAssets(assetIds: string[]): Promise<string[]>;
  frameExtract(clipAssetId: string, which: 'first' | 'last' | { frame: number }, originItemId?: string): Promise<{ ok: true; assetId: string; itemId: string } | { ok: false; error: string }>;
  onBoard(cb: () => void): () => void;
  /** Film blocks of a story (or the project default / starter set when it has none of its own). */
  storyBlocks(storyId?: string): Promise<{ blocks: PromptBlock[]; source: 'story' | 'project' | 'starter' }>;
  /** scope: a story id, or 'project' for the default */
  storySetBlocks(scope: string, blocks: PromptBlock[]): Promise<void>;
  storyClearBlocks(storyId: string): Promise<void>;
  comfyStatus(): Promise<{ ok: boolean; version?: string; error?: string; url: string }>;
  setComfyUrl(url: string): Promise<void>;
  /** Settings → ComfyUI: saved per-profile defaults and on/off, the user profiles folder, profiles that failed to load. */
  comfyPrefs(): Promise<{ url: string; profiles: Record<string, { enabled?: boolean; defaults?: Record<string, unknown> }>; userDir: string; errors: string[] }>;
  comfySetDefault(profileId: string, slotId: string, value: unknown): Promise<void>;
  comfySetEnabled(profileId: string, on: boolean): Promise<void>;
  comfyResetProfile(profileId: string): Promise<void>;
  comfyHas(classes: string[]): Promise<Record<string, boolean>>;
  comfyHealth(): Promise<{ id: string; ok: boolean; missingNodes: string[]; missingModels: { kind: string; name: string }[]; error?: string }[]>;
  openProfilesFolder(): Promise<string>;
  reloadProfiles(): Promise<{ count: number; errors: string[] }>;
  projectCurrent(): Promise<ProjectView | null>;
  projectNew(): Promise<ProjectView | null>;
  projectOpen(): Promise<ProjectView | null>;
  projectList(): Promise<{ dir: string; name: string; opened: number; missing: boolean; current: boolean }[]>;
  projectSwitch(dir: string): Promise<{ ok: true; project: ProjectView } | { ok: false; error: string }>;
  projectForget(dir: string): Promise<void>;
  projectRelink(oldDir: string): Promise<{ ok: boolean; error?: string }>;
  projectDelete(dir: string): Promise<{ ok: boolean; error?: string }>;
  projectRename(dir: string, name: string): Promise<void>;
  logList(): Promise<import('./logger.ts').LogEntry[]>;
  logClear(): Promise<void>;
  logAdd(level: 'info' | 'warn' | 'error', source: string, msg: string): Promise<void>;
  logReveal(): Promise<string | null>;
  onLog(cb: (e: import('./logger.ts').LogEntry) => void): () => void;
  profiles(): Promise<(Manifest & { source: 'bundled' | 'user'; enabled: boolean })[]>;
  profileOptions(profileId: string): Promise<Record<string, string[]>>;
  assets(): Promise<Asset[]>;
  importAssets(): Promise<Asset[]>;
  jobs(): Promise<JobView[]>;
  enqueue(profileId: string, values: Record<string, unknown>): Promise<{ ok: true; job: JobView } | { ok: false; error: string }>;
  variations(jobId: string, n: number): Promise<{ ok: true; queued: number } | { ok: false; error: string }>;
  cancel(jobId: string): Promise<void>;
  retry(jobId: string, nudgeSeed: boolean): Promise<{ ok: true } | { ok: false; error: string }>;
  onJob(cb: (j: JobView) => void): () => void;
  onProgress(cb: (jobId: string, fraction: number) => void): () => void;
}
