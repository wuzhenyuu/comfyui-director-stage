/**
 * trajectory-engine-probe.mjs — 轨迹引擎纯函数探针（node 直接跑，无 three.js 依赖）
 *
 * 运行：node editor-src/test/probes/trajectory-engine-probe.mjs
 *
 * 断言覆盖：
 *  1. 锚点过点精度（smooth/linear，t=point.time 时 position≈point.position，误差<1e-6）
 *  2. 弧长匀速（uniform 模式下段内等 Δt 弧长增量近似相等）
 *  3. ease 模式端点速度趋零、中点速度最大，且仍过锚点
 *  4. linear 模式折线正确（无曲线过冲）
 *  5. 边界：空轨迹 / 单点 / 乱序（不改原数组）/ 越界 t 钳制 / fov 钳制
 *  6. 跟踪目标：resolveTrack 实时坐标优先、null/抛错回退静态 target
 */

import {
  evaluateTrajectory,
  prepareTrajectory,
  evaluatePreparedTrajectory,
  buildArcTable,
  arcLengthToParam,
  sampleCurvePoint,
  smoothstep,
} from "../../src/trajectory.js";

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, name, detail = "") {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(`${name}${detail ? " — " + detail : ""}`);
    console.error(`  ✗ ${name}${detail ? " — " + detail : ""}`);
  }
}

function approx(a, b, eps = 1e-6) {
  return Math.abs(a - b) < eps;
}

function approxVec(a, b, eps = 1e-6) {
  return a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < eps);
}

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// ---------------- 测试轨迹 ----------------

/** smooth + uniform 四点轨迹（锚点时间乱序版见边界测试） */
const smoothTraj = {
  enabled: true,
  duration: 10,
  curve: "smooth",
  speed: "uniform",
  fps: 24,
  points: [
    { id: "p1", position: [0, 1, 0], target: [0, 0, 0], fov: 40, time: 0.0, track: null },
    { id: "p2", position: [2, 1.5, 1], target: [1, 0, 0], fov: 50, time: 0.3, track: null },
    { id: "p3", position: [4, 1, 2], target: [2, 0, 1], fov: 60, time: 0.7, track: null },
    { id: "p4", position: [6, 2, 0], target: [3, 0, 2], fov: 45, time: 1.0, track: null },
  ],
};

// ---------------- 1. 锚点过点精度 ----------------
console.log("1. 锚点过点精度");

for (const curve of ["smooth", "linear"]) {
  for (const speed of ["uniform", "ease"]) {
    const traj = { ...smoothTraj, curve, speed };
    for (const p of traj.points) {
      const r = evaluateTrajectory(traj, p.time);
      assert(r && approxVec(r.position, p.position, 1e-6),
        `${curve}/${speed} 锚点过点 ${p.id}`, r ? `err=${dist(r.position, p.position)}` : "null");
      // 静态 target 同样过点
      assert(r && approxVec(r.target, p.target, 1e-6),
        `${curve}/${speed} 锚点 target 过点 ${p.id}`);
      // fov 锚点值
      assert(r && approx(r.fov, p.fov, 1e-9), `${curve}/${speed} 锚点 fov ${p.id}`);
    }
  }
}

// ---------------- 2. 弧长匀速（uniform） ----------------
console.log("2. 弧长匀速");

{
  // 在单个时间段 [0.3, 0.7] 内等 Δt 采样，弦长增量应近似相等
  const steps = 40;
  const t0 = 0.3, t1 = 0.7;
  let prev = evaluateTrajectory(smoothTraj, t0).position;
  const increments = [];
  for (let k = 1; k <= steps; k++) {
    const t = t0 + ((t1 - t0) * k) / steps;
    const pos = evaluateTrajectory(smoothTraj, t).position;
    increments.push(dist(prev, pos));
    prev = pos;
  }
  const mean = increments.reduce((s, v) => s + v, 0) / increments.length;
  const maxDev = Math.max(...increments.map((v) => Math.abs(v - mean) / mean));
  console.log(`  uniform 段内弦长增量: mean=${mean.toFixed(6)} maxDev=${(maxDev * 100).toFixed(2)}%`);
  assert(mean > 0, "uniform 段内有位移");
  assert(maxDev < 0.05, "uniform 等Δt弧长增量近似相等", `maxDev=${(maxDev * 100).toFixed(2)}%`);
}

