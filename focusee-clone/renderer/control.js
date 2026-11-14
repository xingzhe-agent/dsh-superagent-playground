'use strict';

// Floating recording control pill. The pill itself is excluded from the
// capture via the window's content protection (set in the main process).

const $ = (sel) => document.querySelector(sel);
const state = { startedAt: 0, timer: null, stopped: false };

function fmt(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function tick() {
  if (!state.startedAt) return;
  $('#time').textContent = fmt((Date.now() - state.startedAt) / 1000);
}

window.focusee.control.onState((info) => {
  if (info.startedAt && !state.startedAt) {
    state.startedAt = info.startedAt;
    state.timer = setInterval(tick, 250);
    tick();
  }
  $('#mic-badge').style.visibility = info.mic ? 'visible' : 'hidden';
  if (info.withCamera) {
    document.getElementById('cam-panel').classList.remove('hidden');
    document.getElementById('cam-size-label').textContent = `${info.pipSize}%`;
  }
});

// PiP live adjust: window position = position in the baked video, +/− = size.
function reportPip() {
  try { window.focusee.control.reportPip(); } catch {}
}
document.getElementById('cam-bigger').addEventListener('click', () => {
  try { window.focusee.control.pipResize(3); } catch {}
});
document.getElementById('cam-smaller').addEventListener('click', () => {
  try { window.focusee.control.pipResize(-3); } catch {}
});
window.addEventListener('resize', reportPip);
setInterval(reportPip, 400); // drag moves the window; report position periodically

$('#btn-stop').addEventListener('click', () => {
  if (state.stopped) return;
  state.stopped = true;
  $('#dot').classList.add('paused');
  $('#btn-stop').textContent = '保存中…';
  window.focusee.control.stop();
});

$('#btn-cancel').addEventListener('click', () => {
  if (state.stopped) return;
  state.stopped = true;
  window.focusee.control.cancel();
});
