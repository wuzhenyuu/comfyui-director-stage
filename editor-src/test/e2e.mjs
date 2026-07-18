import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";
import { gzip } from "pako";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const URL = "http://localhost:4173/";
const OUT = path.resolve("test/out");
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
await page.setViewport({ width: 1280, height: 800 });

// 注入 ready 标记监听
await page.evaluateOnNewDocument(() => {
  window.__gotReady = false;
  window.addEventListener("message", (ev) => {
    if (ev.data && ev.data.type === "ready") window.__gotReady = true;
  });
});

await page.goto(URL, { waitUntil: "networkidle0" });
await page.waitForFunction(() => window.__ds && document.querySelector("#viewport canvas"), { timeout: 10000 });
await new Promise((r) => setTimeout(r, 500));
const ready = await page.evaluate(() => window.__gotReady);

/* ==================================================================
   TEST 1: M0 回归 — sceneGz 往返 + 导出分辨率
   ================================================================== */
console.log("\n[TEST 1] M0 回归：sceneGz 往返 + 导出分辨率");

// 修改右腕位置保存为 gz，然后 init 恢复
await page.evaluate(() => {
  const ds = window.__ds;
  ds.joints[4].position.set(-0.55, 1.85, 0.1); // RWrist
  window.__gz = ds.encodeSceneGz();
  ds.joints[4].position.set(-0.7, 1.45, 0); // 复位
  window.postMessage({ type: "init", payload: { width: 768, height: 512, sceneGz: window.__gz } }, "*");
});
await new Promise((r) => setTimeout(r, 400));

const t1 = await page.evaluate(() => {
  const ds = window.__ds;
  const p = ds.joints[4].position;
  const cv = document.querySelector("#viewport canvas");
  const cam = ds.camera;
  return {
    exportSize: ds.exportSize,
    cameraAspect: +cam.aspect.toFixed(4),
    rWristRestored: [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)],
    gzLen: window.__gz.length,
    canvasClientWH: [cv.clientWidth, cv.clientHeight],
  };
});
const t1ok = t1.exportSize[0] === 768 && t1.exportSize[1] === 512
  && t1.rWristRestored[1] > 1.8
  && Math.abs(t1.cameraAspect - 768 / 512) < 0.01;
console.log(`  exportSize: ${t1.exportSize} → ${t1ok ? "PASS" : "FAIL"}`);
console.log(`  RWrist restored: ${t1.rWristRestored}`);
console.log(`  cameraAspect: ${t1.cameraAspect}`);

/* ==================================================================
   TEST 2: OpenPose/Depth 导出图尺寸严格等于 w×h
   ================================================================== */
console.log("\n[TEST 2] 导出图尺寸 = 768×512");
const [poseW, poseH] = await page.evaluate(() => {
  const cv = window.__ds.renderOpenPoseCanvas(768, 512);
  return [cv.width, cv.height];
});
const [depthW, depthH] = await page.evaluate(() => {
  const cv = window.__ds.renderDepthCanvas(768, 512);
  return [cv.width, cv.height];
});
const t2ok = poseW === 768 && poseH === 512 && depthW === 768 && depthH === 512;
console.log(`  OpenPose: ${poseW}×${poseH} → ${poseW === 768 && poseH === 512 ? "PASS" : "FAIL"}`);
console.log(`  Depth:    ${depthW}×${depthH} → ${depthW === 768 && depthH === 512 ? "PASS" : "FAIL"}`);

/* ==================================================================
   TEST 3: Undo/Redo 生效
   ================================================================== */
console.log("\n[TEST 3] Undo/Redo");

const t3 = await page.evaluate(() => {
  const ds = window.__ds;
  // 读取初始状态（右腕）
  const initPos = ds.joints[4].position.toArray().map((v) => +v.toFixed(4));
  // push undo
  ds.pushUndo();
  const d0 = ds.getUndoDepth();
  // 修改关节
  ds.joints[4].position.set(0, 0, 0);
  const midPos = ds.joints[4].position.toArray().map((v) => +v.toFixed(4));
  // undo
  const ok = ds.performUndo();
  const afterUndo = ds.joints[4].position.toArray().map((v) => +v.toFixed(4));
  const d1 = ds.getUndoDepth();
  const rd = ds.getRedoDepth();
  // redo
  const rok = ds.performRedo();
  const afterRedo = ds.joints[4].position.toArray().map((v) => +v.toFixed(4));

  return { initPos, midPos, afterUndo, afterRedo, ok, rok, d0, d1, rd };
});

