'use strict';
// Regenerates renderer/zoom.cjs from renderer/zoom.js so the Node tests and
// any CJS consumer use exactly the same maths as the ES module in the app.
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'zoom.js'), 'utf8');
const stripped = src.replace(/^export (const|function|let)\b/gm, '$1');
const exportNames = [
  'clamp', 'lerp', 'smoothstep', 'ASPECTS', 'detectActions', 'buildZooms',
  'zoomAt', 'sourceRectAt', 'fitRect', 'contentRect', 'mapPointToCanvas',
  'formatTime', 'normaliseCursor', 'cursorAt',
  'CAMERA_LAYOUTS', 'computeCameraRect', 'tiltSlices', 'activeCameraSettings', 'pipRectAt',
];
const tail = `\nmodule.exports = {\n${exportNames.map((n) => `  ${n}`).join(',\n')},\n};\n`;
fs.writeFileSync(path.join(__dirname, '..', 'renderer', 'zoom.cjs'), stripped + tail);
console.log('renderer/zoom.cjs rebuilt from renderer/zoom.js');
