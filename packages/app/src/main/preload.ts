import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AppApi } from './api.ts';

const call = (name: string) => (...args: unknown[]) => ipcRenderer.invoke(name, ...args);
const sub = (channel: string) => (cb: (...a: any[]) => void) => {
  const h = (_: unknown, ...a: unknown[]) => cb(...a);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.off(channel, h);
};
const api: AppApi = {
  storyBlocks: call('storyBlocks'), storySetBlocks: call('storySetBlocks'), storyClearBlocks: call('storyClearBlocks'),
  comfyStatus: call('comfyStatus'), setComfyUrl: call('setComfyUrl'),
  comfyPrefs: call('comfyPrefs'), comfySetDefault: call('comfySetDefault'), comfySetEnabled: call('comfySetEnabled'), comfyResetProfile: call('comfyResetProfile'), comfyHas: call('comfyHas'), comfyHealth: call('comfyHealth'), openProfilesFolder: call('openProfilesFolder'), reloadProfiles: call('reloadProfiles'),
  projectCurrent: call('projectCurrent'), projectNew: call('projectNew'), projectOpen: call('projectOpen'), projectList: call('projectList'), projectSwitch: call('projectSwitch'), projectForget: call('projectForget'), projectRelink: call('projectRelink'), projectDelete: call('projectDelete'), projectRename: call('projectRename'),
  logList: call('logList'), logClear: call('logClear'), logAdd: call('logAdd'), logReveal: call('logReveal'), onLog: sub('log'),
  profiles: call('profiles'), profileOptions: call('profileOptions'), assets: call('assets'), importAssets: call('importAssets'),
  jobs: call('jobs'), enqueue: call('enqueue'), variations: call('variations'), cancel: call('cancel'), retry: call('retry'),
  board: call('board'), boardPlace: call('boardPlace'), boardAddNote: call('boardAddNote'), boardAddGroup: call('boardAddGroup'),
  boardAddAssets: call('boardAddAssets'), boardRemove: call('boardRemove'), libraryTrash: call('libraryTrash'), libraryPurge: call('libraryPurge'), boardConnect: call('boardConnect'),
  boardDisconnect: call('boardDisconnect'), boardUpdate: call('boardUpdate'), boardUndo: call('boardUndo'), boardRedo: call('boardRedo'),
  generate: call('generate'), mediaEdit: call('mediaEdit'), driftCheck: call('driftCheck'), guideClip: call('guideClip'), seamMatch: call('seamMatch'), smoothFlashes: call('smoothFlashes'), refreshJoin: call('refreshJoin'), joinAssets: call('joinAssets'), colorMatch: call('colorMatch'), frameExtract: call('frameExtract'), boardImportPaths: call('boardImportPaths'), pathFor: (f: File) => webUtils.getPathForFile(f),
  timelineLoad: call('timelineLoad'), timelineSave: call('timelineSave'), exportTimeline: call('exportTimeline'), exportCancel: call('exportCancel'), reveal: call('reveal'), exportsDir: call('exportsDir'), assetReveal: call('assetReveal'), assetsDownload: call('assetsDownload'),
  onExportProgress: sub('exportProgress'),
  story: call('story'), storyActive: call('storyActive'), llmName: call('llmName'), directorInterpret: call('directorInterpret'), directorSetInterpreted: call('directorSetInterpreted'), directorUseInterpreted: call('directorUseInterpreted'), directorMissing: call('directorMissing'), directorRuns: call('directorRuns'), directorNewRun: call('directorNewRun'), directorOpenRun: call('directorOpenRun'), directorBack: call('directorBack'), directorRunEdit: call('directorRunEdit'), directorClearAll: call('directorClearAll'), storyOp: call('storyOp'), boardArrange: call('boardArrange'), viewSave: call('viewSave'), viewDelete: call('viewDelete'),
  llmStatus: call('llmStatus'), llmSettings: call('llmSettings'), llmSet: call('llmSet'), guides: call('guides'), guideSave: call('guideSave'), guideReset: call('guideReset'), llmEnhance: call('llmEnhance'), llmWritePrompts: call('llmWritePrompts'), llmCancel: call('llmCancel'), llmReadLook: call('llmReadLook'), llmTasks: call('llmTasks'), onLlmTasks: sub('llmTasks'), onLlmProgress: sub('llmProgress'), chatState: call('chatState'), chatSend: call('chatSend'), chatClear: call('chatClear'), chatToNote: call('chatToNote'), llmUnload: call('llmUnload'), llmDistil: call('llmDistil'), sbGet: call('sbGet'), sbSet: call('sbSet'), sbDescribe: call('sbDescribe'), sbStory: call('sbStory'), sbPrompts: call('sbPrompts'), sbToStory: call('sbToStory'), promptsToStory: call('promptsToStory'), blobGet: call('blobGet'), blobSet: call('blobSet'), directorState: call('directorState'), directorSetScript: call('directorSetScript'),
  directorSetTarget: call('directorSetTarget'), directorUpdate: call('directorUpdate'), directorRun: call('directorRun'), directorCancel: call('directorCancel'),
  directorAccept: call('directorAccept'), directorImportFile: call('directorImportFile'), onDirectorProgress: sub('directorProgress'),
  onJob: sub('job'), onProgress: sub('progress'), onBoard: sub('board'),
} as AppApi;
contextBridge.exposeInMainWorld('driftboard', api);
