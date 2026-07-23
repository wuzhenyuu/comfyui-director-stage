"""Replace addExtBtn with model selection dropdown in main.js"""
path = r'F:\comfyui\custom_nodes\comfyui-director-stage\editor-src\src\main.js'
with open(path, 'r', encoding='utf-8') as f:
    c = f.read()

# 1. Replace addExtBtn creation
old_btn = '''  // ── P3-1：添加3D角色（主入口，自动错位出生 + 自动激活，上限 8）──
  // 文案保留「添加GLB」子串（多角色/导出/动作测试均按该文本定位按钮）
  const addExtBtn = document.createElement("button");
  addExtBtn.id = "btnAddExternal";
  addExtBtn.dataset.addExternalChar = "1";
  addExtBtn.textContent = "➕添加GLB（3D角色）";
  addExtBtn.title = `再加载一个 3D角色（最多 ${MAX_EXTERNAL_CHARACTERS} 个，自动错位出生并激活；点身体拖整人，Alt=升降，拖 IK 球摆姿势）`;
  addExtBtn.style.cssText = "padding:6px 10px;font-size:12px;";'''

new_btn = '''  // ── P7：添加3D角色（弹出模型选择下拉菜单，从 index.json 加载模型列表）──
  const addExtBtn = document.createElement("button");
  addExtBtn.id = "btnAddExternal";
  addExtBtn.dataset.addExternalChar = "1";
  addExtBtn.textContent = "➕添加3D角色";
  addExtBtn.title = `选择 3D角色模型（最多 ${MAX_EXTERNAL_CHARACTERS} 个）`;
  addExtBtn.style.cssText = "padding:6px 10px;font-size:12px;cursor:pointer;position:relative;";'''

assert old_btn in c, 'addExtBtn not found!'
c = c.replace(old_btn, new_btn)

# 2. Replace loadMoreGLB to accept model info object
old_load = '''  /** P1.5：加载一个 GLB 外部角色（首个或追加）；返回 entry 或 null
   *  P3-0：opts.silent = 静默模式（默认角色自动加载用）：不弹 toast/错误 */
  async function loadMoreGLB(url = "/director_stage/models/michelle.glb", opts = {}) {'''

new_load = '''  /** P7：加载 GLB/VRM 3D角色（支持模型选择）
   *  @param {object} modelInfo — { url, name, type: "glb"|"vrm", fileName }
   *  @param {object} [opts] — { silent }
   *  未传 modelInfo 时从 index.json 弹出选择器 */
  async function loadMoreGLB(modelInfo, opts = {}) {
    // 无参数 → 弹出模型选择器
    if (!modelInfo || !modelInfo.url) {
      const info = await showModelPicker();
      if (!info) return null;
      modelInfo = info;
    }
    const url = modelInfo.url;
    const modelName = modelInfo.name || null;'''

assert old_load in c, 'loadMoreGLB not found!'
c = c.replace(old_load, new_load)

# 3. Update loadMoreGLB success toast to use modelInfo.name
old_toast = '''      const entry = await externalManager.addGLB(url);
      if (!entry) throw new Error("角色创建失败");
      externalManager.setActive(entry.id); // P3-1：添加后自动激活新角色
      setCharacterMode("glb");
      if (!silent) {
        showToast(externalManager.size === 1
          ? "3D角色已加载！点身体拖动整人（Alt=升降），拖青/黄 IK 球摆姿势"
          : `已添加「${entry.name}」（${externalManager.size}/${MAX_EXTERNAL_CHARACTERS}）并激活，点身体拖整人`, false);
      } else {
        console.log(`[3D导演台] 默认 3D角色已自动加载（${entry.name}）`);
      }'''

