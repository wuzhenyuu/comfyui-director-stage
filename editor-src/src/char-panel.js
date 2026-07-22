/**
 * char-panel.js — 多角色管理面板 UI
 *
 * 渲染到 #char-panel 容器，提供：
 *   角色列表（名字+颜色圆点）点击切换
 *   ➕ 添加  /  🗑️ 删除  /  ✏️ 重命名
 */
import { CHARACTER_COLORS } from "./constants.js";
import { MAX_CHARACTERS } from "./figure.js";

/**
 * 创建角色面板 DOM
 * @param {HTMLElement} container - 容器元素
 * @param {Function} onAdd - 回调 (color) => void
 * @param {Function} onDelete - 回调 (id) => void
 * @param {Function} onRename - 回调 (id, newName) => void
 * @param {Function} onSelect - 回调 (id) => void
 * @returns {{ el: HTMLElement, render: Function }}
 */
export function createCharPanel(container, onAdd, onDelete, onRename, onSelect) {
  const panel = document.createElement("div");
  panel.id = "char-mgr-panel"; // 与侧边栏容器 #char-panel 区分（避免 id 冲突）
  // 作为 #char-panel 侧边栏 tab 页内的上区块（通宽，底部分隔线接姿势库）
  panel.style.cssText =
    "width:100%;background:#171a22;border-bottom:1px solid #2a2f3d;display:flex;flex-direction:column;user-select:none;max-height:45%;";

  // 标题
  const header = document.createElement("div");
  header.textContent = "👥 角色";
  header.style.cssText =
    "padding:10px 12px;font-weight:600;font-size:13px;border-bottom:1px solid #2a2f3d;";
  panel.appendChild(header);

  // 操作按钮行
  const actions = document.createElement("div");
  actions.style.cssText = "padding:6px 8px;display:flex;gap:4px;border-bottom:1px solid #2a2f3d;";
  actions.innerHTML = `
    <button id="btnCharAdd" title="添加角色" style="flex:1;padding:5px 2px;font-size:12px;">➕</button>
    <button id="btnCharDel" title="删除角色" style="flex:1;padding:5px 2px;font-size:12px;">🗑️</button>
    <button id="btnCharRename" title="重命名" style="flex:1;padding:5px 2px;font-size:12px;">✏️</button>
  `;
  panel.appendChild(actions);

  // 列表区
  const list = document.createElement("div");
  list.id = "char-list";
  list.style.cssText = "flex:1;overflow-y:auto;padding:2px 0;";
  panel.appendChild(list);

  container.appendChild(panel);

  // 事件绑定
  const addBtn = document.getElementById("btnCharAdd");

  /** 契约5：根据当前角色数刷新「添加」按钮可用状态（达上限置灰） */
  function updateAddBtnState(count) {
    if (!addBtn) return;
    const full = count >= MAX_CHARACTERS;
    addBtn.disabled = full;
    addBtn.title = full ? "最多 8 人" : "添加角色";
    addBtn.style.opacity = full ? "0.4" : "";
    addBtn.style.cursor = full ? "not-allowed" : "";
  }

  addBtn?.addEventListener("click", () => {
    // 契约5：防御性拦截——即使按钮状态未刷新，达上限也不触发添加
    const count = window.DS_FigureAPI?.getCharacterCount?.() ?? 0;
    if (count >= MAX_CHARACTERS) {
      window.__ds?.showToast?.("最多 8 人");
      updateAddBtnState(count);
      return;
    }
    if (onAdd) onAdd();
    // 添加后刷新按钮状态（onAdd 可能因 create() 返回 null 而失败，以实际数量为准）
    updateAddBtnState(window.DS_FigureAPI?.getCharacterCount?.() ?? count);
  });
  document.getElementById("btnCharDel")?.addEventListener("click", () => {
    const activeId = panel.dataset.activeId;
    if (activeId && onDelete) onDelete(activeId);
  });
  document.getElementById("btnCharRename")?.addEventListener("click", () => {
    const activeId = panel.dataset.activeId;
    if (!activeId) return;
    const newName = prompt("新角色名：", panel.dataset.activeName || "");
    if (newName && newName.trim() && onRename) {
      onRename(activeId, newName.trim());
    }
  });

  /**
   * 渲染角色列表
   * @param {{ id: string, name: string, color: string }[]} chars
   * @param {string} activeId
   */
  function render(chars, activeId) {
    const listEl = document.getElementById("char-list");
    if (!listEl) return;
    listEl.innerHTML = "";
    panel.dataset.activeId = activeId;

    // 判空保护：create() 达上限返回 null 时，调用方可能把 null 混进列表
    chars = (chars || []).filter(Boolean);

    // 契约5：刷新「添加」按钮置灰状态
    updateAddBtnState(chars.length);

    for (const char of chars) {
      const item = document.createElement("div");
      item.style.cssText =
        "display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:pointer;" +
        "font-size:12px;transition:background 0.15s;";
      if (char.id === activeId) {
        item.style.background = "#232836";
        item.style.borderLeft = "3px solid #2f9e63";
        panel.dataset.activeName = char.name;
      } else {
        item.style.borderLeft = "3px solid transparent";
      }

      // 颜色圆点
      const dot = document.createElement("span");
      dot.style.cssText =
        `display:inline-block;width:10px;height:10px;border-radius:50%;background:${char.color};flex-shrink:0;`;
      item.appendChild(dot);

      // 名字
      const nameSpan = document.createElement("span");
      nameSpan.textContent = char.name;
      nameSpan.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      item.appendChild(nameSpan);

      // 编号标记
      if (char.id === activeId) {
        const badge = document.createElement("span");
        badge.textContent = "✓";
        badge.style.cssText = "color:#2f9e63;font-size:11px;";
        item.appendChild(badge);
      }

      // hover
      item.addEventListener("mouseenter", () => {
        if (char.id !== activeId) item.style.background = "#1e2230";
      });
      item.addEventListener("mouseleave", () => {
        if (char.id !== activeId) item.style.background = "";
      });

      // click
      item.addEventListener("click", () => {
        if (onSelect) onSelect(char.id);
      });

      listEl.appendChild(item);
    }
  }

  // 契约5：角色增删时（ds-char-changed）同步刷新按钮状态
  window.addEventListener("ds-char-changed", () => {
    updateAddBtnState(window.DS_FigureAPI?.getCharacterCount?.() ?? 0);
  });

  return { el: panel, render };
}

/**
 * 获取下一个可用 ID
 * @param {Set<string>} existing
 * @returns {string}
 */
export function nextCharId(existing) {
  let n = 2;
  while (existing.has(`char_${String(n).padStart(2, "0")}`)) n++;
  return `char_${String(n).padStart(2, "0")}`;
}

/**
 * 获取下一个可用名字
 * @param {number} count
 * @returns {string}
 */
export function nextCharName(count) {
  return `角色${count + 1}`;
}
