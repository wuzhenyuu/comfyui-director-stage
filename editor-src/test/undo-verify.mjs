/** undo-verify.mjs — 撤销/重做契约验收（第二轮审查 P3-2 盲区：undo.js 零覆盖）
 *
 * 本脚本只写测试，不改核心源码。发现的行为缺口在输出与汇总中明确报告。
 *
 * 验收契约（聚焦非骨骼编辑器 UI 通道；骨骼编辑器交互由 bone-editor-verify 覆盖）：
 *  0) 自检：near() 探针能区分相等/不等（防恒绿假测试）
 *  1) 空栈契约：fresh 页面 undo/redo 栈深为 0，performUndo/performRedo 返回 false
 *  2) 道具/机位移动不入 undo 栈（undo.js v3 快照仅覆盖角色通道——如实断言当前行为，
 *     「道具/机位 undo 恢复」为已知覆盖缺口，见汇总报告）
 *  3) 角色 transform：移动模型后 undo 恢复 position/quaternion、redo 重做
 *  4) IK targets：移动 rightArm target 后 undo 恢复、redo 重做（判别式断言：
 *     恢复后离原值更近、离移动值更远）
 *  5) v3 快照骨骼通道：直接旋转骨骼（不经骨骼编辑器 UI）后 undo 恢复 rotation
 *  6) v3 快照 activeId：undo 恢复活动角色
 *  7) 多通道原子性：一次 undo 同时恢复 transform + ikTargets + bones + activeId
 *  8) undo 后再操作截断 redo 分支：getRedoDepth() 归零
 *  9) undo 栈上限 100：压 105 次后深度恒为 100，且 undo 仍可用
 * 10) 截图 test/out/undo.png；页面无 JS 错误
 *
 * 反向验证方法：每个「恢复」断言前先断言「探针检测到变动」（liveness），
 * 恢复断言使用双边判别（离原值近/离错误值远），确保断言非恒真。
 *
 * 用法: node undo-verify.mjs
 */
import { createRequire } from "module";
const require = createRequire("C:/Users/Administrator/AppData/Roaming/npm/node_modules/");
const { chromium } = require("playwright");
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const webRoot = path.join(repoRoot, "web/editor");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".glb": "model/gltf-binary", ".vrm": "model/gltf-binary" };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
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
console.log("静态服务器端口:", port);

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch({ channel: "chrome" }));
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());

// 页面内探针助手
await page.addInitScript(() => {
  window.__t = {
    vec: (o) => o.position.toArray().map((v) => +v.toFixed(6)),
    quat: (o) => o.quaternion.toArray().map((v) => +v.toFixed(6)),
    dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
    near: (a, b, eps) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= eps,
  };
});

await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => !!window.__ds, null, { timeout: 10000 });
// 等待默认 3D 角色自动加载
await page.waitForFunction(
  () => (window.__ds?.externalCharacters?.getAll?.().length ?? 0) >= 1,
  null, { timeout: 25000 }
);
await page.waitForTimeout(500);

// ================= 契约 0：探针自检 =================
const selfTest = await page.evaluate(() => ({
  same: window.__t.near([1, 2, 3], [1, 2, 3], 0.001),
  diff: window.__t.near([1, 2, 3], [1, 2, 3.5], 0.001),
}));
check("契约0 探针自检（near 相等=true / 不等=false）", selfTest.same === true && selfTest.diff === false,
  JSON.stringify(selfTest));

// ================= 契约 1：空栈 =================
const empty = await page.evaluate(() => ({
  undoDepth: window.__ds.getUndoDepth(),
  redoDepth: window.__ds.getRedoDepth(),
  undoRet: window.__ds.performUndo(),
  redoRet: window.__ds.performRedo(),
}));
check("契约1 空栈 undo/redo 返回 false 且深度为 0",
  empty.undoDepth === 0 && empty.redoDepth === 0 && empty.undoRet === false && empty.redoRet === false,
  JSON.stringify(empty));

