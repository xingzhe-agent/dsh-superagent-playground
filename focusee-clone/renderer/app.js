'use strict';

import {
  ASPECTS, buildZooms, clamp, detectActions, formatTime, normaliseCursor, zoomAt,
} from './zoom.js';
import {
  BACKGROUNDS, backgroundById, backgroundCss, drawFrame, loadVideoElement, outputSize,
} from './render.js';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const uid = (prefix = 'p') => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const clamp01 = (v) => clamp(Number(v) || 0, 0, 1);

const DEFAULT_STYLE = {
  aspect: '16:9',
  padding: 6,
  border: 0,
  radius: 8,
  shadow: 72,
  blur: 0,
  background: 'gradient-violet',
};

const AUTO_DEFAULTS = { scale: 1.8, hold: 0.8, lead: 0.4, ease: 0.3 };

const S = {
  info: null,
  projects: [],
  project: null,
  video: null,
  videoUrl: null,
  time: 0,
  duration: 0,
  playing: false,
  tab: 'style',
  canvasW: 1280,
  canvasH: 720,
  dirty: true,
  sourceCtx: null,
  audioCtx: null,
  audioSource: null,
  audioDest: null,
  recording: null,
  export: { running: false, cancelled: false },
  selectedSource: null,
  sources: [],
  lastThumbAt: 0,
};

const canvas = $('#canvas');
const ctx = canvas.getContext('2d', { alpha: false });

// ---------------------------------------------------------------------------
// Toast + modal helpers
// ---------------------------------------------------------------------------

let toastTimer = null;
function toast(msg, ms = 2400) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

function openModal(id) {
  $(`#${id}`)?.classList.remove('hidden');
}
function closeModal(id) {
  $(`#${id}`)?.classList.add('hidden');
}

document.addEventListener('click', (e) => {
  const closer = e.target.closest('[data-close]');
  if (closer) closeModal(closer.dataset.close);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  S.info = await window.focusee.info();
  S.projects = await window.focusee.projects.list();
  renderHome();
  showView('home');
  bindChrome();
  bindRecordDialog();
  bindExportDialog();
  requestAnimationFrame(tick);
  exposeTestApi();
  document.addEventListener('keydown', onKey);
}

function showView(name) {
  $('#view-home').classList.toggle('hidden', name !== 'home');
  $('#view-editor').classList.toggle('hidden', name !== 'editor');
  if (name === 'editor') $('#titlebar-center').textContent = '编辑项目';
  else $('#titlebar-center').textContent = '录制 · 自动缩放 · 成片';
}

function bindChrome() {
  $('#btn-record').addEventListener('click', openRecordDialog);
  $('#btn-import').addEventListener('click', importVideo);
  $('#btn-sample').addEventListener('click', () => openProject('sample', { sample: true }));
  $('#btn-home').addEventListener('click', async () => {
    await flushThumb();
    await refreshProjects();
    showView('home');
    S.project = null;
    S.video = null;
    if (S.videoUrl) URL.revokeObjectURL(S.videoUrl);
    S.videoUrl = null;
    renderHome();
  });
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-play').addEventListener('click', () => (S.playing ? pause() : play()));
  $('#btn-auto-zoom').addEventListener('click', () => applyAutoZooms({ announce: true }));
  $('#btn-add-zoom').addEventListener('click', addManualZoom);
  $('#btn-layout').addEventListener('click', () => toast('布局片段：原型未实现（见差异报告）'));
  $('#btn-share').addEventListener('click', () => toast('分享链接：原型未实现（FocuSee 为云分享）'));
  $('#btn-export').addEventListener('click', openExportDialog);
  $('#rail').addEventListener('click', (e) => {
    const btn = e.target.closest('.rail-btn');
    if (btn) selectTab(btn.dataset.tab);
  });
  $('#stage').addEventListener('click', (e) => {
    if (e.target === canvas) play();
  });
  $('#tl-track').addEventListener('click', onTimelineClick);
  $('#btn-undo').addEventListener('click', () => toast('撤销：原型未实现'));
  $('#btn-redo').addEventListener('click', () => toast('重做：原型未实现'));
  window.addEventListener('resize', () => { S.dirty = true; });
}

function onKey(e) {
  if (!S.project) return;
  if (e.code === 'Space' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
    e.preventDefault();
    S.playing ? pause() : play();
  }
  if (e.code === 'Escape') {
    pause();
  }
}

// ---------------------------------------------------------------------------
// Background removal (人像分割, MediaPipe selfie segmenter, vendored model)
// ---------------------------------------------------------------------------

const SEG = { ready: false, failed: false, segmenter: null, lastRun: 0, maskCtx: null };

async function ensureSegmenter() {
  if (SEG.ready || SEG.failed) return SEG.ready;
  try {
    const vision = await import('./vendor/vision_bundle.mjs');
    const fileset = await vision.FilesetResolver.forVisionTasks('vendor://wasm');
    SEG.segmenter = await vision.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: 'vendor://selfie_segmenter.tflite', delegate: 'CPU' },
      runningMode: 'VIDEO',
      outputCategoryMask: false,
      outputConfidenceMask: true,
    });
    SEG.maskCtx = document.createElement('canvas').getContext('2d');
    SEG.ready = true;
    console.log('[seg] ready');
  } catch (err) {
    console.warn('[seg] init failed', err);
    SEG.failed = true;
  }
  return SEG.ready;
}

