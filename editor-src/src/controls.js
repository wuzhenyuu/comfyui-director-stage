/**
 * controls.js — 交互控制：Orbit、Transform、关节选择、子树联动拖动、骨长锁定
 * M2: 增加 IK target 拖拽、角色切换键盘快捷键
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
 * 收集所有可拾取对象（关节球 + IK target 球）
 */
function getPickableObjects() {
  const api = window.DS_FigureAPI;
  const char = api ? api.getActiveCharacter() : null;
  const objects = [];

  // 活动角色关节球
  if (char) {
    objects.push(...char.jointSpheres);
  } else if (window.__ds?.joints) {
    objects.push(...window.__ds.joints);
  }

  // IK targets（仅活动角色）
  if (char) {
    for (const state of Object.values(char.ikState)) {
      objects.push(state.target, state.pole);
    }
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
    const hit = raycaster.intersectObjects(pickables, false).length > 0;
    domElement.style.cursor = hit ? "pointer" : "default";
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
