/**
 * scene.js — Three.js 渲染器、场景、相机、灯光初始化
 */
import * as THREE from "three";

let renderer = null;
let scene = null;
let camera = null;
let grid = null;
let axes = null;
let viewportEl = null;

/** 创建 WebGLRenderer */
export function createRenderer() {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(512, 768); // 初始设置合理尺寸，避免 1x1 导致不可见
  return renderer;
}

/** 创建场景（含灯光、网格、坐标轴） */
export function createScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x222233);

  grid = new THREE.GridHelper(6, 12, 0x888899, 0x333344);
  scene.add(grid);

  axes = new THREE.AxesHelper(0.6);
  scene.add(axes);

  // 诊断信标：原点红色大球，确认渲染正常
  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(0.1, 16, 8),
    new THREE.MeshStandardMaterial({ color: 0xff0000, emissive: 0x440000, roughness: 0.3 })
  );
  beacon.position.set(0, 1, 0);
  beacon.name = "diagnostic_beacon";
  scene.add(beacon);

  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x34322c, 1.5));
  const dirLight = new THREE.DirectionalLight(0xffffff, 2);
  dirLight.position.set(2.5, 4, 3);
  scene.add(dirLight);

  return scene;
}

/** 创建 PerspectiveCamera（初始 fov 由焦距决定） */
export function createCamera(fovDeg, aspect) {
  camera = new THREE.PerspectiveCamera(fovDeg, aspect, 0.1, 100);
  camera.position.set(0, 1.4, 3.2);
  camera.lookAt(0, 1, 0);
  return camera;
}

/** 获取当前相机 */
export function getCamera() {
  return camera;
}

/** 获取当前渲染器 */
export function getRenderer() {
  return renderer;
}

/** 获取场景 */
export function getScene() {
  return scene;
}

/** 获取 Grid/Axes 引用（depth 导出时需要隐藏它们） */
export function getSceneHelpers() {
  return { grid, axes };
}

/** 将渲染器 canvas 挂到 DOM */
export function mountRenderer(viewportElem) {
  viewportEl = viewportElem;
  const canvas = renderer.domElement;
  canvas.style.display = "block";
  canvas.style.maxWidth = "100%";
  canvas.style.maxHeight = "100%";
  viewportEl.appendChild(canvas);
}

/** 获取渲染器 canvas 的 bounding rect */
export function getCanvasRect() {
  if (!renderer || !viewportEl) return null;
  return renderer.domElement.getBoundingClientRect();
}

/* ======================== M2 扩展 ======================== */

/**
 * 获取所有场景中的可视网格对象（用于渲染通道遍历）
 */
export function getAllSceneMeshObjects() {
  const objects = [];
  if (!scene) return objects;
  scene.traverseVisible((child) => {
    if (child.isMesh || child.isSkinnedMesh) {
      objects.push(child);
    }
  });
  return objects;
}

/**
 * 更新相机引用（M2 用 CameraManager 替换默认相机时调用）
 */
export function setCamera(newCamera) {
  camera = newCamera;
}

/**
 * 设置线框模式（所有 Material wireframe）
 */
export function setWireframeMode(enabled) {
  if (!scene) return;
  scene.traverse((child) => {
    if (child.isMesh && child.material && !child.userData._noWireframe) {
      if (Array.isArray(child.material)) {
        child.material.forEach((m) => { m.wireframe = enabled; });
      } else {
        child.material.wireframe = enabled;
      }
    }
  });
}

/**
 * 获取当前所有角色组（从 DS_FigureAPI 或 fallback 到 M1 figureGroup）
 * @returns {Array<{id:string, group:THREE.Group}>}
 */
export function getCharacterGroups() {
  const groups = [];
  if (!scene) return groups;

  try {
    if (window.DS_FigureAPI && window.DS_FigureAPI.getAllCharacters) {
      const chars = window.DS_FigureAPI.getAllCharacters();
      if (chars && typeof chars.forEach === "function") {
        chars.forEach((ch, id) => {
          const group = ch.skeletonGroup || ch.group || ch;
          groups.push({ id: String(id), group });
        });
        return groups;
      }
    }
  } catch (e) {
    // DS_FigureAPI not ready
  }

  // Fallback: M1 single figureGroup
  if (window.__ds && window.__ds.figureGroup) {
    groups.push({ id: "char_01", group: window.__ds.figureGroup });
  }
  return groups;
}
