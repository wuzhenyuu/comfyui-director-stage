/** trajectory-verify.mjs — 相机轨迹+时间轴 正式测试套件（波次3-E）
 *
 * 依据：projects/director-stage-review/camera-trajectory/DESIGN.md
 * 只写测试，不改 src 源码。入口唯一（probes/trajectory-engine-probe.mjs 的 96 条
 * 引擎断言已吸收进 A 组，旧探针文件删除）。
 *
 * 契约分组：
 *  A. 引擎组（node 直测 src/trajectory.js 纯函数，吸收自探针）：
 *     A1 锚点过点精度（smooth/linear × uniform/ease，位置/target/fov，误差<1e-6）
 *     A2 弧长匀速（uniform 段内等Δt弦长增量近似相等）
 *     A3 ease 端点速度趋零、中点最大、仍过锚点、smoothstep 性质
 *     A4 linear 折线正确（段内中点、无过冲）
 *     A5 边界（空/单点/null→null、乱序等价且不改原数组、越界钳制、fov 插值、plain array）
 *     A6 跟踪目标 resolveTrack（实时坐标优先、{x,y,z} 容忍、null/抛错/无回调回退、混合 blend）
 *     A7 辅助函数（buildArcTable/arcLengthToParam/sampleCurvePoint/prepare 一致性）
 *  B. 浏览器组（playwright + 静态服务器 + mock /upload/image）：
 *     B1 UI：#btnTimeline 切换 #timeline-bar 显隐、为机位创建轨迹、记录当前机位为点
 *     B2 播放：play 后相机沿轨迹运动（Δ>0）、orbit 锁定（enabled=false）、pause/stop 恢复
 *     B3 seekTo(0.5) 精确到位（相机位置=引擎姿态<1e-6）且 orbit.target 同步
 *     B4 跟踪：track 指向运动角色时朝向跟随（fwd 变化）；静态 target 不受角色移动影响（负对照）
 *     B5 scrub：拖滑条 = seek 语义（progress/相机位姿一致）
 *     B6 序列化往返：轨迹点+全局设置 export/import 不丢；旧工程（无 trajectory）导入不报错
 *     B7 独立 undo：recordPoint 后栈深+1、undo 移除、redo 恢复、与 undo v3 互不干扰
 *     B8 多帧导出：2s×8fps=16 帧 performTrajectoryExport → manifest files 16 元素 str[]、
 *        帧号递增、首末帧深度内容不同、导出后相机姿态恢复
 *     B9 页面零 JS 错误
 *
 * 防恒绿：每个契约含反向探针（先确认断言对象处于"应失败"状态，再确认操作后通过）；
 * A0 为断言 harness 自检（必然失败的影子断言必须被计数）。
 *
 * 用法: node trajectory-verify.mjs
 */
import { createRequire } from "module";
const require = createRequire("C:/Users/Administrator/AppData/Roaming/npm/node_modules/");
const { chromium } = require("playwright");
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import {
  evaluateTrajectory,
  prepareTrajectory,
  evaluatePreparedTrajectory,
  buildArcTable,
  arcLengthToParam,
  sampleCurvePoint,
  smoothstep,
} from "../src/trajectory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const webRoot = path.join(repoRoot, "web/editor");
const outDir = path.join(__dirname, "out");
const uploadDir = path.join(outDir, "uploads-trajectory");
fs.mkdirSync(uploadDir, { recursive: true });

// ================= 断言 harness =================
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const approxVec = (a, b, eps = 1e-6) =>
  !!a && !!b && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < eps);
const dist = (a, b) => (a && b) ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : Infinity;

// 契约A0：防恒绿自检 —— 必然失败的影子断言必须让 fail +1（否则整套计数不可信）
{
  const failBefore = fail;
  const savedLog = console.log;
  console.log = () => {};
  check("__selftest_fail__", false);
  console.log = savedLog;
  const counted = fail === failBefore + 1;
  fail = failBefore; // 影子断言不计入总分
  check("契约A0 断言 harness 防恒绿自检（失败必被计数）", counted);
}

/* ================================================================
 * A 组：引擎（吸收 probes/trajectory-engine-probe.mjs 全部断言）
 * ================================================================ */
const engineStart = { pass, fail };
console.log("\n===== A 组：轨迹引擎（node 直测） =====");

/** smooth + uniform 四点轨迹 */
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

// ---------------- A1 锚点过点精度 ----------------
console.log("A1. 锚点过点精度");
for (const curve of ["smooth", "linear"]) {
  for (const speed of ["uniform", "ease"]) {
    const traj = { ...smoothTraj, curve, speed };
    for (const p of traj.points) {
      const r = evaluateTrajectory(traj, p.time);
      check(`A1 ${curve}/${speed} 锚点过点 ${p.id}`,
        r && approxVec(r.position, p.position, 1e-6), r ? `err=${dist(r.position, p.position)}` : "null");
      check(`A1 ${curve}/${speed} 锚点 target 过点 ${p.id}`,
        r && approxVec(r.target, p.target, 1e-6));
      check(`A1 ${curve}/${speed} 锚点 fov ${p.id}`,
        r && approx(r.fov, p.fov, 1e-9));
    }
  }
}

// ---------------- A2 弧长匀速（uniform） ----------------
console.log("A2. 弧长匀速");
{
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
  check("A2 uniform 段内有位移", mean > 0);
  check("A2 uniform 等Δt弧长增量近似相等", maxDev < 0.05, `maxDev=${(maxDev * 100).toFixed(2)}%`);
}