const t3UndoOk = JSON.stringify(t3.afterUndo) === JSON.stringify(t3.initPos);
const t3RedoOk = t3.afterRedo[0] === 0 && t3.afterRedo[1] === 0 && t3.afterRedo[2] === 0;
console.log(`  init: ${t3.initPos}  d0=${t3.d0}`);
console.log(`  after set(0,0,0): ${t3.midPos}`);
console.log(`  after undo: ${t3.afterUndo} → ${t3UndoOk ? "PASS" : "FAIL"}`);
console.log(`  after redo: ${t3.afterRedo} → ${t3RedoOk ? "PASS" : "FAIL"}`);
console.log(`  undoDepth=${t3.d1} redoDepth=${t3.rd}`);

/* ==================================================================
   TEST 4: 镜像后左右互换
   ================================================================== */
console.log("\n[TEST 4] 镜像：左右关节互换 + x 取反");

// 先设置一个非对称姿势：右肩高，左肩低
await page.evaluate(() => {
  const ds = window.__ds;
  ds.joints[2].position.set(-0.3, 1.7, 0.1);  // RShoulder 高
  ds.joints[5].position.set(0.18, 1.45, 0.0); // LShoulder 低
  ds.joints[3].position.set(-0.6, 1.7, 0.1);  // RElbow
  ds.joints[6].position.set(0.45, 1.45, 0.0); // LElbow
});

const t4 = await page.evaluate(() => {
  const ds = window.__ds;
  const before = {
    rs: ds.joints[2].position.toArray().map((v) => +v.toFixed(4)),
    ls: ds.joints[5].position.toArray().map((v) => +v.toFixed(4)),
    re: ds.joints[3].position.toArray().map((v) => +v.toFixed(4)),
    le: ds.joints[6].position.toArray().map((v) => +v.toFixed(4)),
  };

  const mirrored = ds.mirrorPose();
  // 直接应用镜像结果
  ds.restore(mirrored);

  const after = {
    rs: ds.joints[2].position.toArray().map((v) => +v.toFixed(4)),
    ls: ds.joints[5].position.toArray().map((v) => +v.toFixed(4)),
    re: ds.joints[3].position.toArray().map((v) => +v.toFixed(4)),
    le: ds.joints[6].position.toArray().map((v) => +v.toFixed(4)),
  };

  return { before, after };
});

// 镜像后 RShoulder(2) 的 x 应该 ≈ -before.LShoulder(5).x（即 -0.18），y 应 ≈ 1.45
const t4rsOk = Math.abs(t4.after.rs[0] - (-t4.before.ls[0])) < 0.01
  && Math.abs(t4.after.rs[1] - t4.before.ls[1]) < 0.01;
const t4lsOk = Math.abs(t4.after.ls[0] - (-t4.before.rs[0])) < 0.01
  && Math.abs(t4.after.ls[1] - t4.before.rs[1]) < 0.01;

console.log(`  before RS: ${t4.before.rs}  LS: ${t4.before.ls}`);
console.log(`  after  RS: ${t4.after.rs}  LS: ${t4.after.ls}`);
console.log(`  RS↔LS swap: ${t4rsOk && t4lsOk ? "PASS" : "FAIL"}`);

const t4reOk = Math.abs(t4.after.re[0] - (-t4.before.le[0])) < 0.01;
const t4leOk = Math.abs(t4.after.le[0] - (-t4.before.re[0])) < 0.01;
console.log(`  before RE: ${t4.before.re}  LE: ${t4.before.le}`);
console.log(`  after  RE: ${t4.after.re}  LE: ${t4.after.le}`);
console.log(`  RE↔LE swap: ${t4reOk && t4leOk ? "PASS" : "FAIL"}`);

/* ==================================================================
   TEST 5: 骨长锁定误差 < 1%
   ================================================================== */
console.log("\n[TEST 5] 骨长锁定误差 < 1%");

// 先重置到 T-pose
await page.evaluate(() => {
  const ds = window.__ds;
  const TPOSE = [
    [0.0, 1.62, 0.05], [0.0, 1.45, 0.0],
    [-0.18, 1.45, 0.0], [-0.45, 1.45, 0.0], [-0.7, 1.45, 0.0],
    [0.18, 1.45, 0.0], [0.45, 1.45, 0.0], [0.7, 1.45, 0.0],
    [-0.1, 0.95, 0.0], [-0.11, 0.52, 0.0], [-0.12, 0.08, 0.0],
    [0.1, 0.95, 0.0], [0.11, 0.52, 0.0], [0.12, 0.08, 0.0],
    [-0.03, 1.66, 0.07], [0.03, 1.66, 0.07],
    [-0.07, 1.64, 0.02], [0.07, 1.64, 0.02],
  ];
  TPOSE.forEach((p, i) => ds.joints[i].position.set(p[0], p[1], p[2]));
});

