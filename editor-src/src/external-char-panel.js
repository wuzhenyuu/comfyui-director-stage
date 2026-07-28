/**
 * external-char-panel.js — P1.5b 外部 3D角色列表面板（GLB/VRM）
 *
 * 挂在左侧「角色」面板内火柴人列表下方（char-panel 容器），分区标题「🧊 3D角色」。
 * 每行：颜色点 / 名称 / type 徽标(GLB·VRM) / 👁 可见性 / ✏️ 重命名 / 🗑️ 删除。
 * 点击行：激活该角色，并确保外部角色处于显示模式（从火柴人模式自动切换）。
 * 标题右侧显示数量上限（如 2/8）。
 *
 * 自动刷新：监听 ds-external-char-changed（ExternalCharacterManager 增删/激活/
 * 可见性/重命名时触发）。
 */
import { MAX_EXTERNAL_CHARACTERS } from "./external-characters.js";
import { ACTIONS, getClipActions, isClipActionId } from "./action-presets.js";
import { createPosePresetSection } from "./pose-presets.js";

const ROW_BTN_STYLE =
  "background:transparent;border:none;color:#8a90a0;cursor:pointer;padding:2px 3px;" +
  "font-size:12px;line-height:1;flex-shrink:0;border-radius:3px;";

/**
 * 创建外部 3D角色面板
 * @param {HTMLElement} container - 挂载容器（通常是 #char-panel）
 * @param {import("./external-characters.js").ExternalCharacterManager} manager
 * @param {object} [opts]
 * @param {(entry: object) => void} [opts.onSelect] - 行点击回调（默认：setActive + 切到外部角色显示模式）
 * @param {import("./action-runtime.js").ActionRuntime} [opts.actionRuntime] - P3-0 动作运行时（可选，缺省不渲染动作栏）
 * @returns {{ el: HTMLElement, render: Function }}
 */
