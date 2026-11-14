// Pure geometry + auto-zoom maths.
// Kept free of DOM and Electron APIs so the same code powers the renderer,
// the export pipeline and the Node unit tests.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const lerp = (a, b, t) => a + (b - a) * t;

const smoothstep = (x) => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};

const ASPECTS = {
  original: null,
  '16:9': 16 / 9,
  '1:1': 1,
  '4:3': 4 / 3,
  '9:16': 9 / 16,
};

function dist(a, b) {
  const dx = a.nx - b.nx;
  const dy = a.ny - b.ny;
  return Math.hypot(dx, dy);
}

/**
 * Find "actions" in a cursor track: moments where the pointer stayed inside a
 * small radius long enough to be a meaningful pause (a click, typing pause, or
 * the human aiming at a control). FocuSee zooms on real clicks; without an OS
 * event tap this prototype uses dwell clusters, which is documented as a
 * behavioural difference.
 *
 * @param {{t:number,nx:number,ny:number}[]} samples normalised cursor track
 * @param {{radius?:number,minDwell?:number,minGap?:number}} [opts]
 * @returns {{t:number,nx:number,ny:number,dwell:number}[]}
 */
function detectActions(samples, opts = {}) {
  const radius = opts.radius ?? 0.012;
  const minDwell = opts.minDwell ?? 0.45;
  const minGap = opts.minGap ?? 0.6;
  if (!Array.isArray(samples) || samples.length < 3) return [];

  const actions = [];
  let i = 0;
  while (i < samples.length) {
    const anchor = samples[i];
    let j = i;
    while (j + 1 < samples.length && dist(samples[j + 1], anchor) <= radius) j += 1;
    const span = samples[j].t - samples[i].t;
    if (span >= minDwell) {
      const mid = samples[Math.floor((i + j) / 2)];
      const t = (samples[i].t + samples[j].t) / 2;
      const last = actions[actions.length - 1];
      if (!last || t - last.t > minGap) {
        actions.push({
          t: Number(t.toFixed(3)),
          nx: Number(mid.nx.toFixed(5)),
          ny: Number(mid.ny.toFixed(5)),
          dwell: Number(span.toFixed(3)),
        });
      }
    }
    i = j + 1;
  }
  return actions;
}

/**
 * Turn actions into zoom keyframe segments.
 *
 * @param {{t:number,nx:number,ny:number,dwell?:number}[]} actions
 * @param {number} duration seconds
 * @param {{scale?:number,hold?:number,lead?:number,minGap?:number,maxZooms?:number}} [opts]
 * @returns {{id:string,start:number,end:number,nx:number,ny:number,scale:number,auto:boolean}[]}
 */
function buildZooms(actions, duration, opts = {}) {
  const scale = opts.scale ?? 1.8;
  const hold = opts.hold ?? 1.35;
  const lead = opts.lead ?? 0.55;
  const ease = opts.ease ?? 0.35;
  const minGap = opts.minGap ?? 0.4;
  const maxZooms = opts.maxZooms ?? 16;
  const dur = Number.isFinite(duration) ? duration : 0;

  const raw = (actions || [])
    .filter((a) => a && Number.isFinite(a.t))
    .map((a) => {
      const start = clamp(a.t - lead, 0, Math.max(0, dur));
      const end = clamp(a.t + hold + ease, 0, Math.max(0, dur));
      return {
        start: Number(start.toFixed(3)),
        end: Number(end.toFixed(3)),
        nx: clamp(a.nx ?? 0.5, 0, 1),
        ny: clamp(a.ny ?? 0.5, 0, 1),
        scale,
        auto: true,
        dwell: a.dwell ?? 0,
      };
    })
    .filter((z) => z.end - z.start >= easyMin(ease));

  const merged = [];
  for (const z of raw) {
    const prev = merged[merged.length - 1];
    // Merge only when the two envelopes truly overlap. A gap (even a small
    // one) means the viewer gets a moment back at scale 1 between zooms.
    if (prev && prev.end >= z.start) {
      if ((z.dwell || 0) > (prev.dwell || 0)) {
        prev.nx = z.nx;
        prev.ny = z.ny;
        prev.dwell = z.dwell;
      }
      prev.end = Math.max(prev.end, z.end);
      prev.scale = Math.max(prev.scale, z.scale);
    } else {
      merged.push({ ...z });
    }
  }

  return merged.slice(0, maxZooms).map((z, idx) => {
    const { dwell, ...rest } = z;
    return { id: `az-${idx + 1}`, ...rest };
  });
}

