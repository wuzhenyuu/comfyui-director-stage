/**
 * main.js — 3D导演台 M2 编排器
 * 集成: 多角色 / 多机位 / 道具系统 / GLB导入 / 批量导出
 */
import * as THREE from "three";
import { T_POSE } from "./constants.js";
import { createRenderer, createScene, createCamera, mountRenderer, getCamera, getRenderer, getScene, getCharacterGroups, setWireframeMode } from "./scene.js";
import { createJoints, createBones, updateBones } from "./figure.js";
import { createOrbit, createTransform, selectJoint, getSelected, setupPointerEvents, setupKeyboardShortcuts, getOrbit, getTransform, isBoneLockEnabled, setBoneLockEnabled } from "./controls.js";
import { pushUndo, performUndo, performRedo, getUndoDepth, getRedoDepth, snapshot, restore } from "./undo.js";
import { encodeSceneGz, decodeSceneGz, applyJoints as sApplyJoints } from "./serialization.js";
import * as cameraSettings from "./camera-settings.js";
import { performApply, performBatchExport } from "./export.js";
import { renderOpenPoseCanvas, renderDepthCanvas, renderNormalCanvas } from "./pass-renderer.js";
import { setupProtocol, announceReady, getExportSize, getSceneJSON, setSceneJSON } from "./protocol.js";
import { createPosePanel, loadPoseLibrary, mirrorPose, exportPoseJson } from "./pose-panel.js";
import { applyViewport, setExportSize, getExportWH, setStatus, showToast, showProgress, hideProgress } from "./ui.js";
import { CameraManager, focalMMToVFov } from "./cameras.js";
import { PropManager } from "./props.js";
import { createPropsPanel } from "./props-panel.js";
import { createGLBImport } from "./glb-import.js";

/* ========================= DOM 引用 ========================= */

const viewportEl = document.getElementById("viewport");
const btnApply = document.getElementById("btnApply");
const btnCancel = document.getElementById("btnCancel");
const statusEl = document.getElementById("status");
const charPanel = document.getElementById("char-panel");
const cameraPanel = document.getElementById("camera-panel");
const propsPanelEl = document.getElementById("props-panel");
const sidebarTabs = document.getElementById("sidebar-tabs");

/* ========================= 初始化渲染器/场景 ========================= */

const renderer = createRenderer();
const scene = createScene();
// 初始相机（M1 兼容，后续由 CameraManager 接管）
const defaultCamera = createCamera(cameraSettings.focalToVFovDeg(35), 1);
mountRenderer(viewportEl);

/* ========================= CameraManager ========================= */

const cameraManager = new CameraManager();
cameraManager.initDefaultCamera(1, 35);
// 用 CameraManager 的活动相机替换 scene.js 中的默认引用
cameraManager.cameras[0].camera.position.copy(defaultCamera.position);
cameraManager.cameras[0].camera.quaternion.copy(defaultCamera.quaternion);
defaultCamera.copy(cameraManager.cameras[0].camera);

/* ========================= 火柴人（M1 兼容） ========================= */

const figureGroup = new THREE.Group();
figureGroup.name = "figure_group";
scene.add(figureGroup);
const joints = createJoints(figureGroup);
const bones = createBones(figureGroup);
updateBones(joints, bones);

/* ========================= PropManager ========================= */

const propManager = new PropManager(scene, defaultCamera, renderer.domElement);
propManager.onDragChanged((dragging) => {
  if (orbit) orbit.enabled = !dragging;
});

/* ========================= 交互 ========================= */

let orbit = createOrbit(defaultCamera, renderer.domElement);
const { tctrl } = createTransform(defaultCamera, renderer.domElement, scene);
setupPointerEvents(renderer.domElement, joints);
setupKeyboardShortcuts(joints, () => {
  updateBones(joints, bones);
  updateStatus();
});

// Prop picking: click on props in viewport
renderer.domElement.addEventListener("pointerup", (e) => {
  if (e.button !== 0) return;
  if (tctrl.dragging || tctrl.axis) return;
  if (propManager.isDragging()) return;
  // Skip if moving (drag)
  const ndcMouse = new THREE.Vector2(
    ((e.clientX - renderer.domElement.getBoundingClientRect().left) / renderer.domElement.clientWidth) * 2 - 1,
    -((e.clientY - renderer.domElement.getBoundingClientRect().top) / renderer.domElement.clientHeight) * 2 + 1
  );
  const prop = propManager.pickProp(ndcMouse);
  if (prop) {
    propManager.selectProp(prop.id);
    refreshAllPanels();
    return;
  }
  // If clicking empty space, deselect prop
  if (propManager.getSelected()) {
    propManager.deselectProp();
    refreshAllPanels();
  }
});

