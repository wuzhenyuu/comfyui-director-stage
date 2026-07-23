/**
 * clipboard.js — Ctrl+C/V 复制粘贴系统
 *
 * 全局 clipboard 单例：{ type: 'character' | 'prop', data }
 *
 * 复制：Ctrl+C → 将当前选中的角色或道具深拷贝到 clipboard
 * 粘贴：Ctrl+V → 在偏移位置创建新对象
 */

import * as THREE from "three";

/** @type {{ type: 'character'|'prop', data: any } | null} */
let clipboard = null;

/**
 * 复制当前选中的对象到剪贴板
 * 优先级：角色 > 道具
 */
function copyToClipboard() {
  try {
    // 检查 ds_opt_a 是否提供了 figureAPI
    const api = window.DS_FigureAPI;
    const pm = window.__ds?.propManager;

    // 1) 复制角色（当前活动角色）
    if (api) {
      const char = api.getActiveCharacter();
      if (char) {
        // 深拷贝角色数据
        const jointCoords = [];
        for (let i = 0; i < 18; i++) {
          const s = char.jointSpheres[i];
          jointCoords.push([s.position.x, s.position.y, s.position.z]);
        }

        // IK targets
        const ikData = {};
        for (const [chainName, state] of Object.entries(char.ikState)) {
          ikData[chainName] = {
            target: state.target.position.toArray(),
            pole: state.pole.position.toArray(),
          };
        }

        clipboard = {
          type: "character",
          data: {
            name: char.name,
            color: char.color,
            joints: jointCoords,
            ikTargets: ikData,
            // skeletonGroup 世界位置（作为角色根位置）
            position: char.skeletonGroup.position.toArray(),
          },
        };

        if (window.__ds?.showToast) {
          window.__ds.showToast(`📋 已复制角色「${char.name}」`, false);
        }
        console.log("[剪贴板] 已复制角色", clipboard.data);
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

/** 粘贴角色 */
function _pasteCharacter(data) {
  const api = window.DS_FigureAPI;
  if (!api) {
    console.warn("[剪贴板] DS_FigureAPI 不可用");
    return;
  }

  // 生成新 ID
  const count = api.getAllCharacters().size;
  const newId = `char_${String(count + 1).padStart(2, "0")}`;
  const newName = `${data.name}_copy`;

  // 创建新角色
  const char = api.createCharacter(newId, newName, data.color);
  if (!char) {
    console.warn("[剪贴板] 创建角色失败");
    return;
  }

  // 偏移位置：原位置 + 1m 偏移
  const offsetPos = [
    (data.position[0] || 0) + 1,
    data.position[1] || 0,
    (data.position[2] || 0) + 1,
  ];
  char.skeletonGroup.position.set(offsetPos[0], offsetPos[1], offsetPos[2]);

  // 应用姿势
  if (api.applyPoseToActive) {
    api.setActive(newId);
    api.applyPoseToActive(data.joints);
  }

  // 恢复 IK target 位置（应用偏移）
  for (const [chainName, ikPos] of Object.entries(data.ikTargets)) {
    const state = char.ikState[chainName];
    if (state) {
      state.target.position.set(
        ikPos.target[0] + 1,
        ikPos.target[1],
        ikPos.target[2] + 1,
      );
      state.pole.position.set(
        ikPos.pole[0] + 1,
        ikPos.pole[1],
        ikPos.pole[2] + 1,
      );
    }
  }

  if (window.__ds?.showToast) {
    window.__ds.showToast(`📌 已粘贴角色「${newName}」`, false);
  }
  console.log("[剪贴板] 已粘贴角色", newId, newName);
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

// 注册全局键盘快捷键
if (typeof document !== "undefined") {
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

export { copyToClipboard, pasteFromClipboard, getClipboard };
