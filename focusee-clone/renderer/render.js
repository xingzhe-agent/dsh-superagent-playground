// Canvas renderer for the framed, auto-zoomed recording.
// One function draws both the interactive preview and the exported frames.

import {
  contentRect, fitRect, sourceRectAt, zoomAt, cursorAt, clamp, mapPointToCanvas,
  computeCameraRect, tiltSlices, activeCameraSettings,
} from './zoom.js';

export const BACKGROUNDS = [
  { id: 'gradient-violet', label: '暮光', kind: 'gradient', stops: ['#7b61ff', '#4b34c9', '#241b64'], angle: 145 },
  { id: 'gradient-mint', label: '薄荷', kind: 'gradient', stops: ['#d9f7ea', '#a5e6c8', '#6fd3a4'], angle: 160 },
  { id: 'gradient-sunset', label: '日落', kind: 'gradient', stops: ['#ffd9a0', '#ff9d7a', '#e85f8a'], angle: 150 },
  { id: 'gradient-sky', label: '天空', kind: 'gradient', stops: ['#dbe9ff', '#b7cdff', '#8aa8f8'], angle: 155 },
  { id: 'gradient-graphite', label: '石墨', kind: 'gradient', stops: ['#3a3f52', '#22252f', '#12141b'], angle: 160 },
  { id: 'gradient-rose', label: '玫瑰', kind: 'gradient', stops: ['#ffe4ef', '#ffc0d6', '#f48fb4'], angle: 150 },
  { id: 'gradient-sand', label: '沙丘', kind: 'gradient', stops: ['#fff3dd', '#f7ddb0', '#e6be7d'], angle: 155 },
  { id: 'gradient-ocean', label: '深海', kind: 'gradient', stops: ['#0f3f5c', '#0c2a44', '#071626'], angle: 150 },
  { id: 'gradient-lilac', label: '雾紫', kind: 'gradient', stops: ['#f1ebff', '#ded2ff', '#c3b1ff'], angle: 150 },
  { id: 'gradient-peach', label: '蜜桃', kind: 'gradient', stops: ['#fff1e8', '#ffd8c2', '#ffb894'], angle: 150 },
  { id: 'solid-slate', label: '深灰', kind: 'solid', color: '#23262f' },
  { id: 'solid-white', label: '纯白', kind: 'solid', color: '#ffffff' },
];

export function backgroundById(id) {
  return BACKGROUNDS.find((b) => b.id === id) || BACKGROUNDS[0];
}

/** Resolve the style's background, including a custom solid colour. */
export function resolveBackground(style) {
  if (style && style.background === 'solid-custom') {
    return { id: 'solid-custom', kind: 'solid', color: style.bgColor || '#23262f' };
  }
  return backgroundById(style && style.background);
}

export function backgroundCss(bg) {
  if (!bg) return '#23262f';
  if (bg.kind === 'solid') return bg.color;
  return `linear-gradient(${bg.angle}deg, ${bg.stops.join(', ')})`;
}

export function loadVideoElement(src) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'auto';
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    video.muted = false;
    video.src = src;
    const done = async () => {
      video.removeEventListener('loadedmetadata', done);
      video.removeEventListener('error', fail);
      // MediaRecorder WebM files carry no duration header: the element reports
      // Infinity (or 0). Force a seek to the end so the demuxer finds the real
      // duration, then rewind — the standard workaround for live-recorded WebM.
      if (!Number.isFinite(video.duration) || video.duration === 0) {
        try {
          await new Promise((r) => {
            const onSeeked = () => {
              video.removeEventListener('seeked', onSeeked);
              r();
            };
            video.addEventListener('seeked', onSeeked);
            video.currentTime = 1e101;
            setTimeout(r, 1500); // some builds never fire seeked; don't hang
          });
          video.currentTime = 0;
        } catch {}
      }
      resolve(video);
    };
    const fail = () => {
      video.removeEventListener('loadedmetadata', done);
      video.removeEventListener('error', fail);
      reject(new Error('video metadata failed to load'));
    };
    video.addEventListener('loadedmetadata', done);
    video.addEventListener('error', fail);
  });
}

