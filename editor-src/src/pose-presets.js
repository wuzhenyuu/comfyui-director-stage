/**
 * pose-presets.js — 自定义姿态预设库（静态姿势，核心B）
 *
 * 与动作预设（action-presets.js，walk/run/wave 等动态 IK 采样）区分：
 *   - 动作预设：内置、参数化、按时间采样驱动 IK targets（动态）
 *   - 姿态预设：用户自定义、骨骼级静态姿势快照（旋转 + 允许的骨骼位移），
 *     保存/应用/重命名/删除，随 sceneJSON.posePresets 持久化
 *
 * 姿态内容（只含骨骼，不含角色整体 transform / 相机 / 道具）：
 *   bones: { [boneKey]: { rotation:[x,y,z], position?:[x,y,z] } }
 *   - rotation：骨骼局部欧拉角（XYZ 分量）
 *   - position：仅"允许位移"的骨骼（顶层骨骼，如 Hips/骨盆）才保存局部位移
 *
 * 跨 Agent 契约（核心A 骨骼编辑器）：
 *   - 优先使用 window.__ds.boneEditor.snapshotPoseBones() / applyPoseBones(bones)
 *   - boneEditor 暂不存在时优雅降级：内置 fallback 直接读写活动 3D角色骨骼，
 *     并在无法降级时报错"骨骼编辑器未就绪"
 *
 * sceneJSON 契约：
 *   posePresets: [{ id, name, type:'custom_pose', skeletonType, skeletonHash,
 *                   createdAt, bones:{ key:{ rotation:[x,y,z], position?:[x,y,z] } } }]
 *
 * 事件：
 *   - ds-pose-presets-changed：预设增删改/恢复/应用后触发（UI 自动刷新）
 *
 * 恢复路径：
 *   1) 节点 init（postMessage type:"init" 携带 sceneJSON.posePresets）— 本模块
 *      自行监听 message，不依赖 main.js 改动；
 *   2) 工程导入（project-io.js _doImport 显式调用 restore）。
 */
const POSE_TYPE = "custom_pose";

/** 模块内预设存储（有序） */
const _presets = [];
let _idCounter = 0;

/* ========================= 内部工具 ========================= */

function _ds() {
  return typeof window !== "undefined" ? window.__ds || null : null;
}

function _boneEditor() {
  return _ds()?.boneEditor || null;
}

function _toast(msg, isErr) {
  _ds()?.showToast?.(msg, !!isErr);
}

/** 当前活动外部 3D角色 entry（GLB/VRM）；无则 null */
function _activeEntry() {
  const mgr = _ds()?.externalCharacters;
  return mgr?.getActive?.() || null;
}

function _genId() {
  _idCounter += 1;
  return `pose_${Date.now().toString(36)}_${_idCounter}`;
}

/**
 * 计算骨架哈希：由骨骼名列表生成稳定短哈希，用于跨角色兼容性提示。
 * @param {object} entry
 * @returns {string}
 */
function _skeletonHash(entry) {
  const names = _boneKeys(entry);
  const s = names.join("|");
  // FNV-1a 32bit
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** 骨骼 key 列表（name 唯一化：重名骨骼加 #index 后缀） */
function _boneKeys(entry) {
  const bones = entry?.allBones || [];
  const seen = new Map();
  return bones.map((b, i) => {
    const base = b?.name || `bone_${i}`;
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}#${n}`;
  });
}

/** 骨骼是否允许保存位移：仅顶层骨骼（parent 不是 Bone，通常为 Hips/骨盆） */
function _allowPosition(bone) {
  return !!(bone?.isBone && !bone.parent?.isBone);
}

function _round(v, p = 6) {
  return +v.toFixed(p);
}

/**
 * Fallback：直接从活动角色骨骼快照姿态（boneEditor 缺失时的降级路径）。
 * @param {object} entry
 * @returns {{ bones: object, count: number }}
 */