// ---------------- 3. ease 端点速度趋零、中点最大 ----------------
console.log("3. ease 速度曲线");

{
  // 直线两点轨迹，便于数值微分速度
  const line = {
    curve: "linear",
    speed: "ease",
    points: [
      { id: "a", position: [0, 0, 0], target: [0, 0, -1], fov: 50, time: 0, track: null },
      { id: "b", position: [10, 0, 0], target: [0, 0, -1], fov: 50, time: 1, track: null },
    ],
  };
  const dt = 1e-4;
  const speedAt = (t) => {
    const pa = evaluateTrajectory(line, t - dt).position;
    const pb = evaluateTrajectory(line, t + dt).position;
    return dist(pa, pb) / (2 * dt);
  };
  const vStart = speedAt(0.01);
  const vMid = speedAt(0.5);
  const vEnd = speedAt(0.99);
  const vQuarter = speedAt(0.25);
  console.log(`  ease 速度: v(0.01)=${vStart.toFixed(3)} v(0.25)=${vQuarter.toFixed(3)} v(0.5)=${vMid.toFixed(3)} v(0.99)=${vEnd.toFixed(3)}`);
  assert(vStart < 0.15 * vMid, "ease 起点速度趋零", `v(0.01)/v(0.5)=${(vStart / vMid).toFixed(3)}`);
  assert(vEnd < 0.15 * vMid, "ease 终点速度趋零", `v(0.99)/v(0.5)=${(vEnd / vMid).toFixed(3)}`);
  assert(vMid > vQuarter && vMid > speedAt(0.75), "ease 中点速度最大");
  assert(approx(vStart, vEnd, 0.05 * vMid), "ease 两端速度对称");
  // ease 仍过锚点
  assert(approxVec(evaluateTrajectory(line, 0).position, [0, 0, 0], 1e-6), "ease 过首锚点");
  assert(approxVec(evaluateTrajectory(line, 1).position, [10, 0, 0], 1e-6), "ease 过尾锚点");
  // smoothstep 函数本身性质
  assert(approx(smoothstep(0), 0) && approx(smoothstep(1), 1) && approx(smoothstep(0.5), 0.5),
    "smoothstep 端点/中点值");
}

// ---------------- 4. linear 模式折线正确 ----------------
console.log("4. linear 折线");

{
  // L 形折线：两段等长，uniform 下 t=0.25 应在第一段中点
  const lShape = {
    curve: "linear",
    speed: "uniform",
    points: [
      { id: "a", position: [0, 0, 0], target: [0, 0, 0], fov: 50, time: 0, track: null },
      { id: "b", position: [1, 0, 0], target: [1, 0, 0], fov: 50, time: 0.5, track: null },
      { id: "c", position: [1, 1, 0], target: [1, 1, 0], fov: 50, time: 1, track: null },
    ],
  };
  const mid = evaluateTrajectory(lShape, 0.25).position;
  assert(approxVec(mid, [0.5, 0, 0], 1e-6), "linear 段内中点", `got [${mid}]`);
  const q3 = evaluateTrajectory(lShape, 0.75).position;
  assert(approxVec(q3, [1, 0.5, 0], 1e-6), "linear 第二段中点", `got [${q3}]`);
  // 无过冲：折线角点外侧不出界（smooth 会过冲，linear 不会）
  let maxX = -Infinity;
  for (let k = 0; k <= 100; k++) {
    const p = evaluateTrajectory(lShape, k / 100).position;
    maxX = Math.max(maxX, p[0]);
  }
  assert(maxX <= 1 + 1e-9, "linear 折线无过冲", `maxX=${maxX}`);
}

// ---------------- 5. 边界 ----------------
console.log("5. 边界");

