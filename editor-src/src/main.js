/**
 * main.js — 3D导演台 M2 编排器
 * 集成: 多角色 / 多机位 / 道具系统 / GLB导入 / 批量导出
 */
import * as THREE from "three";
import { T_POSE } from "./constants.js";
import { createRenderer, createScene, createCamera, mountRenderer, getCamera, getRenderer, getScene, getCharacterGroups, setWireframeMode, drawFrame, renderViewportWebGL } from "./scene.js";
import * as renderMode from "./render-mode.js";
import { createExternalBodyMover, translateExternalCharacter } from "./external-character-move.js";
import { createOrbit, createTransform, selectJoint, getSelected, setupPointerEvents, setupKeyboardShortcuts, getOrbit, getTransform, isBoneLockEnabled, setBoneLockEnabled, setExternalBodyMover } from "./controls.js";
import { pushUndo, performUndo, performRedo, getUndoDepth, getRedoDepth, snapshot, restore } from "./undo.js";
import { encodeSceneGz, decodeSceneGz, applyJoints as sApplyJoints } from "./serialization.js";
import * as cameraSettings from "./camera-settings.js";
import { performApply, performBatchExport, extractExternalJoints } from "./export.js";
import { renderOpenPoseCanvas, renderDepthCanvas, renderNormalCanvas } from "./pass-renderer.js";
import { setupProtocol, announceReady, setSceneJSON } from "./protocol.js";
import { applyViewport, setExportSize, getExportWH, setStatus, showToast, showProgress, hideProgress } from "./ui.js";
import { CameraManager, focalMMToVFov, renderCameraListEntry } from "./cameras.js";
import { PropManager, PrimitiveFactory } from "./props.js";
import { createPropsPanel } from "./props-panel.js";
import { createGLBImport } from "./glb-import.js";
import { createModelLibraryPanel } from "./model-library.js";
import { getGLBJointPositions } from "./char-loader.js";
import { getVRMJointPositions, createVRMImport } from "./vrm-loader.js";
import { ExternalCharacterManager, MAX_EXTERNAL_CHARACTERS } from "./external-characters.js";
import { ActionRuntime } from "./action-runtime.js";
import { SkeletonHelperManager, drawSkeleton2D } from "./skeleton-helper.js";
import { createCharPropsPanel } from "./char-props-panel.js";
import { createExternalCharPanel } from "./external-char-panel.js";
import { createSceneSettingsPanel, setSceneSettings } from "./scene-settings-panel.js";
import { exportProject, importProject, collectSceneData } from "./project-io.js";
import "./clipboard.js";  // 注册 copyToClipboard/pasteFromClipboard 和键盘快捷键
import { mountCameraGlobals } from "./cameras.js";
import { mountControlsGlobals } from "./controls.js";
import { mountThumbnailCapture } from "./thumbnail-capture.js";
import { createBoneEditor } from "./bone-editor.js";
import { serialize as serializePosePresets, restore as restorePosePresets } from "./pose-presets.js";
import * as panorama from "./panorama.js";
import * as openposeImport from "./openpose-import.js";

// ── P8：骨骼视图模式（TE_MAN 式黑底彩色 OpenPose 骨骼人偶）全局开关与钩子 ──
// scene.js drawFrame 每帧读 window.__ds_skeletonMode；UI 复选框与 __ds 契约共用此 setter。
window.__ds_skeletonMode = false;
window.__ds_setSkeletonMode = (on) => {
  window.__ds_skeletonMode = on === true;
  window.dispatchEvent(new CustomEvent("ds-skeleton-mode-changed", {
    detail: { enabled: window.__ds_skeletonMode },
  }));
};
// scene.js 不 import export.js（会循环依赖），经钩子取外部角色 18 关节世界坐标
window.__ds_getExternalJoints18 = (entry) => extractExternalJoints(entry);

/* ========================= DOM 引用 ========================= */

const viewportEl = document.getElementById("viewport");
// 诊断标记：在所有代码之前插入，验证 JS 是否执行
viewportEl.innerHTML = '<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#ff4444;font-size:24px;font-weight:bold;z-index:99;pointer-events:none;">● JS已执行 - 等待3D初始化...</div>';
console.log("[3D导演台] main.js 开始执行, THREE 可用:", typeof THREE !== "undefined");
const btnApply = document.getElementById("btnApply");
const btnCancel = document.getElementById("btnCancel");
const statusEl = document.getElementById("status");
const charPanel = document.getElementById("char-panel");
const cameraPanel = document.getElementById("camera-panel");
const propsPanelEl = document.getElementById("props-panel");
const modelLibraryPanel = document.getElementById("model-library-panel");
const sidebarTabs = document.getElementById("sidebar-tabs");
const charPropsPanelEl = document.getElementById("char-props-panel");
const sceneSettingsPanelEl = document.getElementById("scene-settings-panel");

/* ========================= 初始化渲染器/场景 ========================= */

// 2D Canvas 视口（零 WebGL 依赖）；WebGLRenderer 懒加载仅供导出用
const viewportCanvas = createRenderer();
console.log("[3D导演台] 2D canvas 已创建:", viewportCanvas.width, "x", viewportCanvas.height);
const scene = createScene();
console.log("[3D导演台] scene 已创建, children:", scene.children.length);
// 创建后清除诊断标记
viewportEl.querySelector('div')?.remove();
// 初始相机（M1 兼容，后续由 CameraManager 接管）
const defaultCamera = createCamera(cameraSettings.focalToVFovDeg(35), 1);
mountRenderer(viewportEl);

/* ========================= CameraManager ========================= */

const cameraManager = new CameraManager();
cameraManager.initDefaultCamera(1, 35);
// 让 0 号相机与 defaultCamera 是【同一对象】：orbit/显示/拾取三者强一致
cameraManager.cameras[0].camera = defaultCamera;
cameraManager.cameras[0].pos = defaultCamera.position.toArray();

/* ========================= 渲染模式（P1-A/B：auto/webgl/canvas2d） ========================= */
// 必须在 mountRenderer 之后调用（2D canvas 已挂载）；
// WebGL 可用则进入 webgl 模式，失败自动回退 canvas2d；?force2d=1 强制 2D。
renderMode.initRenderMode({
  viewportEl,
  getCamera: () => cameraManager.getActiveCamera()?.camera || defaultCamera,
});
renderMode.onModeChange(() => {
  if (typeof refreshModeBtnUI === "function") refreshModeBtnUI();
});

/** 顶栏渲染模式指示器刷新函数（injectTopbarControls 内赋值） */
let refreshModeBtnUI = null;
/** 顶栏 3D角色按钮刷新函数（injectTopbarControls 内赋值） */
let refreshExtBtnUI = null;
// 外部角色增删/激活变化时刷新按钮状态
window.addEventListener("ds-external-char-changed", () => refreshExtBtnUI?.());

/* ========================= 火柴人（P3-1：3D-only，底层保留但永久隐藏/不可交互/不导出） ========================= */

const figureGroup = new THREE.Group();
figureGroup.name = "figure_group";
figureGroup.visible = false; // P3-1 3D-only：火柴人永不显示（renderLoop 每帧防御性压制）
scene.add(figureGroup);
// P2-fix：figure.js 空壳已删除——joints/bones 恒为空数组（原 createJoints/createBones 返回 []）
const joints = [];
const bones = [];

/* ========================= PropManager ========================= */

const propManager = new PropManager(scene, defaultCamera, viewportCanvas);

/* ========================= 外部角色（GLB/VRM）管理器 ========================= */
// P1.5：多 3D角色。ExternalCharacterManager 统一管理所有 GLB/VRM 外部角色，
// 每个角色独立 IK target/pole 组、自动错位出生（上限 8）。
// 兼容：window.__ds.glbData/vrmData 由 _dsRef getter 动态指向活动 GLB/VRM entry。
// characterMode 必须放在模块作用域：renderLoop 的 IK 求解与 VRM 回调都要访问，
// 放在 injectTopbarControls 局部会导致 3D角色加载后下一帧 ReferenceError，骨骼完全不动。
const externalManager = new ExternalCharacterManager(scene);
// P3-1 3D-only：默认即外部 3D角色模式，不再提供火柴人用户路径（setCharacterMode 拒绝 "stick"）
let characterMode = "glb"; // glb | vrm（均为“外部角色模式”，仅标记来源类型；stick 已禁用）

// P3-0：动作运行时（每 external entry 独立 action state，驱动 ikTargets + 骨盆）
const actionRuntime = new ActionRuntime(externalManager);
// P3-0：骨骼显示管理器（WebGL=THREE.SkeletonHelper；2D=drawSkeleton2D 投影）
const skeletonHelpers = new SkeletonHelperManager(scene, externalManager);
// Canvas2D 骨骼投影钩子（scene.js drawFrame 调用；仅 2D 绘制模式生效）
window.__ds_drawBones2D = (camRef, w, h, ctx2d, paint) => {
  if (!paint || !skeletonHelpers.enabled) return;
  drawSkeleton2D(externalManager, camRef, w, h, ctx2d);
  // P3-2：骨骼编辑标记辅助线（WebGL 已有 markerGroup，2D 需要 draw2D）
  if (boneEditor && typeof boneEditor.draw2D === "function") {
    boneEditor.draw2D(camRef, w, h, ctx2d);
  }
};

/* ========================= 交互（全部绑定到可见的 2D canvas） ========================= */

let orbit = createOrbit(defaultCamera, viewportCanvas);
const { tctrl } = createTransform(defaultCamera, viewportCanvas, scene);
// 2D 编辑器不使用 3D gizmo 拖拽（由 controls.js 的 2D 屏幕平面拖拽接管），禁用防止干扰
tctrl.enabled = false;
// M2: tctrl 会在下方 _dsRef 中通过 window.__ds 暴露给 figure.js

// 注册拖拽回调（必须在 orbit 创建之后）
propManager.onDragChanged((dragging) => {
  orbit.enabled = !dragging;
});

