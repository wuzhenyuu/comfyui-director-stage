/**
 * props-panel.js — 道具面板 UI（渲染到 #props-panel）
 */
import { PrimitiveFactory } from "./props.js";

/**
 * 创建道具面板 DOM
 * @param {import("./props.js").PropManager} propManager
 * @returns {HTMLElement}
 */
export function createPropsPanel(propManager) {
  const panel = document.createElement("div");
  panel.id = "props-tab";
  panel.style.cssText =
    "display:flex;flex-direction:column;height:100%;overflow-y:auto;";

  // ── 标题 ──
  const header = document.createElement("div");
  header.textContent = "🧱 道具";
  header.style.cssText =
    "padding:12px 14px;font-weight:600;font-size:13px;border-bottom:1px solid #2a2f3d;";
  panel.appendChild(header);

  // ── 添加按钮行 ──
  const addRow = document.createElement("div");
  addRow.style.cssText = "padding:8px 10px;display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid #2a2f3d;";

  const addBtn = (label, title, fn) => {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.title = title;
    btn.style.cssText = "flex:1;min-width:40px;padding:5px 2px;font-size:12px;";
    btn.addEventListener("click", fn);
    return btn;
  };

  addRow.appendChild(addBtn("📦盒", "添加盒子", () => {
    const mesh = PrimitiveFactory.createBox(0.5, 0.5, 0.5, randomColor());
    propManager.addProp("盒子", "box", mesh, { w: 0.5, h: 0.5, d: 0.5, color: mesh.material.color.getHex() });
    refreshList();
  }));

  addRow.appendChild(addBtn("🔵球", "添加球体", () => {
    const mesh = PrimitiveFactory.createSphere(0.3, randomColor());
    propManager.addProp("球体", "sphere", mesh, { r: 0.3, color: mesh.material.color.getHex() });
    refreshList();
  }));

  addRow.appendChild(addBtn("🥫柱", "添加圆柱", () => {
    const mesh = PrimitiveFactory.createCylinder(0.2, 0.2, 0.8, randomColor());
    propManager.addProp("圆柱", "cylinder", mesh, { rTop: 0.2, rBot: 0.2, h: 0.8, color: mesh.material.color.getHex() });
    refreshList();
  }));

  addRow.appendChild(addBtn("🟫板", "添加平面", () => {
    const mesh = PrimitiveFactory.createPlane(1, 1, randomColor());
    propManager.addProp("平面", "plane", mesh, { w: 1, h: 1, color: mesh.material.color.getHex() });
    refreshList();
  }));

  panel.appendChild(addRow);

  // ── 颜色选择器 ──
  const colorRow = document.createElement("div");
  colorRow.style.cssText = "padding:6px 10px;display:flex;align-items:center;gap:6px;border-bottom:1px solid #2a2f3d;";
  colorRow.innerHTML = `<span style="font-size:12px;color:#8a90a0;">颜色</span>`;
  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.value = "#5b8def";
  colorInput.style.cssText = "width:24px;height:24px;border:none;cursor:pointer;background:none;";
  colorRow.appendChild(colorInput);

  const colorLabel = document.createElement("span");
  colorLabel.style.cssText = "font-size:11px;color:#8a90a0;flex:1;";
  colorLabel.textContent = "#5b8def";
  colorInput.addEventListener("input", () => {
    colorLabel.textContent = colorInput.value;
  });
  colorRow.appendChild(colorLabel);
  panel.appendChild(colorRow);

  // ── 操作按钮 ──
  const opRow = document.createElement("div");
  opRow.style.cssText = "padding:6px 10px;display:flex;gap:4px;border-bottom:1px solid #2a2f3d;";

  const delBtn = document.createElement("button");
  delBtn.textContent = "🗑️ 删除选中";
  delBtn.style.cssText = "flex:1;padding:5px 4px;font-size:12px;";
  delBtn.addEventListener("click", () => {
    const sel = propManager.getSelected();
    if (sel) {
      propManager.removeProp(sel.id);
      refreshList();
    }
  });

  const clearAllBtn = document.createElement("button");
  clearAllBtn.textContent = "🧹 清空";
  clearAllBtn.style.cssText = "padding:5px 8px;font-size:12px;";
  clearAllBtn.addEventListener("click", () => {
    propManager.clear();
    refreshList();
  });

  opRow.appendChild(delBtn);
  opRow.appendChild(clearAllBtn);

  // Transform mode buttons
  const modeRow = document.createElement("div");
  modeRow.style.cssText = "padding:4px 10px;display:flex;gap:4px;border-bottom:1px solid #2a2f3d;";
  ["translate", "rotate", "scale"].forEach((mode) => {
    const b = document.createElement("button");
    b.textContent = mode === "translate" ? "↔️移" : mode === "rotate" ? "🔄转" : "🔲缩";
    b.title = mode;
    b.style.cssText = "flex:1;padding:4px 2px;font-size:11px;";
    b.addEventListener("click", () => propManager.setTransformMode(mode));
    modeRow.appendChild(b);
  });

  panel.appendChild(opRow);
  panel.appendChild(modeRow);

  // ── 道具列表 ──
  const list = document.createElement("div");
  list.id = "prop-list";
  list.style.cssText = "flex:1;overflow-y:auto;padding:4px 0;";
  panel.appendChild(list);

  function refreshList() {
    list.innerHTML = "";
    if (propManager.props.length === 0) {
      list.innerHTML = `<div style="padding:20px;text-align:center;color:#8a90a0;font-size:12px;">无道具</div>`;
      return;
    }
    propManager.props.forEach((p) => {
      const row = document.createElement("div");
      row.style.cssText =
        "padding:6px 10px;cursor:pointer;font-size:12px;display:flex;align-items:center;gap:6px;transition:background 0.15s;";
      if (propManager.getSelected() === p) {
        row.style.background = "#2f9e6340";
      }
      row.innerHTML = `<span style="font-size:14px;">${kindIcon(p.kind)}</span> ${p.name}`;
      row.addEventListener("mouseenter", () => {
        if (propManager.getSelected() !== p) row.style.background = "#232836";
      });
      row.addEventListener("mouseleave", () => {
        if (propManager.getSelected() !== p) row.style.background = "";
      });
      row.addEventListener("click", () => {
        propManager.selectProp(p.id);
        refreshList();
      });
      list.appendChild(row);
    });
  }

  function kindIcon(kind) {
    const map = { box: "📦", sphere: "🔵", cylinder: "🥫", plane: "🟫", imported: "📥" };
    return map[kind] || "❓";
  }

  function randomColor() {
    return parseInt(colorInput.value.replace("#", ""), 16);
  }

  // 初始渲染列表
  refreshList();

  // 提供给外部刷新
  panel.refreshList = refreshList;

  return panel;
}