// ---------------- A3 ease 速度曲线 ----------------
console.log("A3. ease 速度曲线");
{
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
  check("A3 ease 起点速度趋零", vStart < 0.15 * vMid, `v(0.01)/v(0.5)=${(vStart / vMid).toFixed(3)}`);
  check("A3 ease 终点速度趋零", vEnd < 0.15 * vMid, `v(0.99)/v(0.5)=${(vEnd / vMid).toFixed(3)}`);
  check("A3 ease 中点速度最大", vMid > vQuarter && vMid > speedAt(0.75));
  check("A3 ease 两端速度对称", approx(vStart, vEnd, 0.05 * vMid));
  check("A3 ease 过首锚点", approxVec(evaluateTrajectory(line, 0).position, [0, 0, 0], 1e-6));
  check("A3 ease 过尾锚点", approxVec(evaluateTrajectory(line, 1).position, [10, 0, 0], 1e-6));
  check("A3 smoothstep 端点/中点值",
    approx(smoothstep(0), 0) && approx(smoothstep(1), 1) && approx(smoothstep(0.5), 0.5));
}

// ---------------- A4 linear 折线 ----------------
console.log("A4. linear 折线");
{
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
  check("A4 linear 段内中点", approxVec(mid, [0.5, 0, 0], 1e-6), `got [${mid}]`);
  const q3 = evaluateTrajectory(lShape, 0.75).position;
  check("A4 linear 第二段中点", approxVec(q3, [1, 0.5, 0], 1e-6), `got [${q3}]`);
  let maxX = -Infinity;
  for (let k = 0; k <= 100; k++) {
    const p = evaluateTrajectory(lShape, k / 100).position;
    maxX = Math.max(maxX, p[0]);
  }
  check("A4 linear 折线无过冲", maxX <= 1 + 1e-9, `maxX=${maxX}`);
}

// ---------------- A5 边界 ----------------
console.log("A5. 边界");
{
  check("A5 空轨迹 → null", evaluateTrajectory({ points: [] }, 0.5) === null);
  check("A5 单点 → null", evaluateTrajectory({ points: [smoothTraj.points[0]] }, 0.5) === null);
  check("A5 null 轨迹 → null", evaluateTrajectory(null, 0.5) === null);
  check("A5 无 points → null", evaluateTrajectory({}, 0.5) === null);
  check("A5 prepare 空轨迹 → null", prepareTrajectory({ points: [] }) === null);

  const shuffled = {
    curve: "smooth",
    speed: "uniform",
    points: [smoothTraj.points[2], smoothTraj.points[0], smoothTraj.points[3], smoothTraj.points[1]],
  };
  const idsBefore = shuffled.points.map((p) => p.id).join(",");
  for (const t of [0, 0.15, 0.3, 0.5, 0.7, 0.85, 1]) {
    const r1 = evaluateTrajectory(shuffled, t);
    const r2 = evaluateTrajectory(smoothTraj, t);
    check(`A5 乱序等价 t=${t}`,
      r1 && r2 && approxVec(r1.position, r2.position, 1e-9) && approx(r1.fov, r2.fov, 1e-9));
  }
  check("A5 乱序求值不改原数组顺序", shuffled.points.map((p) => p.id).join(",") === idsBefore);

  const first = smoothTraj.points[0];
  const last = smoothTraj.points[smoothTraj.points.length - 1];
  const rUnder = evaluateTrajectory(smoothTraj, -0.5);
  const rOver = evaluateTrajectory(smoothTraj, 1.5);
  check("A5 t<0 钳制首点", approxVec(rUnder.position, first.position, 1e-9) && approx(rUnder.fov, first.fov, 1e-9));
  check("A5 t>1 钳制尾点", approxVec(rOver.position, last.position, 1e-9) && approx(rOver.fov, last.fov, 1e-9));

  const shifted = {
    curve: "linear", speed: "uniform",
    points: [
      { id: "a", position: [0, 0, 0], target: [0, 0, 0], fov: 30, time: 0.2, track: null },
      { id: "b", position: [1, 0, 0], target: [1, 0, 0], fov: 70, time: 0.8, track: null },
    ],
  };
  const rBefore = evaluateTrajectory(shifted, 0.1);
  check("A5 t<首点time 钳制（位置+fov）", approxVec(rBefore.position, [0, 0, 0], 1e-9) && approx(rBefore.fov, 30, 1e-9));
  const rAfter = evaluateTrajectory(shifted, 0.95);
  check("A5 t>尾点time 钳制（位置+fov）", approxVec(rAfter.position, [1, 0, 0], 1e-9) && approx(rAfter.fov, 70, 1e-9));
  const rMid = evaluateTrajectory(shifted, 0.5);
  check("A5 fov 相邻点线性插值", approx(rMid.fov, 50, 1e-9), `fov=${rMid.fov}`);
  check("A5 返回 plain array [x,y,z]",
    Array.isArray(rMid.position) && rMid.position.length === 3 && typeof rMid.position[0] === "number");
}

// ---------------- A6 跟踪目标 resolveTrack ----------------
console.log("A6. 跟踪目标");
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
  const dyn = evaluateTrajectory(tracked, 0.5, () => [7, 8, 9]);
  check("A6 track 实时坐标作为 target", approxVec(dyn.target, [7, 8, 9], 1e-9));
  const dynV = evaluateTrajectory(tracked, 0.5, () => ({ x: 1, y: 2, z: 3 }));
  check("A6 track 容忍 {x,y,z} 返回值", approxVec(dynV.target, [1, 2, 3], 1e-9));
  const fb = evaluateTrajectory(tracked, 0.5, () => null);
  check("A6 resolveTrack=null 回退静态 target", approxVec(fb.target, [1, 0, 0], 1e-9));
  const fbErr = evaluateTrajectory(tracked, 0.5, () => { throw new Error("boom"); });
  check("A6 resolveTrack 抛错回退静态 target", approxVec(fbErr.target, [1, 0, 0], 1e-9));
  const noCb = evaluateTrajectory(tracked, 0.5);
  check("A6 无 resolveTrack 回调回退静态 target", approxVec(noCb.target, [1, 0, 0], 1e-9));
  const dynEnd = evaluateTrajectory(tracked, 1.5, () => [5, 5, 5]);
  check("A6 钳制端点 track 实时坐标", approxVec(dynEnd.target, [5, 5, 5], 1e-9));
  const mixed = {
    curve: "linear", speed: "uniform",
    points: [
      { id: "a", position: [0, 0, 0], target: [0, 0, 0], fov: 50, time: 0,
        track: { kind: "prop", id: "box" } },
      { id: "b", position: [2, 0, 0], target: [4, 0, 0], fov: 50, time: 1, track: null },
    ],
  };
  const rMix = evaluateTrajectory(mixed, 0.5, (tr) => (tr.id === "box" ? [2, 2, 0] : null));
  check("A6 混合 track/静态端点线性 blend", approxVec(rMix.target, [3, 1, 0], 1e-9), `got [${rMix.target}]`);
}

