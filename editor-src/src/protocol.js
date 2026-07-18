/**
 * protocol.js — window.postMessage 协议处理（M2 扩展）
 */
import { getCamera } from "./scene.js";
import { decodeSceneGz, applyJoints } from "./serialization.js";
import { setFocalLength } from "./camera-settings.js";

let exportW = 512;
let exportH = 768;

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
  window.addEventListener("message", (ev) => {
    if (ev.origin !== location.origin) return;
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

    if (p.sceneGz) {
      try {
        const decoded = decodeSceneGz(p.sceneGz);
        if (decoded) {
          if (decoded.focalLength !== undefined) fl = decoded.focalLength;
          jointsArr = decoded.joints;
        }
      } catch (err) {
        console.warn("[3D导演台] sceneGz 解析失败:", err);
      }
    }

    onInit(w, h, jointsArr, sceneJSON);

    // 应用焦距
    if (fl !== undefined) setFocalLength(fl);
  });
}

export function announceReady() {
  window.parent.postMessage({ type: "ready" }, "*");
}