function updateBackgroundMask(camVideo, timeMs) {
  if (!SEG.ready || !camVideo?.videoWidth) return;
  // Run at ~15fps; reuse the last mask between runs.
  if (timeMs - SEG.lastRun < 66) return;
  SEG.lastRun = timeMs;
  try {
    const res = SEG.segmenter.segmentForVideo(camVideo, timeMs);
    const mask = res?.confidenceMasks?.[0];
    if (!mask) return;
    const w = mask.width;
    const h = mask.height;
    const data = mask.getAsUint8Array();
    const mc = SEG.maskCtx.canvas;
    if (mc.width !== w || mc.height !== h) { mc.width = w; mc.height = h; }
    const img = SEG.maskCtx.createImageData(w, h);
    // White RGB with the confidence as alpha → destination-in keeps the person.
    for (let i = 0; i < data.length; i += 1) {
      const o = i * 4;
      img.data[o] = 255; img.data[o + 1] = 255; img.data[o + 2] = 255;
      img.data[o + 3] = data[i];
    }
    SEG.maskCtx.putImageData(img, 0, 0);
    if (S.project) S.project.cameraMaskCanvas = mc;
  } catch (err) {
    console.warn('[seg] frame failed', err);
  }
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

async function refreshProjects() {
  S.projects = await window.focusee.projects.list();
}

function renderHome() {
  const wrap = $('#recent-list');
  wrap.innerHTML = '';
  $('#recent-count').textContent = S.projects.length ? `${S.projects.length} 个项目` : '';
  if (!S.projects.length) {
    wrap.innerHTML = `<div class="recent-empty">还没有项目。点击「录制屏幕」开始，或打开示例项目看看自动缩放的效果。</div>`;
    return;
  }
  for (const p of S.projects) {
    const card = document.createElement('div');
    card.className = 'recent-card';
    const dur = formatTime(p.duration || 0);
    card.innerHTML = `
      <div class="recent-thumb ${p.thumb ? '' : 'empty'}" ${p.thumb ? `style="background-image:url(${p.thumb})"` : ''}>
        ${p.thumb ? '' : 'FocuSee Clone'}
      </div>
      <div class="recent-meta">
        <h4>${escapeHtml(p.name || '未命名项目')}</h4>
        <p><span>${dur}</span><span>${p.zoomCount ?? 0} 个缩放</span>${p.id === 'sample' ? '<span>示例</span>' : ''}</p>
      </div>`;
    card.addEventListener('click', () => openProject(p.id));
    card.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      if (p.id === 'sample') return toast('示例项目不可删除');
      if (confirm(`删除项目「${p.name}」？`)) {
        await window.focusee.projects.remove(p.id);
        await refreshProjects();
        renderHome();
        toast('已删除');
      }
    });
    wrap.appendChild(card);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// Project open / video wiring
// ---------------------------------------------------------------------------

async function openProject(id, opts = {}) {
  try {
    const project = await window.focusee.projects.load(id);
    const media = await window.focusee.projects.video(id);
    const blob = new Blob([media.data], { type: media.mime });
    if (S.videoUrl) URL.revokeObjectURL(S.videoUrl);
    S.videoUrl = URL.createObjectURL(blob);
    if (S.video) {
      S.video.pause();
      S.video.removeAttribute('src');
      S.video.load();
    }
    S.video = await loadVideoElement(S.videoUrl);
    S.project = project;
    project.style = { ...DEFAULT_STYLE, ...(project.style || {}) };
    project.camera = { enabled: !!project.cameraFile, layout: 'bottom-right', size: 18, removeBg: false, segments: [], ...(project.camera || {}) };
    if (project.cameraFile) {
      try {
        const camMedia = await window.focusee.camera.load(id);
        const camBlob = new Blob([camMedia.data], { type: camMedia.mime });
        project.cameraVideoEl = await loadVideoElement(URL.createObjectURL(camBlob));
      } catch (err) {
        console.warn('[camera] load failed', err);
        project.camera.enabled = false;
      }
    }
    project.zooms = project.zooms || [];
    project.clicks = project.clicks || [];
    project.cursor = project.cursor || [];
    project.cursorFx = { enabled: true, highlight: false, color: '#ffd166', ...(project.cursorFx || {}) };
    project.captions = project.captions || [];
    S.duration = Number(project.duration) || S.video.duration || 0;
    if (!project.duration && S.video.duration) {
      project.duration = S.video.duration;
      S.duration = S.video.duration;
    }
    S.video.addEventListener('timeupdate', () => {
      if (!S.playing) S.dirty = true;
    });
    S.video.addEventListener('seeked', () => { S.dirty = true; });
    S.time = 0;
    S.video.currentTime = 0;
    resizeCanvas();
    if (!project.zooms.length && project.cursor.length) applyAutoZooms({ silent: true });
    selectTab(S.tab);
    renderTimeline();
    $('#doc-title').textContent = project.name || '未命名项目';
    showView('editor');
    S.dirty = true;
    updateTimeUi();
    if (!project.thumb) setTimeout(flushThumb, 900);
    if (id === 'sample' && opts.sample) toast('示例项目：3 段自动缩放由光标停留点生成');
  } catch (err) {
    console.error(err);
    toast(`打开失败：${err.message}`);
  }
}

function resizeCanvas() {
  const size = outputSize(S.project?.style || DEFAULT_STYLE, S.video?.videoWidth, S.video?.videoHeight, 1600);
  S.canvasW = size.width;
  S.canvasH = size.height;
  canvas.width = S.canvasW;
  canvas.height = S.canvasH;
  S.dirty = true;
}

async function flushThumb() {
  if (!S.project || !S.video || !S.video.videoWidth) return;
  try {
    const data = canvas.toDataURL('image/jpeg', 0.72);
    if (data.length > 2000) await window.focusee.projects.thumb(S.project.id, data);
  } catch {}
}

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------

const TABS = {
  style: { title: '样式', sub: '画布比例、留白与边框。改动即时呈现在左侧画布。' },
  background: { title: '背景', sub: 'FocuSee 的背景预设换成了自绘渐变，可另行调配色。' },
  cursor: { title: '光标', sub: '录制已包含系统光标；这里控制点击强调效果。' },
  zoom: { title: '缩放', sub: '自动缩放由光标停留点生成，也可以手动补一段。' },
  captions: { title: '字幕', sub: 'AI 字幕未实现；可手动添加一条字幕验证渲染链路。' },
  audio: { title: '音频', sub: '音频增强/降噪未实现。' },
  layout: { title: '布局', sub: '摄像头画中画、镜头布局、布局片段、背景移除、3D 动效与提词器。' },
  more: { title: '更多', sub: '原型信息与已知差异。' },
};

function selectTab(tab) {
  S.tab = tab;
  $$('.rail-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  renderInspector();
}

function renderInspector() {
  const host = $('#inspector');
  const meta = TABS[S.tab] || TABS.style;
  const p = S.project;
  if (!p) return;
  let body = '';
  if (S.tab === 'style') body = inspectorStyle(p);
  else if (S.tab === 'background') body = inspectorBackground(p);
  else if (S.tab === 'cursor') body = inspectorCursor(p);
  else if (S.tab === 'zoom') body = inspectorZoom(p);
  else if (S.tab === 'captions') body = inspectorCaptions(p);
  else if (S.tab === 'audio') body = inspectorAudio(p);
  else if (S.tab === 'layout') body = inspectorLayout(p);
  else body = inspectorMore(p);

  host.innerHTML = `<h3 class="insp-title">${meta.title}</h3><p class="insp-sub">${meta.sub}</p>${body}`;
  bindInspector(host);
}

function sliderRow(key, label, min, max, value, suffix = '') {
  return `<div class="slider-row" data-slider="${key}">
    <div class="slider-label"><span>${label}</span><b data-readout="${key}">${value}${suffix}</b></div>
    <input type="range" data-key="${key}" min="${min}" max="${max}" step="1" value="${value}" />
  </div>`;
}

function inspectorStyle(p) {
  const s = p.style;
  const chips = ['original', '16:9', '1:1', '4:3', '9:16']
    .map((a) => `<button class="chip ${s.aspect === a ? 'active' : ''}" data-aspect="${a}">${a === 'original' ? '原始尺寸' : a}</button>`)
    .join('');
  return `
    <div class="insp-section">
      <h4>视频尺寸</h4>
      <div class="chip-row">${chips}</div>
    </div>
    <div class="insp-section">
      <h4>画面</h4>
      ${sliderRow('padding', '内边距', 0, 24, s.padding, '%')}
      ${sliderRow('border', '内边框', 0, 24, s.border)}
      ${sliderRow('radius', '圆角', 0, 30, s.radius)}
      ${sliderRow('shadow', '阴影', 0, 100, s.shadow)}
      ${sliderRow('blur', '背景模糊', 0, 100, s.blur)}
    </div>
    <div class="insp-section">
      <h4>背景 <span class="value">${backgroundById(s.background).label}</span></h4>
      <div class="bg-collage">${BACKGROUNDS.slice(0, 9).map((b) => bgTile(b, s.background)).join('')}</div>
      <div style="margin-top:10px"><button class="btn xs" data-tab-jump="background">更多背景 →</button></div>
    </div>`;
}

function bgTile(bg, active) {
  return `<div class="bg-tile ${bg.id === active ? 'active' : ''}" data-bg="${bg.id}" style="background:${backgroundCss(bg)}"></div>`;
}

function inspectorBackground(p) {
  const s = p.style;
  return `
    <div class="insp-section">
      <h4>预设背景</h4>
      <div class="bg-collage">${BACKGROUNDS.map((b) => bgTile(b, s.background)).join('')}</div>
    </div>
    <div class="insp-section">
      <h4>自定义</h4>
      <div class="switch-row"><span>纯色背景</span>
        <input type="color" data-key="bgColor" value="${p.style.bgColor || '#23262f'}" style="width:42px;height:26px;border:1px solid var(--line-strong);border-radius:6px;background:#fff" />
      </div>
      ${sliderRow('blur', '背景模糊', 0, 100, s.blur)}
      ${sliderRow('padding', '内边距', 0, 24, s.padding, '%')}
      ${sliderRow('radius', '圆角', 0, 30, s.radius)}
      ${sliderRow('shadow', '阴影', 0, 100, s.shadow)}
    </div>`;
}

function inspectorCursor(p) {
  const fx = p.cursorFx;
  return `
    <div class="insp-section">
      <div class="switch-row"><span>点击涟漪</span><button class="switch ${fx.enabled ? 'on' : ''}" data-toggle="cursorFx.enabled"></button></div>
      <div class="switch-row"><span>光标高亮</span><button class="switch ${fx.highlight ? 'on' : ''}" data-toggle="cursorFx.highlight"></button></div>
    </div>
    <div class="insp-section">
      <h4>强调色</h4>
      <div class="swatch-grid">
        ${['#ffd166', '#7b61ff', '#3ddc97', '#ff6b6b', '#4d9bff', '#ffffff'].map((c) => `
          <div class="swatch ${fx.color === c ? 'active' : ''}" data-fxcolor="${c}" style="background:${c}"></div>`).join('')}
      </div>
    </div>
    <div class="insp-section">
      <p class="placeholder"><b>差异说明：</b>FocuSee 会记录真实点击并做点击动画/音效；原型的“点击”来自光标停留簇，属于近似识别，见差异报告 §4。</p>
    </div>`;
}

function inspectorZoom(p) {
  const zs = p.zooms || [];
  const list = zs.length
    ? zs.map((z) => `<div class="seg-item">
        <span class="dot" style="background:${z.auto ? 'var(--accent-2)' : 'var(--good)'}"></span>
        <span>${formatTime(z.start)} → ${formatTime(z.end)}</span>
        <span class="t">×${Number(z.scale).toFixed(1)}</span>
        <button data-del-zoom="${z.id}" title="删除">✕</button>
      </div>`).join('')
    : '<p class="placeholder">还没有缩放片段。点「自动缩放」按光标停留点生成，或把播放头移到目标位置后点「＋ 缩放」。</p>';
  return `
    <div class="insp-section">
      <h4>自动缩放</h4>
      ${sliderRow('autoScale', '缩放强度', 13, 30, Math.round((p.auto?.scale ?? AUTO_DEFAULTS.scale) * 10))}
      ${sliderRow('autoHold', '停留时长', 8, 35, Math.round((p.auto?.hold ?? AUTO_DEFAULTS.hold) * 10))}
      <div class="switch-row"><span>固定缩放区域</span><button class="switch ${p.fixedZoom ? 'on' : ''}" data-toggle="fixedZoom"></button></div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn xs" data-action="reanalyze">重新分析</button>
        <button class="btn xs" data-action="add-zoom">在当前播放头加一段</button>
      </div>
    </div>
    <div class="insp-section">
      <h4>缩放片段 <span class="value">${zs.length}</span></h4>
      <div class="seg-list">${list}</div>
    </div>`;
}

function inspectorCaptions(p) {
  const caps = p.captions || [];
  return `
    <div class="insp-section">
      <h4>手动字幕</h4>
      <div style="display:flex;gap:6px">
        <input id="cap-text" placeholder="在此输入字幕…" style="flex:1;height:30px;border:1px solid var(--line-strong);border-radius:7px;padding:0 8px;outline:none" />
        <button class="btn xs" data-action="add-caption">添加</button>
      </div>
      <p class="hint">新字幕从当前播放头开始，持续 2.4 秒。</p>
      <div class="seg-list">
        ${caps.length ? caps.map((c) => `<div class="seg-item"><span class="dot" style="background:#ffb020"></span><span>${formatTime(c.start)} → ${formatTime(c.end)}</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:110px">${escapeHtml(c.text)}</span><button data-del-caption="${c.start}">✕</button></div>`).join('') : '<p class="placeholder">还没有字幕。</p>'}
      </div>
    </div>
    <div class="insp-section"><p class="placeholder"><b>未实现：</b>AI 字幕识别、字幕样式/位置编辑、跟随音频自动断句。</p></div>`;
}

function inspectorAudio(p) {
  return `
    <div class="insp-section">
      <p class="placeholder">音频增强、降噪、静音剪切在本原型中<b>未实现</b>。录制时可以选择是否带麦克风，音频会随视频一起导出。</p>
    </div>
    <div class="insp-section">
      <h4>项目音频</h4>
      <div class="kv-like" style="font-size:12px;color:var(--muted)">${p.hasAudio === false ? '该录制没有音频轨道' : '包含音频轨道（来自录制）'}</div>
    </div>`;
}

function inspectorLayout(p) {
  const cam = { segments: [], ...(p.camera || { enabled: false, layout: 'bottom-right', size: 18 }) };
  const layouts = ['bottom-right', 'bottom-left', 'top-right', 'top-left', 'bottom-center'];
  const names = { 'bottom-right': '右下', 'bottom-left': '左下', 'top-right': '右上', 'top-left': '左上', 'bottom-center': '底部居中' };
  const hasTake = !!p.cameraFile;
  const chips = layouts.map((l) => `<button class="chip ${cam.layout === l ? 'active' : ''}" data-cam-layout="${l}" ${cam.enabled ? '' : 'disabled'}>${names[l]}</button>`).join('');
  const tilt = p.style.tilt3d || 0;
  return `
    <div class="insp-section">
      <div class="switch-row"><span>摄像头画中画</span><button class="switch ${cam.enabled ? 'on' : ''}" data-toggle="camera.enabled" ${hasTake ? '' : 'disabled'}></button></div>
      ${hasTake
        ? `${cam.baked ? `<div class="switch-row"><span>编辑时再叠加一次摄像头</span><button class="switch ${cam.forceOverlay ? 'on' : ''}" data-toggle="camera.forceOverlay"></button></div><p class="hint">录制时已把画中画合成进画面；默认不再叠加。需要调整时打开此开关（用 camera.webm 重新叠加）。</p>` : `<p class="hint">使用录制时勾选「录制摄像头」保存的摄像头画面（camera.webm）。</p>`}`
        : `<p class="hint">这个项目没有摄像头画面。录制时勾选「录制摄像头（画中画）」即可生成。</p>`}
      <h4>镜头布局</h4>
      <div class="chip-row">${chips}</div>
      ${sliderRow('camSize', '摄像头大小', 8, 40, cam.size || 18)}
    </div>
    <div class="insp-section">
      <h4>布局片段</h4>
      <div style="display:flex;gap:8px">
        <button class="btn xs" data-action="add-cam-segment" ${cam.enabled && hasTake ? '' : 'disabled'}>在播放头加一段（当前布局）</button>
      </div>
      <p class="hint">片段期间摄像头切换到该片段的布局/大小；未覆盖的时间用上方默认布局。</p>
      <div class="seg-list">
        ${(p.camera.segments || []).length ? (p.camera.segments || []).map((sg) => `<div class="seg-item">
          <span class="dot" style="background:#8b7af5"></span>
          <span>${formatTime(sg.start)} → ${formatTime(sg.end)}</span>
          <span class="t">${names[sg.layout] || sg.layout} ×${sg.size || ''}</span>
          <button data-del-cam-seg="${sg.id}" title="删除">✕</button>
        </div>`).join('') : '<p class="placeholder">还没有片段。</p>'}
      </div>
    </div>
    <div class="insp-section">
      <h4>背景移除</h4>
      <div class="switch-row"><span>人像分割去背景</span><button class="switch ${cam.removeBg ? 'on' : ''}" data-toggle="camera.removeBg" ${cam.enabled && hasTake ? '' : 'disabled'}></button></div>
      <p class="hint">${SEG.failed ? `分割模型加载失败：${SEG.error || '未知错误'}。此功能不可用。` : SEG.ready ? '分割模型已就绪：摄像头将只保留人像（约 15fps 更新掩膜）。' : '本地人像分割模型（MediaPipe，随应用内置）。开启后首次会加载模型，约 15fps 更新掩膜。'}</p>
    </div>
    <div class="insp-section">
      <h4>3D 动效</h4>
      <div class="switch-row"><span>跟随光标的透视倾斜</span><button class="switch ${p.style.tiltFollow ? 'on' : ''}" data-toggle="style.tiltFollow"></button></div>
      ${sliderRow('tilt3d', '基础倾斜', -100, 100, tilt)}
      <p class="hint">倾斜为逐列透视（梯形映射），正负切换朝向；开启跟随时光标在左画面朝左转、在右朝右转。</p>
    </div>
    <div class="insp-section">
      <h4>提词器</h4>
      <div style="display:flex;gap:8px">
        <button class="btn xs" data-action="teleprompter">打开 / 收起提词器</button>
      </div>
      <p class="hint">悬浮窗不录进画面；录屏开始前勾选「提词器」也会自动打开。</p>
    </div>
    <div class="insp-section">
      <p class="placeholder"><b>仍未实现：</b>AI 字幕、音频增强/降噪、点击音效、云分享。背景移除与布局片段已实现（见上方开关与片段列表）。</p>
    </div>`;
}

function inspectorMore(p) {
  return `<div class="insp-section">
    <h4>项目</h4>
    <div class="seg-item" style="border:0;background:transparent;padding:4px 0"><span class="t">名称</span><span>${escapeHtml(p.name)}</span></div>
    <div class="seg-item" style="border:0;background:transparent;padding:4px 0"><span class="t">时长</span><span>${formatTime(S.duration)}</span></div>
    <div class="seg-item" style="border:0;background:transparent;padding:4px 0"><span class="t">光标采样</span><span>${(p.cursor || []).length} 点</span></div>
    <div class="seg-item" style="border:0;background:transparent;padding:4px 0"><span class="t">缩放片段</span><span>${(p.zooms || []).length}</span></div>
  </div>
  <div class="insp-section">
    <p class="placeholder"><b>这张原型的边界：</b>录制/预览/自动缩放/背景/导出可用；AI 字幕、音频增强、摄像头布局、3D 动效、云分享未实现。完整差异见仓库 <code>docs/DIFF-REPORT.md</code>。</p>
  </div>`;
}

function bindInspector(host) {
  const p = S.project;
  host.querySelectorAll('[data-aspect]').forEach((el) => el.addEventListener('click', () => {
    p.style.aspect = el.dataset.aspect;
    resizeCanvas();
    renderInspector();
    S.dirty = true;
  }));
  host.querySelectorAll('[data-bg]').forEach((el) => el.addEventListener('click', () => {
    p.style.background = el.dataset.bg;
    renderInspector();
    S.dirty = true;
  }));
  host.querySelectorAll('[data-fxcolor]').forEach((el) => el.addEventListener('click', () => {
    p.cursorFx.color = el.dataset.fxcolor;
    renderInspector();
    S.dirty = true;
  }));
  host.querySelectorAll('input[type="range"]').forEach((el) => {
    el.addEventListener('input', () => {
      const key = el.dataset.key;
      const val = Number(el.value);
      if (key === 'autoScale') p.auto = { ...(p.auto || AUTO_DEFAULTS), scale: val / 10 };
      else if (key === 'autoHold') p.auto = { ...(p.auto || AUTO_DEFAULTS), hold: val / 10 };
      else if (key === 'camSize') p.camera.size = val;
      else p.style[key] = val;
      const readout = host.querySelector(`[data-readout="${key}"]`);
      if (readout) readout.textContent = `${val}${key === 'padding' ? '%' : ''}`;
      if (['padding', 'radius', 'shadow', 'blur', 'border', 'tilt3d', 'camSize'].includes(key)) S.dirty = true;
      if (key === 'autoScale' || key === 'autoHold') applyAutoZooms({ silent: true });
    });
  });
  host.querySelectorAll('[data-toggle]').forEach((el) => el.addEventListener('click', () => {
    if (el.dataset.toggle === 'cursorFx.enabled') p.cursorFx.enabled = !p.cursorFx.enabled;
    else if (el.dataset.toggle === 'cursorFx.highlight') p.cursorFx.highlight = !p.cursorFx.highlight;
    else if (el.dataset.toggle === 'fixedZoom') p.fixedZoom = !p.fixedZoom;
    else if (el.dataset.toggle === 'camera.enabled') p.camera.enabled = !p.camera.enabled;
    else if (el.dataset.toggle === 'camera.forceOverlay') p.camera.forceOverlay = !p.camera.forceOverlay;
    else if (el.dataset.toggle === 'style.tiltFollow') p.style.tiltFollow = !p.style.tiltFollow;
    renderInspector();
    S.dirty = true;
  }));
  host.querySelector('[data-tab-jump]')?.addEventListener('click', (e) => selectTab(e.target.dataset.tabJump));
  host.querySelector('[data-action="reanalyze"]')?.addEventListener('click', () => applyAutoZooms({ announce: true }));
  host.querySelector('[data-action="add-zoom"]')?.addEventListener('click', addManualZoom);
  host.querySelector('[data-action="add-caption"]')?.addEventListener('click', addCaption);
  host.querySelectorAll('[data-del-zoom]').forEach((el) => el.addEventListener('click', () => {
    p.zooms = p.zooms.filter((z) => z.id !== el.dataset.delZoom);
    renderInspector();
    renderTimeline();
    S.dirty = true;
  }));
  host.querySelectorAll('[data-del-caption]').forEach((el) => el.addEventListener('click', () => {
    const start = Number(el.dataset.delCaption);
    p.captions = p.captions.filter((c) => c.start !== start);
    renderInspector();
    S.dirty = true;
  }));
  host.querySelectorAll('[data-cam-layout]').forEach((el) => el.addEventListener('click', () => {
    p.camera.layout = el.dataset.camLayout;
    renderInspector();
    S.dirty = true;
  }));
  host.querySelector('[data-action="add-cam-segment"]')?.addEventListener('click', () => {
    const start = clamp(S.time, 0, Math.max(0, S.duration - 0.2));
    const end = clamp(start + 2, 0, S.duration);
    p.camera.segments = [...(p.camera.segments || []), {
      id: `cs-${Date.now().toString(36)}`,
      start: Number(start.toFixed(2)),
      end: Number(end.toFixed(2)),
      layout: p.camera.layout || 'bottom-right',
      size: p.camera.size || 18,
    }];
    renderInspector();
    S.dirty = true;
  });
  host.querySelectorAll('[data-del-cam-seg]').forEach((el) => el.addEventListener('click', () => {
    p.camera.segments = (p.camera.segments || []).filter((sg) => sg.id !== el.dataset.delCamSeg);
    renderInspector();
    S.dirty = true;
  }));
  host.querySelector('[data-action="teleprompter"]')?.addEventListener('click', async () => {
    await window.focusee.teleprompter.toggle();
  });
  const color = host.querySelector('input[type="color"][data-key="bgColor"]');
  color?.addEventListener('input', () => {
    p.style.bgColor = color.value;
    p.style.background = 'solid-custom';
    S.dirty = true;
  });
}

// The renderer resolves the background from the style on every frame, so a
// custom solid colour needs no special handling here.
function drawCurrent(time) {
  if (!S.project || !S.video) return null;
  return drawFrame(ctx, {
    width: S.canvasW,
    height: S.canvasH,
    project: S.project,
    video: S.video,
    time,
    preview: true,
  });
}

// ---------------------------------------------------------------------------
// Timeline + transport
// ---------------------------------------------------------------------------

function renderTimeline() {
  const p = S.project;
  if (!p) return;
  const dur = Math.max(0.001, S.duration);
  $('#tl-clip-len').textContent = `${S.duration.toFixed(1)}s`;
  const zooms = $('#tl-zooms');
  zooms.innerHTML = (p.zooms || []).map((z) => {
    const left = clamp01(z.start / dur) * 100;
    const width = Math.max(1.2, clamp01((z.end - z.start) / dur) * 100);
    return `<div class="tl-zoom ${z.auto ? '' : 'manual'}" data-zoom-id="${z.id}" style="left:${left}%;width:${width}%" title="${formatTime(z.start)} → ${formatTime(z.end)}">${Number(z.scale).toFixed(1)}×</div>`;
  }).join('');
  const ruler = $('#tl-ruler');
  const ticks = [];
  const step = dur <= 8 ? 1 : dur <= 20 ? 2 : dur <= 60 ? 5 : 10;
  for (let t = 0; t <= dur; t += step) {
    ticks.push(`<span style="left:${(t / dur) * 100}%">${Math.round(t)}s</span>`);
  }
  ruler.innerHTML = ticks.join('');
  $('#tl-hint').classList.toggle('hidden', (p.zooms || []).length > 0);
  updatePlayhead();
}

function updatePlayhead() {
  const pct = S.duration ? (S.time / S.duration) * 100 : 0;
  const head = $('#tl-playhead');
  if (head) head.style.left = `${clamp(pct, 0, 100)}%`;
}

function updateTimeUi() {
  $('#time-now').textContent = formatTime(S.time);
  $('#time-total').textContent = formatTime(S.duration);
  $('#tl-clip-len')?.replaceChildren(document.createTextNode(`${S.duration.toFixed(1)}s`));
}

function onTimelineClick(e) {
  if (!S.duration) return;
  const rect = $('#tl-track').getBoundingClientRect();
  const pct = clamp01((e.clientX - rect.left) / rect.width);
  seek(pct * S.duration);
}

function seek(t) {
  const clamped = clamp(t, 0, Math.max(0, S.duration - 0.001));
  S.time = clamped;
  if (S.video) S.video.currentTime = clamped;
  S.dirty = true;
  updateTimeUi();
  updatePlayhead();
}

function play() {
  if (!S.video || !S.duration) return;
  if (S.time >= S.duration - 0.02) S.time = 0;
  S.video.currentTime = S.time;
  S.video.play().catch(() => {});
  S.playing = true;
  $('#icon-play').classList.add('hidden');
  $('#icon-pause').classList.remove('hidden');
}

function pause() {
  S.playing = false;
  S.video?.pause();
  $('#icon-play').classList.remove('hidden');
  $('#icon-pause').classList.add('hidden');
  S.dirty = true;
}

// ---------------------------------------------------------------------------
// Auto zoom
// ---------------------------------------------------------------------------

function applyAutoZooms({ announce = false, silent = false } = {}) {
  const p = S.project;
  if (!p) return;
  if (!p.cursor?.length) {
    if (!silent) toast('这个项目没有光标轨迹，无法自动识别（例如导入的视频）。');
    return;
  }
  const actions = detectActions(p.cursor, { radius: 0.012, minDwell: 0.42, minGap: 0.55 });
  const auto = { ...AUTO_DEFAULTS, ...(p.auto || {}) };
  p.clicks = actions.map((a) => ({ t: a.t, nx: a.nx, ny: a.ny }));
  const manual = (p.zooms || []).filter((z) => !z.auto);
  const generated = buildZooms(actions, S.duration, auto);
  p.zooms = [...manual, ...generated].sort((a, b) => a.start - b.start);
  renderTimeline();
  renderInspector();
  S.dirty = true;
  if (announce) toast(`已生成 ${generated.length} 段自动缩放（${actions.length} 个停留点）`);
}

function addManualZoom() {
  const p = S.project;
  if (!p) return;
  const pos = nearestCursor(p.cursor, S.time) || { nx: 0.5, ny: 0.5 };
  const start = clamp(S.time, 0, Math.max(0, S.duration - 0.4));
  const end = clamp(start + 2, 0, S.duration);
  p.zooms = [...(p.zooms || []), {
    id: `mz-${Date.now().toString(36)}`,
    start: Number(start.toFixed(2)),
    end: Number(end.toFixed(2)),
    nx: pos.nx,
    ny: pos.ny,
    scale: (p.auto?.scale || AUTO_DEFAULTS.scale),
    auto: false,
  }];
  renderTimeline();
  renderInspector();
  S.dirty = true;
  toast('已添加一段手动缩放');
}

function nearestCursor(track, t) {
  if (!track?.length) return null;
  let best = null;
  let bestD = Infinity;
  for (const s of track) {
    const d = Math.abs(s.t - t);
    if (d < bestD) { best = s; bestD = d; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Captions
// ---------------------------------------------------------------------------

function addCaption() {
  const input = $('#cap-text');
  const text = (input?.value || '').trim();
  if (!text) return toast('先输入字幕文字');
  const start = clamp(S.time, 0, Math.max(0, S.duration - 0.5));
  const end = clamp(start + 2.4, 0, S.duration);
  S.project.captions = [...(S.project.captions || []), { start: Number(start.toFixed(2)), end: Number(end.toFixed(2)), text }];
  input.value = '';
  renderInspector();
  S.dirty = true;
  toast('已添加字幕');
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

let lastFrame = 0;
function tick(ts) {
  requestAnimationFrame(tick);
  const dt = ts - lastFrame;
  lastFrame = ts;
  if (S.playing && S.video) {
    S.time = S.video.currentTime;
    if (S.time >= S.duration - 0.015) {
      pause();
      seek(S.duration);
    }
    S.dirty = true;
  }
  if (S.project && S.video) {
    if (S.project.camera?.enabled && S.project.camera?.removeBg && S.project.cameraVideoEl) {
      if (SEG.ready) updateBackgroundMask(S.project.cameraVideoEl, performance.now());
      else if (!SEG.failed) ensureSegmenter();
      S.dirty = true;
    }
    if (S.dirty) {
      try {
        drawCurrent(S.time);
      } catch (err) {
        console.error('[draw]', err);
      }
      S.dirty = false;
      updateTimeUi();
      updatePlayhead();
    }
  }
  if (dt > 500) S.dirty = true; // window was hidden; repaint once
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/** Reject if the promise takes longer than ms — getUserMedia can hang forever
 *  on an unanswered permission dialog, which would freeze the whole flow. */
function ipcRendererOn(channel, cb) {
  // The preload bridge doesn't expose raw ipcRenderer; register via the
  // control-state channel pattern instead — use a tiny dedicated listener.
  return window.focusee.pipEvents.on(channel, cb);
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}超时（${ms / 1000}s）`)), ms)),
  ]);
}

