/**
 * serialization.js — 场景序列化（gzip + base64），向后兼容 M0 旧格式
 *
 * M0 格式：[[x,y,z], ...18 个关节] （纯数组）
 * M1 格式：{ "v": 1, "joints": [[x,y,z],...], "focalLength": 35 }
 */
import { gzip, ungzip } from "pako";
import { SCENE_VERSION } from "./constants.js";

/**
 * 编码 sceneGz
 * @param {THREE.Mesh[]} joints
 * @param {number} [focalLength=35]
 * @returns {string} base64
 */
export function encodeSceneGz(joints, focalLength = 35) {
  const arr = joints.map((j) => [
    +j.position.x.toFixed(4),
    +j.position.y.toFixed(4),
    +j.position.z.toFixed(4),
  ]);
  const payload = { v: SCENE_VERSION, joints: arr, focalLength };
  const gz = gzip(JSON.stringify(payload));
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < gz.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, gz.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * 解码 sceneGz（兼容 M0 旧格式）
 * @param {string} b64
 * @returns {{ joints: number[][], focalLength?: number } | null}
 */
export function decodeSceneGz(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const decoded = JSON.parse(new TextDecoder().decode(ungzip(u8)));

  let joints = null;
  let focalLength;

  if (decoded && typeof decoded.v === "number") {
    // M1+ 格式
    joints = decoded.joints;
    focalLength = decoded.focalLength;
  } else if (Array.isArray(decoded)) {
    // M0 旧格式：纯数组
    joints = decoded;
  }
  if (!Array.isArray(joints) || joints.length < 18) return null;
  return { joints, focalLength, v: decoded.v };
}

/**
 * 应用解码结果到关节位置
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
