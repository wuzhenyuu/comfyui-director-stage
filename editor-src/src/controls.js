/**
 * controls.js — 交互控制：Orbit、Transform、关节选择、子树联动拖动、骨长锁定
 * M2: 增加 IK target 拖拽、角色切换键盘快捷键
 * P1-A: 增加对象锁定系统 + 锁定检查
 *
 * 导出接口（供 main.js 调用）：
 *   - createOrbit / createTransform / selectJoint / getSelected
 *   - setupPointerEvents / setupKeyboardShortcuts
 *   - getOrbit / getTransform / getTransformControls
 *   - isBoneLockEnabled / setBoneLockEnabled
 *   - setObjectLocked / isObjectLocked / mountControlsGlobals
 *
 * 挂载到 window.__ds：
 *   - setObjectLocked(id, locked)  锁定 / 解锁角色或道具
 *   - isObjectLocked(id)           查询锁定状态
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { JOINT_CN, JOINT_PARENT, JOINT_CHILDREN, BONE_LENGTHS, SELECT_COLOR, JOINT_COLOR, RIGHT_JOINTS, LEFT_JOINTS } from "./constants.js";
import { pushUndo, performUndo, performRedo } from "./undo.js";
import { updateOverlay } from "./camera-settings.js";

let orbit = null;
let tctrl = null;
let selected = null;
let altHeld = false;
let dragInitial = null;
let dragJointIdx = -1;
let boneLockEnabled = true;

/** 运行时锁映射：id → true（角色 ID 或 prop ID，用于对象创建前的锁定标记） */
const _lockedMap = new Map();

const _tempV = new THREE.Vector3();

/* ==================== OrbitControls ==================== */

export function createOrbit(camera, domElement) {
  orbit = new OrbitControls(camera, domElement);
  orbit.target.set(0, 1, 0);
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.08;
  orbit.mouseButtons = {
    LEFT: null,
    MIDDLE: THREE.MOUSE.PAN,
    RIGHT: THREE.MOUSE.ROTATE,
  };
  orbit.update();
  // 暴露给 cameras.js 的 POV 切换使用
  window.__ds__orbit = orbit;
  return orbit;
}

/* ==================== TransformControls ==================== */

export function createTransform(camera, domElement, scene) {
  tctrl = new TransformControls(camera, domElement);
  tctrl.setMode("translate");
  tctrl.setSize(0.65);
  tctrl.addEventListener("dragging-changed", onDragChanged);
  tctrl.addEventListener("objectChange", onObjectChange);

  const gizmo = typeof tctrl.getHelper === "function" ? tctrl.getHelper() : tctrl;
  scene.add(gizmo);
  return { tctrl, gizmo };
}

/* ==================== 关节选择 ==================== */

export function selectJoint(joint) {
  if (selected === joint) return;
  if (selected) {
    // 恢复旧选中关节颜色
    _restoreJointColor(selected);
  }
  selected = joint;
  if (joint) {
    joint.material.color.setHex(SELECT_COLOR);
    joint.material.emissive?.setHex(SELECT_COLOR);
    tctrl.attach(joint);
  } else {
    tctrl.detach();
  }
}

function _restoreJointColor(joint) {
  const idx = joint.userData?.index;
  if (idx !== undefined) {
    if (RIGHT_JOINTS.has(idx)) joint.material.color.setHex(0xff9966);
    else if (LEFT_JOINTS.has(idx)) joint.material.color.setHex(0x6699ff);
    else joint.material.color.setHex(0xffffff);
  } else {
    joint.material.color.setHex(JOINT_COLOR);
  }
}

export function getSelected() {
  return selected;
}

/* ==================== Alt 键追踪 ==================== */

window.addEventListener("keydown", (e) => {
  if (e.key === "Alt" && !e.repeat) altHeld = true;
});
window.addEventListener("keyup", (e) => {
  if (e.key === "Alt") altHeld = false;
});
window.addEventListener("blur", () => { altHeld = false; });