// P3-1：3D角色整体移动器（点身体拖整人，Alt=升降；IK 球摆姿势不受影响）
const bodyMover = createExternalBodyMover({
  scene,
  manager: externalManager,
  getCamera: () => cameraManager.getActiveCamera()?.camera || defaultCamera,
});
setExternalBodyMover(bodyMover);

// P3-2：骨骼编辑模式（直接操作骨骼节点 + 3D Gizmo）
const boneEditor = createBoneEditor({
  scene,
  manager: externalManager,
  actionRuntime,
  skeletonHelpers,
  getCamera: () => cameraManager.getActiveCamera()?.camera || defaultCamera,
  dom: viewportCanvas,
  getOrbit: () => orbit,
  solveEntry: (entry) => {
    if (entry.type === "vrm") solveVRM_IK(entry);
    else solveGLB_IK(entry);
  },
});

setupPointerEvents(viewportCanvas, joints);
setupKeyboardShortcuts(joints, () => {
  updateStatus();
});

// Prop picking: click on props in viewport
viewportCanvas.addEventListener("pointerup", (e) => {
  if (e.button !== 0) return;
  if (tctrl.dragging || tctrl.axis) return;
  if (propManager.isDragging()) return;
  // Skip if moving (drag)
  const ndcMouse = new THREE.Vector2(
    ((e.clientX - viewportCanvas.getBoundingClientRect().left) / viewportCanvas.clientWidth) * 2 - 1,
    -((e.clientY - viewportCanvas.getBoundingClientRect().top) / viewportCanvas.clientHeight) * 2 + 1
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
      const isActive = cam.id === activeId;
      const html = renderCameraListEntry(cam, isActive);
      const tmp = document.createElement("div");
      tmp.innerHTML = html;
      const row = tmp.firstElementChild;
      if (!row) return;

      // 点击切换机位
      row.addEventListener("click", () => {
        cameraManager.switchCamera(cam.id);
        syncActiveCamera();
        refreshCameraList();
        showToast(`已切换到 ${cam.name}`, false);
        // 切换后生成缩略图
        setTimeout(() => {
          if (window.__ds?.captureActiveThumbnail) window.__ds.captureActiveThumbnail();
        }, 200);
      });

      // 悬停效果
      row.addEventListener("mouseenter", () => {
        if (!isActive) row.style.background = "#232836";
      });
      row.addEventListener("mouseleave", () => {
        if (!isActive) row.style.background = "";
      });

      // 删除按钮（匹配 renderCameraListEntry 的 data-remove-cam 属性）
      const delBtn = row.querySelector("[data-remove-cam]");
      if (delBtn) {
        delBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          if (cameraManager.removeCamera(cam.id)) {
            syncActiveCamera();
            refreshCameraList();
          }
        });
      }

      list.appendChild(row);
    });
  }
}

