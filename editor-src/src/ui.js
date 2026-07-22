/**
 * ui.js — DOM 操作、视口自适应、状态栏、Toast、进度条
 */
import { getCamera, peekRenderer, getCanvasRect } from "./scene.js";
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
  const renderer = peekRenderer(); // 不强制创建 WebGL
  const cw = viewportEl.clientWidth;
  const ch = viewportEl.clientHeight;
  if (cw <= 0 || ch <= 0) return;
  const aspect = exportW / exportH;
  // 相机 aspect 必须始终更新（2D 投影依赖它，与 renderer 无关）
  const cam = getCamera();
  if (cam) {
    cam.aspect = aspect;
    cam.updateProjectionMatrix();
  }
  // WebGL renderer 存在时才需要 setSize（仅影响导出离屏渲染）
  if (renderer) {
    let vw = cw;
    let vh = Math.round(cw / aspect);
    if (vh > ch) {
      vh = ch;
      vw = Math.round(ch * aspect);
    }
    renderer.setSize(vw, vh);
  }
  // 2D canvas 信箱重排
  if (window.__ds_layoutCanvas) window.__ds_layoutCanvas();
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

/* ======================== M2: Toast ======================== */

let toastTimer = null;

/**
 * 显示浮动 Toast 消息
 * @param {string} msg
 * @param {boolean} isError
 */
export function showToast(msg, isError = false) {
  // Remove existing toast
  const existing = document.getElementById("m2-toast");
  if (existing) existing.remove();
  if (toastTimer) clearTimeout(toastTimer);

  const toast = document.createElement("div");
  toast.id = "m2-toast";
  toast.textContent = msg;
  toast.style.cssText = [
    "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:9999;",
    "padding:10px 22px;border-radius:8px;font-size:13px;",
    "background:" + (isError ? "#b33" : "#2f9e63"),
    "color:#fff;box-shadow:0 4px 16px rgba(0,0,0,0.5);",
    "transition:opacity 0.3s;pointer-events:none;",
  ].join("");
  document.body.appendChild(toast);

  toastTimer = setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

/* ======================== M2: Progress Bar ======================== */

/**
 * 显示进度条
 * @param {string} msg
 */
export function showProgress(msg) {
  let bar = document.getElementById("m2-progress");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "m2-progress";
    bar.style.cssText = [
      "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:9998;",
      "padding:8px 16px;border-radius:8px;font-size:13px;",
      "background:#232836;color:#e6e9f0;border:1px solid #2a2f3d;",
      "box-shadow:0 4px 16px rgba(0,0,0,0.5);pointer-events:none;",
    ].join("");
    document.body.appendChild(bar);
  }
  bar.textContent = msg;
  bar.style.display = "block";
}

export function hideProgress() {
  const bar = document.getElementById("m2-progress");
  if (bar) bar.style.display = "none";
}
