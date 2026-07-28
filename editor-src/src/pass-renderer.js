/**
 * pass-renderer.js — 渲染通道：Normal / Depth / Lineart / CharacterMask / OpenPose / Preview
 *
 * 所有通道输出 canvas 尺寸严格等于 nodeWidth × nodeHeight。
 */
import * as THREE from "three";
import { LIMB_SEQ } from "./constants.js";

// ─── helpers ───

function pixelsToCanvas(buf, w, h, flipY = true) {
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d");
  const img = ctx.createImageData(w, h);
  const row = w * 4;
  if (flipY) {
    for (let y = 0; y < h; y++) {
      img.data.set(buf.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    }
  } else {
    img.data.set(buf);
  }
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
  ctx.putImageData(img, 0, 0);
  return cv;
}

/**
 * Read pixels from a WebGLRenderTarget into a Uint8Array.
 */
function readPixels(renderer, rt, w, h) {
  const buf = new Uint8Array(w * h * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
  return buf;
}

/** Create a render target of given size */
function makeRT(w, h) {
  return new THREE.WebGLRenderTarget(w, h, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
  });
}

// ─── Normal pass ───

const _normalMat = new THREE.MeshNormalMaterial();

/**
 * 渲染法线贴图：view-space normal → RGB (n*0.5+0.5)
 */
export function renderNormalCanvas(scene, camera, renderer, w, h, hiddenObjects = []) {
  // Hide overlay objects
  const vis = hiddenObjects.map((o) => {
    const v = o.visible;
    o.visible = false;
    return { obj: o, was: v };
  });

  scene.overrideMaterial = _normalMat;

  const rt = makeRT(w, h);
  renderer.setRenderTarget(rt);
  renderer.render(scene, camera);

  const buf = readPixels(renderer, rt, w, h);
  renderer.setRenderTarget(null);
  rt.dispose();
  scene.overrideMaterial = null;

  // Restore visibility
  vis.forEach(({ obj, was }) => { obj.visible = was; });

  return pixelsToCanvas(buf, w, h, true);
}

// ─── Depth pass ───

const _depthMat = new THREE.MeshDepthMaterial();

/**
 * 深度图：近白远黑，所有可见对象参与。
 * 自动计算 near/far 从场景范围。
 */
export function renderDepthCanvas(scene, camera, renderer, w, h, hiddenObjects = []) {
  const vis = hiddenObjects.map((o) => {
    const v = o.visible;
    o.visible = false;
    return { obj: o, was: v };
  });

  const prevBg = scene.background;
  scene.background = new THREE.Color(0x000000);

  const prevNear = camera.near;
  const prevFar = camera.far;

  // Compute scene bounds for near/far
  const bbox = new THREE.Box3();
  scene.traverseVisible((child) => {
    if (child.isMesh || child.isSkinnedMesh) {
      bbox.expandByObject(child);
    }
  });
  if (bbox.isEmpty()) {
    bbox.setFromCenterAndSize(new THREE.Vector3(0, 1, 0), new THREE.Vector3(2, 2, 2));
  }

  const camPos = new THREE.Vector3();
  camera.getWorldPosition(camPos);
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);

  // Find min/max depth along camera forward
  const corners = [
    new THREE.Vector3(bbox.min.x, bbox.min.y, bbox.min.z),
    new THREE.Vector3(bbox.min.x, bbox.min.y, bbox.max.z),
    new THREE.Vector3(bbox.min.x, bbox.max.y, bbox.min.z),
    new THREE.Vector3(bbox.min.x, bbox.max.y, bbox.max.z),
    new THREE.Vector3(bbox.max.x, bbox.min.y, bbox.min.z),
    new THREE.Vector3(bbox.max.x, bbox.min.y, bbox.max.z),
    new THREE.Vector3(bbox.max.x, bbox.max.y, bbox.min.z),
    new THREE.Vector3(bbox.max.x, bbox.max.y, bbox.max.z),
  ];
  let minD = Infinity;
  let maxD = -Infinity;
  corners.forEach((c) => {
    const d = c.clone().sub(camPos).dot(fwd);
    minD = Math.min(minD, d);
    maxD = Math.max(maxD, d);
  });
  camera.near = Math.max(0.05, minD - 0.5);
  camera.far = Math.max(camera.near + 0.2, maxD + 0.5);
  camera.updateProjectionMatrix();

  scene.overrideMaterial = _depthMat;
  const rt = makeRT(w, h);
  renderer.setRenderTarget(rt);
  renderer.render(scene, camera);

  const buf = readPixels(renderer, rt, w, h);
  renderer.setRenderTarget(null);
  rt.dispose();
  scene.overrideMaterial = null;

  // Restore
  scene.background = prevBg;
  camera.near = prevNear;
  camera.far = prevFar;
  camera.updateProjectionMatrix();

  vis.forEach(({ obj, was }) => { obj.visible = was; });

  return pixelsToCanvas(buf, w, h, true);
}