// ---------------- A7 辅助函数 ----------------
console.log("A7. 辅助函数");
{
  const positions = smoothTraj.points.map((p) => p.position);
  const table = buildArcTable(positions, "smooth");
  check("A7 buildArcTable totalLength>0", table && table.totalLength > 0);
  check("A7 anchorDist 长度=点数", table.anchorDist.length === positions.length);
  check("A7 anchorFrac 首尾为 0/1",
    approx(table.anchorFrac[0], 0) && approx(table.anchorFrac[positions.length - 1], 1));
  const linTable = buildArcTable([[0, 0, 0], [3, 0, 0], [3, 4, 0]], "linear");
  check("A7 linear 弧长精确", approx(linTable.totalLength, 7, 1e-12), `L=${linTable.totalLength}`);
  const prm = arcLengthToParam(linTable, 3);
  check("A7 arcLengthToParam 段边界", prm.seg === 0 && approx(prm.u, 1, 1e-9));
  const p35 = sampleCurvePoint([[0, 0, 0], [3, 0, 0], [3, 4, 0]], "linear", 1, 0.875);
  check("A7 sampleCurvePoint linear 段内", approxVec(p35, [3, 3.5, 0], 1e-9));
  const prepared = prepareTrajectory(smoothTraj);
  const r1 = evaluatePreparedTrajectory(prepared, 0.55);
  const r2 = evaluateTrajectory(smoothTraj, 0.55);
  check("A7 prepare/evaluatePrepared 与一步版一致",
    approxVec(r1.position, r2.position, 1e-15) && approx(r1.fov, r2.fov, 1e-15));
}

const engineAsserts = (pass - engineStart.pass) + (fail - engineStart.fail);
console.log(`\nA 组引擎断言: ${pass - engineStart.pass} 通过 / ${fail - engineStart.fail} 失败（共 ${engineAsserts} 条，吸收自探针）`);
if (fail > 0) {
  console.error("A 组存在失败，终止（引擎未过则浏览器组无意义）");
  process.exit(1);
}

/* ================================================================
 * B 组：浏览器（UI / 播放 / seek / 跟踪 / scrub / 序列化 / undo / 导出）
 * ================================================================ */
console.log("\n===== B 组：浏览器契约 =====");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".glb": "model/gltf-binary", ".vrm": "model/gltf-binary" };

/** mock /upload/image：抠出 PNG 存盘，回 ComfyUI 风格 JSON（与 apply-e2e 同款） */
function handleMockUpload(req, res) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const m = /filename="([^"]+\.png)"/.exec(body.toString("latin1"));
    const name = m ? m[1] : `upload_${Date.now()}.png`;
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const start = body.indexOf(sig);
    const end = body.indexOf(Buffer.from("IEND"), start);
    if (start >= 0 && end > start) {
      fs.writeFileSync(path.join(uploadDir, name), body.subarray(start, end + 8));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ name, subfolder: "director_stage", type: "input" }));
  });
}

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/upload/image" && req.method === "POST") return handleMockUpload(req, res);
  let file;
  if (p.startsWith("/director_stage/models/")) {
    file = path.join(repoRoot, "assets/models", path.basename(p));
  } else {
    if (p === "/") p = "/index.html";
    file = path.join(webRoot, p);
  }
  if ((!file.startsWith(webRoot) && !file.startsWith(path.join(repoRoot, "assets"))) || !fs.existsSync(file)) {
    res.writeHead(404); res.end("nf"); return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
console.log("静态服务器端口:", port, "（/upload/image 已 mock →", uploadDir, "）");

const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch({ channel: "chrome" }));
const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept()); // importProject 的 confirm() 自动确认

await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => !!window.__ds, null, { timeout: 10000 });
await page.waitForFunction(
  () => (window.__ds?.externalCharacters?.getAll?.().length ?? 0) >= 1,
  null, { timeout: 30000 }
);
await page.waitForFunction(() => !!document.getElementById("btnTimeline"), null, { timeout: 10000 });
await page.waitForTimeout(500);

// 页面内小工具（reload 后需重新注入；本套件不 reload）
await page.evaluate(() => {
  window.__t = {
    ac: () => window.__ds.cameraManager.getActiveCamera(),
    camPos: () => {
      const c = window.__ds.cameraManager.getActiveCamera().camera.position;
      return [c.x, c.y, c.z];
    },
    camQuat: () => {
      const q = window.__ds.cameraManager.getActiveCamera().camera.quaternion;
      return [q.x, q.y, q.z, q.w];
    },
    fwd: () => {
      const c = window.__ds.cameraManager.getActiveCamera().camera;
      const e = c.matrixWorld.elements; // forward = -Z 列
      const x = -e[8], y = -e[9], z = -e[10];
      const l = Math.hypot(x, y, z) || 1;
      return [x / l, y / l, z / l];
    },
    orbitTarget: () => {
      const t = window.__ds__orbit.target;
      return [t.x, t.y, t.z];
    },
    setCam: (px, py, pz, tx, ty, tz) => {
      const ac = window.__ds.cameraManager.getActiveCamera();
      ac.camera.position.set(px, py, pz);
      window.__ds__orbit.target.set(tx, ty, tz);
    },
    clickPanelBtn: (text) => {
      const btns = [...document.querySelectorAll("#trajectory-panel button")];
      const b = btns.find((x) => x.textContent.includes(text));
      if (!b) return false;
      b.click();
      return true;
    },
  };
});