function bindRecordDialog() {
  $('#opt-mic').addEventListener('change', () => {});
  $('#btn-start-record').addEventListener('click', startRecording);
  $('#modal-record').addEventListener('click', (e) => {
    if (e.target.id === 'modal-record') closeModal('modal-record');
  });
  window.focusee.capture.onStopRequested((payload) => finishRecording(payload?.mode || 'save'));
  ipcRendererOn('record:pipMoved', (p) => {
    if (S.pipLive) { S.pipLive.nx = p.nx; S.pipLive.ny = p.ny; }
  });
  ipcRendererOn('record:pipResize', (p) => {
    if (!S.pipLive) return;
    S.pipLive.size = Math.min(40, Math.max(6, (S.pipLive.size || 18) + p.delta));
    window.focusee.capture.updateControl({ pipSize: S.pipLive.size });
  });
}

async function openRecordDialog() {
  openModal('modal-record');
  S.selectedSource = null;
  $('#btn-start-record').disabled = true;
  const grid = $('#source-grid');
  grid.innerHTML = '<div class="loading">正在获取可录制画面…</div>';
  try {
    S.sources = await window.focusee.capture.sources();
    renderSources();
  } catch (err) {
    grid.innerHTML = `<div class="loading">获取失败：${escapeHtml(err.message)}</div>`;
  }
}

