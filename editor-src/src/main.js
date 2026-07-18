import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { gzip, ungzip } from "pako";

/* ========================= 常量定义 ========================= */

// COCO-18 关节顺序
const JOINT_CN = [
  "鼻", "颈", "右肩", "右肘", "右腕", "左肩", "左肘", "左腕",
  "右髋", "右膝", "右踝", "左髋", "左膝", "左踝",
  "右眼", "左眼", "右耳", "左耳",
];

// T-pose 默认坐标（米），COCO-18 顺序
const T_POSE = [
  [0.0, 1.62, 0.05],   // 0 Nose
  [0.0, 1.45, 0.0],    // 1 Neck
  [-0.18, 1.45, 0.0],  // 2 RShoulder
  [-0.45, 1.45, 0.0],  // 3 RElbow
  [-0.7, 1.45, 0.0],   // 4 RWrist
  [0.18, 1.45, 0.0],   // 5 LShoulder
  [0.45, 1.45, 0.0],   // 6 LElbow
  [0.7, 1.45, 0.0],    // 7 LWrist
  [-0.1, 0.95, 0.0],   // 8 RHip
  [-0.11, 0.52, 0.0],  // 9 RKnee
  [-0.12, 0.08, 0.0],  // 10 RAnkle
  [0.1, 0.95, 0.0],    // 11 LHip
  [0.11, 0.52, 0.0],   // 12 LKnee
  [0.12, 0.08, 0.0],   // 13 LAnkle
  [-0.03, 1.66, 0.07], // 14 REye
  [0.03, 1.66, 0.07],  // 15 LEye
  [-0.07, 1.64, 0.02], // 16 REar
  [0.07, 1.64, 0.02],  // 17 LEar
];

// OpenPose limbSeq（0 基索引对）
const LIMB_SEQ = [
  [1, 2], [1, 5], [2, 3], [3, 4], [5, 6], [6, 7],
  [1, 8], [8, 9], [9, 10], [1, 11], [11, 12], [12, 13],
  [1, 0], [0, 14], [14, 16], [0, 15], [15, 17],
];

// OpenPose 18 色调色板
const POSE_COLORS = [
  [255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0],
  [170, 255, 0], [85, 255, 0], [0, 255, 0], [0, 255, 85],
  [0, 255, 170], [0, 255, 255], [0, 170, 255], [0, 85, 255],
  [0, 0, 255], [85, 0, 255], [170, 0, 255], [255, 0, 255],
  [255, 0, 170], [255, 0, 85],
];

const JOINT_COLOR = 0x4da6ff;
const SELECT_COLOR = 0xffcc00;

// 导出分辨率（由 init 消息覆盖）
let exportW = 512;
let exportH = 768;

/* ========================= DOM ========================= */

const viewportEl = document.getElementById("viewport");
const btnApply = document.getElementById("btnApply");
const btnCancel = document.getElementById("btnCancel");
const statusEl = document.getElementById("status");

function setStatus(msg) {
  statusEl.textContent = msg ? `${msg}　|　导出 ${exportW}×${exportH}` : `导出 ${exportW}×${exportH}`;
}

/* ========================= 渲染器 / 场景 ========================= */

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio || 1);
viewportEl.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14161c);

const camera = new THREE.PerspectiveCamera(40, exportW / exportH, 0.1, 100);
camera.position.set(0, 1.4, 3.2);
camera.lookAt(0, 1, 0);

const grid = new THREE.GridHelper(6, 12, 0x55607a, 0x262b38);
scene.add(grid);
const axes = new THREE.AxesHelper(0.6);
scene.add(axes);

scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x34322c, 1.1));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.6);
dirLight.position.set(2.5, 4, 3);
scene.add(dirLight);

/* ========================= 轨道控制 ========================= */

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(0, 1, 0);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
// 左键留给关节选取/拖动，右键旋转视角，中键平移
orbit.mouseButtons = {
  LEFT: null,
  MIDDLE: THREE.MOUSE.PAN,
  RIGHT: THREE.MOUSE.ROTATE,
};
orbit.update();

/* ========================= 火柴人 ========================= */

const figure = new THREE.Group();
scene.add(figure);

const jointGeo = new THREE.SphereGeometry(0.035, 24, 16);
const joints = T_POSE.map((p, i) => {
  const mesh = new THREE.Mesh(
    jointGeo,
    new THREE.MeshStandardMaterial({ color: JOINT_COLOR, roughness: 0.5, metalness: 0.05 })
  );
  mesh.position.set(p[0], p[1], p[2]);
  mesh.userData.index = i;
  figure.add(mesh);
  return mesh;
});

const boneGeo = new THREE.CylinderGeometry(0.012, 0.012, 1, 10, 1, true);
const boneMat = new THREE.MeshStandardMaterial({ color: 0x9fb8cc, roughness: 0.6, metalness: 0.05 });
const bones = LIMB_SEQ.map(() => {
  const b = new THREE.Mesh(boneGeo, boneMat);
  figure.add(b);
  return b;
});

