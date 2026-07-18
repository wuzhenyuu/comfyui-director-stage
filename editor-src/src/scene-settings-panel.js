/**
 * scene-settings-panel.js — ⚙️ 场景设置面板
 * 渲染到 #scene-settings-panel DOM 容器
 */
import * as THREE from "three";

/**
 * 场景设置状态（供序列化使用）
 */
let sceneSettings = {
  showGrid: true,
  showAxes: true,
  snapGrid: true,
  backgroundColor: "#0b0d12",
  groundHeight: 0,
};

export function getSceneSettings() {
  return { ...sceneSettings };
}

export function setSceneSettings(settings) {
  if (settings) {
    if (settings.showGrid !== undefined) sceneSettings.showGrid = settings.showGrid;
    if (settings.showAxes !== undefined) sceneSettings.showAxes = settings.showAxes;
    if (settings.snapGrid !== undefined) sceneSettings.snapGrid = settings.snapGrid;
    if (settings.backgroundColor !== undefined) sceneSettings.backgroundColor = settings.backgroundColor;
    if (settings.groundHeight !== undefined) sceneSettings.groundHeight = settings.groundHeight;
  }
}

/**
 * 创建场景设置面板
 * @returns {{ panel: HTMLElement, refresh: () => void }}
 */
export function createSceneSettingsPanel() {
  const panel = document.createElement("div");
  panel.style.cssText = "display:flex;flex-direction:column;height:100%;overflow-y:auto;";

  // ── 标题 ──
  const header = document.createElement("div");
  header.textContent = "⚙️ 场景设置";
  header.style.cssText = "padding:12px 14px;font-weight:600;font-size:13px;border-bottom:1px solid #2a2f3d;";
  panel.appendChild(header);

  // ── 内容区域 ──
  const content = document.createElement("div");
  content.id = "scene-settings-content";
  content.style.cssText = "flex:1;overflow-y:auto;padding:8px 10px;";
  panel.appendChild(content);

  function addField(label) {
    const el = document.createElement("div");
    el.style.cssText = "margin-bottom:8px;";
    const lbl = document.createElement("div");
    lbl.textContent = label;
    lbl.style.cssText = "font-size:11px;color:#8a90a0;margin-bottom:3px;";
    el.appendChild(lbl);
    content.appendChild(el);
    return el;
  }

  function addCheckbox(label, emoji, getter, setter) {
    const el = addField(`${emoji} ${label}`);
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:6px;";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = getter();
    cb.style.cssText = "accent-color:#2f9e63;";

    const lbl = document.createElement("span");
    lbl.textContent = getter() ? "开" : "关";
    lbl.style.cssText = "font-size:12px;";

    cb.addEventListener("change", () => {
      setter(cb.checked);
      lbl.textContent = cb.checked ? "开" : "关";
      _applySettings();
    });

    row.appendChild(cb);
    row.appendChild(lbl);
    el.appendChild(row);
  }

  // ── 显示网格 ──
  addCheckbox("显示网格", "📏",
    () => sceneSettings.showGrid,
    (v) => { sceneSettings.showGrid = v; },
  );

  // ── 显示坐标轴 ──
  addCheckbox("显示坐标轴", "📐",
    () => sceneSettings.showAxes,
    (v) => { sceneSettings.showAxes = v; },
  );

  // ── 吸附网格 ──
  (() => {
    const el = addField("🎯 吸附网格");
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:6px;";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = sceneSettings.snapGrid;
    cb.style.cssText = "accent-color:#2f9e63;";

    const lbl = document.createElement("span");
    lbl.textContent = sceneSettings.snapGrid ? "开（变换吸附）" : "关（自由移动）";
    lbl.style.cssText = "font-size:12px;";

    cb.addEventListener("change", () => {
      sceneSettings.snapGrid = cb.checked;
      lbl.textContent = cb.checked ? "开（变换吸附）" : "关（自由移动）";
      _applySnapToTransforms(cb.checked);
    });

    row.appendChild(cb);
    row.appendChild(lbl);
    el.appendChild(row);
  })();

  // ── 背景色 ──
  (() => {
    const el = addField("🌅 背景色");
    const colorRow = document.createElement("div");
    colorRow.style.cssText = "display:flex;align-items:center;gap:6px;";

    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.value = sceneSettings.backgroundColor;
    colorInput.style.cssText = "width:28px;height:28px;border:none;cursor:pointer;background:none;padding:0;";

    const colorLabel = document.createElement("span");
    colorLabel.textContent = sceneSettings.backgroundColor;
    colorLabel.style.cssText = "font-size:11px;color:#8a90a0;flex:1;";

    colorInput.addEventListener("input", () => {
      colorLabel.textContent = colorInput.value;
      sceneSettings.backgroundColor = colorInput.value;
      _applyBackground(colorInput.value);
    });

    colorRow.appendChild(colorInput);
    colorRow.appendChild(colorLabel);
    el.appendChild(colorRow);
  })();

  // ── 地面高度 ──
  (() => {
    const el = addField("📐 地面高度");
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:6px;";

    const range = document.createElement("input");
    range.type = "range";
    range.min = "-1";
    range.max = "3";
    range.step = "0.1";
    range.value = String(sceneSettings.groundHeight);
    range.style.cssText = "flex:1;accent-color:#2f9e63;";

    const rangeLabel = document.createElement("span");
    rangeLabel.textContent = sceneSettings.groundHeight.toFixed(1);
    rangeLabel.style.cssText = "font-size:12px;min-width:30px;text-align:right;";

    range.addEventListener("input", () => {
      const v = parseFloat(range.value);
      sceneSettings.groundHeight = v;
      rangeLabel.textContent = v.toFixed(1);
      _applyGroundHeight(v);
    });

    row.appendChild(range);
    row.appendChild(rangeLabel);
    el.appendChild(row);
  })();

  // ── 应用设置 ──
  function _applySettings() {
    _applyGridAndAxes();
    _applyBackground(sceneSettings.backgroundColor);
    _applyGroundHeight(sceneSettings.groundHeight);
    _applySnapToTransforms(sceneSettings.snapGrid);
  }

  function _applyGridAndAxes() {
    try {
      const ds = window.__ds;
      const scene = ds?.scene;
      if (!scene) return;

      scene.traverse((child) => {
        if (child instanceof THREE.GridHelper) {
          child.visible = sceneSettings.showGrid;
        }
        if (child instanceof THREE.AxesHelper) {
          child.visible = sceneSettings.showAxes;
        }
      });
    } catch (e) { /* ignore */ }
  }

  function _applyBackground(colorStr) {
    try {
      const ds = window.__ds;
      const scene = ds?.scene;
      if (!scene) return;
      scene.background = new THREE.Color(colorStr);
    } catch (e) { /* ignore */ }
  }

  function _applyGroundHeight(h) {
    try {
      const ds = window.__ds;
      const scene = ds?.scene;
      if (!scene) return;

      // 查找并调整 GridHelper 位置
      scene.traverse((child) => {
        if (child instanceof THREE.GridHelper) {
          child.position.y = h;
        }
        if (child instanceof THREE.AxesHelper) {
          // AxesHelper 随地面移动
          child.position.y = h;
        }
      });
    } catch (e) { /* ignore */ }
  }

  function _applySnapToTransforms(enabled) {
    try {
      // PropManager TransformControls 吸附
      const pm = window.__ds?.propManager;
      if (pm && pm.tctrl) {
        if (enabled) {
          pm.tctrl.setTranslationSnap(0.25, 0.25, 0.25);
        } else {
          pm.tctrl.setTranslationSnap(null);
        }
      }

      // 角色 TransformControls 吸附
      const tctrl = window.__ds?.__tctrl;
      if (tctrl) {
        if (enabled) {
          tctrl.setTranslationSnap(0.25, 0.25, 0.25);
        } else {
          tctrl.setTranslationSnap(null);
        }
      }
    } catch (e) { /* ignore */ }
  }

  // 初始应用
  _applySettings();

  // 同步到 window.__ds.sceneSettings（供 serialization.js 读取）
  function _syncToGlobal() {
    window.__ds = window.__ds || {};
    window.__ds.sceneSettings = getSceneSettings();
  }
  _syncToGlobal();

  // 原始引用，以便 onChange 回写设置后重新同步
  panel.syncGlobal = _syncToGlobal;

  return {
    panel,
    refresh: () => {
      _applySettings();
      _syncToGlobal();
    },
  };
}
