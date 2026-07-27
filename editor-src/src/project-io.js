/**
 * project-io.js — 工程文件导入导出
 *
 * 暴露 window.__ds.exportProject() 和 window.__ds.importProject()
 */
import { getSceneSettings, setSceneSettings } from "./scene-settings-panel.js";

/**
 * 收集完整场景数据
 */
function collectSceneData() {
  const ds = window.__ds;
  const api = window.DS_FigureAPI;

  const data = {
    version: 3,
    timestamp: Date.now(),
    cameras: ds?.cameraManager?.serialize?.() || [],
    props: ds?.propManager?.snapshot?.() || [],
    sceneSettings: getSceneSettings(),
    focalLength: ds?.getFocalLength?.() || 35,
  };

  // 收集角色数据
  if (api) {
    const chars = [];
    const allChars = api.getAllCharacters();
    if (allChars) {
      for (const [id, char] of allChars) {
        const jointCoords = [];
        for (let i = 0; i < 18; i++) {
          if (char.jointSpheres?.[i]) {
            const p = char.jointSpheres[i].position;
            jointCoords.push([+p.x.toFixed(4), +p.y.toFixed(4), +p.z.toFixed(4)]);
          } else {
            jointCoords.push([0, 0, 0]);
          }
        }

        const ikTargets = {};
        if (char.ikState) {
          for (const [chainName, state] of Object.entries(char.ikState)) {
            ikTargets[chainName] = {
              target: state.target.position.toArray(),
              pole: state.pole.position.toArray(),
            };
          }
        }

        chars.push({
          id: char.id,
          name: char.name,
          color: char.color,
          joints: jointCoords,
          ikTargets,
          visible: char.visible !== false,
          position: char.skeletonGroup?.position?.toArray() || [0, 0, 0],
        });
      }
    }
    data.characters = chars;
    data.activeCharId = api.getActiveCharacter()?.id || null;
  }

  // sceneGz 兼容 — 已通过完整场景数据序列化，不再冗余存储 sceneGz 编码
  // （略去 data.sceneGz 以减小 30-50% 文件体积）

  // P1.5：外部 3D角色（GLB/VRM）快照
  const extMgr = ds?.externalCharacters;
  if (extMgr && typeof extMgr.snapshot === "function") {
    const snap = extMgr.snapshot();
    data.externalCharacters = snap.characters;
    data.activeExternalCharacterId = snap.activeCharacterId;
  }

  // 核心B：自定义姿态预设（随 sceneJSON.posePresets / 工程文件持久化）
  if (typeof ds?.posePresets?.serialize === "function") {
    data.posePresets = ds.posePresets.serialize();
  }

  // 全景图
  if (ds?.panorama && typeof ds.panorama.serialize === "function") {
    data.panorama = ds.panorama.serialize();
  }

  return data;
}

/**
 * 导出工程文件
 */
