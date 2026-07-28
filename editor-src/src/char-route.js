/**
 * char-route.js — 人物行走路线纯函数引擎（零 UI / 零 DOM / 零 three.js 依赖）
 *
 * 数据模型（挂在 characters[i].route，见 DESIGN-V2.md F3）：
 *   {
 *     points: [{ id, position:[x,y,z], time:0..1 }],
 *     curve: "smooth"|"linear",   // 位置插值方式（smooth 需 ≥3 点，否则自动退化 linear）
 *     duration: 秒,               // 全程时长（仅供 routeAvgSpeed 换算参考，引擎不消费）
 *     loop: false                 // V2 仅支持 false：t01 越界钳制到端点
 *   }
 *
 * 核心入口 evaluateRoute(route, t01) → { position, heading } | null
 *  - 位置：逐轴 Catmull-Rom（smooth）或折线（linear），弧长参数化保证匀速性。
 *    完全复用 trajectory.js 的 buildArcTable / arcLengthToParam / sampleCurvePoint，
 *    不重复实现曲线数学。
 *  - heading：位置曲线的单位切线方向（yaw，rad），约定 yaw = atan2(dx, dz)
 *    （同 3ddd getPathFacingYaw，research-3ddd.md §7），供角色平滑转向。
 *    端点处用前向/后向单侧差分，中间用中心差分；切线退化（重合点）时回退 0。
 *  - 时间映射：points[].time 为归一化锚点（t=point.time 时必过该点）；
 *    锚点之间按弧长比例线性插值（uniform）；乱序 points 内部排序，不改原数组。
 *  - 空 / <2 有效点 → null（调用方跳过）。
 *
 * 另含：
 *  - smoothHeading(prevYaw, targetYaw, dt, maxTurnRate)：角速度受限的朝向插值，
 *    处理 ±π 环绕（永远走短弧，不绕远路），转身不瞬移。
 *  - routeLength(route)：全程弧长（m）。
 *  - routeAvgSpeed(route)：routeLength / duration → 平均速度 m/s（walk 步频匹配参考）。
 *  - flattenRoute(route, groundY)：贴地工具（所有点 Y 设为 groundY，返回新对象不改原）。
 *    引擎本身不强制贴地（允许楼梯/坡道逐点 Y），由集成层决定是否调用。
 *
 * 返回值均为 plain array [x,y,z] / plain number，不 import three。
 */

import {
  buildArcTable,
  arcLengthToParam,
  sampleCurvePoint,
  sampleByArcFraction,
} from "./trajectory.js";

// ---------------- 基础数学 ----------------

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function isVec3(v) {
  return Array.isArray(v) && v.length >= 3 &&
    Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
}

/** 把角度规约到 (-π, π]（用于 ±π 环绕走短弧） */
export function wrapAnglePi(a) {
  if (!Number.isFinite(a)) return 0;
  let w = a % (2 * Math.PI);
  if (w <= -Math.PI) w += 2 * Math.PI;
  else if (w > Math.PI) w -= 2 * Math.PI;
  return w;
}

/** 由位移向量求朝向 yaw = atan2(dx, dz)；退化（零位移）返回 null */
function yawFromDelta(dx, dz) {
  const len = Math.sqrt(dx * dx + dz * dz);
  if (!(len > 1e-9)) return null;
  return Math.atan2(dx, dz);
}

// ---------------- 路线编译 ----------------

/**
 * 编译路线：内部按 time 排序（不改原数组），预建位置弧长表。
 * 播放循环可每帧复用编译结果，避免重复 32×n 采样。
 *
 * @param {Object} route 路线数据（characters[i].route）
 * @returns {{ points:Object[], curve:"smooth"|"linear", positions:number[][],
 *             posTable:Object, duration:number, loop:boolean } | null}
 *   空路线 / 有效点 <2 → null
 */
export function prepareRoute(route) {
  if (!route || !Array.isArray(route.points) || route.points.length < 2) return null;
  const points = route.points
    .filter((p) => p && isVec3(p.position))
    .slice()
    .sort((a, b) => (Number.isFinite(a.time) ? a.time : 0) - (Number.isFinite(b.time) ? b.time : 0));
  if (points.length < 2) return null;
  const curve = route.curve === "linear" ? "linear" : "smooth";
  const positions = points.map((p) => p.position);
  const posTable = buildArcTable(positions, curve);
  if (!posTable) return null;
  const duration = Number.isFinite(route.duration) && route.duration > 0 ? route.duration : 0;
  return { points, curve, positions, posTable, duration, loop: route.loop === true };
}

