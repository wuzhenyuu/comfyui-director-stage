/**
 * scene.js — 2D Canvas 渲染（替代 Three.js WebGL）
 *
 * 用原生 Canvas 2D 绘制火柴人，零 WebGL 依赖，确保在任何环境都能显示。
 * WebGLRenderer 改为【懒加载】：仅在导出/缩略图真正需要时创建；
 * 创建失败（无 GPU/WebGL2）不影响编辑器使用，仅相关导出通道不可用。
 */
import * as THREE from "three";

let renderer = null;          // 懒加载 WebGLRenderer（仅导出用）
let rendererFailed = false;   // WebGL 创建失败标记（只警告一次）
let scene = null;
let camera = null;
let grid = null;
let axes = null;
let viewportEl = null;

// 2D 渲染上下文
let ctx2d = null;
let canvas2d = null;

// WebGL 视口渲染器（P1-A/B）：与导出用懒加载 renderer 完全分离，互不影响尺寸
let viewportWebGLRenderer = null;
let webglCanvas = null;
// 2D 投影绘制开关：WebGL 模式下 2D canvas 仅作透明交互层
// （事件绑定/拾取缓存 __ds_jointScreen/__ds_propScreen 照常填充，但不绘制投影）
let paint2dEnabled = true;

/** 创建 2D Canvas（启动时绝不触碰 WebGL） */
export function createRenderer() {
  canvas2d = document.createElement("canvas");
  canvas2d.width = 512;
  canvas2d.height = 768;
  ctx2d = canvas2d.getContext("2d");
  // 返回 2D canvas：交互/挂载全部以此为准
  return canvas2d;
}

/**
 * 懒加载 WebGLRenderer（仅供导出通道/缩略图使用）
 * 无 WebGL 环境返回 null，调用方需判空。
 */
export function getRenderer() {
  if (renderer || rendererFailed) return renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
    renderer.setSize(512, 768);
    renderer.setPixelRatio(1);
  } catch (e) {
    rendererFailed = true;
    console.warn("[3D导演台] WebGL 不可用，depth/normal/lineart/preview/mask 通道与缩略图将停用：", e.message || e);
    renderer = null;
  }
  return renderer;
}

/**
 * 返回已创建的 WebGLRenderer（不触发创建）—— 用于 applyViewport 等不应强制创建 WebGL 的场景
 */
export function peekRenderer() {
  return renderer;
}

/** 编辑器视口使用的 2D canvas（交互事件绑定目标） */
export function getViewportCanvas() {
  return canvas2d;
}

/** 2D 投影绘制开关（render-mode.js 在 WebGL 模式下关闭绘制，仅保留拾取缓存） */
export function set2DPaintEnabled(enabled) {
  paint2dEnabled = !!enabled;
}
export function is2DPaintEnabled() {
  return paint2dEnabled;
}

/**
 * 创建视口专用 WebGLRenderer（P1-A/B）。
 * 与 getRenderer() 的导出用 renderer 是两个独立实例：
 * 导出 setSize 不会影响编辑视口，视口 resize 也不会污染导出通道。
 * 失败（无 GPU/WebGL2）抛异常，由 render-mode.js 捕获并回退 2D。
 */
export function createViewportWebGL() {
  if (viewportWebGLRenderer) return webglCanvas;
  // 快速能力探测：拿不到 webgl2/webgl context 直接抛错走 2D 兜底，避免 THREE 半初始化
  const probe = document.createElement("canvas");
  const gl = probe.getContext("webgl2") || probe.getContext("webgl");
  if (!gl) throw new Error("WebGL context unavailable");
  // 释放探测 context，避免占用浏览器 WebGL context 配额
  try { gl.getExtension("WEBGL_lose_context")?.loseContext(); } catch (e) { /* ignore */ }

  viewportWebGLRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  viewportWebGLRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  viewportWebGLRenderer.setSize(512, 768, false);
  webglCanvas = viewportWebGLRenderer.domElement;
  webglCanvas.dataset.role = "webgl-viewport";
  return webglCanvas;
}

export function getViewportWebGLRenderer() {
  return viewportWebGLRenderer;
}
export function getWebGLCanvas() {
  return webglCanvas;
}

