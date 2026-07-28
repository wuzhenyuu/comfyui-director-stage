/**
 * trajectory.js — 相机轨迹纯函数引擎（零 UI / 零 DOM / 零 three.js 依赖）
 *
 * 数据模型（挂在 cameras[i].trajectory，见 DESIGN.md §1）：
 *   {
 *     enabled, duration, curve: "smooth"|"linear", speed: "uniform"|"ease", fps,
 *     points: [{ id, position:[x,y,z], target:[x,y,z], fov, time:0..1,
 *                track: null | { kind:"character"|"prop", id } }]
 *   }
 *
 * 核心入口 evaluateTrajectory(traj, t01, resolveTrack) → { position, target, fov } | null
 *  - 位置：逐轴 Catmull-Rom（smooth）或折线（linear），每段 32 采样弧长参数化保证匀速性
 *  - 时间映射：points[].time 为归一化锚点（t=point.time 时必过该点）；
 *    uniform = 段内弧长匀速，ease = 段内 smoothstep 缓动（两端速度趋零）
 *  - 朝向：不做 slerp —— 返回 effectiveTarget（点带 track 时经 resolveTrack 取实时
 *    世界坐标，失败/返回 null 回退静态 target），由调用方每帧 lookAt
 *  - fov：相邻点按时间线性插值；t01 越界钳制到端点
 *
 * 借鉴 3d-director-desk schema/routeTiming.ts（见 research-3ddd.md §2），去 TS 化。
 * 返回值均为 plain array [x,y,z]，不 import three。
 */

/** 每段弧长参数化采样数（同 3ddd CURVE_SAMPLES_PER_SEGMENT） */
export const CURVE_SAMPLES_PER_SEGMENT = 32;