function syncActiveCamera() {
  const ac = cameraManager.getActiveCamera();
  if (!ac) return;
  // 关键修复：将 orbit controls 直接关联到活动相机的 THREE.Camera 对象，
  // 避免 defaultCamera ↔ CameraManager 双向同步反馈环
  orbit.object = ac.camera;
  orbit.target.copy(new THREE.Vector3().fromArray(ac.target));
  orbit.update();
  // defaultCamera 渲染时用活动相机；PropManager 的拾取/TransformControls 也要跟随
  defaultCamera.copy(ac.camera);
  propManager.camera = ac.camera;
  if (propManager.tctrl) propManager.tctrl.camera = ac.camera;
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

// P3-1 3D-only：火柴人角色列表面板（createCharPanel）已移除。
// 角色面板现在只包含外部 3D角色列表 + 动作栏。

// P1.5b：外部 3D角色面板（P3-1 起为角色面板唯一内容）
// 行点击激活；👁/✏️/🗑️ 由面板内部直调 manager API；头部 ➕ 按钮添加新角色
const extCharUI = createExternalCharPanel(charPanel, externalManager, { actionRuntime });
window.__dsExternalCharPanel = extCharUI; // 调试/测试钩子

// P3-1 3D-only：火柴人姿势库面板（createPosePanel/loadPoseLibrary/poseMirror/poseExport）已移除。
// 3D角色姿势通过 IK 球拖拽 + 动作预设（external-char-panel 动作栏）实现。

// 机位面板
const camPanelUI = createCameraPanel();
cameraPanel.appendChild(camPanelUI);
camPanelUI.refreshList();

// 道具面板
const propsPanelUI = createPropsPanel(propManager);
propsPanelEl.appendChild(propsPanelUI);

// 模型库面板
const modelLibPanelUI = createModelLibraryPanel(propManager, showToast);
modelLibraryPanel.appendChild(modelLibPanelUI);

// 角色属性面板
const charPropsUI = createCharPropsPanel();
charPropsPanelEl.appendChild(charPropsUI.panel);

// 场景设置面板
const sceneSettingsUI = createSceneSettingsPanel();
sceneSettingsPanelEl.appendChild(sceneSettingsUI.panel);

function refreshAllPanels() {
  if (camPanelUI.refreshList) camPanelUI.refreshList();
  if (propsPanelUI.refreshList) propsPanelUI.refreshList();
  if (charPropsUI.refresh) charPropsUI.refresh();
  if (sceneSettingsUI.refresh) sceneSettingsUI.refresh();
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

  // ── P3-1 3D-only：骨长锁定 / FK-IK 切换 / 整人移动（火柴人专属控件）已移除 ──

  // ── P7：添加3D角色（弹出模型选择下拉菜单，从 index.json 加载模型列表）──
  const addExtBtn = document.createElement("button");
  addExtBtn.id = "btnAddExternal";
  addExtBtn.dataset.addExternalChar = "1";
  addExtBtn.textContent = "➕添加3D角色";
  addExtBtn.title = `选择 3D角色模型（最多 ${MAX_EXTERNAL_CHARACTERS} 个）`;
  addExtBtn.style.cssText = "padding:6px 10px;font-size:12px;cursor:pointer;position:relative;";

  // ── P3-0：骨骼显示开关（默认开；与 3D角色面板内的开关共享状态）──
  const skeletonLabel = document.createElement("label");
  skeletonLabel.style.cssText = "display:flex;align-items:center;gap:3px;font-size:12px;color:#8a90a0;cursor:pointer;margin:0 4px;";
  const skeletonCheckbox = document.createElement("input");
  skeletonCheckbox.type = "checkbox";
  skeletonCheckbox.id = "skeletonCheckbox";
  skeletonCheckbox.checked = true;
  skeletonCheckbox.style.cssText = "accent-color:#2f9e63;";
  skeletonCheckbox.addEventListener("change", () => {
    skeletonHelpers.setEnabled(skeletonCheckbox.checked);
    showToast(skeletonCheckbox.checked ? "🦴骨骼显示已开启" : "🦴骨骼显示已关闭", false);
  });
  skeletonLabel.appendChild(skeletonCheckbox);
  skeletonLabel.appendChild(document.createTextNode("🦴骨骼"));
  window.addEventListener("ds-skeleton-changed", (e) => {
    skeletonCheckbox.checked = e.detail?.enabled !== false;
  });

  // ── P8：骨骼视图模式开关（TE_MAN 式：黑底彩色 OpenPose 骨骼人偶替换 3D 角色网格；
  //    视觉隐藏 ≠ 数据删除，角色/场景状态保留，切回即恢复）──
  const skeletonModeLabel = document.createElement("label");
  skeletonModeLabel.style.cssText = "display:flex;align-items:center;gap:3px;font-size:12px;color:#8a90a0;cursor:pointer;margin:0 4px;";
  skeletonModeLabel.title = "骨骼模式：隐藏 3D 角色网格，以黑底彩色 OpenPose 骨骼人偶查看/编辑（IK 球仍可拖拽）";
  const skeletonModeCheckbox = document.createElement("input");
  skeletonModeCheckbox.type = "checkbox";
  skeletonModeCheckbox.id = "skeletonModeCheckbox";
  skeletonModeCheckbox.checked = window.__ds_skeletonMode === true;
  skeletonModeCheckbox.style.cssText = "accent-color:#2f9e63;";
  skeletonModeCheckbox.addEventListener("change", () => {
    window.__ds_setSkeletonMode(skeletonModeCheckbox.checked);
    showToast(skeletonModeCheckbox.checked
      ? "🦴骨骼模式已开启（3D角色已隐藏，黑底骨骼视图）"
      : "🦴骨骼模式已关闭（恢复3D角色）", false);
  });
  skeletonModeLabel.appendChild(skeletonModeCheckbox);
  skeletonModeLabel.appendChild(document.createTextNode("🦴骨骼模式"));
  window.addEventListener("ds-skeleton-mode-changed", (e) => {
    skeletonModeCheckbox.checked = e.detail?.enabled === true;
  });

  // 使用模块级 externalManager / characterMode 状态（renderLoop 与 VRM 回调共享）

  function updateExtButtonsUI() {
    addExtBtn.style.opacity = externalManager.size >= MAX_EXTERNAL_CHARACTERS ? "0.5" : "";
  }
  refreshExtBtnUI = updateExtButtonsUI;

  // P3-1 3D-only：只允许 glb/vrm；stick 请求直接忽略（不再允许切回火柴人）
  function setCharacterMode(mode) {
    if (mode === "stick") return characterMode;
    if (!["glb", "vrm"].includes(mode)) return characterMode;
    characterMode = mode;

    // 火柴人永久隐藏（防御：restore/setActive 等路径可能重新点亮，renderLoop 每帧再压制一次）
    figureGroup.visible = false;
    const manager = window.DS_FigureAPI?.getManager?.();
    if (manager?.ikTargetsGroup) manager.ikTargetsGroup.visible = false;

    // 显示全部可见外部角色（manager 内部叠加单角色 visible 标记）
    externalManager.setModeVisible(true);
    externalManager.markAllIKDirty();

    // 外部角色强制 IK 路径（isGLBMode/isVRMMode/characterMode 由 _dsRef getter 读取模块变量）
    if (window.__ds) {
      window.__ds.fkMode = true;
    }

    updateExtButtonsUI();
    updateStatus();
    return characterMode;
  }

  // VRM 加载回调在 injectTopbarControls 外层注册，通过全局桥接调用模式切换
  window.__dsSetCharacterMode = setCharacterMode;


  /** P7：弹出模型选择下拉菜单，从 /director_stage/models/index.json 加载列表 */
  async function showModelPicker() {
    return new Promise((resolve) => {
      const menu = document.createElement("div");
      menu.id = "model-picker-menu";
      menu.style.cssText = "position:fixed;z-index:20000;min-width:260px;max-height:400px;overflow-y:auto;background:#1a1d26;border:1px solid #2f9e63;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,0.6);padding:4px 0;font-size:12px;";

      const loading = document.createElement("div");
      loading.textContent = "加载模型列表…";
      loading.style.cssText = "padding:12px 16px;color:#8a90a0;";
      menu.appendChild(loading);
      document.body.appendChild(menu);

      // 定位到按钮下方
      const rect = addExtBtn.getBoundingClientRect();
      menu.style.left = rect.left + "px";
      menu.style.top = (rect.bottom + 4) + "px";

      const close = () => { menu.remove(); document.removeEventListener("click", onOutside, true); resolve(null); };
      const onOutside = (e) => { if (!menu.contains(e.target) && e.target !== addExtBtn) close(); };
      setTimeout(() => document.addEventListener("click", onOutside, true), 50);

      // 异步加载模型列表
      fetch("/director_stage/models/index.json")
        .then(r => r.json())
        .then(data => {
          menu.innerHTML = "";
          const head = document.createElement("div");
          head.textContent = "选择3D角色模型";
          head.style.cssText = "padding:8px 14px;font-weight:600;color:#c8cddb;border-bottom:1px solid #2a2f3d;";
          menu.appendChild(head);

          const chars = (data.models || []).filter(m => m.type === "character");
          if (chars.length === 0) {
            const empty = document.createElement("div");
            empty.textContent = "暂无可用角色模型";
            empty.style.cssText = "padding:12px 14px;color:#6a7080;";
            menu.appendChild(empty);
            return;
          }

          chars.forEach((m, i) => {
            const row = document.createElement("div");
            row.style.cssText = "padding:10px 14px;cursor:pointer;display:flex;align-items:center;gap:10px;transition:background 0.1s;color:#d0d6e0;";
            row.addEventListener("mouseenter", () => row.style.background = "#2a3040");
            row.addEventListener("mouseleave", () => row.style.background = "");

            const icon = document.createElement("span");
            icon.textContent = m.type === "vrm" ? "🎭" : "🧊";
            icon.style.cssText = "font-size:18px;";
            row.appendChild(icon);

            const info = document.createElement("div");
            info.style.cssText = "flex:1;";
            const nameEl = document.createElement("div");
            nameEl.textContent = m.name;
            nameEl.style.cssText = "font-weight:500;";
            const descEl = document.createElement("div");
            descEl.textContent = `${m.bones || "?"}骨骼${m.hasFingers ? "·手指" : ""} | ${m.description || ""}`.substring(0, 60);
            descEl.style.cssText = "font-size:10px;color:#6a7080;margin-top:2px;";
            info.appendChild(nameEl);
            info.appendChild(descEl);
            row.appendChild(info);

            if (i === 0) {
              const defBadge = document.createElement("span");
              defBadge.textContent = "默认";
              defBadge.style.cssText = "font-size:9px;background:#2f9e6350;color:#2f9e63;padding:1px 6px;border-radius:8px;";
              row.appendChild(defBadge);
            }

            row.addEventListener("click", (e) => {
              e.stopPropagation();
              menu.remove();
              document.removeEventListener("click", onOutside, true);
              resolve({
                url: `/director_stage/models/${m.file}`,
                name: m.name,
                type: m.type === "vrm" ? "vrm" : "glb",
                fileName: m.file,
              });
            });
            menu.appendChild(row);
          });
        })
        .catch(() => {
          // 失败兜底：显示内置模型
          menu.innerHTML = "";
          const head2 = document.createElement("div");
          head2.textContent = "选择3D角色（离线模式）";
          head2.style.cssText = "padding:8px 14px;font-weight:600;color:#c8cddb;border-bottom:1px solid #2a2f3d;";
          menu.appendChild(head2);
          const builtin = [
            { name: "Michelle (女)", url: "/director_stage/models/michelle.glb", type: "glb", fileName: "michelle.glb" },
            { name: "Mixamo (男)", url: "/director_stage/models/mixamo-rigged-character.glb", type: "glb", fileName: "mixamo-rigged-character.glb" },
            { name: "UE人体模型", url: "/director_stage/models/ue-mannequin-retopology.glb", type: "glb", fileName: "ue-mannequin-retopology.glb" },
            { name: "Alicia VRM", url: "/director_stage/models/AliciaSolid.vrm", type: "vrm", fileName: "AliciaSolid.vrm" },
          ];
          builtin.forEach(m => {
            const row = document.createElement("div");
            row.textContent = (m.type === "vrm" ? "🎭 " : "🧊 ") + m.name;
            row.style.cssText = "padding:10px 14px;cursor:pointer;color:#d0d6e0;";
            row.addEventListener("mouseenter", () => row.style.background = "#2a3040");
            row.addEventListener("mouseleave", () => row.style.background = "");
            row.addEventListener("click", (e) => { e.stopPropagation(); close(); resolve(m); });
            menu.appendChild(row);
          });
        });
    });
  }

  // setCharacterMode 代理（loadMoreGLB 在 injectTopbarControls 闭包中调用，需要引到外层函数）
  function setCharacterModeProxy(mode) { setCharacterMode(mode); }
  /** P7：加载 GLB/VRM 3D角色（支持模型选择）
   *  @param {object} modelInfo — { url, name, type: "glb"|"vrm", fileName }
   *  @param {object} [opts] — { silent }
   *  未传 modelInfo 时从 index.json 弹出选择器 */
  async function loadMoreGLB(modelInfo, opts = {}) {
    // 无参数 → 弹出模型选择器
    if (!modelInfo || !modelInfo.url) {
      const info = await showModelPicker();
      if (!info) return null;
      modelInfo = info;
    }
    const url = modelInfo.url;
    const modelName = modelInfo.name || null;
    const silent = !!opts.silent;
    if (externalManager.size >= MAX_EXTERNAL_CHARACTERS) {
      if (!silent) showToast(`最多 ${MAX_EXTERNAL_CHARACTERS} 个 3D角色`, true);
      return null;
    }
    addExtBtn.disabled = true;
    const prevBtnText = addExtBtn.textContent;
    addExtBtn.textContent = "⏳加载中…";
    try {
      // 根据模型类型调用不同的加载方法
      let entry;
      if (modelInfo.type === "vrm") {
        entry = await externalManager.addVRM(url, modelName, modelInfo.fileName);
        if (entry) setCharacterModeProxy("vrm");
      } else {
        entry = await externalManager.addGLB(url, modelName, { fileName: modelInfo.fileName });
        if (entry) setCharacterModeProxy("glb");
      }
      if (!entry) throw new Error("角色创建失败");
      externalManager.setActive(entry.id);
      if (!silent) {
        showToast(externalManager.size === 1
          ? `${entry.name} 已加载！点身体拖整人（Alt=升降），拖青/黄 IK 球摆姿势`
          : `已添加「${entry.name}」（${externalManager.size}/${MAX_EXTERNAL_CHARACTERS}）`, false);
      } else {
        console.log(`[3D导演台] 默认 3D角色已自动加载（${entry.name}）`);
      }
      return entry;
    } catch (e) {
      console.error("GLB加载失败:", e);
      if (!silent) showToast("3D角色加载失败：" + (e.message || e), true);
      updateExtButtonsUI();
      return null;
    } finally {
      addExtBtn.disabled = false;
      addExtBtn.textContent = prevBtnText;
      updateExtButtonsUI();
    }
  }

  // P7：点击弹出模型选择器；面板内 ➕ 按钮也走同一入口
  addExtBtn.addEventListener("click", () => loadMoreGLB());
  window.__dsAddExternalCharacter = () => loadMoreGLB();

  // ── P3-0：默认 3D角色工作流 —— 启动后自动加载默认 UE GLB（静默/低打扰）──
  // 若 init/工程导入带 externalCharacters 快照，则由恢复路径负责，跳过自动加载。
  setTimeout(() => {
    if (externalManager.size > 0 || externalManager._restorePending) return;
    if (window.__ds_externalRestored) return;
    loadMoreGLB({ url: "/director_stage/models/michelle.glb", name: "Michelle", type: "glb", fileName: "michelle.glb" }, { silent: true })
      .catch((e) => console.warn("[3D导演台] 默认 3D角色自动加载失败:", e?.message || e));
  }, 800);

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
    // P2-fix：删除未使用的 reduce 块（计算结果从未使用，真正工作的是下面的 traverse）
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

  // ── P4：全景图 ──
  // 全景模式开关
  const panoLabel = document.createElement("label");
  panoLabel.style.cssText = "display:flex;align-items:center;gap:3px;font-size:12px;color:#8a90a0;cursor:pointer;margin:0 4px;";
  const panoCheckbox = document.createElement("input");
  panoCheckbox.type = "checkbox";
  panoCheckbox.style.cssText = "accent-color:#e8962f;";
  panoCheckbox.addEventListener("change", () => {
    panorama.setEnabled(panoCheckbox.checked);
    showToast(panoCheckbox.checked ? "🌐全景模式已开启（相机锁定原点，仅旋转）" : "🎬自由视角已恢复", false);
  });
  panoLabel.appendChild(panoCheckbox);
  panoLabel.appendChild(document.createTextNode("🌐全景"));

  // 全景图上传按钮
  const panoUploadBtn = document.createElement("button");
  panoUploadBtn.textContent = "🖼️全景图";
  panoUploadBtn.title = "上传等距柱状全景图（建议 2:1 比例）";
  panoUploadBtn.style.cssText = "padding:6px 10px;font-size:12px;";
  const panoFileInput = document.createElement("input");
  panoFileInput.type = "file";
  panoFileInput.accept = "image/png,image/jpeg,image/webp";
  panoFileInput.style.display = "none";
  panoFileInput.addEventListener("change", async () => {
    const file = panoFileInput.files[0];
    if (!file) return;
    panoUploadBtn.disabled = true;
    panoUploadBtn.textContent = "⏳加载…";
    try {
      const url = URL.createObjectURL(file);
      try {
        await panorama.load(url, scene);
      } finally {
        URL.revokeObjectURL(url); // P2-fix：objectURL 用后释放
      }
      panorama.setEnabled(true);
      panoCheckbox.checked = true;
      showToast("🌐全景图已加载", false);
    } catch (e) {
      showToast("全景图加载失败：" + (e.message || e), true);
    } finally {
      panoUploadBtn.disabled = false;
      panoUploadBtn.textContent = "🖼️全景图";
    }
  });
  panoUploadBtn.addEventListener("click", () => panoFileInput.click());
  document.body.appendChild(panoFileInput);

  // 全景旋转滑杆
  const panoRotGroup = document.createElement("span");
  panoRotGroup.id = "pano-rot-group";
  panoRotGroup.style.cssText = "display:none;align-items:center;gap:4px;margin:0 4px;";
  const panoRotSlider = document.createElement("input");
  panoRotSlider.type = "range";
  panoRotSlider.min = "-180";
  panoRotSlider.max = "180";
  panoRotSlider.value = "0";
  panoRotSlider.style.cssText = "width:60px;accent-color:#e8962f;";
  panoRotSlider.addEventListener("input", () => {
    panorama.setRotation(parseInt(panoRotSlider.value) * Math.PI / 180);
  });
  panoRotGroup.appendChild(document.createTextNode("↻"));
  panoRotGroup.appendChild(panoRotSlider);

  // 全景距离滑杆
  const panoDistGroup = document.createElement("span");
  panoDistGroup.id = "pano-dist-group";
  panoDistGroup.style.cssText = "display:none;align-items:center;gap:4px;margin:0 4px;";
  const panoDistLabel = document.createElement("span");
  panoDistLabel.textContent = "5m";
  panoDistLabel.style.cssText = "font-size:11px;color:#c8a65c;min-width:24px;";
  const panoDistSlider = document.createElement("input");
  panoDistSlider.type = "range";
  panoDistSlider.min = "1.5";
  panoDistSlider.max = "10";
  panoDistSlider.step = "0.1";
  panoDistSlider.value = "5";
  panoDistSlider.style.cssText = "width:60px;accent-color:#e8962f;";
  panoDistSlider.addEventListener("input", () => {
    const v = parseFloat(panoDistSlider.value);
    panorama.setDistance(v);
    panoDistLabel.textContent = v.toFixed(1) + "m";
  });
  panoDistGroup.appendChild(document.createTextNode("📏"));
  panoDistGroup.appendChild(panoDistLabel);
  panoDistGroup.appendChild(panoDistSlider);

  // 状态变更时同步 UI
  panorama.setStateChangeCallback((s) => {
    panoCheckbox.checked = s.enabled;
    panoRotGroup.style.display = s.enabled && s.path ? "flex" : "none";
    panoDistGroup.style.display = s.enabled && s.path ? "flex" : "none";
  });

  // ── P4：OpenPose 骨骼图导入 ──
  const poseImportBtn = document.createElement("button");
  poseImportBtn.textContent = "🦴导入骨骼图";
  poseImportBtn.title = "从 OpenPose 骨骼图导入姿势（自动识别 BODY_18 关节点并映射到 3D 角色）";
  poseImportBtn.style.cssText = "padding:6px 10px;font-size:12px;";
  const poseFileInput = document.createElement("input");
  poseFileInput.type = "file";
  poseFileInput.accept = "image/png,image/jpeg,image/webp";
  poseFileInput.style.display = "none";
  poseFileInput.addEventListener("change", async () => {
    const file = poseFileInput.files[0];
    if (!file) return;
    poseImportBtn.disabled = true;
    poseImportBtn.textContent = "⏳解析中…";
    try {
      const img = new Image();
      const objUrl = URL.createObjectURL(file);
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = objUrl;
      });
      URL.revokeObjectURL(objUrl); // P2-fix：objectURL 用后释放
      const result = await openposeImport.importPose(
        file, externalManager, img.width, img.height,
        { facingAngle: 0, rootY: 0 }
      );
      const detected = result.joints.filter(Boolean).length;
      showToast(`🦴已导入姿势（${detected}/18 关节检测成功）`, false);
    } catch (e) {
      console.error("[OpenPose导入]", e);
      showToast("骨骼图导入失败：" + (e.message || e), true);
    } finally {
      poseImportBtn.disabled = false;
      poseImportBtn.textContent = "🦴导入骨骼图";
    }
  });
  poseImportBtn.addEventListener("click", () => poseFileInput.click());
  document.body.appendChild(poseFileInput);

  // ── Undo/Redo 按钮 ──
  const undoBtn = document.createElement("button");
  undoBtn.textContent = "↩️";
  undoBtn.title = "撤销 Ctrl+Z";
  undoBtn.style.cssText = "padding:6px 8px;font-size:14px;";
  undoBtn.addEventListener("click", () => {
    if (performUndo(joints)) {
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
      cameraSettings.updateOverlay();
      updateStatus();
    }
  });

  // ── GLB 导入按钮 ──
  const { button: importBtn, fileInput } = createGLBImport(propManager, showToast);

  // ── VRM 导入按钮 ──
  const { button: vrmImportBtn, fileInput: vrmFileInput } = createVRMImport(showToast);

  // ── M2 新增：POV 切换 ──
  const povBtn = document.createElement("button");
  povBtn.id = "btnPov";
  povBtn.textContent = "🎬导演视角";
  povBtn.title = "切换导演/相机视角";
  povBtn.style.cssText = "padding:6px 10px;font-size:12px;";
  povBtn.addEventListener("click", () => {
    try {
      if (window.__ds?.togglePovMode) {
        window.__ds.togglePovMode();
      }
    } catch (e) { console.warn("togglePovMode 不可用:", e); }
    // 更新按钮文本
    setTimeout(() => _updatePovButton(povBtn), 100);
  });

  // ── M2 新增：导出工程 ──
  const exportProjBtn = document.createElement("button");
  exportProjBtn.id = "btnExportProj";
  exportProjBtn.textContent = "💾导出工程";
  exportProjBtn.title = "导出工程 JSON 文件";
  exportProjBtn.style.cssText = "padding:6px 10px;font-size:12px;";
  exportProjBtn.addEventListener("click", () => {
    window.__ds?.exportProject?.();
  });

  // ── M2 新增：导入工程 ──
  const importProjBtn = document.createElement("button");
  importProjBtn.id = "btnImportProj";
  importProjBtn.textContent = "📂导入工程";
  importProjBtn.title = "导入工程 JSON 文件（会清空当前场景）";
  importProjBtn.style.cssText = "padding:6px 10px;font-size:12px;";
  importProjBtn.addEventListener("click", () => {
    window.__ds?.importProject?.();
  });

  // ── M2 新增：复制 ──
  const copyBtn = document.createElement("button");
  copyBtn.id = "btnCopy";
  copyBtn.textContent = "📋复制";
  copyBtn.title = "复制选中对象 Ctrl+C";
  copyBtn.style.cssText = "padding:6px 10px;font-size:12px;";
  copyBtn.addEventListener("click", () => {
    window.__ds?.copyToClipboard?.();
  });

  // ── M2 新增：粘贴 ──
  const pasteBtn = document.createElement("button");
  pasteBtn.id = "btnPaste";
  pasteBtn.textContent = "📌粘贴";
  pasteBtn.title = "粘贴 Ctrl+V";
  pasteBtn.style.cssText = "padding:6px 10px;font-size:12px;";
  pasteBtn.addEventListener("click", () => {
    window.__ds?.pasteFromClipboard?.();
  });

  // ── P1-A：渲染模式指示/切换（auto → webgl → canvas2d 循环）──
  const modeBtn = document.createElement("button");
  modeBtn.id = "btnRenderMode";
  modeBtn.style.cssText = "padding:6px 10px;font-size:12px;";
  refreshModeBtnUI = () => {
    const eff = renderMode.getRenderMode();
    const pref = renderMode.getRenderModePreference();
    modeBtn.textContent = eff === "webgl" ? "🖥️WebGL" : "🟦Canvas2D";
    modeBtn.title = `渲染模式：${pref}（当前 ${eff}）— 点击切换 auto/webgl/canvas2d；URL 加 ?force2d=1 可强制 2D`;
  };
  refreshModeBtnUI();
  modeBtn.addEventListener("click", () => {
    const order = ["auto", "webgl", "canvas2d"];
    const cur = renderMode.getRenderModePreference();
    const next = order[(order.indexOf(cur) + 1) % order.length];
    const eff = renderMode.setRenderMode(next);
    refreshModeBtnUI();
    showToast(`渲染模式：${next}（当前 ${eff === "webgl" ? "WebGL" : "Canvas 2D"}）`, false);
  });

  // Insert all after btnCancel
  afterBtn.insertAdjacentElement("afterend", poseImportBtn);
  afterBtn.insertAdjacentElement("afterend", panoDistGroup);
  afterBtn.insertAdjacentElement("afterend", panoRotGroup);
  afterBtn.insertAdjacentElement("afterend", panoUploadBtn);
  afterBtn.insertAdjacentElement("afterend", panoLabel);
  afterBtn.insertAdjacentElement("afterend", modeBtn);
  afterBtn.insertAdjacentElement("afterend", pasteBtn);
  afterBtn.insertAdjacentElement("afterend", copyBtn);
  afterBtn.insertAdjacentElement("afterend", importProjBtn);
  afterBtn.insertAdjacentElement("afterend", exportProjBtn);
  afterBtn.insertAdjacentElement("afterend", povBtn);
  afterBtn.insertAdjacentElement("afterend", importBtn);
  afterBtn.insertAdjacentElement("afterend", vrmImportBtn);
  afterBtn.insertAdjacentElement("afterend", redoBtn);
  afterBtn.insertAdjacentElement("afterend", undoBtn);
  afterBtn.insertAdjacentElement("afterend", hidePropsLabel);
  afterBtn.insertAdjacentElement("afterend", gridLabel);
  afterBtn.insertAdjacentElement("afterend", wireLabel);
  afterBtn.insertAdjacentElement("afterend", addExtBtn);
  afterBtn.insertAdjacentElement("afterend", skeletonLabel);
  afterBtn.insertAdjacentElement("afterend", skeletonModeLabel);
  afterBtn.insertAdjacentElement("afterend", thirdsLabel);
  afterBtn.insertAdjacentElement("afterend", focalGroup);

  // Append hidden file inputs to body
  document.body.appendChild(fileInput);
  document.body.appendChild(vrmFileInput);

  cameraSettings.bindUI(focalSlider, focalLabel, thirdsCheckbox);

  document.getElementById("hint").textContent =
    "拖 IK 球摆姿势 | 点身体拖整人（Alt=升降） | 空白拖动转视角 | 1~9 切换角色 | Ctrl+1~9 切机位";

  if (!window.DS_FigureAPI) {
    document.getElementById("hint").textContent =
      "拖 IK 球摆姿势 / 点身体拖整人（Alt=升降） / 空白处拖动转视角 / 右键平移 / 滚轮缩放";
  }
}

