/**
 * main.js — 3D导演台 M1 编排器
 */
import * as THREE from "three";
import { JOINT_CN, JOINT_EN, T_POSE } from "./constants.js";
import { createRenderer, createScene, createCamera, mountRenderer, getCamera, getRenderer, getScene } from "./scene.js";
import { createJoints, createBones, updateBones } from "./figure.js";
import {
  createOrbit, createTransform, selectJoint, getSelected,
  setupPointerEvents, setupKeyboardShortcuts, getOrbit, getTransform,
  isBoneLockEnabled, setBoneLockEnabled,
} from "./controls.js";
import { pushUndo, performUndo, performRedo, getUndoDepth, getRedoDepth, snapshot, restore } from "./undo.js";
import { encodeSceneGz, decodeSceneGz, applyJoints as sApplyJoints } from "./serialization.js";
import * as cameraSettings from "./camera-settings.js";
import { performApply, renderOpenPoseCanvas, renderDepthCanvas } from "./export.js";
import { setupProtocol, announceReady, getExportSize } from "./protocol.js";
import { createPosePanel, loadPoseLibrary, mirrorPose, exportPoseJson } from "./pose-panel.js";
import { applyViewport, setExportSize, getExportWH, setStatus } from "./ui.js";

/* ========================= DOM 引用 ========================= */

const viewportEl = document.getElementById("viewport");
const btnApply = document.getElementById("btnApply");
const btnCancel = document.getElementById("btnCancel");
const statusEl = document.getElementById("status");

/* ========================= 初始化渲染器/场景 ========================= */

const renderer = createRenderer();
const scene = createScene();
const camera = createCamera(cameraSettings.focalToVFovDeg(35), 1);
mountRenderer(viewportEl);

/* ========================= 火柴人 ========================= */

const figureGroup = new THREE.Group();
scene.add(figureGroup);
const joints = createJoints(figureGroup);
const bones = createBones(figureGroup);
updateBones(joints, bones);

/* ========================= 交互 ========================= */

const orbit = createOrbit(camera, renderer.domElement);
const { tctrl } = createTransform(camera, renderer.domElement, scene);
setupPointerEvents(renderer.domElement, joints);
setupKeyboardShortcuts(joints, () => {
  updateBones(joints, bones);
  updateStatus();
});

/* ========================= UI 控件注入 ========================= */

function injectTopbarControls() {
  document.getElementById("title").textContent = "🎬 3D导演台 M1";

  const afterBtn = btnCancel;

  // 焦距滑杆
  const focalGroup = document.createElement("span");
  focalGroup.style.cssText = "display:flex;align-items:center;gap:4px;margin:0 8px;";
  const focalLabel = document.createElement("span");
  focalLabel.textContent = "35mm";
  focalLabel.style.cssText = "font-size:12px;color:#8a90a0;min-width:40px;text-align:right;";
  const focalSlider = document.createElement("input");
  focalSlider.type = "range";
  focalSlider.min = "20";
  focalSlider.max = "135";
  focalSlider.value = "35";
  focalSlider.style.cssText = "width:80px;accent-color:#2f9e63;";
  focalSlider.addEventListener("input", () => {
    cameraSettings.setFocalLength(parseInt(focalSlider.value, 10));
    updateBones(joints, bones);
    cameraSettings.updateOverlay();
  });
  focalGroup.appendChild(document.createTextNode("📷"));
  focalGroup.appendChild(focalLabel);
  focalGroup.appendChild(focalSlider);

  // 三分线
  const thirdsLabel = document.createElement("label");
  thirdsLabel.style.cssText = "display:flex;align-items:center;gap:3px;font-size:12px;color:#8a90a0;cursor:pointer;margin:0 4px;";
  const thirdsCheckbox = document.createElement("input");
  thirdsCheckbox.type = "checkbox";
  thirdsCheckbox.style.cssText = "accent-color:#2f9e63;";
  thirdsCheckbox.addEventListener("change", () => {
    cameraSettings.setThirdsEnabled(thirdsCheckbox.checked);
  });
  thirdsLabel.appendChild(thirdsCheckbox);
  thirdsLabel.appendChild(document.createTextNode("卌"));

  // 骨长锁定
  const lockLabel = document.createElement("label");
  lockLabel.style.cssText = "display:flex;align-items:center;gap:3px;font-size:12px;color:#8a90a0;cursor:pointer;margin:0 4px;";
  const lockCheckbox = document.createElement("input");
  lockCheckbox.type = "checkbox";
  lockCheckbox.checked = true;
  lockCheckbox.style.cssText = "accent-color:#2f9e63;";
  lockCheckbox.addEventListener("change", () => {
    setBoneLockEnabled(lockCheckbox.checked);
  });
  lockLabel.appendChild(lockCheckbox);
  lockLabel.appendChild(document.createTextNode("🔒骨长"));

  // Undo/Redo 按钮
  const undoBtn = document.createElement("button");
  undoBtn.textContent = "↩️";
  undoBtn.title = "撤销 Ctrl+Z";
  undoBtn.style.cssText = "padding:6px 8px;font-size:14px;";
  undoBtn.addEventListener("click", () => {
    if (performUndo(joints)) {
      updateBones(joints, bones);
      cameraSettings.updateOverlay();
      updateStatus();
    }
  });

  const redoBtn = document.createElement("button");
  redoBtn.textContent = "↪️";
  redoBtn.title = "重做 Ctrl+Y";
  redoBtn.style.cssText = "padding:6px 8px;font-size:14px;";
  redoBtn.addEventListener("click", () => {
    if (performRedo(joints)) {
      updateBones(joints, bones);
      cameraSettings.updateOverlay();
      updateStatus();
    }
  });

  afterBtn.insertAdjacentElement("afterend", redoBtn);
  afterBtn.insertAdjacentElement("afterend", undoBtn);
  afterBtn.insertAdjacentElement("afterend", lockLabel);
  afterBtn.insertAdjacentElement("afterend", thirdsLabel);
  afterBtn.insertAdjacentElement("afterend", focalGroup);

  cameraSettings.bindUI(focalSlider, focalLabel, thirdsCheckbox);

  document.getElementById("hint").textContent =
    "左键选关节拖动 / 按住Alt拖=自由模式 / 右键旋转 / 滚轮缩放";
}