// ================= B1：UI（时间轴按钮显隐 / 创建轨迹 / 记录点） =================
console.log("\n--- B1 UI ---");
// 反向探针：初始隐藏 + 无机位轨迹
const b1pre = await page.evaluate(() => ({
  barDisplay: getComputedStyle(document.getElementById("timeline-bar")).display,
  panelDisplay: getComputedStyle(document.getElementById("trajectory-panel")).display,
  hasTraj: !!window.__ds.cameraManager.getActiveCamera().trajectory,
}));
check("B1a [反向] 初始 #timeline-bar 与编辑面板隐藏、活动机位无轨迹",
  b1pre.barDisplay === "none" && b1pre.panelDisplay === "none" && !b1pre.hasTraj,
  JSON.stringify(b1pre));

await page.click("#btnTimeline");
const b1toggle = await page.evaluate(() => ({
  barDisplay: getComputedStyle(document.getElementById("timeline-bar")).display,
  panelDisplay: getComputedStyle(document.getElementById("trajectory-panel")).display,
}));
check("B1b 点击 #btnTimeline 后 #timeline-bar/面板显示",
  b1toggle.barDisplay === "flex" && b1toggle.panelDisplay === "block",
  JSON.stringify(b1toggle));

// 事件计数（ds-trajectory-changed 契约）
await page.evaluate(() => {
  window.__trajChangedCount = 0;
  window.addEventListener("ds-trajectory-changed", () => window.__trajChangedCount++);
});

// 创建轨迹（点真实面板按钮）
const b1create = await page.evaluate(() => {
  const ok = window.__t.clickPanelBtn("为此机位创建轨迹");
  const traj = window.__ds.cameraManager.getActiveCamera().trajectory;
  return { ok, hasTraj: !!traj, enabled: traj?.enabled, pointsLen: traj?.points?.length ?? -1 };
});
check("B1c 点击「为此机位创建轨迹」→ entry.trajectory 创建（enabled/空点列）",
  b1create.ok && b1create.hasTraj && b1create.enabled === true && b1create.pointsLen === 0,
  JSON.stringify(b1create));

// 记录两个轨迹点（先摆机位，再点真实按钮）
await page.evaluate(() => window.__t.setCam(2, 1.5, 4, 0, 1, 0));
await page.waitForTimeout(120);
const b1p1 = await page.evaluate(() => {
  const ok = window.__t.clickPanelBtn("记录当前机位为轨迹点");
  const p = window.__ds.cameraManager.getActiveCamera().trajectory?.points?.[0];
  return { ok, p };
});
check("B1d 记录点1：位置=当前相机 (2,1.5,4)、target=(0,1,0)、time=0",
  b1p1.ok && b1p1.p && approxVec(b1p1.p.position, [2, 1.5, 4], 1e-6) &&
  approxVec(b1p1.p.target, [0, 1, 0], 1e-6) && approx(b1p1.p.time, 0, 1e-9),
  JSON.stringify(b1p1.p));

await page.evaluate(() => window.__t.setCam(-2, 2, 3, 0, 0.5, 0));
await page.waitForTimeout(120);
const b1p2 = await page.evaluate(() => {
  const ok = window.__t.clickPanelBtn("记录当前机位为轨迹点");
  const pts = window.__ds.cameraManager.getActiveCamera().trajectory?.points;
  return { ok, len: pts?.length ?? -1, p: pts?.[1] };
});
check("B1e 记录点2：位置=(-2,2,3)、time 自动推进(≈0.2)",
  b1p2.ok && b1p2.len === 2 && approxVec(b1p2.p.position, [-2, 2, 3], 1e-6) &&
  b1p2.p.time > 0.1 && b1p2.p.time < 0.3,
  JSON.stringify(b1p2.p && { len: b1p2.len, pos: b1p2.p.position, time: b1p2.p.time }));

// 第二点拉满到 time=1（覆盖全程），duration 缩短到 2s 便于播放契约
await page.evaluate(() => {
  const ops = window.__ds.getTrajectoryUI()._ops;
  ops.updatePoint(1, { time: 1 });
  ops.updateGlobals({ duration: 2 });
});
const b1evt = await page.evaluate(() => ({
  changed: window.__trajChangedCount,
  t1: window.__ds.cameraManager.getActiveCamera().trajectory.points[1].time,
  dur: window.__ds.cameraManager.getActiveCamera().trajectory.duration,
}));
check("B1f ds-trajectory-changed 事件随编辑广播（≥4 次）+ updatePoint/updateGlobals 生效",
  b1evt.changed >= 4 && approx(b1evt.t1, 1, 1e-9) && b1evt.dur === 2,
  JSON.stringify(b1evt));

// ================= B2：播放（运动 / orbit 锁定 / pause / stop） =================
console.log("\n--- B2 播放 ---");
const b2pre = await page.evaluate(() => ({
  playing: window.__ds.trajectoryRuntime.playing,
  orbitEnabled: window.__ds__orbit.enabled,
  camPos: window.__t.camPos(),
}));
check("B2a [反向] 播放前 playing=false、orbit.enabled=true",
  b2pre.playing === false && b2pre.orbitEnabled === true, JSON.stringify({ playing: b2pre.playing, orbit: b2pre.orbitEnabled }));