new_toast = '''      // 根据模型类型调用不同的加载方法
      let entry;
      if (modelInfo.type === "vrm") {
        entry = await externalManager.addVRM(url, modelName, modelInfo.fileName);
        if (entry) setCharacterModeProxy("vrm");
      } else {
        entry = await externalManager.addGLB(url, modelName, { fileName: modelInfo.fileName });
        if (entry) setCharacterModeProxy("glb");
      }
      if (!entry) throw new Error("角色创建失败");
      externalManager.setActive(entry.id);
      if (!silent) {
        showToast(externalManager.size === 1
          ? `${entry.name} 已加载！点身体拖整人（Alt=升降），拖青/黄 IK 球摆姿势`
          : `已添加「${entry.name}」（${externalManager.size}/${MAX_EXTERNAL_CHARACTERS}）`, false);
      } else {
        console.log(`[3D导演台] 默认 3D角色已自动加载（${entry.name}）`);
      }'''

assert old_toast in c, 'toast block not found!'
c = c.replace(old_toast, new_toast)

# 4. Replace addExtBtn click handler
old_click = '''  addExtBtn.addEventListener("click", () => loadMoreGLB());
  // P3-1：面板内添加入口（external-char-panel 头部 ➕ 按钮调用）
  window.__dsAddExternalCharacter = () => loadMoreGLB();'''

new_click = '''  // P7：点击弹出模型选择器；面板内 ➕ 按钮也走同一入口
  addExtBtn.addEventListener("click", () => loadMoreGLB());
  window.__dsAddExternalCharacter = () => loadMoreGLB();'''

assert old_click in c, 'click handler not found!'
c = c.replace(old_click, new_click)

# 5. Update auto-load to use michelle from index  
old_auto = '''  setTimeout(() => {
    if (externalManager.size > 0 || externalManager._restorePending) return;
    if (window.__ds_externalRestored) return;
    loadMoreGLB("/director_stage/models/michelle.glb", { silent: true })
      .catch((e) => console.warn("[3D导演台] 默认 3D角色自动加载失败（保持火柴人模式）:", e?.message || e));
  }, 800);'''

new_auto = '''  setTimeout(() => {
    if (externalManager.size > 0 || externalManager._restorePending) return;
    if (window.__ds_externalRestored) return;
    loadMoreGLB({ url: "/director_stage/models/michelle.glb", name: "Michelle", type: "glb", fileName: "michelle.glb" }, { silent: true })
      .catch((e) => console.warn("[3D导演台] 默认 3D角色自动加载失败:", e?.message || e));
  }, 800);'''

assert old_auto in c, 'auto load block not found!'
c = c.replace(old_auto, new_auto)