function renderSources() {
  const grid = $('#source-grid');
  if (!S.sources.length) {
    grid.innerHTML = '<div class="loading">没有可录制的画面</div>';
    return;
  }
  grid.innerHTML = S.sources.map((s) => `
    <div class="source-card ${S.selectedSource?.id === s.id ? 'active' : ''}" data-source="${s.id}">
      <img src="${s.thumbnail}" alt="" />
      <div class="sc-meta"><span class="sc-kind">${s.kind === 'screen' ? '屏幕' : '窗口'}</span><span class="sc-name">${escapeHtml(s.name)}</span></div>
    </div>`).join('');
  grid.querySelectorAll('[data-source]').forEach((card) => card.addEventListener('click', () => {
    S.selectedSource = S.sources.find((s) => s.id === card.dataset.source) || null;
    grid.querySelectorAll('.source-card').forEach((c) => c.classList.toggle('active', c === card));
    $('#btn-start-record').disabled = !S.selectedSource;
  }));
}

function pickMime() {
  const options = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  for (const m of options) if (window.MediaRecorder?.isTypeSupported(m)) return m;
  return '';
}

async function startRecording() {
  const source = S.selectedSource;
  if (!source) return;
  const mic = $('#opt-mic').checked;
  const countdown = $('#opt-countdown').checked;
  closeModal('modal-record');

  if (countdown) {
    for (let n = 3; n > 0; n -= 1) {
      $('#countdown-number').textContent = String(n);
      openModal('modal-countdown');
      await new Promise((r) => setTimeout(r, 700));
    }
    closeModal('modal-countdown');
    await new Promise((r) => setTimeout(r, 150));
  }

  try {
    // Screen video and microphone audio are captured as separate streams and
    // then joined: mixing a desktop video constraint with a microphone audio
    // constraint in one getUserMedia call is unreliable on macOS.
    // No maxWidth/maxHeight caps: Chromium turns them into a crop-and-scale
    // request (16:9 on a 16:10 display) and the source start frequently times
    // out on macOS. Native size keeps the frame intact and starts reliably.
    let videoStream = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= 3 && !videoStream; attempt += 1) {
      try {
        videoStream = await withTimeout(
          navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id },
            },
          }),
          15000,
          '屏幕捕获',
        );
      } catch (err) {
        lastErr = err;
        console.warn('[record] getUserMedia attempt', attempt, 'failed:', err.message);
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
    if (!videoStream) throw lastErr || new Error('无法启动屏幕捕获');
    let micStream = null;
    if (mic) {
      try {
        micStream = await withTimeout(
          navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
          }),
          12000,
          '麦克风',
        );
      } catch (err) {
        toast('麦克风未授权或不可用，将只录制画面（系统设置 → 隐私与安全性 → 麦克风）');
      }
    }
    let camStream = null;
    S.pipLive = { nx: 0.82, ny: 0.82, size: 18 };
    const withCamera = $('#opt-camera')?.checked || S.info?.forceBake;
    if (withCamera) {
      try {
        camStream = await withTimeout(
          navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
            audio: false,
          }),
          12000,
          '摄像头',
        );
      } catch (err) {
        toast('摄像头未授权或不可用，将不录制画中画（系统设置 → 隐私与安全性 → 摄像头）');
      }
    }
    if ($('#opt-teleprompter')?.checked) {
      window.focusee.teleprompter.toggle();
    }
    const tracks = [
      ...videoStream.getVideoTracks(),
      ...(micStream ? micStream.getAudioTracks() : []),
      ...(camStream ? camStream.getVideoTracks() : []),
    ];
    const stream = new MediaStream(tracks);
    const mimeType = pickMime();
    let recordSource = stream;
    let bakeCanvas = null;
    let bakeRaf = null;
    let baked = false;
    if (camStream) {
      baked = true;
      // Bake the camera PiP into the recording in real time: composite the
      // screen capture + camera onto an offscreen canvas at the screen's own
      // resolution, and record THAT — FocuSee-style, PiP visible in the take.
      const settings = videoStream.getVideoTracks()[0]?.getSettings?.() || {};
      const bw = settings.width || display.width;
      const bh = settings.height || display.height;
      bakeCanvas = document.createElement('canvas');
      bakeCanvas.width = bw;
      bakeCanvas.height = bh;
      const bctx = bakeCanvas.getContext('2d');
      const screenVideoEl = document.createElement('video');
      screenVideoEl.srcObject = videoStream;
      screenVideoEl.muted = true;
      screenVideoEl.playsInline = true;
      await screenVideoEl.play().catch(() => {});
      const camVideoEl = document.createElement('video');
      camVideoEl.srcObject = camStream;
      camVideoEl.muted = true;
      camVideoEl.playsInline = true;
      await camVideoEl.play().catch(() => {});
      const drawBakedFrame = () => {
        try {
          if (screenVideoEl.readyState >= 2) {
            bctx.drawImage(screenVideoEl, 0, 0, bw, bh);
            const cv = S.recording?.camStream ? camVideoEl : null;
            if (cv && cv.videoWidth > 0) {
              const pip = pipRectAt(bw, bh, S.pipLive.nx, S.pipLive.ny, S.pipLive.size, cv.videoWidth / cv.videoHeight);
              const d = pip.w;
              const cx = pip.x + pip.w / 2;
              const cy = pip.y + pip.h / 2;
              bctx.save();
              bctx.beginPath();
              bctx.arc(cx, cy, d / 2, 0, Math.PI * 2);
              bctx.clip();
              const cw = Math.min(cv.videoWidth, cv.videoHeight);
              bctx.drawImage(cv, (cv.videoWidth - cw) / 2, (cv.videoHeight - cw) / 2, cw, cw, pip.x, pip.y, pip.w, pip.h);
              bctx.restore();
              bctx.save();
              bctx.strokeStyle = 'rgba(255,255,255,0.7)';
              bctx.lineWidth = Math.max(2, d * 0.02);
              bctx.beginPath();
              bctx.arc(cx, cy, d / 2 - bctx.lineWidth / 2, 0, Math.PI * 2);
              bctx.stroke();
              bctx.restore();
            }
          }
        } catch {}
        bakeRaf = requestAnimationFrame(drawBakedFrame);
      };
      drawBakedFrame();
      recordSource = bakeCanvas.captureStream(30);
      if (micStream) for (const t of micStream.getAudioTracks()) recordSource.addTrack(t);
    }
    const recorder = new MediaRecorder(recordSource, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: 8_000_000,
    });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const began = await window.focusee.capture.begin();
    const display = source.display || began?.display || { width: 1680, height: 1050 };
    S.recording = {
      stream,
      videoStream,
      micStream,
      camStream,
      recorder,
      chunks,
      camChunks: camStream ? [] : null,
      baked,
      pip: { ...S.pipLive },
      mic,
      source,
      display,
      startedAt: Date.now(),
      settings: videoStream.getVideoTracks()[0]?.getSettings?.() || {},
    };
    if (camStream) {
      // Record the camera to its own file so the PiP can be re-laid-out in the
      // editor (FocuSee bakes the camera in at record time; we keep it editable).
      const camRec = new MediaRecorder(camStream, { mimeType: 'video/webm;codecs=vp8' });
      S.recording.camRecorder = camRec;
      camRec.ondataavailable = (e) => { if (e.data.size) S.recording.camChunks.push(e.data); };
      camRec.start(1000);
    }
    recorder.onstop = () => saveRecordingFrom(recorder).catch((err) => {
      console.error(err);
      toast(`保存录制失败：${err.message}`);
    });
    recorder.start(1000);
    await window.focusee.capture.showControl({
      startedAt: S.recording.startedAt,
      mic,
      withCamera: !!camStream,
      pipSize: S.recording.pip.size,
    });
    if (camStream) {
      await window.focusee.control.attachCameraPreview();
    }
    // Hide the editor while the control pill is up; the pill itself is excluded
    // from capture via content protection.
    const timer = setInterval(() => {
      if (!S.recording) return clearInterval(timer);
      const secs = (Date.now() - S.recording.startedAt) / 1000;
      window.focusee.capture.updateControl({ startedAt: S.recording.startedAt, mic, seconds: secs });
    }, 1000);
    S.recording.timer = timer;
  } catch (err) {
    console.error(err);
    closeModal('modal-record');
    toast(`录制失败：${err.message}。请检查屏幕录制权限。`);
  }
}

