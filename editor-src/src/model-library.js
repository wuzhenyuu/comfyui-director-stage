/**
 * model-library.js — 内置模型库面板
 * 
 * 从 /director_stage/models/index.json 读取可用模型列表，
 * 一键添加到场景（通过 GLTFLoader 加载）。
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

/**
 * @param {import("./props.js").PropManager} propManager
 * @param {Function} onToast - (msg, isErr) => void
 * @returns {HTMLElement} panel DOM element
 */
export function createModelLibraryPanel(propManager, onToast) {
  const panel = document.createElement("div");
  panel.style.cssText = "display:flex;flex-direction:column;height:100%;overflow-y:auto;";

  // Header
  const header = document.createElement("div");
  header.textContent = "📦 模型库";
  header.style.cssText = "padding:12px 14px;font-weight:600;font-size:13px;border-bottom:1px solid #2a2f3d;";
  panel.appendChild(header);

  // Model list container
  const list = document.createElement("div");
  list.id = "model-library-list";
  list.style.cssText = "flex:1;overflow-y:auto;padding:4px 0;";
  list.innerHTML = `<div style="padding:20px;text-align:center;color:#6a7080;font-size:12px;">正在加载模型库…</div>`;
  panel.appendChild(list);

  // Load model index
  loadModelLibrary(list);

  return panel;

  async function loadModelLibrary(container) {
    try {
      const res = await fetch("/director_stage/models/index.json");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const { models } = await res.json();
      if (!models || models.length === 0) {
        container.innerHTML = `<div style="padding:20px;text-align:center;color:#6a7080;font-size:12px;">模型库为空</div>`;
        return;
      }

      container.innerHTML = "";
      models.forEach((model) => {
        const card = createModelCard(model);
        container.appendChild(card);
      });
    } catch (err) {
      console.warn("[模型库] 加载失败:", err);
      container.innerHTML = `<div style="padding:20px;text-align:center;color:#6a7080;font-size:12px;">模型库不可用<br/><small>${err.message}</small></div>`;
    }
  }

  function createModelCard(model) {
    const card = document.createElement("div");
    card.style.cssText = [
      "margin:6px 10px;padding:8px 10px;background:#1a1d26;border-radius:6px;",
      "border:1px solid #2a2f3d;cursor:pointer;transition:background 0.15s;",
    ].join("");
    card.addEventListener("mouseenter", () => (card.style.background = "#252a36"));
    card.addEventListener("mouseleave", () => (card.style.background = "#1a1d26"));

    const nameRow = document.createElement("div");
    nameRow.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;";
    const nameEl = document.createElement("span");
    nameEl.style.cssText = "font-size:13px;font-weight:500;color:#d0d6e0;";
    nameEl.textContent = model.name;

    const addBtn = document.createElement("button");
    addBtn.textContent = "➕ 添加";
    addBtn.style.cssText = [
      "padding:3px 8px;font-size:11px;background:#2f9e63;color:#fff;",
      "border:none;border-radius:4px;cursor:pointer;",
    ].join("");
    addBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      loadAndAddModel(model, addBtn);
    });

    nameRow.appendChild(nameEl);
    nameRow.appendChild(addBtn);

    const desc = document.createElement("div");
    desc.style.cssText = "font-size:11px;color:#7a8090;line-height:1.4;";
    desc.textContent = model.description || "";

    card.appendChild(nameRow);
    card.appendChild(desc);
    return card;
  }

  async function loadAndAddModel(model, btn) {
    const origText = btn.textContent;
    btn.textContent = "⏳";
    btn.disabled = true;
    try {
      const url = `/director_stage/models/${model.file}`;
      const loader = new GLTFLoader();
      const gltf = await new Promise((resolve, reject) => {
        loader.load(url, resolve, undefined, (err) =>
          reject(new Error(err.message || "加载失败"))
        );
      });

      const sceneModel = gltf.scene;
      const bbox = new THREE.Box3().setFromObject(sceneModel);
      const size = new THREE.Vector3();
      bbox.getSize(size);
      const maxDim = Math.max(size.x, size.y, size.z);
      const targetHeight = model.defaultScale || 1.8;
      const scale = maxDim > 0 ? targetHeight / maxDim : 1;
      sceneModel.scale.setScalar(scale);

      const center = new THREE.Vector3();
      bbox.getCenter(center);
      sceneModel.position.set(-center.x * scale, 0, -center.z * scale);

      // 自动贴地
      const groundY = model.autoGround !== false ? 0 : sceneModel.position.y;
      bbox.setFromObject(sceneModel);
      sceneModel.position.y = groundY - bbox.min.y;

      propManager.addProp(model.name, "imported", sceneModel, {
        fileName: model.file,
        modelId: model.id,
        originalSize: size.toArray(),
        url,
      }, { autoGround: false });

      // 刷新道具面板
      const propPanel = document.querySelector("#prop-list");
      if (propPanel?.parentElement?.refreshList) {
        propPanel.parentElement.refreshList();
      }

      onToast(`✅ 已添加：${model.name}`, false);
    } catch (err) {
      console.error("[模型库] 添加失败:", err);
      onToast(`❌ 添加失败：${err.message}`, true);
    } finally {
      btn.textContent = origText;
      btn.disabled = false;
    }
  }
}