const b2play = await page.evaluate(() => {
  const ok = window.__ds.playTrajectory();
  return { ok, playing: window.__ds.trajectoryRuntime.playing, orbitEnabled: window.__ds__orbit.enabled };
});
check("B2b play → playing=true 且 orbit 锁定（enabled=false）",
  b2play.ok === true && b2play.playing === true && b2play.orbitEnabled === false,
  JSON.stringify(b2play));

await page.waitForTimeout(600);
const b2mid = await page.evaluate(() => ({
  progress: window.__ds.trajectoryRuntime.progress,
  camPos: window.__t.camPos(),
}));
check("B2c 播放中相机沿轨迹运动（Δposition>0 且 progress 推进）",
  dist(b2mid.camPos, b2pre.camPos) > 0.05 && b2mid.progress > 0.05,
  `Δpos=${dist(b2mid.camPos, b2pre.camPos).toFixed(4)} progress=${b2mid.progress.toFixed(3)}`);

const b2pause = await page.evaluate(() => {
  window.__ds.pauseTrajectory();
  return { playing: window.__ds.trajectoryRuntime.playing, orbitEnabled: window.__ds__orbit.enabled, progress: window.__ds.trajectoryRuntime.progress };
});
check("B2d pause → playing=false 且 orbit 恢复 enabled=true（progress 保持）",
  b2pause.playing === false && b2pause.orbitEnabled === true && b2pause.progress > 0,
  JSON.stringify(b2pause));

await page.evaluate(() => window.__ds.playTrajectory());
await page.waitForTimeout(250);
const b2stop = await page.evaluate(() => {
  window.__ds.stopTrajectory();
  return {
    playing: window.__ds.trajectoryRuntime.playing,
    orbitEnabled: window.__ds__orbit.enabled,
    progress: window.__ds.trajectoryRuntime.progress,
    camPos: window.__t.camPos(),
    p0: window.__ds.cameraManager.getActiveCamera().trajectory.points[0].position,
  };
});
check("B2e stop → progress 归零、orbit 恢复、相机回到轨迹起点（<1e-6）",
  b2stop.playing === false && b2stop.orbitEnabled === true && b2stop.progress === 0 &&
  approxVec(b2stop.camPos, b2stop.p0, 1e-6),
  `camPos=[${b2stop.camPos.map((v) => v.toFixed(4))}] p0=[${b2stop.p0}]`);

// ================= B3：seekTo(0.5) 精确到位 + orbit.target 同步 =================
console.log("\n--- B3 seek ---");
// 先偏离（seek 0.1），反向确认相机不在 0.5 姿态
const b3traj = await page.evaluate(() => {
  window.__ds.seekTrajectory(0.1);
  return JSON.parse(JSON.stringify(window.__ds.cameraManager.getActiveCamera().trajectory, (k, v) => k === "_rev" ? undefined : v));
});
const nodePose05 = evaluateTrajectory(b3traj, 0.5); // node 引擎独立基准
const b3away = await page.evaluate(() => window.__t.camPos());
check("B3a [反向] seek(0.1) 后相机偏离 0.5 姿态", dist(b3away, nodePose05.position) > 1e-3,
  `d=${dist(b3away, nodePose05.position).toFixed(4)}`);

const b3 = await page.evaluate(() => {
  const pose = window.__ds.seekTrajectory(0.5);
  return {
    pose,
    progress: window.__ds.trajectoryRuntime.progress,
    camPos: window.__t.camPos(),
    orbitTarget: window.__t.orbitTarget(),
  };
});
check("B3b seekTo(0.5)：progress=0.5 且相机位置精确到位（<1e-6）",
  approx(b3.progress, 0.5, 1e-12) && approxVec(b3.camPos, b3.pose.position, 1e-6),
  `camPos=[${b3.camPos.map((v) => v.toFixed(6))}]`);
check("B3c 页面姿态与 node 引擎独立基准一致（<1e-6）+ orbit.target 同步轨迹目标",
  approxVec(b3.pose.position, nodePose05.position, 1e-6) &&
  approxVec(b3.orbitTarget, b3.pose.target, 1e-6),
  `orbitTarget=[${b3.orbitTarget.map((v) => v.toFixed(4))}] target=[${b3.pose.target.map((v) => v.toFixed(4))}]`);

// ================= B4：跟踪（track 运动角色朝向跟随 + 静态负对照） =================
console.log("\n--- B4 跟踪 ---");
const b4char = await page.evaluate(() => {
  const e = window.__ds.externalCharacters.getAll()[0];
  return { id: e.id, name: e.name };
});
// 负对照：track=null 时移动角色，静态 target 朝向不变
await page.evaluate(() => window.__ds.seekTrajectory(0.5));
await page.waitForTimeout(80);
const b4n1 = await page.evaluate(() => window.__t.fwd());
await page.evaluate(() => {
  const e = window.__ds.externalCharacters.getAll()[0];
  e.model.position.x += 0.8;
  e.model.updateMatrixWorld(true);
  window.__ds.seekTrajectory(0.5);
});
await page.waitForTimeout(80);
const b4n2 = await page.evaluate(() => window.__t.fwd());
check("B4a [负对照] 静态 target 时角色移动不影响相机朝向（fwd 不变）",
  dist(b4n1, b4n2) < 1e-9, `Δfwd=${dist(b4n1, b4n2).toExponential(2)}`);