injectTopbarControls();

/* ========================= 姿势库面板 ========================= */

const mainArea = document.createElement("div");
mainArea.style.cssText = "display:flex;flex:1;min-height:0;";
viewportEl.remove();
mainArea.appendChild(createPosePanel());
mainArea.appendChild(viewportEl);
document.body.appendChild(mainArea);

loadPoseLibrary((poseArr) => {
  pushUndo(joints);
  restore(joints, poseArr);
  updateBones(joints, bones);
  cameraSettings.updateOverlay();
  updateStatus();
});

document.getElementById("poseMirror").addEventListener("click", () => {
  pushUndo(joints);
  const mirrored = mirrorPose(joints);
  restore(joints, mirrored);
  updateBones(joints, bones);
  cameraSettings.updateOverlay();
  updateStatus();
});

document.getElementById("poseExport").addEventListener("click", () => {
  exportPoseJson(joints);
});

/* ========================= 构图叠加层 ========================= */

cameraSettings.createOverlay(viewportEl);
window.addEventListener("resize", () => {
  applyViewport(viewportEl);
  cameraSettings.updateOverlay();
});
renderer.domElement.addEventListener("pointerup", () => {
  setTimeout(() => cameraSettings.updateOverlay(), 100);
});

/* ========================= postMessage 协议 ========================= */

setupProtocol((w, h, jointsArr) => {
  setExportSize(w, h);
  applyViewport(viewportEl);
  if (jointsArr) {
    sApplyJoints(joints, jointsArr);
  }
  updateBones(joints, bones);
  cameraSettings.updateOverlay();
  updateStatus();
});

if (document.readyState === "complete") announceReady();
else window.addEventListener("load", announceReady);

/* ========================= 应用 / 取消 ========================= */

async function onApply() {
  btnApply.disabled = true;
  btnCancel.disabled = true;
  setStatus("正在导出并上传…", statusEl);
  try {
    const [ew, eh] = getExportWH();
    const sceneGz = encodeSceneGz(joints, cameraSettings.getFocalLength());
    await performApply(joints, ew, eh, sceneGz);
    setStatus("✅ 已应用到节点", statusEl);
  } catch (err) {
    console.error("[3D导演台] 导出失败:", err);
    setStatus(`❌ 导出失败：${err.message || err}`, statusEl);
  } finally {
    btnApply.disabled = false;
    btnCancel.disabled = false;
  }
}

btnApply.addEventListener("click", onApply);
btnCancel.addEventListener("click", () => {
  window.parent.postMessage({ type: "cancel" }, "*");
});

/* ========================= 状态栏 ========================= */

function updateStatus() {
  const sel = getSelected();
  const [ew, eh] = getExportWH();
  const undoN = getUndoDepth();
  let msg = "";
  if (sel) msg = `已选中：${JOINT_CN[sel.userData.index]}`;
  if (undoN > 0) msg += `　⎌${undoN}`;
  setStatus(msg, statusEl);
}

/* ========================= 调试/测试钩子 ========================= */

window.__ds = {
  joints,
  bones,
  camera,
  scene,
  renderer,
  renderOpenPoseCanvas: (w, h) => renderOpenPoseCanvas(joints, w, h),
  renderDepthCanvas: (w, h) => renderDepthCanvas(joints, w, h),
  encodeSceneGz: (fl) => encodeSceneGz(joints, fl || cameraSettings.getFocalLength()),
  decodeSceneGz: (b64) => {
    const result = decodeSceneGz(b64);
    if (result) {
      sApplyJoints(joints, result.joints);
      if (result.focalLength !== undefined) {
        cameraSettings.setFocalLength(result.focalLength);
      }
      updateBones(joints, bones);
      return result;
    }
    return null;
  },
  get exportSize() { return getExportWH(); },
  pushUndo: () => pushUndo(joints),
  performUndo: () => {
    const ok = performUndo(joints);
    updateBones(joints, bones);
    return ok;
  },
  performRedo: () => {
    const ok = performRedo(joints);
    updateBones(joints, bones);
    return ok;
  },
  getUndoDepth,
  getRedoDepth,
  mirrorPose: () => mirrorPose(joints),
  setFocalLength: (mm) => {
    cameraSettings.setFocalLength(mm);
    cameraSettings.updateOverlay();
  },
  getFocalLength: () => cameraSettings.getFocalLength(),
  isBoneLockEnabled,
  setBoneLockEnabled,
  snapshot: () => snapshot(joints),
  restore: (snap) => {
    restore(joints, snap);
    updateBones(joints, bones);
  },
};

/* ========================= 主循环 ========================= */

applyViewport(viewportEl);
updateStatus();
renderer.setAnimationLoop(() => {
  orbit.update();
  updateBones(joints, bones);
  renderer.render(scene, camera);
});
