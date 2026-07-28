/**
 * camera-operator.js — V2-F1 WASD 掌镜打点（Pointer Lock 掌镜模式）
 *
 * 依据 DESIGN-V2.md F1 + research-3ddd.md §3（CameraPilotController 移植）：
 *  - 顶栏「🎥 掌镜」→ requestPointerLock；鼠标转视角（Euler YXZ，灵敏度持久化）
 *  - WASD 平移 + E/Q 升降（速度可调持久化）；滚轮调 FOV（与 focalMM 换算一致）
 *  - Enter 打点：采样 pos/target(视线前方~5m)/fov → 调 V1 轨迹 UI _ops 追加轨迹点
 *    （无轨迹自动创建；时间均分 retime time=i/(n-1)）；HUD 反馈"已记录轨迹点 N"
 *  - F 锁定/解锁：准星 raycast 角色(hit-proxy/model)/道具 → 锁定时打点 track=目标；
 *    锁定中进入球坐标环绕（鼠标/A/D=绕轨、W/S=推拉半径、E/Q=升降），始终 lookAt 目标
 *  - 空格：播放/暂停场景角色动作（复用 actionRuntime pause/resume）
 *  - 掌镜全程 orbit.enabled=false，退出恢复原值；Esc/丢锁/再点按钮退出
 *  - 准星 HUD：十字线 + 底部提示条（按键说明/锁定状态/轨迹点数）
 *  - Pointer Lock 不可用（headless 等）时优雅降级：console.warn + 键盘/HUD 仍可用，
 *    仅鼠标转视角失效（degraded 标志，__ds.cameraOperator.isDegraded() 可查）
 *
 * __ds 钩子：__ds.cameraOperator = { enter, exit, isActive, lockedTarget, ... }
 * 本文件自包含构建 DOM（按钮 + HUD），不改动 index.html。
 */
import * as THREE from "three";
import { vFovToFocalMM } from "./cameras.js";

/* ==================== 常量 / 持久化 ==================== */

const LS_SPEED = "ds.pilot.speed";
const LS_SENS = "ds.pilot.sensitivity";
const DEFAULT_SPEED = 4;          // m/s
const DEFAULT_SENS = 0.0022;      // rad/px
const PITCH_LIMIT = Math.PI / 2 - 0.025;
const TARGET_DISTANCE = 5;        // 打点 target = 视线前方 ~5m
const FOV_MIN = 10;
const FOV_MAX = 120;

function loadNum(key, fallback, min, max) {
  try {
    const v = parseFloat(localStorage.getItem(key));
    if (Number.isFinite(v)) return Math.max(min, Math.min(max, v));
  } catch { /* localStorage 不可用（隐私模式等） */ }
  return fallback;
}
function saveNum(key, v) {
  try { localStorage.setItem(key, String(v)); } catch { /* 忽略 */ }
}

let _pilotPointSeq = 1;
function nextPilotPointId() {
  return `p_pilot_${Date.now().toString(36)}_${_pilotPointSeq++}`;
}

/* ==================== 工厂 ==================== */

/**
 * @param {object} deps
 * @param {THREE.Scene} deps.scene
 * @param {object} deps.cameraManager
 * @param {object} deps.orbit — OrbitControls
 * @param {object} deps.externalManager
 * @param {object} deps.propManager
 * @param {object} deps.actionRuntime
 * @param {object} deps.trajectoryRuntime — 复用其 resolveTrack（与轨迹播放同口径）
 * @param {() => object|null} deps.getTrajectoryUI — V1 轨迹 UI（_ops.mutate 打点走 undo 栈）
 * @param {HTMLElement} deps.dom — 视口 canvas（pointer lock 目标）
 * @param {HTMLElement} deps.viewportEl — HUD 挂载容器
 * @param {(msg:string,isErr?:boolean)=>void} [deps.showToast]
 */
