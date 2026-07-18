/**
 * char-props-panel.js — 角色属性面板
 * 渲染到 #char-props-panel DOM 容器
 * 选中角色时显示属性编辑器，未选中时显示灰色提示
 */
import * as THREE from "three";

/**
 * 创建角色属性面板
 * @returns {{ panel: HTMLElement, refresh: () => void }}
 */
export function createCharPropsPanel() {
  const panel = document.createElement("div");
  panel.style.cssText = "display:flex;flex-direction:column;height:100%;overflow-y:auto;";

  // ── 标题 ──
  const header = document.createElement("div");
  header.textContent = "🪪 角色属性";
  header.style.cssText = "padding:12px 14px;font-weight:600;font-size:13px;border-bottom:1px solid #2a2f3d;";
  panel.appendChild(header);

  // ── 内容区域 ──
  const content = document.createElement("div");
  content.id = "char-props-content";
  content.style.cssText = "flex:1;overflow-y:auto;padding:8px 10px;";
  panel.appendChild(content);

  // ── 空状态 ──
  function showEmpty() {
    content.innerHTML = `
      <div style="padding:24px;text-align:center;color:#8a90a0;font-size:12px;line-height:1.6;">
        🖱️ 请在视口中点击选择角色
      </div>`;
  }

  // ── 渲染属性编辑器 ──
  function renderProps() {
    const api = window.DS_FigureAPI;
    if (!api) {
      showEmpty();
      return;
    }
    const char = api.getActiveCharacter();
    if (!char) {
      showEmpty();
      return;
    }

    content.innerHTML = "";

    const addField = (label) => {
      const el = document.createElement("div");
      el.style.cssText = "margin-bottom:8px;";
      const lbl = document.createElement("div");
      lbl.textContent = label;
      lbl.style.cssText = "font-size:11px;color:#8a90a0;margin-bottom:3px;";
      el.appendChild(lbl);
      return el;
    };

    // ── 名称文本框 ──
    (() => {
      const el = addField("📝 名称");
      const input = document.createElement("input");
      input.type = "text";
      input.value = char.name;
      input.style.cssText = "width:100%;padding:5px 8px;font-size:12px;background:#0b0d12;border:1px solid #2a2f3d;border-radius:4px;color:#e6e9f0;";
      input.addEventListener("change", () => {
        const newName = input.value.trim();
        if (newName && newName !== char.name) {
          api.getManager().rename(char.id, newName);
          // 通知其他面板刷新
          window.dispatchEvent(new CustomEvent("ds-char-changed"));
        }
      });
      el.appendChild(input);
      content.appendChild(el);
    })();

    // ── 颜色选择器 ──
    (() => {
      const el = addField("🎨 颜色");
      const colorRow = document.createElement("div");
      colorRow.style.cssText = "display:flex;align-items:center;gap:6px;";

      const colorInput = document.createElement("input");
      colorInput.type = "color";
      // Convert char.color string to hex
      const hex = (() => {
        if (typeof char.color === "number") return "#" + char.color.toString(16).padStart(6, "0");
        if (typeof char.color === "string" && char.color.startsWith("#")) return char.color;
        return "#ff6b6b";
      })();
      colorInput.value = hex;
      colorInput.style.cssText = "width:28px;height:28px;border:none;cursor:pointer;background:none;padding:0;";

      const colorLabel = document.createElement("span");
      colorLabel.textContent = hex;
      colorLabel.style.cssText = "font-size:11px;color:#8a90a0;flex:1;";

      colorInput.addEventListener("input", () => {
        colorLabel.textContent = colorInput.value;
        const newColor = parseInt(colorInput.value.replace("#", ""), 16);
        // 更新角色颜色：修改 jointSpheres 材质
        if (char.jointSpheres) {
          char.jointSpheres.forEach((s) => {
            if (s.material) {
              s.material.color.setHex(newColor);
              s.material.emissive?.setHex(newColor);
            }
          });
        }
        // 更新 boneMeshes 颜色（半透明度影响）
        if (char.boneMeshes) {
          const color = new THREE.Color(newColor);
          const mutedColor = color.clone().multiplyScalar(0.5);
          char.boneMeshes.forEach((m) => {
            if (m.material) m.material.color.copy(mutedColor);
          });
        }
      });

      colorRow.appendChild(colorInput);
      colorRow.appendChild(colorLabel);
      el.appendChild(colorRow);
      content.appendChild(el);
    })();

    // ── 锁定切换 ──
    (() => {
      const el = addField("🔒 锁定");
      const lockRow = document.createElement("div");
      lockRow.style.cssText = "display:flex;align-items:center;gap:6px;";

      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = (() => {
        try { return window.__ds?.isObjectLocked?.(char.id) || false; }
        catch (e) { return false; }
      })();
      toggle.style.cssText = "accent-color:#2f9e63;";

      const label = document.createElement("span");
      label.textContent = toggle.checked ? "已锁定" : "未锁定";
      label.style.cssText = "font-size:12px;";

      toggle.addEventListener("change", () => {
        try {
          window.__ds?.setObjectLocked?.(char.id, toggle.checked);
        } catch (e) {
          console.warn("[角色属性] setObjectLocked 不可用:", e);
        }
        label.textContent = toggle.checked ? "已锁定" : "未锁定";
      });

      lockRow.appendChild(toggle);
      lockRow.appendChild(label);
      el.appendChild(lockRow);
      content.appendChild(el);
    })();

    // ── 可见性切换 ──
    (() => {
      const el = addField("👁️ 可见性");
      const visRow = document.createElement("div");
      visRow.style.cssText = "display:flex;align-items:center;gap:6px;";

      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = char.visible !== false;
      toggle.style.cssText = "accent-color:#2f9e63;";

      const label = document.createElement("span");
      label.textContent = toggle.checked ? "可见" : "隐藏";
      label.style.cssText = "font-size:12px;";

      toggle.addEventListener("change", () => {
        char.visible = toggle.checked;
        if (char.skeletonGroup) char.skeletonGroup.visible = toggle.checked;
        label.textContent = toggle.checked ? "可见" : "隐藏";
      });

      visRow.appendChild(toggle);
      visRow.appendChild(label);
      el.appendChild(visRow);
      content.appendChild(el);
    })();

    // ── X/Y/Z 坐标输入 ──
    (() => {
      const el = addField("📍 坐标 (X Y Z)");
      const coordRow = document.createElement("div");
      coordRow.style.cssText = "display:flex;gap:4px;";

      const axes = [
        { key: "x", label: "X" },
        { key: "y", label: "Y" },
        { key: "z", label: "Z" },
      ];

      const pos = char.skeletonGroup?.position || new THREE.Vector3();

      axes.forEach(({ key, label }) => {
        const input = document.createElement("input");
        input.type = "number";
        input.step = "0.1";
        input.value = pos[key].toFixed(2);
        input.style.cssText = "flex:1;padding:4px 4px;font-size:12px;background:#0b0d12;border:1px solid #2a2f3d;border-radius:4px;color:#e6e9f0;min-width:0;text-align:center;";

        const lbl = document.createElement("span");
        lbl.textContent = label;
        lbl.style.cssText = "font-size:10px;color:#8a90a0;";

        const wrapper = document.createElement("div");
        wrapper.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:2px;flex:1;";
        wrapper.appendChild(lbl);
        wrapper.appendChild(input);

        input.addEventListener("input", () => {
          const v = parseFloat(input.value);
          if (!isNaN(v) && char.skeletonGroup) {
            char.skeletonGroup.position[key] = v;
          }
        });

        coordRow.appendChild(wrapper);
      });

      el.appendChild(coordRow);
      content.appendChild(el);
    })();

    // ── 当前姿势名称 ──
    (() => {
      const el = addField("🧍 姿势");
      const poseText = document.createElement("div");
      poseText.textContent = "自定义姿势";
      poseText.style.cssText = "font-size:12px;color:#e6e9f0;padding:4px 0;";
      el.appendChild(poseText);
      content.appendChild(el);
    })();

    // ── 角色 ID（只读） ──
    (() => {
      const el = addField("🆔 ID");
      const idText = document.createElement("div");
      idText.textContent = char.id;
      idText.style.cssText = "font-size:11px;color:#8a90a0;padding:2px 0;font-family:monospace;";
      el.appendChild(idText);
      content.appendChild(el);
    })();
  }

  // ── 初始渲染 ──
  renderProps();

  // ── 监听角色切换事件 ──
  window.addEventListener("ds-char-changed", () => {
    renderProps();
  });

  return {
    panel,
    refresh: renderProps,
  };
}