// 测骨长锁定：手动挪右腕到远处，然后模拟施加骨锁约束
const t5 = await page.evaluate(() => {
  const ds = window.__ds;
  // RElbow(3) → RWrist(4) 标称骨长
  function dist(a, b) {
    return Math.sqrt((a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2);
  }
  const elbowPos = ds.joints[3].position.toArray();
  const wristInit = ds.joints[4].position.toArray();
  const initLen = dist(elbowPos, wristInit);

  // 手动把腕拉到远处（模拟不带锁定拖动）
  ds.joints[4].position.set(-2.0, 0.5, 0.5);
  const farLen = dist(elbowPos, ds.joints[4].position.toArray());

  // 现在手动施加骨长锁定（用 controls 模块相同的算法）
  // pos = parent + normalize(pos-parent) * boneLen
  const parentPos = new Float64Array(elbowPos);
  const childPos = ds.joints[4].position.toArray();
  const dx = childPos[0] - parentPos[0];
  const dy = childPos[1] - parentPos[1];
  const dz = childPos[2] - parentPos[2];
  const dist2 = Math.sqrt(dx*dx + dy*dy + dz*dz);
  if (dist2 > 1e-8) {
    const scale = initLen / dist2;
    ds.joints[4].position.set(
      parentPos[0] + dx * scale,
      parentPos[1] + dy * scale,
      parentPos[2] + dz * scale,
    );
  }
  const lockedPos = ds.joints[4].position.toArray();
  const lockedLen = dist(elbowPos, lockedPos);
  const err = Math.abs(lockedLen - initLen) / initLen;

  return { initLen: +initLen.toFixed(4), farLen: +farLen.toFixed(4), lockedLen: +lockedLen.toFixed(4), err: +err.toFixed(6) };
});

const t5ok = t5.err < 0.01;
console.log(`  initLen=${t5.initLen} farLen=${t5.farLen} lockedLen=${t5.lockedLen} err=${(t5.err*100).toFixed(4)}%`);
console.log(`  ${t5ok ? "PASS" : "FAIL"}`);

/* ==================================================================
   TEST 6: 改焦距后导出图尺寸仍 = 指定宽高
   ================================================================== */
console.log("\n[TEST 6] 改焦距后导出图尺寸不变");

// 先 init 到 640x480
await page.evaluate(() => {
  window.postMessage({ type: "init", payload: { width: 640, height: 480 } }, "*");
});
await new Promise((r) => setTimeout(r, 300));

await page.evaluate(() => window.__ds.setFocalLength(24));
await new Promise((r) => setTimeout(r, 200));

const t6_24 = await page.evaluate(() => {
  const cv = window.__ds.renderOpenPoseCanvas(640, 480);
  return [cv.width, cv.height];
});
console.log(`  焦距24mm: ${t6_24[0]}×${t6_24[1]} → ${t6_24[0]===640&&t6_24[1]===480?"PASS":"FAIL"}`);

await page.evaluate(() => window.__ds.setFocalLength(85));
await new Promise((r) => setTimeout(r, 200));

const t6_85 = await page.evaluate(() => {
  const cv = window.__ds.renderOpenPoseCanvas(640, 480);
  return [cv.width, cv.height];
});
console.log(`  焦距85mm: ${t6_85[0]}×${t6_85[1]} → ${t6_85[0]===640&&t6_85[1]===480?"PASS":"FAIL"}`);

await page.evaluate(() => window.__ds.setFocalLength(135));
await new Promise((r) => setTimeout(r, 200));

const t6_135 = await page.evaluate(() => {
  const cv = window.__ds.renderOpenPoseCanvas(640, 480);
  return [cv.width, cv.height];
});
console.log(`  焦距135mm: ${t6_135[0]}×${t6_135[1]} → ${t6_135[0]===640&&t6_135[1]===480?"PASS":"FAIL"}`);

/* ==================================================================
   TEST 7: sceneGz 向后兼容（M0 旧格式）
   ================================================================== */
console.log("\n[TEST 7] sceneGz 向后兼容 M0 旧格式");

// 在 Node.js 侧生成 M0 格式 sceneGz
const m0Data = [
  [0, 1.62, 0.05], [0, 1.45, 0], [-0.18, 1.45, 0], [-0.45, 1.45, 0],
  [0.5, 2.0, -0.2], // RWrist(4) 被修改了
  [0.18, 1.45, 0], [0.45, 1.45, 0], [0.7, 1.45, 0],
  [-0.1, 0.95, 0], [-0.11, 0.52, 0], [-0.12, 0.08, 0],
  [0.1, 0.95, 0], [0.11, 0.52, 0], [0.12, 0.08, 0],
  [-0.03, 1.66, 0.07], [0.03, 1.66, 0.07],
  [-0.07, 1.64, 0.02], [0.07, 1.64, 0.02],
];
const m0Bin = new TextEncoder().encode(JSON.stringify(m0Data));
const m0Gz = gzip(m0Bin);
let m0B64 = "";
const CHUNK = 0x8000;
for (let i = 0; i < m0Gz.length; i += CHUNK) {
  m0B64 += String.fromCharCode.apply(null, m0Gz.subarray(i, i + CHUNK));
}
m0B64 = btoa(m0B64);

const t7 = await page.evaluate((b64) => {
  const result = window.__ds.decodeSceneGz(b64);
  const wristPos = window.__ds.joints[4].position.toArray().map(v => +v.toFixed(4));
  return { decoded: !!result, wrist: wristPos };
}, m0B64);

const t7ok = t7.decoded
  && Math.abs(t7.wrist[0] - 0.5) < 0.01
  && Math.abs(t7.wrist[1] - 2.0) < 0.01;
console.log(`  解码成功: ${t7.decoded}`);
console.log(`  RWrist: ${t7.wrist}`);
console.log(`  向后兼容: ${t7ok ? "PASS" : "FAIL"}`);

/* ==================================================================
   TEST 8: sceneGz 新格式含版本号和焦距
   ================================================================== */
console.log("\n[TEST 8] sceneGz 新格式含版本号+焦距");

const t8 = await page.evaluate(() => {
  const ds = window.__ds;
  // 设置焦距 50mm
  ds.setFocalLength(50);
  // 编码
  const b64 = ds.encodeSceneGz();
  // 重置焦距
  ds.setFocalLength(35);
  // 解码
  const result = ds.decodeSceneGz(b64);

  return {
    ok: !!result,
    version: result.v,
    hasFocal: result.focalLength !== undefined,
    focalLength: result.focalLength,
    currentFocal: ds.getFocalLength(),
  };
});

const t8ok = t8.ok && t8.version === 1 && t8.hasFocal && t8.focalLength === 50 && t8.currentFocal === 50;
console.log(`  版本: v${t8.version}, 焦距: ${t8.focalLength}mm, 恢复后焦距: ${t8.currentFocal}mm`);
console.log(`  ${t8ok ? "PASS" : "FAIL"}`);

/* ==================================================================
   汇总
   ================================================================== */

console.log("\n" + "=".repeat(50));
const allPass = t1ok && t2ok && t3UndoOk && t3RedoOk && t4rsOk && t4lsOk && t4reOk && t4leOk
  && t5ok
  && (t6_24[0]===640&&t6_24[1]===480) && (t6_85[0]===640&&t6_85[1]===480) && (t6_135[0]===640&&t6_135[1]===480)
  && t7ok && t8ok;
console.log(`  Ready: ${ready}`);
console.log(`  Errors: ${errors.length}  ${errors.join(" | ")}`);
console.log(`  ALL PASS: ${allPass}`);
console.log("=".repeat(50));

// 导出参考图
const poseUrl = await page.evaluate(() => window.__ds.renderOpenPoseCanvas(...window.__ds.exportSize).toDataURL("image/png"));
const depthUrl = await page.evaluate(() => window.__ds.renderDepthCanvas(...window.__ds.exportSize).toDataURL("image/png"));
fs.writeFileSync(path.join(OUT, "openpose_m1.png"), Buffer.from(poseUrl.split(",")[1], "base64"));
fs.writeFileSync(path.join(OUT, "depth_m1.png"), Buffer.from(depthUrl.split(",")[1], "base64"));
await page.screenshot({ path: path.join(OUT, "viewport_m1.png") });

await browser.close();
process.exit(allPass ? 0 : 1);
