/**
 * trajectory-ui.js — 相机轨迹播放集成 + 时间轴/编辑 UI（波次2-C）
 *
 * 依据 DESIGN.md §3/§4/§6：
 *  - TrajectoryRuntime：{ playing, progress(0~1), camId } + play/pause/stop/seekTo(t01)
 *    renderLoop 插入点：boneEditor 之后、actionRuntime 之前（main.js 调 tick(dt)）
 *    播放中 orbit.enabled=false（防覆写），停止/暂停/切无轨迹机位时恢复
 *  - resolveTrack：character→角色骨盆(rigRoot)世界坐标，prop→道具包围盒中心
 *  - UI：顶栏「🎞️时间轴」按钮 ↔ 底部 #timeline-bar（播放/暂停/滑条/时间/轨迹点刻度）
 *    + 选中机位的轨迹编辑面板（记录点/点列表/全局设置/创建轨迹）
 *  - undo：独立 command 栈（栈深 50），与 undo.js v3 互不干扰
 *
 * 本文件自包含构建 DOM，不改动 index.html。
 */
import * as THREE from "three";
import { prepareTrajectory, evaluatePreparedTrajectory } from "./trajectory.js";

/* ==================== 数据工具 ==================== */

/** 默认轨迹数据（DESIGN §1） */
export function createDefaultTrajectory() {
  return {
    enabled: true,
    duration: 10,          // 秒，1~30
    curve: "smooth",       // "smooth" | "linear"
    speed: "uniform",      // "uniform" | "ease"
    fps: 24,               // 24 | 30
    points: [],
  };
}

function cloneTraj(traj) {
  if (!traj) return null;
  const { _rev, ...rest } = traj;
  return JSON.parse(JSON.stringify(rest));
}

/** 编辑后 bump 修订号（引擎 prepared 缓存失效）+ 广播变更 */
function touchTraj(traj) {
  if (traj) traj._rev = (traj._rev || 0) + 1;
  window.dispatchEvent(new CustomEvent("ds-trajectory-changed"));
}

let _pointSeq = 1;
function nextPointId() {
  return `p_${Date.now().toString(36)}_${_pointSeq++}`;
}

/* ==================== 播放运行时（DESIGN §3） ==================== */

/**
 * 相机轨迹运行时。状态 { playing, progress, camId }。
 * renderLoop 每帧调 tick(dt)（插入点：boneEditor 之后、actionRuntime 之前）。
 */
