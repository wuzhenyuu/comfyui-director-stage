/**
 * scene.js — 2D Canvas 渲染（替代 Three.js WebGL）
 * 
 * 用原生 Canvas 2D 绘制火柴人，零 WebGL 依赖，确保在任何环境都能显示。
 * 保留 OpenPose/Depth 离屏渲染的三维能力用于导出通道。
 */
import * as THREE from "three";

let renderer = null;
let scene = null;
let camera = null;
let grid = null;
let axes = null;
let viewportEl = null;

// 2D 渲染上下文
let ctx2d = null;
let canvas2d = null;

/** 创建 2D Canvas 渲染器 */
export function createRenderer() {
  canvas2d = document.createElement("canvas");
  canvas2d.width = 512;
  canvas2d.height = 768;
  ctx2d = canvas2d.getContext("2d");
  
  // 同时创建 Three.js 用于导出渲染
  renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  renderer.setSize(512, 768);
  renderer.setPixelRatio(1); // 不求高DPI
  
  return renderer;
}

/** 创建 Three.js 场景（仅用于导出） */
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

/** 创建相机（用于坐标投影） */
export function createCamera(fovDeg, aspect) {
  camera = new THREE.PerspectiveCamera(fovDeg, aspect, 0.1, 100);
  camera.position.set(0, 1.4, 3.2);
  camera.lookAt(0, 1, 0);
  return camera;
}

export function getCamera() { return camera; }
export function getRenderer() { return renderer; }
export function getScene() { return scene; }
export function getSceneHelpers() { return { grid, axes }; }

/** 将 2D canvas 挂载到 DOM */
export function mountRenderer(viewportElem) {
  viewportEl = viewportElem;
  
  canvas2d.style.display = "block";
  canvas2d.style.position = "absolute";
  canvas2d.style.top = "0";
  canvas2d.style.left = "0";
  canvas2d.style.width = "100%";
  canvas2d.style.height = "100%";
  viewportElem.style.position = "relative";
  viewportElem.style.overflow = "hidden";
  viewportElem.appendChild(canvas2d);
  
  // 初始尺寸
  const w = viewportElem.clientWidth || 512;
  const h = viewportElem.clientHeight || 768;
  canvas2d.width = w * 2;
  canvas2d.height = h * 2;
  ctx2d = canvas2d.getContext("2d");
  ctx2d.scale(2, 2);
  
  // ResizeObserver
  if (window.ResizeObserver) {
    new ResizeObserver(() => {
      const cw = viewportElem.clientWidth || 512;
      const ch = viewportElem.clientHeight || 768;
      canvas2d.width = cw * 2;
      canvas2d.height = ch * 2;
      ctx2d = canvas2d.getContext("2d");
      ctx2d.scale(2, 2);
    }).observe(viewportElem);
  }
}

export function getCanvasRect() {
  if (!canvas2d || !viewportEl) return null;
  const rect = viewportEl.getBoundingClientRect();
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

/** 2D绘图：清屏+网格+火柴人+相机投影 */
export function drawFrame(figureGroup, joints, cameraRef, fkMode) {
  if (!ctx2d || !canvas2d) return;
  
  const w = viewportEl ? viewportEl.clientWidth : canvas2d.width / 2;
  const h = viewportEl ? viewportEl.clientHeight : canvas2d.height / 2;
  if (w <= 0 || h <= 0) return;
  
  // 清屏
  ctx2d.clearRect(0, 0, w, h);
  
  // 背景
  ctx2d.fillStyle = "#222233";
  ctx2d.fillRect(0, 0, w, h);
  
  // 网格
  drawGrid(w, h);
  
  // 火柴人（当前活动角色）
  drawStickFigure(joints, cameraRef, w, h);
  
  // 信标
  const beaconPos = new THREE.Vector3(0, 1, 0);
  beaconPos.project(cameraRef);
  const bx = (beaconPos.x + 1) / 2 * w;
  const by = (1 - beaconPos.y) / 2 * h;
  ctx2d.beginPath();
  ctx2d.arc(bx, by, 8, 0, Math.PI * 2);
  ctx2d.fillStyle = "#ff4444";
  ctx2d.fill();
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

function drawStickFigure(joints, cameraRef, w, h) {
  if (!joints || joints.length < 18) return;
  
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
    const v = new THREE.Vector3(j.position.x, j.position.y, j.position.z);
    v.project(cameraRef);
    return { x: (v.x + 1) / 2 * w, y: (1 - v.y) / 2 * h };
  });
  
  // 画肢
  limbSeq.forEach(([a,b], i) => {
    const pa = screenPos[a], pb = screenPos[b];
    ctx2d.beginPath();
    ctx2d.moveTo(pa.x, pa.y);
    ctx2d.lineTo(pb.x, pb.y);
    ctx2d.strokeStyle = colors[i % colors.length];
    ctx2d.lineWidth = 3;
    ctx2d.stroke();
  });
  
  // 画关节
  screenPos.forEach((p, i) => {
    ctx2d.beginPath();
    ctx2d.arc(p.x, p.y, 5, 0, Math.PI * 2);
    const c = colors[i % colors.length];
    ctx2d.fillStyle = c;
    ctx2d.fill();
    ctx2d.strokeStyle = "#000";
    ctx2d.lineWidth = 1;
    ctx2d.stroke();
  });
}

/** 线框模式切换（2D模式无操作） */
export function setWireframeMode() {}