/* ========================= 机位面板 ========================= */

function createCameraPanel() {
  const panel = document.createElement("div");
  panel.style.cssText = "display:flex;flex-direction:column;height:100%;";

  // Header
  const header = document.createElement("div");
  header.textContent = "📷 多机位";
  header.style.cssText = "padding:12px 14px;font-weight:600;font-size:13px;border-bottom:1px solid #2a2f3d;";
  panel.appendChild(header);

  // Actions
  const actions = document.createElement("div");
  actions.style.cssText = "padding:6px 10px;display:flex;gap:4px;border-bottom:1px solid #2a2f3d;";

  const addBtn = document.createElement("button");
  addBtn.textContent = "➕ 添加";
  addBtn.title = "添加新机位";
  addBtn.style.cssText = "flex:1;padding:5px 4px;font-size:12px;";
  addBtn.addEventListener("click", () => {
    cameraManager.addCamera();
    refreshCameraList();
  });
  actions.appendChild(addBtn);

  const snapBtn = document.createElement("button");
  snapBtn.textContent = "📌 适配视角";
  snapBtn.title = "将当前视角保存到活动机位";
  snapBtn.style.cssText = "flex:1;padding:5px 4px;font-size:12px;";
  snapBtn.addEventListener("click", () => {
    cameraManager.snapCurrentView(orbit);
    refreshCameraList();
    showToast("视角已保存到当前机位", false);
  });
  actions.appendChild(snapBtn);

  panel.appendChild(actions);

  // Camera list
  const list = document.createElement("div");
  list.id = "cam-list";
  list.style.cssText = "flex:1;overflow-y:auto;padding:4px 0;";
  panel.appendChild(list);

  panel.refreshList = refreshCameraList;
  return panel;

  function refreshCameraList() {
    list.innerHTML = "";
    const activeId = cameraManager.getActiveCamera()?.id;
    cameraManager.cameras.forEach((cam) => {
      const row = document.createElement("div");
      row.style.cssText = [
        "padding:6px 10px;cursor:pointer;font-size:12px;",
        "display:flex;align-items:center;justify-content:space-between;",
        "transition:background 0.15s;",
      ].join("");

      const nameEl = document.createElement("span");
      nameEl.style.cssText = "display:flex;align-items:center;gap:4px;flex:1;";
      nameEl.innerHTML = `📷 ${cam.name} <span style="color:#8a90a0;font-size:10px;">${cam.focalMM}mm</span>`;

      const delBtn = document.createElement("button");
      delBtn.textContent = "✕";
      delBtn.title = "删除机位";
      delBtn.style.cssText = "padding:2px 6px;font-size:10px;background:transparent;border:1px solid #2a2f3d;color:#8a90a0;";
      delBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (cameraManager.removeCamera(cam.id)) {
          syncActiveCamera();
          refreshCameraList();
        }
      });

      row.appendChild(nameEl);
      row.appendChild(delBtn);

      if (cam.id === activeId) {
        row.style.background = "#2f9e6340";
      }

      row.addEventListener("mouseenter", () => {
        if (cam.id !== activeId) row.style.background = "#232836";
      });
      row.addEventListener("mouseleave", () => {
        if (cam.id !== activeId) row.style.background = (cam.id === activeId) ? "#2f9e6340" : "";
      });
      row.addEventListener("click", () => {
        cameraManager.switchCamera(cam.id);
        syncActiveCamera();
        refreshCameraList();
        showToast(`已切换到 ${cam.name}`, false);
      });

      list.appendChild(row);
    });
  }
}

function syncActiveCamera() {
  const ac = cameraManager.getActiveCamera();
  if (!ac) return;
  // Copy active camera state FROM CameraManager TO the viewport camera (which orbit controls follows)
  defaultCamera.position.copy(ac.camera.position);
  defaultCamera.quaternion.copy(ac.camera.quaternion);
  defaultCamera.fov = ac.camera.fov;
  defaultCamera.aspect = ac.camera.aspect;
  defaultCamera.updateProjectionMatrix();

  // Update orbit target
  if (ac.target && ac.target.length >= 3) {
    orbit.target.fromArray(ac.target);
  }
  orbit.update();
}