// ================= 契约 2：道具/机位移动不入 undo 栈（如实断言当前行为） =================
const propCam = await page.evaluate(() => {
  const ds = window.__ds;
  ds.addProp("box", { name: "undo探针盒" });
  const prop = ds.propManager.props[ds.propManager.props.length - 1];
  const cam = ds.cameraManager.getActiveCamera();
  const propBefore = window.__t.vec(prop.mesh);
  const camBefore = window.__t.vec(cam.camera);
  // 模拟用户拖动（props.js/cameras.js 拖拽均不压 undo 栈）
  prop.mesh.position.x += 0.5;
  cam.camera.position.x += 0.5;
  return {
    propBefore, camBefore,
    propMoved: window.__t.vec(prop.mesh),
    camMoved: window.__t.vec(cam.camera),
    undoDepth: ds.getUndoDepth(),
    undoRet: ds.performUndo(),
    propAfter: window.__t.vec(prop.mesh),
    camAfter: window.__t.vec(cam.camera),
  };
});
// 探针活性（node 侧数值判别，防恒绿）
const propMovedDetected = Math.abs(propCam.propMoved[0] - propCam.propBefore[0] - 0.5) < 1e-6;
const camMovedDetected = Math.abs(propCam.camMoved[0] - propCam.camBefore[0] - 0.5) < 1e-6;
check("契约2b 道具/机位移动不入 undo 栈，undo 返回 false 且位置不被破坏",
  propMovedDetected && camMovedDetected &&
  propCam.undoDepth === 0 && propCam.undoRet === false &&
  Math.abs(propCam.propAfter[0] - propCam.propMoved[0]) < 1e-6 &&
  Math.abs(propCam.camAfter[0] - propCam.camMoved[0]) < 1e-6,
  `depth=${propCam.undoDepth}, ret=${propCam.undoRet}（注意：undo 不覆盖道具/机位——见报告）`);

// ================= 契约 3-7：角色通道 undo/redo（第二角色 + 多通道） =================
// 添加第 2 个角色（直接走 manager API，避开 UI 选择器）
const added = await page.evaluate(async () => {
  const mgr = window.__ds.externalCharacters;
  const entry = await mgr.addGLB("/director_stage/models/michelle.glb", "Michelle-2", { fileName: "michelle.glb" });
  return { ok: !!entry, id: entry?.id, count: mgr.getAll().length };
});
check("契约3-pre 添加第 2 个 3D角色成功", added.ok && added.count === 2, JSON.stringify(added));

// 压栈 → 多通道同时变动 → 活性断言 → undo → 恢复断言 → redo → 重做断言
const phase = await page.evaluate(async () => {
  const T = window.__t;
  const ds = window.__ds;
  const mgr = ds.externalCharacters;
  const [c1, c2] = mgr.getAll();
  const bone2 = c2.jointMap.get(2); // RShoulder 骨骼

  mgr.setActive(c1.id);
  const orig = {
    activeId: mgr.getActive()?.id,
    c1pos: T.vec(c1.model),
    c1quat: T.quat(c1.model),
    c2pos: T.vec(c2.model),
    ik1: T.vec(c1.ikTargets.rightArm.target),
    bone2rot: [bone2.rotation.x, bone2.rotation.y, bone2.rotation.z],
  };

  // 压 undo 栈（v3 全角色快照）
  ds.pushUndo();
  const depthAfterPush = ds.getUndoDepth();

  // ── 多通道同时变动 ──
  mgr.setActive(c2.id);                                  // activeId
  c2.model.position.x += 0.6;                            // transform
  c2.model.updateMatrixWorld(true);
  c1.ikTargets.rightArm.target.position.y += 0.3;        // ikTargets
  bone2.rotation.z += 0.4;                               // bones
  bone2.updateMatrixWorld(true);

  const moved = {
    activeId: mgr.getActive()?.id,
    c2pos: T.vec(c2.model),
    ik1: T.vec(c1.ikTargets.rightArm.target),
    bone2rot: [bone2.rotation.x, bone2.rotation.y, bone2.rotation.z],
  };
  return { orig, moved, depthAfterPush, ids: [c1.id, c2.id] };
});
await page.waitForTimeout(200);

