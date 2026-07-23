/**
 * glb-import.js — GLB/GLTF 模型导入
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

/**
 * 为顶部栏创建"导入模型"按钮和隐藏的 file input
 * @param {import("./props.js").PropManager} propManager
 * @param {Function} onToast - (msg, isErr) => void
 * @returns {{ button: HTMLElement, fileInput: HTMLInputElement }}
 */
export function createGLBImport(propManager, onToast) {
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".glb,.gltf";
  fileInput.style.display = "none";

  const button = document.createElement("button");
  button.textContent = "📦 导入模型";
  button.title = "从本地选择 .glb 或 .gltf 3D模型文件导入场景";
  button.style.cssText = "padding:6px 12px;font-size:13px;";

  button.addEventListener("click", () => {
    // 添加文件选择提示
    onToast("请选择 .glb 或 .gltf 格式的3D模型文件（可从 Sketchfab / Poly Haven 等网站下载免费模型）", false);
    fileInput.value = "";
    fileInput.click();
  });

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) return;

    try {
      onToast(`正在导入 ${file.name}…`, false);

      // 1) Upload to ComfyUI
      const formData = new FormData();
      formData.append("image", file, file.name);
      formData.append("type", "input");
      formData.append("subfolder", "director_stage");
      formData.append("overwrite", "true");

      const uploadRes = await fetch("/upload/image", { method: "POST", body: formData });
      if (!uploadRes.ok) throw new Error(`上传失败 HTTP ${uploadRes.status}`);
      const uploadJson = await uploadRes.json();
      const relativePath = (uploadJson.subfolder ? uploadJson.subfolder + "/" : "") + uploadJson.name;

      // 2) Load via GLTFLoader from the uploaded URL
      const url = `/view?filename=${encodeURIComponent(relativePath)}&type=input`;
      const loader = new GLTFLoader();

      const gltf = await new Promise((resolve, reject) => {
        loader.load(
          url,
          (result) => resolve(result),
          (xhr) => {
            if (xhr.total > 0) {
              onToast('导入中 ' + Math.round(xhr.loaded / xhr.total * 100) + '%...', false);
            }
          },
          (err) => reject(new Error(`加载失败: ${err.message || err}`))
        );
      });

      // 3) Scale to fit scene (target height ~1.8m)
      const model = gltf.scene;
      const bbox = new THREE.Box3().setFromObject(model);
      const size = new THREE.Vector3();
      bbox.getSize(size);
      const maxDim = Math.max(size.x, size.y, size.z);
      const targetHeight = 1.8;
      const scale = maxDim > 0 ? targetHeight / maxDim : 1;
      model.scale.setScalar(scale);

      // 4) Center model at origin
      const center = new THREE.Vector3();
      bbox.getCenter(center);
      model.position.set(-center.x * scale, 0, -center.z * scale);

      // 5) Add to prop manager
      propManager.addProp(
        file.name.replace(/\.[^.]+$/, ""),
        "imported",
        model,
        { fileName: file.name, originalSize: size.toArray(), uploadPath: relativePath },
        { autoGround: true }
      );

      // Refresh prop panel if available
      const propPanel = document.getElementById("prop-list");
      if (propPanel && propPanel.parentElement && propPanel.parentElement.refreshList) {
        propPanel.parentElement.refreshList();
      }

      onToast(`✅ 已导入：${file.name}`, false);
    } catch (err) {
      console.error("[GLB导入]", err);
      onToast(`❌ 导入失败：${err.message || err}`, true);
    }
  });

  return { button, fileInput };
}
