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
/** P3-1：3D角色整体移动器（main.js 注入，external-character-move.js 实现） */
let externalBodyMover = null;
/** P3-1：身体射线命中点缓存（pointerdown → begin 传参） */
let _bodyHitPoint = null;

/** 注入 3D角色整体移动器（点身体拖整人；IK 球仍走原有摆姿势路径） */
export function setExternalBodyMover(mover) {
  externalBodyMover = mover;
}
let dragInitial = null;
let dragJointIdx = -1;
/** 契约 3：被拖角色（beginDrag 时确定，endDrag 清空）；null 时回退 window.__ds.joints */
let dragChar = null;
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
  // 左键（空白处）= 旋转视角：避开浏览器鼠标手势（右键拖动=后退/前进）
  // 左键点在关节/道具上时 beginDrag 会禁用 orbit，拖拽对象优先
  orbit.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.PAN,
    RIGHT: THREE.MOUSE.PAN,
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
  // 2D 视口选中高亮（scene.js 每帧读取）
  window.__ds_selectedJoint = joint || null;
  if (joint) {
    joint.material.color.setHex(SELECT_COLOR);
    joint.material.emissive?.setHex(SELECT_COLOR);
    // 2D 编辑器：不 attach TransformControls（gizmo 不可见，拖拽由自定义 2D 拖拽处理）
  }
}

function _restoreJointColor(joint) {
  // 3D-only：IK target/pole 球没有 userData.index，不需要恢复火柴人颜色
  if (!joint || !joint.material || !joint.material.color) return;
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
  const joints = (dragChar && dragChar.jointSpheres) || window.__ds.joints;
  return joints.map((j) => [j.position.x, j.position.y, j.position.z]);
}

/**
 * 契约 3：根据被拖对象确定所属角色
 * - IK target/pole 球：userData.characterId
 * - 普通关节球：查拾取缓存 __ds_jointScreen 的 charId
 * - 兜底：当前活动角色
 */
function _resolveDragChar(obj) {
  const api = window.DS_FigureAPI;
  if (!api || !obj) return null;
  let charId = obj.userData?.characterId || null;
  if (!charId) {
    const screen = window.__ds_jointScreen;
    if (screen && screen.length) {
      for (const s of screen) {
        if (s.obj === obj) { charId = s.charId; break; }
      }
    }
  }
  if (charId && api.getAllCharacters) {
    const ch = api.getAllCharacters().get(charId);
    if (ch) return ch;
  }
  return api.getActiveCharacter ? api.getActiveCharacter() : null;
}

/** 契约 3：pointerdown 命中后自动激活对象所属角色 */
function _activateCharOfObj(obj) {
  // P1.5：命中外部 3D角色的 IK 球 → 激活对应外部角色
  const extId = obj?.userData?.externalCharId;
  if (extId) {
    const mgr = window.__ds?.externalCharacters;
    if (mgr && mgr.activeCharacterId !== extId) {
      mgr.setActive(extId);
    }
    return;
  }
  const api = window.DS_FigureAPI;
  if (!api || !api.setActive) return;
  const ch = _resolveDragChar(obj);
  if (ch && ch.id && ch.id !== api.getActiveCharacter()?.id) {
    api.setActive(ch.id);
    updateCharPanelIfExists();
  }
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

    // 契约 3：确定被拖角色
    dragChar = _resolveDragChar(selected);

    // 关节拖拽初始化（IK targets 不参与子树拖动/骨长锁定）
    if (selected && !selected.userData.ikType) {
      dragInitial = jointsSnapshot();
      dragJointIdx = selected.userData.index;
    }
  } else {
    // 拖动结束
    dragInitial = null;
    dragJointIdx = -1;
    dragChar = null;
    updateOverlay();
  }
}

function onObjectChange() {
  applyDragConstraints();
}

/**
 * 拖拽约束（子树联动 + 骨长锁定）—— TransformControls 与 2D 拖拽共用
 * 前提：selected 位置已被外部更新，dragInitial/dragJointIdx 已就位
 */