// Keyboard shortcut for camera switching
window.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key >= "1" && e.key <= "9") {
    e.preventDefault();
    const idx = parseInt(e.key) - 1;
    if (idx < cameraManager.cameras.length) {
      cameraManager.switchCamera(cameraManager.cameras[idx].id);
      syncActiveCamera();
      const camPanel = cameraPanel.querySelector("#cam-list");
      if (camPanel && cameraPanel.refreshList) cameraPanel.refreshList();
    }
  }
});

/* ========================= 侧边栏 Tab 切换 ========================= */

sidebarTabs.addEventListener("click", (e) => {
  const tab = e.target.closest(".sidebar-tab");
  if (!tab) return;
  const panelId = tab.dataset.panel;

  // Update active tab
  sidebarTabs.querySelectorAll(".sidebar-tab").forEach((t) => t.classList.remove("active"));
  tab.classList.add("active");

  // Show panel
  document.querySelectorAll(".sidebar-panel").forEach((p) => p.classList.remove("active"));
  const targetPanel = document.getElementById(panelId);
  if (targetPanel) targetPanel.classList.add("active");
});

/* ========================= 填充面板 ========================= */

// 角色面板 — 姿势库
const posePanel = createPosePanel();
charPanel.appendChild(posePanel);

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

// 机位面板
const camPanelUI = createCameraPanel();
cameraPanel.appendChild(camPanelUI);
camPanelUI.refreshList();

// 道具面板
const propsPanelUI = createPropsPanel(propManager);
propsPanelEl.appendChild(propsPanelUI);

function refreshAllPanels() {
  if (camPanelUI.refreshList) camPanelUI.refreshList();
  if (propsPanelUI.refreshList) propsPanelUI.refreshList();
}

/* ========================= 顶部栏 M2 控件 ========================= */

function injectTopbarControls() {
  document.getElementById("title").textContent = "🎬 3D导演台 M2";

  const afterBtn = document.getElementById("btnCancel");

  // ── 焦距滑杆 ──
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
    const mm = parseInt(focalSlider.value, 10);
    cameraSettings.setFocalLength(mm);
    // Also update active camera's FOV
    const ac = cameraManager.getActiveCamera();
    if (ac) {
      ac.camera.fov = focalMMToVFov(mm);
      ac.camera.updateProjectionMatrix();
      ac.focalMM = mm;
      defaultCamera.fov = ac.camera.fov;
      defaultCamera.updateProjectionMatrix();
    }
    updateBones(joints, bones);
    cameraSettings.updateOverlay();
  });
  focalGroup.appendChild(document.createTextNode("📷"));
  focalGroup.appendChild(focalLabel);
  focalGroup.appendChild(focalSlider);

  // ── 三分线 ──
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

  // ── 骨长锁定 ──
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

  // ── M2 独有：线框模式 ──
  const wireLabel = document.createElement("label");
  wireLabel.style.cssText = "display:flex;align-items:center;gap:3px;font-size:12px;color:#8a90a0;cursor:pointer;margin:0 4px;";
  const wireCheckbox = document.createElement("input");
  wireCheckbox.type = "checkbox";
  wireCheckbox.style.cssText = "accent-color:#2f9e63;";
  wireCheckbox.addEventListener("change", () => {
    setWireframeMode(wireCheckbox.checked);
  });
  wireLabel.appendChild(wireCheckbox);
  wireLabel.appendChild(document.createTextNode("🔲线框"));

  // ── M2 独有：显示网格 ──
  const gridLabel = document.createElement("label");
  gridLabel.style.cssText = "display:flex;align-items:center;gap:3px;font-size:12px;color:#8a90a0;cursor:pointer;margin:0 4px;";
  const gridCheckbox = document.createElement("input");
  gridCheckbox.type = "checkbox";
  gridCheckbox.checked = true;
  gridCheckbox.style.cssText = "accent-color:#2f9e63;";
  gridCheckbox.addEventListener("change", () => {
    const { grid } = getScene().children.reduce((acc, c) => {
      if (c instanceof THREE.GridHelper) acc.grid = c;
      return acc;
    }, {});
    getScene().traverse((child) => {
      if (child instanceof THREE.GridHelper || child instanceof THREE.AxesHelper) {
        child.visible = gridCheckbox.checked;
      }
    });
  });
  gridLabel.appendChild(gridCheckbox);
  gridLabel.appendChild(document.createTextNode("📏网格"));

  // ── M2 独有：隐藏道具 ──
  const hidePropsLabel = document.createElement("label");
  hidePropsLabel.style.cssText = "display:flex;align-items:center;gap:3px;font-size:12px;color:#8a90a0;cursor:pointer;margin:0 4px;";
  const hidePropsCheckbox = document.createElement("input");
  hidePropsCheckbox.type = "checkbox";
  hidePropsCheckbox.style.cssText = "accent-color:#2f9e63;";
  hidePropsCheckbox.addEventListener("change", () => {
    propManager.props.forEach((p) => {
      p.mesh.visible = !hidePropsCheckbox.checked;
    });
  });
  hidePropsLabel.appendChild(hidePropsCheckbox);
  hidePropsLabel.appendChild(document.createTextNode("👁️隐藏道具"));

  // ── Undo/Redo 按钮 ──
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

  // ── GLB 导入按钮 ──
  const { button: importBtn, fileInput } = createGLBImport(propManager, showToast);

  // Insert all after btnCancel
  afterBtn.insertAdjacentElement("afterend", importBtn);
  afterBtn.insertAdjacentElement("afterend", redoBtn);
  afterBtn.insertAdjacentElement("afterend", undoBtn);
  afterBtn.insertAdjacentElement("afterend", hidePropsLabel);
  afterBtn.insertAdjacentElement("afterend", gridLabel);
  afterBtn.insertAdjacentElement("afterend", wireLabel);
  afterBtn.insertAdjacentElement("afterend", lockLabel);
  afterBtn.insertAdjacentElement("afterend", thirdsLabel);
  afterBtn.insertAdjacentElement("afterend", focalGroup);

  // Append hidden file input to body
  document.body.appendChild(fileInput);

  cameraSettings.bindUI(focalSlider, focalLabel, thirdsCheckbox);

  document.getElementById("hint").textContent =
    "左键选关节拖动 / Alt+拖=自由模式 / 右键旋转 / 滚轮缩放 / Ctrl+1~9切机位";
}

