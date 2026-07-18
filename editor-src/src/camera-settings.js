/**
 * camera-settings.js — 焦距控制、构图辅助（三分线、安全框）
 */
import { getCamera, getRenderer, getCanvasRect } from "./scene.js";

let focalLength = 35; // mm, 默认 35
let thirdsEnabled = false;
const MIN_FOCAL = 20;
const MAX_FOCAL = 135;

// DOM overrides set by ui.js
let focalSliderEl = null;
let focalLabelEl = null;
let thirdsCheckboxEl = null;
let overlayEl = null;

export function getFocalLength() {
  return focalLength;
}

export function setFocalLength(mm) {
  focalLength = Math.max(MIN_FOCAL, Math.min(MAX_FOCAL, mm));
  applyFov();
  if (focalSliderEl) focalSliderEl.value = focalLength;
  if (focalLabelEl) focalLabelEl.textContent = `${focalLength}mm`;
  updateOverlay();
}

/** 焦距 → 竖直 fov（度）：vFov = 2*atan(12/焦距)  (35mm全幅，sensor height=24mm, half=12mm) */
export function focalToVFovDeg(mm) {
  return (2 * Math.atan(12 / mm) * 180) / Math.PI;
}

function applyFov() {
  const cam = getCamera();
  if (!cam) return;
  cam.fov = focalToVFovDeg(focalLength);
  cam.updateProjectionMatrix();
}

export function isThirdsEnabled() {
  return thirdsEnabled;
}

export function setThirdsEnabled(v) {
  thirdsEnabled = !!v;
  if (thirdsCheckboxEl) thirdsCheckboxEl.checked = thirdsEnabled;
  updateOverlay();
}

// --------------- 构图叠加层 ---------------

export function createOverlay(viewportEl) {
  overlayEl = document.createElement("div");
  overlayEl.id = "framing-overlay";
  overlayEl.style.cssText =
    "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:5;";
  viewportEl.style.position = "relative";
  viewportEl.appendChild(overlayEl);
  return overlayEl;
}

export function updateOverlay() {
  if (!overlayEl) return;
  const rect = getCanvasRect();
  if (!rect) {
    overlayEl.innerHTML = "";
    return;
  }
  const parentRect = overlayEl.parentElement.getBoundingClientRect();
  const x = rect.left - parentRect.left;
  const y = rect.top - parentRect.top;
  const w = rect.width;
  const h = rect.height;

  let html = "";

  // 安全框外半透明遮罩（上、下、左、右四条）
  const maskAlpha = 0.45;
  // top bar
  if (y > 0) {
    html += `<div style="position:absolute;top:0;left:0;width:100%;height:${y}px;background:rgba(0,0,0,${maskAlpha});"></div>`;
  }
  // bottom bar
  const bottomH = parentRect.height - (y + h);
  if (bottomH > 0) {
    html += `<div style="position:absolute;bottom:0;left:0;width:100%;height:${bottomH}px;background:rgba(0,0,0,${maskAlpha});"></div>`;
  }
  // left bar
  if (x > 0) {
    html += `<div style="position:absolute;top:${y}px;left:0;width:${x}px;height:${h}px;background:rgba(0,0,0,${maskAlpha});"></div>`;
  }
  // right bar
  const rightW = parentRect.width - (x + w);
  if (rightW > 0) {
    html += `<div style="position:absolute;top:${y}px;right:0;width:${rightW}px;height:${h}px;background:rgba(0,0,0,${maskAlpha});"></div>`;
  }

  // 安全框边框
  html += `<div style="position:absolute;top:${y}px;left:${x}px;width:${w}px;height:${h}px;border:1px solid rgba(255,255,255,0.3);pointer-events:none;"></div>`;

  // 三分线（仅在开启时显示）
  if (thirdsEnabled) {
    const thirdW = w / 3;
    const thirdH = h / 3;
    const lineColor = "rgba(255,255,255,0.15)";
    // 竖线
    html += `<div style="position:absolute;top:${y}px;left:${x + thirdW}px;width:1px;height:${h}px;background:${lineColor};"></div>`;
    html += `<div style="position:absolute;top:${y}px;left:${x + 2 * thirdW}px;width:1px;height:${h}px;background:${lineColor};"></div>`;
    // 横线
    html += `<div style="position:absolute;top:${y + thirdH}px;left:${x}px;width:${w}px;height:1px;background:${lineColor};"></div>`;
    html += `<div style="position:absolute;top:${y + 2 * thirdH}px;left:${x}px;width:${w}px;height:1px;background:${lineColor};"></div>`;
  }

  overlayEl.innerHTML = html;
}

/** 注册 UI 控件引用 */
export function bindUI(fsEl, flEl, tcEl) {
  focalSliderEl = fsEl;
  focalLabelEl = flEl;
  thirdsCheckboxEl = tcEl;
}
