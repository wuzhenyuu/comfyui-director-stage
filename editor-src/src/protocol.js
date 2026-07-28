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

/** P3-10：是否已收到合法 init 消息（供超时告警判断） */
let _initReceived = false;

/**
 * P3-10：N 秒未收到 init 时给出可见告警。
 * 场景：父页面 Referrer-Policy: no-referrer 且与编辑器跨源部署时，
 * document.referrer 为空 → _parentOrigin 回退 location.origin →
 * 父窗口 init 消息被 origin 校验静默丢弃，编辑器永远停在等待状态且无任何提示。
 */
function _armInitTimeoutWarning(timeoutMs = 8000) {
  setTimeout(() => {
    if (_initReceived) return;
    if (window.parent === window) return; // 独立打开（非 iframe 嵌入）属合法用法，不告警
    const msg = "⚠️ 3D导演台：" + (timeoutMs / 1000) + " 秒未收到父窗口 init 消息。" +
      "若父页面跨源部署且设置了 Referrer-Policy: no-referrer，origin 校验会静默丢弃 init——" +
      "请将编辑器与父页面同源部署，或为父页面补充 referrer。";
    console.warn("[3D导演台]", msg);
    const show = () => {
      if (_initReceived || !document.body) return;
      const div = document.createElement("div");
      div.id = "ds-init-timeout-warning";
      div.textContent = msg;
      div.style.cssText =
        "position:fixed;top:0;left:0;right:0;z-index:99999;padding:8px 12px;" +
        "background:#5a3b00;color:#ffd980;font-size:12px;line-height:1.5;" +
        "border-bottom:1px solid #8a6d1f;text-align:center;";
      document.body.appendChild(div);
    };
    if (document.body) show();
    else document.addEventListener("DOMContentLoaded", show, { once: true });
  }, timeoutMs);
}

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

  _armInitTimeoutWarning();

  window.addEventListener("message", (ev) => {
    // P2-fix：同源或已解析的父窗口 origin 才受理（原只校验同源，与 referrer 解析自相矛盾）
    if (ev.origin !== location.origin && ev.origin !== _parentOrigin) return;
    const data = ev.data;
    if (!data || data.type !== "init") return;
    _initReceived = true;
    // P3-10：收到 init 后移除可能已显示的超时告警
    document.getElementById("ds-init-timeout-warning")?.remove();
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
