/**
 * protocol.js — window.postMessage 协议处理
 */
import { getCamera } from "./scene.js";
import { decodeSceneGz, applyJoints } from "./serialization.js";
import { setFocalLength } from "./camera-settings.js";

let exportW = 512;
let exportH = 768;

export function getExportSize() {
  return [exportW, exportH];
}

/**
 * 注册消息监听。回调在 init 成功后调用。
 * @param {Function} onInit - (w, h, sceneGz, focalLength) => void
 */
export function setupProtocol(onInit) {
  window.addEventListener("message", (ev) => {
    // M1 修复：校验 origin
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
    let fl = undefined;
    if (p.sceneGz) {
      try {
        const decoded = decodeSceneGz(p.sceneGz);
        if (decoded) {
          if (decoded.focalLength !== undefined) fl = decoded.focalLength;
          onInit(w, h, decoded.joints);
        } else {
          onInit(w, h, null);
        }
      } catch (err) {
        console.warn("[3D导演台] sceneGz 解析失败:", err);
        onInit(w, h, null);
      }
    } else {
      onInit(w, h, null);
    }
    // 应用焦距（如果 sceneGz 中有则用它，否则保持默认35mm）
    if (fl !== undefined) setFocalLength(fl);
  });
}

export function announceReady() {
  window.parent.postMessage({ type: "ready" }, "*");
}
