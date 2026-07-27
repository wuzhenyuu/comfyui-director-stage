/**
 * serialization.js — 场景序列化（gzip + base64）
 *
 * M0 格式：[[x,y,z], ...18 个关节] （纯数组）
 * M1 格式：{ "v": 1, "joints": [[x,y,z],...], "focalLength": 35 }
 * M2 格式：{ "v": 2, "characters": [{id,name,joints,ikTargets,visible}], "activeCharId", "focalLength" }
 *
 * 向后兼容 M0/M1 格式
 */
import * as THREE from "three";
import { gzip, ungzip } from "pako";
import { SCENE_VERSION, JOINT_EN, IK_CHAINS } from "./constants.js";

/**
 * 编码 sceneGz
 *
 * 双签名：
 *   encodeSceneGz(CharacterManager, focalLength) — M2 多角色
 *   encodeSceneGz(joints:THREE.Mesh[], focalLength)  — M1 单角色（向后兼容）
 *
 * @param {*} arg1 - CharacterManager 或关节数组
 * @param {number} [focalLength=35]
 * @returns {string} base64
 */
export function encodeSceneGz(arg1, focalLength = 35) {
  // 检测：如果是数组 → M1 兼容
  if (Array.isArray(arg1)) {
    return encodeSceneGzM1(arg1, focalLength);
  }
  // 检测：如果有 characters Map → CharacterManager
  const manager = arg1;
  const hasMap = manager && typeof manager.characters === "object" && typeof manager.characters.get === "function";
  if (!hasMap) {
    // 尝试从 window 获取
    const api = typeof window !== "undefined" ? window.DS_FigureAPI : null;
    if (api) return encodeSceneGzV2(api.getManager(), focalLength);
    return null;
  }
  return encodeSceneGzV2(manager, focalLength);
}

/**
 * M2 v2 格式编码
 */
function encodeSceneGzV2(manager, focalLength) {
  const chars = [];
  if (manager) {
    for (const [id, char] of manager.characters) {
      // 从骨架读取关节世界坐标
      const joints = [];
      for (let i = 0; i < 18; i++) {
        const bone = char.allBones[i];
        if (bone) {
          const pos = new THREE.Vector3();
          bone.getWorldPosition(pos);
          joints.push([
            Number.isFinite(pos.x) ? +pos.x.toFixed(4) : 0,
            Number.isFinite(pos.y) ? +pos.y.toFixed(4) : 0,
            Number.isFinite(pos.z) ? +pos.z.toFixed(4) : 0,
          ]);
        } else {
          joints.push([0, 0, 0]);
        }
      }

      // IK targets 位置
      const ikTargets = {};
      for (const [chainName, state] of Object.entries(char.ikState)) {
        const safeCoord = (v) => Number.isFinite(v) ? +v.toFixed(4) : 0;
        ikTargets[chainName] = {
          target: [
            safeCoord(state.target.position.x),
            safeCoord(state.target.position.y),
            safeCoord(state.target.position.z),
          ],
          pole: [
            safeCoord(state.pole.position.x),
            safeCoord(state.pole.position.y),
            safeCoord(state.pole.position.z),
          ],
        };
      }

      chars.push({
        id: char.id,
        name: char.name,
        joints,
        ikTargets,
        visible: char.visible,
      });
    }
  }

  // 收集场景设置（从全局 __ds.sceneSettings，由 scene-settings-panel 注入）
  const sceneSettings = (typeof window !== "undefined" && window.__ds?.sceneSettings)
    ? window.__ds.sceneSettings : null;

  const payload = {
    v: SCENE_VERSION,
    characters: chars,
    activeCharId: manager ? manager.activeCharacterId : null,
    focalLength,
    scene: sceneSettings,
  };

  const gz = gzip(JSON.stringify(payload));
  // 安全编码：逐字节拼接，避免 String.fromCharCode.apply 栈溢出
  let bin = "";
  for (let i = 0; i < gz.length; i++) {
    bin += String.fromCharCode(gz[i]);
  }
  return btoa(bin);
}

/**
 * M1 兼容编码（单角色，旧 API）
 * @param {THREE.Mesh[]} joints
 * @param {number} [focalLength=35]
 * @returns {string} base64
 */