// ---------------- 基础数学 ----------------

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** smoothstep 缓动：t*t*(3-2t)，t=0/1 处导数为 0，t=0.5 处导数最大（1.5） */
export function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerp3(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

function dist3(a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function isVec3(v) {
  return Array.isArray(v) && v.length >= 3 &&
    Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
}

/** 标准均匀 Catmull-Rom 单轴求值（t=0 过 p1，t=1 过 p2，保证锚点过点精确） */
function catmullRom1D(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    2 * p1 +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}

/**
 * 在点列上取第 seg 段、段内参数 u∈[0,1] 的曲线位置。
 * curve !== "smooth" 或点数 <3 时退化为线性；边界 clamp 重复端点。
 *
 * @param {number[][]} points 控制点列（[[x,y,z],...]，长度≥2）
 * @param {"smooth"|"linear"} curve
 * @param {number} seg 段索引 [0, n-2]
 * @param {number} u 段内参数 [0,1]
 * @returns {number[]} [x,y,z]
 */
export function sampleCurvePoint(points, curve, seg, u) {
  const n = points.length;
  const i = Math.max(0, Math.min(Math.floor(seg), n - 2));
  const uu = clamp01(u);
  const p1 = points[i];
  const p2 = points[i + 1];
  if (curve !== "smooth" || n < 3) return lerp3(p1, p2, uu);
  const p0 = i > 0 ? points[i - 1] : p1; // 左边界：重复端点
  const p3 = i + 2 < n ? points[i + 2] : p2; // 右边界：重复端点
  return [
    catmullRom1D(p0[0], p1[0], p2[0], p3[0], uu),
    catmullRom1D(p0[1], p1[1], p2[1], p3[1], uu),
    catmullRom1D(p0[2], p1[2], p2[2], p3[2], uu),
  ];
}

// ---------------- 弧长参数化 ----------------

/**
 * 构建弧长参数化表：每段按 32 采样展开曲线，累积弦长。
 * 之后可把"弧长距离"线性反查回曲线参数 (seg, u)，保证匀速性。
 *
 * @param {number[][]} points 控制点列（[[x,y,z],...]，长度≥2）
 * @param {"smooth"|"linear"} curve
 * @returns {{ totalLength:number, segSamples:{d:number[],u:number[],length:number}[],
 *             anchorDist:number[], anchorFrac:number[] } | null}
 *   anchorDist[i] = 第 i 个控制点处的全程累积弧长；anchorFrac = anchorDist / totalLength
 */
export function buildArcTable(points, curve) {
  const n = points ? points.length : 0;
  if (n < 2) return null;
  const segSamples = [];
  const anchorDist = [0];
  let total = 0;
  for (let s = 0; s < n - 1; s++) {
    const ds = [0];
    const us = [0];
    let prev = sampleCurvePoint(points, curve, s, 0);
    let acc = 0;
    for (let k = 1; k <= CURVE_SAMPLES_PER_SEGMENT; k++) {
      const u = k / CURVE_SAMPLES_PER_SEGMENT;
      const p = sampleCurvePoint(points, curve, s, u);
      acc += dist3(prev, p);
      prev = p;
      ds.push(acc);
      us.push(u);
    }
    segSamples.push({ d: ds, u: us, length: acc });
    total += acc;
    anchorDist.push(total);
  }
  const anchorFrac = anchorDist.map((d) => (total > 0 ? d / total : 0));
  return { totalLength: total, segSamples, anchorDist, anchorFrac };
}

/** 在单调递增数组 arr 中找最大 k 使 arr[k] <= v（k ∈ [0, len-2]），二分 */
function findInterval(arr, v) {
  let lo = 0;
  let hi = arr.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= v) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * 弧长距离 d → 曲线参数 { seg, u }（在采样表上线性反查）。
 * d 越界自动钳制到 [0, totalLength]。
 */
export function arcLengthToParam(table, d) {
  if (!table || !(table.totalLength > 0)) return { seg: 0, u: 0 };
  let remaining = Math.max(0, Math.min(d, table.totalLength));
  const segs = table.segSamples;
  for (let s = 0; s < segs.length; s++) {
    const seg = segs[s];
    if (remaining <= seg.length || s === segs.length - 1) {
      if (!(seg.length > 0)) return { seg: s, u: 0 };
      const k = findInterval(seg.d, remaining);
      const d0 = seg.d[k];
      const d1 = seg.d[k + 1];
      const f = d1 > d0 ? (remaining - d0) / (d1 - d0) : 0;
      return { seg: s, u: lerp(seg.u[k], seg.u[k + 1], f) };
    }
    remaining -= seg.length;
  }
  return { seg: segs.length - 1, u: 1 };
}

/**
 * 弧长比例 frac∈[0,1] → 曲线位置（先反查 (seg,u)，再精确求值曲线）
 * @returns {number[]} [x,y,z]
 */
export function sampleByArcFraction(points, curve, table, frac) {
  const { seg, u } = arcLengthToParam(table, clamp01(frac) * (table ? table.totalLength : 0));
  return sampleCurvePoint(points, curve, seg, u);
}

// ---------------- 轨迹编译 ----------------

/**
 * 编译轨迹：内部按 time 排序（不改原数组），预建位置弧长表。
 * 播放循环可每帧复用编译结果，避免重复 32×n 采样。
 *
 * @param {Object} traj 轨迹数据（cameras[i].trajectory）
 * @returns {{ points:Object[], curve:"smooth"|"linear", speed:"uniform"|"ease",
 *             positions:number[][], targets:number[][], posTable:Object } | null}
 *   空轨迹 / 单点 → null
 */
export function prepareTrajectory(traj) {
  if (!traj || !Array.isArray(traj.points) || traj.points.length < 2) return null;
  const points = traj.points
    .filter((p) => p && isVec3(p.position) && isVec3(p.target))
    .slice()
    .sort((a, b) => a.time - b.time); // 内部排序，不改原数组
  if (points.length < 2) return null;
  const curve = traj.curve === "linear" ? "linear" : "smooth";
  const speed = traj.speed === "ease" ? "ease" : "uniform";
  const positions = points.map((p) => p.position);
  const targets = points.map((p) => p.target);
  const posTable = buildArcTable(positions, curve);
  if (!posTable) return null;
  return { points, curve, speed, positions, targets, posTable };
}

// ---------------- 跟踪目标解算 ----------------

/**
 * 安全调用 resolveTrack：返回实时世界坐标 [x,y,z]；
 * 无 track / 无回调 / 回调抛错 / 返回非法值 → null（调用方回退静态 target）。
 * 容忍 Vector3 风格返回值（{x,y,z}）。
 */
function safeResolveTrack(track, resolveTrack) {
  if (!track || typeof resolveTrack !== "function") return null;
  try {
    const v = resolveTrack(track);
    if (isVec3(v)) return [v[0], v[1], v[2]];
    if (v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)) {
      return [v.x, v.y, v.z];
    }
    return null;
  } catch {
    return null;
  }
}

/** 端点姿态（t01 越界钳制时用）：位置/目标取该点原值（副本），fov 取该点 */
function endpointPose(point, resolveTrack) {
  const tracked = safeResolveTrack(point.track, resolveTrack);
  return {
    position: [point.position[0], point.position[1], point.position[2]],
    target: tracked || [point.target[0], point.target[1], point.target[2]],
    fov: Number.isFinite(point.fov) ? point.fov : 50,
  };
}

// ---------------- 主求值入口 ----------------

/**
 * 在已编译轨迹上求值 t01∈[0,1]（归一化进度，对应 0..duration 秒）。
 *
 * @param {Object} prepared prepareTrajectory 的返回值
 * @param {number} t01 归一化时间（自动 clamp 到 [0,1]）
 * @param {(track:{kind:string,id:string})=>number[]|{x,y,z}|null} [resolveTrack]
 *        跟踪目标实时世界坐标解析回调（由调用方注入）
 * @returns {{ position:number[], target:number[], fov:number }}
 */
export function evaluatePreparedTrajectory(prepared, t01, resolveTrack) {
  const pts = prepared.points;
  const n = pts.length;
  const { curve, speed, positions, targets, posTable } = prepared;

  const t = clamp01(Number.isFinite(t01) ? t01 : 0);

  // 越界钳制到首尾锚点
  const tFirst = Number.isFinite(pts[0].time) ? pts[0].time : 0;
  const tLast = Number.isFinite(pts[n - 1].time) ? pts[n - 1].time : 1;
  if (t <= tFirst) return endpointPose(pts[0], resolveTrack);
  if (t >= tLast) return endpointPose(pts[n - 1], resolveTrack);

  // 定位时间段 i：time[i] <= t < time[i+1]
  let i = 0;
  while (i < n - 2 && t >= pts[i + 1].time) i++;
  const t0 = pts[i].time;
  const t1 = pts[i + 1].time;
  const localTime = t1 > t0 ? (t - t0) / (t1 - t0) : 0;

  // 时间 → 弧长比例：锚点之间按弧长比例插值（uniform 线性 / ease smoothstep）。
  // 锚点处 frac == anchorFrac[i]，反查必得段边界 (u=0/1)，保证过点精确。
  const w = speed === "ease" ? smoothstep(localTime) : localTime;
  const frac = posTable.anchorFrac[i] +
    (posTable.anchorFrac[i + 1] - posTable.anchorFrac[i]) * w;

  // 位置与静态注视点共用同一曲线参数 (seg,u)（同 3ddd：target 随位置走同一时序）
  const { seg, u } = arcLengthToParam(posTable, frac * posTable.totalLength);
  const position = sampleCurvePoint(positions, curve, seg, u);

  // effectiveTarget：任一端点带 track 时，两端各自解算（失败回退静态）后按时间线性 blend；
  // 否则沿曲线插值静态 target。
  const a = pts[i];
  const b = pts[i + 1];
  const ta = safeResolveTrack(a.track, resolveTrack);
  const tb = safeResolveTrack(b.track, resolveTrack);
  let target;
  if (a.track || b.track) {
    const va = ta || a.target;
    const vb = tb || b.target;
    target = lerp3(va, vb, localTime);
  } else {
    target = sampleCurvePoint(targets, curve, seg, u);
  }

  // fov：相邻点按时间线性插值
  const fovA = Number.isFinite(a.fov) ? a.fov : 50;
  const fovB = Number.isFinite(b.fov) ? b.fov : 50;
  return { position, target, fov: lerp(fovA, fovB, localTime) };
}

/**
 * 轨迹求值主入口（一步版：内部编译后直接求值）。
 * 高频调用（播放/逐帧导出）建议先 prepareTrajectory 再 evaluatePreparedTrajectory。
 *
 * @param {Object} traj 轨迹数据（cameras[i].trajectory）
 * @param {number} t01 归一化时间 [0,1]
 * @param {Function} [resolveTrack] 跟踪目标实时世界坐标解析回调
 * @returns {{ position:number[], target:number[], fov:number } | null}
 *   空轨迹 / 单点 → null（调用方跳过）
 */
export function evaluateTrajectory(traj, t01, resolveTrack) {
  const prepared = prepareTrajectory(traj);
  if (!prepared) return null;
  return evaluatePreparedTrajectory(prepared, t01, resolveTrack);
}