export function createTrajectoryRuntime({ cameraManager, orbit, externalManager, propManager }) {
  const _v = new THREE.Vector3();
  const _box = new THREE.Box3();

  const runtime = {
    playing: false,
    progress: 0,        // 0~1（在 duration 上归一）
    camId: null,        // 播放绑定的机位 id
    /** UI 更新回调（seek/play/pause/tick 后触发） */
    onUpdate: null,

    /** 跟踪目标实时世界坐标解析（DESIGN §2 resolveTrack 回调） */
    resolveTrack(track) {
      try {
        if (!track || !track.kind) return null;
        if (track.kind === "character") {
          const entry = externalManager?.get?.(track.id);
          // 骨盆（rigRoot），退化 joint 1（Neck）——与 main.js _rigRootBone 口径一致
          const bone = entry?.jointMap?.get?.("rigRoot") || entry?.jointMap?.get?.(1);
          if (!bone) return null;
          bone.getWorldPosition(_v);
          return [_v.x, _v.y, _v.z];
        }
        if (track.kind === "prop") {
          const p = propManager?.getProp?.(track.id);
          if (!p?.mesh) return null;
          _box.setFromObject(p.mesh);
          _box.getCenter(_v);
          return [_v.x, _v.y, _v.z];
        }
        return null;
      } catch {
        return null;
      }
    },

    /** 当前活动机位的启用轨迹（无/未启用/点数不足 → null） */
    _activeTraj() {
      const ac = cameraManager.getActiveCamera();
      const traj = ac?.trajectory;
      if (!ac || !traj || traj.enabled === false) return { ac, traj: null };
      return { ac, traj };
    },

    /** prepared 缓存（按 traj 对象 + _rev 失效） */
    _cache: { traj: null, rev: -1, prepared: null },
    _prepared(traj) {
      const rev = traj._rev || 0;
      if (this._cache.traj === traj && this._cache.rev === rev) return this._cache.prepared;
      const prepared = prepareTrajectory(traj);
      this._cache = { traj, rev, prepared };
      return prepared;
    },

    /**
     * 把 t01 处轨迹姿态应用到指定机位（写 position/lookAt/fov + updateProjectionMatrix，
     * 同步 entry.pos/target 活引用与 orbit.target，保证 orbit 恢复时朝向不跳变）。
     * @returns {{position:number[],target:number[],fov:number}|null}
     */
    _applyPose(ac, traj, t01) {
      const prepared = this._prepared(traj);
      if (!prepared) return null;
      const pose = evaluatePreparedTrajectory(prepared, t01, (tr) => this.resolveTrack(tr));
      if (!pose) return null;
      const cam = ac.camera;
      cam.position.set(pose.position[0], pose.position[1], pose.position[2]);
      cam.lookAt(pose.target[0], pose.target[1], pose.target[2]);
      if (Number.isFinite(pose.fov) && Math.abs(cam.fov - pose.fov) > 1e-6) {
        cam.fov = pose.fov;
      }
      cam.updateProjectionMatrix();
      // entry 活引用（renderLoop 第 4 步每帧也会写，但 seek 当帧必须立即正确）
      if (Array.isArray(ac.pos) && ac.pos.length === 3) {
        ac.pos[0] = pose.position[0]; ac.pos[1] = pose.position[1]; ac.pos[2] = pose.position[2];
      }
      if (Array.isArray(ac.target) && ac.target.length === 3) {
        ac.target[0] = pose.target[0]; ac.target[1] = pose.target[1]; ac.target[2] = pose.target[2];
      }
      // orbit.target 跟随轨迹目标——orbit.update 恢复时 lookAt 不跳变
      orbit?.target?.set?.(pose.target[0], pose.target[1], pose.target[2]);
      return pose;
    },

    /** 播放中禁用 orbit（保留原状态供恢复） */
    _lockOrbit() {
      if (!orbit) return;
      if (this._orbitSaved == null) {
        this._orbitSaved = orbit.enabled !== false;
      }
      orbit.enabled = false;
    },

    /** 停止/暂停/切机位时恢复 orbit */
    _unlockOrbit() {
      if (!orbit) return;
      if (this._orbitSaved != null) {
        orbit.enabled = this._orbitSaved;
        this._orbitSaved = null;
      } else {
        orbit.enabled = true;
      }
    },
    _orbitSaved: null,

    play() {
      const { ac, traj } = this._activeTraj();
      if (!ac || !traj || !this._prepared(traj)) return false;
      this.playing = true;
      this.camId = ac.id;
      this._lockOrbit();
      this._applyPose(ac, traj, this.progress);
      this._notify();
      return true;
    },

    pause() {
      if (!this.playing) return;
      this.playing = false;
      this._unlockOrbit();
      this._notify();
    },

    stop() {
      this.playing = false;
      this.progress = 0;
      this._unlockOrbit();
      const { ac, traj } = this._activeTraj();
      if (ac && traj) this._applyPose(ac, traj, 0);
      this._notify();
    },

    /**
     * 精确寻址（供导出逐帧调用）：设置 progress 并立即应用姿态。
     * 播放/暂停/停止状态均可调用；不改变 playing 标志。
     * @returns 应用的姿态 {position,target,fov} 或 null（无有效轨迹）
     */
    seekTo(t01) {
      const t = Math.max(0, Math.min(1, Number.isFinite(t01) ? t01 : 0));
      this.progress = t;
      const { ac, traj } = this._activeTraj();
      const pose = ac && traj ? this._applyPose(ac, traj, t) : null;
      this._notify();
      return pose;
    },

    /** renderLoop 每帧调用（boneEditor 之后、actionRuntime 之前） */
    tick(dt) {
      // 活动机位跟踪：播放中切走（或机位失去轨迹）→ 停止并恢复 orbit
      const ac = cameraManager.getActiveCamera();
      const id = ac?.id || null;
      if (id !== this._lastActiveId) {
        if (this.playing) {
          this.playing = false;
          this._unlockOrbit();
        }
        this._lastActiveId = id;
        window.dispatchEvent(new CustomEvent("ds-trajectory-activecam-changed", { detail: { camId: id } }));
      }
      if (!this.playing) return;
      const traj = ac?.trajectory;
      if (!ac || ac.id !== this.camId || !traj || traj.enabled === false || !this._prepared(traj)) {
        // 播放目标失效（切机位/禁用/删点）→ 停止并恢复 orbit
        this.playing = false;
        this._unlockOrbit();
        this._notify();
        return;
      }
      const dur = Number.isFinite(traj.duration) && traj.duration > 0 ? traj.duration : 10;
      this.progress += (Number.isFinite(dt) ? dt : 0.016) / dur;
      if (this.progress >= 1) {
        this.progress = 1;
        this._applyPose(ac, traj, 1);
        // 播放到头：停止并恢复 orbit（DESIGN §3「停止/拖到头：恢复 orbit」）
        this.playing = false;
        this._unlockOrbit();
      } else {
        this._applyPose(ac, traj, this.progress);
      }
      this._notify();
    },

    _lastActiveId: null,
    _notify() { try { this.onUpdate?.(); } catch { /* UI 回调容错 */ } },
  };
  return runtime;
}