/* ==================== 拖动事件：子树联动 + 骨长锁定 ==================== */

function jointsSnapshot() {
  return window.__ds.joints.map((j) => [j.position.x, j.position.y, j.position.z]);
}

function onDragChanged(e) {
  orbit.enabled = !e.value;
  if (e.value) {
    // 拖拽开始：检查选中对象是否锁定
    if (selected && _isObjectLocked(selected)) {
      // 锁定对象禁止拖拽 — 立即 detach 并清除选择
      tctrl.detach();
      selectJoint(null);
      orbit.enabled = true;
      return;
    }

    // 拖动开始：压 undo 栈
    const api = window.DS_FigureAPI;
    if (api) {
      pushUndo(null);  // undo.js 内部会处理多角色 snapshot
    } else if (selected) {
      pushUndo(window.__ds.joints);
    }

    // 关节拖拽初始化（IK targets 不参与子树拖动/骨长锁定）
    if (selected && !selected.userData.ikType) {
      dragInitial = jointsSnapshot();
      dragJointIdx = selected.userData.index;
    }
  } else {
    // 拖动结束
    dragInitial = null;
    dragJointIdx = -1;
    updateOverlay();
  }
}

function onObjectChange() {
  if (!selected || !dragInitial || dragJointIdx < 0) return;

  const joints = window.__ds.joints;
  const idx = dragJointIdx;

  // 如果是 IK target 球，由 figure.js update 循环处理，这里不干预
  if (selected.userData.ikType) return;

  const dx = selected.position.x - dragInitial[idx][0];
  const dy = selected.position.y - dragInitial[idx][1];
  const dz = selected.position.z - dragInitial[idx][2];

  if (!altHeld) {
    const descendants = collectDescendants(idx);
    for (const di of descendants) {
      joints[di].position.set(
        dragInitial[di][0] + dx,
        dragInitial[di][1] + dy,
        dragInitial[di][2] + dz
      );
    }
  }

  if (boneLockEnabled && !selected.userData.ikType) {
    applyBoneLock(idx);
  }
}

function collectDescendants(idx) {
  const result = [];
  const stack = [idx];
  while (stack.length) {
    const ci = stack.pop();
    result.push(ci);
    for (const child of JOINT_CHILDREN[ci]) {
      stack.push(child);
    }
  }
  return result;
}

function applyBoneLock(rootIdx) {
  const joints = window.__ds.joints;
  const queue = [rootIdx];
  while (queue.length) {
    const idx = queue.shift();
    const parentIdx = JOINT_PARENT[idx];
    if (parentIdx !== undefined) {
      const parent = joints[parentIdx].position;
      const child = joints[idx].position;
      const boneLen = BONE_LENGTHS[idx];
      _tempV.copy(child).sub(parent);
      const dist = _tempV.length();
      if (dist > 1e-8) {
        _tempV.normalize().multiplyScalar(boneLen).add(parent);
        joints[idx].position.copy(_tempV);
      }
    }
    for (const ci of JOINT_CHILDREN[idx]) {
      queue.push(ci);
    }
  }
}

/* ==================== 骨长锁定开关 ==================== */

export function isBoneLockEnabled() {
  return boneLockEnabled;
}

export function setBoneLockEnabled(v) {
  boneLockEnabled = !!v;
}

/* ==================== 关节/IkTarget 拾取 ==================== */

const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
let downXY = null;

function ndcFromEvent(e, domElement) {
  const r = domElement.getBoundingClientRect();
  pointerNdc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  pointerNdc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
}

/**
 * 收集所有可拾取对象
 * 在 IK 模式下仅 IK targets/poles 可拾取（关节球纯视觉）
 * 在 FK 模式下所有关节球可拾取（类似 M1）
 */