function roundRectPath(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function drawBackground(ctx, W, H, style, video) {
  const bg = resolveBackground(style);
  if (bg.kind === 'solid') {
    ctx.fillStyle = bg.color;
    ctx.fillRect(0, 0, W, H);
  } else {
    const angle = ((bg.angle ?? 150) * Math.PI) / 180;
    const x0 = W / 2 - (Math.cos(angle) * W) / 2;
    const y0 = H / 2 - (Math.sin(angle) * H) / 2;
    const x1 = W / 2 + (Math.cos(angle) * W) / 2;
    const y1 = H / 2 + (Math.sin(angle) * H) / 2;
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    const stops = bg.stops;
    stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // Soft glow behind the framed screen, plus an optional blurred copy of the
  // recording — FocuSee's "背景模糊" control works the same way.
  const blur = Number(style.blur) || 0;
  if (blur > 0 && video && video.videoWidth) {
    const scale = Math.max(W / video.videoWidth, H / video.videoHeight) * 1.12;
    const dw = video.videoWidth * scale;
    const dh = video.videoHeight * scale;
    ctx.save();
    ctx.globalAlpha = Math.min(1, 0.55 + blur / 120);
    ctx.filter = `blur(${Math.max(4, blur * 1.6)}px) saturate(0.9) brightness(0.82)`;
    ctx.drawImage(video, (W - dw) / 2, (H - dh) / 2, dw, dh);
    ctx.restore();
  }

  const vignette = ctx.createRadialGradient(W / 2, H * 0.42, Math.min(W, H) * 0.2, W / 2, H / 2, Math.max(W, H) * 0.75);
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.20)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, W, H);
}

/**
 * Draw one frame.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} opts
 * @param {number} opts.width output width in px
 * @param {number} opts.height output height in px
 * @param {object} opts.project project model
 * @param {HTMLVideoElement} opts.video
 * @param {number} opts.time seconds
 * @param {boolean} [opts.preview]
 * @returns {{dest:{x:number,y:number,w:number,h:number},zoom:object,content:object}|null}
 */