// 活性断言用 phase.moved（变动后同步读取，先于 IK 求解帧）；
// live（200ms 稳定后）作为 undo 时刻状态，供 redo 期望值使用（IK 求解会实时修正骨骼）。
const live = await page.evaluate(() => {
  const T = window.__t;
  const mgr = window.__ds.externalCharacters;
  const [c1, c2] = mgr.getAll();
  const bone2 = c2.jointMap.get(2);
  return {
    activeNow: mgr.getActive()?.id,
    c2posNow: T.vec(c2.model),
    ik1Now: T.vec(c1.ikTargets.rightArm.target),
    bone2rotNow: [bone2.rotation.x, bone2.rotation.y, bone2.rotation.z],
  };
});
check("契约3a 探针活性：activeId/transform/ikTargets/bones 变动均被探测到（同步读取）",
  phase.moved.activeId === phase.ids[1] &&
  Math.abs(phase.moved.c2pos[0] - phase.orig.c2pos[0] - 0.6) < 1e-4 &&
  Math.abs(phase.moved.ik1[1] - phase.orig.ik1[1] - 0.3) < 1e-4 &&
  Math.abs(phase.moved.bone2rot[2] - phase.orig.bone2rot[2] - 0.4) < 1e-4,
  `active=${phase.moved.activeId}, Δc2x=${(phase.moved.c2pos[0] - phase.orig.c2pos[0]).toFixed(3)}, Δik1y=${(phase.moved.ik1[1] - phase.orig.ik1[1]).toFixed(3)}, Δbone2z=${(phase.moved.bone2rot[2] - phase.orig.bone2rot[2]).toFixed(3)}`);
check("契约3b 压栈后 undo 深度 +1", phase.depthAfterPush >= 1, `depth=${phase.depthAfterPush}`);

// ── UNDO ──
const undoRes = await page.evaluate(() => {
  const T = window.__t;
  const ds = window.__ds;
  const mgr = ds.externalCharacters;
  const ret = ds.performUndo();
  const [c1, c2] = mgr.getAll();
  const bone2 = c2.jointMap.get(2);
  return {
    ret,
    activeId: mgr.getActive()?.id,
    c2pos: T.vec(c2.model),
    c2quat: T.quat(c2.model),
    ik1: T.vec(c1.ikTargets.rightArm.target),
    bone2rot: [bone2.rotation.x, bone2.rotation.y, bone2.rotation.z],
    redoDepth: ds.getRedoDepth(),
  };
});
await page.waitForTimeout(300);
const undoSettled = await page.evaluate(() => {
  const T = window.__t;
  const mgr = window.__ds.externalCharacters;
  const [c1, c2] = mgr.getAll();
  const bone2 = c2.jointMap.get(2);
  return {
    activeId: mgr.getActive()?.id,
    c2pos: T.vec(c2.model),
    ik1: T.vec(c1.ikTargets.rightArm.target),
    bone2rot: [bone2.rotation.x, bone2.rotation.y, bone2.rotation.z],
  };
});
const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const dRot = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
check("契约4/7 undo 返回 true 且 transform 精确恢复（多通道原子）",
  undoRes.ret === true && d(undoSettled.c2pos, phase.orig.c2pos) < 1e-3 &&
  d(undoSettled.c2pos, phase.moved.c2pos) > 0.3, // 反向：若未恢复则离 moved 近
  `d(orig)=${d(undoSettled.c2pos, phase.orig.c2pos).toFixed(5)}, d(moved)=${d(undoSettled.c2pos, phase.moved.c2pos).toFixed(3)}`);
check("契约5/7 undo 后 IK target 恢复（判别：离原值近、离移动值远）",
  d(undoSettled.ik1, phase.orig.ik1) < d(undoSettled.ik1, phase.moved.ik1) &&
  d(undoSettled.ik1, phase.moved.ik1) > 0.1,
  `d(orig)=${d(undoSettled.ik1, phase.orig.ik1).toFixed(3)}, d(moved)=${d(undoSettled.ik1, phase.moved.ik1).toFixed(3)}`);
check("契约6/7 undo 后骨骼旋转恢复（v3 bones 通道）",
  dRot(undoSettled.bone2rot, phase.orig.bone2rot) < 0.05 &&
  Math.abs(undoSettled.bone2rot[2] - phase.moved.bone2rot[2]) > 0.2,
  `rot.z=${undoSettled.bone2rot[2].toFixed(3)}（orig=${phase.orig.bone2rot[2].toFixed(3)}, moved=${phase.moved.bone2rot[2].toFixed(3)}）`);