function _snapshotFallback(entry) {
  const bones = {};
  const all = entry?.allBones || [];
  const keys = _boneKeys(entry);
  for (let i = 0; i < all.length; i++) {
    const b = all[i];
    if (!b?.isBone) continue;
    const rec = {
      rotation: [_round(b.rotation.x), _round(b.rotation.y), _round(b.rotation.z)],
    };
    if (_allowPosition(b)) {
      rec.position = [_round(b.position.x, 5), _round(b.position.y, 5), _round(b.position.z, 5)];
    }
    bones[keys[i]] = rec;
  }
  return { bones, count: Object.keys(bones).length };
}

/**
 * Fallback：把姿态直接写回活动角色骨骼。
 * 注意：活动角色的 IK 求解循环可能覆盖直接写入的骨骼旋转（见已知限制）。
 * @param {object} entry
 * @param {object} bones
 * @returns {number} 实际写入的骨骼数
 */
function _applyFallback(entry, bones) {
  const all = entry?.allBones || [];
  const keys = _boneKeys(entry);
  let applied = 0;
  for (let i = 0; i < all.length; i++) {
    const b = all[i];
    if (!b?.isBone) continue;
    const rec = bones[keys[i]] || bones[b.name];
    if (!rec) continue;
    if (Array.isArray(rec.rotation) && rec.rotation.length >= 3) {
      b.rotation.set(+rec.rotation[0] || 0, +rec.rotation[1] || 0, +rec.rotation[2] || 0);
    }
    if (Array.isArray(rec.position) && rec.position.length >= 3 && _allowPosition(b)) {
      b.position.set(+rec.position[0] || 0, +rec.position[1] || 0, +rec.position[2] || 0);
    }
    applied++;
  }
  return applied;
}

/** 姿态应用后的刷新：骨骼/IK/SkeletonHelper + 标记 scene dirty */
function _afterApply(entry, usedFallback) {
  const ds = _ds();
  // 正常路径（boneEditor.applyPoseBones）：内部已调 syncIKFromBones + _skipIKFrames
  // fallback 路径：需要手动跳帧 IK 求解，否则下一帧 CCD solver 会覆盖刚写入的骨骼旋转
  if (entry) {
    if (usedFallback) {
      entry._skipIKFrames = 40; // ~0.7s 跳过 IK，保证骨骼写入生效
      entry._ikDirty = false;
      // fallback 路径没有 syncIKFromBones：IK target/pole 保留旧位置，
      // 但 _skipIKFrames 到期后 CCD 会自动收敛（位置差不大）——
      // 后果是姿态切换时有短暂过渡，可接受。
    } else {
      entry._ikDirty = false; // boneEditor 内部已同步 IK 球，禁止求解器覆盖
    }
  }
  ds?.skeletonHelpers?.syncAll?.(); // SkeletonHelper 跟随骨骼（创建/清理/可见性）
  // 标记 scene dirty：优先核心A的钩子；否则退化为通用变更事件
  if (typeof ds?.markSceneDirty === "function") ds.markSceneDirty();
  window.dispatchEvent(new CustomEvent("ds-external-char-changed"));
  _emitChanged();
}

function _emitChanged() {
  window.dispatchEvent(new CustomEvent("ds-pose-presets-changed"));
}

function _notReady() {
  _toast("⚠️ 骨骼编辑器未就绪", true);
  console.warn("[姿态预设] 骨骼编辑器未就绪（无 __ds.boneEditor 且无活动 3D角色可降级）");
}

/* ========================= 公共 API ========================= */

/**
 * 列出全部姿态预设（按保存顺序，返回浅拷贝）
 * @returns {object[]}
 */
function list() {
  return _presets.map((p) => ({ ...p, bones: p.bones }));
}

/**
 * 获取单个预设
 * @param {string} id
 * @returns {object|null}
 */
function get(idOrName) {
  const p = _presets.find((x) => x.id === idOrName || x.name === idOrName);
  return p ? { ...p, bones: p.bones } : null;
}

/**
 * 保存当前活动 3D角色的骨骼姿势为自定义姿态。
 * @param {string} [name] - 缺省自动命名「姿态 N」
 * @returns {object|null} 新预设；失败返回 null
 */
