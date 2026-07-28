/** char-route-probe.mjs — F3 人物行走路线引擎纯数学探针（node 直跑，零 three / 零浏览器）
 *
 * 验收项（对应 DESIGN-V2.md F3 引擎部分）：
 *  A1 锚点过点：smooth/linear 两种曲线，t=point.time 时位置误差 < 1e-6
 *  A2 切线方向：直线东西走向 → heading ≈ ±π/2（yaw = atan2(dx, dz)）
 *  A3 急转弯：L 形 smooth 路线，密采样下相邻切线朝向差有界（切线连续）
 *  A4 smoothHeading：角速度受限（单步 ≤ maxTurnRate×dt）且有限步内收敛
 *  A5 ±π 环绕：prev=+3.0 / target=-3.0 走短弧（不绕远路）
 *  A6 routeLength 精度：64 点折线半圆 vs 解析值 πR（误差 < 0.5%）
 *  A7 loop=false 端点钳制：t01<0 → 首点，t01>1 → 末点
 *  A8 边界：空/单点/全非法点 → null；乱序 points 正确排序且不改原数组
 *  A9 routeAvgSpeed：routeLength/duration 换算 + duration 缺失 → null
 *  A10 flattenRoute：所有点 Y=groundY，原对象不被修改
 *
 * 用法: node char-route-probe.mjs
 */
import {
  evaluateRoute,
  prepareRoute,
  evaluatePreparedRoute,
  smoothHeading,
  wrapAnglePi,
  routeLength,
  routeAvgSpeed,
  flattenRoute,
} from "../../src/char-route.js";

