/**
 * ui.js — DOM 操作、视口自适应、状态栏
 */
import { getCamera, getRenderer, getCanvasRect } from "./scene.js";
import { updateOverlay } from "./camera-settings.js";

let exportW = 512;
let exportH = 768;
let viewportEl = null;

export function setExportSize(w, h) {
  exportW = w;
  exportH = h;
}

export function getExportWH() {
  return [exportW, exportH];
}

/**
 * 视口自适应：保持 canvas 比例 = exportW/exportH 并居中
 */
export function applyViewport(viewportElem) {
  viewportEl = viewportElem;
  const renderer = getRenderer();
  if (!renderer) return;
  const cw = viewportEl.clientWidth;
  const ch = viewportEl.clientHeight;
  if (cw <= 0 || ch <= 0) return;
  const aspect = exportW / exportH;
  let vw = cw;
  let vh = Math.round(cw / aspect);
  if (vh > ch) {
    vh = ch;
    vw = Math.round(ch * aspect);
  }
  renderer.setSize(vw, vh);
  const cam = getCamera();
  if (cam) {
    cam.aspect = exportW / exportH;
    cam.updateProjectionMatrix();
  }
  updateOverlay();
}

export function setStatus(msg, statusEl) {
  if (!statusEl) return;
  statusEl.textContent = msg
    ? `${msg}　|　导出 ${exportW}×${exportH}`
    : `导出 ${exportW}×${exportH}`;
}

/**
 * 获取 viewport 元素（用于绑定 resize）
 */
export function getViewportEl() {
  return viewportEl;
}