function exportProject() {
  try {
    const data = collectSceneData();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    a.download = `director-project-${ts}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    if (window.__ds?.showToast) {
      window.__ds.showToast("💾 工程已导出", false);
    }
    console.log("[工程IO] 导出完成，大小:", json.length, "bytes");
  } catch (err) {
    console.error("[工程IO] 导出失败:", err);
    if (window.__ds?.showToast) {
      window.__ds.showToast("❌ 导出失败: " + err.message, true);
    }
  }
}

/**
 * 导入工程文件
 * @param {File} file - 用户选择的文件
 */
async function importProject(file) {
  if (!file) {
    // 创建 file input
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.style.display = "none";
    document.body.appendChild(input);

    return new Promise((resolve) => {
      input.addEventListener("change", async () => {
        const f = input.files[0];
        document.body.removeChild(input);
        if (f) {
          await _doImport(f);
        }
        resolve();
      });
      input.click();
    });
  }

  return _doImport(file);
}

async function _doImport(file) {
  try {
    // 文件大小限制：最大 50MB
    const MAX_FILE_BYTES = 50 * 1024 * 1024;
    if (file.size > MAX_FILE_BYTES) {
      throw new Error(`文件过大 (${(file.size / 1024 / 1024).toFixed(1)}MB)，最大支持 50MB`);
    }

    // 确认对话框
    const confirmed = confirm("导入会清空当前场景，确定？");
    if (!confirmed) {
      console.log("[工程IO] 用户取消导入");
      return;
    }

    const text = await file.text();
    const data = JSON.parse(text);

    if (!data.version || data.version < 1) {
      throw new Error("无效的工程文件格式");
    }

    const ds = window.__ds;
    const api = window.DS_FigureAPI;

    // 1) 清空角色
    if (api) {
      const existingIds = Array.from(api.getAllCharacters().keys());
      for (const id of existingIds) {
        api.removeCharacter(id);
      }
    }

    // 2) 清空道具
    if (ds?.propManager) {
      ds.propManager.clear();
    }

    // 3) 恢复角色
    if (data.characters && api) {
      for (const charData of data.characters) {
        const char = api.createCharacter(charData.id, charData.name, charData.color);
        if (!char) continue;

        char.visible = charData.visible !== false;

        // 恢复骨架位置
        if (charData.position && char.skeletonGroup) {
          char.skeletonGroup.position.fromArray(charData.position);
        }

        // 恢复关节位置
        if (charData.joints && api.applyPoseToActive) {
          api.setActive(charData.id);
          api.applyPoseToActive(charData.joints);
        }

        // 恢复 IK targets
        if (charData.ikTargets && char.ikState) {
          for (const [chainName, ikPos] of Object.entries(charData.ikTargets)) {
            const state = char.ikState[chainName];
            if (state) {
              if (ikPos.target) state.target.position.fromArray(ikPos.target);
              if (ikPos.pole) state.pole.position.fromArray(ikPos.pole);
            }
          }
        }
      }

      // 恢复活动角色
      if (data.activeCharId && api.setActive) {
        try { api.setActive(data.activeCharId); } catch (e) {
          console.warn("[工程IO] 无法设置活动角色:", e.message);
        }
      }
    }

    // 4) 恢复道具
    if (data.props && ds?.propManager) {
      ds.propManager.restore(data.props, true);
    }

    // 5) 恢复机位
    if (data.cameras && ds?.cameraManager) {
      // deserialize 开头自带清空（this.cameras = []），原 while 循环因 removeCamera 的
      // “至少保留 1 个相机”保护会死循环（P0-fix），直接删除
      if (ds.cameraManager.deserialize) {
        ds.cameraManager.deserialize(data.cameras);
      }
    }

    // 6) 恢复场景设置
    if (data.sceneSettings) {
      setSceneSettings(data.sceneSettings);
    }

    // 6.5) 核心B：恢复自定义姿态预设（旧工程无该字段则跳过）
    if (Array.isArray(data.posePresets) && ds?.posePresets?.restore) {
      ds.posePresets.restore(data.posePresets);
    }

    // 7) 恢复焦距
    if (data.focalLength !== undefined && ds?.setFocalLength) {
      ds.setFocalLength(data.focalLength);
    }

    // 7.5) P1.5：恢复外部 3D角色（GLB/VRM，异步加载模型）
    if (Array.isArray(data.externalCharacters) && data.externalCharacters.length > 0 && ds?.externalCharacters) {
      ds.externalCharacters.restore({
        characters: data.externalCharacters,
        activeCharacterId: data.activeExternalCharacterId || null,
      }).then((ok) => {
        if (ok && window.__dsSetCharacterMode) {
          window.__dsSetCharacterMode(ds.externalCharacters.getActive()?.type || "glb");
        }
        window.dispatchEvent(new CustomEvent("ds-project-loaded"));
      }).catch((e) => console.warn("[工程IO] 外部角色恢复失败:", e));
    }

    // 7.6) 恢复全景图
    if (data.panorama && ds?.panorama && typeof ds.panorama.restore === "function") {
      ds.panorama.restore(data.panorama, ds.scene);
    }

    // 8) 通知更新
    window.dispatchEvent(new CustomEvent("ds-char-changed"));
    window.dispatchEvent(new CustomEvent("ds-project-loaded"));

    if (window.__ds?.showToast) {
      window.__ds.showToast("📂 工程已导入", false);
    }
    console.log("[工程IO] 导入完成:", file.name);
  } catch (err) {
    console.error("[工程IO] 导入失败:", err);
    if (window.__ds?.showToast) {
      window.__ds.showToast("❌ 导入失败: " + err.message, true);
    }
  }
}

// ==================== 暴露到全局 ====================

window.__ds = window.__ds || {};
window.__ds.exportProject = exportProject;
window.__ds.importProject = importProject;

export { exportProject, importProject, collectSceneData };