/** 将 WebGL canvas 挂载到 viewport，插在 2D canvas 之下（2D canvas 恒为最上交互层） */
export function mountWebGLCanvas(viewportElem) {
  if (!webglCanvas) return;
  webglCanvas.style.display = "block";
  webglCanvas.style.position = "absolute";
  if (canvas2d && canvas2d.parentNode === viewportElem) {
    viewportElem.insertBefore(webglCanvas, canvas2d);
  } else {
    viewportElem.appendChild(webglCanvas);
  }
  layoutViewport();
}

/** 渲染一帧 WebGL 视口；渲染抛异常时返回 false（调用方负责回退 2D） */
export function renderViewportWebGL(cameraRef) {
  if (!viewportWebGLRenderer || !scene || !cameraRef) return false;
  try {
    viewportWebGLRenderer.render(scene, cameraRef);
    return true;
  } catch (e) {
    console.warn("[3D导演台] WebGL 视口渲染异常：", e?.message || e);
    return false;
  }
}

/** 创建 Three.js 场景（仅用于导出与数据模型） */
export function createScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x222233);

  grid = new THREE.GridHelper(6, 12, 0x888899, 0x333344);
  scene.add(grid);
  axes = new THREE.AxesHelper(0.6);
  scene.add(axes);

  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x34322c, 1.5));
  const dirLight = new THREE.DirectionalLight(0xffffff, 2);
  dirLight.position.set(2.5, 4, 3);
  scene.add(dirLight);

  return scene;
}

/** 创建相机（用于坐标投影与导出） */
export function createCamera(fovDeg, aspect) {
  camera = new THREE.PerspectiveCamera(fovDeg, aspect, 0.1, 100);
  camera.position.set(0, 1.4, 3.2);
  camera.lookAt(0, 1, 0);
  return camera;
}

export function getCamera() { return camera; }
export function getScene() { return scene; }
export function getSceneHelpers() { return { grid, axes }; }

/** 信箱式布局计算：按相机 aspect 算出在 viewport 内居中的可视矩形 */
function computeLetterbox() {
  if (!viewportEl) return null;
  const cw = viewportEl.clientWidth;
  const ch = viewportEl.clientHeight;
  if (cw <= 0 || ch <= 0) return null;
  const aspect = (camera && camera.aspect) || (cw / ch);
  let vw = cw;
  let vh = Math.round(cw / aspect);
  if (vh > ch) {
    vh = ch;
    vw = Math.round(ch * aspect);
  }
  return { vw, vh, ox: Math.round((cw - vw) / 2), oy: Math.round((ch - vh) / 2) };
}

/**
 * 统一信箱布局：2D canvas 与 WebGL canvas 套用同一可视矩形，
 * 保证两种模式（及 WebGL 下的透明交互层）坐标系完全一致。
 */
export function layoutViewport() {
  const box = computeLetterbox();
  if (!box) return;
  const { vw, vh, ox, oy } = box;

  if (canvas2d && canvas2d.parentNode) {
    canvas2d.style.width = vw + "px";
    canvas2d.style.height = vh + "px";
    canvas2d.style.left = ox + "px";
    canvas2d.style.top = oy + "px";
    // HiDPI：内部分辨率 2 倍，绘制坐标系用 CSS 像素
    canvas2d.width = vw * 2;
    canvas2d.height = vh * 2;
    ctx2d = canvas2d.getContext("2d");
    ctx2d.scale(2, 2);
  }

  if (viewportWebGLRenderer && webglCanvas && webglCanvas.parentNode) {
    viewportWebGLRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    viewportWebGLRenderer.setSize(vw, vh, false);
    webglCanvas.style.width = vw + "px";
    webglCanvas.style.height = vh + "px";
    webglCanvas.style.left = ox + "px";
    webglCanvas.style.top = oy + "px";
  }
}

/** 兼容旧名：仅重排（现在同时处理 2D 与 WebGL canvas） */
export function layoutCanvas2d() {
  layoutViewport();
}