/**
 * 更新 POV 按钮文本
 */
function _updatePovButton(btn) {
  try {
    const cam = window.__ds?.cameraManager;
    if (cam && cam.viewMode === "camera") {
      btn.textContent = "📷机位视角";
    } else {
      btn.textContent = "🎬导演视角";
    }
  } catch (e) {
    btn.textContent = "🎬导演视角";
  }
}

injectTopbarControls();

// P3-2：骨骼编辑 UI（IK/骨骼模式切换 + Gizmo 模式 + 高级平移，挂载到顶栏右侧）
boneEditor.mountUI();

/* ========================= 构图叠加层 ========================= */

cameraSettings.createOverlay(viewportEl);
window.addEventListener("resize", () => {
  applyViewport(viewportEl);
  cameraManager.updateAspect(getExportWH()[0] / getExportWH()[1]);
  cameraSettings.updateOverlay();
});
viewportCanvas.addEventListener("pointerup", () => {
  setTimeout(() => cameraSettings.updateOverlay(), 100);
});

// 监听字符变更事件（来自 ds_opt_a 或 clipboard）
window.addEventListener("ds-char-changed", () => {
  refreshAllPanels();
});

// 监听工程加载事件（来自 project-io）
window.addEventListener("ds-project-loaded", () => {
  refreshAllPanels();
});