/* ==================== 轨迹编辑独立 undo 栈（DESIGN §6） ==================== */

function createTrajUndoStack() {
  const undoStack = [];
  const redoStack = [];
  const MAX = 50;
  return {
    /** 记录一次编辑：before/after 均为轨迹深拷贝（或 null=无轨迹） */
    push(entry, before, after, label) {
      undoStack.push({ entry, before: cloneTraj(before), after: cloneTraj(after), label: label || "" });
      if (undoStack.length > MAX) undoStack.shift();
      redoStack.length = 0;
    },
    _apply(entry, snap) {
      entry.trajectory = cloneTraj(snap);
      touchTraj(entry.trajectory);
    },
    undo() {
      const cmd = undoStack.pop();
      if (!cmd) return false;
      this._apply(cmd.entry, cmd.before);
      redoStack.push(cmd);
      return true;
    },
    redo() {
      const cmd = redoStack.pop();
      if (!cmd) return false;
      this._apply(cmd.entry, cmd.after);
      undoStack.push(cmd);
      return true;
    },
    get depth() { return undoStack.length; },
    get redoDepth() { return redoStack.length; },
    clear() { undoStack.length = 0; redoStack.length = 0; },
  };
}

/* ==================== UI（DESIGN §4） ==================== */

/**
 * 构建时间轴 + 轨迹编辑面板（自包含 DOM）。
 * @returns {{ undo(), redo(), getUndoDepth(), refreshPanel(), toggleBar(), bar }}
 */