injectTopbarControls();

/* ========================= 构图叠加层 ========================= */

cameraSettings.createOverlay(viewportEl);
window.addEventListener("resize", () => {
  applyViewport(viewportEl);
  cameraManager.updateAspect(getExportWH()[0] / getExportWH()[1]);
  cameraSettings.updateOverlay();
});
renderer.domElement.addEventListener("pointerup", () => {
  setTimeout(() => cameraSettings.updateOverlay(), 100);
});

/* ========================= postMessage 协议 ========================= */

setupProtocol((w, h, jointsArr) => {
  setExportSize(w, h);
  applyViewport(viewportEl);
  cameraManager.updateAspect(w / h);
  defaultCamera.aspect = w / h;
  defaultCamera.updateProjectionMatrix();

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

    // M2: batch export across all cameras
    const enabledPasses = new Set(["openpose", "depth", "normal", "lineart"]);
    const characters = getCharacterGroups();

    // Build scene JSON for serialization
    const sceneJSON = buildSceneJSON(sceneGz);
    setSceneJSON(sceneJSON);

    if (cameraManager.cameras.length > 1 || characters.length > 0) {
      // Multi-camera or multi-character: batch export
      showProgress("导出中…");
      const result = await performBatchExport({
        cameraManager,
        propManager,
        joints,
        getSceneGz: () => sceneGz,
        exportW: ew,
        exportH: eh,
        enabledPasses,
        onProgress: (msg) => showProgress(msg),
        characters,
      });
      hideProgress();

      // Post manifest
      window.parent.postMessage(
        { type: "exportDone", payload: { manifest: result.manifest, sceneGz, sceneJSON } },
        "*"
      );
    } else {
      // Single camera, single character: use M1-compatible export
      await performApply(joints, ew, eh, sceneGz);
    }

    setStatus("✅ 已应用到节点", statusEl);
    showToast("✅ 导出完成", false);
  } catch (err) {
    console.error("[3D导演台] 导出失败:", err);
    setStatus(`❌ 导出失败：${err.message || err}`, statusEl);
    showToast(`❌ 导出失败：${err.message || err}`, true);
  } finally {
    hideProgress();
    btnApply.disabled = false;
    btnCancel.disabled = false;
  }
}

