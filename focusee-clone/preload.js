'use strict';

const { contextBridge, ipcRenderer } = require('electron');
// Node modules are only available when the window is NOT sandboxed. The main
// editor window sets sandbox:false; other windows (the control pill) stay
// sandboxed, where require('node:*') throws — so guard, or this preload dies
// and the pill loses its whole bridge (buttons dead, timer frozen).
let nodePath = null;
let nodeFs = null;
let childRequire = null;
try {
  nodePath = require('node:path');
  nodeFs = require('node:fs');
  childRequire = require;
} catch {}
const VENDOR_DIR = nodePath ? nodePath.join(__dirname, 'renderer', 'vendor') : '';
const SEG = { segmenter: null, ts: 0 };

function blobUrlOf(file) {
  const buf = nodeFs.readFileSync(file);
  return URL.createObjectURL(new Blob([buf]));
}

async function initSegmenter() {
  if (!childRequire) return { ok: false, error: 'renderer is sandboxed; require unavailable' };
  try {
    const vision = childRequire('@mediapipe/tasks-vision');
    const fileset = {
      wasmLoaderPath: blobUrlOf(nodePath.join(VENDOR_DIR, 'wasm', 'vision_wasm_internal.js')),
      wasmBinaryPath: blobUrlOf(nodePath.join(VENDOR_DIR, 'wasm', 'vision_wasm_internal.wasm')),
    };
    const modelBuffer = new Uint8Array(nodeFs.readFileSync(nodePath.join(VENDOR_DIR, 'selfie_segmenter.tflite')));
    SEG.segmenter = await vision.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: modelBuffer, delegate: 'CPU' },
      runningMode: 'VIDEO',
      outputCategoryMask: false,
      outputConfidenceMask: true,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err).slice(0, 200) };
  }
}

contextBridge.exposeInMainWorld('focusee', {
  info: () => ipcRenderer.invoke('app:info'),

  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    load: (id) => ipcRenderer.invoke('projects:load', id),
    save: (project) => ipcRenderer.invoke('projects:save', project),
    remove: (id) => ipcRenderer.invoke('projects:delete', id),
    video: (id) => ipcRenderer.invoke('projects:video', id),
    thumb: (id, dataUrl) => ipcRenderer.invoke('projects:thumb', { id, dataUrl }),
    importVideo: (payload) => ipcRenderer.invoke('media:import', payload),
    openVideoDialog: () => ipcRenderer.invoke('dialog:openVideo'),
    readVideoFile: (filePath) => ipcRenderer.invoke('file:readVideo', filePath),
  },

  capture: {
    sources: () => ipcRenderer.invoke('capture:sources'),
    begin: () => ipcRenderer.invoke('capture:begin'),
    setDisplaySource: (id) => ipcRenderer.send('capture:setDisplaySource', id),
    end: () => ipcRenderer.invoke('capture:end'),
    showControl: (info) => ipcRenderer.invoke('capture:showControl', info),
    updateControl: (info) => ipcRenderer.invoke('capture:updateControl', info),
    hideControl: () => ipcRenderer.invoke('capture:hideControl'),
    stop: () => ipcRenderer.send('capture:stopRequested'),
    cancel: () => ipcRenderer.send('capture:cancelRequested'),
    onStopRequested: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('record:stopRequested', handler);
      return () => ipcRenderer.removeListener('record:stopRequested', handler);
    },
  },

  control: {
    onState: (cb) => {
      const handler = (_e, info) => cb(info);
      ipcRenderer.on('control:state', handler);
      return () => ipcRenderer.removeListener('control:state', handler);
    },
    stop: () => ipcRenderer.send('capture:stopRequested'),
    cancel: () => ipcRenderer.send('capture:cancelRequested'),
    reportPip: () => ipcRenderer.send('control:pipReport'),
    pipResize: (delta) => ipcRenderer.send('control:pipResize', delta),
    attachCameraPreview: () => ipcRenderer.invoke('control:attachCameraPreview'),
  },

  exporter: {
    saveWebm: (defaultName, data) => ipcRenderer.invoke('export:saveWebm', { defaultName, data }),
    tempFile: (name, data) => ipcRenderer.invoke('export:tempFile', { name, data }),
    toMp4: (inputPath, outputPath) => ipcRenderer.invoke('export:toMp4', { inputPath, outputPath }),
    reveal: (filePath) => ipcRenderer.invoke('export:reveal', filePath),
    saveProjectFile: (name, data) => ipcRenderer.invoke('dialog:saveProjectFile', { name, data }),
  },

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
  },

  teleprompter: {
    toggle: () => ipcRenderer.invoke('teleprompter:toggle'),
  },

  camera: {
    save: (id, data) => ipcRenderer.invoke('projects:saveCamera', { id, data }),
    load: (id) => ipcRenderer.invoke('projects:camera', id),
  },

  // Background removal: segmentation runs in this preload context (Node
  // available); frames arrive as cloneable ImageBitmaps, masks go back as
  // typed arrays. Timestamps must increase monotonically (VIDEO mode).
  segmenter: {
    init: () => initSegmenter(),
    async segment(bitmap, timeMs) {
      if (!SEG.segmenter) return { ok: false, error: 'segmenter not initialised' };
      const ts = Math.max(++SEG.ts, Math.round(timeMs) || SEG.ts);
      const res = SEG.segmenter.segmentForVideo(bitmap, ts);
      const mask = res.confidenceMasks && res.confidenceMasks[0];
      const bytes = mask.getAsUint8Array();
      const out = { ok: true, bytes, w: mask.width, h: mask.height };
      try { res.close(); } catch {}
      return out;
    },
  },

  pipEvents: {
    on: (channel, cb) => {
      const handler = (_e, payload) => cb(payload);
      const allowed = ['record:pipMoved', 'record:pipResize'];
      if (!allowed.includes(channel)) return () => {};
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
  },

  e2e: {
    shot: (name) => ipcRenderer.invoke('e2e:shot', name),
    quit: () => ipcRenderer.invoke('e2e:quit'),
  },
});
