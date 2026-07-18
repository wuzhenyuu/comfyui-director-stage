/**
 * thumbnail-capture.js — 机位缩略图捕获工具
 *
 * 功能：
 *   - initThumbnailTarget(renderer)  初始化 160×120 渲染目标
 *   - captureCameraThumbnail(camera, renderer, scene)  捕获缩略图返回 dataUrl
 *   - 挂载 window.__ds.captureActiveThumbnail() 供外部调用
 */
import * as THREE from "three";

let thumbTarget = null;
let _renderer = null;

/**
 * 初始化缩略图渲染目标（160×120）
 * @param {THREE.WebGLRenderer} renderer
 */
export function initThumbnailTarget(renderer) {
  _renderer = renderer;
  thumbTarget = new THREE.WebGLRenderTarget(160, 120, {
    format: THREE.RGBAFormat,
  });
  return thumbTarget;
}

/**
 * 用指定相机渲染场景到 160×120 缩略图，返回 base64 dataUrl
 * @param {THREE.PerspectiveCamera} camera
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene
 * @returns {string|null} data:image/jpeg;base64,... 或 null
 */
export function captureCameraThumbnail(camera, renderer, scene) {
  if (!camera || !renderer || !scene) return null;
  if (!thumbTarget) initThumbnailTarget(renderer);

  // 保存当前渲染状态
  const prevTarget = renderer.getRenderTarget();
  const prevClearColor = new THREE.Color();
  renderer.getClearColor(prevClearColor);
  const prevClearAlpha = renderer.getClearAlpha();
  const prevScissor = renderer.getScissor();
  const prevScissorTest = renderer.getScissorTest();
  const prevViewport = new THREE.Vector4();
  renderer.getViewport(prevViewport);
  const prevSize = new THREE.Vector2();
  renderer.getSize(prevSize);

  // 渲染到缩略图目标
  renderer.setRenderTarget(thumbTarget);
  renderer.setClearColor(new THREE.Color(0x1a1a2e), 1);
  renderer.setScissorTest(false);
  renderer.clear();
  renderer.render(scene, camera);

  // 读取像素
  const pixels = new Uint8Array(160 * 120 * 4);
  renderer.readRenderTargetPixels(thumbTarget, 0, 0, 160, 120, pixels);

  // 恢复渲染状态
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClearColor, prevClearAlpha);
  renderer.setScissor(prevScissor);
  renderer.setScissorTest(prevScissorTest);
  renderer.setViewport(prevViewport);
  renderer.setSize(prevSize.x, prevSize.y);

  // 像素 → Canvas → dataUrl（WebGL 读取的是 bottom-up，需要翻转 Y）
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 120;
  const ctx = canvas.getContext("2d");
  const imgData = ctx.createImageData(160, 120);

  for (let y = 0; y < 120; y++) {
    for (let x = 0; x < 160; x++) {
      const srcIdx = ((119 - y) * 160 + x) * 4; // flip Y
      const dstIdx = (y * 160 + x) * 4;
      imgData.data[dstIdx] = pixels[srcIdx];
      imgData.data[dstIdx + 1] = pixels[srcIdx + 1];
      imgData.data[dstIdx + 2] = pixels[srcIdx + 2];
      imgData.data[dstIdx + 3] = 255;
    }
  }
  ctx.putImageData(imgData, 0, 0);

  return canvas.toDataURL("image/jpeg", 0.7);
}

/**
 * 为活动相机生成缩略图并存入 cameraEntry.dataUrl
 * 供 window.__ds.captureActiveThumbnail() 调用
 * @param {import('./cameras.js').CameraManager} [cameraManager]
 * @param {THREE.WebGLRenderer} [renderer]
 * @param {THREE.Scene} [scene]
 * @param {number} [delayMs=200] 延迟毫秒（等视口渲染完成）
 */
export function scheduleActiveThumbnail(cameraManager, renderer, scene, delayMs = 200) {
  if (!cameraManager || !renderer || !scene) return;
  const ac = cameraManager.getActiveCamera();
  if (!ac) return;

  setTimeout(() => {
    const dataUrl = captureCameraThumbnail(ac.camera, renderer, scene);
    if (dataUrl) {
      ac.dataUrl = dataUrl;
    }
  }, delayMs);
}

/* ---- 挂载到 window.__ds ---- */

/**
 * 初始化缩略图系统并挂载全局函数
 * 由 main.js 在初始化时调用一次
 */
export function mountThumbnailCapture() {
  if (!window.__ds) window.__ds = {};

  // 确保渲染目标已创建
  if (!thumbTarget && window.__ds.renderer) {
    initThumbnailTarget(window.__ds.renderer);
  }

  /**
   * 捕获活动相机缩略图（供 POV 切换等场景调用）
   */
  window.__ds.captureActiveThumbnail = function () {
    const cm = window.__ds.cameraManager;
    const r = window.__ds.renderer;
    const s = window.__ds.scene;
    if (!cm || !r || !s) {
      console.warn("[thumbnail-capture] cameraManager/renderer/scene 未就绪");
      return null;
    }
    const ac = cm.getActiveCamera();
    if (!ac) return null;
    const dataUrl = captureCameraThumbnail(ac.camera, r, s);
    if (dataUrl) ac.dataUrl = dataUrl;
    return dataUrl;
  };
}