// ---------------- 位置 + 切线朝向 ----------------

/**
 * 在已编译路线上取弧长距离 d 处的位置与单位切线 yaw。
 * 切线用弧长域差分（天然匀速，不受曲线参数化畸变影响）：
 *  - 中间：中心差分  d±eps
 *  - 起点：前向差分  d, d+eps
 *  - 终点：后向差分  d-eps, d
 * eps = totalLength × 1e-3（同 3ddd 在 progress±0.001 采样的思路，换到弧长域）。
 *
 * @returns {{ position:number[], heading:number }}
 *   heading 退化（全程零长度/重合点）时为 0。
 */
function poseAtArcDist(prepared, d) {
  const { curve, positions, posTable } = prepared;
  const L = posTable.totalLength;
  const dd = Math.max(0, Math.min(d, L)); // 钳制（loop=false 端点钳制）
  const position = sampleByArcFraction(positions, curve, posTable, L > 0 ? dd / L : 0);

  let heading = null;
  if (L > 1e-9) {
    const eps = L * 1e-3;
    let pA;
    let pB;
    if (dd <= 0) {
      pA = position;
      pB = sampleByArcFraction(positions, curve, posTable, eps / L);
    } else if (dd >= L) {
      pA = sampleByArcFraction(positions, curve, posTable, (L - eps) / L);
      pB = position;
    } else {
      pA = sampleByArcFraction(positions, curve, posTable, Math.max(0, dd - eps) / L);
      pB = sampleByArcFraction(positions, curve, posTable, Math.min(L, dd + eps) / L);
    }
    heading = yawFromDelta(pB[0] - pA[0], pB[2] - pA[2]);
  }
  return { position, heading: heading == null ? 0 : heading };
}

/**
 * 在已编译路线上求值 t01∈[0,1]（归一化进度，对应 0..duration 秒）。
 *
 * @param {Object} prepared prepareRoute 的返回值
 * @param {number} t01 归一化时间（loop=false 时自动 clamp 到 [0,1] 及首末锚点 time）
 * @returns {{ position:number[], heading:number }}
 */
export function evaluatePreparedRoute(prepared, t01) {
  const pts = prepared.points;
  const n = pts.length;
  const { posTable } = prepared;

  const t = clamp01(Number.isFinite(t01) ? t01 : 0);

  // 越界钳制到首尾锚点（loop=false 语义：停在端点，不回绕）
  const tFirst = Number.isFinite(pts[0].time) ? pts[0].time : 0;
  const tLast = Number.isFinite(pts[n - 1].time) ? pts[n - 1].time : 1;
  if (t <= tFirst) return poseAtArcDist(prepared, posTable.anchorDist[0]);
  if (t >= tLast) return poseAtArcDist(prepared, posTable.anchorDist[n - 1]);

  // 定位时间段 i：time[i] <= t < time[i+1]
  let i = 0;
  while (i < n - 2 && t >= pts[i + 1].time) i++;
  const t0 = Number.isFinite(pts[i].time) ? pts[i].time : 0;
  const t1 = Number.isFinite(pts[i + 1].time) ? pts[i + 1].time : 1;
  const localTime = t1 > t0 ? (t - t0) / (t1 - t0) : 0;

  // 时间 → 弧长距离：锚点之间按弧长比例线性插值（uniform 匀速）。
  // 锚点处 d == anchorDist[i]，反查必得段边界，保证过点精确。
  const d = posTable.anchorDist[i] +
    (posTable.anchorDist[i + 1] - posTable.anchorDist[i]) * localTime;

  return poseAtArcDist(prepared, d);
}

/**
 * 路线求值主入口（一步版：内部编译后直接求值）。
 * 高频调用（逐帧行走）建议先 prepareRoute 再 evaluatePreparedRoute。
 *
 * @param {Object} route 路线数据（characters[i].route）
 * @param {number} t01 归一化时间 [0,1]
 * @returns {{ position:number[], heading:number } | null}
 *   空路线 / 有效点 <2 → null（调用方跳过）
 */
export function evaluateRoute(route, t01) {
  const prepared = prepareRoute(route);
  if (!prepared) return null;
  return evaluatePreparedRoute(prepared, t01);
}

// ---------------- 朝向平滑（角速度受限） ----------------