/* ========================= postMessage 协议 ========================= */

function restoreCharactersFromSnapshot(characters, activeCharId) {
  const api = window.DS_FigureAPI;
  const manager = api?.getManager?.();
  if (!api || !manager || !Array.isArray(characters) || characters.length === 0) return false;

  // 清空当前默认场景，再按快照逐个重建
  for (const id of Array.from(manager.characters.keys())) {
    manager.remove(id);
  }

  for (const charData of characters) {
    const char = manager.create(charData.id, charData.name, charData.color);
    if (!char) continue;
    char.visible = charData.visible !== false;
    if (charData.position && char.skeletonGroup) {
      char.skeletonGroup.position.fromArray(charData.position);
    }

    if (Array.isArray(charData.joints) && charData.joints.length >= 18) {
      manager.setActive(char.id);
      api.applyPoseToActive(charData.joints);
    }

    if (charData.ikTargets && char.ikState) {
      for (const [chainName, ikPos] of Object.entries(charData.ikTargets)) {
        const state = char.ikState[chainName];
        if (!state) continue;
        if (Array.isArray(ikPos.target)) state.target.position.fromArray(ikPos.target);
        if (Array.isArray(ikPos.pole)) state.pole.position.fromArray(ikPos.pole);
      }
    }
  }

  const fallbackActive = manager.characters.keys().next().value;
  manager.setActive(manager.characters.has(activeCharId) ? activeCharId : fallbackActive);
  manager._footPinInitialized = false;
  manager._updateVisibility?.();
  return manager.characters.size > 0;
}

function applySceneSnapshot(sceneData) {
  if (!sceneData || typeof sceneData !== "object") return false;
  let restored = false;

  if (Array.isArray(sceneData.cameras) && sceneData.cameras.length > 0) {
    const [ew, eh] = getExportWH();
    cameraManager.deserialize(sceneData.cameras, ew / eh);
    restored = true;
  }

  if (Array.isArray(sceneData.props)) {
    propManager.restore(sceneData.props, true);
    restored = true;
  }

  const savedSceneSettings = sceneData.sceneSettings || sceneData.scene;
  if (savedSceneSettings) {
    setSceneSettings(savedSceneSettings);
    restored = true;
  }

  if (sceneData.focalLength !== undefined) {
    cameraSettings.setFocalLength(sceneData.focalLength);
    restored = true;
  }

  if (restored) {
    syncActiveCamera();
    refreshAllPanels();
    cameraSettings.updateOverlay();
  }
  return restored;
}