{
  // 空轨迹 / 单点
  assert(evaluateTrajectory({ points: [] }, 0.5) === null, "空轨迹 → null");
  assert(evaluateTrajectory({ points: [smoothTraj.points[0]] }, 0.5) === null, "单点 → null");
  assert(evaluateTrajectory(null, 0.5) === null, "null 轨迹 → null");
  assert(evaluateTrajectory({}, 0.5) === null, "无 points → null");
  assert(prepareTrajectory({ points: [] }) === null, "prepare 空轨迹 → null");

  // 乱序：内部排序，不改原数组
  const shuffled = {
    curve: "smooth",
    speed: "uniform",
    points: [smoothTraj.points[2], smoothTraj.points[0], smoothTraj.points[3], smoothTraj.points[1]],
  };
  const idsBefore = shuffled.points.map((p) => p.id).join(",");
  for (const t of [0, 0.15, 0.3, 0.5, 0.7, 0.85, 1]) {
    const r1 = evaluateTrajectory(shuffled, t);
    const r2 = evaluateTrajectory(smoothTraj, t);
    assert(r1 && r2 && approxVec(r1.position, r2.position, 1e-9) && approx(r1.fov, r2.fov, 1e-9),
      `乱序等价 t=${t}`);
  }
  assert(shuffled.points.map((p) => p.id).join(",") === idsBefore, "乱序求值不改原数组顺序");

  // 越界 t 钳制
  const first = smoothTraj.points[0];
  const last = smoothTraj.points[smoothTraj.points.length - 1];
  const rUnder = evaluateTrajectory(smoothTraj, -0.5);
  const rOver = evaluateTrajectory(smoothTraj, 1.5);
  assert(approxVec(rUnder.position, first.position, 1e-9) && approx(rUnder.fov, first.fov, 1e-9),
    "t<0 钳制首点");
  assert(approxVec(rOver.position, last.position, 1e-9) && approx(rOver.fov, last.fov, 1e-9),
    "t>1 钳制尾点");
  // 首尾 time 非 0/1 时也钳制
  const shifted = {
    curve: "linear", speed: "uniform",
    points: [
      { id: "a", position: [0, 0, 0], target: [0, 0, 0], fov: 30, time: 0.2, track: null },
      { id: "b", position: [1, 0, 0], target: [1, 0, 0], fov: 70, time: 0.8, track: null },
    ],
  };
  const rBefore = evaluateTrajectory(shifted, 0.1);
  assert(approxVec(rBefore.position, [0, 0, 0], 1e-9) && approx(rBefore.fov, 30, 1e-9),
    "t<首点time 钳制（位置+fov）");
  const rAfter = evaluateTrajectory(shifted, 0.95);
  assert(approxVec(rAfter.position, [1, 0, 0], 1e-9) && approx(rAfter.fov, 70, 1e-9),
    "t>尾点time 钳制（位置+fov）");
  // fov 相邻点线性插值
  const rMid = evaluateTrajectory(shifted, 0.5);
  assert(approx(rMid.fov, 50, 1e-9), "fov 相邻点线性插值", `fov=${rMid.fov}`);
  // 返回 plain array
  assert(Array.isArray(rMid.position) && rMid.position.length === 3 &&
    typeof rMid.position[0] === "number", "返回 plain array [x,y,z]");
}

// ---------------- 6. 跟踪目标 resolveTrack ----------------
console.log("6. 跟踪目标");

