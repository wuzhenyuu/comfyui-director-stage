/**
 * clipboard.js — Ctrl+C/V 复制粘贴系统
 *
 * 全局 clipboard 单例：{ type: 'character' | 'prop', data }
 *
 * 复制：Ctrl+C → 将当前选中的角色或道具深拷贝到 clipboard
 * 粘贴：Ctrl+V → 在偏移位置创建新对象
 */

import * as THREE from "three";
import { translateExternalCharacter } from "./external-character-move.js";

/** @type {{ type: 'character'|'prop', data: any } | null} */
let clipboard = null;

/**
 * 复制当前选中的对象到剪贴板
 * 优先级：角色 > 道具
 */
function copyToClipboard() {
  try {
    const pm = window.__ds?.propManager;

    // 1) 复制角色（P2-fix：火柴人分支已删除，3D-only 从 ExternalCharacterManager 取活动 3D 角色）
    {
      const mgr = window.__ds?.externalCharacters;
      const entry = mgr?.getActive?.();
      if (entry && entry.model) {
        const ikData = {};
        if (entry.ikTargets) {
          for (const [chainName, t] of Object.entries(entry.ikTargets)) {
            ikData[chainName] = {
              target: t?.target ? t.target.position.toArray() : null,
              pole: t?.pole ? t.pole.position.toArray() : null,
            };
          }
        }

        clipboard = {
          type: "character",
          data: {
            external: true, // 标记：3D 外部角色拷贝（与 DS_FigureAPI 火柴人路径区分）
            name: entry.name,
            url: entry.url,
            fileName: entry.fileName || null,
            entryType: entry.type || "glb",
            transform: {
              position: entry.model.position.toArray(),
              quaternion: entry.model.quaternion.toArray(),
              scale: entry.model.scale.toArray(),
            },
            ikTargets: ikData,
          },
        };

        if (window.__ds?.showToast) {
          window.__ds.showToast(`📋 已复制角色「${entry.name}」（3D）`, false);
        }
        console.log("[剪贴板] 已复制 3D 角色", clipboard.data);
        return;
      }
    }

    // 2) 复制道具
    if (pm) {
      const sel = pm.getSelected();
      if (sel) {
        clipboard = {
          type: "prop",
          data: {
            name: sel.name,
            kind: sel.kind,
            params: { ...sel.params },
            position: sel.mesh.position.toArray(),
            rotation: sel.mesh.rotation.toArray().slice(0, 3),
            scale: sel.mesh.scale.toArray(),
          },
        };

        if (window.__ds?.showToast) {
          window.__ds.showToast(`📋 已复制道具「${sel.name}」`, false);
        }
        console.log("[剪贴板] 已复制道具", clipboard.data);
        return;
      }
    }

    console.log("[剪贴板] 无选中对象可复制");
  } catch (err) {
    console.error("[剪贴板] 复制失败:", err);
  }
}

/**
 * 从剪贴板粘贴
 */
function pasteFromClipboard() {
  if (!clipboard) {
    console.log("[剪贴板] 剪贴板为空");
    return;
  }

  try {
    if (clipboard.type === "character") {
      _pasteCharacter(clipboard.data);
    } else if (clipboard.type === "prop") {
      _pasteProp(clipboard.data);
    }
  } catch (err) {
    console.error("[剪贴板] 粘贴失败:", err);
  }
}

/** 粘贴角色（P2-fix：火柴人路径已删除，3D-only 仅支持外部角色拷贝） */
function _pasteCharacter(data) {
  if (data?.external) {
    // 3D 外部角色拷贝：走 ExternalCharacterManager 异步加载路径
    _pasteExternalCharacter(data);
    return;
  }
  console.warn("[剪贴板] 非 3D 角色拷贝，无法粘贴（火柴人已移除）");
}

/**
 * 粘贴 3D 外部角色（GLB/VRM）
 * 流程：addGLB/addVRM 异步加载 → 恢复拷贝时的模型变换 → 恢复 IK target/pole 世界坐标
 *      → translateExternalCharacter 整体平移 +1/+1（模型+IK 同步，并重置脚钉地基准）
 */
