/**
 * protocol.js — window.postMessage 协议处理（M2 扩展）
 */
import { getCamera } from "./scene.js";
import { decodeSceneGz, applyJoints } from "./serialization.js";
import { setFocalLength } from "./camera-settings.js";

let exportW = 512;
let exportH = 768;

/** 父窗口 origin（setupProtocol 时解析），用于 postMessage 安全校验 */
let _parentOrigin = null;

/** M2 场景 JSON（序列化多相机、道具等，兼容 M1） */
let sceneJSON = null;

export function getExportSize() {
  return [exportW, exportH];
}

export function getSceneJSON() {
  return sceneJSON;
}

export function setSceneJSON(v) {
  sceneJSON = v;
}

/**
 * 注册消息监听。回调在 init 成功后调用。
 * @param {Function} onInit - (w, h, jointsArr, sceneData) => void
 *   sceneData: { focalLength?, cameras?, props? }  (M2 扩展)
 */
export function setupProtocol(onInit) {
  // 从 referrer 安全解析父窗口 origin（避免 postMessage "*" 通配符风险）
  try {
    if (document.referrer) {
      const refUrl = new URL(document.referrer);
      _parentOrigin = refUrl.origin;
    }
  } catch { /* referrer 不可解析时回退同源校验 */ }
  if (!_parentOrigin) _parentOrigin = location.origin;

  window.addEventListener("message", (ev) => {
    // P2-fix：同源或已解析的父窗口 origin 才受理（原只校验同源，与 referrer 解析自相矛盾）
    if (ev.origin !== location.origin && ev.origin !== _parentOrigin) return;
    const data = ev.data;
    if (!data || data.type !== "init") return;
    const p = data.payload || {};
    const w = parseInt(p.width, 10);
    const h = parseInt(p.height, 10);
    if (w > 0 && h > 0) {
      exportW = w;
      exportH = h;
    }

    // M2: scene JSON (optional)
    if (p.sceneJSON) {
      try {
        sceneJSON = typeof p.sceneJSON === "string"
          ? JSON.parse(p.sceneJSON)
          : p.sceneJSON;
      } catch (e) {
        console.warn("[3D导演台] sceneJSON 解析失败:", e);
        sceneJSON = null;
      }
    }

    let fl = undefined;
    let jointsArr = null;
    let decodedScene = null;

    if (p.sceneGz) {
      try {
        decodedScene = decodeSceneGz(p.sceneGz);
        if (decodedScene) {
          if (decodedScene.focalLength !== undefined) fl = decodedScene.focalLength;
          jointsArr = decodedScene.joints;
        }
      } catch (err) {
        console.warn("[3D导演台] sceneGz 解析失败:", err);
      }
    }

    onInit(w, h, jointsArr, sceneJSON, decodedScene);

    // 应用焦距
    if (fl !== undefined) setFocalLength(fl);
  });
}

export function announceReady() {
  const origin = _parentOrigin || location.origin;
  // 暴露给 main.js 等其他模块使用
  if (window.__ds) window.__ds._protocolOrigin = origin;
  window.parent.postMessage({ type: "ready" }, origin);
}

/** 父窗口 origin（export.js 等发送 postMessage 时统一使用，禁止 "*" 通配） */
export function getParentOrigin() {
  return _parentOrigin || location.origin;
}
