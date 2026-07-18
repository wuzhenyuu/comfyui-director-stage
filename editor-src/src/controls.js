/**
 * controls.js — 交互控制：Orbit、Transform、关节选择、子树联动拖动、骨长锁定
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { JOINT_CN, JOINT_PARENT, JOINT_CHILDREN, BONE_LENGTHS, SELECT_COLOR, JOINT_COLOR } from "./constants.js";
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
  if (selected) selected.material.color.setHex(JOINT_COLOR);
  selected = joint;
  if (joint) {
    joint.material.color.setHex(SELECT_COLOR);
    tctrl.attach(joint);
  } else {
    tctrl.detach();
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
// 窗口失焦时清除 Alt 状态
window.addEventListener("blur", () => { altHeld = false; });

/* ==================== 拖动事件：子树联动 + 骨长锁定 ==================== */

function jointsSnapshot() {
  return window.__ds.joints.map((j) => [j.position.x, j.position.y, j.position.z]);
}

function onDragChanged(e) {
  orbit.enabled = !e.value;
  if (e.value) {
    // 拖动开始：压 undo 栈（保存拖动前状态），记录初始坐标
    if (selected) {
      pushUndo(window.__ds.joints);
      dragJointIdx = selected.userData.index;
      dragInitial = jointsSnapshot();
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

  // 计算拖动关节的位移量（相对于拖动开始时）
  const dx = selected.position.x - dragInitial[idx][0];
  const dy = selected.position.y - dragInitial[idx][1];
  const dz = selected.position.z - dragInitial[idx][2];

  if (!altHeld) {
    // 联动模式：递推所有子孙
    const descendants = collectDescendants(idx);
    for (const di of descendants) {
      joints[di].position.set(
        dragInitial[di][0] + dx,
        dragInitial[di][1] + dy,
        dragInitial[di][2] + dz
      );
    }
  }

  // 骨长锁定
  if (boneLockEnabled) {
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
  // 从 rootIdx 向下递归约束，BFS 保证父关节先处理
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

/* ==================== 关节拾取 ==================== */

const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
let downXY = null;

function ndcFromEvent(e, domElement) {
  const r = domElement.getBoundingClientRect();
  pointerNdc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  pointerNdc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
}

export function setupPointerEvents(domElement, joints) {
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
    const hits = raycaster.intersectObjects(joints, false);
    selectJoint(hits.length ? hits[0].object : null);
  });

  domElement.addEventListener("pointermove", (e) => {
    if (tctrl.dragging) return;
    ndcFromEvent(e, domElement);
    raycaster.setFromCamera(pointerNdc, window.__ds.camera);
    const hit = raycaster.intersectObjects(joints, false).length > 0;
    domElement.style.cursor = hit ? "pointer" : "default";
  });
}

/* ==================== Undo/Redo 快捷键 ==================== */

export function setupKeyboardShortcuts(joints, onStateChange) {
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && !e.shiftKey && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      if (performUndo(joints)) {
        if (onStateChange) onStateChange();
      }
      updateOverlay();
      return;
    }
    if (e.ctrlKey && (e.key === "y" || e.key === "Y" || (e.shiftKey && (e.key === "Z" || e.key === "z")))) {
      // Ctrl+Y or Ctrl+Shift+Z
      e.preventDefault();
      if (performRedo(joints)) {
        if (onStateChange) onStateChange();
      }
      updateOverlay();
      return;
    }
  });
}

/* ==================== getters ==================== */

export function getOrbit() {
  return orbit;
}

export function getTransform() {
  return tctrl;
}