function getPickableObjects() {
  const api = window.DS_FigureAPI;
  const char = api ? api.getActiveCharacter() : null;
  const objects = [];

  // FK 模式开关（由 main.js 设置）
  const fkMode = window.__ds?.fkMode;

  if (char) {
    if (fkMode) {
      // FK 模式：所有关节球可拖拽
      objects.push(...char.jointSpheres);
    } else {
      // IK 模式：仅 IK targets 和 poles 可拾取，关节球纯视觉
      for (const state of Object.values(char.ikState)) {
        objects.push(state.target, state.pole);
      }
    }
  } else if (window.__ds?.joints) {
    // M1 降级
    objects.push(...window.__ds.joints);
  }

  return objects;
}

export function setupPointerEvents(domElement) {
  domElement.addEventListener("pointerdown", (e) => {
    if (e.button === 0) downXY = [e.clientX, e.clientY];
  });

  domElement.addEventListener("pointerup", (e) => {
    if (e.button !== 0 || !downXY) return;
    const moved = Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]) > 5;
    downXY = null;
    if (moved || tctrl.dragging || tctrl.axis) return;
    ndcFromEvent(e, domElement);
    raycaster.setFromCamera(pointerNdc, window.__ds.camera);

    const pickables = getPickableObjects();
    const hits = raycaster.intersectObjects(pickables, false);

    if (hits.length) {
      const obj = hits[0].object;
      // 锁定检查：如果对象或其所属角色被锁定，阻止选中
      if (_isObjectLocked(obj)) {
        return; // 不选中锁定对象
      }
      if (obj.userData.ikType) {
        // IK target 或 pole：选中它以便 TransformControls 拖拽
        selectJoint(obj);
      } else {
        selectJoint(obj);
      }
    } else {
      selectJoint(null);
    }
  });

  domElement.addEventListener("pointermove", (e) => {
    if (tctrl.dragging) return;
    ndcFromEvent(e, domElement);
    raycaster.setFromCamera(pointerNdc, window.__ds.camera);
    const pickables = getPickableObjects();
    const hits = raycaster.intersectObjects(pickables, false);
    if (hits.length) {
      const obj = hits[0].object;
      domElement.style.cursor = _isObjectLocked(obj) ? "not-allowed" : "pointer";
    } else {
      domElement.style.cursor = "default";
    }
  });
}

/* ==================== Undo/Redo 快捷键 ==================== */

export function setupKeyboardShortcuts(onStateChange) {
  window.addEventListener("keydown", (e) => {
    // 角色切换快捷键 1-9（非编辑状态）
    if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key >= "1" && e.key <= "9") {
      const api = window.DS_FigureAPI;
      if (!api) return;
      const chars = Array.from(api.getAllCharacters().values());
      const idx = parseInt(e.key) - 1;
      if (idx < chars.length) {
        e.preventDefault();
        const targetId = chars[idx].id;
        if (targetId !== api.getActiveCharacter()?.id) {
          api.setActive(targetId);
          // 切换 active 后 TransformControls detach old，不自动 attach new
          if (selected) selectJoint(null);
          updateCharPanelIfExists();
        }
      }
      return;
    }

    if (e.ctrlKey && !e.shiftKey && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      const api = window.DS_FigureAPI;
      if (api) {
        if (performUndo(null)) {
          if (onStateChange) onStateChange();
        }
      } else if (window.__ds?.joints) {
        if (performUndo(window.__ds.joints)) {
          if (onStateChange) onStateChange();
        }
      }
      updateOverlay();
      return;
    }
    if (e.ctrlKey && (e.key === "y" || e.key === "Y" || (e.shiftKey && (e.key === "Z" || e.key === "z")))) {
      e.preventDefault();
      if (performRedo(null)) {
        if (onStateChange) onStateChange();
      }
      updateOverlay();
      return;
    }
  });
}

function updateCharPanelIfExists() {
  const api = window.DS_FigureAPI;
  if (!api) return;
  // 触发 char-panel 更新（通过自定义事件）
  window.dispatchEvent(new CustomEvent("ds-char-changed", {
    detail: { activeId: api.getActiveCharacter()?.id }
  }));
}