// ─── Lineart pass (Sobel edge detection) ───

/**
 * Sobel 边缘检测：depth + normal → 白底黑线，线宽 2px×scale。
 * @param {HTMLCanvasElement} depthCanvas
 * @param {HTMLCanvasElement} normalCanvas
 * @param {number} w
 * @param {number} h
 * @returns {HTMLCanvasElement}
 */
export function renderLineartCanvas(depthCanvas, normalCanvas, w, h) {
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d");

  // Read pixel data
  const dCtx = document.createElement("canvas").getContext("2d");
  dCtx.canvas.width = w;
  dCtx.canvas.height = h;
  dCtx.drawImage(depthCanvas, 0, 0);
  const dData = dCtx.getImageData(0, 0, w, h);

  const nCtx = document.createElement("canvas").getContext("2d");
  nCtx.canvas.width = w;
  nCtx.canvas.height = h;
  nCtx.drawImage(normalCanvas, 0, 0);
  const nData = nCtx.getImageData(0, 0, w, h);

  const out = ctx.createImageData(w, h);

  const s = Math.max(1, Math.round(Math.min(w, h) / 512));

  // Sobel kernels
  const sobelX = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
  const sobelY = [-1, -2, -1, 0, 0, 0, 1, 2, 1];

  function getPixel(data, x, y) {
    if (x < 0 || x >= w || y < 0 || y >= h) return [0, 0, 0, 0];
    const i = (y * w + x) * 4;
    return [data.data[i], data.data[i + 1], data.data[i + 2], data.data[i + 3]];
  }

  function sobelAt(data, cx, cy) {
    let gxSum = 0, gySum = 0;
    for (let ky = -1; ky <= 1; ky++) {
      for (let kx = -1; kx <= 1; kx++) {
        const idx = (ky + 1) * 3 + (kx + 1);
        const p = getPixel(data, cx + kx * s, cy + ky * s);
        // Use luminance of RGB
        const lum = (p[0] + p[1] + p[2]) / 3;
        gxSum += lum * sobelX[idx];
        gySum += lum * sobelY[idx];
      }
    }
    return Math.sqrt(gxSum * gxSum + gySum * gySum);
  }

  const threshold = 12; // sensitivity

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const di = (y * w + x) * 4;
      const gD = sobelAt(dData, x, y);
      const gN = sobelAt(nData, x, y);
      const grad = Math.max(gD, gN);

      if (grad > threshold) {
        // Black edge
        out.data[di] = 0;
        out.data[di + 1] = 0;
        out.data[di + 2] = 0;
      } else {
        // White background
        out.data[di] = 255;
        out.data[di + 1] = 255;
        out.data[di + 2] = 255;
      }
      out.data[di + 3] = 255;
    }
  }

  ctx.putImageData(out, 0, 0);
  return cv;
}

// ─── Character Mask pass ───

// P3-3：mask 白色材质模块级共享（原每角色×每机位 new 一次且从不 dispose，批量导出累积）
const _maskWhiteMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

/**
 * 对每个角色生成白色 mask（黑色背景）。
 * @param {THREE.Scene} scene
 * @param {THREE.PerspectiveCamera} camera
 * @param {THREE.WebGLRenderer} renderer
 * @param {number} w
 * @param {number} h
 * @param {Array<{id:string, group:THREE.Group}>} characters — 每个角色 {id, group}
 * @param {THREE.Object3D[]} hiddenObjects — 渲染前需隐藏的对象
 * @returns {Object<string, HTMLCanvasElement>}  { charId: canvas }
 */
