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

/**
 * 信箱式布局：按相机 aspect 把 canvas2d 居中放进 viewport
 * （修复全视口铺满导致的投影拉伸变形）
 */
export function layoutCanvas2d() {
  if (!canvas2d || !viewportEl) return;
  const cw = viewportEl.clientWidth;
  const ch = viewportEl.clientHeight;
  if (cw <= 0 || ch <= 0) return;
  const aspect = (camera && camera.aspect) || (cw / ch);
  let vw = cw;
  let vh = Math.round(cw / aspect);
  if (vh > ch) {
    vh = ch;
    vw = Math.round(ch * aspect);
  }
  const ox = Math.round((cw - vw) / 2);
  const oy = Math.round((ch - vh) / 2);
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

export function mountRendererCanvas(viewportElem) {
  mountRenderer(viewportElem);
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

export function getAllSceneMeshObjects() {
  return [];
}

/** 2D绘图：清屏+网格+火柴人+信标 */
export function drawFrame(figureGroup, joints, cameraRef, fkMode) {
  if (!ctx2d || !canvas2d) return;

  // 用 canvas 自身 CSS 尺寸（信箱布局后的可视区域）
  const w = canvas2d.clientWidth || canvas2d.width / 2;
  const h = canvas2d.clientHeight || canvas2d.height / 2;
  if (w <= 0 || h <= 0) return;

  // 清屏（坐标系已 scale(2,2)，用 CSS 像素）
  ctx2d.clearRect(0, 0, w, h);

  // 背景
  ctx2d.fillStyle = "#222233";
  ctx2d.fillRect(0, 0, w, h);

  // 网格
  drawGrid(w, h);

  // 每帧重置屏幕拾取缓存（pointerdown 的屏幕空间拾取依赖它）
  window.__ds_jointScreen = [];

  if (!cameraRef) return;

  // 火柴人：多角色遍历（无 DS_FigureAPI 时 fallback 画传入的 joints）
  const api = window.DS_FigureAPI;
  let chars = [];
  if (api) {
    try {
      const all = api.getAllCharacters();
      if (all && typeof all.forEach === "function") all.forEach((ch) => chars.push(ch));
    } catch (e) { /* ignore */ }
  }
  const active = api ? api.getActiveCharacter() : null;
  if (chars.length) {
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
  } else {
    drawStickFigure(joints, cameraRef, w, h, fkMode);
  }

  // IK 模式：把 IK target/pole 也投影画出来（否则 2D 里完全点不到）
  if (fkMode) drawIKTargets(cameraRef, w, h);

  // 原点信标
  const beaconPos = new THREE.Vector3(0, 1, 0);
  beaconPos.project(cameraRef);
  if (beaconPos.z < 1) { // 相机前方才画
    const bx = (beaconPos.x + 1) / 2 * w;
    const by = (1 - beaconPos.y) / 2 * h;
    ctx2d.beginPath();
    ctx2d.arc(bx, by, 8, 0, Math.PI * 2);
    ctx2d.fillStyle = "#ff4444";
    ctx2d.fill();
  }
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

  // 画肢
  limbSeq.forEach(([a,b], i) => {
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
  screenPos.forEach((p, i) => {
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
  const char = api ? api.getActiveCharacter() : null;
  const activeCharId = char ? String(char.id) : null;
  if (char) {
    for (const state of Object.values(char.ikState)) {
      list.push({ obj: state.target, kind: "target", charId: activeCharId }, { obj: state.pole, kind: "pole", charId: activeCharId });
    }
  }
  if (window.__ds?.glbData?.ikTargets) {
    for (const t of Object.values(window.__ds.glbData.ikTargets)) {
      list.push({ obj: t.target, kind: "target", charId: null }, { obj: t.pole, kind: "pole", charId: null });
    }
  }

  const _v = new THREE.Vector3();
  for (const { obj, kind, charId } of list) {
    if (!obj) continue;
    // IK 球可能挂在有变换的父级下，必须用世界坐标投影
    obj.getWorldPosition(_v);
    _v.project(cameraRef);
    const behind = _v.z > 1;
    const sx = (_v.x + 1) / 2 * w;
    const sy = (1 - _v.y) / 2 * h;
    window.__ds_jointScreen.push({ x: sx, y: sy, behind, obj, charId });
    if (behind) continue;
    const isSel = obj === selectedJoint;
    const isHover = obj === hoverJoint;
    const r = kind === "target" ? (isSel ? 12 : isHover ? 11 : 9) : (isSel ? 7 : 6);
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
  }
}

/** 线框模式切换（2D模式无操作） */
export function setWireframeMode() {}