const _va = new THREE.Vector3();
const _vb = new THREE.Vector3();
const _vd = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

// 关节移动后实时更新连接圆柱（每帧调用，开销可忽略）
function updateBones() {
  for (let i = 0; i < LIMB_SEQ.length; i++) {
    const [a, b] = LIMB_SEQ[i];
    _va.copy(joints[a].position);
    _vb.copy(joints[b].position);
    const bone = bones[i];
    bone.position.copy(_va).add(_vb).multiplyScalar(0.5);
    _vd.copy(_vb).sub(_va);
    const len = Math.max(_vd.length(), 1e-6);
    bone.scale.set(1, len, 1);
    bone.quaternion.setFromUnitVectors(_up, _vd.normalize());
  }
}
updateBones();

/* ========================= TransformControls ========================= */

const tctrl = new TransformControls(camera, renderer.domElement);
tctrl.setMode("translate");
tctrl.setSize(0.65);
tctrl.addEventListener("dragging-changed", (e) => {
  orbit.enabled = !e.value;
});
// r169+ 需要把 helper 加入场景；旧版本 TransformControls 本身就是 Object3D
const gizmo = typeof tctrl.getHelper === "function" ? tctrl.getHelper() : tctrl;
scene.add(gizmo);

let selected = null;
function selectJoint(joint) {
  if (selected === joint) return;
  if (selected) selected.material.color.setHex(JOINT_COLOR);
  selected = joint;
  if (joint) {
    joint.material.color.setHex(SELECT_COLOR);
    tctrl.attach(joint);
    setStatus(`已选中：${JOINT_CN[joint.userData.index]}`);
  } else {
    tctrl.detach();
    setStatus("");
  }
}

/* ========================= 关节拾取 ========================= */

const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
let downXY = null;

function ndcFromEvent(e) {
  const r = renderer.domElement.getBoundingClientRect();
  pointerNdc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  pointerNdc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
}

renderer.domElement.addEventListener("pointerdown", (e) => {
  if (e.button === 0) downXY = [e.clientX, e.clientY];
});

renderer.domElement.addEventListener("pointerup", (e) => {
  if (e.button !== 0 || !downXY) return;
  const moved = Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]) > 5;
  downXY = null;
  // 拖动手势 / 正在拖 gizmo / 悬停在 gizmo 轴上时不做拾取
  if (moved || tctrl.dragging || tctrl.axis) return;
  ndcFromEvent(e);
  raycaster.setFromCamera(pointerNdc, camera);
  const hits = raycaster.intersectObjects(joints, false);
  selectJoint(hits.length ? hits[0].object : null);
});

renderer.domElement.addEventListener("pointermove", (e) => {
  if (tctrl.dragging) return;
  ndcFromEvent(e);
  raycaster.setFromCamera(pointerNdc, camera);
  const hit = raycaster.intersectObjects(joints, false).length > 0;
  renderer.domElement.style.cursor = hit ? "pointer" : "default";
});

/* ========================= 视口自适应（跟随导出画幅比例） ========================= */

