import { app } from "../../scripts/app.js";

const OVERLAY_ID = "director-stage-overlay";

/** 在节点上按名称查找 widget，找不到返回 null（容错） */
function findWidget(node, name) {
  if (!node || !Array.isArray(node.widgets)) return null;
  return node.widgets.find((w) => w && w.name === name) || null;
}

/** 隐藏 widget（不占布局空间） */
function hideWidget(w) {
  if (!w) return;
  w.type = "hidden";
  w.computeSize = () => [0, -4];
}

/** 打开全屏导演台编辑器 */
function openEditor(node) {
  // 若已有旧 overlay，先彻底清理（含事件监听），防泄漏
  const old = document.getElementById(OVERLAY_ID);
  if (old) {
    if (typeof old.__dsCleanup === "function") {
      old.__dsCleanup();
    } else {
      old.remove();
    }
  }

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.6);display:flex;";

  const iframe = document.createElement("iframe");
  iframe.src = "/director_stage/editor/index.html";
  iframe.style.cssText =
    "flex:1;margin:2%;border:none;border-radius:12px;background:#1e1e1e;";
  overlay.appendChild(iframe);

  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    // 关闭时必须移除监听，防止内存泄漏
    window.removeEventListener("message", onMessage);
    window.removeEventListener("keydown", onKeyDown);
    overlay.remove();
  };

  const onKeyDown = (e) => {
    if (e.key === "Escape") close();
  };

  const onMessage = (event) => {
    // 仅处理来自本编辑器 iframe 的消息
    if (!iframe.contentWindow || event.source !== iframe.contentWindow) return;
    const data = event.data;
    if (!data || typeof data.type !== "string") return;

    if (data.type === "ready") {
      const sceneGzWidget = findWidget(node, "scene_gz");
      const widthWidget = findWidget(node, "width");
      const heightWidget = findWidget(node, "height");
      iframe.contentWindow.postMessage(
        {
          type: "init",
          payload: {
            sceneGz: (sceneGzWidget && sceneGzWidget.value) || "",
            width: widthWidget ? widthWidget.value : undefined,
            height: heightWidget ? heightWidget.value : undefined,
          },
        },
        "*"
      );
    } else if (data.type === "exportDone") {
      const payload = data.payload || {};
      const sceneGzWidget = findWidget(node, "scene_gz");
      const manifestWidget = findWidget(node, "manifest");
      if (sceneGzWidget) sceneGzWidget.value = payload.sceneGz || "";
      if (manifestWidget) {
        try {
          manifestWidget.value = JSON.stringify(
            payload.manifest === undefined ? {} : payload.manifest
          );
        } catch (err) {
          manifestWidget.value = "{}";
        }
      }
      if (app.graph) app.graph.setDirtyCanvas(true);
      close();
    } else if (data.type === "cancel") {
      close();
    }
  };

  // 挂到 overlay 上，便于下次打开前统一清理
  overlay.__dsCleanup = close;

  window.addEventListener("message", onMessage);
  window.addEventListener("keydown", onKeyDown);

  document.body.appendChild(overlay);
}

app.registerExtension({
  name: "Comfy.DirectorStage",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!nodeData || nodeData.name !== "DirectorStage") return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = onNodeCreated
        ? onNodeCreated.apply(this, arguments)
        : undefined;

      this.addWidget("button", "🎬 打开导演台", null, () => openEditor(this));

      // 隐藏序列化用的内部 widget（容错：不存在则跳过）
      hideWidget(findWidget(this, "scene_gz"));
      hideWidget(findWidget(this, "manifest"));

      return result;
    };
  },
});
