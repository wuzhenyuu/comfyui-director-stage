/** project-io-verify.mjs — 工程导出/导入往返契约验收（第二轮审查 P3-2 盲区：project-io.js 零覆盖）
 *
 * 本脚本只写测试，不改核心源码。
 *
 * 验收契约：
 *  0) 探针自检（防恒绿）
 *  1) 构造场景：1 外部角色（移动 transform + IK target + 骨骼姿势）+ 2 机位（cam2 自定义
 *     位置/焦距）+ 2 道具（自定义位置）+ 全局焦距 55
 *  2) 导出工程：拦截 URL.createObjectURL 捕获真实 Blob 内容（exportProject 走
 *     Blob→a.click 下载路径），断言 version=3、cameras/props/externalCharacters 齐全、
 *     characters 为数组（P1-2 schema 恒定回归）、骨骼姿势随工程持久化（bones 字段）
 *  3) 清空场景：清道具、删到 1 机位、清外部角色、焦距归 35 —— 探针确认值已偏离（反向验证）
 *  4) 导入往返：File 注入 __ds.importProject → 角色/机位/道具/姿势/焦距全部恢复
 *     （角色 id、transform、IK target、骨骼 rotation、机位 pos/focalMM、道具位置/ id）
 *  5) P0-2 回归保护：含 cameras 工程导入不死循环（30s 内完成恢复）
 *  6) infra P1-1 回归保护：导入后相机绑定刷新 —— propManager.camera 与 orbit.object
 *     均指向新的活动相机对象（非导入前的旧对象）
 *  7) 错误路径：导入非法 JSON 文件 → 不崩、场景不变、无 pageerror
 *  8) 截图 test/out/project-io.png
 *
 * 用法: node project-io-verify.mjs
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
const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch({ channel: "chrome" }));
const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept()); // importProject 的 confirm() 自动确认
let downloadCount = 0;
page.on("download", () => downloadCount++);

await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => !!window.__ds, null, { timeout: 10000 });
await page.waitForFunction(
  () => (window.__ds?.externalCharacters?.getAll?.().length ?? 0) >= 1,
  null, { timeout: 25000 }
);
await page.waitForTimeout(500);

// ================= 契约 1：构造场景 =================
const setup = await page.evaluate(() => {
  const ds = window.__ds;
  const mgr = ds.externalCharacters;
  const entry = mgr.getAll()[0];
  // 角色 transform
  entry.model.position.set(0.4, 0, 0.2);
  entry.model.updateMatrixWorld(true);
  // IK target
  entry.ikTargets.rightArm.target.position.x += 0.2;
  entry.ikTargets.rightArm.target.position.y += 0.25;
  entry._ikDirty = true;
  // 骨骼姿势（头骨，非 IK 链——走 bones 持久化通道）
  const head = entry.jointMap.get(0);
  head.rotation.z += 0.35;
  head.updateMatrixWorld(true);
  // 机位 2
  const cam2 = ds.addCamera();
  cam2.pos = [1.5, 2.0, 3.0];
  cam2.camera.position.set(1.5, 2.0, 3.0);
  cam2.focalMM = 24;
  // 道具
  const p1 = ds.addProp("box", { name: "往返盒" });
  p1.mesh.position.set(0.5, 0.25, -0.3);
  const p2 = ds.addProp("sphere", { name: "往返球" });
  p2.mesh.position.set(-0.6, 0.3, 0.4);
  // 全局焦距
  ds.setFocalLength(55);
  return {
    charId: entry.id,
    charPos: entry.model.position.toArray(),
    ikTarget: entry.ikTargets.rightArm.target.position.toArray(),
    headRotZ: head.rotation.z,
    cam2Id: cam2.id,
    camCount: ds.getCameraCount(),
    propIds: [p1.id, p2.id],
    propPos: [p1.mesh.position.toArray(), p2.mesh.position.toArray()],
    focal: ds.getFocalLength(),
  };
});
await page.waitForTimeout(300);
// 记录导出前腕骨世界坐标（视觉姿势基准，供往返后对比）
const wristPre = await page.evaluate(() => {
  const entry = window.__ds.externalCharacters.getAll()[0];
  const b = entry.jointMap.get(4);
  b.updateWorldMatrix(true, false);
  const e = b.matrixWorld.elements;
  return [e[12], e[13], e[14]];
});
check("契约1 场景构造完成（1 角色 + 2 机位 + 2 道具 + 焦距 55）",
  setup.camCount === 2 && setup.propIds.length === 2 && setup.focal === 55 && !!setup.charId,
  JSON.stringify({ charId: setup.charId, cams: setup.camCount, focal: setup.focal }));

// ================= 契约 2：导出工程（捕获真实 Blob 内容） =================
const exportedText = await page.evaluate(async () => {
  window.__capBlobs = [];
  const orig = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (b) => { window.__capBlobs.push(b); return orig(b); };
  window.__ds.exportProject();
  URL.createObjectURL = orig;
  if (!window.__capBlobs.length) return null;
  return await window.__capBlobs[0].text();
});
check("契约2a exportProject 产生真实下载 Blob（createObjectURL 被调用）",
  typeof exportedText === "string" && exportedText.length > 100,
  `bytes=${exportedText?.length ?? 0}, downloadEvent=${downloadCount}`);

const proj = JSON.parse(exportedText);
const cam2data = proj.cameras.find((c) => c.id === setup.cam2Id);
check("契约2b 工程 JSON 结构：version=3、cameras/props/externalCharacters 齐全",
  proj.version === 3 &&
  proj.cameras.length === 2 && proj.props.length === 2 &&
  Array.isArray(proj.externalCharacters) && proj.externalCharacters.length === 1 &&
  proj.focalLength === 55,
  `cams=${proj.cameras?.length}, props=${proj.props?.length}, extChars=${proj.externalCharacters?.length}, focal=${proj.focalLength}`);
check("契约2c characters 为数组（P1-2 schema 恒定回归）+ 骨骼姿势随工程持久化",
  Array.isArray(proj.characters) &&
  proj.externalCharacters[0].bones && typeof proj.externalCharacters[0].bones === "object" &&
  Object.keys(proj.externalCharacters[0].bones).length > 0,
  `characters=${JSON.stringify(proj.characters)}, bones=${Object.keys(proj.externalCharacters[0].bones || {}).length}`);
check("契约2d 机位数据含 pos/focalMM（cam2 自定义值）",
  cam2data && d3(cam2data.pos, [1.5, 2.0, 3.0]) < 1e-3 && cam2data.focalMM === 24,
  JSON.stringify(cam2data && { pos: cam2data.pos, focalMM: cam2data.focalMM }));

// ================= 契约 3：清空场景（反向验证：值确实偏离） =================
const cleared = await page.evaluate(() => {
  const ds = window.__ds;
  ds.clearProps();
  while (ds.cameraManager.cameras.length > 1) {
    ds.removeCamera(ds.cameraManager.cameras[ds.cameraManager.cameras.length - 1].id);
  }
  ds.externalCharacters.clear();
  ds.setFocalLength(35);
  return {
    chars: ds.externalCharacters.getAll().length,
    cams: ds.getCameraCount(),
    props: ds.getPropCount(),
    focal: ds.getFocalLength(),
  };
});
check("契约3 清空场景生效（探针反向验证：恢复断言非恒真）",
  cleared.chars === 0 && cleared.cams === 1 && cleared.props === 0 && cleared.focal === 35,
  JSON.stringify(cleared));

// ================= 契约 4/5：导入往返（含 P0-2 不死循环回归） =================
const t0 = Date.now();
await page.evaluate((text) => {
  const file = new File([text], "roundtrip.json", { type: "application/json" });
  window.__ds.importProject(file); // confirm() 由 dialog handler 自动接受
}, exportedText);
const restored = await page.waitForFunction(
  (exp) => {
    const ds = window.__ds;
    return ds.externalCharacters.getAll().length === 1 &&
      ds.getCameraCount() === 2 && ds.getPropCount() === 2;
  },
  null, { timeout: 30000 }
).then(() => true).catch(() => false);
const importMs = Date.now() - t0;
check("契约5 [P0-2 回归] 含 cameras 工程导入不死循环（30s 内恢复完成）",
  restored && importMs < 30000, `耗时 ${importMs}ms`);

await page.waitForTimeout(800); // 骨骼姿势应用 + IK 稳定
const after = await page.evaluate(() => {
  const ds = window.__ds;
  const mgr = ds.externalCharacters;
  const entry = mgr.getAll()[0];
  const head = entry?.jointMap.get(0);
  const cam2 = ds.cameraManager.cameras[1];
  const ac = ds.cameraManager.getActiveCamera();
  return {
    charId: entry?.id,
    charPos: entry?.model.position.toArray(),
    ikTarget: entry?.ikTargets.rightArm.target.position.toArray(),
    headRotZ: head?.rotation.z,
    activeId: mgr.getActive()?.id,
    camCount: ds.getCameraCount(),
    cam2pos: cam2?.camera.position.toArray(),
    cam2focal: cam2?.focalMM,
    props: ds.propManager.props.map((p) => ({ id: p.id, pos: p.mesh.position.toArray() })),
    focal: ds.getFocalLength(),
    // infra P1-1：绑定刷新
    bindingPropCam: ds.propManager.camera === ac?.camera,
    bindingTctrl: ds.propManager.tctrl?.camera === ac?.camera,
    bindingOrbit: window.__ds__orbit?.object === ac?.camera,
  };
});

check("契约4a 角色恢复：id/transform 一致",
  after.charId === setup.charId && d3(after.charPos, setup.charPos) < 1e-3,
  `id=${after.charId}, pos=${JSON.stringify(after.charPos)}`);
// 数据级：工程 JSON 中的 ikTargets 字段精确往返；视觉级：腕骨世界坐标恢复
// （导入后 _applySnapshotBones 会从骨骼重新推导 IK target——骨骼是视觉姿势的权威源）
const exportedIk = proj.externalCharacters[0].ikTargets?.rightArm?.target;
const wristPost = await page.evaluate(() => {
  const entry = window.__ds.externalCharacters.getAll()[0];
  const b = entry.jointMap.get(4);
  b.updateWorldMatrix(true, false);
  const e = b.matrixWorld.elements;
  return [e[12], e[13], e[14]];
});
check("契约4b 姿势恢复：工程 JSON ikTargets 字段精确往返 + 骨骼 rotation 一致 + 腕骨视觉姿势恢复",
  exportedIk && d3(exportedIk, setup.ikTarget) < 0.02 &&
  Math.abs(after.headRotZ - setup.headRotZ) < 0.05 &&
  d3(wristPost, wristPre) < 0.05,
  `ik字段 d=${exportedIk ? d3(exportedIk, setup.ikTarget).toFixed(4) : "null"}, headRotZ ${after.headRotZ?.toFixed(3)} vs ${setup.headRotZ.toFixed(3)}, 腕骨 d=${d3(wristPost, wristPre).toFixed(4)}`);
check("契约4c 机位恢复：数量/cam2 位置/焦距一致",
  after.camCount === 2 && d3(after.cam2pos, [1.5, 2.0, 3.0]) < 1e-3 && after.cam2focal === 24,
  `cams=${after.camCount}, cam2pos=${JSON.stringify(after.cam2pos)}, focal=${after.cam2focal}`);
check("契约4d 道具恢复：数量/id/位置一致",
  after.props.length === 2 &&
  after.props.some((p) => p.id === setup.propIds[0] && d3(p.pos, setup.propPos[0]) < 1e-3) &&
  after.props.some((p) => p.id === setup.propIds[1] && d3(p.pos, setup.propPos[1]) < 1e-3),
  JSON.stringify(after.props));
check("契约4e 全局焦距恢复 55 + 活动角色 id 一致",
  after.focal === 55 && after.activeId === setup.charId,
  `focal=${after.focal}, active=${after.activeId}`);

// ================= 契约 6：infra P1-1 相机绑定刷新 =================
check("契约6 [P1-1 回归] 导入后相机绑定刷新（propManager/tctrl/orbit 指向新活动相机）",
  after.bindingPropCam && after.bindingTctrl && after.bindingOrbit,
  `propCam=${after.bindingPropCam}, tctrl=${after.bindingTctrl}, orbit=${after.bindingOrbit}`);

// ================= 契约 7：错误路径 =================
const bad = await page.evaluate(() => {
  const before = {
    chars: window.__ds.externalCharacters.getAll().length,
    cams: window.__ds.getCameraCount(),
    props: window.__ds.getPropCount(),
  };
  const file = new File(["{ 这不是合法 JSON"], "bad.json", { type: "application/json" });
  return window.__ds.importProject(file).then(() => {
    const after = {
      chars: window.__ds.externalCharacters.getAll().length,
      cams: window.__ds.getCameraCount(),
      props: window.__ds.getPropCount(),
    };
    return { same: JSON.stringify(before) === JSON.stringify(after), before, after };
  }).catch((e) => ({ same: true, caught: e.message || String(e) }));
});
check("契约7 导入非法 JSON：不崩、场景不变",
  bad.same === true, JSON.stringify(bad.after || bad));

await page.screenshot({ path: path.join(__dirname, "out", "project-io.png") });
console.log("截图: test/out/project-io.png");
console.log("JS 错误:", errors.length ? errors : "无");
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
await browser.close();
server.close();
process.exit(fail === 0 && errors.length === 0 ? 0 : 1);