export function createExternalCharPanel(container, manager, opts = {}) {
  const actionRuntime = opts.actionRuntime || null;
  const panel = document.createElement("div");
  panel.id = "external-char-panel";
  panel.style.cssText =
    "width:100%;background:#14171f;border-bottom:1px solid #2a2f3d;display:flex;" +
    "flex-direction:column;user-select:none;"; // P4-fix（2026-07-29）：去掉 max-height:32%——否则 list 被动作栏/姿态预设挤成一条缝，删除/重命名按钮点不到

  // ── 标题行：分区名 + 数量上限徽标 ──
  const header = document.createElement("div");
  header.style.cssText =
    "padding:8px 12px;font-weight:600;font-size:12px;border-bottom:1px solid #2a2f3d;" +
    "display:flex;align-items:center;gap:6px;color:#c8cddb;";
  const titleSpan = document.createElement("span");
  titleSpan.textContent = "🧊 3D角色";
  titleSpan.style.cssText = "flex:1;";
  header.appendChild(titleSpan);

  // P3-1：面板内添加入口（与顶栏「➕添加3D角色」等效，调 main.js 暴露的钩子）
  const addBtn = document.createElement("button");
  addBtn.id = "ext-char-add";
  addBtn.dataset.addExternalChar = "1";
  addBtn.textContent = "➕";
  addBtn.title = "添加 3D角色（自动错位出生并激活）";
  addBtn.style.cssText =
    "padding:1px 8px;font-size:13px;background:#2f9e63;border:none;border-radius:4px;" +
    "color:#fff;cursor:pointer;flex-shrink:0;line-height:1.4;";
  addBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (manager.size >= MAX_EXTERNAL_CHARACTERS) {
      window.__ds?.showToast?.(`最多 ${MAX_EXTERNAL_CHARACTERS} 个 3D角色`, true);
      return;
    }
    window.__dsAddExternalCharacter?.();
  });
  header.appendChild(addBtn);

  const countBadge = document.createElement("span");
  countBadge.id = "ext-char-count";
  countBadge.style.cssText =
    "font-size:11px;font-weight:400;color:#8a90a0;background:#1e2230;" +
    "padding:1px 7px;border-radius:8px;";
  header.appendChild(countBadge);
  panel.appendChild(header);

  // ── P3-0：骨骼显示开关（默认开，与顶栏共享 window.__ds.setSkeletonVisible）──
  const skeletonLabel = document.createElement("label");
  skeletonLabel.style.cssText =
    "padding:4px 12px;font-size:11px;color:#8a90a0;display:flex;align-items:center;" +
    "gap:5px;border-bottom:1px solid #2a2f3d;cursor:pointer;";
  const skeletonCheckbox = document.createElement("input");
  skeletonCheckbox.type = "checkbox";
  skeletonCheckbox.id = "ext-skeleton-toggle";
  skeletonCheckbox.checked = window.__ds?.skeletonVisible !== false; // 默认开
  skeletonCheckbox.style.cssText = "accent-color:#2f9e63;";
  skeletonCheckbox.addEventListener("change", () => {
    window.__ds?.setSkeletonVisible?.(skeletonCheckbox.checked);
  });
  skeletonLabel.appendChild(skeletonCheckbox);
  skeletonLabel.appendChild(document.createTextNode("🦴 显示骨骼"));
  panel.appendChild(skeletonLabel);
  // 顶栏开关同步面板勾选
  window.addEventListener("ds-skeleton-changed", (e) => {
    skeletonCheckbox.checked = e.detail?.enabled !== false;
  });

  // ── 列表区 ──
  const list = document.createElement("div");
  list.id = "ext-char-list";
  list.style.cssText = "flex:none;overflow-y:auto;padding:2px 0;min-height:58px;max-height:172px;"; // P4-fix：列表自身限高+内部滚动（约2~5行可见）
  panel.appendChild(list);

  // ── P3-0：动作栏（作用于活动角色）──
  const actionBar = document.createElement("div");
  actionBar.id = "ext-action-bar";
  actionBar.style.cssText =
    "padding:6px 10px;border-top:1px solid #2a2f3d;display:flex;flex-direction:column;gap:5px;";

  const actionRow1 = document.createElement("div");
  actionRow1.style.cssText = "display:flex;align-items:center;gap:5px;";
  const actionSelect = document.createElement("select");
  actionSelect.id = "ext-action-select";
  actionSelect.title = "选择动作预设（作用于活动 3D角色）";
  actionSelect.style.cssText =
    "flex:1;background:#1e2230;color:#c8cddb;border:1px solid #2a2f3d;border-radius:4px;" +
    "font-size:11px;padding:3px 4px;min-width:0;";
  // P3-2：动态填充动作下拉框 —「动作预设」（程序化）+「模型动画」（活动角色自带 AnimationClip）
  let _actionSelectKey = "";
  function rebuildActionSelect() {
    const activeEntry = manager.getActive?.() || null;
    const clipActions = activeEntry ? getClipActions(activeEntry) : [];
    const key = (activeEntry?.id || "-") + ":" + clipActions.length;
    if (key === _actionSelectKey) return;
    _actionSelectKey = key;
    const prevVal = actionSelect.value;
    actionSelect.innerHTML = "";
    const g1 = document.createElement("optgroup");
    g1.label = "动作预设";
    for (const a of ACTIONS) {
      const opt = document.createElement("option");
      opt.value = a.id;
      opt.textContent = a.name;
      g1.appendChild(opt);
    }
    actionSelect.appendChild(g1);
    if (clipActions.length) {
      const g2 = document.createElement("optgroup");
      g2.label = "模型动画";
      for (const a of clipActions) {
        const opt = document.createElement("option");
        opt.value = a.id;
        opt.textContent = a.name;
        g2.appendChild(opt);
      }
      actionSelect.appendChild(g2);
    }
    if ([...actionSelect.options].some((o) => o.value === prevVal)) {
      actionSelect.value = prevVal;
    }
  }
  rebuildActionSelect();
  actionRow1.appendChild(actionSelect);

  const playBtn = document.createElement("button");
  playBtn.id = "ext-action-play";
  playBtn.title = "播放/暂停动作";
  playBtn.textContent = "▶";
  playBtn.style.cssText =
    "padding:3px 10px;font-size:12px;background:#2f9e63;border:none;border-radius:4px;" +
    "color:#fff;cursor:pointer;flex-shrink:0;";
  actionRow1.appendChild(playBtn);

  const standBtn = document.createElement("button");
  standBtn.id = "ext-action-stand";
  standBtn.title = "停止全部动作并恢复站立";
  standBtn.textContent = "⏹站立";
  standBtn.style.cssText =
    "padding:3px 8px;font-size:11px;background:#1e2230;border:1px solid #2a2f3d;border-radius:4px;" +
    "color:#c8cddb;cursor:pointer;flex-shrink:0;";
  actionRow1.appendChild(standBtn);
  actionBar.appendChild(actionRow1);

  const actionRow2 = document.createElement("div");
  actionRow2.style.cssText = "display:flex;align-items:center;gap:6px;font-size:10px;color:#8a90a0;";
  const speedLabel = document.createElement("span");
  speedLabel.textContent = "速度";
  const speedSlider = document.createElement("input");
  speedSlider.id = "ext-action-speed";
  speedSlider.type = "range";
  speedSlider.min = "0.25";
  speedSlider.max = "2";
  speedSlider.step = "0.05";
  speedSlider.value = "1";
  speedSlider.title = "动作速度";
  speedSlider.style.cssText = "flex:1;accent-color:#2f9e63;min-width:0;";
  const speedVal = document.createElement("span");
  speedVal.id = "ext-action-speed-val";
  speedVal.textContent = "1.00×";
  speedVal.style.cssText = "min-width:36px;text-align:right;";
  const intensityLabel = document.createElement("span");
  intensityLabel.textContent = "强度";
  const intensitySlider = document.createElement("input");
  intensitySlider.id = "ext-action-intensity";
  intensitySlider.type = "range";
  intensitySlider.min = "0";
  intensitySlider.max = "1";
  intensitySlider.step = "0.05";
  intensitySlider.value = "1";
  intensitySlider.title = "动作强度";
  intensitySlider.style.cssText = "flex:1;accent-color:#2f9e63;min-width:0;";
  actionRow2.appendChild(speedLabel);
  actionRow2.appendChild(speedSlider);
  actionRow2.appendChild(speedVal);
  actionRow2.appendChild(intensityLabel);
  actionRow2.appendChild(intensitySlider);
  actionBar.appendChild(actionRow2);

  // 快捷动作按钮行：每个动作一个 data-action-id，既可读也可直接点击播放
  const quickRow = document.createElement("div");  quickRow.style.cssText = "display:flex;flex-wrap:wrap;gap:3px;";
  for (const a of ACTIONS) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.actionId = a.id;
    b.textContent = a.name;
    b.title = `播放/切换到「${a.name}」`;
    b.style.cssText =
      "padding:2px 5px;font-size:10px;background:#1e2230;border:1px solid #2a2f3d;" +
      "border-radius:4px;color:#aeb6c8;cursor:pointer;";
    b.addEventListener("click", () => {
      const entry = activeEntry();
      if (!entry || !actionRuntime) {
        window.__ds?.showToast?.("请先在列表中激活一个 3D角色", true);
        return;
      }
      actionSelect.value = a.id;
      _leaveBoneModeForProceduralAction(a.id);
      actionRuntime.toggle(entry.id, a.id);
    });
    quickRow.appendChild(b);
  }
  actionBar.appendChild(quickRow);
  if (actionRuntime) panel.appendChild(actionBar);

  // ── 姿态预设分区（核心B：自定义静态姿势库，随 sceneJSON.posePresets 持久化）──
  const posePresetUI = createPosePresetSection();
  panel.appendChild(posePresetUI.el);

  container.appendChild(panel);

  function activeEntry() {
    return manager.getActive?.() || null;
  }

  // P4-fix（2026-07-29）：程序化动作预设驱动 IK targets + 骨盆，而骨骼模式冻结 IK 求解，
  // 会导致「骨盆被拉走、四肢保持原姿势」的撕裂怪姿势（用户反馈：骨骼模式下预设姿势全错）。
  // 规则：骨骼模式下触发程序化动作 → 自动切回 IK 模式再播放（setMode 内部已 syncIKFromBones，
  // 当前骨骼姿势无损带到 IK）；模型动画（clip:）由 AnimationMixer 直接驱动骨骼，不受影响。
  function _leaveBoneModeForProceduralAction(actionId) {
    const be = window.__ds?.boneEditor;
    if (!be?.isBoneMode?.()) return;
    if (typeof isClipActionId === "function" && isClipActionId(actionId)) return;
    be.setMode("ik");
    window.__ds?.showToast?.("🎯 动作预设基于 IK 驱动，已自动切回 IK 模式", false);
  }

  playBtn.addEventListener("click", () => {
    const entry = activeEntry();
    if (!entry || !actionRuntime) {
      window.__ds?.showToast?.("请先在列表中激活一个 3D角色", true);
      return;
    }
    _leaveBoneModeForProceduralAction(actionSelect.value);
    actionRuntime.toggle(entry.id, actionSelect.value);
  });
  standBtn.addEventListener("click", () => {
    if (!actionRuntime) return;
    actionRuntime.stopAll();
    window.__ds?.showToast?.("⏹ 已停止全部动作，恢复站立", false);
  });
  speedSlider.addEventListener("input", () => {
    const v = parseFloat(speedSlider.value) || 1;
    speedVal.textContent = v.toFixed(2) + "×";
    const entry = activeEntry();
    if (entry && actionRuntime) actionRuntime.setSpeed(entry.id, v);
  });
  intensitySlider.addEventListener("input", () => {
    const entry = activeEntry();
    if (entry && actionRuntime) actionRuntime.setIntensity(entry.id, parseFloat(intensitySlider.value));
  });

  /** 默认行点击行为：激活角色并确保外部角色显示（火柴人模式下自动切换） */
  function defaultSelect(entry) {
    manager.setActive(entry.id);
    // 当前若是火柴人模式，切到该角色来源类型以显示外部角色
    if (window.__ds?.characterMode === "stick") {
      window.__ds?.setCharacterMode?.(entry.type);
    }
  }

  function makeRowBtn(text, title, onClick) {
    const btn = document.createElement("button");
    btn.textContent = text;
    btn.title = title;
    btn.style.cssText = ROW_BTN_STYLE;
    btn.addEventListener("mouseenter", () => (btn.style.background = "#2a3040"));
    btn.addEventListener("mouseleave", () => (btn.style.background = "transparent"));
    btn.addEventListener("click", (e) => {
      e.stopPropagation(); // 不触发行激活
      onClick();
    });
    return btn;
  }

  function render() {
    const entries = manager.getAll();
    const activeId = manager.activeCharacterId;

    // P3-0：同步动作栏到活动角色状态
    if (actionRuntime) {
      rebuildActionSelect(); // P3-2：活动角色变化时刷新「模型动画」分组
      const active = entries.find((e) => e.id === activeId) || null;
      const st = active ? actionRuntime.getState(active.id) : null;
      if (st && actionSelect.value !== st.id && [...actionSelect.options].some((o) => o.value === st.id)) {
        actionSelect.value = st.id;
      }
      playBtn.textContent = st?.playing ? "⏸" : "▶";
      playBtn.style.background = st?.playing ? "#b8860b" : "#2f9e63";
      quickRow.querySelectorAll("[data-action-id]").forEach((btn) => {
        const activeAction = st && btn.dataset.actionId === st.id;
        btn.style.background = activeAction ? (st.playing ? "#2f9e63" : "#39445a") : "#1e2230";
        btn.style.color = activeAction ? "#ffffff" : "#aeb6c8";
      });
      if (st && Math.abs(parseFloat(speedSlider.value) - st.speed) > 0.01) {
        speedSlider.value = String(st.speed);
        speedVal.textContent = st.speed.toFixed(2) + "×";
      }
    }

    countBadge.textContent = `${entries.length}/${MAX_EXTERNAL_CHARACTERS}`;
    addBtn.style.opacity = entries.length >= MAX_EXTERNAL_CHARACTERS ? "0.45" : "";
    list.innerHTML = "";

    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "暂无 3D角色（点上方 ➕ 或顶栏「➕添加GLB（3D角色）」加载）";
      empty.style.cssText = "padding:10px 12px;color:#5a6070;font-size:11px;";
      list.appendChild(empty);
      return;
    }

    for (const entry of entries) {
      const visible = entry.visible !== false;
      const isActive = entry.id === activeId;

      const row = document.createElement("div");
      row.dataset.extCharId = entry.id;
      row.style.cssText =
        "display:flex;align-items:center;gap:7px;padding:6px 10px;cursor:pointer;" +
        "font-size:12px;transition:background 0.15s;";
      if (isActive) {
        row.style.background = "#232836";
        row.style.borderLeft = "3px solid #44ccff";
      } else {
        row.style.borderLeft = "3px solid transparent";
      }
      if (!visible) row.style.opacity = "0.5";

      // 颜色点
      const dot = document.createElement("span");
      dot.style.cssText =
        `display:inline-block;width:10px;height:10px;border-radius:50%;` +
        `background:${entry.color || "#888"};flex-shrink:0;`;
      row.appendChild(dot);

      // 名称
      const nameSpan = document.createElement("span");
      nameSpan.textContent = entry.name || entry.id;
      nameSpan.title = entry.name || entry.id;
      nameSpan.style.cssText =
        "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;";
      row.appendChild(nameSpan);

      // P3-0：播放中动作徽标
      if (actionRuntime?.isPlaying?.(entry.id)) {
        const st = actionRuntime.getState(entry.id);
        // P3-2：clip 动作名从模型动画清单取（含中文名）
        const actionName = ACTIONS.find((a) => a.id === st.id)?.name
          || getClipActions(entry).find((a) => a.id === st.id)?.name
          || st.id;
        const playBadge = document.createElement("span");
        playBadge.className = "ext-action-badge";
        playBadge.textContent = "▶" + actionName;
        playBadge.style.cssText =
          "font-size:10px;color:#2f9e63;background:#16241c;padding:1px 5px;" +
          "border-radius:4px;flex-shrink:0;";
        row.appendChild(playBadge);
      }

      // type 徽标
      const typeBadge = document.createElement("span");
      typeBadge.textContent = entry.type === "vrm" ? "VRM" : "GLB";
      typeBadge.style.cssText =
        "font-size:10px;color:#8a90a0;background:#1e2230;padding:1px 5px;" +
        "border-radius:4px;flex-shrink:0;";
      row.appendChild(typeBadge);

      // 👁 可见性切换
      row.appendChild(
        makeRowBtn(visible ? "👁" : "🚫", visible ? "隐藏该角色" : "显示该角色", () => {
          manager.setVisible(entry.id, !visible);
        })
      );

      // ✏️ 重命名
      row.appendChild(
        makeRowBtn("✏️", "重命名", () => {
          const newName = prompt("新角色名：", entry.name || "");
          if (newName && newName.trim()) {
            manager.rename(entry.id, newName.trim());
          }
        })
      );

      // 🗑️ 删除
      row.appendChild(
        makeRowBtn("🗑️", "删除该 3D角色", () => {
          if (confirm(`删除 3D角色「${entry.name || entry.id}」？`)) {
            manager.remove(entry.id);
            window.__ds?.showToast?.(`已删除「${entry.name || entry.id}」`, false);
          }
        })
      );

      // hover
      row.addEventListener("mouseenter", () => {
        if (!isActive) row.style.background = "#1e2230";
      });
      row.addEventListener("mouseleave", () => {
        if (!isActive) row.style.background = "";
      });

      // 点击行：激活 + 确保外部角色显示
      row.addEventListener("click", () => {
        if (opts.onSelect) opts.onSelect(entry);
        else defaultSelect(entry);
      });

      list.appendChild(row);
    }
  }

  // 管理器任何变化（增删/激活/可见性/重命名/restore）自动刷新
  window.addEventListener("ds-external-char-changed", render);
  // P3-0：动作播放/暂停/停止时刷新徽标与按钮
  window.addEventListener("ds-action-changed", render);

  render();
  return { el: panel, render };
}