async function finishRecording(mode = 'save') {
  if (!S.recording) return;
  const rec = S.recording;
  const cancelled = mode === 'cancel';
  S.recording = null;
  clearInterval(rec.timer);
  try {
    if (rec.recorder.state !== 'inactive') rec.recorder.stop();
    if (rec.bakeRaf) cancelAnimationFrame(rec.bakeRaf);
    if (rec.camRecorder && rec.camRecorder.state !== 'inactive') rec.camRecorder.stop();
    rec.stream.getTracks().forEach((t) => t.stop());
    rec.videoStream?.getTracks().forEach((t) => t.stop());
    rec.micStream?.getTracks().forEach((t) => t.stop());
    rec.camStream?.getTracks().forEach((t) => t.stop());
    await window.focusee.capture.hideControl();
  } catch (err) {
    console.error(err);
  }
  if (cancelled) {
    // Discard: drop the chunks without going through saveRecording.
    rec.chunks.length = 0;
    rec.recorder.onstop = null;
    toast('录制已取消，未保存');
    return;
  }
  // saveRecording reads S.recording; hand the recorder's chunks over directly.
  await saveRecordingFrom(rec);
}

async function saveRecordingFrom(rec) {
  if (!rec || rec.saved) return;
  rec.saved = true;
  rec.recorder.onstop = null;
  const blob = new Blob(rec.chunks, { type: rec.recorder.mimeType || 'video/webm' });
  const data = new Uint8Array(await blob.arrayBuffer());
  const rawCursor = await window.focusee.capture.end();
  const display = rec.display;
  const video = rec.stream.getVideoTracks()[0]?.getSettings?.() || {};
  // Global cursor coordinates only line up with a full-screen capture. For a
  // single window the mapping needs the window's origin, which the prototype
  // does not track, so it keeps the samples out of the zoom analysis.
  const cursor = rec.source.kind === 'screen' ? normaliseCursor(rawCursor, display) : [];
  const project = {
    name: defaultProjectName(),
    videoFile: 'recording.webm',
    videoSize: { width: video.width || display.width, height: video.height || display.height },
    duration: 0,
    hasAudio: blob.type.includes('audio') || rec.mic,
    style: { ...DEFAULT_STYLE },
    zooms: [],
    cursor,
    clicks: [],
    captions: [],
    cursorFx: { enabled: true, highlight: false, color: '#ffd166' },
    data,
  };
  const saved = await window.focusee.projects.importVideo({ id: uid('rec'), video: project, cursor });
  // Persist the camera take beside the screen recording (id known only now).
  let camSaved = false;
  if (rec.camRecorder && rec.camChunks?.length) {
    try {
      const camBlob = new Blob(rec.camChunks, { type: 'video/webm' });
      await window.focusee.camera.save(saved.id, new Uint8Array(await camBlob.arrayBuffer()));
      saved.cameraFile = 'camera.webm';
      saved.camera = { enabled: true, layout: 'bottom-right', size: 18 };
      camSaved = true;
    } catch (err) {
      console.warn('[camera] save failed', err);
    }
  }
  await refreshProjects();
  renderHome();
  await openProject(saved.id);
  if (camSaved && S.project) {
    S.project.cameraFile = 'camera.webm';
    S.project.camera = {
      enabled: true, layout: 'bottom-right', size: 18,
      baked: rec.baked === true, // recording already contains the PiP
      nx: rec.pip?.nx, ny: rec.pip?.ny,
      forceOverlay: false,
    };
    await window.focusee.projects.save(stripRuntime(S.project));
  }
  // Duration comes from the decoded video; persist it for the project list.
  if (S.video?.duration) {
    S.project.duration = S.video.duration;
    await window.focusee.projects.save(stripRuntime(S.project));
    S.duration = S.video.duration;
    S.project.zooms = [];
    applyAutoZooms({ silent: true });
    await window.focusee.projects.save(stripRuntime(S.project));
    renderTimeline();
  }
  toast(`录制完成：${cursor.length} 个光标采样点`);
}