function applyDragConstraints() {
  if (!selected || !dragInitial || dragJointIdx < 0) return;

  const joints = (dragChar && dragChar.jointSpheres) || window.__ds.joints;
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
  const joints = (dragChar && dragChar.jointSpheres) || window.__ds.joints;
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
 * FK 模式（默认）：关节球可拖拽，类似 M1
 * IK 模式（勾选）：仅 IK targets/poles 可拾取
 */
function getPickableObjects() {
  const api = window.DS_FigureAPI;
  const char = api ? api.getActiveCharacter() : null;
  const objects = [];

  const fkMode = window.__ds?.fkMode;

  const externalGlbMode = !!window.__ds?.isGLBMode;
  const externalVrmMode = !!window.__ds?.isVRMMode;
  const externalMode = externalGlbMode || externalVrmMode;

  // GLB/VRM 外部角色模式下：只拾取所有可见外部角色自己的 IK 目标，
  // 不再拾取已隐藏火柴人的关节/IK 球，避免“拖到隐形对象”。
  if (externalMode) {
    const mgr = window.__ds?.externalCharacters;
    if (mgr && mgr.characters?.size) {
      // P1.5：枚举全部外部角色（点谁的 IK 球就激活谁）
      for (const entry of mgr.characters.values()) {
        if (!entry.ikTargets) continue;
        if (entry.visible === false) continue;
        if (entry.model && entry.model.visible === false) continue;
        for (const t of Object.values(entry.ikTargets)) {
          if (t && t.target) objects.push(t.target);
          if (t && t.pole) objects.push(t.pole);
        }
      }
      // 过滤 null/undefined 与不可见对象；全部不可见/无 ikTargets 时返回空数组，
      // 此时 orbit 不受影响仍可旋转视角，pickAt 对空数组安全返回 null
      return objects.filter((o) => o && o.visible !== false);
    }
    // 旧路径兼容（manager 为空但 glbData/vrmData 存在的极端情况）
    if (externalGlbMode && window.__ds?.glbData?.ikTargets) {
      for (const t of Object.values(window.__ds.glbData.ikTargets)) {
        if (t && t.target) objects.push(t.target);
        if (t && t.pole) objects.push(t.pole);
      }
    }
    if (externalVrmMode && window.__ds?.vrmData?.ikTargets) {
      for (const t of Object.values(window.__ds.vrmData.ikTargets)) {
        if (t && t.target) objects.push(t.target);
        if (t && t.pole) objects.push(t.pole);
      }
    }
    // 同上：空数组安全返回，orbit 保持可用，pickAt 不会因此抛异常
    return objects.filter((o) => o && o.visible !== false);
  }

  if (char) {
    if (fkMode) {
      for (const state of Object.values(char.ikState)) {
        objects.push(state.target, state.pole);
      }
    } else {
      objects.push(...char.jointSpheres);
    }
  } else if (window.__ds?.joints) {
    objects.push(...window.__ds.joints);
  }

  return objects;
}

export function setupPointerEvents(domElement) {
  // ─── 2D 拖拽状态 ───
  let dragObj = null;
  const dragPlane = new THREE.Plane();
  const dragOffset = new THREE.Vector3();
  const _hit = new THREE.Vector3();
  const _world = new THREE.Vector3();
  const _camDir = new THREE.Vector3();

  function pickAt(e) {
    // 屏幕空间拾取优先：与 2D 绘制同一套投影坐标，视觉=拾取
    // （根治：3D 小球体在远机位投影过小导致射线打不中）
    const r = domElement.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      const screen = window.__ds_jointScreen;
      if (screen && screen.length) {
        let best = null;
        let bestD = 14; // 14px 命中半径（绘制点最大 12px，留 2px 余量）
        for (const s of screen) {
          if (s.behind || !s.obj) continue;
          const d = Math.hypot(s.x - mx, s.y - my);
          if (d < bestD) { bestD = d; best = s.obj; }
        }
        if (best) return best;
      }
    }
    // 兜底：3D 射线（未来 3D 渲染模式 / 无屏幕缓存对象）
    const cam = window.__ds?.camera;
    if (!cam) return null;
    ndcFromEvent(e, domElement);
    raycaster.setFromCamera(pointerNdc, cam);
    const pickables = getPickableObjects();
    // 无可拾取对象（如外部角色全部不可见/无 ikTargets）时直接返回 null，
    // 避免对空数组做射线求交，orbit 交互不受影响
    if (!pickables.length) return null;
    const hits = raycaster.intersectObjects(pickables, false);
    return hits.length ? hits[0].object : null;
  }

  function beginDrag(e, obj) {
    const cam = window.__ds.camera;
    dragObj = obj;
    // 契约 3：确定被拖角色（IK 球取 userData.characterId，关节球取拾取缓存 charId）
    dragChar = _resolveDragChar(obj);
    orbit.enabled = false;

    // 拖拽平面：过对象世界位置，法线 = 相机视线方向（屏幕平行面）
    obj.getWorldPosition(_world);
    cam.getWorldDirection(_camDir);
    dragPlane.setFromNormalAndCoplanarPoint(_camDir, _world);

    // 指针射线与平面交点 → 记录与对象位置的偏移，防止跳变
    ndcFromEvent(e, domElement);
    raycaster.setFromCamera(pointerNdc, cam);
    if (raycaster.ray.intersectPlane(dragPlane, _hit)) {
      dragOffset.copy(_hit).sub(_world);
    } else {
      dragOffset.set(0, 0, 0);
    }

    // 压 undo 栈（与 onDragChanged 起始逻辑一致）
    const api = window.DS_FigureAPI;
    if (api) {
      pushUndo(null);
    } else {
      pushUndo(window.__ds.joints);
    }

    // 关节拖拽初始化（IK targets 不参与子树拖动/骨长锁定）
    if (!obj.userData.ikType) {
      dragInitial = jointsSnapshot();
      dragJointIdx = obj.userData.index;
    } else {
      dragInitial = null;
      dragJointIdx = -1;
    }
  }

  function moveDrag(e) {
    if (!dragObj) return;
    const cam = window.__ds?.camera;
    if (!cam) return;
    ndcFromEvent(e, domElement);
    raycaster.setFromCamera(pointerNdc, cam);
    if (!raycaster.ray.intersectPlane(dragPlane, _hit)) return;
    _hit.sub(dragOffset);
    // 世界坐标 → 对象父坐标系
    if (dragObj.parent) {
      dragObj.parent.worldToLocal(_hit);
    }
    dragObj.position.copy(_hit);
    // 契约 2：整人移动 — 开关 ON 且拖普通关节（非 IK 球）时，
    // delta 平移到该角色全部 18 关节，跳过子树联动 + 骨长锁定
    if (window.__ds_moveWholeBody && !dragObj.userData.ikType && dragChar && dragInitial && dragJointIdx >= 0) {
      const dx = dragObj.position.x - dragInitial[dragJointIdx][0];
      const dy = dragObj.position.y - dragInitial[dragJointIdx][1];
      const dz = dragObj.position.z - dragInitial[dragJointIdx][2];
      const joints = dragChar.jointSpheres;
      const n = Math.min(joints.length, dragInitial.length);
      for (let i = 0; i < n; i++) {
        joints[i].position.set(
          dragInitial[i][0] + dx,
          dragInitial[i][1] + dy,
          dragInitial[i][2] + dz
        );
      }
      return;
    }
    // 子树联动 + 骨长锁定（IK 球内部自动跳过）
    applyDragConstraints();
  }

  function endDrag() {
    if (!dragObj) return;
    dragObj = null;
    dragInitial = null;
    dragJointIdx = -1;
    dragChar = null;  // 契约 3：拖拽结束清空被拖角色
    orbit.enabled = true;
    updateOverlay();
  }

  domElement.addEventListener("pointerdown", (e) => {
    if (e.button === 0) downXY = [e.clientX, e.clientY];
    if (e.button !== 0) return;
    // 道具拖拽优先（PropManager 先注册，命中道具时 isDragging=true）
    if (window.__ds?.propManager?.isDragging?.()) return;
    const obj = pickAt(e);
    if (!obj) {
      // P3-1：未命中 IK 球/关节时，尝试命中 3D角色身体 → 整体移动
      // P3-2：骨骼编辑模式下禁用身体拖拽，让 bone-editor 接管点击事件
      const isBoneEdit = window.__ds?.boneEditor?.getMode?.() === "bone";
      if (!isBoneEdit) {
      const externalMode = !!(window.__ds?.isGLBMode || window.__ds?.isVRMMode);
      if (externalMode && externalBodyMover) {
        // 道具命中优先（道具选择/拖拽由 PropManager 接管）
        let propHit = null;
        try {
          const pm = window.__ds?.propManager;
          if (pm?.pickProp) {
            ndcFromEvent(e, domElement);
            propHit = pm.pickProp(pointerNdc);
          }
        } catch (_) { /* ignore */ }
        if (!propHit) {
          _bodyHitPoint = _bodyHitPoint || new THREE.Vector3();
          const entry = externalBodyMover.pick(e.clientX, e.clientY, domElement, _bodyHitPoint);
          if (entry) {
            const mgr = window.__ds?.externalCharacters;
            if (mgr && mgr.activeCharacterId !== entry.id) mgr.setActive(entry.id);
            selectJoint(null);
            if (externalBodyMover.begin(entry, e.clientX, e.clientY, domElement, _bodyHitPoint)) {
              orbit.enabled = false;
            }
          }
        }
      }
      } // end if (!isBoneEdit)
      return;
    }
    if (_isObjectLocked(obj)) return;
    // 契约 3：命中后自动激活所属角色（顺带刷新角色面板高亮）
    _activateCharOfObj(obj);
    selectJoint(obj);
    beginDrag(e, obj);
  });

  domElement.addEventListener("pointerup", (e) => {
    if (e.button !== 0) return;
    // P3-1：结束 3D角色整体拖拽
    if (externalBodyMover?.dragging) {
      externalBodyMover.end();
      orbit.enabled = true;
    }
    const wasDragging = !!dragObj;
    endDrag();
    if (!downXY) return;
    const moved = Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]) > 5;
    downXY = null;
    if (moved || wasDragging) return; // 拖拽结束不算点击
    // 点击（未拖动）：命中选中 / 空白取消选中
    const obj = pickAt(e);
    if (obj) {
      if (!_isObjectLocked(obj)) selectJoint(obj);
    } else {
      selectJoint(null);
    }
  });

  domElement.addEventListener("pointermove", (e) => {
    // P3-1：3D角色整体拖拽中（Alt = Y 升降）
    if (externalBodyMover?.dragging) {
      externalBodyMover.move(e.clientX, e.clientY, domElement, e.altKey);
      return;
    }
    if (dragObj) {
      moveDrag(e);
      return;
    }
    const obj = pickAt(e);
    // hover 高亮（scene.js 每帧读取）
    window.__ds_hoverJoint = obj || null;
    if (obj) {
      domElement.style.cursor = _isObjectLocked(obj) ? "not-allowed" : "pointer";
      return;
    }
    // P3-1：悬停 3D角色身体提示可整体移动
    const externalMode = !!(window.__ds?.isGLBMode || window.__ds?.isVRMMode);
    if (externalMode && externalBodyMover) {
      const entry = externalBodyMover.pick(e.clientX, e.clientY, domElement);
      domElement.style.cursor = entry ? "move" : "default";
      return;
    }
    domElement.style.cursor = "default";
  });

  // 指针离开画布时兜底结束拖拽
  domElement.addEventListener("pointerleave", () => {
    if (externalBodyMover?.dragging) {
      externalBodyMover.end();
      orbit.enabled = true;
    }
    endDrag();
  });
}

/* ==================== Undo/Redo 快捷键 ==================== */

export function setupKeyboardShortcuts(onStateChange) {
  window.addEventListener("keydown", (e) => {
    // 角色切换快捷键 1-9（非编辑状态）
    if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key >= "1" && e.key <= "9") {
      const idx = parseInt(e.key) - 1;
      // P3-1 3D-only：优先切换外部 3D角色
      const extMgr = window.__ds?.externalCharacters;
      if (extMgr && extMgr.size > 0) {
        const entries = extMgr.getAll();
        if (idx < entries.length) {
          e.preventDefault();
          extMgr.setActive(entries[idx].id);
          if (selected) selectJoint(null);
        }
        return;
      }
      const api = window.DS_FigureAPI;
      if (!api) return;
      const chars = Array.from(api.getAllCharacters().values());
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