// 双点挂 track → 角色移动后朝向跟随
const b4t = await page.evaluate(async (charId) => {
  const ops = window.__ds.getTrajectoryUI()._ops;
  const track = { kind: "character", id: charId };
  ops.updatePoint(0, { track });
  ops.updatePoint(1, { track });
  const rt = () => window.__ds.trajectoryRuntime.resolveTrack(track);
  const rt1 = rt();
  window.__ds.seekTrajectory(0.5);
  await new Promise((r) => setTimeout(r, 80));
  const fwd1 = window.__t.fwd();
  const pose1 = window.__ds.trajectoryRuntime.seekTo(0.5);
  // 角色再移动 → 重新 seek → 朝向应变化
  const e = window.__ds.externalCharacters.getAll()[0];
  e.model.position.x += 0.8;
  e.model.updateMatrixWorld(true);
  const rt2 = rt();
  window.__ds.seekTrajectory(0.5);
  await new Promise((r) => setTimeout(r, 80));
  const fwd2 = window.__t.fwd();
  return { rt1, rt2, fwd1, fwd2, poseTarget1: pose1.target };
}, b4char.id);
check("B4b resolveTrack 解析角色骨盆实时坐标（非 null 且随移动变化）",
  Array.isArray(b4t.rt1) && Array.isArray(b4t.rt2) && dist(b4t.rt1, b4t.rt2) > 0.5,
  `rt1=[${b4t.rt1?.map((v) => v.toFixed(3))}] rt2=[${b4t.rt2?.map((v) => v.toFixed(3))}]`);
check("B4c track 双点时 seek 的 effectiveTarget=角色实时坐标（<1e-6）",
  approxVec(b4t.poseTarget1, b4t.rt1, 1e-6),
  `target=[${b4t.poseTarget1.map((v) => v.toFixed(4))}]`);
check("B4d 跟踪目标移动后相机朝向跟随（fwd 变化>1e-4）",
  dist(b4t.fwd1, b4t.fwd2) > 1e-4, `Δfwd=${dist(b4t.fwd1, b4t.fwd2).toFixed(5)}`);

// ================= B5：scrub（拖滑条 = seek 语义） =================
console.log("\n--- B5 scrub ---");
const b5pre = await page.evaluate(() => window.__ds.trajectoryRuntime.progress);
check("B5a [反向] scrub 前 progress≠0.25", Math.abs(b5pre - 0.25) > 0.01, `progress=${b5pre.toFixed(3)}`);
const b5 = await page.evaluate(async () => {
  const s = document.getElementById("tl-slider");
  s.value = "250";
  s.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  const camPosScrubbed = window.__t.camPos();
  const progress = window.__ds.trajectoryRuntime.progress;
  const pose = window.__ds.seekTrajectory(0.25); // seek 基准（同 t 重放）
  return { camPosScrubbed, progress, posePos: pose.position };
});
check("B5b 拖滑条=seek：progress=0.25 且相机位姿与 seekTrajectory(0.25) 一致（<1e-6）",
  approx(b5.progress, 0.25, 1e-9) && approxVec(b5.camPosScrubbed, b5.posePos, 1e-6),
  `progress=${b5.progress} Δpos=${dist(b5.camPosScrubbed, b5.posePos).toExponential(2)}`);

// ================= B7：独立 undo（与 undo v3 互不干扰） =================
console.log("\n--- B7 独立 undo ---");
const b7a = await page.evaluate(() => {
  const ds = window.__ds;
  const pts = () => ds.cameraManager.getActiveCamera().trajectory.points.length;
  const before = { trajDepth: ds.getTrajectoryUndoDepth(), mainDepth: ds.getUndoDepth(), pts: pts() };
  ds.getTrajectoryUI()._ops.recordPoint(); // 轨迹编辑
  const afterRec = { trajDepth: ds.getTrajectoryUndoDepth(), mainDepth: ds.getUndoDepth(), pts: pts() };
  ds.pushUndo(); // undo v3（角色姿势栈）
  const afterPush = { trajDepth: ds.getTrajectoryUndoDepth(), mainDepth: ds.getUndoDepth() };
  return { before, afterRec, afterPush };
});
check("B7a recordPoint → 轨迹 undo 栈深+1、点数+1、undo v3 栈深不变",
  b7a.afterRec.trajDepth === b7a.before.trajDepth + 1 &&
  b7a.afterRec.pts === b7a.before.pts + 1 &&
  b7a.afterRec.mainDepth === b7a.before.mainDepth,
  JSON.stringify({ before: b7a.before, after: b7a.afterRec }));
check("B7b pushUndo（undo v3）→ 主栈+1、轨迹栈不变（互不干扰①）",
  b7a.afterPush.mainDepth === b7a.before.mainDepth + 1 &&
  b7a.afterPush.trajDepth === b7a.afterRec.trajDepth,
  JSON.stringify(b7a.afterPush));

const b7b = await page.evaluate(() => {
  const ds = window.__ds;
  const pts = () => ds.cameraManager.getActiveCamera().trajectory.points.length;
  const undoOk = ds.trajectoryUndo();
  const afterUndo = { pts: pts(), mainDepth: ds.getUndoDepth() };
  const redoOk = ds.trajectoryRedo();
  const afterRedo = { pts: pts() };
  const mainUndoOk = ds.performUndo(); // undo v3 弹栈：不得触碰轨迹
  const afterMain = { pts: pts() };
  return { undoOk, afterUndo, redoOk, afterRedo, mainUndoOk, afterMain };
});
check("B7c trajectoryUndo 移除该点、主栈不变（互不干扰②）；trajectoryRedo 恢复",
  b7b.undoOk === true && b7b.afterUndo.pts === b7a.before.pts &&
  b7b.afterUndo.mainDepth === b7a.afterPush.mainDepth &&
  b7b.redoOk === true && b7b.afterRedo.pts === b7a.before.pts + 1,
  JSON.stringify(b7b));
check("B7d performUndo（undo v3）不触碰轨迹点列",
  b7b.afterMain.pts === b7a.before.pts + 1, `pts=${b7b.afterMain.pts}`);
// 收尾：撤销掉 B7 多记的点，恢复 2 点轨迹供 B8/B6 使用
await page.evaluate(() => window.__ds.trajectoryUndo());