setupProtocol((w, h, jointsArr, sceneData, decodedScene) => {
  setExportSize(w, h);
  applyViewport(viewportEl);
  cameraManager.updateAspect(w / h);
  defaultCamera.aspect = w / h;
  defaultCamera.updateProjectionMatrix();

  let charsRestored = false;
  if (sceneData?.characters?.length) {
    charsRestored = restoreCharactersFromSnapshot(sceneData.characters, sceneData.activeCharId);
  }
  // P2-fix：decodedScene.v>=2 火柴人恢复分支（applyDecodedToManager）已删除

  if (!charsRestored && jointsArr) {
    const curJointMeshes = _dsRef.joints;
    sApplyJoints(curJointMeshes, jointsArr);
  }

  applySceneSnapshot(sceneData);

  // P1.5：恢复外部 3D角色（GLB/VRM，异步加载模型，不阻塞 init；旧 sceneJSON 无该字段则跳过）
  if (Array.isArray(sceneData?.externalCharacters) && sceneData.externalCharacters.length > 0) {
    window.__ds_externalRestored = true; // P3-0：阻止默认角色自动加载竞争
    externalManager.restore({
      characters: sceneData.externalCharacters,
      activeCharacterId: sceneData.activeExternalCharacterId || null,
    }).then((ok) => {
      if (ok) {
        window.__dsSetCharacterMode?.(externalManager.getActive()?.type || "glb");
        refreshAllPanels();
        console.log(`[3D导演台] 已恢复 ${externalManager.size} 个外部 3D角色`);
      }
    }).catch((e) => console.warn("[3D导演台] 外部角色恢复失败:", e));
  }

  // P3-2：恢复姿态预设（在 characters 恢复之后）
  if (Array.isArray(sceneData?.posePresets) && sceneData.posePresets.length > 0) {
    restorePosePresets(sceneData.posePresets);
    console.log(`[3D导演台] 已恢复 ${sceneData.posePresets.length} 个姿态预设`);
  }

  // 全景图恢复
  if (sceneData?.panorama) {
    panorama.restore(sceneData.panorama, scene);
  }

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
  skeletonHelpers.beginExport(); // P3-0：骨骼线不混入 depth/normal/preview/mask 通道
  try {
    const [ew, eh] = getExportWH();
    const sceneGz = encodeCurrentSceneGz();

    // M2: batch export across all cameras
    const enabledPasses = new Set(["openpose", "depth", "normal", "lineart", "preview"]);
    const characters = getCharacterGroups();

    // Build scene JSON for serialization
    const sceneJSON = buildSceneJSON(sceneGz);
    setSceneJSON(sceneJSON);

    if (cameraManager.cameras.length > 1 || characters.length > 0) {
      // Multi-camera or multi-character: batch export
      showProgress("导出中…");
      // P3-2：导出前隐藏骨骼标记/Gizmo
      boneEditor.beginExport();
      const result = await performBatchExport({
        cameraManager,
        propManager,
        get joints() { return getEffectiveJoints(); },
        getSceneGz: () => sceneGz,
        exportW: ew,
        exportH: eh,
        enabledPasses,
        onProgress: (msg) => showProgress(msg),
        characters,
      });
      hideProgress();
      // P3-2：导出后恢复骨骼标记/Gizmo
      boneEditor.endExport();

      // Post manifest（安全：使用协议层解析的父窗口 origin）
      const origin = window.__ds?._protocolOrigin || location.origin;
      window.parent.postMessage(
        { type: "exportDone", payload: { manifest: result.manifest, sceneGz, sceneJSON } },
        origin
      );
    } else {
      // Single camera, single character: use M1-compatible export
      await performApply(getEffectiveJoints(), ew, eh, sceneGz, { sceneJSON });
    }

    setStatus("✅ 已应用到节点", statusEl);
    showToast("✅ 导出完成", false);
  } catch (err) {
    console.error("[3D导演台] 导出失败:", err);
    setStatus(`❌ 导出失败：${err.message || err}`, statusEl);
    showToast(`❌ 导出失败：${err.message || err}`, true);
  } finally {
    hideProgress();
    skeletonHelpers.endExport();
    btnApply.disabled = false;
    btnCancel.disabled = false;
  }
}

/**
 * 3D-only 兜底：DS_FigureAPI 不存在时，从 externalManager 收集所有外部角色的
 * COCO-18 关节世界坐标，包装成 M1 兼容的 { position, userData.index } 对象数组。
 * （export.js 中 extractExternalJoints 的内联简化版，放这里避免循环依赖。）
 * @returns {THREE.Mesh[]} 每个外部角色 18 个关节；无外部角色时返回空数组
 */
function collectExternalM1Joints() {
  const out = [];
  try {
    const entries = externalManager?.getAll?.() || [];
    for (const entry of entries) {
      if (!entry || !entry.jointMap) continue;
      // 确保骨骼世界矩阵最新（IK/拖拽后导出时 matrixWorld 可能滞后）
      try { entry.model?.updateMatrixWorld?.(true); } catch { /* 用现有矩阵 */ }
      for (let i = 0; i < 18; i++) {
        const bone = entry.jointMap.get?.(i);
        const v = new THREE.Vector3();
        if (bone) {
          try { bone.getWorldPosition(v); } catch { v.set(0, 0, 0); }
        }
        const m = new THREE.Mesh();
        m.position.copy(v);
        m.userData = { index: i };
        out.push(m);
      }
    }
  } catch (err) {
    console.warn("[3D导演台] 收集外部角色关节失败:", err);
  }
  return out;
}

/**
 * 渲染/导出统一取关节：FigureAPI 活动角色 > 外部角色 > M1 火柴人兜底。
 * 确保 3D-only（DS_FigureAPI 不存在）下渲染类通道不会走空数组路径。
 */
function getEffectiveJoints() {
  const apiJoints = window.DS_FigureAPI?.getActiveCharacter?.()?.jointSpheres;
  if (apiJoints && apiJoints.length) return apiJoints;
  const ext = collectExternalM1Joints();
  if (ext.length) return ext;
  return joints; // M1 火柴人兜底（契约 4）
}

function encodeCurrentSceneGz(focalOverride) {
  const manager = window.DS_FigureAPI?.getManager?.();
  const focal = focalOverride ?? cameraSettings.getFocalLength();
  if (manager) return encodeSceneGz(manager, focal);
  // 3D-only：DS_FigureAPI 不存在时，用外部角色的 COCO-18 关节做 M1 兼容编码；
  // externalManager 也没有角色时，退回原 M1 路径（空关节数组兜底编码）
  const extJoints = collectExternalM1Joints();
  return extJoints.length ? encodeSceneGz(extJoints, focal) : encodeSceneGz(_dsRef.joints, focal);
}

function buildSceneJSON(sceneGz) {
  let data = {};
  try {
    data = collectSceneData() || {};
  } catch (err) {
    console.warn("[3D导演台] sceneJSON 收集失败，使用最小快照:", err);
  }

  // 隐藏 widget 不适合存缩略图 dataUrl；重新打开后缩略图会按需重新生成
  const cameras = Array.isArray(data.cameras)
    ? data.cameras.map(({ dataUrl, ...cam }) => cam)
    : cameraManager.serialize().map(({ dataUrl, ...cam }) => cam);

  return {
    ...data,
    version: 2,
    cameras,
    props: Array.isArray(data.props) ? data.props : propManager.snapshot(),
    posePresets: serializePosePresets(),
    panorama: panorama.serialize(),
    focalLength: cameraSettings.getFocalLength(),
    sceneGz,
  };
}

btnApply.addEventListener("click", onApply);
btnCancel.addEventListener("click", () => {
  // 安全：使用协议层解析的父窗口 origin，回退同源
  const origin = window.__ds?._protocolOrigin || location.origin;
  window.parent.postMessage({ type: "cancel" }, origin);
});

/* ========================= 状态栏 ========================= */

function updateStatus() {
  const sel = getSelected();
  // P2-fix：删除未使用的 [ew, eh] 解构（1123/1219 处的同名解构是有用的，不在此处）
  const undoN = getUndoDepth();
  let msg = "";
  if (sel) msg = `已选中关节`;
  if (undoN > 0) msg += `　⎌${undoN}`;
  msg += `　📷${cameraManager.cameras.length} 🧱${propManager.props.length}`;
  setStatus(msg, statusEl);
}

/* ========================= 调试/测试钩子 ========================= */

// M2 修复：__ds 应动态获取活动角色数据，而非缓存初始引用
const _dsRef = {
  get joints() {
    // 契约 4：跟随活动角色；无 FigureAPI / 无活动角色时回退 M1 火柴人（闭包 joints = m1Joints）
    return window.DS_FigureAPI?.getActiveCharacter()?.jointSpheres || joints;
  },
  get bones() {
    const api = window.DS_FigureAPI;
    const ch = api ? api.getActiveCharacter() : null;
    return ch ? ch.boneMeshes : [];
  },
  get figureGroup() { return figureGroup; },
  get scene() { return scene; },
  get renderer() { return getRenderer(); },  // 懒加载 WebGL，无 WebGL 环境返回 null
  get camera() { return cameraManager.getActiveCamera()?.camera || defaultCamera; },  // 拾取/投影统一用活动相机
  get cameraManager() { return cameraManager; },
  get propManager() { return propManager; },
  __tctrl: tctrl,      // 模块作用域的 tctrl 引用

  // P1-A/B 渲染模式契约
  get renderMode() { return renderMode.getRenderMode(); },               // 当前实际模式："webgl" | "canvas2d"
  get renderModePreference() { return renderMode.getRenderModePreference(); }, // 请求模式：auto/webgl/canvas2d
  setRenderMode: (mode) => renderMode.setRenderMode(mode),               // 返回实际生效模式
  setCharacterMode: (mode) => window.__dsSetCharacterMode?.(mode),       // stick | glb | vrm

  // P1.5 外部角色契约：glbData/vrmData 动态指向活动 GLB/VRM entry；
  // isGLBMode/isVRMMode/characterMode 读取模块级 characterMode（getter 只读，禁止外部赋值）
  get externalCharacters() { return externalManager; },
  // P3-0：动作/骨骼契约
  get actionRuntime() { return actionRuntime; },
  get skeletonHelpers() { return skeletonHelpers; },
  get skeletonVisible() { return skeletonHelpers.enabled; },
  setSkeletonVisible: (v) => skeletonHelpers.setEnabled(v),
  // P3-2：骨骼编辑契约
  get boneEditor() { return boneEditor; },
  // P3-1：3D角色整体移动契约
  get externalBodyMover() { return bodyMover; },
  moveExternalCharacter: (id, dx, dy, dz) => {
    const entry = id ? externalManager.get(id) : externalManager.getActive();
    return translateExternalCharacter(entry, +dx || 0, +dy || 0, +dz || 0);
  },
  playAction: (entryId, actionId, opts) => actionRuntime.play(entryId, actionId, opts),
  pauseAction: (entryId) => actionRuntime.pause(entryId),
  resumeAction: (entryId) => actionRuntime.resume(entryId),
  toggleAction: (entryId, actionId) => actionRuntime.toggle(entryId, actionId),
  getActionState: (entryId) => {
    const s = actionRuntime.getState(entryId);
    return s ? { ...s } : null;
  },
  stopAllActions: () => actionRuntime.stopAll(),
  get glbData() { return externalManager.getActiveOfType("glb"); },
  get vrmData() { return externalManager.getActiveOfType("vrm"); },
  get isGLBMode() { return characterMode === "glb"; },
  get isVRMMode() { return characterMode === "vrm"; },
  get characterMode() { return characterMode; },
  // 活动外部角色的 COCO-18 关节世界坐标（兼容旧 _glbJointRef 测试钩子）
  _glbJointRef: () => {
    const entry = externalManager.getActiveOfType("glb") || externalManager.getActive();
    if (!entry || !entry.jointMap) return [];
    const getJoints = entry.type === "vrm" ? getVRMJointPositions : getGLBJointPositions;
    return getJoints(entry.jointMap).map((p, idx) => {
      const m = new THREE.Mesh();
      m.position.set(p[0], p[1], p[2]);
      m.userData = { index: idx };
      return m;
    });
  },

  // M1 compat
  renderOpenPoseCanvas: (w, h) => renderOpenPoseCanvas(getEffectiveJoints(), defaultCamera, w, h),
  renderDepthCanvas: (w, h) => {
    const { grid, axes } = getScene().children.reduce((acc, c) => {
      if (c instanceof THREE.GridHelper) acc.grid = c;
      if (c instanceof THREE.AxesHelper) acc.axes = c;
      return acc;
    }, { grid: null, axes: null });
    const pg = grid?.visible, pa = axes?.visible;
    if (grid) grid.visible = false;
    if (axes) axes.visible = false;
    const cv = renderDepthCanvas(scene, defaultCamera, getRenderer(), w, h, []);
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
    const cv = renderNormalCanvas(scene, defaultCamera, getRenderer(), w, h, []);
    if (grid) grid.visible = pg;
    if (axes) axes.visible = pa;
    return cv;
  },

  encodeSceneGz: (fl) => encodeCurrentSceneGz(fl),
  decodeSceneGz: (b64) => {
    const result = decodeSceneGz(b64);
    if (result) {
      if (result.joints) {
        const curJoints = _dsRef.joints;
        sApplyJoints(curJoints, result.joints);
      }
      if (result.focalLength !== undefined) {
        cameraSettings.setFocalLength(result.focalLength);
      }
      return result;
    }
    return null;
  },
  get exportSize() { return getExportWH(); },
  pushUndo: () => pushUndo(_dsRef.joints),
  performUndo: () => {
    const j = _dsRef.joints;
    return performUndo(j);
  },
  performRedo: () => {
    const j = _dsRef.joints;
    return performRedo(j);
  },
  getUndoDepth,
  getRedoDepth,
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
  snapshot: () => snapshot(_dsRef.joints),
  restore: (snap) => {
    restore(_dsRef.joints, snap);
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

  // P1-fix：实现为 PrimitiveFactory + propManager.addProp 的真实代理
  // （原调用不存在的 requireDynamic，任何 __ds.addProp 调用必抛 ReferenceError）
  addProp: (kind, params = {}) => {
    const color = params.color ?? 0x8899aa;
    const creators = {
      box: () => PrimitiveFactory.createBox(params.w ?? 0.5, params.h ?? 0.5, params.d ?? 0.5, color),
      sphere: () => PrimitiveFactory.createSphere(params.r ?? 0.3, color),
      cylinder: () => PrimitiveFactory.createCylinder(params.rTop ?? 0.2, params.rBot ?? 0.2, params.h ?? 0.8, color),
      plane: () => PrimitiveFactory.createPlane(params.w ?? 1, params.h ?? 1, color),
      torus: () => PrimitiveFactory.createTorus(params.r ?? 0.3, params.tube ?? 0.1, color),
      cone: () => PrimitiveFactory.createCone(params.r ?? 0.3, params.h ?? 0.8, color),
      pyramid: () => PrimitiveFactory.createPyramid(params.s ?? 0.4, params.h ?? 0.8, color),
    };
    const create = creators[kind];
    if (!create) {
      console.warn("[__ds.addProp] 未知道具类型:", kind);
      return null;
    }
    const mesh = create();
    const entry = propManager.addProp(params.name || kind, kind, mesh, { ...params, color: mesh.material.color.getHex() });
    propsPanelUI?.refreshList?.();
    return entry;
  },
  getPropCount: () => propManager.props.length,
  clearProps: () => { propManager.clear(); propsPanelUI.refreshList(); },

  getSceneJSON: () => buildSceneJSON(encodeCurrentSceneGz()),

  // Batch export（P3-0：包装隐藏骨骼线，避免混入 3D 通道）
  performBatchExport: async (enabledPasses) => {
    skeletonHelpers.beginExport();
    try {
      return await performBatchExport({
        cameraManager,
        propManager,
        get joints() { return getEffectiveJoints(); },
        getSceneGz: () => encodeCurrentSceneGz(),
        exportW: getExportWH()[0],
        exportH: getExportWH()[1],
        enabledPasses: new Set(enabledPasses || ["openpose", "depth", "normal", "lineart", "preview"]),
        onProgress: () => {},
        characters: getCharacterGroups(),
      });
    } finally {
      skeletonHelpers.endExport();
    }
  },

  wireframeMode: (enabled) => setWireframeMode(enabled),

  // P8：骨骼视图模式（TE_MAN 式黑底彩色 OpenPose 骨骼人偶）
  get skeletonMode() { return window.__ds_skeletonMode === true; },
  setSkeletonMode: (on) => window.__ds_setSkeletonMode(on),

  // P4：全景图 & OpenPose 导入
  get panorama() { return panorama; },
  get openposeImport() { return openposeImport; },
  togglePanorama: () => panorama.toggle(),
  importOpenPose: async (file) => {
    const img = new Image();
    const objUrl = URL.createObjectURL(file);
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = objUrl; });
    URL.revokeObjectURL(objUrl); // P2-fix：objectURL 用后释放
    return openposeImport.importPose(file, externalManager, img.width, img.height);
  },
};

