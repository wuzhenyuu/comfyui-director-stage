/**
 * render-mode.js — 渲染模式管理（P1-A）
 *
 * 三档模式：
 *   auto     — 默认。WebGL 可用则 webgl，否则自动回退 canvas2d。
 *   webgl    — 强制尝试 WebGL；初始化/首帧失败仍自动回退 canvas2d（不黑屏）。
 *   canvas2d — 强制 2D Canvas（等价于 URL 参数 ?force2d=1）。
 *
 * 回退策略（任何一步失败都 console.warn 且落到 canvas2d）：
 *   1. WebGL context 探测失败
 *   2. THREE.WebGLRenderer 创建抛异常
 *   3. 运行期 webglcontextlost
 *   4. 渲染帧抛异常（由 main.js 渲染循环调用 fallbackTo2D）
 *
 * 2D canvas 永远是交互层：webgl 模式下它透明叠加在 WebGL canvas 之上，
 * 拾取/拖拽/orbit 事件绑定不变，仅关闭投影绘制（见 scene.js set2DPaintEnabled）。
 */
import {
  createViewportWebGL,
  mountWebGLCanvas,
  getWebGLCanvas,
  getViewportCanvas,
  set2DPaintEnabled,
  layoutViewport,
} from "./scene.js";

export const RENDER_MODES = ["auto", "webgl", "canvas2d"];

let preference = "auto";      // 用户/参数请求的模式
let effective = "canvas2d";   // 实际生效的模式（"webgl" | "canvas2d"）
let viewportEl = null;
let getCameraRef = null;

let webglReady = false;       // 视口 WebGLRenderer 已创建
let webglFailed = false;      // 初始化失败 / context lost 后永久回退（本次会话）
let fallbackWarned = false;

const listeners = [];

/** URL 参数 ?force2d=1 → 强制 2D（测试/兜底通道） */
function detectForce2d() {
  try {
    return new URLSearchParams(window.location.search).get("force2d") === "1";
  } catch (e) {
    return false;
  }
}

/**
 * 初始化渲染模式管理器。必须在 mountRenderer（2D canvas 已挂载）之后调用。
 * @param {{ viewportEl: HTMLElement, getCamera?: () => THREE.Camera|null }} opts
 */
export function initRenderMode(opts) {
  viewportEl = opts.viewportEl;
  getCameraRef = opts.getCamera || null;
  if (detectForce2d()) {
    preference = "canvas2d";
    console.log("[3D导演台] URL force2d=1 → 强制 Canvas 2D 模式");
  }
  applyMode();
}

/** 按 preference 解析并应用实际模式 */
export function applyMode() {
  if (preference === "canvas2d") {
    setEffective("canvas2d");
  } else if (tryInitWebGL()) {
    setEffective("webgl");
  } else {
    // auto/webgl 都回退：不黑屏
    setEffective("canvas2d");
  }
  return effective;
}

/**
 * 切换渲染模式（测试契约：window.__ds.setRenderMode）
 * @param {"auto"|"webgl"|"canvas2d"} mode
 * @returns {string} 实际生效的模式
 */
export function setRenderMode(mode) {
  if (!RENDER_MODES.includes(mode)) {
    console.warn(`[3D导演台] 未知渲染模式 "${mode}"，支持: ${RENDER_MODES.join("/")}`);
    return effective;
  }
  preference = mode;
  return applyMode();
}

/** 当前实际生效的模式："webgl" | "canvas2d"（测试契约：window.__ds.renderMode） */
export function getRenderMode() {
  return effective;
}

/** 当前请求的模式（auto/webgl/canvas2d），可能与 effective 不同（auto 解析后） */
export function getRenderModePreference() {
  return preference;
}

export function isWebGL() {
  return effective === "webgl";
}

/**
 * 运行期回退入口：渲染帧异常 / context lost 时调用。
 * 只警告一次；回退后本次会话不再自动尝试 WebGL。
 */
export function fallbackTo2D(reason) {
  webglFailed = true;
  if (!fallbackWarned) {
    fallbackWarned = true;
    console.warn(`[3D导演台] WebGL 不可用（${reason}），已回退 Canvas 2D 渲染`);
  }
  if (effective !== "canvas2d") setEffective("canvas2d");
}

/** 注册模式变化监听（UI 指示器用） */
export function onModeChange(fn) {
  if (typeof fn === "function") listeners.push(fn);
}

/* ============================ 内部实现 ============================ */

function tryInitWebGL() {
  if (webglReady) return true;
  if (webglFailed) return false;
  try {
    const canvas = createViewportWebGL(); // 探测失败 / 创建失败会抛异常
    mountWebGLCanvas(viewportEl);
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault(); // 阻止默认行为，留 2D canvas 继续交互
      fallbackTo2D("context lost");
    });
    webglReady = true;
    return true;
  } catch (e) {
    webglFailed = true;
    if (!fallbackWarned) {
      fallbackWarned = true;
      console.warn("[3D导演台] WebGL 初始化失败，回退 Canvas 2D 渲染：", e?.message || e);
    }
    return false;
  }
}

function setEffective(mode) {
  if (effective === mode && viewportEl?.dataset.renderMode === mode) return;
  effective = mode;

  const canvas2d = getViewportCanvas();
  const glCanvas = getWebGLCanvas();

  if (mode === "webgl" && glCanvas) {
    // WebGL：3D canvas 显示在底层；2D canvas 透明叠加在最上层继续接收交互
    glCanvas.style.display = "block";
    if (canvas2d) canvas2d.style.display = "block";
    set2DPaintEnabled(false); // 只填拾取缓存，不画 2D 投影
  } else {
    // Canvas 2D：隐藏 WebGL canvas（保留实例，切回不重建）
    if (glCanvas) glCanvas.style.display = "none";
    if (canvas2d) canvas2d.style.display = "block";
    set2DPaintEnabled(true);
  }

  // 测试契约：容器与 canvas 都带 data-render-mode
  if (viewportEl) viewportEl.dataset.renderMode = mode;
  if (canvas2d) canvas2d.dataset.renderMode = mode;
  if (glCanvas) glCanvas.dataset.renderMode = mode;

  // 模式切换后重排（webgl canvas 显示状态变化可能影响布局）
  layoutViewport();

  for (const fn of listeners) {
    try { fn(mode, preference); } catch (e) { /* 监听器异常不影响主链路 */ }
  }
  console.log(`[3D导演台] 渲染模式：${preference} → 实际 ${mode}`);
}