let pass = 0;
let fail = 0;
function assert(cond, label, detail = "") {
  if (cond) {
    pass++;
    console.log(`  PASS ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}${detail ? " — " + detail : ""}`);
  }
}
function near(a, b, eps = 1e-6) {
  return Math.abs(a - b) < eps;
}
function dist3(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// ---------- A1 锚点过点 ----------
console.log("A1 锚点过点 < 1e-6");
const ptsA1 = [
  { id: "p0", position: [0, 0, 0], time: 0 },
  { id: "p1", position: [3, 0.5, 4], time: 0.3 },
  { id: "p2", position: [8, 0, 4], time: 0.7 },
  { id: "p3", position: [10, 1, 0], time: 1 },
];
for (const curve of ["smooth", "linear"]) {
  const route = { points: ptsA1, curve, duration: 6, loop: false };
  let maxErr = 0;
  for (const p of ptsA1) {
    const r = evaluateRoute(route, p.time);
    maxErr = Math.max(maxErr, r ? dist3(r.position, p.position) : Infinity);
  }
  assert(maxErr < 1e-6, `${curve} 锚点过点 maxErr=${maxErr.toExponential(2)}`);
}

// ---------- A2 切线方向（东西直线 → ±π/2） ----------
console.log("A2 直线切线朝向");
{
  const east = evaluateRoute(
    { points: [{ position: [-5, 0, 0], time: 0 }, { position: [5, 0, 0], time: 1 }], curve: "linear" },
    0.5
  );
  assert(near(east.heading, Math.PI / 2, 1e-3), `向东 heading≈+π/2 (got ${east.heading.toFixed(4)})`);
  const west = evaluateRoute(
    { points: [{ position: [5, 0, 0], time: 0 }, { position: [-5, 0, 0], time: 1 }], curve: "linear" },
    0.5
  );
  assert(near(west.heading, -Math.PI / 2, 1e-3), `向西 heading≈-π/2 (got ${west.heading.toFixed(4)})`);
  const north = evaluateRoute(
    { points: [{ position: [0, 0, -5], time: 0 }, { position: [0, 0, 5], time: 1 }], curve: "linear" },
    0.5
  );
  assert(near(north.heading, 0, 1e-3), `向+Z heading≈0 (got ${north.heading.toFixed(4)})`);
  // 端点：单侧差分也应给出正确朝向
  const atStart = evaluateRoute(
    { points: [{ position: [-5, 0, 0], time: 0 }, { position: [5, 0, 0], time: 1 }], curve: "linear" },
    0
  );
  assert(near(atStart.heading, Math.PI / 2, 1e-3), `起点前向差分 heading≈+π/2`);
  const atEnd = evaluateRoute(
    { points: [{ position: [-5, 0, 0], time: 0 }, { position: [5, 0, 0], time: 1 }], curve: "linear" },
    1
  );
  assert(near(atEnd.heading, Math.PI / 2, 1e-3), `终点后向差分 heading≈+π/2`);
}

// ---------- A3 急转弯切线连续 ----------
console.log("A3 L 形急转弯切线连续（smooth）");
{
  const route = {
    points: [
      { position: [0, 0, 0], time: 0 },
      { position: [10, 0, 0], time: 0.5 },
      { position: [10, 0, 10], time: 1 },
    ],
    curve: "smooth",
  };
  const prepared = prepareRoute(route);
  const N = 2000;
  let maxStep = 0;
  let prevH = evaluatePreparedRoute(prepared, 0).heading;
  for (let k = 1; k <= N; k++) {
    const h = evaluatePreparedRoute(prepared, k / N).heading;
    maxStep = Math.max(maxStep, Math.abs(wrapAnglePi(h - prevH)));
    prevH = h;
  }
  // 90° 弯在 2000 采样下若切线连续，单步变化应 << 0.05 rad（不连续则出现 ~π/2 跳变）
  assert(maxStep < 0.05, `密采样相邻朝向差 max=${maxStep.toFixed(5)} rad < 0.05`);
  // 中途朝向应介于 ±π/2 之间（东→北过渡，不走反）
  const mid = evaluatePreparedRoute(prepared, 0.5).heading;
  assert(mid > -1e-3 && mid < Math.PI / 2 + 1e-3, `弯道中点朝向在短弧区间内 (${mid.toFixed(3)})`);
}

// ---------- A4 smoothHeading 限速 + 收敛 ----------
console.log("A4 smoothHeading 角速度受限且收敛");
{
  const dt = 0.05;
  const rate = 2; // rad/s → 单步上限 0.1 rad
  let yaw = 0;
  const target = 1.0;
  let steps = 0;
  let violated = false;
  while (Math.abs(wrapAnglePi(target - yaw)) > 1e-9 && steps < 1000) {
    const next = smoothHeading(yaw, target, dt, rate);
    if (Math.abs(wrapAnglePi(next - yaw)) > rate * dt + 1e-12) violated = true;
    yaw = next;
    steps++;
  }
  assert(!violated, "全程单步转角 ≤ maxTurnRate×dt");
  assert(steps === 10, `1.0rad @2rad/s dt=0.05 → 恰好 10 步收敛 (got ${steps})`);
  assert(near(yaw, target, 1e-9), "收敛到 target");
  // 首步精确值
  assert(near(smoothHeading(0, 1.0, 0.1, 2), 0.2, 1e-12), "首步 = rate×dt = 0.2");
  // 最后一步不 overshoot
  assert(near(smoothHeading(0.95, 1.0, 0.1, 2), 1.0, 1e-12), "末步钳制到 target 不越过");
  // dt=0 / rate=0 → 直接对齐
  assert(near(smoothHeading(0, 1.0, 0, 2), 1.0, 1e-12), "dt=0 → 直接对齐");
  assert(near(smoothHeading(0, 1.0, 0.1, 0), 1.0, 1e-12), "rate=0 → 直接对齐");
}

// ---------- A5 ±π 环绕走短弧 ----------
console.log("A5 ±π 环绕不绕远路");
{
  // prev=+3.0, target=-3.0：直接差 -6.0，短弧差 +0.2832（越过 +π 继续增大）
  const next = smoothHeading(3.0, -3.0, 0.1, 2); // 步长上限 0.2
  assert(near(next, wrapAnglePi(3.2), 1e-12), `走短弧：3.0 → ${next.toFixed(4)}（向 +π 方向而非回绕 -6rad）`);
  assert(Math.abs(wrapAnglePi(next - 3.0)) <= 0.2 + 1e-12, "环绕场景步长仍受限");
  // 收敛验证：环绕路径迭代后到达 target
  let yaw = 3.0;
  for (let k = 0; k < 50 && Math.abs(wrapAnglePi(-3.0 - yaw)) > 1e-9; k++) {
    yaw = smoothHeading(yaw, -3.0, 0.1, 2);
  }
  assert(near(yaw, wrapAnglePi(-3.0), 1e-9), `环绕收敛到 target (${yaw.toFixed(4)})`);
  // 恰好 ±π 对面：wrapAnglePi 归一，abs 差 = π，任一方向合法但步长受限
  const opp = smoothHeading(0, Math.PI, 0.1, 2);
  assert(Math.abs(wrapAnglePi(opp)) <= 0.2 + 1e-12, "正对面步长受限");
  // wrapAnglePi 自身
  assert(near(wrapAnglePi(3 * Math.PI), Math.PI, 1e-12), "wrapAnglePi(3π)=π");
  assert(near(wrapAnglePi(-3 * Math.PI), Math.PI, 1e-12), "wrapAnglePi(-3π)=π（(-π,π] 约定）");
}

// ---------- A6 routeLength 精度（半圆 vs πR） ----------
console.log("A6 routeLength 精度");
{
  const R = 5;
  const M = 64; // 半圆 64 段折线
  const pts = [];
  for (let k = 0; k <= M; k++) {
    const a = (k / M) * Math.PI;
    pts.push({ position: [R * Math.cos(a), 0, R * Math.sin(a)], time: k / M });
  }
  const len = routeLength({ points: pts, curve: "linear" });
  const analytic = Math.PI * R;
  const err = Math.abs(len - analytic) / analytic;
  assert(err < 0.005, `64 段折线半圆 len=${len.toFixed(4)} vs πR=${analytic.toFixed(4)} err=${(err * 100).toFixed(3)}% < 0.5%`);
  // smooth 曲线过同样的点应更接近
  const lenS = routeLength({ points: pts, curve: "smooth" });
  const errS = Math.abs(lenS - analytic) / analytic;
  assert(errS < 0.005, `smooth 半圆 err=${(errS * 100).toFixed(3)}% < 0.5%`);
  // 直线精确
  const lineLen = routeLength({ points: [{ position: [0, 0, 0], time: 0 }, { position: [3, 4, 0], time: 1 }] });
  assert(near(lineLen, 5, 1e-6), `直线 3-4-5 长度=5 (got ${lineLen})`);
}

// ---------- A7 loop=false 端点钳制 ----------
console.log("A7 端点钳制（loop=false）");
{
  const route = {
    points: [
      { position: [1, 0, 1], time: 0.2 },
      { position: [9, 0, 9], time: 0.8 },
    ],
    curve: "linear",
    loop: false,
  };
  const before = evaluateRoute(route, -0.5);
  const after = evaluateRoute(route, 1.5);
  assert(dist3(before.position, [1, 0, 1]) < 1e-9, "t01<首点.time → 钳制到首点");
  assert(dist3(after.position, [9, 0, 9]) < 1e-9, "t01>末点.time → 钳制到末点");
  const atAnchor = evaluateRoute(route, 0.2);
  assert(dist3(atAnchor.position, [1, 0, 1]) < 1e-9, "t01==首点.time → 首点");
}

// ---------- A8 边界 ----------
console.log("A8 边界：空/单点/乱序");
{
  assert(evaluateRoute(null, 0.5) === null, "null route → null");
  assert(evaluateRoute({}, 0.5) === null, "无 points → null");
  assert(evaluateRoute({ points: [] }, 0.5) === null, "空 points → null");
  assert(evaluateRoute({ points: [{ position: [0, 0, 0], time: 0 }] }, 0.5) === null, "单点 → null");
  assert(
    evaluateRoute({ points: [{ position: [0, 0, 0], time: 0 }, { position: null, time: 1 }] }, 0.5) === null,
    "有效点 <2 → null"
  );
  // 乱序：原数组顺序不被修改，求值按 time 排序后正确
  const shuffled = [
    { id: "b", position: [10, 0, 0], time: 1 },
    { id: "a", position: [0, 0, 0], time: 0 },
    { id: "m", position: [4, 0, 0], time: 0.5 },
  ];
  const origOrder = shuffled.map((p) => p.id).join(",");
  const r = evaluateRoute({ points: shuffled, curve: "linear" }, 0.25);
  assert(r && near(r.position[0], 2, 1e-6), `乱序求值 t=0.25 → x=2 (got ${r && r.position[0]})`);
  assert(shuffled.map((p) => p.id).join(",") === origOrder, "原数组顺序未被修改");
  // 乱序锚点过点
  const atM = evaluateRoute({ points: shuffled, curve: "linear" }, 0.5);
  assert(dist3(atM.position, [4, 0, 0]) < 1e-9, "乱序锚点仍精确过点");
  // NaN t01 → 按 0 处理
  const nan = evaluateRoute({ points: shuffled, curve: "linear" }, NaN);
  assert(dist3(nan.position, [0, 0, 0]) < 1e-9, "NaN t01 → 钳到首锚点");
}

// ---------- A9 routeAvgSpeed ----------
console.log("A9 速度换算");
{
  const route = {
    points: [{ position: [0, 0, 0], time: 0 }, { position: [6, 0, 0], time: 1 }],
    curve: "linear",
    duration: 4,
  };
  assert(near(routeAvgSpeed(route), 1.5, 1e-9), "6m/4s = 1.5 m/s");
  assert(routeAvgSpeed({ ...route, duration: 0 }) === null, "duration=0 → null");
  assert(routeAvgSpeed({ points: route.points }) === null, "duration 缺失 → null");
  assert(routeAvgSpeed(null) === null, "无效路线 → null");
}

// ---------- A10 flattenRoute ----------
console.log("A10 flattenRoute 贴地工具");
{
  const route = {
    points: [
      { id: "a", position: [0, 1.2, 0], time: 0 },
      { id: "b", position: [5, 0.3, 5], time: 1 },
    ],
    curve: "smooth",
    duration: 3,
    loop: false,
  };
  const flat = flattenRoute(route, 0);
  assert(flat !== route, "返回新对象");
  assert(flat.points.every((p) => p.position[1] === 0), "所有点 Y=groundY");
  assert(route.points[0].position[1] === 1.2 && route.points[1].position[1] === 0.3, "原对象未被修改");
  assert(flat.points[0].id === "a" && flat.curve === "smooth" && flat.duration === 3, "id/curve/duration 保留");
  assert(flattenRoute(null, 0) === null, "null 输入 → null");
  // 贴地后求值 Y 恒为 0
  const r = evaluateRoute(flat, 0.5);
  assert(near(r.position[1], 0, 1e-9), "贴地后求值 Y=0");
}

// ---------- 汇总 ----------
console.log(`\n==== char-route-probe: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