function saveCurrent(name) {
  const entry = _activeEntry();
  const editor = _boneEditor();
  if (!entry && !editor) {
    _notReady();
    return null;
  }

  let bones = null;
  if (editor && typeof editor.snapshotPoseBones === "function") {
    bones = editor.snapshotPoseBones();
  } else {
    if (!editor) {
      console.warn("[姿态预设] boneEditor 未就绪，使用内置骨骼快照降级路径");
    }
    bones = _snapshotFallback(entry).bones;
  }
  if (!bones || Object.keys(bones).length === 0) {
    _toast("⚠️ 未捕获到任何骨骼，无法保存姿态", true);
    return null;
  }

  const preset = {
    id: _genId(),
    name: (name && String(name).trim()) || `姿态 ${_presets.length + 1}`,
    type: POSE_TYPE,
    skeletonType: entry?.type || null,
    skeletonHash: entry ? _skeletonHash(entry) : null,
    createdAt: new Date().toISOString(),
    bones,
  };
  _presets.push(preset);
  _emitChanged();
  _toast(`💾 已保存姿态「${preset.name}」（${Object.keys(bones).length} 骨骼）`, false);
  return { ...preset };
}

/**
 * 应用姿态到当前活动 3D角色。
 * @param {string} id
 * @returns {boolean}
 */
function apply(idOrName) {
  const preset = _presets.find((x) => x.id === idOrName || x.name === idOrName);
  if (!preset) {
    _toast("⚠️ 姿态预设不存在", true);
    return false;
  }
  const entry = _activeEntry();
  const editor = _boneEditor();
  if (!entry && !editor) {
    _notReady();
    return false;
  }

  // 骨架兼容性提示（不阻断：骨骼按 key/name 匹配，部分应用也允许）
  if (entry && preset.skeletonHash && _skeletonHash(entry) !== preset.skeletonHash) {
    _toast(`⚠️ 骨架不匹配（预设:${preset.skeletonType || "?"}），将按骨骼名部分应用`, true);
  }

  let ok = false;
  let usedFallback = false;
  if (editor && typeof editor.applyPoseBones === "function") {
    ok = editor.applyPoseBones(preset.bones) !== false;
  } else {
    if (!editor) {
      console.warn("[姿态预设] boneEditor 未就绪，使用内置骨骼写入降级路径");
    }
    usedFallback = true;
    ok = _applyFallback(entry, preset.bones) > 0;
  }
  if (!ok) {
    _toast("⚠️ 姿态应用失败（无匹配骨骼）", true);
    return false;
  }

  _afterApply(entry, usedFallback);
  _toast(`🧘 已应用姿态「${preset.name}」`, false);
  return true;
}

/**
 * 重命名预设
 * @param {string} id
 * @param {string} name
 * @returns {boolean}
 */
function rename(id, name) {
  const preset = _presets.find((x) => x.id === id);
  const n = (name && String(name).trim()) || "";
  if (!preset || !n) return false;
  preset.name = n;
  _emitChanged();
  return true;
}

/**
 * 删除预设
 * @param {string} id
 * @returns {boolean}
 */
function remove(id) {
  const i = _presets.findIndex((x) => x.id === id);
  if (i < 0) return false;
  const [p] = _presets.splice(i, 1);
  _emitChanged();
  _toast(`🗑️ 已删除姿态「${p.name}」`, false);
  return true;
}

/**
 * 序列化：写入 sceneJSON.posePresets / 工程文件
 * @returns {object[]}
 */
function serialize() {
  return _presets.map((p) => ({
    id: p.id,
    name: p.name,
    type: p.type,
    skeletonType: p.skeletonType,
    skeletonHash: p.skeletonHash,
    createdAt: p.createdAt,
    bones: p.bones,
  }));
}

/**
 * 从 sceneJSON.posePresets / 工程文件恢复（整体替换，与 restore 语义一致）。
 * 旧 sceneJSON 无该字段时调用方不应传入（传 null/undefined 则忽略）。
 * @param {object[]|null|undefined} arr
 * @returns {number} 恢复的预设数
 */