export function renderCharacterMasks(scene, camera, renderer, w, h, characters, hiddenObjects = []) {
  const results = {};

  const vis = hiddenObjects.map((o) => {
    const v = o.visible;
    o.visible = false;
    return { obj: o, was: v };
  });

  const prevBg = scene.background;
  scene.background = new THREE.Color(0x000000);

  // First, hide ALL characters
  const allCharObjs = [];
  const charVisState = new Map();
  characters.forEach((ch) => {
    ch.group.traverse((child) => {
      if (child.visible !== undefined) {
        charVisState.set(child, child.visible);
        allCharObjs.push(child);
      }
    });
  });

  // For each character: show only that character, white material, render
  characters.forEach((ch) => {
    // Hide all
    allCharObjs.forEach((o) => { o.visible = false; });

    // Show only this character's objects
    ch.group.traverse((child) => {
      if (child.visible !== undefined) child.visible = true;
    });

    // Override material to white（P3-3：模块级共享材质，禁止 dispose）
    const whiteMat = _maskWhiteMat;
    const prevMats = [];
    scene.traverseVisible((child) => {
      if ((child.isMesh || child.isSkinnedMesh) && child.material) {
        prevMats.push({ obj: child, mat: child.material });
        child.material = whiteMat;
      }
    });

    const rt = makeRT(w, h);
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    const buf = readPixels(renderer, rt, w, h);
    renderer.setRenderTarget(null);
    rt.dispose();

    // Restore materials
    prevMats.forEach(({ obj, mat }) => { obj.material = mat; });

    results[ch.id] = pixelsToCanvas(buf, w, h, true);
  });

  // Restore all visibility
  allCharObjs.forEach((o) => {
    o.visible = charVisState.get(o) !== false;
  });

  scene.background = prevBg;
  vis.forEach(({ obj, was }) => { obj.visible = was; });

  return results;
}

// ─── OpenPose pass (multi-character) ───

/**
 * 角色分配颜色（与 CHARACTER_COLORS 配合）
 */
const CHAR_COLORS = [
  [255, 85, 85],   // red
  [85, 170, 255],  // blue
  [85, 255, 85],   // green
  [255, 255, 85],  // yellow
  [255, 170, 85],  // orange
  [170, 85, 255],  // purple
  [255, 85, 255],  // magenta
  [85, 255, 255],  // cyan
];

/**
 * 多角色 OpenPose 渲染：所有角色同一 canvas，每角色单色+肢体连线。
 * @param {Array<{id:string, joints:THREE.Vector3[]}>} allCharJoints — 每个角色的 18 关节世界坐标
 * @param {THREE.PerspectiveCamera} camera
 * @param {number} w
 * @param {number} h
 * @returns {HTMLCanvasElement}
 */
export function renderOpenPoseCanvasMulti(allCharJoints, camera, w, h) {
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);

  if (!camera) return cv;

  camera.updateMatrixWorld();
  const v = new THREE.Vector3();
  const s = Math.min(w, h) / 512;

  allCharJoints.forEach((charData, charIdx) => {
    // P1 修复：空/缺失 joints 直接跳过该角色（3D-only 零角色场景不会走到这里，但防御兜底）
    if (!charData || !Array.isArray(charData.joints) || charData.joints.length === 0) return;

    const color = CHAR_COLORS[charIdx % CHAR_COLORS.length];
    const colorStr = `rgb(${color[0]},${color[1]},${color[2]})`;

    // Project all joints（缺失关节记为 null，下方防御性跳过）
    const pts = charData.joints.map((j) => {
      if (!j) return null;
      v.copy(j);
      v.project(camera);
      return [((v.x + 1) / 2) * w, ((1 - v.y) / 2) * h];
    });

    // Draw limbs
    ctx.strokeStyle = colorStr;
    ctx.lineWidth = 3 * s;
    ctx.lineCap = "round";
    LIMB_SEQ.forEach(([a, b]) => {
      if (!pts[a] || !pts[b]) return;
      ctx.beginPath();
      ctx.moveTo(pts[a][0], pts[a][1]);
      ctx.lineTo(pts[b][0], pts[b][1]);
      ctx.stroke();
    });

    // Draw joints
    ctx.fillStyle = colorStr;
    pts.forEach((p) => {
      if (!p) return;
      ctx.beginPath();
      ctx.arc(p[0], p[1], 3 * s, 0, Math.PI * 2);
      ctx.fill();
    });
  });

  return cv;
}

/**
 * 单角色 OpenPose（兼容 M1）— 使用 POSE_COLORS 肢体色编码
 * @param {THREE.Mesh[]} joints — 18个关节球体
 * @param {THREE.PerspectiveCamera} camera
 * @param {number} w
 * @param {number} h
 * @returns {HTMLCanvasElement}
 */