/**
 * 角速度受限的朝向插值：从 prevYaw 朝 targetYaw 转，单步转角不超过
 * maxTurnRate × dt（rad），处理 ±π 环绕（wrapAnglePi 保证永远走短弧）。
 * 供调用方每帧驱动角色身体朝向：evaluateRoute 给的是"此刻应朝哪"，
 * smoothHeading 负责"转身不瞬移"。
 *
 * @param {number} prevYaw 当前朝向（rad）
 * @param {number} targetYaw 目标朝向（rad）
 * @param {number} dt 帧间隔（秒）
 * @param {number} maxTurnRate 最大角速度（rad/s）；≤0 或 dt≤0 时视为不限制（直接对齐）
 * @returns {number} 新朝向（rad，规约到 (-π, π]）
 */
export function smoothHeading(prevYaw, targetYaw, dt, maxTurnRate) {
  const prev = Number.isFinite(prevYaw) ? prevYaw : 0;
  const target = Number.isFinite(targetYaw) ? targetYaw : prev;
  const diff = wrapAnglePi(target - prev); // 短弧差分 ∈ (-π, π]
  if (!Number.isFinite(dt) || dt <= 0 || !Number.isFinite(maxTurnRate) || maxTurnRate <= 0) {
    return wrapAnglePi(target); // 无速率约束：直接对齐
  }
  const maxStep = maxTurnRate * dt;
  const step = Math.abs(diff) <= maxStep ? diff : Math.sign(diff) * maxStep;
  return wrapAnglePi(prev + step);
}

// ---------------- 长度 / 速度换算 ----------------

/**
 * 路线全程弧长（m）。基于 32 采样/段的弧长表，精度足够步频匹配参考。
 * @param {Object} route
 * @returns {number} 弧长（m）；无效路线 → 0
 */
export function routeLength(route) {
  const prepared = prepareRoute(route);
  return prepared ? prepared.posTable.totalLength : 0;
}

/**
 * 平均速度换算：routeLength / duration → m/s（供 walk clip 步频匹配参考）。
 * duration 缺失/≤0 或路线无效 → null（调用方自行降级）。
 * @param {Object} route
 * @returns {number | null}
 */
export function routeAvgSpeed(route) {
  const prepared = prepareRoute(route);
  if (!prepared || !(prepared.duration > 0)) return null;
  return prepared.posTable.totalLength / prepared.duration;
}

// ---------------- 路线数据工具（集成层用） ----------------

let _routePointSeq = 1;
/** 路线点 id 生成（集成层添加/插入点用） */
export function nextRoutePointId() {
  return `rp_${Date.now().toString(36)}_${_routePointSeq++}`;
}

/** 默认路线数据（DESIGN-V2 F3 数据模型） */
export function createDefaultRoute() {
  return { points: [], curve: "smooth", duration: 6, loop: false };
}

/**
 * 路线数据清洗（反序列化/外部注入用）：过滤非法点、钳制 time 到 [0,1]、
 * 补默认 curve/duration/loop。恒返回新对象（不改入参）；输入非对象 → null。
 * 注意：不保留 _rev（缓存修订号由 touchRoute 重建）。
 */
export function sanitizeRoute(raw) {
  if (!raw || typeof raw !== "object") return null;
  const points = (Array.isArray(raw.points) ? raw.points : [])
    .filter((p) => p && isVec3(p.position))
    .map((p, i) => ({
      id: typeof p.id === "string" && p.id ? p.id : `rp_${i}`,
      position: [+p.position[0], +p.position[1], +p.position[2]],
      time: clamp01(Number.isFinite(p.time) ? p.time : 0),
    }));
  return {
    points,
    curve: raw.curve === "linear" ? "linear" : "smooth",
    duration: Number.isFinite(raw.duration) && raw.duration > 0 ? raw.duration : 6,
    loop: raw.loop === true,
  };
}

/**
 * 编辑后 bump 修订号（prepared 缓存失效）+ 广播 ds-char-route-changed。
 * 浏览器外（node 探针）静默跳过广播。
 */
export function touchRoute(route) {
  if (route) route._rev = (route._rev || 0) + 1;
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new CustomEvent("ds-char-route-changed"));
  }
}

// ---------------- 行走播放运行时（纯函数，three/DOM 由集成层注入） ----------------

