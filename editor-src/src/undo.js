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
 * 获取 ExternalCharacterManager 轻量快照（3D-only 路径）
 * 只序列化 transform + ikTarget 世界位置，不重新加载模型
 * @returns {Object|null} { v:3, chars: { id: { id, type, name, transform, ikTargets } }, activeId }
 */
function externalCharSnapshot() {
  const manager = window.__ds?.externalCharacters;
  if (!manager || typeof manager.getAll !== "function") return null;
  const entries = manager.getAll();
  if (!entries || entries.length === 0) return null;

  const chars = {};
  for (const entry of entries) {
    if (!entry || !entry.id || !entry.model) continue;
    const transform = {
      position: entry.model.position.toArray(),
      quaternion: entry.model.quaternion.toArray(),
      scale: entry.model.scale.toArray(),
    };
    const ikTargets = {};
    if (entry.ikTargets) {
      for (const [chainName, t] of Object.entries(entry.ikTargets)) {
        if (!t) continue;
        ikTargets[chainName] = {
          target: t.target ? t.target.position.toArray() : null,
          pole: t.pole ? t.pole.position.toArray() : null,
        };
      }
    }
    chars[entry.id] = {
      id: entry.id,
      type: entry.type,
      name: entry.name,
      transform,
      ikTargets,
      // P1-fix：骨骼姿势快照（骨骼编辑模式 Ctrl+Z 支持），按原始骨骼名记录
      bones: _snapshotBones(entry),
    };
  }
  return {
    v: 3,
    chars,
    activeId: manager.getActive?.()?.id ?? manager.activeCharacterId ?? null,
  };
}

/**
 * P1-fix：快照 entry 全部骨骼的局部旋转/位置（按骨骼名索引）
 * @returns {Object<string,{rotation:number[],position:number[]}>}
 */
function _snapshotBones(entry) {
  const bones = {};
  for (const b of entry.allBones || []) {
    if (!b?.isBone) continue;
    bones[b.name] = {
      rotation: [b.rotation.x, b.rotation.y, b.rotation.z],
      position: [b.position.x, b.position.y, b.position.z],
    };
  }
  return bones;
}

/**
 * 应用 ExternalCharacterManager 快照（3D-only 路径）
 */
function externalCharRestore(snap) {
  if (!snap || snap.v !== 3 || !snap.chars) return;
  const manager = window.__ds?.externalCharacters;
  if (!manager || typeof manager.get !== "function") return;

  for (const [id, charData] of Object.entries(snap.chars)) {
    const entry = manager.get(id);
    if (!entry || !entry.model) continue;

    // 恢复模型 transform
    const tr = charData.transform;
    if (tr) {
      if (Array.isArray(tr.position)) entry.model.position.fromArray(tr.position);
      if (Array.isArray(tr.quaternion)) entry.model.quaternion.fromArray(tr.quaternion);
      if (Array.isArray(tr.scale)) entry.model.scale.fromArray(tr.scale);
      entry.model.updateMatrixWorld(true);
    }

    // 恢复 IK targets 世界位置
    if (charData.ikTargets && entry.ikTargets) {
      for (const [chainName, pos] of Object.entries(charData.ikTargets)) {
        const t = entry.ikTargets[chainName];
        if (!t) continue;
        if (Array.isArray(pos.target) && t.target) t.target.position.fromArray(pos.target);
        if (Array.isArray(pos.pole) && t.pole) t.pole.position.fromArray(pos.pole);
      }
      entry._ikDirty = true; // 下一帧补解 IK
    }

    // P1-fix：恢复骨骼姿势（最后执行——applyPoseBones 内含 syncIKFromBones，
    // 会从骨骼重新推导 IK target，保证骨骼↔IK 一致）
    if (charData.bones) {
      const be = window.__ds?.boneEditor;
      if (be?.applyPoseBones) {
        try {
          be.applyPoseBones(charData.bones, { entry, positions: "all" });
        } catch (e) {
          console.warn("[undo] 骨骼姿势恢复失败:", e);
        }
      } else {
        // 兜底：boneEditor 未挂载时直接写回
        for (const b of entry.allBones || []) {
          const rec = charData.bones[b.name];
          if (!rec) continue;
          if (Array.isArray(rec.rotation)) b.rotation.set(+rec.rotation[0] || 0, +rec.rotation[1] || 0, +rec.rotation[2] || 0);
          if (Array.isArray(rec.position)) b.position.set(+rec.position[0] || 0, +rec.position[1] || 0, +rec.position[2] || 0);
        }
        entry._skipIKFrames = 60;
      }
    }
  }

  // 恢复活动角色
  if (snap.activeId && typeof manager.setActive === "function") {
    manager.setActive(snap.activeId);
  }
}

/**
 * 获取全部角色完整快照
 * P2-fix：火柴人（DS_FigureAPI）已删除，3D-only 恒走 ExternalCharacterManager v3 路径
 * @returns {Object|null} { v:3, chars, activeId }
 */
function multiCharSnapshot() {
  return externalCharSnapshot();
}

/**
 * 应用多角色快照
 */
function multiCharRestore(snap) {
  if (!snap || !snap.chars) return;
  if (snap.v === 3) {
    externalCharRestore(snap);
    return;
  }
  // P2-fix：v:2 火柴人快照格式已不支持（3D-only）
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
  // 3D-only 外部角色：自动快照
  if (window.__ds?.externalCharacters) {
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

  if (window.__ds?.externalCharacters && snap && snap.v === 3) {
    // 3D-only: 保存当前状态到 redo
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

  if (window.__ds?.externalCharacters && snap && snap.v === 3) {
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