function restore(arr) {
  if (!Array.isArray(arr)) return 0;
  _presets.length = 0;
  let n = 0;
  for (const p of arr) {
    if (!p || !p.id || typeof p.bones !== "object" || !p.bones) continue;
    _presets.push({
      id: String(p.id),
      name: String(p.name || p.id),
      type: p.type || POSE_TYPE,
      skeletonType: p.skeletonType || null,
      skeletonHash: p.skeletonHash || null,
      createdAt: p.createdAt || null,
      bones: p.bones,
    });
    n++;
  }
  _emitChanged();
  if (n > 0) console.log(`[姿态预设] 已恢复 ${n} 个自定义姿态`);
  return n;
}

/* ========================= UI：姿态预设分区 ========================= */

const _BTN =
  "background:transparent;border:none;color:#8a90a0;cursor:pointer;padding:2px 3px;" +
  "font-size:12px;line-height:1;flex-shrink:0;border-radius:3px;";

/**
 * 创建姿态预设 UI 分区（保存按钮 + 预设列表）。
 * 挂在 external-char-panel 动作栏下方。
 *
 * UI 契约（跨 Agent）：
 *   - 保存按钮：data-save-pose
 *   - 列表项：data-pose-preset=<id>
 *   - 应用：data-apply-pose / 重命名：data-rename-pose / 删除：data-delete-pose
 *
 * @returns {{ el: HTMLElement, render: Function }}
 */