function easyMin(ease) {
  return Math.min(0.35, Math.max(0.12, ease)) + 0.12;
}

/**
 * Current zoom state at time t. Returns scale 1 and centre .5/.5 when no zoom
 * is active. Uses smoothstep envelopes so transitions never snap.
 */
function zoomAt(zooms, t) {
  const base = { scale: 1, nx: 0.5, ny: 0.5, active: null };
  if (!Array.isArray(zooms) || !zooms.length) return base;
  let best = null;
  let bestW = 0;
  for (const z of zooms) {
    if (!Number.isFinite(z.start) || !Number.isFinite(z.end)) continue;
    if (t < z.start || t > z.end) continue;
    const span = z.end - z.start;
    const ease = Math.min(0.35, span / 2);
    const inW = smoothstep((t - z.start) / Math.max(ease, 1e-6));
    const outW = 1 - smoothstep((t - (z.end - ease)) / Math.max(ease, 1e-6));
    const w = Math.min(inW, outW);
    if (w > bestW) {
      bestW = w;
      best = { z, w };
    }
  }
  if (!best || bestW <= 0.0001) return base;
  return {
    scale: 1 + (best.z.scale - 1) * bestW,
    nx: lerp(0.5, best.z.nx, bestW),
    ny: lerp(0.5, best.z.ny, bestW),
    active: best.z.id ?? null,
  };
}

/**
 * Source rectangle (in video pixels) for a zoom state. Keeps the rectangle
 * inside the video frame so panning never reveals the background.
 */
function sourceRectAt(zoom, videoW, videoH) {
  const scale = Math.max(1, zoom?.scale ?? 1);
  const sw = videoW / scale;
  const sh = videoH / scale;
  const cx = clamp((zoom?.nx ?? 0.5) * videoW, sw / 2, videoW - sw / 2);
  const cy = clamp((zoom?.ny ?? 0.5) * videoH, sh / 2, videoH - sh / 2);
  return { sx: cx - sw / 2, sy: cy - sh / 2, sw, sh, scale };
}

/** Letterbox `src` inside `outer`, centring it. */
function fitRect(outerW, outerH, srcW, srcH) {
  if (srcW <= 0 || srcH <= 0) return { x: 0, y: 0, w: outerW, h: outerH };
  const scale = Math.min(outerW / srcW, outerH / srcH);
  const w = srcW * scale;
  const h = srcH * scale;
  return { x: (outerW - w) / 2, y: (outerH - h) / 2, w, h };
}

/**
 * The framed "screen" rectangle inside the output canvas: full bleed for
 * "original", or a centred box of the chosen aspect for preset ratios.
 */
function contentRect(canvasW, canvasH, paddingPct = 0, aspect = 'original') {
  const pad = Math.round((Math.min(canvasW, canvasH) * clamp(paddingPct, 0, 40)) / 100);
  const inner = { x: pad, y: pad, w: canvasW - pad * 2, h: canvasH - pad * 2 };
  const ratio = ASPECTS[aspect];
  if (!ratio) return inner;
  const innerRatio = inner.w / inner.h;
  if (innerRatio > ratio) {
    const h = inner.h;
    const w = h * ratio;
    return { x: inner.x + (inner.w - w) / 2, y: inner.y, w, h };
  }
  const w = inner.w;
  const h = w / ratio;
  return { x: inner.x, y: inner.y + (inner.h - h) / 2, w, h };
}