check("契约6b/7 undo 后活动角色恢复（v3 activeId）",
  undoSettled.activeId === phase.orig.activeId && undoSettled.activeId === phase.ids[0],
  `active=${undoSettled.activeId}`);
check("契约4b undo 后 redo 栈有内容", undoRes.redoDepth >= 1, `redoDepth=${undoRes.redoDepth}`);

// ── REDO ──
const redoRes = await page.evaluate(() => {
  const ds = window.__ds;
  const ret = ds.performRedo();
  return { ret, undoDepth: ds.getUndoDepth() };
});
await page.waitForTimeout(300);
const redoSettled = await page.evaluate(() => {
  const T = window.__t;
  const mgr = window.__ds.externalCharacters;
  const [c1, c2] = mgr.getAll();
  const bone2 = c2.jointMap.get(2);
  return {
    activeId: mgr.getActive()?.id,
    c2pos: T.vec(c2.model),
    bone2rot: [bone2.rotation.x, bone2.rotation.y, bone2.rotation.z],
  };
});
check("契约4c redo 重做 transform（离 moved 近、离 orig 远）",
  redoRes.ret === true &&
  d(redoSettled.c2pos, phase.moved.c2pos) < 1e-3 && d(redoSettled.c2pos, phase.orig.c2pos) > 0.3,
  `d(moved)=${d(redoSettled.c2pos, phase.moved.c2pos).toFixed(5)}`);
check("契约5c redo 重做骨骼旋转 + 活动角色（期望值=undo 时刻状态，IK 求解已实时修正）",
  Math.abs(redoSettled.bone2rot[2] - live.bone2rotNow[2]) < 0.05 &&
  redoSettled.activeId === live.activeNow &&
  Math.abs(redoSettled.bone2rot[2] - phase.orig.bone2rot[2]) > 1e-3, // 反向：不等于 undo 后原值
  `rot.z=${redoSettled.bone2rot[2].toFixed(3)}（undo时刻=${live.bone2rotNow[2].toFixed(3)}, orig=${phase.orig.bone2rot[2].toFixed(3)}）, active=${redoSettled.activeId}`);

// ================= 契约 8：undo 后再操作截断 redo 分支 =================
const trunc = await page.evaluate(() => {
  const ds = window.__ds;
  const mgr = ds.externalCharacters;
  // 当前在 redo 后状态；先 undo 一次制造 redo 分支
  ds.performUndo();
  const redoBefore = ds.getRedoDepth();
  // 新操作：压栈 + 变动
  ds.pushUndo();
  const c1 = mgr.getAll()[0];
  c1.model.position.z += 0.2;
  return { redoBefore, redoAfter: ds.getRedoDepth() };
});
check("契约8 undo 后新操作截断 redo 分支", trunc.redoBefore >= 1 && trunc.redoAfter === 0,
  `redo ${trunc.redoBefore} → ${trunc.redoAfter}`);

// ================= 契约 9：undo 栈上限 100 =================
const cap = await page.evaluate(() => {
  const ds = window.__ds;
  for (let i = 0; i < 105; i++) ds.pushUndo();
  const depth = ds.getUndoDepth();
  const undoOk = ds.performUndo();
  return { depth, afterUndo: ds.getUndoDepth(), undoOk };
});
check("契约9 undo 栈上限 100（压 105 次深度恒 100，undo 仍可用）",
  cap.depth === 100 && cap.undoOk === true && cap.afterUndo === 99,
  `depth=${cap.depth}, undo→${cap.afterUndo}`);

await page.screenshot({ path: path.join(__dirname, "out", "undo.png") });
console.log("截图: test/out/undo.png");
console.log("JS 错误:", errors.length ? errors : "无");
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
console.log("行为缺口报告：undo.js v3 快照仅覆盖角色通道（transform/ikTargets/bones/activeId）；");
console.log("  道具（props.js）与机位（cameras.js）的拖拽/移动不入 undo 栈，undo 无法恢复——");
console.log("  契约2 已按当前真实行为断言（不破坏、不误报成功），如需支持属功能缺口。");
await browser.close();
server.close();
process.exit(fail === 0 && errors.length === 0 ? 0 : 1);
