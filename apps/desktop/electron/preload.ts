// The renderer's only bridge to the system: a fixed, typed set of calls.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC, type AppEvent, type GenerationProgress, type MorphixApi, type PrinterStatus, type VoiceEvent } from "@morphix/shared";

function subscribe<T>(channel: string, cb: (v: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, v: T) => cb(v);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: MorphixApi = {
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  getSystemInfo: () => ipcRenderer.invoke(IPC.getSystemInfo),
  recentLogs: (lines) => ipcRenderer.invoke(IPC.recentLogs, lines),
  log: (level, message) => ipcRenderer.send(IPC.log, level, message),

  listProjects: () => ipcRenderer.invoke(IPC.listProjects),
  getProject: (id) => ipcRenderer.invoke(IPC.getProject, id),
  createProjectFromPrompt: (prompt) => ipcRenderer.invoke(IPC.createProjectFromPrompt, prompt),
  setTargetHeight: (versionId, heightMm) => ipcRenderer.invoke(IPC.setTargetHeight, versionId, heightMm),
  saveThumbnail: (versionId, png) => ipcRenderer.invoke(IPC.saveThumbnail, versionId, png),
  onGenerationProgress: (cb) => subscribe<GenerationProgress>(IPC.generationProgress, cb),

  submitRecording: (pcm, rate) => ipcRenderer.invoke(IPC.submitRecording, pcm, rate),
  sendText: (text) => ipcRenderer.invoke(IPC.sendText, text),
  conversation: () => ipcRenderer.invoke(IPC.conversation),
  smartSearch: (query) => ipcRenderer.invoke(IPC.smartSearch, query),
  smartSearchState: () => ipcRenderer.invoke(IPC.smartSearchState),
  selectSmartModel: (id) => ipcRenderer.invoke(IPC.selectSmartModel, id),
  importSmartModel: (resultId, files) => ipcRenderer.invoke(IPC.importSmartModel, resultId, files),
  importModelFiles: (files) => ipcRenderer.invoke(IPC.importModelFiles, files),
  downloadSmartModel: (resultId) => ipcRenderer.invoke(IPC.downloadSmartModel, resultId),
  libraryManifest: (versionId) => ipcRenderer.invoke(IPC.libraryManifest, versionId),
  libraryPlate: (projectId, plate) => ipcRenderer.invoke(IPC.libraryPlate, projectId, plate),

  printerStatus: () => ipcRenderer.invoke(IPC.printerStatus),
  printerInfo: () => ipcRenderer.invoke(IPC.printerInfo),
  onPrinterStatus: (cb) => subscribe<PrinterStatus>(IPC.printerStatusEvent, cb),

  voiceTurn: (pcm, rate) => ipcRenderer.invoke(IPC.voiceTurn, pcm, rate),
  voiceText: (text) => ipcRenderer.invoke(IPC.voiceText, text),
  onVoiceEvent: (cb) => subscribe<VoiceEvent>(IPC.voiceEvent, cb),
  onAppEvent: (cb) => subscribe<AppEvent>(IPC.appEvent, cb),
  pendingAction: () => ipcRenderer.invoke(IPC.pendingAction),
  confirmAction: (id) => ipcRenderer.invoke(IPC.confirmAction, id),
  cancelAction: (id) => ipcRenderer.invoke(IPC.cancelAction, id),
  requestRefine: (versionId) => ipcRenderer.invoke(IPC.requestRefine, versionId),
  meshyBalance: () => ipcRenderer.invoke(IPC.meshyBalance),
  testGemini: () => ipcRenderer.invoke(IPC.testGemini),

  preparePrint: (versionId, settings, opts) => ipcRenderer.invoke(IPC.preparePrint, versionId, settings, opts),
  slicerDefaults: () => ipcRenderer.invoke(IPC.slicerDefaults),
  machineCommand: (c) => ipcRenderer.invoke(IPC.machineCommand, c),
  machineCapabilities: () => ipcRenderer.invoke(IPC.machineCapabilities),
  jobs: () => ipcRenderer.invoke(IPC.jobs),
  latestPrintJob: (projectId) => ipcRenderer.invoke(IPC.latestPrintJob, projectId),
  requestPrint: (jobId) => ipcRenderer.invoke(IPC.requestPrint, jobId),
  printStatus: () => ipcRenderer.invoke(IPC.printStatus),
  pausePrint: () => ipcRenderer.invoke(IPC.pausePrint),
  resumePrint: () => ipcRenderer.invoke(IPC.resumePrint),
  filaments: () => ipcRenderer.invoke(IPC.filaments),
  setLoadedFilament: (id) => ipcRenderer.invoke(IPC.setLoadedFilament, id),
  filamentJob: (kind, filament) => ipcRenderer.invoke(IPC.filamentJob, kind, filament),
  uiPage: (page) => ipcRenderer.invoke(IPC.uiPage, page),
  cancelPrint: () => ipcRenderer.invoke(IPC.cancelPrint),
  guardian: () => ipcRenderer.invoke(IPC.guardian),
  guardianCommand: (cmd) => ipcRenderer.invoke(IPC.guardianCommand, cmd),
  guardianAnswer: (decision) => ipcRenderer.invoke(IPC.guardianAnswer, decision),
  guardianSimulate: () => ipcRenderer.invoke(IPC.guardianSimulate),

  cloudStatus: () => ipcRenderer.invoke(IPC.cloudStatus),
  cloudPair: () => ipcRenderer.invoke(IPC.cloudPair),
  cloudUnpair: () => ipcRenderer.invoke(IPC.cloudUnpair),
  networkStatus: () => ipcRenderer.invoke(IPC.networkStatus),
  wifiScan: () => ipcRenderer.invoke(IPC.wifiScan),
  wifiConnect: (ssid, password) => ipcRenderer.invoke(IPC.wifiConnect, ssid, password),
  wifiForget: (ssid) => ipcRenderer.invoke(IPC.wifiForget, ssid),
};

contextBridge.exposeInMainWorld("morphix", api);
