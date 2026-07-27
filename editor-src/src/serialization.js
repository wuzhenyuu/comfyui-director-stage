/**
 * serialization.js — 场景序列化（gzip + base64）
 *
 * M0 格式：[[x,y,z], ...18 个关节] （纯数组）
 * M1 格式：{ "v": 1, "joints": [[x,y,z],...], "focalLength": 35 }
 * M2 格式：{ "v": 2, "characters": [{id,name,joints,ikTargets,visible}], "activeCharId", "focalLength" }
 *
 * 向后兼容 M0/M1 格式
 */
import { gzip, ungzip } from "pako";

/**
 * 编码 sceneGz
 * P2-fix：火柴人（CharacterManager/V2）编码路径已删除，3D-only 仅走 M1 数组路径
 * （encodeCurrentSceneGz 始终传关节数组；DS_FigureAPI 恒不存在）
 *
 * @param {THREE.Mesh[]} arg1 - 关节数组
 * @param {number} [focalLength=35]
 * @returns {string} base64
 */
export function encodeSceneGz(arg1, focalLength = 35) {
  if (Array.isArray(arg1)) {
    return encodeSceneGzM1(arg1, focalLength);
  }
  return null;
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