// P3-2：保存其他模块（如 pose-presets.js）在 main.js 之前注入的 __ds 属性
const _prevDsModules = Object.assign({}, window.__ds || {});

window.__ds = _dsRef;

// 恢复被覆盖的模块注入属性（posePresets 等）
if (_prevDsModules && _prevDsModules !== _dsRef) {
  for (const key of Object.keys(_prevDsModules)) {
    if (!(key in _dsRef) || _dsRef[key] === undefined) {
      try { window.__ds[key] = _prevDsModules[key]; } catch (_) { /* readonly */ }
    }
  }
}

// === 挂载 ds_opt_a 提供的全局功能 ===
mountCameraGlobals(orbit);     // window.__ds.togglePovMode
mountControlsGlobals();        // window.__ds.setObjectLocked / isObjectLocked
mountThumbnailCapture();       // window.__ds.captureActiveThumbnail

// VRM/GLB 回调注册（必须在 window.__ds 就绪后，不可提前）
window.__ds._onVRMLoad = async (url, fileName) => {
  try {
    showToast(`正在加载 VRM: ${fileName}…`, false);
    const entry = await externalManager.addVRM(url, undefined, fileName);
    if (!entry) throw new Error(`外部角色已达上限（${MAX_EXTERNAL_CHARACTERS}）`);
    externalManager.setActive(entry.id);
    window.__dsSetCharacterMode?.("vrm");
    showToast(`VRM 已加载：${fileName}（拖手脚 IK 球摆姿势）`, false);
  } catch (e) {
    console.error("VRM加载失败:", e);
    showToast("VRM加载失败：" + (e.message || e), true);
  }
};

/* ========================= 主循环 ========================= */

applyViewport(viewportEl);
updateStatus();

// GLB IK 求解函数（驱动 UE mannequin 骨骼）
const _detWorld = new THREE.Matrix4();
const _detLocal = new THREE.Matrix4();

// P1-fix：脚钉地跟踪根骨——优先 rigRoot（hips/pelvis），退化到 joint 1（Neck）
const _rigRootBone = (jm) => jm?.get?.("rigRoot") || jm?.get?.(1) || null;

function solveGLB_IK(data) {
  const { jointMap, ikTargets, allBones } = data;
  if (!jointMap || !ikTargets) return;

  // 检查是否有程序化动作正在播放（非 clip）——播放中跳过脚钉地，
  // 否则骨盆动画（walk/jump/idle呼吸）会被脚钉地反向抵消，
  // 导致走路腿不动、跳跃不腾空等"动作不对"的现象。
  const actionState = actionRuntime?.states?.get(data.id);
  const playingAction = actionState?.playing && !actionState?.isClip;

  // 脚钉地（仅非动作播放时生效，保持 IK 拖拽时的站姿稳定）
  if (!playingAction) {
    if (!data._rootPrev) {
      const rootBone = _rigRootBone(jointMap);
      if (rootBone) {
        data._rootPrev = new THREE.Vector3();
        rootBone.getWorldPosition(data._rootPrev);
      }
    } else {
      const rootBone = _rigRootBone(jointMap);
      if (rootBone) {
        const nowPos = new THREE.Vector3();
        rootBone.getWorldPosition(nowPos);
        const delta = nowPos.clone().sub(data._rootPrev);
        if (delta.length() > 0.001) {
          for (const leg of ["rightLeg", "leftLeg"]) {
            if (ikTargets[leg]) {
              ikTargets[leg].target.position.sub(delta);
              ikTargets[leg].pole.position.sub(delta);
            }
          }
        }
        data._rootPrev.copy(nowPos);
      }
    }
  } else {
    // 动作播放中：清除脚钉地缓存，动作停止后重新从当前姿势初始化
    data._rootPrev = null;
  }

  // IK 求解四链
  const chains = {
    rightArm: { root: 2, mid: 3, end: 4 },
    leftArm:  { root: 5, mid: 6, end: 7 },
    rightLeg: { root: 8, mid: 9, end: 10 },
    leftLeg:  { root: 11, mid: 12, end: 13 },
  };

  for (const [name, chain] of Object.entries(chains)) {
    const target = ikTargets[name];
    if (!target) continue;
    const chainBones = [chain.root, chain.mid, chain.end].map(i => jointMap.get(i)).filter(Boolean);
    if (chainBones.length < 3) continue;

    // P2-fix：原无条件求解两遍（无 snap 一遍 + 带 snap 一遍）。
    // 仅当存在 detachedEnds 时才走带 snap 的单次求解，否则一次普通求解。
    const det = data.detachedEnds?.[name];
    if (det) {
      // 扁平骨架修补：末端骨不在链条内（如 Rigify 的 Foot 挂根骨）时，
      // CCD 转不动它——按绑定偏移矩阵手动贴回中段骨
      const snap = () => snapDetachedEnd(det);
      snap();
      solveGLB_CCD(chainBones, target.target.position, target.pole.position, 10, 0.001, snap);
      snap();
    } else {
      solveGLB_CCD(chainBones, target.target.position, target.pole.position);
    }
  }

  // 刷新骨骼世界矩阵
  allBones.forEach(b => b.updateMatrixWorld());
}

// 扁平骨架修补：把脱离链条的末端骨按绑定偏移贴回中段骨（每次骨骼旋转后调用）
function snapDetachedEnd(det) {
  det.mid.updateWorldMatrix(true, false);
  _detWorld.copy(det.mid.matrixWorld).multiply(det.offsetMatrix);
  _detLocal.copy(det.end.parent.matrixWorld).invert().multiply(_detWorld);
  _detLocal.decompose(det.end.position, det.end.quaternion, det.end.scale);
  det.end.updateMatrixWorld(true);
}