// ================= B8：多帧导出（2s×8fps=16 帧） =================
console.log("\n--- B8 多帧导出 ---");
// 清空上传目录，确保帧文件计数干净
for (const f of fs.readdirSync(uploadDir)) fs.unlinkSync(path.join(uploadDir, f));
await page.evaluate(() => {
  const ops = window.__ds.getTrajectoryUI()._ops;
  ops.updateGlobals({ duration: 2, fps: 8, curve: "linear", speed: "uniform" });
  // 把相机摆到远离轨迹起点的姿态（反向探针：证明导出确实动过相机）
  window.__t.setCam(0, 3, 6, 0, 1, 0);
});
await page.waitForTimeout(120);

const b8 = await page.evaluate(async () => {
  const ds = window.__ds;
  const ac = ds.cameraManager.getActiveCamera();
  const pre = {
    pos: ac.camera.position.toArray(),
    quat: ac.camera.quaternion.toArray(),
    fov: ac.camera.fov,
    aspect: ac.camera.aspect,
    entryPos: ac.pos.slice(),
    entryTarget: ac.target.slice(),
  };
  const { manifest } = await ds.performTrajectoryExport(ac, ac.trajectory, {
    exportW: 256,
    exportH: 256,
    enabledPasses: ["depth"],
    getSceneGz: () => "",
  });
  const post = {
    pos: ac.camera.position.toArray(),
    quat: ac.camera.quaternion.toArray(),
    fov: ac.camera.fov,
    aspect: ac.camera.aspect,
    entryPos: ac.pos.slice(),
    entryTarget: ac.target.slice(),
  };
  return { pre, post, manifest, trajStart: ac.trajectory.points[0].position };
});

const b8m = b8.manifest;
const b8cam = b8m?.cameras?.[0];
const b8depth = b8cam?.files?.depth;
check("B8a manifest 结构：version=2、fps=8、frameCount=16、files.depth 为 16 元素 str[]",
  b8m?.version === 2 && b8m?.fps === 8 && b8m?.frameCount === 16 &&
  Array.isArray(b8depth) && b8depth.length === 16 && b8depth.every((f) => typeof f === "string"),
  `fps=${b8m?.fps} frameCount=${b8m?.frameCount} depth=${Array.isArray(b8depth) ? b8depth.length : typeof b8depth}`);

const b8frames = (b8depth || []).map((f) => {
  const m = /_f(\d{4})_/.exec(f);
  return m ? parseInt(m[1], 10) : -1;
});
check("B8b 帧号文件名 1 起始 4 位递增（f0001..f0016 顺序）",
  b8frames.length === 16 && b8frames.every((n, i) => n === i + 1),
  `frames=[${b8frames.slice(0, 4)}…${b8frames.slice(-2)}]`);

const b8disk = fs.readdirSync(uploadDir).filter((f) => f.includes("_f") && f.endsWith(".png")).sort();
let b8diff = false, b8firstBuf = null, b8lastBuf = null;
{
  const first = b8disk.find((f) => f.includes("_f0001_"));
  const last = b8disk.find((f) => f.includes("_f0016_"));
  if (first && last) {
    b8firstBuf = fs.readFileSync(path.join(uploadDir, first));
    b8lastBuf = fs.readFileSync(path.join(uploadDir, last));
    b8diff = !b8firstBuf.equals(b8lastBuf);
  }
}
check("B8c 磁盘帧文件 16 个且首/末帧深度内容不同（相机确实沿轨迹移动）",
  b8disk.length === 16 && b8diff,
  `disk=${b8disk.length} first=${b8firstBuf?.length ?? 0}B last=${b8lastBuf?.length ?? 0}B diff=${b8diff}`);

const b8firstPose = b8cam?.cameraParams?.extrinsics?.position;
check("B8d [反向+恢复] 首帧姿态=轨迹起点（≠导出前姿态）且导出后相机姿态完整恢复（<1e-6）",
  approxVec(b8firstPose, b8.trajStart, 1e-3) && dist(b8firstPose, b8.pre.pos) > 0.5 &&
  approxVec(b8.post.pos, b8.pre.pos, 1e-6) && approxVec(b8.post.quat, b8.pre.quat, 1e-6) &&
  approx(b8.post.fov, b8.pre.fov, 1e-9) && approx(b8.post.aspect, b8.pre.aspect, 1e-9) &&
  approxVec(b8.post.entryPos, b8.pre.entryPos, 1e-6),
  `first=[${b8firstPose?.map((v) => v.toFixed(3))}] pre=[${b8.pre.pos.map((v) => v.toFixed(3))}] post=[${b8.post.pos.map((v) => v.toFixed(3))}]`);
check("B8e manifest 轨迹元信息（trajectory.exportedFrames=16）+ 首帧 pose 字段存在",
  b8cam?.trajectory?.exportedFrames === 16 && b8cam?.trajectory?.frameCount === 16 &&
  Array.isArray(b8cam?.pose?.pos) && Array.isArray(b8cam?.pose?.target),
  JSON.stringify(b8cam?.trajectory));

// ---- 截图（时间轴+轨迹面板可见状态） ----
await page.evaluate(() => {
  window.__ds.seekTrajectory(0.35);
  window.__ds.getTrajectoryUI().refreshPanel();
  window.__ds.getTrajectoryUI().refreshTransport();
});
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(outDir, "trajectory.png") });
check("B8f 截图 test/out/trajectory.png", fs.existsSync(path.join(outDir, "trajectory.png")));

