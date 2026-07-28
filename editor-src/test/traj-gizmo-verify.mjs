/** traj-gizmo-verify.mjs — V2-F4 轨迹点 3D gizmo 验收探针
 *
 * 验收契约：
 *  1) gizmo 存在：打开时间轴 + 活动机位有轨迹点 → 场景常亮（group.visible）
 *  2) 轨迹线（Line）+ 编号点标记（3 pos 球 + 3 target 球 + 3 序号 sprite）
 *  3) timeline-bar 刻度联动：#tl-ticks 数量 == 轨迹点数
 *  4) 点击点标记 raycast 选中（真实 mouse.click）→ TransformControls 挂上 proxy
 *  5) 拖动改 position：模拟 dragging-changed/objectChange 序列 → 点位移、插值路径随之变化
 *     （seek 到该点时间，相机位置 == 新点位置）；target 点独立可拖
 *  6) 拖动进 undo 栈：undo 复原、redo 重做
 *  7) 「插入轨迹点」：选中相邻两点中点插入（时间取均值，位置在插值路径上）；undo 可撤
 *  8) 删除点（面板 _ops）；undo 可撤
 *  9) 关时间轴 → 隐藏 gizmo；切无轨迹机位 → 隐藏；切回 → 常亮
 * 10) 截图 test/out/traj-gizmo.png；页面无 JS 错误
 *
 * 用法: node traj-gizmo-verify.mjs
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

await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => !!window.__ds, null, { timeout: 10000 });
await page.waitForTimeout(1200);

// ================= 构造：活动机位 + 3 轨迹点 =================
const setup = await page.evaluate(() => {
  const ds = window.__ds;
  const ui = ds.getTrajectoryUI();
  ui._ops.createTrajectoryForActive();
  const ac = ds.cameraManager.getActiveCamera();
  ui._ops.mutate("测试加3点", () => {
    ac.trajectory.points.push(
      { id: "p0", position: [0, 1, 3], target: [0, 1, 0], fov: 50, time: 0, track: null },
      { id: "p1", position: [2, 1.5, 1], target: [0.5, 1, 0], fov: 50, time: 0.5, track: null },
      { id: "p2", position: [3, 1, -2], target: [0, 1, -1], fov: 50, time: 1, track: null }
    );
  });
  ui.toggleBar(true);
  const g = ui.gizmo;
  return {
    gizmoExists: !!g,
    camId: ac.id,
    undoDepth: ds.getTrajectoryUndoDepth(),
  };
});
check("契约1 gizmo 运行时存在 + 时间轴打开", setup.gizmoExists, JSON.stringify(setup));

// ================= 契约 2：常亮 + 线 + 编号点标记 =================
const scene1 = await page.evaluate(() => {
  const g = window.__ds.getTrajectoryUI().gizmo;
  const kids = g._group.children;
  const markers = kids.filter((c) => c.userData?.dsPoint);
  const posM = markers.filter((c) => c.isMesh && c.userData.dsPoint.kind === "pos");
  const tgtM = markers.filter((c) => c.isMesh && c.userData.dsPoint.kind === "target");
  const sprites = markers.filter((c) => c.isSprite);
  return {
    visible: g._group.visible,
    lines: kids.filter((c) => c.isLine).length,
    pos: posM.length, tgt: tgtM.length, sprites: sprites.length,
    ticks: document.getElementById("tl-ticks").childElementCount,
  };
});
check("契约2 轨迹常亮 + Catmull-Rom 曲线 Line", scene1.visible && scene1.lines >= 1, JSON.stringify(scene1));
check("契约2b 编号点标记（3 球 + 3 target + 3 sprite）",
  scene1.pos === 3 && scene1.tgt === 3 && scene1.sprites === 3, JSON.stringify(scene1));
check("契约3 timeline-bar 刻度 == 轨迹点数", scene1.ticks === 3, `ticks=${scene1.ticks}`);

// ================= 契约 4：raycast 点击选中 =================
// 记录拖动前 t=0.5 的相机姿态（插值路径基准）
const preDrag = await page.evaluate(() => {
  const ds = window.__ds;
  ds.seekTrajectory(0.5);
  const cam = ds.cameraManager.getActiveCamera().camera;
  const pos = cam.position.toArray();
  ds.seekTrajectory(0); // 复位，避免相机正好坐在待点击的标记点上
  return { pos, undoDepth: ds.getTrajectoryUndoDepth() };
});
await page.evaluate(() => {
  // 先把相机摆到概览位（seek 会把相机停在轨迹点上，标记点可能在视锥外）
  const ds = window.__ds;
  const ac = ds.cameraManager.getActiveCamera();
  ac.camera.position.set(5, 4, 7);
  window.__ds__orbit.target.set(0.5, 1, 0);
  window.__ds__orbit.update();
});
await page.waitForTimeout(400); // 等帧渲染：marker matrixWorld 就绪（raycast 依赖）
const clickPos = await page.evaluate(() => {
  const ds = window.__ds;
  const g = ds.getTrajectoryUI().gizmo;
  const marker = g._group.children.find((c) =>
    c.isMesh && c.userData?.dsPoint?.source === "traj" &&
    c.userData.dsPoint.index === 1 && c.userData.dsPoint.kind === "pos");
  const v = marker.position.clone().project(ds.camera);
  // 必须用 gizmo 内部同一个 canvas 的 rect（#viewport 容器 rect 与 canvas 不同，坐标会偏）
  const rect = (window.__ds.__tctrl?.domElement || document.getElementById("viewport")).getBoundingClientRect();
  return {
    x: rect.left + ((v.x + 1) / 2) * rect.width,
    y: rect.top + ((1 - v.y) / 2) * rect.height,
    inFront: v.z < 1 && Math.abs(v.x) < 0.95 && Math.abs(v.y) < 0.95,
  };
});
check("契约4 点标记在视口内可点击", clickPos.inFront, JSON.stringify(clickPos));
await page.mouse.click(clickPos.x, clickPos.y);
await page.waitForTimeout(200);
const sel1 = await page.evaluate(() => {
  const g = window.__ds.getTrajectoryUI().gizmo;
  return {
    sel: g.selection,
    attached: g._tctrl.object === g._proxy,
    proxyPos: g._proxy.position.toArray(),
  };
});
check("契约4b 点击点标记 → 选中 + TransformControls 挂上",
  sel1.sel?.index === 1 && sel1.sel?.kind === "pos" && sel1.attached, JSON.stringify(sel1));
check("契约4c proxy 位于选中点",
  Math.abs(sel1.proxyPos[0] - 2) < 1e-3 && Math.abs(sel1.proxyPos[1] - 1.5) < 1e-3 && Math.abs(sel1.proxyPos[2] - 1) < 1e-3,
  JSON.stringify(sel1.proxyPos));

// ================= 契约 5：拖动改 position → 插值路径随之变化 =================
const drag = await page.evaluate(() => {
  const ds = window.__ds;
  const ui = ds.getTrajectoryUI();
  const g = ui.gizmo;
  const before = ds.getTrajectoryUndoDepth();
  // 模拟真实拖拽事件序列（dragging-changed → objectChange → dragging-changed）
  g._tctrl.dispatchEvent({ type: "dragging-changed", value: true });
  g._proxy.position.set(5, 2, 5);
  g._tctrl.dispatchEvent({ type: "objectChange" });
  const midDrag = ds.cameraManager.getActiveCamera().trajectory.points[1].position.slice();
  g._tctrl.dispatchEvent({ type: "dragging-changed", value: false });
  const after = ds.getTrajectoryUndoDepth();
  const finalPt = ds.cameraManager.getActiveCamera().trajectory.points[1].position.slice();
  // 插值路径随之变化：seek 到该点时间（锚点过点）→ 相机位置 == 新点位置
  ds.seekTrajectory(0.5);
  const camPos = ds.cameraManager.getActiveCamera().camera.position.toArray();
  return { before, after, midDrag, finalPt, camPos };
});
check("契约5 拖动实时写点（objectChange）",
  Math.abs(drag.midDrag[0] - 5) < 1e-6 && Math.abs(drag.midDrag[2] - 5) < 1e-6, JSON.stringify(drag.midDrag));
check("契约5b 拖动后插值路径过新点（seek 0.5 → 相机 == 新位置）",
  Math.abs(drag.camPos[0] - 5) < 1e-3 && Math.abs(drag.camPos[1] - 2) < 1e-3 && Math.abs(drag.camPos[2] - 5) < 1e-3,
  JSON.stringify(drag.camPos));
check("契约5c 拖动进 undo 栈（深度 +1）", drag.after === drag.before + 1, `${drag.before}→${drag.after}`);
const preDragDist = Math.hypot(
  drag.camPos[0] - preDrag.pos[0], drag.camPos[1] - preDrag.pos[1], drag.camPos[2] - preDrag.pos[2]);
check("契约5d 拖动后 t=0.5 姿态与拖动前不同", preDragDist > 1, `dist=${preDragDist.toFixed(2)}`);

// ================= 契约 6：undo / redo =================
const undo1 = await page.evaluate(() => {
  const ds = window.__ds;
  ds.trajectoryUndo();
  const p1 = ds.cameraManager.getActiveCamera().trajectory.points[1].position.slice();
  ds.seekTrajectory(0.5);
  const camPos = ds.cameraManager.getActiveCamera().camera.position.toArray();
  ds.trajectoryRedo();
  const p1r = ds.cameraManager.getActiveCamera().trajectory.points[1].position.slice();
  ds.trajectoryUndo(); // 回到原始位置，保持后续断言基准
  const p1u = ds.cameraManager.getActiveCamera().trajectory.points[1].position.slice();
  return { p1, camPos, p1r, p1u };
});
check("契约6 undo 复原拖动的点 + 插值路径回退",
  Math.abs(undo1.p1[0] - 2) < 1e-6 && Math.abs(undo1.camPos[0] - preDrag.pos[0]) < 1e-3,
  JSON.stringify({ p1: undo1.p1, camPos: undo1.camPos.map((v) => +v.toFixed(2)) }));
check("契约6b redo 重做 / 再 undo 复原",
  Math.abs(undo1.p1r[0] - 5) < 1e-6 && Math.abs(undo1.p1u[0] - 2) < 1e-6, JSON.stringify(undo1));

// ================= 契约 7：target 点独立可拖 =================
const tgtDrag = await page.evaluate(() => {
  const ds = window.__ds;
  const g = ds.getTrajectoryUI().gizmo;
  g.select("traj", 0, "target");
  const before = ds.getTrajectoryUndoDepth();
  g._tctrl.dispatchEvent({ type: "dragging-changed", value: true });
  g._proxy.position.set(9, 9, 9);
  g._tctrl.dispatchEvent({ type: "objectChange" });
  g._tctrl.dispatchEvent({ type: "dragging-changed", value: false });
  const pt = ds.cameraManager.getActiveCamera().trajectory.points[0];
  const ok = Math.abs(pt.target[0] - 9) < 1e-6 && Math.abs(pt.position[0] - 0) < 1e-6; // target 动、position 不动
  ds.trajectoryUndo();
  const restored = ds.cameraManager.getActiveCamera().trajectory.points[0].target.slice();
  g.clearSelection();
  return { ok, depthUp: ds.getTrajectoryUndoDepth() > before, restored };
});
check("契约7 target 点独立拖动（不动 position）+ undo", tgtDrag.ok && tgtDrag.restored[0] !== 9,
  JSON.stringify(tgtDrag));

// ================= 契约 8：插入轨迹点（中点，时间取均值） =================
const ins = await page.evaluate(() => {
  const ds = window.__ds;
  const ui = ds.getTrajectoryUI();
  const g = ui.gizmo;
  g.select("traj", 0, "pos");
  const n0 = ds.cameraManager.getActiveCamera().trajectory.points.length;
  ui._ops.insertPoint();
  const pts = ds.cameraManager.getActiveCamera().trajectory.points;
  const nInsert = pts.length;
  const np = pts[1];
  // 插入点必须落在插值路径上：seek 到其时间 → 相机位置 == 插入点位置
  ds.seekTrajectory(np.time);
  const camPos = ds.cameraManager.getActiveCamera().camera.position.toArray();
  const onPath = Math.hypot(camPos[0] - np.position[0], camPos[1] - np.position[1], camPos[2] - np.position[2]);
  const ticks = document.getElementById("tl-ticks").childElementCount;
  ui._ops.deletePoint(1); // 删除插入点（契约 9）
  const afterDel = ds.cameraManager.getActiveCamera().trajectory.points.length;
  ds.trajectoryUndo(); // 撤删除 → 回到 4 点
  const afterUndo = ds.cameraManager.getActiveCamera().trajectory.points.length;
  ds.trajectoryUndo(); // 撤插入 → 回到 3 点
  const afterUndo2 = ds.cameraManager.getActiveCamera().trajectory.points.length;
  g.clearSelection();
  return { n0, n1: nInsert, time: np.time, onPath, ticks, afterDel, afterUndo, afterUndo2 };
});
check("契约8 插入点：数量 3→4、时间取均值 0.25、落在插值路径上",
  ins.n1 === 4 && Math.abs(ins.time - 0.25) < 1e-6 && ins.onPath < 1e-3,
  JSON.stringify({ n: ins.n1, time: ins.time, onPath: ins.onPath.toExponential(1) }));
check("契约8b 插入后刻度联动刷新", ins.ticks === 4, `ticks=${ins.ticks}`);
check("契约9 删除点 + 两次 undo 依次恢复", ins.afterDel === 3 && ins.afterUndo === 4 && ins.afterUndo2 === 3,
  JSON.stringify(ins));

// ================= 契约 10：显隐联动 =================
const vis = await page.evaluate(() => {
  const ds = window.__ds;
  const ui = ds.getTrajectoryUI();
  const g = ui.gizmo;
  const camId = ds.cameraManager.getActiveCamera().id;
  ui.toggleBar(false);
  const closed = g._group.visible;
  ui.toggleBar(true);
  const reopened = g._group.visible;
  return { closed, reopened, camId };
});
check("契约10 关时间轴 → 隐藏 gizmo；重开 → 常亮", vis.closed === false && vis.reopened === true, JSON.stringify(vis));
// 切机位的 gizmo 联动由 renderLoop 的 activecam-changed 事件驱动（下一帧生效）
await page.evaluate(() => { const c = window.__ds.addCamera(); window.__ds.switchCamera(c.id); });
await page.waitForTimeout(250);
const vis2 = await page.evaluate((camId) => {
  const ds = window.__ds;
  const g = ds.getTrajectoryUI().gizmo;
  const onNewCam = g._group.visible;
  ds.switchCamera(camId);
  return { onNewCam };
}, vis.camId);
await page.waitForTimeout(250);
vis2.onBack = await page.evaluate(() => window.__ds.getTrajectoryUI().gizmo._group.visible);
check("契约10b 切无轨迹机位 → 隐藏；切回 → 常亮", vis2.onNewCam === false && vis2.onBack === true, JSON.stringify(vis2));

// ================= 收尾 =================
await page.screenshot({ path: path.join(__dirname, "out", "traj-gizmo.png") });
check("页面无 JS 错误", errors.length === 0, errors.slice(0, 3).join(" | ") || "无");

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
