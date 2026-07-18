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
  return renderer;
}

/** 创建场景（含灯光、网格、坐标轴） */
export function createScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14161c);

  grid = new THREE.GridHelper(6, 12, 0x55607a, 0x262b38);
  scene.add(grid);

  axes = new THREE.AxesHelper(0.6);
  scene.add(axes);

  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x34322c, 1.1));
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.6);
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
  viewportEl.appendChild(renderer.domElement);
}

/** 获取渲染器 canvas 的 bounding rect */
export function getCanvasRect() {
  if (!renderer || !viewportEl) return null;
  return renderer.domElement.getBoundingClientRect();
}