// ================= B6：序列化往返（轨迹点+全局设置 / 旧工程兼容） =================
console.log("\n--- B6 序列化往返 ---");
await page.evaluate(() => {
  const ops = window.__ds.getTrajectoryUI()._ops;
  ops.updateGlobals({ duration: 7, curve: "smooth", speed: "ease", fps: 30 });
});
const b6expected = await page.evaluate(() => {
  const ac = window.__ds.cameraManager.getActiveCamera();
  const t = ac.trajectory;
  return {
    camId: ac.id,
    duration: t.duration, curve: t.curve, speed: t.speed, fps: t.fps, enabled: t.enabled,
    points: t.points.map((p) => ({
      position: p.position, target: p.target, fov: p.fov, time: p.time, track: p.track,
    })),
  };
});
const b6exportedText = await page.evaluate(async () => {
  window.__capBlobs = [];
  const orig = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (b) => { window.__capBlobs.push(b); return orig(b); };
  window.__ds.exportProject();
  URL.createObjectURL = orig;
  if (!window.__capBlobs.length) return null;
  return await window.__capBlobs[0].text();
});
const b6proj = b6exportedText ? JSON.parse(b6exportedText) : null;
const b6camData = b6proj?.cameras?.find((c) => c.id === b6expected.camId);
const b6ptOk = (exp, got) =>
  Array.isArray(got) && got.length === exp.length &&
  exp.every((p, i) =>
    approxVec(p.position, got[i].position, 1e-9) &&
    approxVec(p.target, got[i].target, 1e-9) &&
    approx(p.fov, got[i].fov, 1e-9) &&
    approx(p.time, got[i].time, 1e-9) &&
    JSON.stringify(p.track) === JSON.stringify(got[i].track ?? null));
check("B6a 导出工程 JSON 含完整轨迹（duration/curve/speed/fps/点列/track 逐字段一致）",
  !!b6camData?.trajectory &&
  b6camData.trajectory.duration === 7 && b6camData.trajectory.curve === "smooth" &&
  b6camData.trajectory.speed === "ease" && b6camData.trajectory.fps === 30 &&
  b6ptOk(b6expected.points, b6camData.trajectory.points),
  `cam=${b6expected.camId} pts=${b6camData?.trajectory?.points?.length} dur=${b6camData?.trajectory?.duration}`);

// 反向探针：清掉轨迹
await page.evaluate(() => {
  const ac = window.__ds.cameraManager.getActiveCamera();
  ac.trajectory = null;
  window.dispatchEvent(new CustomEvent("ds-trajectory-changed"));
});
const b6cleared = await page.evaluate(() =>
  !window.__ds.cameraManager.getActiveCamera().trajectory);
check("B6b [反向] 清除后活动机位无轨迹（恢复断言非恒真）", b6cleared);

// 导入往返
await page.evaluate((text) => {
  const file = new File([text], "traj-roundtrip.json", { type: "application/json" });
  return window.__ds.importProject(file);
}, b6exportedText);
const b6restored = await page.waitForFunction(
  (exp) => {
    const entry = window.__ds?.cameraManager?.cameras?.find?.((c) => c.id === exp.camId);
    return entry?.trajectory?.points?.length === exp.points.length &&
      (window.__ds?.externalCharacters?.getAll?.().length ?? 0) >= 1;
  },
  b6expected, { timeout: 30000 }
).then(() => true).catch(() => false);
const b6after = b6restored ? await page.evaluate((camId) => {
  const entry = window.__ds.cameraManager.cameras.find((c) => c.id === camId);
  const t = entry?.trajectory;
  return t ? {
    duration: t.duration, curve: t.curve, speed: t.speed, fps: t.fps,
    points: t.points.map((p) => ({
      position: p.position, target: p.target, fov: p.fov, time: p.time, track: p.track ?? null,
    })),
    undoDepth: window.__ds.getTrajectoryUndoDepth(),
  } : null;
}, b6expected.camId) : null;
check("B6c 导入往返：轨迹全局设置+点列（含 track）完整恢复，undo 栈随工程加载清空",
  !!b6after &&
  b6after.duration === 7 && b6after.curve === "smooth" && b6after.speed === "ease" &&
  b6after.fps === 30 && b6ptOk(b6expected.points, b6after.points) && b6after.undoDepth === 0,
  b6after ? `dur=${b6after.duration} pts=${b6after.points.length} undoDepth=${b6after.undoDepth}` : "轨迹未恢复");

// 旧工程（无 trajectory 字段）导入不报错
const b6old = JSON.parse(b6exportedText);
for (const c of b6old.cameras || []) delete c.trajectory;
const b6errorsBefore = errors.length;
await page.evaluate((text) => {
  const file = new File([text], "traj-old-project.json", { type: "application/json" });
  return window.__ds.importProject(file);
}, JSON.stringify(b6old));
const b6oldOk = await page.waitForFunction(
  () => (window.__ds?.externalCharacters?.getAll?.().length ?? 0) >= 1 &&
    window.__ds?.cameraManager?.cameras?.length >= 1,
  null, { timeout: 30000 }
).then(() => true).catch(() => false);
const b6oldState = b6oldOk ? await page.evaluate(() => ({
  hasTraj: !!window.__ds.cameraManager.getActiveCamera()?.trajectory,
  undoDepth: window.__ds.getTrajectoryUndoDepth(),
})) : null;
check("B6d 旧工程（无 trajectory 字段）导入不报错、轨迹缺席、无新增 JS 错误",
  b6oldOk && b6oldState && !b6oldState.hasTraj && b6oldState.undoDepth === 0 &&
  errors.length === b6errorsBefore,
  b6oldState ? `hasTraj=${b6oldState.hasTraj} newErrors=${errors.length - b6errorsBefore}` : "旧工程导入未完成");

// ================= B9：页面零 JS 错误 =================
const realErrors = errors.filter((e) => !/favicon|404/.test(e));
check("B9 页面零 JS 错误（含缩略图 getScissor 回归）", realErrors.length === 0,
  realErrors.length ? realErrors[0].slice(0, 160) : "无");

console.log(`\n结果: ${pass} 通过 / ${fail} 失败（其中 A 组引擎断言 ${engineAsserts} 条）`);
await browser.close();
server.close();
process.exit(fail === 0 && realErrors.length === 0 ? 0 : 1);