export function createTrajectoryUI({ runtime, cameraManager, propManager, externalManager, orbit, showToast }) {
  const toast = (msg, isErr) => { try { showToast?.(msg, isErr); } catch { console.log(msg); } };
  const undoStack = createTrajUndoStack();

  /* ---------- 顶栏按钮 ---------- */
  const tlBtn = document.createElement("button");
  tlBtn.id = "btnTimeline";
  tlBtn.textContent = "🎞️时间轴";
  tlBtn.title = "显示/隐藏相机轨迹时间轴";
  tlBtn.style.cssText = "padding:6px 10px;font-size:12px;";
  tlBtn.addEventListener("click", () => toggleBar());
  const btnCancel = document.getElementById("btnCancel");
  if (btnCancel) btnCancel.insertAdjacentElement("afterend", tlBtn);

  /* ---------- 底部时间轴 #timeline-bar ---------- */
  const bar = document.createElement("div");
  bar.id = "timeline-bar";
  bar.style.cssText = [
    "display:none", "flex:0 0 auto", "height:76px",
    "background:var(--panel,#171a22)", "border-top:1px solid var(--border,#2a2f3d)",
    "padding:6px 12px", "flex-direction:column", "gap:4px", "user-select:none",
  ].join(";");

  // 传输行：播放/暂停、停止、滑条、时间显示
  const transport = document.createElement("div");
  transport.style.cssText = "display:flex;align-items:center;gap:8px;";

  const playBtn = document.createElement("button");
  playBtn.id = "tl-play";
  playBtn.textContent = "▶️";
  playBtn.title = "播放/暂停当前机位轨迹";
  playBtn.style.cssText = "padding:4px 10px;font-size:13px;";
  playBtn.addEventListener("click", () => {
    if (runtime.playing) {
      runtime.pause();
    } else if (!runtime.play()) {
      toast("当前机位无启用轨迹（需 ≥2 个轨迹点）", false);
    }
    refreshTransport();
  });

  const stopBtn = document.createElement("button");
  stopBtn.id = "tl-stop";
  stopBtn.textContent = "⏹️";
  stopBtn.title = "停止并回到起点";
  stopBtn.style.cssText = "padding:4px 10px;font-size:13px;";
  stopBtn.addEventListener("click", () => { runtime.stop(); refreshTransport(); });

  const sliderWrap = document.createElement("div");
  sliderWrap.style.cssText = "flex:1;position:relative;display:flex;align-items:center;";
  const slider = document.createElement("input");
  slider.id = "tl-slider";
  slider.type = "range";
  slider.min = "0";
  slider.max = "1000";
  slider.value = "0";
  slider.style.cssText = "width:100%;accent-color:#2f9e63;";
  slider.addEventListener("input", () => {
    runtime.seekTo(parseInt(slider.value, 10) / 1000);
    refreshTransport();
  });
  sliderWrap.appendChild(slider);

  const timeLabel = document.createElement("span");
  timeLabel.id = "tl-time";
  timeLabel.style.cssText = "font-size:11px;color:#8a90a0;min-width:86px;text-align:right;";
  timeLabel.textContent = "0.0s / 0s";

  transport.appendChild(playBtn);
  transport.appendChild(stopBtn);
  transport.appendChild(sliderWrap);
  transport.appendChild(timeLabel);
  bar.appendChild(transport);

  // 轨迹点刻度行（点击跳转 seek）
  const ticksRow = document.createElement("div");
  ticksRow.id = "tl-ticks";
  ticksRow.style.cssText = "position:relative;height:14px;margin:0 2px;";
  bar.appendChild(ticksRow);

  document.body.appendChild(bar);

  /* ---------- 轨迹编辑面板（选中机位时） ---------- */
  const panel = document.createElement("div");
  panel.id = "trajectory-panel";
  panel.style.cssText = [
    "display:none", "position:fixed", "right:12px", "top:60px", "width:268px",
    "max-height:72vh", "overflow-y:auto", "z-index:9000",
    "background:var(--panel,#171a22)", "border:1px solid var(--border,#2a2f3d)",
    "border-radius:8px", "padding:10px 12px", "font-size:12px",
    "box-shadow:0 8px 32px rgba(0,0,0,0.5)",
  ].join(";");
  document.body.appendChild(panel);

  /* ---------- 显隐切换 ---------- */
  let barVisible = false;
  function toggleBar(force) {
    barVisible = force !== undefined ? !!force : !barVisible;
    bar.style.display = barVisible ? "flex" : "none";
    panel.style.display = barVisible ? "block" : "none";
    tlBtn.style.background = barVisible ? "#2f9e6340" : "";
    if (barVisible) {
      refreshTransport();
      refreshPanel();
    }
    // 底部栏改变布局高度 → 触发视口信箱重排
    try { window.dispatchEvent(new Event("resize")); } catch { /* 忽略 */ }
    if (window.__ds_layoutCanvas) { try { window.__ds_layoutCanvas(); } catch { /* 忽略 */ } }
  }

  /* ---------- 传输控件刷新 ---------- */
  function refreshTransport() {
    playBtn.textContent = runtime.playing ? "⏸️" : "▶️";
    if (document.activeElement !== slider) {
      slider.value = String(Math.round(runtime.progress * 1000));
    }
    const ac = cameraManager.getActiveCamera();
    const dur = ac?.trajectory && Number.isFinite(ac.trajectory.duration) ? ac.trajectory.duration : 0;
    timeLabel.textContent = `${(runtime.progress * dur).toFixed(1)}s / ${dur}s`;
    refreshTicks();
  }

  /** 轨迹点刻度：按 time 归一位置画点，点击 seek 跳转 */
  function refreshTicks() {
    ticksRow.innerHTML = "";
    const ac = cameraManager.getActiveCamera();
    const traj = ac?.trajectory;
    if (!traj || !Array.isArray(traj.points)) return;
    for (const p of traj.points) {
      if (!Number.isFinite(p?.time)) continue;
      const dot = document.createElement("div");
      dot.title = `轨迹点 ${p.id || ""} @ t=${p.time.toFixed(2)}（点击跳转）`;
      dot.style.cssText = [
        "position:absolute", `left:${(Math.max(0, Math.min(1, p.time)) * 100).toFixed(2)}%`,
        "top:3px", "width:8px", "height:8px", "margin-left:-4px",
        "border-radius:50%", "background:#e8962f", "cursor:pointer",
        "border:1px solid #0b0d12",
      ].join(";");
      dot.addEventListener("click", () => {
        runtime.seekTo(Math.max(0, Math.min(1, p.time)));
        refreshTransport();
      });
      ticksRow.appendChild(dot);
    }
  }

  /* ---------- 编辑操作（全部走 undo 栈） ---------- */

  function activeEntry() { return cameraManager.getActiveCamera(); }

  function mutate(label, fn) {
    const entry = activeEntry();
    if (!entry) return;
    const before = cloneTraj(entry.trajectory);
    fn();
    touchTraj(entry.trajectory);
    undoStack.push(entry, before, entry.trajectory, label);
    refreshPanel();
    refreshTransport();
  }

  function createTrajectoryForActive() {
    const entry = activeEntry();
    if (!entry) return;
    if (entry.trajectory) { toast("该机位已有轨迹", false); return; }
    mutate("创建轨迹", () => { entry.trajectory = createDefaultTrajectory(); });
    toast("🎞️ 已为当前机位创建轨迹", false);
  }

  function recordPoint() {
    const entry = activeEntry();
    if (!entry?.trajectory) return;
    mutate("记录轨迹点", () => {
      const traj = entry.trajectory;
      const pts = traj.points;
      // 时间：优先当前播放进度（须大于末点时间），否则末点 +0.2，钳制到 1
      let time;
      if (pts.length === 0) {
        time = 0;
      } else {
        const lastT = Math.max(...pts.map((p) => (Number.isFinite(p.time) ? p.time : 0)));
        time = runtime.progress > lastT + 1e-3 ? runtime.progress : Math.min(1, lastT + 0.2);
      }
      pts.push({
        id: nextPointId(),
        position: entry.camera.position.toArray(),
        target: orbit ? orbit.target.toArray() : [0, 1, 0],
        fov: entry.camera.fov,
        time: Math.max(0, Math.min(1, time)),
        track: null,
      });
    });
    toast("📍 已记录当前机位为轨迹点", false);
  }

  function deletePoint(idx) {
    mutate("删除轨迹点", () => { activeEntry().trajectory.points.splice(idx, 1); });
  }

  function movePoint(idx, dir) {
    mutate("移动轨迹点", () => {
      const pts = activeEntry().trajectory.points;
      const j = idx + dir;
      if (j < 0 || j >= pts.length) return;
      [pts[idx], pts[j]] = [pts[j], pts[idx]];
    });
  }

  function updatePoint(idx, patch) {
    mutate("修改轨迹点", () => {
      Object.assign(activeEntry().trajectory.points[idx], patch);
    });
  }

  function updateGlobals(patch) {
    mutate("修改轨迹设置", () => {
      Object.assign(activeEntry().trajectory, patch);
    });
  }

  /* ---------- 编辑面板刷新 ---------- */

  function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  const btnCss = "padding:4px 8px;font-size:11px;";
  const inputCss = "width:56px;background:#232836;border:1px solid #2a2f3d;color:#e6e9f0;border-radius:4px;padding:2px 4px;font-size:11px;";
  const selectCss = "background:#232836;border:1px solid #2a2f3d;color:#e6e9f0;border-radius:4px;padding:2px 4px;font-size:11px;max-width:110px;";

  function buildTrackOptions(selected) {
    const frag = document.createDocumentFragment();
    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = "静态目标";
    frag.appendChild(opt0);
    for (const c of externalManager?.getAll?.() || []) {
      const o = document.createElement("option");
      o.value = `character:${c.id}`;
      o.textContent = `🧍 ${c.name || c.id}`;
      frag.appendChild(o);
    }
    for (const p of propManager?.props || []) {
      const o = document.createElement("option");
      o.value = `prop:${p.id}`;
      o.textContent = `🧱 ${p.name || p.id}`;
      frag.appendChild(o);
    }
    const cur = selected ? `${selected.kind}:${selected.id}` : "";
    // 目标已删除时仍保留一个占位项，避免 select 静默改变语义
    if (selected && ![...frag.children].some((o) => o.value === cur)) {
      const o = document.createElement("option");
      o.value = cur;
      o.textContent = `⚠️ 已失效 ${selected.id}`;
      frag.appendChild(o);
    }
    return { frag, cur };
  }

  function refreshPanel() {
    panel.innerHTML = "";
    const entry = activeEntry();
    const title = el("div", "font-weight:600;font-size:13px;margin-bottom:8px;",
      `🎞️ 轨迹编辑 — ${entry?.name || "无机位"}`);
    panel.appendChild(title);
    if (!entry) return;

    if (!entry.trajectory) {
      const createBtn = el("button", btnCss + "width:100%;", "➕ 为此机位创建轨迹");
      createBtn.addEventListener("click", createTrajectoryForActive);
      panel.appendChild(createBtn);
      return;
    }

    const traj = entry.trajectory;

    // ── 操作行：记录点 / undo / redo ──
    const row1 = el("div", "display:flex;gap:4px;margin-bottom:8px;");
    const recBtn = el("button", btnCss + "flex:1;", "📍 记录当前机位为轨迹点");
    recBtn.addEventListener("click", recordPoint);
    const undoBtn = el("button", btnCss, "↩️");
    undoBtn.title = "撤销轨迹编辑（独立栈）";
    undoBtn.disabled = undoStack.depth === 0;
    undoBtn.addEventListener("click", () => { undoStack.undo(); refreshPanel(); refreshTransport(); });
    const redoBtn = el("button", btnCss, "↪️");
    redoBtn.title = "重做轨迹编辑";
    redoBtn.disabled = undoStack.redoDepth === 0;
    redoBtn.addEventListener("click", () => { undoStack.redo(); refreshPanel(); refreshTransport(); });
    row1.appendChild(recBtn);
    row1.appendChild(undoBtn);
    row1.appendChild(redoBtn);
    panel.appendChild(row1);

    // ── 全局设置：enabled / duration / curve / speed / fps ──
    const grid = el("div", "display:grid;grid-template-columns:auto 1fr auto 1fr;gap:4px 6px;align-items:center;margin-bottom:8px;");

    grid.appendChild(el("span", "color:#8a90a0;", "启用"));
    const enCb = document.createElement("input");
    enCb.type = "checkbox";
    enCb.checked = traj.enabled !== false;
    enCb.style.cssText = "accent-color:#2f9e63;";
    enCb.addEventListener("change", () => updateGlobals({ enabled: enCb.checked }));
    grid.appendChild(enCb);

    grid.appendChild(el("span", "color:#8a90a0;", "时长(s)"));
    const durIn = document.createElement("input");
    durIn.type = "number"; durIn.min = "1"; durIn.max = "30"; durIn.step = "0.5";
    durIn.value = String(traj.duration ?? 10);
    durIn.style.cssText = inputCss;
    durIn.addEventListener("change", () => {
      const v = Math.max(1, Math.min(30, parseFloat(durIn.value) || 10));
      durIn.value = String(v);
      updateGlobals({ duration: v });
    });
    grid.appendChild(durIn);

    grid.appendChild(el("span", "color:#8a90a0;", "曲线"));
    const curveSel = document.createElement("select");
    curveSel.style.cssText = selectCss;
    for (const [v, t] of [["smooth", "平滑"], ["linear", "线性"]]) {
      const o = document.createElement("option"); o.value = v; o.textContent = t; curveSel.appendChild(o);
    }
    curveSel.value = traj.curve === "linear" ? "linear" : "smooth";
    curveSel.addEventListener("change", () => updateGlobals({ curve: curveSel.value }));
    grid.appendChild(curveSel);

    grid.appendChild(el("span", "color:#8a90a0;", "速度"));
    const speedSel = document.createElement("select");
    speedSel.style.cssText = selectCss;
    for (const [v, t] of [["uniform", "匀速"], ["ease", "缓动"]]) {
      const o = document.createElement("option"); o.value = v; o.textContent = t; speedSel.appendChild(o);
    }
    speedSel.value = traj.speed === "ease" ? "ease" : "uniform";
    speedSel.addEventListener("change", () => updateGlobals({ speed: speedSel.value }));
    grid.appendChild(speedSel);

    grid.appendChild(el("span", "color:#8a90a0;", "FPS"));
    const fpsSel = document.createElement("select");
    fpsSel.style.cssText = selectCss;
    for (const v of [24, 30]) {
      const o = document.createElement("option"); o.value = String(v); o.textContent = `${v}`; fpsSel.appendChild(o);
    }
    fpsSel.value = String(traj.fps === 30 ? 30 : 24);
    fpsSel.addEventListener("change", () => updateGlobals({ fps: parseInt(fpsSel.value, 10) }));
    grid.appendChild(fpsSel);

    panel.appendChild(grid);

    // ── 轨迹点列表 ──
    const listHead = el("div", "color:#8a90a0;font-size:11px;margin:4px 0;",
      `轨迹点（${traj.points.length}${traj.points.length < 2 ? "，≥2 才可播放" : ""}）`);
    panel.appendChild(listHead);

    traj.points.forEach((p, idx) => {
      const row = el("div", "display:flex;align-items:center;gap:4px;padding:3px 0;border-top:1px solid #2a2f3d;");

      // 时间
      const tIn = document.createElement("input");
      tIn.type = "number"; tIn.min = "0"; tIn.max = "1"; tIn.step = "0.01";
      tIn.value = Number.isFinite(p.time) ? p.time.toFixed(2) : "0.00";
      tIn.title = "归一化时间 0~1";
      tIn.style.cssText = inputCss + "width:48px;";
      tIn.addEventListener("change", () => {
        const v = Math.max(0, Math.min(1, parseFloat(tIn.value) || 0));
        updatePoint(idx, { time: v });
      });
      row.appendChild(tIn);

      // FOV
      const fovIn = document.createElement("input");
      fovIn.type = "number"; fovIn.min = "5"; fovIn.max = "120"; fovIn.step = "1";
      fovIn.value = String(Number.isFinite(p.fov) ? Math.round(p.fov) : 50);
      fovIn.title = "FOV（度）";
      fovIn.style.cssText = inputCss + "width:44px;";
      fovIn.addEventListener("change", () => {
        const v = Math.max(5, Math.min(120, parseFloat(fovIn.value) || 50));
        updatePoint(idx, { fov: v });
      });
      row.appendChild(fovIn);

      // 跟踪目标下拉（场景角色 + 道具）
      const sel = document.createElement("select");
      sel.style.cssText = selectCss + "flex:1;min-width:0;";
      sel.title = "跟踪目标（播放时每帧取实时坐标）";
      const { frag, cur } = buildTrackOptions(p.track);
      sel.appendChild(frag);
      sel.value = cur;
      sel.addEventListener("change", () => {
        const v = sel.value;
        updatePoint(idx, { track: v ? { kind: v.split(":")[0], id: v.slice(v.indexOf(":") + 1) } : null });
      });
      row.appendChild(sel);

      // 上移 / 下移 / 删除
      const upBtn = el("button", btnCss + "padding:2px 5px;", "↑");
      upBtn.disabled = idx === 0;
      upBtn.addEventListener("click", () => movePoint(idx, -1));
      const downBtn = el("button", btnCss + "padding:2px 5px;", "↓");
      downBtn.disabled = idx === traj.points.length - 1;
      downBtn.addEventListener("click", () => movePoint(idx, 1));
      const delBtn = el("button", btnCss + "padding:2px 5px;", "✕");
      delBtn.title = "删除轨迹点";
      delBtn.addEventListener("click", () => deletePoint(idx));
      row.appendChild(upBtn);
      row.appendChild(downBtn);
      row.appendChild(delBtn);

      panel.appendChild(row);
    });
  }

  /* ---------- 事件联动 ---------- */
  runtime.onUpdate = () => { if (barVisible) refreshTransport(); };
  window.addEventListener("ds-trajectory-activecam-changed", () => {
    if (barVisible) { refreshPanel(); refreshTransport(); }
  });
  window.addEventListener("ds-trajectory-changed", () => {
    if (barVisible) { refreshPanel(); refreshTransport(); }
  });
  window.addEventListener("ds-project-loaded", () => {
    undoStack.clear(); // 工程切换后旧轨迹快照失效
    if (barVisible) { refreshPanel(); refreshTransport(); }
  });
  window.addEventListener("ds-char-changed", () => { if (barVisible) refreshPanel(); });

  return {
    toggleBar,
    refreshPanel,
    refreshTransport,
    undo: () => { const ok = undoStack.undo(); if (barVisible) { refreshPanel(); refreshTransport(); } return ok; },
    redo: () => { const ok = undoStack.redo(); if (barVisible) { refreshPanel(); refreshTransport(); } return ok; },
    getUndoDepth: () => undoStack.depth,
    getRedoDepth: () => undoStack.redoDepth,
    /** 测试钩子：直接调用编辑操作 */
    _ops: { createTrajectoryForActive, recordPoint, deletePoint, movePoint, updatePoint, updateGlobals, mutate },
    bar,
    panel,
  };
}