export function createPosePresetSection() {
  const el = document.createElement("div");
  el.id = "pose-preset-section";
  el.style.cssText =
    "padding:6px 10px;border-top:1px solid #2a2f3d;display:flex;flex-direction:column;gap:5px;";

  // 标题行
  const header = document.createElement("div");
  header.style.cssText = "display:flex;align-items:center;gap:6px;font-size:11px;color:#c8cddb;";
  const title = document.createElement("span");
  title.textContent = "🧘 姿态预设";
  title.style.cssText = "flex:1;font-weight:600;";
  header.appendChild(title);
  const count = document.createElement("span");
  count.id = "pose-preset-count";
  count.style.cssText =
    "font-size:10px;font-weight:400;color:#8a90a0;background:#1e2230;padding:1px 7px;border-radius:8px;";
  header.appendChild(count);
  el.appendChild(header);

  // 保存行：名称输入 + 保存按钮
  const saveRow = document.createElement("div");
  saveRow.style.cssText = "display:flex;align-items:center;gap:5px;";
  const nameInput = document.createElement("input");
  nameInput.id = "pose-preset-name";
  nameInput.type = "text";
  nameInput.placeholder = "姿态名称（可留空自动命名）";
  nameInput.style.cssText =
    "flex:1;background:#1e2230;color:#c8cddb;border:1px solid #2a2f3d;border-radius:4px;" +
    "font-size:11px;padding:3px 6px;min-width:0;";
  saveRow.appendChild(nameInput);
  const saveBtn = document.createElement("button");
  saveBtn.id = "pose-preset-save";
  saveBtn.dataset.savePose = "1";
  saveBtn.textContent = "💾 保存姿态";
  saveBtn.title = "保存当前活动 3D角色的骨骼姿势为自定义姿态（旋转 + 允许的骨骼位移）";
  saveBtn.style.cssText =
    "padding:3px 8px;font-size:11px;background:#2f9e63;border:none;border-radius:4px;" +
    "color:#fff;cursor:pointer;flex-shrink:0;";
  saveBtn.addEventListener("click", () => {
    // 优先 prompt 对话框（Playwright 测试自动 dialog.accept 填入名称）
    const name = typeof window !== "undefined" && window.prompt
      ? window.prompt("姿态名称（留空自动命名）", nameInput.value || "")
      : nameInput.value || "";
    const p = saveCurrent(name || "");
    if (p) nameInput.value = "";
  });
  saveRow.appendChild(saveBtn);
  el.appendChild(saveRow);

  // 列表区
  const listEl = document.createElement("div");
  listEl.id = "pose-preset-list";
  listEl.style.cssText = "display:flex;flex-direction:column;gap:2px;max-height:140px;overflow-y:auto;";
  el.appendChild(listEl);

  function _rowBtn(text, titleAttr, dataAttr, id, onClick) {
    const b = document.createElement("button");
    b.textContent = text;
    b.title = titleAttr;
    b.dataset[dataAttr] = id;
    b.style.cssText = _BTN;
    b.addEventListener("mouseenter", () => (b.style.background = "#2a3040"));
    b.addEventListener("mouseleave", () => (b.style.background = "transparent"));
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  function render() {
    const presets = list();
    count.textContent = String(presets.length);
    listEl.innerHTML = "";

    if (presets.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "暂无自定义姿态（摆好姿势后点「💾 保存姿态」）";
      empty.style.cssText = "padding:6px 2px;color:#5a6070;font-size:10px;";
      listEl.appendChild(empty);
      return;
    }

    for (const p of presets) {
      const row = document.createElement("div");
      row.dataset.posePreset = p.id;
      row.style.cssText =
        "display:flex;align-items:center;gap:6px;padding:4px 6px;font-size:11px;" +
        "border-left:3px solid transparent;border-radius:3px;";
      row.addEventListener("mouseenter", () => (row.style.background = "#1e2230"));
      row.addEventListener("mouseleave", () => (row.style.background = ""));

      // 名称
      const nameSpan = document.createElement("span");
      nameSpan.textContent = p.name;
      nameSpan.title = `${p.name}\n骨骼数:${Object.keys(p.bones).length} 骨架:${p.skeletonType || "?"}#${p.skeletonHash || "?"}\n${p.createdAt || ""}`;
      nameSpan.style.cssText =
        "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;cursor:pointer;";
      nameSpan.addEventListener("click", () => apply(p.id)); // 点名即应用
      row.appendChild(nameSpan);

      // 骨架类型徽标
      const badge = document.createElement("span");
      badge.textContent = (p.skeletonType || "?").toUpperCase();
      badge.style.cssText =
        "font-size:9px;color:#8a90a0;background:#1e2230;padding:1px 4px;border-radius:3px;flex-shrink:0;";
      row.appendChild(badge);

      // ▶ 应用
      row.appendChild(
        _rowBtn("▶", "应用该姿态到活动 3D角色", "applyPose", p.id, () => apply(p.id))
      );
      // ✏️ 重命名
      row.appendChild(
        _rowBtn("✏️", "重命名", "renamePose", p.id, () => {
          const n = prompt("新姿态名：", p.name);
          if (n && n.trim()) rename(p.id, n);
        })
      );
      // 🗑️ 删除
      row.appendChild(
        _rowBtn("🗑️", "删除该姿态", "deletePose", p.id, () => {
          if (confirm(`删除姿态「${p.name}」？`)) remove(p.id);
        })
      );

      listEl.appendChild(row);
    }
  }

  window.addEventListener("ds-pose-presets-changed", render);
  render();
  return { el, render };
}

/* ========================= 全局 API & 恢复钩子 ========================= */

window.__ds = window.__ds || {};
window.__ds.posePresets = { list, saveCurrent, apply, rename, remove, get, serialize, restore };

// 恢复路径 1：节点 init（postMessage type:"init" 携带 sceneJSON.posePresets）。
// 与 protocol.js 相同的过滤条件；本模块独立于 main.js，无需改动核心A/主流程。
window.addEventListener("message", (ev) => {
  if (ev.origin !== location.origin) return;
  const data = ev.data;
  if (!data || data.type !== "init") return;
  const p = data.payload || {};
  if (!p.sceneJSON) return;
  try {
    const sceneJSON = typeof p.sceneJSON === "string" ? JSON.parse(p.sceneJSON) : p.sceneJSON;
    if (Array.isArray(sceneJSON?.posePresets)) {
      restore(sceneJSON.posePresets);
    }
  } catch (e) {
    console.warn("[姿态预设] sceneJSON.posePresets 解析失败:", e);
  }
});

export {
  list,
  saveCurrent,
  apply,
  rename,
  remove,
  get,
  serialize,
  restore,
  POSE_TYPE,
};