export function encodeSceneGzM1(joints, focalLength = 35) {
  const safeCoord = (v) => Number.isFinite(v) ? +v.toFixed(4) : 0;
  const arr = joints.map((j) => [
    safeCoord(j.position.x),
    safeCoord(j.position.y),
    safeCoord(j.position.z),
  ]);
  const payload = { v: 1, joints: arr, focalLength };
  const gz = gzip(JSON.stringify(payload));
  let bin = "";
  for (let i = 0; i < gz.length; i++) {
    bin += String.fromCharCode(gz[i]);
  }
  return btoa(bin);
}

/**
 * 解码 sceneGz（兼容 M0/M1/M2）
 * @param {string} b64
 * @returns {Object | null} { v, characters, joints(legacy), focalLength, activeCharId }
 */
export function decodeSceneGz(b64) {
  try {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const decoded = JSON.parse(new TextDecoder().decode(ungzip(u8)));

  if (!decoded) return null;

  // M2 格式
  if (decoded.v >= 2 && Array.isArray(decoded.characters)) {
    return {
      v: decoded.v,
      characters: decoded.characters,
      activeCharId: decoded.activeCharId,
      focalLength: decoded.focalLength,
      joints: decoded.characters.length > 0 ? decoded.characters[0].joints : null,
    };
  }

  // M1 格式
  if (decoded.v === 1 && Array.isArray(decoded.joints)) {
    return {
      v: 1,
      joints: decoded.joints,
      focalLength: decoded.focalLength,
      characters: null,
    };
  }

  // M0 纯数组格式
  if (Array.isArray(decoded)) {
    return { v: 0, joints: decoded, characters: null };
  }

  return null;
  } catch (err) {
    console.error("[3D导演台] sceneGz 解码失败:", err);
    return null;
  }
}

/**
 * 应用解码结果到关节（M1 兼容，用于直接修改 mesh 位置）
 * @param {THREE.Mesh[]} joints
 * @param {number[][]} arr
 */
export function applyJoints(joints, arr) {
  arr.forEach((p, i) => {
    if (joints[i] && Array.isArray(p) && p.length >= 3) {
      joints[i].position.set(+p[0], +p[1], +p[2]);
    }
  });
}

/**
 * 应用 M2 解码结果到 CharacterManager
 * @param {import("./figure.js").CharacterManager} manager
 * @param {Object} decoded - decodeSceneGz 返回值
 */
export function applyDecodedToManager(manager, decoded) {
  if (!manager || !decoded) return false;

  // 清空现有角色
  const existingIds = Array.from(manager.characters.keys());
  for (const id of existingIds) {
    manager.remove(id);
  }

  if (decoded.v >= 2 && decoded.characters) {
    // M2: 重建所有角色
    for (const charData of decoded.characters) {
      const char = manager.create(charData.id, charData.name);
      if (!char) continue;

      char.visible = charData.visible !== false;

      // 恢复关节位置：设置骨骼变换（简单方式：直接设置关节球位置给 IK 参考）
      // 对于有 IK 的骨架，直接设关节球位置，update 循环里 IK 会调整
      if (charData.joints) {
        for (let i = 0; i < 18 && i < charData.joints.length; i++) {
          const p = charData.joints[i];
          if (p && p.length >= 3) {
            char.jointSpheres[i].position.set(+p[0], +p[1], +p[2]);
          }
        }
      }

      // 恢复 IK target 位置
      if (charData.ikTargets) {
        for (const [chainName, pos] of Object.entries(charData.ikTargets)) {
          const state = char.ikState[chainName];
          if (state && pos.target) {
            state.target.position.set(+pos.target[0], +pos.target[1], +pos.target[2]);
            if (pos.pole) {
              state.pole.position.set(+pos.pole[0], +pos.pole[1], +pos.pole[2]);
            }
          }
        }
      }
    }

    // 恢复活动角色
    if (decoded.activeCharId && manager.characters.has(decoded.activeCharId)) {
      manager.setActive(decoded.activeCharId);
    }
    return true;
  }

  if (decoded.v <= 1 && decoded.joints) {
    // M0/M1: 创建单个默认角色
    const char = manager.createDefault();
    if (char && decoded.joints) {
      for (let i = 0; i < 18 && i < decoded.joints.length; i++) {
        const p = decoded.joints[i];
        if (p && p.length >= 3) {
          char.jointSpheres[i].position.set(+p[0], +p[1], +p[2]);
        }
      }
    }
    return true;
  }

  return false;
}