/** 将 2D canvas 挂载到 DOM */
export function mountRenderer(viewportElem) {
  viewportEl = viewportElem;

  canvas2d.style.display = "block";
  canvas2d.style.position = "absolute";
  viewportElem.style.position = "relative";
  viewportElem.style.overflow = "hidden";
  viewportElem.appendChild(canvas2d);

  layoutCanvas2d();

  // ResizeObserver：视口尺寸变化时重排
  if (window.ResizeObserver) {
    new ResizeObserver(() => layoutCanvas2d()).observe(viewportElem);
  }

  // 供 cameras.js 等外部模块在切相机后触发重排
  window.__ds_layoutCanvas = layoutCanvas2d;
}

export function getCanvasRect() {
  if (!canvas2d) return null;
  const rect = canvas2d.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

export function getCharacterGroups() {
  const groups = [];
  if (!window.DS_FigureAPI) return groups;
  try {
    const chars = window.DS_FigureAPI.getAllCharacters();
    if (chars && typeof chars.forEach === "function") {
      chars.forEach((ch, id) => {
        groups.push({ id: String(id), group: ch.skeletonGroup || ch });
      });
    }
  } catch (e) { /* ignore */ }
  return groups;
}

/** 2D绘图：清屏+网格+火柴人+信标 */
export function drawFrame(figureGroup, joints, cameraRef, fkMode) {
  if (!ctx2d || !canvas2d) return;

  // 用 canvas 自身 CSS 尺寸（信箱布局后的可视区域）
  const w = canvas2d.clientWidth || canvas2d.width / 2;
  const h = canvas2d.clientHeight || canvas2d.height / 2;
  if (w <= 0 || h <= 0) return;

  // ── P8：骨骼视图模式（TE_MAN 式）—— 黑底彩色 OpenPose 骨骼人偶。
  // 2D canvas 恒为最上层：不透明黑底直接盖住 WebGL 视图中的 3D 角色网格
  // （视觉隐藏 ≠ 数据删除：角色/场景状态不动，切回即恢复）；IK 球保持可拖。
  if (window.__ds_skeletonMode === true) {
    drawSkeletonModeFrame(cameraRef, w, h);
    return;
  }

  // 清屏（坐标系已 scale(2,2)，用 CSS 像素）
  ctx2d.clearRect(0, 0, w, h);

  // 背景（WebGL 模式下 2D canvas 是透明交互层，不绘制）
  if (paint2dEnabled) {
    ctx2d.fillStyle = "#222233";
    ctx2d.fillRect(0, 0, w, h);

    // 网格
    drawGrid(w, h);
  }

  // 道具：2D 视口必须把 PropManager 里的 mesh 投影画出来
  // （否则添加道具只存在于 Three 场景里，用户在框内完全看不见）
  // WebGL 模式下仍调用：仅填充 __ds_propScreen 拾取缓存，不绘制（内部判 paint2dEnabled）
  drawProps2D(cameraRef, w, h);

  // 每帧重置屏幕拾取缓存（pointerdown 的屏幕空间拾取依赖它）
  window.__ds_jointScreen = [];

  if (!cameraRef) return;

  const externalCharacterMode = !!(window.__ds?.isGLBMode || window.__ds?.isVRMMode);

  // 火柴人：多角色遍历（无 DS_FigureAPI 时 fallback 画传入的 joints）
  // 外部 GLB/VRM 角色模式下不再绘制/缓存隐藏火柴人，避免拾取串台。
  const api = window.DS_FigureAPI;
  let chars = [];
  if (!externalCharacterMode && api) {
    try {
      const all = api.getAllCharacters();
      if (all && typeof all.forEach === "function") all.forEach((ch) => chars.push(ch));
    } catch (e) { /* ignore */ }
  }
  const active = api ? api.getActiveCharacter() : null;
  if (!externalCharacterMode && chars.length) {
    // 非活动角色先画，活动角色最后画（压在最上层）
    chars.sort((a, b) => (a === active ? 1 : 0) - (b === active ? 1 : 0));
    for (const ch of chars) {
      if (!ch || !ch.jointSpheres) continue;
      const isActive = !!active && ch === active;
      // char.color 可能是 CSS 字符串（CHARACTER_COLORS）或十六进制数字，两种都兼容
      const cssColor = typeof ch.color === "string" ? ch.color
        : "#" + (ch.color ?? 0xffffff).toString(16).padStart(6, "0");
      drawStickFigure(ch.jointSpheres, cameraRef, w, h, fkMode, {
        color: cssColor,
        isActive,
        charId: String(ch.id),
      });
    }
  } else if (!externalCharacterMode) {
    drawStickFigure(joints, cameraRef, w, h, fkMode);
  }

  // IK 模式：把 IK target/pole 也投影画出来（否则 2D 里完全点不到）
  // 外部 GLB/VRM 角色模式强制缓存外部 IK 目标，确保 WebGL/2D 都能拖。
  if (fkMode || externalCharacterMode) drawIKTargets(cameraRef, w, h);

  // P3-0：Canvas2D 骨骼显示（WebGL 模式由 THREE.SkeletonHelper 负责，此处跳过）
  if (externalCharacterMode && typeof window.__ds_drawBones2D === "function") {
    window.__ds_drawBones2D(cameraRef, w, h, ctx2d, paint2dEnabled);
  }

  // 原点信标
  const beaconPos = new THREE.Vector3(0, 1, 0);
  beaconPos.project(cameraRef);
  if (paint2dEnabled && beaconPos.z < 1) { // 相机前方才画
    const bx = (beaconPos.x + 1) / 2 * w;
    const by = (1 - beaconPos.y) / 2 * h;
    ctx2d.beginPath();
    ctx2d.arc(bx, by, 8, 0, Math.PI * 2);
    ctx2d.fillStyle = "#ff4444";
    ctx2d.fill();
  }
}

/**
 * P8：骨骼视图模式整帧绘制 —— 黑底 + BODY_18 标准色骨骼人偶 + 道具线框 + IK 目标。
 *
 * 与导出的 openpose 通道（pass-renderer.renderOpenPoseCanvas）同一套
 * COCO limbSeq + 17 色彩色调色板，视口所见即导出所得。
 * 忽略 paint2dEnabled：WebGL 模式下 2D canvas 也是最上层，需不透明覆盖。
 */
function drawSkeletonModeFrame(cameraRef, w, h) {
  // 不透明黑底（盖住下层 WebGL 视图里的 3D 角色网格）
  ctx2d.fillStyle = "#000000";
  ctx2d.fillRect(0, 0, w, h);

  // 每帧重置屏幕拾取缓存
  window.__ds_jointScreen = [];

  if (!cameraRef) return;

  // 骨骼模式下恒绘制（临时打开绘制开关，帧尾恢复）
  const savedPaint = paint2dEnabled;
  paint2dEnabled = true;

  // 道具仍投影绘制（构图参考 + 拾取缓存）
  drawProps2D(cameraRef, w, h);

  // BODY_18 / COCO limbSeq（与 drawStickFigure / renderOpenPoseCanvas 一致）
  const limbSeq = [
    [1,2],[1,5],[2,3],[3,4],[5,6],[6,7],[1,8],[8,9],[9,10],
    [1,11],[11,12],[12,13],[1,0],[0,14],[14,16],[0,15],[15,17]
  ];
  // OpenPose 标准 17 色（与 pass-renderer renderOpenPoseCanvas 相同）
  const limbColors = [
    [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0],
    [85, 255, 0], [0, 255, 85], [0, 255, 170], [0, 255, 255],
    [0, 170, 255], [0, 85, 255], [0, 0, 255], [85, 0, 255],
    [170, 0, 255], [255, 0, 255], [255, 0, 170], [255, 0, 85],
    [255, 0, 0],
  ];

  const mgr = window.__ds?.externalCharacters;
  const entries = mgr && typeof mgr.getAll === "function" ? mgr.getAll() : [];
  const getJoints18 = window.__ds_getExternalJoints18;
  const s = Math.min(w, h) / 512;
  const _v = new THREE.Vector3();

  for (const entry of entries) {
    if (!entry || entry.visible === false) continue;
    if (entry.model && entry.model.visible === false) continue;
    if (typeof getJoints18 !== "function") break;

    let joints18 = null;
    try {
      joints18 = getJoints18(entry); // THREE.Vector3[18] 世界坐标（缺关节为零向量）
    } catch (e) { continue; }
    if (!Array.isArray(joints18) || joints18.length < 18) continue;

    const pts = joints18.map((j) => {
      _v.copy(j).project(cameraRef);
      return {
        x: (_v.x + 1) / 2 * w,
        y: (1 - _v.y) / 2 * h,
        behind: _v.z > 1,
        // 缺关节填的零向量不参与绘制（原点恰好全零的概率可忽略）
        missing: j.x === 0 && j.y === 0 && j.z === 0,
      };
    });

    // 画肢（OpenPose 彩色）
    ctx2d.lineCap = "round";
    limbSeq.forEach(([a, b], i) => {
      const pa = pts[a], pb = pts[b];
      if (pa.behind || pb.behind || pa.missing || pb.missing) return;
      const c = limbColors[i % limbColors.length];
      ctx2d.strokeStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      ctx2d.lineWidth = 3 * s;
      ctx2d.beginPath();
      ctx2d.moveTo(pa.x, pa.y);
      ctx2d.lineTo(pb.x, pb.y);
      ctx2d.stroke();
    });

    // 画关节点
    pts.forEach((p, i) => {
      if (p.behind || p.missing) return;
      const c = limbColors[i % limbColors.length];
      ctx2d.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      ctx2d.beginPath();
      ctx2d.arc(p.x, p.y, 3.5 * s, 0, Math.PI * 2);
      ctx2d.fill();
    });
  }

  // IK target/pole 保持可拖（编辑不中断）；内部会填充拾取缓存
  drawIKTargets(cameraRef, w, h);

  paint2dEnabled = savedPaint;
}

function drawGrid(w, h) {
  ctx2d.strokeStyle = "#444466";
  ctx2d.lineWidth = 0.5;
  const step = 40;
  for (let x = 0; x <= w; x += step) {
    ctx2d.beginPath(); ctx2d.moveTo(x, 0); ctx2d.lineTo(x, h); ctx2d.stroke();
  }
  for (let y = 0; y <= h; y += step) {
    ctx2d.beginPath(); ctx2d.moveTo(0, y); ctx2d.lineTo(w, y); ctx2d.stroke();
  }
}

/** 投影绘制道具（线框 + 选中包围盒 + 名称标签） */
function drawProps2D(cameraRef, w, h) {
  if (!cameraRef) return;
  const pm = window.__ds?.propManager;
  const entries = pm?.props || [];
  window.__ds_propScreen = [];
  if (!entries.length) return;

  const selected = typeof pm.getSelected === "function" ? pm.getSelected() : null;
  const centerV = new THREE.Vector3();

  for (const entry of entries) {
    const root = entry?.mesh;
    if (!root || !isVisibleInTree(root)) continue;

    root.updateWorldMatrix(true, true);
    let projectedSegments = 0;
    root.traverse((obj) => {
      if (!obj.isMesh || !obj.geometry) return;
      projectedSegments += drawMeshEdges(obj, cameraRef, w, h, entry === selected);
    });

    // 极端情况下（几何体为空/全部被裁剪）仍画包围盒，保证道具可见
    const box = new THREE.Box3().setFromObject(root);
    if (!box.isEmpty()) {
      if (projectedSegments === 0 || entry === selected) {
        drawBoundingBox(box, cameraRef, w, h, entry === selected);
      }
      box.getCenter(centerV);
      const labelPos = projectPoint(centerV, cameraRef, w, h);
      if (labelPos && !labelPos.behind) {
        window.__ds_propScreen.push({ id: entry.id, x: labelPos.x, y: labelPos.y, behind: false });
        if (!paint2dEnabled) continue; // WebGL 模式：只要拾取缓存，不画标签
        ctx2d.font = "11px sans-serif";
        ctx2d.textAlign = "center";
        ctx2d.fillStyle = entry === selected ? "#00ff88" : "#c9d4ff";
        ctx2d.strokeStyle = "rgba(0,0,0,0.75)";
        ctx2d.lineWidth = 3;
        ctx2d.strokeText(entry.name || entry.id, labelPos.x, labelPos.y - 8);
        ctx2d.fillText(entry.name || entry.id, labelPos.x, labelPos.y - 8);
      }
    }
  }
}

function isVisibleInTree(obj) {
  let cur = obj;
  while (cur) {
    if (cur.visible === false) return false;
    cur = cur.parent;
  }
  return true;
}

function getMeshColor(obj, fallback = "#5b8def") {
  const mat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
  return mat?.color ? `#${mat.color.getHexString()}` : fallback;
}

function projectPoint(vec, cameraRef, w, h) {
  const p = vec.clone().project(cameraRef);
  const behind = p.z < -1 || p.z > 1;
  return {
    x: (p.x + 1) / 2 * w,
    y: (1 - p.y) / 2 * h,
    behind,
  };
}

function drawMeshEdges(mesh, cameraRef, w, h, selected) {
  if (!isVisibleInTree(mesh)) return 0;
  const paint = paint2dEnabled; // WebGL 模式只计算段数（供包围盒 fallback 判断），不画线

  // 缓存 EdgesGeometry；几何体不变时每帧只投影，不重复拆边
  let edgeGeo = mesh.userData.__dsEdgeGeometry;
  if (!edgeGeo || mesh.userData.__dsEdgeSource !== mesh.geometry) {
    if (edgeGeo) edgeGeo.dispose();
    edgeGeo = new THREE.EdgesGeometry(mesh.geometry, 30);
    mesh.userData.__dsEdgeGeometry = edgeGeo;
    mesh.userData.__dsEdgeSource = mesh.geometry;
  }

  const pos = edgeGeo.getAttribute("position");
  if (!pos || pos.count < 2) return 0;

  // 导入模型可能很密：限制 2D 线框段数，避免每帧卡顿
  const maxSegments = 3000;
  const totalSegments = Math.floor(pos.count / 2);
  const stride = Math.max(1, Math.ceil(totalSegments / maxSegments));

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  let drawn = 0;

  ctx2d.beginPath();
  for (let seg = 0; seg < totalSegments; seg += stride) {
    const i = seg * 2;
    a.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    b.fromBufferAttribute(pos, i + 1).applyMatrix4(mesh.matrixWorld);
    const pa = projectPoint(a, cameraRef, w, h);
    const pb = projectPoint(b, cameraRef, w, h);
    if (pa.behind || pb.behind) continue;
    if (paint) {
      ctx2d.moveTo(pa.x, pa.y);
      ctx2d.lineTo(pb.x, pb.y);
    }
    drawn++;
  }

  if (drawn > 0 && paint) {
    ctx2d.strokeStyle = selected ? "#00ff88" : getMeshColor(mesh);
    ctx2d.globalAlpha = selected ? 0.95 : 0.72;
    ctx2d.lineWidth = selected ? 2.2 : 1.25;
    ctx2d.stroke();
    ctx2d.globalAlpha = 1;
  }
  return drawn;
}

function drawBoundingBox(box, cameraRef, w, h, selected) {
  if (!paint2dEnabled) return; // WebGL 模式：包围盒由 3D 场景本身呈现
  const min = box.min;
  const max = box.max;
  const corners = [
    [min.x, min.y, min.z], [max.x, min.y, min.z],
    [max.x, min.y, max.z], [min.x, min.y, max.z],
    [min.x, max.y, min.z], [max.x, max.y, min.z],
    [max.x, max.y, max.z], [min.x, max.y, max.z],
  ].map((p) => projectPoint(new THREE.Vector3(p[0], p[1], p[2]), cameraRef, w, h));

  const edges = [
    [0,1],[1,2],[2,3],[3,0],
    [4,5],[5,6],[6,7],[7,4],
    [0,4],[1,5],[2,6],[3,7],
  ];

  ctx2d.beginPath();
  let drawn = 0;
  for (const [ia, ib] of edges) {
    const pa = corners[ia];
    const pb = corners[ib];
    if (pa.behind || pb.behind) continue;
    ctx2d.moveTo(pa.x, pa.y);
    ctx2d.lineTo(pb.x, pb.y);
    drawn++;
  }
  if (drawn > 0) {
    ctx2d.strokeStyle = selected ? "#00ff88" : "#8fa8ff";
    ctx2d.lineWidth = selected ? 2.5 : 1.5;
    ctx2d.stroke();
  }
}

// opts: { color, isActive, charId } — 多人模式着色/激活标记/拾取归属；缺省走旧彩虹单角色路径
function drawStickFigure(joints, cameraRef, w, h, ikMode, opts) {
  if (!joints || joints.length < 18) return;
  opts = opts || {};
  const charColor = opts.color || null;
  const isActiveChar = !!opts.isActive;
  const charId = opts.charId != null ? opts.charId : null;

  const selectedJoint = window.__ds_selectedJoint || null;
  const hoverJoint = window.__ds_hoverJoint || null;

  // COCO limbSeq
  const limbSeq = [
    [1,2],[1,5],[2,3],[3,4],[5,6],[6,7],[1,8],[8,9],[9,10],
    [1,11],[11,12],[12,13],[1,0],[0,14],[14,16],[0,15],[15,17]
  ];
  const colors = [
    "#ff0000","#ff5500","#ffaa00","#ffff00","#aaff00","#55ff00","#00ff00",
    "#00ff55","#00ffaa","#00ffff","#00aaff","#0055ff","#0000ff","#5500ff",
    "#aa00ff","#ff00ff","#ff00aa"
  ];

  const screenPos = joints.map(j => {
    const v = new THREE.Vector3();
    j.getWorldPosition(v); // 与拾取/射线统一用世界坐标（多角色父级变换下不会错位）
    v.project(cameraRef);
    return {
      x: (v.x + 1) / 2 * w,
      y: (1 - v.y) / 2 * h,
      behind: v.z > 1, // 相机背后
    };
  });

  // 缓存屏幕拾取坐标（视觉=拾取，根治关节点选不中）
  // IK 模式下关节球不可拾取（由 drawIKTargets 的 target/pole 接管）
  if (!ikMode) {
    screenPos.forEach((p, i) => {
      window.__ds_jointScreen.push({ x: p.x, y: p.y, behind: p.behind, obj: joints[i], charId });
    });
  }

  const jointColor = (i) => charColor || colors[i % colors.length];

  // 画肢（WebGL 模式跳过绘制，上方屏幕拾取缓存已填充）
  if (paint2dEnabled) limbSeq.forEach(([a,b], i) => {
    const pa = screenPos[a], pb = screenPos[b];
    if (pa.behind || pb.behind) return;
    ctx2d.beginPath();
    ctx2d.moveTo(pa.x, pa.y);
    ctx2d.lineTo(pb.x, pb.y);
    ctx2d.strokeStyle = jointColor(i);
    ctx2d.lineWidth = charColor ? (isActiveChar ? 4 : 2.5) : 3;
    ctx2d.stroke();
  });

  // 画关节（IK 模式下画小灰点仅作视觉参考，不参与拾取）
  if (paint2dEnabled) screenPos.forEach((p, i) => {
    if (p.behind) return;
    const isSel = joints[i] === selectedJoint;
    const isHover = joints[i] === hoverJoint;
    // hover/selected 高亮优先于活动角色标记
    const r = ikMode ? 3 : (isSel ? 8 : isHover ? 7 : (charColor ? (isActiveChar ? 6 : 5) : 5));
    ctx2d.beginPath();
    ctx2d.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx2d.fillStyle = ikMode ? "#888899" : jointColor(i);
    ctx2d.fill();
    ctx2d.strokeStyle = isSel ? "#ffffff" : isHover ? "#ffff88" : (isActiveChar && !ikMode ? "#ffffff" : "#000");
    ctx2d.lineWidth = isSel || isHover ? 2 : (isActiveChar && !ikMode ? 2 : 1);
    ctx2d.stroke();
  });
}

/** IK 模式：投影绘制 target（青色大圈）/ pole（黄色小点），并缓存屏幕拾取坐标 */
function drawIKTargets(cameraRef, w, h) {
  const selectedJoint = window.__ds_selectedJoint || null;
  const hoverJoint = window.__ds_hoverJoint || null;
  const list = [];

  const api = window.DS_FigureAPI;
  const externalGlbMode = !!window.__ds?.isGLBMode;
  const externalVrmMode = !!window.__ds?.isVRMMode;
  const externalMode = externalGlbMode || externalVrmMode;
  const char = !externalMode && api ? api.getActiveCharacter() : null;
  const activeCharId = char ? String(char.id) : null;
  if (char) {
    for (const state of Object.values(char.ikState)) {
      list.push({ obj: state.target, kind: "target", charId: activeCharId }, { obj: state.pole, kind: "pole", charId: activeCharId });
    }
  }
  if (externalMode) {
    const mgr = window.__ds?.externalCharacters;
    if (mgr && mgr.characters?.size) {
      // P1.5：枚举全部可见外部角色的 IK 目标（点击谁的球就激活谁；非活动角色略淡）
      for (const entry of mgr.characters.values()) {
        if (!entry.ikTargets) continue;
        if (entry.visible === false) continue;
        if (entry.model && entry.model.visible === false) continue;
        const dim = mgr.activeCharacterId && entry.id !== mgr.activeCharacterId;
        for (const t of Object.values(entry.ikTargets)) {
          list.push({ obj: t.target, kind: "target", charId: entry.id, dim }, { obj: t.pole, kind: "pole", charId: entry.id, dim });
        }
      }
    } else {
      // 旧路径兼容
      if (externalGlbMode && window.__ds?.glbData?.ikTargets) {
        for (const t of Object.values(window.__ds.glbData.ikTargets)) {
          list.push({ obj: t.target, kind: "target", charId: null }, { obj: t.pole, kind: "pole", charId: null });
        }
      }
      if (externalVrmMode && window.__ds?.vrmData?.ikTargets) {
        for (const t of Object.values(window.__ds.vrmData.ikTargets)) {
          list.push({ obj: t.target, kind: "target", charId: null }, { obj: t.pole, kind: "pole", charId: null });
        }
      }
    }
  }

  const _v = new THREE.Vector3();
  for (const { obj, kind, charId, dim } of list) {
    if (!obj) continue;
    // IK 球可能挂在有变换的父级下，必须用世界坐标投影
    obj.getWorldPosition(_v);
    _v.project(cameraRef);
    const behind = _v.z > 1;
    const sx = (_v.x + 1) / 2 * w;
    const sy = (1 - _v.y) / 2 * h;
    window.__ds_jointScreen.push({ x: sx, y: sy, behind, obj, charId });
    if (behind || !paint2dEnabled) continue;
    const isSel = obj === selectedJoint;
    const isHover = obj === hoverJoint;
    const r = kind === "target" ? (isSel ? 12 : isHover ? 11 : 9) : (isSel ? 7 : 6);
    if (dim) ctx2d.globalAlpha = 0.45; // 非活动外部角色：淡显，提示点击可激活
    ctx2d.beginPath();
    ctx2d.arc(sx, sy, r, 0, Math.PI * 2);
    if (kind === "target") {
      ctx2d.strokeStyle = isSel ? "#ffffff" : isHover ? "#ffff88" : "#33e0ff";
      ctx2d.lineWidth = isSel || isHover ? 3 : 2;
      ctx2d.stroke();
    } else {
      ctx2d.fillStyle = isSel ? "#ffffff" : isHover ? "#ffff88" : "#ffcc33";
      ctx2d.fill();
      ctx2d.strokeStyle = "#000";
      ctx2d.lineWidth = 1;
      ctx2d.stroke();
    }
    if (dim) ctx2d.globalAlpha = 1;
  }
}

/**
 * 线框模式切换（P2-fix：原为空函数=假功能；实现为遍历场景 mesh 切换 wireframe）
 */
export function setWireframeMode(enabled) {
  if (!scene) return;
  scene.traverse((child) => {
    if (!(child.isMesh || child.isSkinnedMesh) || !child.material) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const m of mats) {
      if (m && "wireframe" in m) m.wireframe = !!enabled;
    }
  });
}