/* ==================== getters ==================== */

export function getOrbit() {
  return orbit;
}

export function getTransform() {
  return tctrl;
}

export function getTransformControls() {
  return tctrl;
}

/* ==================== 对象锁定系统 ==================== */

/**
 * 判断拾取对象是否被锁定
 * - 关节球 / IK target：查所属角色 _locked 字段
 * - 道具网格：查 propManager 中对应 entry 的 locked 字段
 * - 直接标记：对象自身 _locked 属性
 * @param {THREE.Object3D} obj
 * @returns {boolean}
 */
function _isObjectLocked(obj) {
  if (!obj) return false;

  // 1. 对象自身 _locked 标记
  if (obj._locked === true) return true;

  // 2. 通过 userData 查找所属角色
  const charId = obj.userData?.characterId;
  if (charId) {
    const api = window.DS_FigureAPI;
    if (api) {
      const ch = api.getCharacter ? api.getCharacter(charId) : null;
      if (ch && ch._locked) return true;
    }
    if (_lockedMap.has(charId)) return true;
  }

  // 3. 通过 userData.propId 查找道具锁
  const propId = obj.userData?.propId;
  if (propId) {
    const pm = window.__ds?.propManager;
    if (pm) {
      const prop = pm.props.find((p) => p.id === propId);
      if (prop && prop.locked) return true;
    }
    if (_lockedMap.has(propId)) return true;
  }

  // 4. 兜底：查全局锁映射
  const id = obj.userData?.propId || obj.userData?.characterId;
  if (id && _lockedMap.has(id)) return true;

  return false;
}

/**
 * 设置对象锁定状态（角色或道具）
 * @param {string} id - 角色 ID 或道具 ID
 * @param {boolean} locked
 */
export function setObjectLocked(id, locked) {
  if (!id) return;

  // 1. 查角色
  const api = window.DS_FigureAPI;
  if (api && api.getCharacter) {
    const ch = api.getCharacter(id);
    if (ch) {
      ch._locked = !!locked;
      if (locked) _lockedMap.set(id, true);
      else _lockedMap.delete(id);
      return;
    }
  }

  // 2. 查道具
  const pm = window.__ds?.propManager;
  if (pm) {
    const prop = pm.props.find((p) => p.id === id);
    if (prop) {
      prop.locked = !!locked;
      if (locked) _lockedMap.set(id, true);
      else _lockedMap.delete(id);
      return;
    }
  }

  // 3. 只记录到全局映射（对象尚未创建但先置锁）
  if (locked) {
    _lockedMap.set(id, true);
  } else {
    _lockedMap.delete(id);
  }
}

/**
 * 查询对象锁定状态
 * @param {string} id - 角色 ID 或道具 ID
 * @returns {boolean}
 */
export function isObjectLocked(id) {
  if (!id) return false;

  // 查角色
  const api = window.DS_FigureAPI;
  if (api && api.getCharacter) {
    const ch = api.getCharacter(id);
    if (ch) return ch._locked === true || _lockedMap.has(id);
  }

  // 查道具
  const pm = window.__ds?.propManager;
  if (pm) {
    const prop = pm.props.find((p) => p.id === id);
    if (prop) return prop.locked === true || _lockedMap.has(id);
  }

  return _lockedMap.has(id);
}

/* ---- 挂载全局函数 ---- */

export function mountControlsGlobals() {
  if (!window.__ds) window.__ds = {};

  /**
   * 设置对象（角色/道具）锁定状态
   * @param {string} id
   * @param {boolean} locked
   */
  window.__ds.setObjectLocked = setObjectLocked;

  /**
   * 查询对象锁定状态
   * @param {string} id
   * @returns {boolean}
   */
  window.__ds.isObjectLocked = isObjectLocked;
}