async function _pasteExternalCharacter(data) {
  const mgr = window.__ds?.externalCharacters;
  if (!mgr) {
    console.warn("[剪贴板] ExternalCharacterManager 不可用");
    return;
  }
  if (!data?.url) {
    console.warn("[剪贴板] 3D 角色拷贝缺少 url，无法粘贴");
    return;
  }

  const copyName = `${data.name || "3D角色"}_copy`;

  let entry = null;
  try {
    entry = data.entryType === "vrm"
      ? await mgr.addVRM(data.url, copyName, data.fileName)
      : await mgr.addGLB(data.url, copyName);
  } catch (err) {
    console.error("[剪贴板] 加载 3D 角色失败:", err);
    if (window.__ds?.showToast) {
      window.__ds.showToast(`📌 粘贴失败：${err?.message || err}`, false);
    }
    return;
  }
  if (!entry || !entry.model) {
    console.warn("[剪贴板] 创建 3D 角色失败（可能已达上限）");
    if (window.__ds?.showToast) {
      window.__ds.showToast("📌 粘贴失败：3D角色数量已达上限", false);
    }
    return;
  }

  // 恢复拷贝时的模型变换（覆盖 addGLB/addVRM 的自动错位出生位置）
  const tf = data.transform;
  if (tf) {
    if (Array.isArray(tf.position)) entry.model.position.fromArray(tf.position);
    if (Array.isArray(tf.quaternion)) entry.model.quaternion.fromArray(tf.quaternion);
    if (Array.isArray(tf.scale)) entry.model.scale.fromArray(tf.scale);
    entry.model.updateMatrixWorld(true);
  }

  // 恢复拷贝时的 IK target/pole 世界坐标
  if (data.ikTargets && entry.ikTargets) {
    for (const [chainName, ikPos] of Object.entries(data.ikTargets)) {
      const t = entry.ikTargets[chainName];
      if (!t) continue;
      if (Array.isArray(ikPos?.target) && t.target) t.target.position.fromArray(ikPos.target);
      if (Array.isArray(ikPos?.pole) && t.pole) t.pole.position.fromArray(ikPos.pole);
    }
  }

  // 整体平移偏移 +1m（X/Z）：模型与 IK target/pole 同步移动，并重置脚钉地基准
  translateExternalCharacter(entry, 1, 0, 1);

  // 补解一次 IK，让骨骼对齐到新 target/pole；并激活新角色
  entry._ikDirty = true;
  mgr.setActive?.(entry.id);

  if (window.__ds?.showToast) {
    window.__ds.showToast(`📌 已粘贴角色「${copyName}」（3D）`, false);
  }
  console.log("[剪贴板] 已粘贴 3D 角色", entry.id, copyName);
}

/** 粘贴道具 */
function _pasteProp(data) {
  const pm = window.__ds?.propManager;
  if (!pm) {
    console.warn("[剪贴板] PropManager 不可用");
    return;
  }

  // 偏移位置
  const offsetX = data.position[0] + 1;
  const offsetZ = data.position[2] + 1;

  // 使用工厂函数创建 mesh
  _createPropMesh(data.kind, data.params, data.position, offsetX, offsetZ, data.scale, data.rotation);

  if (window.__ds?.showToast) {
    window.__ds.showToast(`📌 已粘贴道具「${data.name}」`, false);
  }
  console.log("[剪贴板] 已粘贴道具", data.name);
}

/** 创建道具 mesh 并添加到 PropManager */
function _createPropMesh(kind, params, pos, offsetX, offsetZ, scale, rotation) {
  const pm = window.__ds?.propManager;
  if (!pm) return;

  const color = params.color || 0x5b8def;
  let mesh;

  // 直接使用 THREE API（避免循环依赖 props.js）
  switch (kind) {
    case "box": {
      const w = params.w || 1, h = params.h || 1, d = params.d || 1;
      mesh = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, d),
        new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.05 }),
      );
      break;
    }
    case "cylinder": {
      const rTop = params.rTop !== undefined ? params.rTop : 0.3;
      const rBot = params.rBot !== undefined ? params.rBot : 0.3;
      const h = params.h || 1;
      mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(rTop, rBot, h, 32),
        new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.05 }),
      );
      break;
    }
    case "sphere": {
      const r = params.r || 0.5;
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(r, 32, 24),
        new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.05 }),
      );
      break;
    }
    case "plane": {
      const w = params.w || 1, h = params.h || 1;
      mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.05, side: THREE.DoubleSide }),
      );
      break;
    }
    case "torus": {
      const r = params.r || 0.5, tube = params.tube || 0.15;
      mesh = new THREE.Mesh(
        new THREE.TorusGeometry(r, tube, 16, 32),
        new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.05 }),
      );
      break;
    }
    case "cone": {
      const r = params.r || 0.3, h = params.h || 1;
      mesh = new THREE.Mesh(
        new THREE.ConeGeometry(r, h, 32),
        new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.05 }),
      );
      break;
    }
    case "pyramid": {
      const s = params.s || 0.5, h = params.h || 0.8;
      mesh = new THREE.Mesh(
        new THREE.ConeGeometry(s, h, 4),
        new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.05 }),
      );
      break;
    }
    default: {
      mesh = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.05 }),
      );
    }
  }

  mesh.name = kind;
  mesh.position.set(offsetX, pos[1], offsetZ);
  if (rotation) mesh.rotation.set(rotation[0] || 0, rotation[1] || 0, rotation[2] || 0);
  if (scale) mesh.scale.fromArray(scale);

  pm.addProp(
    kind === "copy" ? "已粘贴" : params.name || `${kind}_copy`,
    kind,
    mesh,
    { ...params },
    { autoGround: true },
  );
}

// ==================== 获取剪贴板状态（供 main.js 读取） ====================

function getClipboard() {
  return clipboard;
}

// ==================== 暴露到全局 ====================

window.__ds = window.__ds || {};
window.__ds.copyToClipboard = copyToClipboard;
window.__ds.pasteFromClipboard = pasteFromClipboard;
window.__ds.getClipboard = getClipboard;

export { copyToClipboard, pasteFromClipboard, getClipboard };

// ==================== 快捷键注册（文件末尾，确保 DOM 就绪） ====================

function _registerHotkeys() {
  document.addEventListener("keydown", (e) => {
    // 不在 input/textarea 中时才触发剪贴板快捷键
    const tag = document.activeElement?.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea") return;

    if (e.ctrlKey && e.key === "c" && !e.shiftKey) {
      e.preventDefault();
      copyToClipboard();
    } else if (e.ctrlKey && e.key === "v" && !e.shiftKey) {
      e.preventDefault();
      pasteFromClipboard();
    }
  });
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _registerHotkeys, { once: true });
  } else {
    _registerHotkeys();
  }
}