function buildSceneJSON(sceneGz) {
  return {
    version: 2,
    cameras: cameraManager.serialize(),
    props: propManager.snapshot(),
    focalLength: cameraSettings.getFocalLength(),
    sceneGz,
  };
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
  if (sel) msg = `已选中关节`;
  if (undoN > 0) msg += `　⎌${undoN}`;
  msg += `　📷${cameraManager.cameras.length} 🧱${propManager.props.length}`;
  setStatus(msg, statusEl);
}

/* ========================= 调试/测试钩子 ========================= */

window.__ds = {
  joints,
  bones,
  camera: defaultCamera,
  figureGroup,
  scene,
  renderer,
  cameraManager,
  propManager,

  // M1 compat
  renderOpenPoseCanvas: (w, h) => renderOpenPoseCanvas(joints, defaultCamera, w, h),
  renderDepthCanvas: (w, h) => {
    const { grid, axes } = getScene().children.reduce((acc, c) => {
      if (c instanceof THREE.GridHelper) acc.grid = c;
      if (c instanceof THREE.AxesHelper) acc.axes = c;
      return acc;
    }, { grid: null, axes: null });
    const pg = grid?.visible, pa = axes?.visible;
    if (grid) grid.visible = false;
    if (axes) axes.visible = false;
    const cv = renderDepthCanvas(scene, defaultCamera, renderer, w, h, []);
    if (grid) grid.visible = pg;
    if (axes) axes.visible = pa;
    return cv;
  },
  renderNormalCanvas: (w, h) => {
    const { grid, axes } = getScene().children.reduce((acc, c) => {
      if (c instanceof THREE.GridHelper) acc.grid = c;
      if (c instanceof THREE.AxesHelper) acc.axes = c;
      return acc;
    }, { grid: null, axes: null });
    const pg = grid?.visible, pa = axes?.visible;
    if (grid) grid.visible = false;
    if (axes) axes.visible = false;
    const cv = renderNormalCanvas(scene, defaultCamera, renderer, w, h, []);
    if (grid) grid.visible = pg;
    if (axes) axes.visible = pa;
    return cv;
  },

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
    const ac = cameraManager.getActiveCamera();
    if (ac) {
      ac.camera.fov = focalMMToVFov(mm);
      ac.camera.updateProjectionMatrix();
      ac.focalMM = mm;
      defaultCamera.fov = ac.camera.fov;
      defaultCamera.updateProjectionMatrix();
    }
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

  // M2 hooks
  addCamera: () => {
    const cam = cameraManager.addCamera();
    camPanelUI.refreshList();
    return cam;
  },
  switchCamera: (id) => {
    cameraManager.switchCamera(id);
    syncActiveCamera();
    camPanelUI.refreshList();
  },
  removeCamera: (id) => cameraManager.removeCamera(id),
  getCameraCount: () => cameraManager.cameras.length,

  addProp: (kind, params) => {
    const { PrimitiveFactory } = requireDynamic("./props.js");
    // Simple fallback
  },
  getPropCount: () => propManager.props.length,
  clearProps: () => { propManager.clear(); propsPanelUI.refreshList(); },

  getSceneJSON: () => buildSceneJSON(encodeSceneGz(joints, cameraSettings.getFocalLength())),

  // Batch export
  performBatchExport: (enabledPasses) => performBatchExport({
    cameraManager,
    propManager,
    joints,
    getSceneGz: () => encodeSceneGz(joints, cameraSettings.getFocalLength()),
    exportW: getExportWH()[0],
    exportH: getExportWH()[1],
    enabledPasses: new Set(enabledPasses || ["openpose", "depth", "normal", "lineart"]),
    onProgress: () => {},
    characters: getCharacterGroups(),
  }),

  wireframeMode: (enabled) => setWireframeMode(enabled),
};

function requireDynamic() {
  // stub - props.js already imported
}

/* ========================= 主循环 ========================= */

applyViewport(viewportEl);
updateStatus();
renderer.setAnimationLoop(() => {
  orbit.update();
  // Sync orbit-modified camera back to active camera entry
  const ac = cameraManager.getActiveCamera();
  if (ac) {
    ac.camera.position.copy(defaultCamera.position);
    ac.camera.quaternion.copy(defaultCamera.quaternion);
    ac.camera.fov = defaultCamera.fov;
    ac.pos = ac.camera.position.toArray();
    ac.target = orbit.target.toArray();
  }
  updateBones(joints, bones);
  renderer.render(scene, defaultCamera);
});