# 6. Add model picker function + setCharacterMode proxy BEFORE loadMoreGLB
# Find the spot right before "async function loadMoreGLB"
picker_code = '''
  /** P7：弹出模型选择下拉菜单，从 /director_stage/models/index.json 加载列表 */
  async function showModelPicker() {
    return new Promise((resolve) => {
      const menu = document.createElement("div");
      menu.id = "model-picker-menu";
      menu.style.cssText = "position:fixed;z-index:20000;min-width:260px;max-height:400px;overflow-y:auto;background:#1a1d26;border:1px solid #2f9e63;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,0.6);padding:4px 0;font-size:12px;";

      const loading = document.createElement("div");
      loading.textContent = "加载模型列表…";
      loading.style.cssText = "padding:12px 16px;color:#8a90a0;";
      menu.appendChild(loading);
      document.body.appendChild(menu);

      // 定位到按钮下方
      const rect = addExtBtn.getBoundingClientRect();
      menu.style.left = rect.left + "px";
      menu.style.top = (rect.bottom + 4) + "px";

      const close = () => { menu.remove(); document.removeEventListener("click", onOutside, true); resolve(null); };
      const onOutside = (e) => { if (!menu.contains(e.target) && e.target !== addExtBtn) close(); };
      setTimeout(() => document.addEventListener("click", onOutside, true), 50);

      // 异步加载模型列表
      fetch("/director_stage/models/index.json")
        .then(r => r.json())
        .then(data => {
          menu.innerHTML = "";
          const head = document.createElement("div");
          head.textContent = "选择3D角色模型";
          head.style.cssText = "padding:8px 14px;font-weight:600;color:#c8cddb;border-bottom:1px solid #2a2f3d;";
          menu.appendChild(head);

          const chars = (data.models || []).filter(m => m.type === "character");
          if (chars.length === 0) {
            const empty = document.createElement("div");
            empty.textContent = "暂无可用角色模型";
            empty.style.cssText = "padding:12px 14px;color:#6a7080;";
            menu.appendChild(empty);
            return;
          }

          chars.forEach((m, i) => {
            const row = document.createElement("div");
            row.style.cssText = "padding:10px 14px;cursor:pointer;display:flex;align-items:center;gap:10px;transition:background 0.1s;color:#d0d6e0;";
            row.addEventListener("mouseenter", () => row.style.background = "#2a3040");
            row.addEventListener("mouseleave", () => row.style.background = "");

            const icon = document.createElement("span");
            icon.textContent = m.type === "vrm" ? "🎭" : "🧊";
            icon.style.cssText = "font-size:18px;";
            row.appendChild(icon);

            const info = document.createElement("div");
            info.style.cssText = "flex:1;";
            const nameEl = document.createElement("div");
            nameEl.textContent = m.name;
            nameEl.style.cssText = "font-weight:500;";
            const descEl = document.createElement("div");
            descEl.textContent = `${m.bones || "?"}骨骼${m.hasFingers ? "·手指" : ""} | ${m.description || ""}`.substring(0, 60);
            descEl.style.cssText = "font-size:10px;color:#6a7080;margin-top:2px;";
            info.appendChild(nameEl);
            info.appendChild(descEl);
            row.appendChild(info);

            if (i === 0) {
              const defBadge = document.createElement("span");
              defBadge.textContent = "默认";
              defBadge.style.cssText = "font-size:9px;background:#2f9e6350;color:#2f9e63;padding:1px 6px;border-radius:8px;";
              row.appendChild(defBadge);
            }

            row.addEventListener("click", (e) => {
              e.stopPropagation();
              menu.remove();
              document.removeEventListener("click", onOutside, true);
              resolve({
                url: `/director_stage/models/${m.file}`,
                name: m.name,
                type: m.type === "vrm" ? "vrm" : "glb",
                fileName: m.file,
              });
            });
            menu.appendChild(row);
          });
        })
        .catch(() => {
          // 失败兜底：显示内置模型
          menu.innerHTML = "";
          const head2 = document.createElement("div");
          head2.textContent = "选择3D角色（离线模式）";
          head2.style.cssText = "padding:8px 14px;font-weight:600;color:#c8cddb;border-bottom:1px solid #2a2f3d;";
          menu.appendChild(head2);
          const builtin = [
            { name: "Michelle (女)", url: "/director_stage/models/michelle.glb", type: "glb", fileName: "michelle.glb" },
            { name: "Mixamo (男)", url: "/director_stage/models/mixamo-rigged-character.glb", type: "glb", fileName: "mixamo-rigged-character.glb" },
            { name: "UE人体模型", url: "/director_stage/models/ue-mannequin-retopology.glb", type: "glb", fileName: "ue-mannequin-retopology.glb" },
            { name: "Alicia VRM", url: "/director_stage/models/AliciaSolid.vrm", type: "vrm", fileName: "AliciaSolid.vrm" },
          ];
          builtin.forEach(m => {
            const row = document.createElement("div");
            row.textContent = (m.type === "vrm" ? "🎭 " : "🧊 ") + m.name;
            row.style.cssText = "padding:10px 14px;cursor:pointer;color:#d0d6e0;";
            row.addEventListener("mouseenter", () => row.style.background = "#2a3040");
            row.addEventListener("mouseleave", () => row.style.background = "");
            row.addEventListener("click", (e) => { e.stopPropagation(); close(); resolve(m); });
            menu.appendChild(row);
          });
        });
    });
  }

  // setCharacterMode 代理（loadMoreGLB 在 injectTopbarControls 闭包中调用，需要引到外层函数）
  function setCharacterModeProxy(mode) { setCharacterMode(mode); }
'''

# Insert picker BEFORE loadMoreGLB
marker = "  /** P7：加载 GLB/VRM 3D角色（支持模型选择）"
assert marker in c, 'picker insertion point not found!'
c = c.replace(marker, picker_code + marker)

with open(path, 'w', encoding='utf-8') as f:
    f.write(c)
print('OK: main.js updated with model picker dropdown')
