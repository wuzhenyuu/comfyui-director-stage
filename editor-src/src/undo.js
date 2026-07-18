/**
 * undo.js — Undo/Redo 栈（18关节快照，上限50）
 */
const MAX_STACK = 50;

let undoStack = [];
let redoStack = [];

/**
 * 获取当前18关节的快照（每关节 [x,y,z]）
 * @param {THREE.Mesh[]} joints
 * @returns {number[][]}
 */
export function snapshot(joints) {
  return joints.map((j) => [j.position.x, j.position.y, j.position.z]);
}

/**
 * 将快照应用到关节（恢复位置）
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
 * 压栈（变动前调用）。会清空 redo 栈。
 * @param {THREE.Mesh[]} joints
 */
export function pushUndo(joints) {
  undoStack.push(snapshot(joints));
  if (undoStack.length > MAX_STACK) undoStack.shift();
  redoStack = [];
}

/**
 * Undo 操作
 * @param {THREE.Mesh[]} joints
 * @returns {boolean} 是否成功
 */
export function performUndo(joints) {
  if (undoStack.length === 0) return false;
  redoStack.push(snapshot(joints));
  restore(joints, undoStack.pop());
  return true;
}

/**
 * Redo 操作
 * @param {THREE.Mesh[]} joints
 * @returns {boolean} 是否成功
 */
export function performRedo(joints) {
  if (redoStack.length === 0) return false;
  undoStack.push(snapshot(joints));
  restore(joints, redoStack.pop());
  return true;
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