function applyViewport() {
  const cw = viewportEl.clientWidth;
  const ch = viewportEl.clientHeight;
  if (cw <= 0 || ch <= 0) return;
  const aspect = exportW / exportH;
  let vw = cw;
  let vh = Math.round(cw / aspect);
  if (vh > ch) {
    vh = ch;
    vw = Math.round(ch * aspect);
  }
  renderer.setSize(vw, vh);
  camera.aspect = exportW / exportH;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", applyViewport);

/* ========================= 场景序列化（sceneGz） ========================= */

function encodeSceneGz() {
  const arr = joints.map((j) => [
    +j.position.x.toFixed(4),
    +j.position.y.toFixed(4),
    +j.position.z.toFixed(4),
  ]);
  const gz = gzip(JSON.stringify(arr));
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < gz.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, gz.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function decodeSceneGz(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const arr = JSON.parse(new TextDecoder().decode(ungzip(u8)));
  if (!Array.isArray(arr)) throw new Error("sceneGz 内容不是数组");
  arr.forEach((p, i) => {
    if (joints[i] && Array.isArray(p) && p.length >= 3) {
      joints[i].position.set(+p[0], +p[1], +p[2]);
    }
  });
  updateBones();
}

/* ========================= OpenPose 导出 ========================= */

function renderOpenPoseCanvas(w, h) {
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);

  camera.updateMatrixWorld();
  const v = new THREE.Vector3();
  const pts = joints.map((j) => {
    j.getWorldPosition(v);
    v.project(camera); // 相机 aspect == w/h，与预览一致
    return [((v.x + 1) / 2) * w, ((1 - v.y) / 2) * h];
  });

  const s = h / 512; // 线宽/半径随分辨率等比缩放
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

/* ========================= Depth 导出 ========================= */

const depthMat = new THREE.MeshDepthMaterial(); // BasicDepthPacking：近白远黑

function renderDepthCanvas(w, h) {
  // 1) 隐藏网格 / 坐标轴 / gizmo
  const helpers = [grid, axes, gizmo];
  const prevVisible = helpers.map((o) => o.visible);
  helpers.forEach((o) => (o.visible = false));

  // 2) 背景置纯黑，near/far 收紧到人物包围盒前后各 0.5m
  const prevBg = scene.background;
  scene.background = new THREE.Color(0x000000);
  const prevNear = camera.near;
  const prevFar = camera.far;

  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  const camPos = new THREE.Vector3();
  camera.getWorldPosition(camPos);
  let minD = Infinity;
  let maxD = -Infinity;
  const v = new THREE.Vector3();
  joints.forEach((j) => {
    j.getWorldPosition(v);
    const d = v.sub(camPos).dot(fwd);
    if (d < minD) minD = d;
    if (d > maxD) maxD = d;
  });
  camera.near = Math.max(0.05, minD - 0.5);
  camera.far = Math.max(camera.near + 0.2, maxD + 0.5);
  camera.updateProjectionMatrix();

  // 3) 深度材质覆盖渲染到 w×h renderTarget
  scene.overrideMaterial = depthMat;
  const rt = new THREE.WebGLRenderTarget(w, h);
  renderer.setRenderTarget(rt);
  renderer.render(scene, camera);
  const buf = new Uint8Array(w * h * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
  renderer.setRenderTarget(null);
  rt.dispose();

  // 4) 全部恢复
  scene.overrideMaterial = null;
  scene.background = prevBg;
  camera.near = prevNear;
  camera.far = prevFar;
  camera.updateProjectionMatrix();
  helpers.forEach((o, i) => (o.visible = prevVisible[i]));

  // 5) 像素上下翻转写入 2D canvas
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d");
  const img = ctx.createImageData(w, h);
  const row = w * 4;
  for (let y = 0; y < h; y++) {
    img.data.set(buf.subarray((h - 1 - y) * row, (h - y) * row), y * row);
  }
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255; // 强制不透明
  ctx.putImageData(img, 0, 0);
  return cv;
}

/* ========================= 上传 / 应用 / 取消 ========================= */

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

async function onApply() {
  btnApply.disabled = true;
  btnCancel.disabled = true;
  setStatus("正在导出并上传…");
  try {
    const poseCv = renderOpenPoseCanvas(exportW, exportH);
    const depthCv = renderDepthCanvas(exportW, exportH);
    const t = Date.now();
    const openpose = await uploadCanvas(poseCv, `director_pose_${t}.png`);
    const depth = await uploadCanvas(depthCv, `director_depth_${t}.png`);
    const manifest = { files: { openpose, depth } };
    const sceneGz = encodeSceneGz();
    window.parent.postMessage({ type: "exportDone", payload: { manifest, sceneGz } }, "*");
    setStatus("✅ 已应用到节点");
  } catch (err) {
    console.error("[3D导演台] 导出失败:", err);
    setStatus(`❌ 导出失败：${err.message || err}`);
  } finally {
    btnApply.disabled = false;
    btnCancel.disabled = false;
  }
}

btnApply.addEventListener("click", onApply);
btnCancel.addEventListener("click", () => {
  window.parent.postMessage({ type: "cancel" }, "*");
});

/* ========================= postMessage 协议 ========================= */

window.addEventListener("message", (ev) => {
  const data = ev.data;
  if (!data || data.type !== "init") return;
  const p = data.payload || {};
  const w = parseInt(p.width, 10);
  const h = parseInt(p.height, 10);
  if (w > 0 && h > 0) {
    exportW = w;
    exportH = h;
  }
  applyViewport();
  if (p.sceneGz) {
    try {
      decodeSceneGz(p.sceneGz);
    } catch (err) {
      console.warn("[3D导演台] sceneGz 解析失败，使用默认 T-pose:", err);
    }
  }
  setStatus("");
});

function announceReady() {
  window.parent.postMessage({ type: "ready" }, "*");
}
if (document.readyState === "complete") announceReady();
else window.addEventListener("load", announceReady);

/* ========================= 调试/测试钩子 ========================= */

window.__ds = {
  joints,
  camera,
  renderOpenPoseCanvas,
  renderDepthCanvas,
  encodeSceneGz,
  decodeSceneGz,
  get exportSize() {
    return [exportW, exportH];
  },
};

/* ========================= 主循环 ========================= */

applyViewport();
setStatus("");
renderer.setAnimationLoop(() => {
  orbit.update();
  updateBones();
  renderer.render(scene, camera);
});