function defaultProjectName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `录制 ${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function stripRuntime(project) {
  const { data, cameraVideoEl, ...rest } = project;
  return rest;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

async function importVideo() {
  const file = await window.focusee.projects.openVideoDialog();
  if (!file) return;
  try {
    const media = await window.focusee.projects.readVideoFile(file);
    const ext = media.name.split('.').pop().toLowerCase();
    const videoFile = `recording.${ext}`;
    const project = {
      name: media.name.replace(/\.[^.]+$/, ''),
      videoFile,
      videoSize: { width: 0, height: 0 },
      duration: 0,
      hasAudio: true,
      style: { ...DEFAULT_STYLE },
      zooms: [],
      cursor: [],
      clicks: [],
      captions: [],
      cursorFx: { enabled: true, highlight: false, color: '#ffd166' },
      data: media.data,
    };
    const saved = await window.focusee.projects.importVideo({ id: uid('imp'), video: project, cursor: [] });
    await refreshProjects();
    await openProject(saved.id);
    if (S.video?.duration) {
      S.project.duration = S.video.duration;
      S.project.videoSize = { width: S.video.videoWidth, height: S.video.videoHeight };
      await window.focusee.projects.save(stripRuntime(S.project));
      S.duration = S.video.duration;
      renderTimeline();
    }
    toast('已导入视频。导入的视频没有光标轨迹，自动缩放不可用，可手动加缩放。');
  } catch (err) {
    console.error(err);
    toast(`导入失败：${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function bindExportDialog() {
  $('#btn-export-go').addEventListener('click', () => runExportFromDialog());
  $('#btn-export-close').addEventListener('click', () => { if (!S.export.running) closeModal('modal-export'); });
  $('#btn-export-cancel').addEventListener('click', () => {
    if (S.export.running) { S.export.cancelled = true; return; }
    closeModal('modal-export');
  });
}

function openExportDialog() {
  if (!S.project) return;
  $('#export-progress').classList.add('hidden');
  $('#btn-export-go').disabled = false;
  $('#export-format').querySelector('option[value="mp4"]').disabled = !S.info.ffmpeg;
  openModal('modal-export');
}

async function runExportFromDialog() {
  if (S.export.running) return;
  const [w, h] = $('#export-size').value.split('x').map(Number);
  const fps = Number($('#export-fps').value);
  const format = $('#export-format').value;
  const res = await runExport({ width: w, height: h, fps, format, ui: true });
  if (res) toast(`已导出：${res}`);
}

async function runExport({ width, height, fps, format, ui = false, silent = false }) {
  if (!S.project || !S.video) return null;
  if (S.export.running) return null;
  pause();
  S.export.running = true;
  S.export.cancelled = false;
  S.export.progress = 0;
  if (ui) {
    $('#export-progress').classList.remove('hidden');
    $('#btn-export-go').disabled = true;
    $('#export-status').textContent = '准备导出…';
    $('#export-bar').style.width = '0%';
  }

  const outCanvas = document.createElement('canvas');
  outCanvas.width = width;
  outCanvas.height = height;
  const outCtx = outCanvas.getContext('2d', { alpha: false });

  // Route the recording's audio into the exported stream while keeping the
  // preview audible: the media element source feeds both destinations.
  let audioTracks = [];
  if (!S.audioCtx) {
    try {
      S.audioCtx = new AudioContext();
      S.audioSource = S.audioCtx.createMediaElementSource(S.video);
      S.audioDest = S.audioCtx.createMediaStreamDestination();
      S.audioSource.connect(S.audioCtx.destination);
      S.audioSource.connect(S.audioDest);
    } catch (err) {
      console.warn('audio graph unavailable', err);
      S.audioCtx = null;
    }
  }
  if (S.audioDest) audioTracks = S.audioDest.stream.getAudioTracks();

  const stream = outCanvas.captureStream(fps);
  for (const t of audioTracks) stream.addTrack(t);
  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find((m) => MediaRecorder.isTypeSupported(m)) || 'video/webm';
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise((resolve) => { rec.onstop = resolve; });

  S.video.pause();
  S.video.currentTime = 0;
  await new Promise((resolve) => {
    const done = () => { S.video.removeEventListener('seeked', done); resolve(); };
    S.video.addEventListener('seeked', done);
    setTimeout(done, 260);
  });

  rec.start(250);
  await S.video.play().catch(() => {});

  // Render the composition in real time (MediaRecorder captures the canvas
  // stream as it is painted), which also makes the UI progress meaningful.
  await new Promise((resolve) => {
    const frame = () => {
      const t = S.video.currentTime;
      if (S.export.cancelled || (t >= S.duration - 0.02 && t > 0)) {
        resolve();
        return;
      }
      drawFrame(outCtx, {
        width,
        height,
        project: S.project,
        video: S.video,
        time: t,
        preview: false,
      });
      const pct = clamp01(t / Math.max(0.001, S.duration));
      S.export.progress = Math.max(S.export.progress, pct);
      if (ui) {
        $('#export-bar').style.width = `${Math.round(pct * 100)}%`;
        $('#export-status').textContent = `正在渲染 ${Math.round(pct * 100)}%`;
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });

  S.video.pause();
  try { if (rec.state !== 'inactive') rec.stop(); } catch {}
  await stopped;
  closeMediaStream(stream);

  const blob = new Blob(chunks, { type: mime });
  const data = new Uint8Array(await blob.arrayBuffer());
  let savedPath = null;
  try {
    if (silent) {
      savedPath = await window.focusee.exporter.tempFile(`focusee-export-${width}x${height}.webm`, data);
    } else {
      savedPath = await window.focusee.exporter.saveWebm(`focusee-export-${width}x${height}.webm`, data);
      if (savedPath && format === 'mp4' && S.info.ffmpeg) {
        if (ui) $('#export-status').textContent = '转码 MP4…';
        savedPath = await window.focusee.exporter.toMp4(savedPath);
      }
    }
  } catch (err) {
    console.error(err);
    toast(`导出失败：${err.message}`);
    savedPath = null;
  }

  S.export.running = false;
  if (ui) {
    $('#export-bar').style.width = '100%';
    $('#export-status').textContent = savedPath ? `完成：${savedPath}` : '已取消';
    $('#btn-export-go').disabled = false;
    setTimeout(() => closeModal('modal-export'), savedPath ? 1600 : 500);
  }
  if (savedPath && !silent) toast(`已导出：${savedPath}`);
  seek(0);
  return savedPath;
}

function closeMediaStream(stream) {
  try {
    for (const track of stream.getTracks()) {
      // Never stop the shared audio track; it belongs to the audio graph.
      if (track.kind === 'video') track.stop();
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function openSettings() {
  const info = S.info || {};
  $('#settings-body').innerHTML = `
    <div class="kv"><span>原型版本</span><span>${info.version || '—'}（Electron ${info.electron || '—'}）</span></div>
    <div class="kv"><span>数据目录</span><code>${escapeHtml(info.dataRoot || '')}</code></div>
    <div class="kv"><span>ffmpeg</span><span>${info.ffmpeg ? '已找到，可导出 MP4' : '未找到（仅 WebM）'}</span></div>
    <div class="kv"><span>屏幕录制权限</span><span>录制时由系统询问</span></div>
    <div class="kv"><span>研究方式</span><span>Craft Anything 净室（可见界面/控件树）</span></div>
    <p class="hint">本项目是学习用复刻，不包含 FocuSee 的代码、图标或素材；不绕过任何 DRM/登录。</p>`;
  openModal('modal-settings');
}

// ---------------------------------------------------------------------------
// E2E API
// ---------------------------------------------------------------------------

function exposeTestApi() {
  window.__focuseeTest = {
    ready: () => true,
    openSample: async () => { await openProject('sample', { sample: true }); return true; },
    selectTab: (t) => { selectTab(t); return t; },
    previewZoom: (t) => { seek(t); S.dirty = true; return t; },
    summary: () => ({
      project: S.project?.name || null,
      duration: Number(S.duration?.toFixed?.(2) || S.duration),
      canvas: [S.canvasW, S.canvasH],
      zooms: (S.project?.zooms || []).map((z) => ({ start: z.start, end: z.end, scale: z.scale, auto: z.auto })),
      clicks: S.project?.clicks?.length || 0,
      cursorSamples: S.project?.cursor?.length || 0,
      tab: S.tab,
      style: S.project?.style,
      playing: S.playing,
    }),
    exportPreview: async () => {
      const path = await runExport({ width: 960, height: 540, fps: 24, format: 'webm', silent: true, ui: false });
      return { path, bytes: path ? 0 : null };
    },
  };
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

boot().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<pre style="padding:24px;font:12px/1.6 monospace;color:#b00">启动失败：${escapeHtml(err.message)}</pre>`;
});
