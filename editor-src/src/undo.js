/**
 * undo.js — Undo/Redo 栈（多角色快照，上限100步）
 *
 * M1 兼容：单参数 snapshot(joints) / restore(joints, snap) 保持不变
 * M2 新增：pushUndo(null) 自动从 CharacterManager 获取全部角色状态
 */
import { JOINT_EN } from "./constants.js";

const MAX_STACK = 100;

let undoStack = [];
let redoStack = [];

/**
 * 获取当前关节快照（向后兼容 M1）
 * @param {THREE.Mesh[]} joints
 * @returns {number[][]}
 */
export function snapshot(joints) {
  return joints.map((j) => [j.position.x, j.position.y, j.position.z]);
}

/**
 * 将快照应用到关节（向后兼容 M1）
 * @param {THREE.Mesh[]} joints
 * @param {number[][]} snap
 */
export function restore(joints, snap) {
  snap.forEach((p, i) => {
    if (joints[i] && p && p.length >= 3) {
      joints[i].position.set(p[0], p[1], p[2]);
    }
  });
}

/**
 * 获取全部角色完整快照（M2 多角色）
 * @returns {Object} { v:2, chars: { id: { joints, ikTargets } }, activeId }
 */
function multiCharSnapshot() {
  const api = window.DS_FigureAPI;
  if (!api || !api.getCharacterCount()) return null;

  const chars = {};
  const allChars = api.getAllCharacters();
  for (const [id, char] of allChars) {
    const joints = [];
    for (let i = 0; i < 18; i++) {
      const sp = char.jointSpheres[i];
      joints.push([sp.position.x, sp.position.y, sp.position.z]);
    }
    const ikTargets = {};
    for (const [chainName, state] of Object.entries(char.ikState)) {
      ikTargets[chainName] = {
        target: [
          state.target.position.x,
          state.target.position.y,
          state.target.position.z,
        ],
        pole: [
          state.pole.position.x,
          state.pole.position.y,
          state.pole.position.z,
        ],
      };
    }
    chars[id] = { joints, ikTargets };
  }
  return {
    v: 2,
    chars,
    activeId: api.getActiveCharacter()?.id,
  };
}

/**
 * 应用多角色快照
 */
function multiCharRestore(snap) {
  if (!snap || snap.v !== 2 || !snap.chars) return;
  const api = window.DS_FigureAPI;
  if (!api) return;

  for (const [id, charData] of Object.entries(snap.chars)) {
    const char = api.getCharacter(id);
    if (!char) continue;

    // 恢复关节球位置
    if (charData.joints) {
      for (let i = 0; i < 18 && i < charData.joints.length; i++) {
        const p = charData.joints[i];
        if (p && p.length >= 3) {
          char.jointSpheres[i].position.set(p[0], p[1], p[2]);
        }
      }
    }

    // 恢复 IK targets 位置
    if (charData.ikTargets) {
      for (const [chainName, pos] of Object.entries(charData.ikTargets)) {
        const state = char.ikState[chainName];
        if (state) {
          if (pos.target) state.target.position.set(pos.target[0], pos.target[1], pos.target[2]);
          if (pos.pole) state.pole.position.set(pos.pole[0], pos.pole[1], pos.pole[2]);
        }
      }
    }
  }

  // 恢复活动角色
  if (snap.activeId) {
    api.setActive(snap.activeId);
  }
}

/**
 * 压栈（变动前调用）。会清空 redo 栈。
 *
 * M1 兼容调用：pushUndo(joints) 传入关节数组
 * M2 调用：pushUndo(null) 自动获取全部角色快照
 *
 * @param {THREE.Mesh[]|null} joints
 */
export function pushUndo(joints) {
  const api = window.DS_FigureAPI;

  if (api) {
    // M2: 多角色快照
    const snap = multiCharSnapshot();
    if (snap) {
      undoStack.push(snap);
      if (undoStack.length > MAX_STACK) undoStack.shift();
      redoStack = [];
      return;
    }
  }

  // 回退到 M1 单角色快照
  if (joints && joints.length >= 18) {
    undoStack.push(snapshot(joints));
    if (undoStack.length > MAX_STACK) undoStack.shift();
    redoStack = [];
  }
}

/**
 * Undo 操作
 * @param {THREE.Mesh[]|null} joints — M1 兼容
 * @returns {boolean} 是否成功
 */
export function performUndo(joints) {
  if (undoStack.length === 0) return false;
  const snap = undoStack.pop();

  const api = window.DS_FigureAPI;

  if (api && snap && snap.v === 2) {
    // M2: 保存当前状态到 redo
    const cur = multiCharSnapshot();
    if (cur) redoStack.push(cur);
    multiCharRestore(snap);
    return true;
  }

  // M1 回退
  if (joints && joints.length >= 18 && Array.isArray(snap)) {
    redoStack.push(snapshot(joints));
    restore(joints, snap);
    return true;
  }

  // 如果 snap 是数组但没传 joints，尝试用 __ds
  if (Array.isArray(snap) && window.__ds?.joints) {
    redoStack.push(snapshot(window.__ds.joints));
    restore(window.__ds.joints, snap);
    return true;
  }

  // 放回去
  undoStack.push(snap);
  return false;
}

/**
 * Redo 操作
 * @param {THREE.Mesh[]|null} joints — M1 兼容
 * @returns {boolean} 是否成功
 */
export function performRedo(joints) {
  if (redoStack.length === 0) return false;
  const snap = redoStack.pop();

  const api = window.DS_FigureAPI;

  if (api && snap && snap.v === 2) {
    const cur = multiCharSnapshot();
    if (cur) undoStack.push(cur);
    multiCharRestore(snap);
    return true;
  }

  if (joints && joints.length >= 18 && Array.isArray(snap)) {
    undoStack.push(snapshot(joints));
    restore(joints, snap);
    return true;
  }

  if (Array.isArray(snap) && window.__ds?.joints) {
    undoStack.push(snapshot(window.__ds.joints));
    restore(window.__ds.joints, snap);
    return true;
  }

  redoStack.push(snap);
  return false;
}

/** 栈大小查询 */
export function getUndoDepth() {
  return undoStack.length;
}

export function getRedoDepth() {
  return redoStack.length;
}

/** 清空栈 */
export function clearHistory() {
  undoStack = [];
  redoStack = [];
}

// 暴露给测试
export function __getStacks() {
  return { undoStack, redoStack };
}