{
  const tracked = {
    curve: "linear",
    speed: "uniform",
    points: [
      { id: "a", position: [0, 1, 0], target: [0, 0, 0], fov: 50, time: 0,
        track: { kind: "character", id: "c1" } },
      { id: "b", position: [4, 1, 0], target: [2, 0, 0], fov: 50, time: 1,
        track: { kind: "character", id: "c1" } },
    ],
  };
  // 实时坐标优先
  const dyn = evaluateTrajectory(tracked, 0.5, () => [7, 8, 9]);
  assert(approxVec(dyn.target, [7, 8, 9], 1e-9), "track 实时坐标作为 target");
  // 容忍 Vector3 风格返回值
  const dynV = evaluateTrajectory(tracked, 0.5, () => ({ x: 1, y: 2, z: 3 }));
  assert(approxVec(dynV.target, [1, 2, 3], 1e-9), "track 容忍 {x,y,z} 返回值");
  // resolveTrack 返回 null → 回退静态 target（中点 blend [1,0,0]）
  const fb = evaluateTrajectory(tracked, 0.5, () => null);
  assert(approxVec(fb.target, [1, 0, 0], 1e-9), "resolveTrack=null 回退静态 target");
  // resolveTrack 抛错 → 回退静态
  const fbErr = evaluateTrajectory(tracked, 0.5, () => { throw new Error("boom"); });
  assert(approxVec(fbErr.target, [1, 0, 0], 1e-9), "resolveTrack 抛错回退静态 target");
  // 无 resolveTrack 回调 → 静态
  const noCb = evaluateTrajectory(tracked, 0.5);
  assert(approxVec(noCb.target, [1, 0, 0], 1e-9), "无 resolveTrack 回调回退静态 target");
  // 越界钳制端点也走 track
  const dynEnd = evaluateTrajectory(tracked, 1.5, () => [5, 5, 5]);
  assert(approxVec(dynEnd.target, [5, 5, 5], 1e-9), "钳制端点 track 实时坐标");
  // 混合：仅一端带 track，另一端静态，按时间 blend
  const mixed = {
    curve: "linear", speed: "uniform",
    points: [
      { id: "a", position: [0, 0, 0], target: [0, 0, 0], fov: 50, time: 0,
        track: { kind: "prop", id: "box" } },
      { id: "b", position: [2, 0, 0], target: [4, 0, 0], fov: 50, time: 1, track: null },
    ],
  };
  const rMix = evaluateTrajectory(mixed, 0.5, (tr) => (tr.id === "box" ? [2, 2, 0] : null));
  assert(approxVec(rMix.target, [3, 1, 0], 1e-9), "混合 track/静态端点线性 blend",
    `got [${rMix.target}]`);
}

// ---------------- 7. 辅助函数契约（测试组要用） ----------------
console.log("7. 辅助函数");

{
  const positions = smoothTraj.points.map((p) => p.position);
  const table = buildArcTable(positions, "smooth");
  assert(table && table.totalLength > 0, "buildArcTable totalLength>0");
  assert(table.anchorDist.length === positions.length, "anchorDist 长度=点数");
  assert(approx(table.anchorFrac[0], 0) && approx(table.anchorFrac[positions.length - 1], 1),
    "anchorFrac 首尾为 0/1");
  // 折线弧长精确（弦长=真实弧长）
  const linTable = buildArcTable([[0, 0, 0], [3, 0, 0], [3, 4, 0]], "linear");
  assert(approx(linTable.totalLength, 7, 1e-12), "linear 弧长精确", `L=${linTable.totalLength}`);
  // 弧长反查：半弧长 → 角点
  const prm = arcLengthToParam(linTable, 3);
  assert(prm.seg === 0 && approx(prm.u, 1, 1e-9), "arcLengthToParam 段边界");
  const p35 = sampleCurvePoint([[0, 0, 0], [3, 0, 0], [3, 4, 0]], "linear", 1, 0.875);
  assert(approxVec(p35, [3, 3.5, 0], 1e-9), "sampleCurvePoint linear 段内");
  // prepare + evaluatePrepared 与一步版一致
  const prepared = prepareTrajectory(smoothTraj);
  const r1 = evaluatePreparedTrajectory(prepared, 0.55);
  const r2 = evaluateTrajectory(smoothTraj, 0.55);
  assert(approxVec(r1.position, r2.position, 1e-15) && approx(r1.fov, r2.fov, 1e-15),
    "prepare/evaluatePrepared 与一步版一致");
}

// ---------------- 汇总 ----------------
console.log("");
console.log(`结果: ${passed} passed, ${failed} failed, 共 ${passed + failed} 断言`);
if (failed > 0) {
  console.error("失败项:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("全部通过 ✓");