/**
 * 人物行走路线运行时。状态 per-character：{ playing, progress(0~1), yaw, follow, _driving }。
 * renderLoop 每帧调 tick(dt, trajCtx)（插入点：cameraOperator 之后、actionRuntime 之前）。
 *
 * 依赖全部注入，本模块保持零 three / 零 DOM：
 *  - manager：ExternalCharacterManager（get / setCharacterRotation / getCharacterRotation）
 *  - actionRuntime：动作运行时（play/stop/getState）——行走自动播 walk、停止回 stand
 *  - translate(entry, dx, dy, dz)：整体平移入口（main.js 注入 translateExternalCharacter，
 *    模型 + IK target/pole 同步并 reset 脚钉地基准）
 *  - findWalkAction(entry) → actionId：优先模型自带 walk clip，回退程序化 "walk"
 *
 * 时间基准：与 trajectoryRuntime 共享归一化 progress 语义（0~1 对应 0~duration 秒）；
 * follow=true 且相机轨迹播放中时，progress 直接跟随 trajCtx.progress（同一时刻同一进度），
 * 轨迹停止 → 路线自动停（回 stand）。loop=false 到终点停住并回 stand。
 *
 * @param {object} deps
 * @returns 运行时对象
 */
export function createRouteRuntime(deps = {}) {
  const { manager, actionRuntime, translate, findWalkAction, maxTurnRate = 6 } = deps;
  const RAD2DEG = 180 / Math.PI;
  const DEG2RAD = Math.PI / 180;

  /** @type {Map<string, {playing:boolean, progress:number, yaw:number, follow:boolean,
   *   _driving:boolean, _cache:{route:object,rev:number,prepared:object}|null}>} */
  const states = new Map();

  function _state(id, create = false) {
    let st = states.get(id);
    if (!st && create) {
      st = { playing: false, progress: 0, yaw: 0, follow: true, _driving: false, _cache: null };
      states.set(id, st);
    }
    return st || null;
  }

  function _prepared(entry, st) {
    const route = entry?.route;
    if (!route) return null;
    const rev = route._rev || 0;
    if (st?._cache && st._cache.route === route && st._cache.rev === rev) {
      return st._cache.prepared;
    }
    const prepared = prepareRoute(route);
    if (st) st._cache = { route, rev, prepared };
    return prepared;
  }

  function _startWalk(entry) {
    if (!actionRuntime) return;
    try {
      const walkId = (typeof findWalkAction === "function" ? findWalkAction(entry) : null) || "walk";
      const st = actionRuntime.getState?.(entry.id);
      if (st?.playing && st.id === walkId) return; // 已在走
      actionRuntime.play?.(entry.id, walkId);
    } catch { /* 动作启动失败不阻塞行走 */ }
  }

  function _stopWalk(entry) {
    if (!actionRuntime) return;
    try {
      const st = actionRuntime.getState?.(entry.id);
      if (st?.playing) actionRuntime.stop?.(entry.id); // 回 stand
    } catch { /* 容错 */ }
  }

  /** 把 t01 处路线姿态应用到角色（平移模型 + 返回姿态；不含转向） */
  function _applyPosition(entry, prepared, t01) {
    const pose = evaluatePreparedRoute(prepared, t01);
    const m = entry.model;
    if (m && typeof translate === "function") {
      const dx = pose.position[0] - m.position.x;
      const dy = pose.position[1] - m.position.y;
      const dz = pose.position[2] - m.position.z;
      if (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9 || Math.abs(dz) > 1e-9) {
        translate(entry, dx, dy, dz);
      }
    }
    return pose;
  }

  const runtime = {
    states,
    /** UI 更新回调（play/stop/tick 状态变化后触发） */
    onUpdate: null,

    isPlaying(id) {
      return _state(id)?.playing === true;
    },
    getProgress(id) {
      return _state(id)?.progress ?? 0;
    },
    getFollow(id) {
      return _state(id)?.follow !== false;
    },
    setFollow(id, v) {
      _state(id, true).follow = !!v;
    },

    /** 播放（从当前 progress 继续；loop=false 且已在终点时从头开始） */
    play(id) {
      const entry = manager?.get?.(id);
      if (!entry?.route) return false;
      const st = _state(id, true);
      const prepared = _prepared(entry, st);
      if (!prepared) return false;
      if (!st.playing && !prepared.loop && st.progress >= 1 - 1e-6) st.progress = 0;
      // 起始朝向：从模型当前 Y 旋转起平滑（不瞬转）
      try {
        const rot = manager.getCharacterRotation?.(id);
        st.yaw = rot && Number.isFinite(rot.y) ? rot.y * DEG2RAD : 0;
      } catch { st.yaw = 0; }
      st.playing = true;
      st._driving = false;
      _startWalk(entry);
      const pose = _applyPosition(entry, prepared, st.progress);
      st.yaw = smoothHeading(st.yaw, pose.heading, 0, 0); // 首帧直接对齐行进方向
      manager?.setCharacterRotation?.(id, { y: st.yaw * RAD2DEG });
      this._notify();
      return true;
    },

    pause(id) {
      const st = _state(id);
      if (!st?.playing) return;
      st.playing = false;
      st._driving = false;
      const entry = manager?.get?.(id);
      if (entry) _stopWalk(entry);
      this._notify();
    },

    /** 停止：停走回 stand；角色停在当前位置（progress 保留，再 play 续走） */
    stop(id) {
      const st = _state(id);
      if (!st) return;
      st.playing = false;
      st._driving = false;
      const entry = manager?.get?.(id);
      if (entry) _stopWalk(entry);
      this._notify();
    },

    /** 精确寻址：设置 progress 并立即应用位置/朝向（不改变 playing 标志） */
    seekTo(id, t01) {
      const entry = manager?.get?.(id);
      if (!entry?.route) return null;
      const st = _state(id, true);
      const prepared = _prepared(entry, st);
      if (!prepared) return null;
      st.progress = clamp01(Number.isFinite(t01) ? t01 : 0);
      const pose = _applyPosition(entry, prepared, st.progress);
      st.yaw = pose.heading; // seek 直接对齐朝向（无平滑）
      manager?.setCharacterRotation?.(id, { y: st.yaw * RAD2DEG });
      this._notify();
      return pose;
    },

    /**
     * renderLoop 每帧调用。
     * @param {number} dt 帧间隔（秒）
     * @param {{playing:boolean, progress:number}} [trajCtx] 相机轨迹上下文（follow 联动用）
     */
    tick(dt, trajCtx) {
      const dtf = Number.isFinite(dt) ? dt : 0.016;
      for (const [id, st] of states) {
        const entry = manager?.get?.(id);
        if (!entry?.route) {
          if (st.playing || st._driving) { st.playing = false; st._driving = false; }
          continue;
        }
        const prepared = _prepared(entry, st);
        if (!prepared) {
          if (st.playing) { st.playing = false; _stopWalk(entry); this._notify(); }
          continue;
        }

        // follow 联动：相机轨迹播放中 → progress 跟随轨迹；轨迹停 → 路线停
        const driving = st.follow && trajCtx?.playing === true;
        if (driving) {
          if (!st._driving) {
            st._driving = true;
            st.playing = true;
            _startWalk(entry);
            this._notify();
          }
          st.progress = clamp01(Number.isFinite(trajCtx.progress) ? trajCtx.progress : 0);
        } else if (st._driving) {
          st._driving = false;
          st.playing = false;
          _stopWalk(entry);
          this._notify();
          continue;
        } else if (st.playing) {
          const dur = prepared.duration > 0 ? prepared.duration : 0;
          if (!(dur > 0)) {
            st.playing = false;
            _stopWalk(entry);
            this._notify();
            continue;
          }
          st.progress += dtf / dur;
          if (st.progress >= 1) {
            if (prepared.loop) {
              st.progress %= 1;
            } else {
              // loop=false：到终点停住 + 回 stand
              st.progress = 1;
              const endPose = _applyPosition(entry, prepared, 1);
              manager?.setCharacterRotation?.(id, { y: endPose.heading * RAD2DEG });
              st.yaw = endPose.heading;
              st.playing = false;
              _stopWalk(entry);
              this._notify();
              continue;
            }
          }
        } else {
          continue; // 未播放：不动
        }

        // 应用位置 + 平滑转向（角速度上限）
        const pose = _applyPosition(entry, prepared, st.progress);
        st.yaw = smoothHeading(st.yaw, pose.heading, dtf, maxTurnRate);
        manager?.setCharacterRotation?.(id, { y: st.yaw * RAD2DEG });
      }
    },

    _notify() { try { this.onUpdate?.(); } catch { /* UI 回调容错 */ } },
  };
  return runtime;
}

// ---------------- 贴地工具 ----------------

/**
 * 贴地工具：把所有路线点的 Y 设为 groundY，返回**新** route 对象（不改原）。
 * 引擎不强制贴地（允许坡道/楼梯逐点 Y），是否调用由集成层决定。
 * 点的其他字段（id/time）原样保留，curve/duration/loop 原样拷贝。
 *
 * @param {Object} route
 * @param {number} groundY 地面高度
 * @returns {Object | null} 新 route；输入无效 → null
 */
export function flattenRoute(route, groundY) {
  if (!route || !Array.isArray(route.points)) return null;
  const y = Number.isFinite(groundY) ? groundY : 0;
  return {
    ...route,
    points: route.points.map((p) => {
      if (!p || !isVec3(p.position)) return p;
      return { ...p, position: [p.position[0], y, p.position[2]] };
    }),
  };
}