export function renderOpenPoseCanvas(joints, camera, w, h) {
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);

  if (!camera) return cv;

  // P1 修复：3D-only 零角色时 getEffectiveJoints() 兜底为空数组/undefined，
  // 直接返回全黑 canvas（尺寸已正确），避免 LIMB_SEQ 对空 pts 取下标崩溃。
  if (!Array.isArray(joints) || joints.length === 0) return cv;

  camera.updateMatrixWorld();
  const v = new THREE.Vector3();
  const pts = joints.map((j) => {
    if (!j) return null;
    j.getWorldPosition(v);
    v.project(camera);
    return [((v.x + 1) / 2) * w, ((1 - v.y) / 2) * h];
  });

  const s = Math.min(w, h) / 512;

  // Use simple per-limb coloring for single char
  const limbColors = [
    [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0],
    [85, 255, 0], [0, 255, 85], [0, 255, 170], [0, 255, 255],
    [0, 170, 255], [0, 85, 255], [0, 0, 255], [85, 0, 255],
    [170, 0, 255], [255, 0, 255], [255, 0, 170], [255, 0, 85],
    [255, 0, 0],
  ];

  ctx.lineCap = "round";
  LIMB_SEQ.forEach(([a, b], i) => {
    // 稀疏 pts 防御：部分关节缺失时跳过该肢体
    if (!pts[a] || !pts[b]) return;
    const c = limbColors[i % limbColors.length];
    ctx.strokeStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
    ctx.lineWidth = 3 * s;
    ctx.beginPath();
    ctx.moveTo(pts[a][0], pts[a][1]);
    ctx.lineTo(pts[b][0], pts[b][1]);
    ctx.stroke();
  });

  pts.forEach((p, j) => {
    if (!p) return;
    const c = limbColors[j % limbColors.length];
    ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
    ctx.beginPath();
    ctx.arc(p[0], p[1], 3 * s, 0, Math.PI * 2);
    ctx.fill();
  });

  return cv;
}

// ─── Preview pass（灰模渲染）───

const _previewMat = new THREE.MeshToonMaterial({ color: 0xcccccc });

// 三点光：主光 + 补光 + 背光
const _previewLights = {
  key:  new THREE.DirectionalLight(0xffffff, 1.0),
  fill: new THREE.DirectionalLight(0xffffff, 0.3),
  rim:  new THREE.DirectionalLight(0xffffff, 0.5),
};
_previewLights.key.position.set(2, 3, 2);
_previewLights.fill.position.set(-2, 1, 1);
_previewLights.rim.position.set(0, 2, -3);

/**
 * 灰模渲染：将所有 mesh 替换为灰色 toon 材质 + 三点光，输出带光影的灰度参考图。
 * 用于 IPAdapter / 重绘参考。
 *
 * @param {THREE.Scene} scene
 * @param {THREE.PerspectiveCamera} camera
 * @param {THREE.WebGLRenderer} renderer
 * @param {number} w
 * @param {number} h
 * @param {THREE.Object3D[]} hiddenObjects
 * @returns {HTMLCanvasElement}
 */
export function renderPreviewCanvas(scene, camera, renderer, w, h, hiddenObjects = []) {
  // 1. 隐藏辅助对象
  const vis = hiddenObjects.map((o) => {
    const v = o.visible;
    o.visible = false;
    return { obj: o, was: v };
  });

  // 2. 保存原始材质，替换为灰色 toon
  const prevMats = [];
  scene.traverseVisible((child) => {
    if ((child.isMesh || child.isSkinnedMesh) && child.material) {
      prevMats.push({ obj: child, mat: child.material });
      child.material = _previewMat;
    }
  });

  // 3. 添加三点光
  const lightsToAdd = Object.values(_previewLights);
  lightsToAdd.forEach((l) => scene.add(l));

  // 4. 保存背景色，设为中性灰
  const prevBg = scene.background;
  scene.background = new THREE.Color(0x808080);

  // 5. 渲染到 RenderTarget
  const rt = makeRT(w, h);
  renderer.setRenderTarget(rt);
  renderer.render(scene, camera);

  const buf = readPixels(renderer, rt, w, h);
  renderer.setRenderTarget(null);
  rt.dispose();

  // 6. 恢复：移除灯光、恢复材质、恢复背景、恢复可见性
  lightsToAdd.forEach((l) => scene.remove(l));
  prevMats.forEach(({ obj, mat }) => { obj.material = mat; });
  scene.background = prevBg;
  vis.forEach(({ obj, was }) => { obj.visible = was; });

  return pixelsToCanvas(buf, w, h, true);
}