// 简化 CCD IK（针对 GLB 骨骼）。snapEnd：可选回调，在每次量测末端前调用（扁平骨架贴脚）
function solveGLB_CCD(chainBones, targetPos, polePos, maxIter = 10, tol = 0.001, snapEnd = null) {
  const [root, mid, end] = chainBones;
  const ev = new THREE.Vector3();
  const bv = new THREE.Vector3();
  const dv = new THREE.Vector3();
  const q = new THREE.Quaternion();

  for (let iter = 0; iter < maxIter; iter++) {
    snapEnd?.();
    end.getWorldPosition(ev);
    if (ev.distanceTo(targetPos) < tol) break;

    // 旋转 mid — 保护：骨骼与目标重合时跳过（避免 NaN 四元数）
    mid.getWorldPosition(bv);
    dv.copy(targetPos).sub(bv);
    if (dv.lengthSq() < 1e-10) continue;
    dv.normalize();
    ev.sub(bv);
    if (ev.lengthSq() < 1e-10) continue;
    ev.normalize();
    q.setFromUnitVectors(ev, dv);
    applyWorldRotation(mid, q);

    snapEnd?.();
    end.getWorldPosition(ev);
    if (ev.distanceTo(targetPos) < tol) break;

    // 旋转 root
    root.getWorldPosition(bv);
    dv.copy(targetPos).sub(bv);
    if (dv.lengthSq() < 1e-10) continue;
    dv.normalize();
    ev.sub(bv);
    if (ev.lengthSq() < 1e-10) continue;
    ev.normalize();
    q.setFromUnitVectors(ev, dv);
    applyWorldRotation(root, q);
  }
  snapEnd?.();

  // Pole 约束
  if (polePos) {
    const rp = new THREE.Vector3(); root.getWorldPosition(rp);
    const ep = new THREE.Vector3(); end.getWorldPosition(ep);
    const mp = new THREE.Vector3(); mid.getWorldPosition(mp);
    const axis = ep.clone().sub(rp).normalize();
    const mproj = mp.clone().sub(rp);
    const pproj = polePos.clone().sub(rp);
    mproj.sub(axis.clone().multiplyScalar(mproj.dot(axis)));
    pproj.sub(axis.clone().multiplyScalar(pproj.dot(axis)));
    if (mproj.length() > 1e-6 && pproj.length() > 1e-6) {
      mproj.normalize(); pproj.normalize();
      const dot = Math.max(-1, Math.min(1, mproj.dot(pproj)));
      const angle = Math.acos(dot);
      if (angle > 1e-6) {
        const cross = new THREE.Vector3().crossVectors(mproj, pproj);
        q.setFromAxisAngle(axis, cross.dot(axis) > 0 ? angle : -angle);
        applyWorldRotation(root, q);
      }
    }
  }
}

function applyWorldRotation(bone, worldQ) {
  const pq = new THREE.Quaternion();
  if (bone.parent && bone.parent.isBone) {
    bone.parent.getWorldQuaternion(pq);
    pq.invert();
    const localQ = pq.clone().multiply(worldQ).multiply(pq.clone().invert());
    bone.quaternion.premultiply(localQ);
  } else {
    bone.quaternion.premultiply(worldQ);
  }
  bone.quaternion.normalize();
}

// VRM IK 求解函数（驱动 VRM humanoid 骨骼，复用 CCD 算法）
function solveVRM_IK(data) {
  const { jointMap, ikTargets, allBones } = data;
  if (!jointMap || !ikTargets) return;

  // 动作播放中跳过脚钉地（同 solveGLB_IK）
  const actionState = actionRuntime?.states?.get(data.id);
  const playingAction = actionState?.playing && !actionState?.isClip;

  if (!playingAction) {
    // 脚钉地（与 GLB 逻辑一致）
    if (!data._rootPrev) {
      const rootBone = _rigRootBone(jointMap);
      if (rootBone) {
        data._rootPrev = new THREE.Vector3();
        rootBone.getWorldPosition(data._rootPrev);
      }
    } else {
      const rootBone = _rigRootBone(jointMap);
      if (rootBone) {
        const nowPos = new THREE.Vector3();
        rootBone.getWorldPosition(nowPos);
        const delta = nowPos.clone().sub(data._rootPrev);
        if (delta.length() > 0.001) {
          for (const leg of ["rightLeg", "leftLeg"]) {
            if (ikTargets[leg]) {
              ikTargets[leg].target.position.sub(delta);
              ikTargets[leg].pole.position.sub(delta);
            }
          }
        }
        data._rootPrev.copy(nowPos);
      }
    }
  } else {
    data._rootPrev = null;
  }

  // IK 求解四链（复用 solveGLB_CCD）
  const chains = {
    rightArm: { root: 2, mid: 3, end: 4 },
    leftArm:  { root: 5, mid: 6, end: 7 },
    rightLeg: { root: 8, mid: 9, end: 10 },
    leftLeg:  { root: 11, mid: 12, end: 13 },
  };

  for (const [name, chain] of Object.entries(chains)) {
    const target = ikTargets[name];
    if (!target) continue;
    const chainBones = [chain.root, chain.mid, chain.end].map(i => jointMap.get(i)).filter(Boolean);
    if (chainBones.length < 3) continue;
    solveGLB_CCD(chainBones, target.target.position, target.pole.position);
  }

  // 刷新骨骼世界矩阵
  allBones.forEach(b => b.updateMatrixWorld());
}

// 动画循环：2D Canvas 渲染（零 WebGL 依赖）
let _lastFrameTs = 0;
let _renderLoopErrorCount = 0;
function renderLoop(ts) {
  try {
    // P3-0：帧间隔（动作采样用），首帧/异常值保护
    const dt = _lastFrameTs ? (ts - _lastFrameTs) / 1000 : 0.016;
    _lastFrameTs = ts || performance.now();

    // P0-fix：ac 声明上移（原在 panorama 分支后声明，全景模式 TDZ ReferenceError）
    const ac = cameraManager.getActiveCamera();

    // 更新 OrbitControls 的相机（用于关节投影计算）
    if (panorama.isEnabled()) {
      // 全景模式：相机锁原点，仅旋转（距离用极微小值保持球坐标正常运算）
      orbit.target.set(0, 1.5, 0);
      orbit.enablePan = false;
      orbit.minDistance = 0.01;
      orbit.maxDistance = 0.01;
      orbit.update();
      // 强制相机归位（orbit minDistance=0.01 保证球坐标非退化）
      defaultCamera.position.set(0, 1.5, 0);
      if (ac && ac.camera !== defaultCamera) {
        ac.camera.position.copy(defaultCamera.position);
      }
    } else {
      orbit.enablePan = true;
      orbit.minDistance = 0.5;
      orbit.maxDistance = 20;
      orbit.update();
    }
    // 2D 模式没有 WebGL render 自动更新矩阵，必须手动更新（拾取/IK/投影全依赖 matrixWorld）
    scene.updateMatrixWorld();
    if (ac) {
      ac.pos = ac.camera.position.toArray();
      ac.target = orbit.target.toArray();
    }

    // P3-1 3D-only：火柴人永久隐藏（防御性每帧压制——restore/setActive/导入等路径可能重新点亮）
    figureGroup.visible = false;
    const stickMgr = window.DS_FigureAPI?.getManager?.();
    if (stickMgr) {
      if (stickMgr.ikTargetsGroup) stickMgr.ikTargetsGroup.visible = false;
      for (const ch of stickMgr.characters.values()) {
        if (ch.skeletonGroup && ch.skeletonGroup.visible) ch.skeletonGroup.visible = false;
      }
    }
    // P3-1：同步 3D角色身体拾取 proxy（整体移动的点选目标）
    bodyMover.syncProxies();

    // P3-2：骨骼编辑模式每帧更新（投影/标记/Gizmo 相机）
    boneEditor.update();

    // P3-0：动作运行时 —— 采样动作预设，驱动 ikTargets + 骨盆（在 IK 求解前）
    actionRuntime.tick(dt);
    // P2-fix：VRM 实例每帧更新（弹簧骨/视线），原从不 update 导致 springBone 僵直
    for (const entry of externalManager.characters.values()) {
      if (entry.type === "vrm" && entry.vrm?.update) entry.vrm.update(dt);
    }
    // P3-0：骨骼显示 —— 补齐/清理 SkeletonHelper 并同步可见性
    skeletonHelpers.syncAll();
    
    // 渲染主链路：WebGL 模式走真实 3D 渲染；失败当帧回退 2D；
    // drawFrame 两种模式都调用——webgl 下内部仅填拾取缓存不绘制（2D canvas 作透明交互层）。
    const camRef = ac ? ac.camera : defaultCamera;
    // 全景模式：同步场景背景
    panorama.syncSceneBackground(scene);
    if (renderMode.isWebGL()) {
      if (!renderViewportWebGL(camRef)) renderMode.fallbackTo2D("渲染帧异常");
    }
    drawFrame(figureGroup, joints, camRef, window.__ds?.fkMode);
    
    // P1.5b 性能优化：IK 不再全员每帧求解。
    // - 活动角色：每帧解（拖拽 IK 球时必须实时）
    // - 非活动角色：仅在 _ikDirty（添加/恢复/模式切换/激活）时补解一次
    if (characterMode !== "stick") {
      const activeId = externalManager.activeCharacterId;
      for (const entry of externalManager.characters.values()) {
        if (!entry.model || entry.model.visible === false || !entry.jointMap || !entry.ikTargets) continue;
        // P3-2：骨骼编辑 applyPoseBones 后跳过几帧 IK，避免 solver 覆盖刚写入的骨骼
        if (entry._skipIKFrames > 0) { entry._skipIKFrames--; continue; }
        // P3-2：clip 动画播放期间骨骼由 AnimationMixer 驱动，IK 冻结不得覆写
        if (entry._clipPlaying) continue;
        const mustSolve = entry.id === activeId || entry._ikDirty;
        if (!mustSolve) continue;
        if (entry.type === "vrm") solveVRM_IK(entry);
        else solveGLB_IK(entry);
        entry._ikDirty = false;
      }
    }
    
    // 重置错误计数（连续成功帧后清零）
    if (_renderLoopErrorCount > 0) _renderLoopErrorCount = 0;
  } catch (e) {
    _renderLoopErrorCount++;
    console.error("[3D导演台] renderLoop 异常 (第" + _renderLoopErrorCount + "次):", e);
    // 连续异常 > 60 帧（~1秒）则提示用户并暂停错误日志
    if (_renderLoopErrorCount === 60) {
      showToast("⚠️ 渲染异常频繁，建议刷新页面", true);
    } else if (_renderLoopErrorCount > 600) {
      // 持续 10 秒以上异常，停止日志洪水
      if (_renderLoopErrorCount === 601) console.error("[3D导演台] renderLoop 持续异常，日志已抑制");
    }
  }
  requestAnimationFrame(renderLoop);
}
requestAnimationFrame(renderLoop);