/** Map a normalised video point into canvas space for a given zoom + rect. */
function mapPointToCanvas(nx, ny, zoom, destRect, videoW, videoH) {
  const src = sourceRectAt(zoom, videoW, videoH);
  const px = (clamp(nx, 0, 1) * videoW - src.sx) / src.sw;
  const py = (clamp(ny, 0, 1) * videoH - src.sy) / src.sh;
  return {
    x: destRect.x + px * destRect.w,
    y: destRect.y + py * destRect.h,
    visible: px >= 0 && px <= 1 && py >= 0 && py <= 1,
  };
}

/** Format seconds as MM:SS.cc for the transport bar. */
function formatTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${String(m).padStart(2, '0')}:${rest.toFixed(2).padStart(5, '0')}`;
}

/** Normalise a raw screen-space cursor track against the recorded display. */
function normaliseCursor(samples, display) {
  const w = Math.max(1, display?.width || 1);
  const h = Math.max(1, display?.height || 1);
  return (samples || [])
    .filter((s) => Number.isFinite(s.t) && Number.isFinite(s.x) && Number.isFinite(s.y))
    .map((s) => ({
      t: Number(s.t.toFixed(3)),
      nx: Number(clamp(s.x / w, 0, 1).toFixed(5)),
      ny: Number(clamp(s.y / h, 0, 1).toFixed(5)),
    }));
}

/** Cursor point at a time (linear interpolation), or null. */
function cursorAt(track, t) {
  if (!Array.isArray(track) || !track.length) return null;
  if (t <= track[0].t) return track[0];
  if (t >= track[track.length - 1].t) return track[track.length - 1];
  let lo = 0;
  let hi = track.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (track[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = track[lo];
  const b = track[hi];
  const span = b.t - a.t || 1;
  const k = (t - a.t) / span;
  return { t, nx: lerp(a.nx, b.nx, k), ny: lerp(a.ny, b.ny, k) };
}

// ---------------------------------------------------------------------------
// Camera picture-in-picture layouts + 3D tilt (pure geometry, unit-tested)
// ---------------------------------------------------------------------------

/** Camera PiP layout presets. margin is a fraction of the shorter canvas side. */
const CAMERA_LAYOUTS = {
  'bottom-right': { anchor: ['right', 'bottom'], margin: 0.06 },
  'bottom-left': { anchor: ['left', 'bottom'], margin: 0.06 },
  'top-right': { anchor: ['right', 'top'], margin: 0.06 },
  'top-left': { anchor: ['left', 'top'], margin: 0.06 },
  'bottom-center': { anchor: ['center', 'bottom'], margin: 0.05 },
};

/**
 * Rectangle for the camera PiP inside the output canvas.
 *
 * @param {string} layout one of CAMERA_LAYOUTS keys
 * @param {number} canvasW output width
 * @param {number} canvasH output height
 * @param {number} sizePct 4..40 — camera width as a percentage of canvas width
 * @param {number} camAspect camera video aspect (width/height), default 4/3
 * @returns {{x:number,y:number,w:number,h:number,radius:number,shape:'circle'|'rounded'}}
 */
function computeCameraRect(layout, canvasW, canvasH, sizePct, camAspect = 4 / 3) {
  const preset = CAMERA_LAYOUTS[layout] || CAMERA_LAYOUTS['bottom-right'];
  const W = Math.max(1, canvasW);
  const H = Math.max(1, canvasH);
  let w = clamp((W * clamp(Number(sizePct) || 18, 4, 40)) / 100, 8, W * 0.45);
  const ratio = clamp(Number(camAspect) || 4 / 3, 0.5, 3);
  let h = w / ratio;
  const maxH = H * 0.6;
  if (h > maxH) { h = maxH; w = h * ratio; }
  const [ax, ay] = preset.anchor;
  const margin = (Math.min(W, H) * preset.margin);
  const x = ax === 'left' ? margin : ax === 'center' ? (W - w) / 2 : W - w - margin;
  const y = ay === 'top' ? margin : H - h - margin;
  // Corner layouts use a circle; bottom-center uses a wide rounded card.
  const isCorner = ax !== 'center';
  return {
    x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h),
    radius: Math.round(Math.min(w, h) / (isCorner ? 2 : 6)),
    shape: isCorner ? 'circle' : 'rounded',
  };
}

/**
 * Perspective-tilt mapping: given the source rectangle and a tilt amount
 * (-1..1), returns per-column destination heights for a slice-based trapezoid
 * render (fake 3D rotation around the vertical axis). Positive tilt shrinks
 * the right edge (rotate right).
 *
 * @returns {{columns:number, slices:[{sx:number,sw:number, dx:number, dyTop:number, dyBot:number, dw:number}]}}
 */
function tiltSlices(rect, tilt, columns = 32) {
  const t = clamp(Number(tilt) || 0, -1, 1);
  const n = Math.max(4, Math.round(columns));
  const slices = [];
  const shrink = Math.abs(t) * 0.14; // max 14% height change on the far edge
  const cy = rect.y + rect.h / 2;
  for (let i = 0; i < n; i += 1) {
    const f0 = i / n;
    const f1 = (i + 1) / n;
    // Height factor at each column EDGE: 1 near the pivot edge, 1-shrink far.
    // Top/bottom use the edge factors directly so the outermost edges keep
    // their exact geometry (h=1 at the pivot edge).
    const h0 = 1 - shrink * (t > 0 ? f0 : 1 - f0);
    const h1 = 1 - shrink * (t > 0 ? f1 : 1 - f1);
    slices.push({
      sx: rect.w * f0,
      sw: rect.w / n + 0.6,
      dx: rect.x + rect.w * f0,
      dyTop: cy - (rect.h * h0) / 2,
      dyBot: cy + (rect.h * h1) / 2,
      dw: rect.w / n + 0.6,
    });
  }
  return { columns: n, slices };
}

/**
 * Active camera settings at a time: the last segment covering `time` wins,
 * falling back to the project defaults.
 *
 * @param {{layout?:string,size?:number,segments?:{start:number,end:number,layout?:string,size?:number}[]}} camera
 * @param {number} time
 * @returns {{layout:string,size:number,segmentId:string|null}}
 */
function activeCameraSettings(camera, time) {
  const base = {
    layout: camera?.layout || 'bottom-right',
    size: clamp(Number(camera?.size) || 18, 4, 40),
    segmentId: null,
  };
  const segs = Array.isArray(camera?.segments) ? camera.segments : [];
  let best = null;
  for (const seg of segs) {
    if (!seg || !Number.isFinite(seg.start) || !Number.isFinite(seg.end)) continue;
    if (time >= seg.start && time <= seg.end && (!best || seg.start >= best.start)) best = seg;
  }
  if (!best) return base;
  return {
    layout: best.layout || base.layout,
    size: clamp(Number(best.size) || base.size, 4, 40),
    segmentId: best.id || null,
  };
}

/**
 * PiP rectangle for live (baked-into-recording) camera compositing: anchored
 * at a free normalized centre point, circle diameter = sizePct of canvas width.
 *
 * @returns {{x:number,y:number,w:number,h:number}}
 */
function pipRectAt(canvasW, canvasH, nx, ny, sizePct, camAspect = 4 / 3) {
  const W = Math.max(1, canvasW);
  const H = Math.max(1, canvasH);
  const d = clamp((W * clamp(Number(sizePct) || 18, 6, 40)) / 100, 24, W * 0.45);
  const w = d;
  const h = d / clamp(Number(camAspect) || 4 / 3, 0.5, 3);
  const x = clamp(nx * W - w / 2, 4, W - w - 4);
  const y = clamp(ny * H - h / 2, 4, H - h - 4);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

module.exports = {
  clamp,
  lerp,
  smoothstep,
  ASPECTS,
  detectActions,
  buildZooms,
  zoomAt,
  sourceRectAt,
  fitRect,
  contentRect,
  mapPointToCanvas,
  formatTime,
  normaliseCursor,
  cursorAt,
  CAMERA_LAYOUTS,
  computeCameraRect,
  tiltSlices,
  activeCameraSettings,
  pipRectAt,
};
