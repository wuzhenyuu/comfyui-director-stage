/**
 * export.js — OpenPose / Depth 导出、上传到 ComfyUI、应用到节点
 */
import * as THREE from "three";
import { LIMB_SEQ, POSE_COLORS } from "./constants.js";
import { getCamera, getRenderer, getScene, getSceneHelpers } from "./scene.js";

/**
 * 渲染 OpenPose 骨骼图到 canvas（尺寸严格等于 w×h）
 */
export function renderOpenPoseCanvas(joints, w, h) {
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);

  const cam = getCamera();
  cam.updateMatrixWorld();
  const v = new THREE.Vector3();
  const pts = joints.map((j) => {
    j.getWorldPosition(v);
    v.project(cam);
    return [((v.x + 1) / 2) * w, ((1 - v.y) / 2) * h];
  });

  const s = Math.min(w, h) / 512; // 线宽/半径随分辨率等比缩放
  ctx.lineCap = "round";
  LIMB_SEQ.forEach(([a, b], i) => {
    const c = POSE_COLORS[i];
    ctx.strokeStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
    ctx.lineWidth = 4 * s;
    ctx.beginPath();
    ctx.moveTo(pts[a][0], pts[a][1]);
    ctx.lineTo(pts[b][0], pts[b][1]);
    ctx.stroke();
  });
  pts.forEach((p, j) => {
    const c = POSE_COLORS[j];
    ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
    ctx.beginPath();
    ctx.arc(p[0], p[1], 4 * s, 0, Math.PI * 2);
    ctx.fill();
  });
  return cv;
}

const depthMat = new THREE.MeshDepthMaterial();

/**
 * 渲染 Depth 图到 canvas（尺寸严格等于 w×h）
 */
export function renderDepthCanvas(joints, w, h) {
  const scene = getScene();
  const renderer = getRenderer();
  const cam = getCamera();
  const { grid, axes } = getSceneHelpers();

  // 1) 隐藏辅助物件
  const prevGrid = grid.visible;
  const prevAxes = axes.visible;
  grid.visible = false;
  axes.visible = false;

  // 2) 调整 near/far
  const prevBg = scene.background;
  scene.background = new THREE.Color(0x000000);
  const prevNear = cam.near;
  const prevFar = cam.far;

  const fwd = new THREE.Vector3();
  cam.getWorldDirection(fwd);
  const camPos = new THREE.Vector3();
  cam.getWorldPosition(camPos);
  let minD = Infinity;
  let maxD = -Infinity;
  const vt = new THREE.Vector3();
  joints.forEach((j) => {
    j.getWorldPosition(vt);
    const d = vt.sub(camPos).dot(fwd);
    if (d < minD) minD = d;
    if (d > maxD) maxD = d;
  });
  cam.near = Math.max(0.05, minD - 0.5);
  cam.far = Math.max(cam.near + 0.2, maxD + 0.5);
  cam.updateProjectionMatrix();

  // 3) 深度渲染到 RenderTarget（分辨率严格 w×h）
  scene.overrideMaterial = depthMat;
  const rt = new THREE.WebGLRenderTarget(w, h);
  renderer.setRenderTarget(rt);
  renderer.render(scene, cam);
  const buf = new Uint8Array(w * h * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
  renderer.setRenderTarget(null);
  rt.dispose();

  // 4) 恢复
  scene.overrideMaterial = null;
  scene.background = prevBg;
  cam.near = prevNear;
  cam.far = prevFar;
  cam.updateProjectionMatrix();
  grid.visible = prevGrid;
  axes.visible = prevAxes;

  // 5) 像素上下翻转写入 canvas
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d");
  const img = ctx.createImageData(w, h);
  const row = w * 4;
  for (let y = 0; y < h; y++) {
    img.data.set(buf.subarray((h - 1 - y) * row, (h - y) * row), y * row);
  }
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
  ctx.putImageData(img, 0, 0);
  return cv;
}

function canvasToBlob(cv) {
  return new Promise((resolve, reject) => {
    cv.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob 失败"))), "image/png");
  });
}

async function uploadCanvas(cv, filename) {
  const blob = await canvasToBlob(cv);
  const fd = new FormData();
  fd.append("image", blob, filename);
  fd.append("subfolder", "director_stage");
  fd.append("type", "input");
  const res = await fetch("/upload/image", { method: "POST", body: fd });
  if (!res.ok) throw new Error(`上传失败 HTTP ${res.status}`);
  const j = await res.json();
  return (j.subfolder ? j.subfolder + "/" : "") + j.name;
}

/**
 * 执行"应用到节点"
 * @param {THREE.Mesh[]} joints
 * @param {number} exportW
 * @param {number} exportH
 * @param {string} sceneGz
 * @returns {Promise<{manifest, sceneGz}>}
 */
export async function performApply(joints, exportW, exportH, sceneGz) {
  const poseCv = renderOpenPoseCanvas(joints, exportW, exportH);
  const depthCv = renderDepthCanvas(joints, exportW, exportH);
  const t = Date.now();
  const openpose = await uploadCanvas(poseCv, `director_pose_${t}.png`);
  const depth = await uploadCanvas(depthCv, `director_depth_${t}.png`);
  const manifest = { files: { openpose, depth } };
  window.parent.postMessage(
    { type: "exportDone", payload: { manifest, sceneGz } },
    "*"
  );
  return { manifest, sceneGz };
}