export function drawFrame(ctx, { width, height, project, video, time, preview = false }) {
  const style = project.style || {};
  const W = width;
  const H = height;
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  drawBackground(ctx, W, H, style, preview ? video : video);

  const content = contentRect(W, H, style.padding ?? 4, style.aspect || 'original');
  const ready = video && video.videoWidth > 0;
  const vw = ready ? video.videoWidth : 16;
  const vh = ready ? video.videoHeight : 10;
  const dest = fitRect(content.w, content.h, vw, vh);
  const dx = content.x + dest.x;
  const dy = content.y + dest.y;
  const rect = { x: dx, y: dy, w: dest.w, h: dest.h };

  const radius = ((Number(style.radius) || 0) / 100) * Math.min(rect.w, rect.h) * 2.6;
  const shadow = clamp(Number(style.shadow) || 0, 0, 100) / 100;

  if (shadow > 0.01) {
    ctx.save();
    ctx.shadowColor = `rgba(8, 10, 20, ${0.18 + shadow * 0.35})`;
    ctx.shadowBlur = 12 + shadow * 70;
    ctx.shadowOffsetY = 4 + shadow * 26;
    ctx.fillStyle = '#0b0d14';
    roundRectPath(ctx, rect.x, rect.y, rect.w, rect.h, radius);
    ctx.fill();
    ctx.restore();
  }

  const zoom = zoomAt(project.zooms || [], time);
  const src = sourceRectAt(zoom, vw, vh);

  const tilt = clamp((Number(style.tilt3d) || 0), -100, 100) / 100;
  // Cursor-driven tilt: the far edge follows the pointer's horizontal position.
  let tiltAmount = tilt;
  if (style.tiltFollow && project.cursor?.length) {
    const pos = cursorAt(project.cursor, time);
    if (pos) tiltAmount = clamp(tiltAmount + (pos.nx - 0.5) * 0.9, -1, 1);
  }

  ctx.save();
  roundRectPath(ctx, rect.x, rect.y, rect.w, rect.h, radius);
  ctx.clip();
  ctx.fillStyle = '#0b0d14';
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  if (ready) {
    try {
      if (Math.abs(tiltAmount) > 0.02) {
        // Slice-based perspective: draw the cropped frame column by column,
        // interpolating each column's height — a real trapezoid, not a skew.
        const srcH = src.sh;
        for (const sl of tiltSlices(rect, tiltAmount).slices) {
          const syTop = src.sy;
          const syH = srcH * ((sl.dyBot - sl.dyTop) / rect.h);
          const syOff = srcH * ((sl.dyTop - rect.y) / rect.h);
          ctx.drawImage(
            video,
            src.sx + sl.sx, src.sy + syOff, sl.sw, syH,
            sl.dx, sl.dyTop, sl.dw, sl.dyBot - sl.dyTop,
          );
        }
      } else {
        ctx.drawImage(video, src.sx, src.sy, src.sw, src.sh, rect.x, rect.y, rect.w, rect.h);
      }
    } catch {
      // Video can be mid-seek; the next frame will paint it.
    }
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  }
  ctx.restore();

  // Inner border
  const border = Number(style.border) || 0;
  if (border > 0) {
    const bw = Math.max(1, (border / 100) * Math.min(rect.w, rect.h) * 0.16);
    ctx.save();
    roundRectPath(ctx, rect.x + bw / 2, rect.y + bw / 2, rect.w - bw, rect.h - bw, Math.max(0, radius - bw / 2));
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = bw;
    ctx.stroke();
    ctx.restore();
  }

  // Cursor emphasis: expanding ripple at each detected action.
  const fx = project.cursorFx || {};
  if (fx.enabled !== false) {
    const clicks = project.clicks || [];
    for (const c of clicks) {
      const dt = time - c.t;
      if (dt < -0.05 || dt > 0.62) continue;
      const p = mapPointToCanvas(c.nx, c.ny, zoom, rect, vw, vh);
      if (!p.visible) continue;
      const k = clamp(dt / 0.62, 0, 1);
      const ringR = 6 + k * 34;
      ctx.save();
      ctx.globalAlpha = (1 - k) * 0.85;
      ctx.strokeStyle = fx.color || '#ffd166';
      ctx.lineWidth = Math.max(1.5, 3.4 * (1 - k));
      ctx.beginPath();
      ctx.arc(p.x, p.y, ringR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = (1 - k) * 0.35;
      ctx.fillStyle = fx.color || '#ffd166';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // A soft highlight around the live pointer position (optional).
    if (fx.highlight && project.cursor?.length) {
      const pos = cursorAt(project.cursor, time);
      if (pos) {
        const p = mapPointToCanvas(pos.nx, pos.ny, zoom, rect, vw, vh);
        if (p.visible) {
          ctx.save();
          ctx.globalAlpha = 0.35;
          const g = ctx.createRadialGradient(p.x, p.y, 2, p.x, p.y, 34);
          g.addColorStop(0, 'rgba(255, 214, 102, 0.85)');
          g.addColorStop(1, 'rgba(255, 214, 102, 0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 34, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }
    }
  }

  // Camera picture-in-picture (FocuSee's 摄像头画中画 / 镜头布局 / 布局片段).
  const camBase = { ...(project.camera || {}) };
  const camVideo = project.cameraVideoEl || null;
  // camera.baked = the take already has the PiP composited in; skip drawing it
  // again unless the person explicitly re-overlays (forceOverlay).
  if (camBase.baked && !camBase.forceOverlay) camBase.enabled = false;
  const camActive = activeCameraSettings(camBase, time);
  const camReady = camBase.enabled && camVideo && camVideo.videoWidth > 0;
  if (camReady) {
    const camRect = computeCameraRect(camActive.layout, W, H, camActive.size, camVideo.videoWidth / camVideo.videoHeight);
    const shadow2 = 0.35;
    ctx.save();
    ctx.shadowColor = `rgba(8, 10, 20, ${shadow2})`;
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 6;
    ctx.fillStyle = '#101218';
    if (camRect.shape === 'circle') {
      ctx.beginPath();
      ctx.arc(camRect.x + camRect.w / 2, camRect.y + camRect.h / 2, camRect.w / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      roundRectPath(ctx, camRect.x, camRect.y, camRect.w, camRect.h, camRect.radius);
      ctx.fill();
    }
    ctx.restore();

    ctx.save();
    if (camRect.shape === 'circle') {
      ctx.beginPath();
      ctx.arc(camRect.x + camRect.w / 2, camRect.y + camRect.h / 2, camRect.w / 2, 0, Math.PI * 2);
      ctx.clip();
      // Square source crop centred, so the circle doesn't stretch the face.
      const cw = Math.min(camVideo.videoWidth, camVideo.videoHeight);
      const cx0 = (camVideo.videoWidth - cw) / 2;
      const cy0 = (camVideo.videoHeight - cw) / 2;
      ctx.drawImage(camVideo, cx0, cy0, cw, cw, camRect.x, camRect.y, camRect.w, camRect.h);
    } else {
      roundRectPath(ctx, camRect.x, camRect.y, camRect.w, camRect.h, camRect.radius);
      ctx.clip();
      ctx.drawImage(camVideo, 0, 0, camVideo.videoWidth, camVideo.videoHeight, camRect.x, camRect.y, camRect.w, camRect.h);
    }
    // Background removal (人像分割): a mask canvas (white = person) composited
    // with destination-in keeps only the person; the PiP then floats without
    // its rectangular/circular background.
    const maskCanvas = project.cameraMaskCanvas || null;
    if (cam.removeBg && maskCanvas && maskCanvas.width) {
      try {
        ctx.globalCompositeOperation = 'destination-in';
        ctx.drawImage(maskCanvas, camRect.x, camRect.y, camRect.w, camRect.h);
        ctx.globalCompositeOperation = 'source-over';
      } catch {}
    }
    // Thin light ring, like FocuSee's camera border.
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = Math.max(1.5, camRect.w * 0.014);
    if (camRect.shape === 'circle') {
      ctx.beginPath();
      ctx.arc(camRect.x + camRect.w / 2, camRect.y + camRect.h / 2, camRect.w / 2 - ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      roundRectPath(ctx, camRect.x + ctx.lineWidth / 2, camRect.y + ctx.lineWidth / 2, camRect.w - ctx.lineWidth, camRect.h - ctx.lineWidth, camRect.radius);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Captions (manual / imported). AI captioning itself is out of scope.
  const caps = project.captions || [];
  const cap = caps.find((c) => time >= c.start && time <= c.end);
  if (cap?.text) {
    const fontSize = Math.round(H * 0.045);
    ctx.save();
    ctx.font = `600 ${fontSize}px -apple-system, "PingFang SC", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const textW = ctx.measureText(cap.text).width;
    const boxW = textW + fontSize * 1.2;
    const boxH = fontSize * 1.7;
    const bx = W / 2 - boxW / 2;
    const by = H - boxH - H * 0.05;
    ctx.fillStyle = 'rgba(12, 14, 22, 0.72)';
    roundRectPath(ctx, bx, by, boxW, boxH, boxH / 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(cap.text, W / 2, by + boxH / 2 + 1);
    ctx.restore();
  }

  ctx.restore();
  return { dest: rect, content, zoom, src, videoSize: { width: vw, height: vh } };
}

/** Output pixel size for a project style + video size. */
export function outputSize(style, videoW, videoH, maxWidth = 1600) {
  const aspect = style?.aspect && style.aspect !== 'original'
    ? (style.aspect === '16:9' ? 16 / 9 : style.aspect === '1:1' ? 1 : style.aspect === '4:3' ? 4 / 3 : 9 / 16)
    : (videoW && videoH ? videoW / videoH : 16 / 9);
  let w = Math.min(maxWidth, Math.max(640, videoW || 1280));
  if (aspect < 1) w = Math.min(w, 720);
  let h = Math.round(w / aspect);
  if (aspect >= 1) h = Math.min(h, Math.round(maxWidth / aspect));
  return { width: Math.round(w / 2) * 2, height: Math.round(h / 2) * 2 };
}