export function createCameraOperator(deps) {
  const {
    scene, cameraManager, orbit, externalManager, propManager,
    actionRuntime, trajectoryRuntime, getTrajectoryUI, dom, viewportEl, showToast,
  } = deps;
  const toast = (msg, isErr) => { try { showToast?.(msg, isErr); } catch { console.log(msg); } };

  /* ---------- 状态 ---------- */
  let active = false;
  let degraded = false;          // pointer lock 不可用（headless 等）
  let _lockEverAcquired = false;
  let yaw = 0;
  let pitch = 0;
  let speed = loadNum(LS_SPEED, DEFAULT_SPEED, 0.5, 40);
  let sensitivity = loadNum(LS_SENS, DEFAULT_SENS, 0.0005, 0.01);
  const keys = new Set();
  let locked = null;             // { kind, id, name, center:V3, radius, theta, phi }
  let _savedOrbitEnabled = null;
  let _lockDetectTimer = null;

  const _euler = new THREE.Euler(0, 0, 0, "YXZ");
  const _quat = new THREE.Quaternion();
  const _fwd = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _move = new THREE.Vector3();
  const _v1 = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _sph = new THREE.Spherical();
  const _ray = new THREE.Raycaster();
  const _ndcCenter = new THREE.Vector2(0, 0);

  /* ==================== HUD ==================== */

  const hud = document.createElement("div");
  hud.id = "pilot-hud";
  hud.style.cssText = [
    "display:none", "position:absolute", "inset:0", "pointer-events:none", "z-index:60",
  ].join(";");

  // 十字线（两细条 + 中心点）
  const cross = document.createElement("div");
  cross.id = "pilot-crosshair";
  cross.style.cssText = "position:absolute;left:50%;top:50%;width:0;height:0;";
  const crossH = document.createElement("div");
  crossH.style.cssText = "position:absolute;left:-11px;top:0;width:22px;height:1.5px;background:rgba(255,255,255,0.85);box-shadow:0 0 2px #000;";
  const crossV = document.createElement("div");
  crossV.style.cssText = "position:absolute;top:-11px;left:0;height:22px;width:1.5px;background:rgba(255,255,255,0.85);box-shadow:0 0 2px #000;";
  const crossDot = document.createElement("div");
  crossDot.style.cssText = "position:absolute;left:-1.5px;top:-1.5px;width:3px;height:3px;border-radius:50%;background:#e8962f;";
  cross.appendChild(crossH);
  cross.appendChild(crossV);
  cross.appendChild(crossDot);
  hud.appendChild(cross);

  // 锁定目标名（准星上方）
  const lockLabel = document.createElement("div");
  lockLabel.id = "pilot-lock-label";
  lockLabel.style.cssText = [
    "position:absolute", "left:50%", "top:calc(50% - 44px)", "transform:translateX(-50%)",
    "font-size:12px", "color:#e8962f", "text-shadow:0 0 4px #000", "display:none",
  ].join(";");
  hud.appendChild(lockLabel);

  // 打点/操作反馈（底部提示条上方，自动淡出）
  const flashEl = document.createElement("div");
  flashEl.id = "pilot-flash";
  flashEl.style.cssText = [
    "position:absolute", "left:50%", "bottom:64px", "transform:translateX(-50%)",
    "font-size:14px", "font-weight:600", "color:#2f9e63", "text-shadow:0 0 6px #000",
    "opacity:0", "transition:opacity 0.25s",
  ].join(";");
  hud.appendChild(flashEl);
  let _flashTimer = null;
  function flash(msg) {
    flashEl.textContent = msg;
    flashEl.style.opacity = "1";
    if (_flashTimer) clearTimeout(_flashTimer);
    _flashTimer = setTimeout(() => { flashEl.style.opacity = "0"; }, 1400);
  }

  // 底部提示条
  const hintBar = document.createElement("div");
  hintBar.id = "pilot-hint";
  hintBar.style.cssText = [
    "position:absolute", "left:50%", "bottom:14px", "transform:translateX(-50%)",
    "max-width:92%", "padding:6px 14px", "border-radius:6px",
    "background:rgba(10,12,18,0.72)", "border:1px solid rgba(255,255,255,0.12)",
    "font-size:12px", "color:#c9cfdd", "white-space:nowrap", "overflow:hidden",
  ].join(";");
  hud.appendChild(hintBar);

  (viewportEl || document.body).appendChild(hud);
  if (viewportEl) viewportEl.style.position = viewportEl.style.position || "relative";

  function refreshHint() {
    const ac = cameraManager?.getActiveCamera?.();
    const n = ac?.trajectory?.points?.length ?? 0;
    const lockTxt = locked ? `🎯 锁定 ${locked.name}` : "F 锁定目标";
    const degTxt = degraded ? "｜⚠️ 无指针锁(降级)" : "";
    hintBar.textContent =
      `WASD 平移｜E/Q 升降｜滚轮 FOV｜Enter 打点｜${lockTxt}｜空格 动作｜` +
      `PgUp/PgDn 速度 ${speed.toFixed(1)}m/s｜[/] 灵敏度｜Esc 退出｜轨迹点 ${n}${degTxt}`;
  }

  /* ==================== 顶栏按钮 ==================== */

  const btn = document.createElement("button");
  btn.id = "btnPilot";
  btn.textContent = "🎥 掌镜";
  btn.title = "WASD 掌镜模式（打点/跟拍）";
  btn.style.cssText = "padding:6px 10px;font-size:12px;";
  btn.addEventListener("click", () => (active ? exit() : enter()));
  const anchor = document.getElementById("btnTimeline") || document.getElementById("btnCancel");
  if (anchor) anchor.insertAdjacentElement("afterend", btn);

  /* ==================== 视角/位姿工具 ==================== */

  function activeCam() {
    const ac = cameraManager?.getActiveCamera?.();
    return ac?.camera || null;
  }

  /** 从相机当前姿态初始化 yaw/pitch（无缝接管） */
  function syncAnglesFromCamera(cam) {
    _euler.setFromQuaternion(cam.quaternion, "YXZ");
    yaw = _euler.y;
    pitch = _euler.x;
  }

  /** 视线前方 target 写入 orbit.target（renderLoop 每帧把 orbit.target 抄进 ac.target；退出也不跳变） */
  function syncOrbitTarget(cam) {
    if (!orbit?.target) return;
    if (locked) {
      orbit.target.copy(locked.center);
    } else {
      cam.getWorldDirection(_fwd);
      orbit.target.copy(cam.position).addScaledVector(_fwd, TARGET_DISTANCE);
    }
  }

  /* ==================== 锁定（F） ==================== */

  /** 准星 raycast：角色（hit-proxy / model 子树）+ 道具（userData.propId） */
  function pickCenterTarget() {
    const cam = activeCam();
    if (!cam) return null;
    _ray.setFromCamera(_ndcCenter, cam);

    const candidates = [];
    const proxyGroup = scene?.getObjectByName?.("ExtChar_HitProxies");
    if (proxyGroup) candidates.push(...proxyGroup.children);
    for (const entry of externalManager?.getAll?.() || []) {
      if (entry?.model && entry.visible !== false && entry.model.visible !== false) {
        candidates.push(entry.model);
      }
    }
    for (const p of propManager?.props || []) {
      if (p?.mesh && p.mesh.visible !== false) candidates.push(p.mesh);
    }
    if (!candidates.length) return null;

    const hits = _ray.intersectObjects(candidates, true);
    if (!hits.length) return null;

    // 命中对象向上找归属
    let obj = hits[0].object;
    while (obj) {
      if (obj.userData?.externalCharId) {
        const entry = externalManager?.get?.(obj.userData.externalCharId);
        if (entry) return { kind: "character", id: entry.id, name: entry.name || entry.id };
      }
      if (obj.userData?.propId) {
        const p = propManager?.getProp?.(obj.userData.propId);
        if (p) return { kind: "prop", id: p.id, name: p.name || p.id };
      }
      // model 子树兜底（SkinnedMesh 绑定姿势命中等场景）
      for (const entry of externalManager?.getAll?.() || []) {
        if (entry?.model === obj) return { kind: "character", id: entry.id, name: entry.name || entry.id };
      }
      for (const p of propManager?.props || []) {
        if (p?.mesh === obj) return { kind: "prop", id: p.id, name: p.name || p.id };
      }
      obj = obj.parent;
    }
    return null;
  }

  /** 解析锁定目标实时世界坐标（与轨迹播放同口径：角色骨盆 / 道具包围盒中心） */
  function resolveLockedCenter(out) {
    if (!locked) return null;
    const pos = trajectoryRuntime?.resolveTrack?.({ kind: locked.kind, id: locked.id });
    if (!pos) return null;
    return out.set(pos[0], pos[1], pos[2]);
  }

  function toggleLock() {
    if (locked) {
      locked = null;
      lockLabel.style.display = "none";
      // 解锁后以当前相机朝向继续自由飞
      const cam = activeCam();
      if (cam) syncAnglesFromCamera(cam);
      flash("🔓 已解锁");
      refreshHint();
      return;
    }
    const hit = pickCenterTarget();
    if (!hit) {
      flash("✕ 准星未命中角色/道具");
      return;
    }
    const cam = activeCam();
    if (!cam) return;
    locked = { ...hit, center: new THREE.Vector3(), radius: 3, theta: 0, phi: Math.PI / 2 };
    if (!resolveLockedCenter(locked.center)) {
      locked = null;
      flash("✕ 目标坐标解析失败");
      return;
    }
    // 由当前相机相对目标的偏移初始化球坐标（无缝进入环绕）
    _v1.copy(cam.position).sub(locked.center);
    _sph.setFromVector3(_v1);
    locked.radius = Math.max(0.3, _sph.radius);
    locked.phi = Math.max(0.05, Math.min(Math.PI - 0.05, _sph.phi));
    locked.theta = _sph.theta;
    lockLabel.textContent = `🎯 ${locked.name}`;
    lockLabel.style.display = "block";
    flash(`🔒 锁定 ${locked.name}`);
    refreshHint();
  }

  /* ==================== 打点（Enter） ==================== */

  function recordPoint() {
    const ac = cameraManager?.getActiveCamera?.();
    const trajUI = getTrajectoryUI?.();
    if (!ac || !trajUI?._ops) {
      console.warn("[掌镜] 无机位或轨迹 UI 未就绪，打点失败");
      return false;
    }
    // 当前机位无轨迹时自动创建
    if (!ac.trajectory) trajUI._ops.createTrajectoryForActive();
    if (!ac.trajectory) return false;

    const cam = ac.camera;
    cam.getWorldDirection(_fwd);
    _v1.copy(cam.position).addScaledVector(_fwd, TARGET_DISTANCE);
    const track = locked ? { kind: locked.kind, id: locked.id } : null;
    const point = {
      id: nextPilotPointId(),
      position: cam.position.toArray(),
      target: [_v1.x, _v1.y, _v1.z],
      fov: cam.fov,
      time: 0,
      track,
    };
    let count = 0;
    trajUI._ops.mutate("掌镜打点", () => {
      const pts = ac.trajectory.points;
      pts.push(point);
      // 时间均分（DESIGN-V2：V2 用均分，time = i/(n-1)）
      const n = pts.length;
      pts.forEach((p, i) => { p.time = n > 1 ? i / (n - 1) : 0; });
      count = n;
    });
    flash(`📍 已记录轨迹点 ${count}`);
    refreshHint();
    return true;
  }

  /* ==================== 动作 播放/暂停（空格） ==================== */

  function toggleActions() {
    const chars = externalManager?.getAll?.() || [];
    if (!chars.length || !actionRuntime) {
      flash("✕ 场景无角色");
      return;
    }
    const anyPlaying = chars.some((c) => actionRuntime.isPlaying?.(c.id));
    let changed = 0;
    if (anyPlaying) {
      for (const c of chars) if (actionRuntime.pause?.(c.id)) changed++;
      if (changed) flash(`⏸️ 已暂停 ${changed} 个角色动作`);
    } else {
      for (const c of chars) if (actionRuntime.resume?.(c.id)) changed++;
      if (changed) flash(`▶️ 已恢复 ${changed} 个角色动作`);
      else flash("✕ 无可恢复的动作");
    }
  }

  /* ==================== 事件处理 ==================== */

  function isTypingTarget(t) {
    if (!t) return false;
    const tag = t.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
  }

  function onMouseMove(e) {
    if (!active) return;
    // 未持有指针锁（降级模式/锁未生效）时鼠标不转视角
    if (document.pointerLockElement !== dom) return;
    const mx = e.movementX || 0;
    const my = e.movementY || 0;
    if (locked) {
      locked.theta -= mx * sensitivity;
      locked.phi = Math.max(0.05, Math.min(Math.PI - 0.05, locked.phi - my * sensitivity));
    } else {
      yaw -= mx * sensitivity;
      pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch - my * sensitivity));
    }
  }

  function onWheel(e) {
    if (!active) return;
    e.preventDefault();
    const cam = activeCam();
    if (!cam) return;
    // deltaY×0.006，单帧 clamp ±0.6°（research §3）
    const d = Math.max(-0.6, Math.min(0.6, (e.deltaY || 0) * 0.006));
    cam.fov = Math.max(FOV_MIN, Math.min(FOV_MAX, cam.fov + d));
    cam.updateProjectionMatrix();
    // 与相机 focalMM 换算口径保持一致（cameras.js vFovToFocalMM）
    const ac = cameraManager?.getActiveCamera?.();
    if (ac) ac.focalMM = Math.round(vFovToFocalMM(cam.fov) * 10) / 10;
  }

  function onKeyDown(e) {
    if (!active) return;
    if (isTypingTarget(e.target)) return;
    switch (e.code) {
      case "KeyW": case "KeyA": case "KeyS": case "KeyD":
      case "KeyE": case "KeyQ":
        keys.add(e.code);
        e.preventDefault();
        break;
      case "Enter":
        e.preventDefault();
        if (!e.repeat) recordPoint();
        break;
      case "KeyF":
        e.preventDefault();
        if (!e.repeat) toggleLock();
        break;
      case "Space":
        e.preventDefault();
        if (!e.repeat) toggleActions();
        break;
      case "Escape":
        // 真实浏览器：指针锁下 Esc 被浏览器消费并丢锁 → pointerlockchange → exit；
        // 合成事件/降级模式：Esc 直达本处理器 → 直接 exit。两条路径都覆盖。
        e.preventDefault();
        if (!e.repeat) exit();
        break;
      case "PageUp":
        e.preventDefault();
        speed = Math.min(40, Math.round((speed + 0.5) * 10) / 10);
        saveNum(LS_SPEED, speed);
        flash(`速度 ${speed.toFixed(1)} m/s`);
        refreshHint();
        break;
      case "PageDown":
        e.preventDefault();
        speed = Math.max(0.5, Math.round((speed - 0.5) * 10) / 10);
        saveNum(LS_SPEED, speed);
        flash(`速度 ${speed.toFixed(1)} m/s`);
        refreshHint();
        break;
      case "BracketLeft":
        sensitivity = Math.max(0.0005, sensitivity / 1.2);
        saveNum(LS_SENS, sensitivity);
        flash(`灵敏度 ${(sensitivity * 1000).toFixed(1)}`);
        break;
      case "BracketRight":
        sensitivity = Math.min(0.01, sensitivity * 1.2);
        saveNum(LS_SENS, sensitivity);
        flash(`灵敏度 ${(sensitivity * 1000).toFixed(1)}`);
        break;
      default:
        break;
    }
  }

  function onKeyUp(e) {
    if (keys.has(e.code)) keys.delete(e.code);
  }

  function onPointerLockChange() {
    if (!active) return;
    if (document.pointerLockElement === dom) {
      _lockEverAcquired = true;
      degraded = false;
      refreshHint();
      return;
    }
    // 曾持有锁 → 丢锁 = 退出（research §3：pointerlockchange 丢失锁 = 退出掌镜）
    if (_lockEverAcquired) exit();
  }

  function onPointerLockError() {
    if (!active) return;
    degraded = true;
    console.warn("[掌镜] requestPointerLock 被拒绝（headless/权限），进入降级模式：键盘/HUD 可用，鼠标转视角失效");
    refreshHint();
  }

  /* ==================== 进入 / 退出 ==================== */

  function enter() {
    if (active) return true;
    const cam = activeCam();
    if (!cam) {
      toast("无活动机位，无法掌镜", true);
      return false;
    }
    active = true;
    degraded = false;
    _lockEverAcquired = false;
    keys.clear();
    locked = null;
    lockLabel.style.display = "none";

    // 无缝接管当前视角
    syncAnglesFromCamera(cam);

    // 轨迹播放中进入掌镜：先暂停（双方都抢相机/orbit）
    try { if (trajectoryRuntime?.playing) trajectoryRuntime.pause(); } catch { /* 容错 */ }

    // 掌镜全程 orbit 禁用，退出恢复
    if (orbit) {
      _savedOrbitEnabled = orbit.enabled !== false;
      orbit.enabled = false;
    }

    // Pointer Lock（不可用则降级，不中断掌镜）
    try {
      const p = dom?.requestPointerLock?.();
      if (p && typeof p.catch === "function") {
        p.catch((err) => {
          if (!active) return;
          degraded = true;
          console.warn("[掌镜] requestPointerLock 失败，进入降级模式:", err?.message || err);
          refreshHint();
        });
      }
    } catch (err) {
      degraded = true;
      console.warn("[掌镜] requestPointerLock 异常，进入降级模式:", err?.message || err);
    }
    // 兜底探测：短时间后既未拿到锁也未报错 → 视为降级（某些 headless 静默吞掉请求）
    if (_lockDetectTimer) clearTimeout(_lockDetectTimer);
    _lockDetectTimer = setTimeout(() => {
      _lockDetectTimer = null;
      if (active && !_lockEverAcquired && !degraded && document.pointerLockElement !== dom) {
        degraded = true;
        console.warn("[掌镜] 未获得指针锁（降级模式）：键盘/HUD 可用，鼠标转视角失效");
        refreshHint();
      }
    }, 400);

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("pointerlockchange", onPointerLockChange);
    document.addEventListener("pointerlockerror", onPointerLockError);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp);
    dom?.addEventListener?.("wheel", onWheel, { passive: false });

    hud.style.display = "block";
    btn.style.background = "#2f9e6340";
    refreshHint();
    return true;
  }

  function exit() {
    if (!active) return false;
    active = false;
    keys.clear();
    locked = null;

    if (_lockDetectTimer) { clearTimeout(_lockDetectTimer); _lockDetectTimer = null; }
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("pointerlockchange", onPointerLockChange);
    document.removeEventListener("pointerlockerror", onPointerLockError);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", onKeyUp);
    dom?.removeEventListener?.("wheel", onWheel);
    if (document.pointerLockElement === dom) {
      try { document.exitPointerLock?.(); } catch { /* 容错 */ }
    }

    // 恢复 orbit（保持掌镜最终朝向：target 已在 tick 中持续同步）
    if (orbit) {
      const cam = activeCam();
      if (cam) syncOrbitTarget(cam);
      orbit.enabled = _savedOrbitEnabled != null ? _savedOrbitEnabled : true;
      _savedOrbitEnabled = null;
      try { orbit.update?.(); } catch { /* 容错 */ }
    }

    hud.style.display = "none";
    btn.style.background = "";
    return true;
  }

  /* ==================== 每帧驱动（renderLoop 插入点：trajectoryRuntime 之后） ==================== */

  function tick(dt) {
    if (!active) return;
    const cam = activeCam();
    if (!cam) return;
    const step = Math.max(0, Math.min(0.05, Number.isFinite(dt) ? dt : 0.016)); // clamp 防掉帧跳跃

    if (locked) {
      // 目标移动 → 跟拍（相机随目标平移）
      if (!resolveLockedCenter(_v2)) {
        // 目标被删除等 → 自动解锁
        locked = null;
        lockLabel.style.display = "none";
        flash("🔓 目标失效，已解锁");
        refreshHint();
      } else {
        _v1.copy(_v2).sub(locked.center); // 目标位移
        if (_v1.lengthSq() > 1e-12) cam.position.add(_v1);
        locked.center.copy(_v2);

        // A/D 环绕（绕轨角速度 ~1.6 rad/s）、W/S 推拉、E/Q 升降（极角）
        const orbitRate = 1.6;
        if (keys.has("KeyA")) locked.theta += orbitRate * step;
        if (keys.has("KeyD")) locked.theta -= orbitRate * step;
        if (keys.has("KeyW")) locked.radius = Math.max(0.3, locked.radius - speed * step);
        if (keys.has("KeyS")) locked.radius = Math.min(60, locked.radius + speed * step);
        if (keys.has("KeyE")) locked.phi = Math.max(0.05, locked.phi - orbitRate * 0.6 * step);
        if (keys.has("KeyQ")) locked.phi = Math.min(Math.PI - 0.05, locked.phi + orbitRate * 0.6 * step);

        _sph.set(locked.radius, locked.phi, locked.theta);
        cam.position.setFromSpherical(_sph).add(locked.center);
        cam.lookAt(locked.center);
        cam.updateMatrixWorld?.();
      }
    } else {
      // 自由飞：Euler YXZ 视角 + WASD 平移 + E/Q 升降
      _euler.set(pitch, yaw, 0, "YXZ");
      _quat.setFromEuler(_euler);
      cam.quaternion.copy(_quat);

      _move.set(0, 0, 0);
      _fwd.set(0, 0, -1).applyQuaternion(_quat);
      _right.set(1, 0, 0).applyQuaternion(_quat);
      if (keys.has("KeyW")) _move.add(_fwd);
      if (keys.has("KeyS")) _move.sub(_fwd);
      if (keys.has("KeyD")) _move.add(_right);
      if (keys.has("KeyA")) _move.sub(_right);
      if (keys.has("KeyE")) _move.y += 1;
      if (keys.has("KeyQ")) _move.y -= 1;
      if (_move.lengthSq() > 1) _move.normalize();
      cam.position.addScaledVector(_move, speed * step);
      cam.updateMatrixWorld?.();
    }

    syncOrbitTarget(cam);
  }

  /* ==================== __ds 钩子 ==================== */

  const api = {
    enter,
    exit,
    isActive: () => active,
    isDegraded: () => degraded,
    get lockedTarget() { return locked ? { kind: locked.kind, id: locked.id, name: locked.name } : null; },
    recordPoint,
    toggleLock,
    setSpeed(v) {
      speed = Math.max(0.5, Math.min(40, Number(v) || DEFAULT_SPEED));
      saveNum(LS_SPEED, speed);
      if (active) refreshHint();
    },
    getSpeed: () => speed,
    setSensitivity(v) {
      sensitivity = Math.max(0.0005, Math.min(0.01, Number(v) || DEFAULT_SENS));
      saveNum(LS_SENS, sensitivity);
    },
    getSensitivity: () => sensitivity,
    _btn: btn,
    _hud: hud,
  };

  return { api, tick, enter, exit, isActive: api.isActive };
}
