/** probe-char-scale.mjs — 临时探针：缩放数学 + gizmo 管线冒烟 */
import { createRequire } from "module";
const require = createRequire("C:/Users/Administrator/AppData/Roaming/npm/node_modules/");
const { chromium } = require("playwright");
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const webRoot = path.join(repoRoot, "web/editor");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".glb": "model/gltf-binary", ".vrm": "model/gltf-binary" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  let file;
  if (p.startsWith("/director_stage/models/")) file = path.join(repoRoot, "assets/models", path.basename(p));
  else { if (p === "/") p = "/index.html"; file = path.join(webRoot, p); }
  if ((!file.startsWith(webRoot) && !file.startsWith(path.join(repoRoot, "assets"))) || !fs.existsSync(file)) { res.writeHead(404); res.end("nf"); return; }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch({ channel: "chrome" }));
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("pageerror", (e) => { errors.push(e.message); console.log("PAGEERROR:", e.message); });
page.on("dialog", (d) => d.accept());

await page.goto(`http://127.0.0.1:${port}/index.html`);
console.log("页面已加载，等待 __ds…");
try {
  await page.waitForFunction(() => !!window.__ds, null, { timeout: 15000 });
} catch (err) {
  const state = await page.evaluate(() => ({
    ds: !!window.__ds, ready: document.readyState,
    scripts: document.scripts.length,
  })).catch((e2) => String(e2));
  console.log("等待 __ds 超时，页面状态:", JSON.stringify(state), "错误:", errors.slice(0, 5));
  throw err;
}
await page.waitForFunction(() => (window.__ds?.externalCharacters?.getAll?.().length ?? 0) >= 1, null, { timeout: 25000 });
await page.waitForTimeout(600);

const r1 = await page.evaluate(() => {
  const ds = window.__ds;
  const e = ds.externalCharacters.getActive();
  const cg = ds.charGizmo;
  return {
    renderMode: ds.renderMode,
    hasSetScale: typeof ds.setCharacterScale === "function",
    hasGetScale: typeof ds.getCharacterScale === "function",
    hasMgrScale: typeof ds.externalCharacters.setCharacterScale === "function",
    hasGizmo: !!cg,
    attachedId: cg?.attachedId,
    helperVisible: cg?.helperVisible,
    gizmoMode: cg?.getMode?.(),
    scale0: ds.getCharacterScale(),
    charMode: ds.characterMode,
    boneMode: ds.boneEditor.isBoneMode(),
  };
});
console.log("基础状态:", JSON.stringify(r1, null, 1));

// 缩放数学：IK 点 = pivot + ds*(v - pivot)
const r2 = await page.evaluate(() => {
  const ds = window.__ds;
  ds.stopAllActions();
  const e = ds.externalCharacters.getActive();
  const pivot = e.model.position.toArray();
  const before = {};
  for (const [n, t] of Object.entries(e.ikTargets)) before[n] = { t: t.target.position.toArray(), p: t.pole.position.toArray() };
  const ok = ds.setCharacterScale(2.0);
  const s = ds.getCharacterScale();
  const dsr = 2.0 / 1.0815; // 实际 delta（michelle 加载缩放 1.0815）
  let maxErr = 0;
  for (const [n, b] of Object.entries(before)) {
    const t = e.ikTargets[n];
    const expT = [pivot[0] + dsr * (b.t[0] - pivot[0]), pivot[1] + dsr * (b.t[1] - pivot[1]), pivot[2] + dsr * (b.t[2] - pivot[2])];
    const expP = [pivot[0] + dsr * (b.p[0] - pivot[0]), pivot[1] + dsr * (b.p[1] - pivot[1]), pivot[2] + dsr * (b.p[2] - pivot[2])];
    maxErr = Math.max(maxErr,
      Math.hypot(expT[0] - t.target.position.x, expT[1] - t.target.position.y, expT[2] - t.target.position.z),
      Math.hypot(expP[0] - t.pole.position.x, expP[1] - t.pole.position.y, expP[2] - t.pole.position.z));
  }
  // 钳制
  ds.setCharacterScale(99); const hi = ds.getCharacterScale();
  ds.setCharacterScale(0.01); const lo = ds.getCharacterScale();
  ds.setCharacterScale(2.0);
  return { ok, s, maxErr, hi, lo };
});
console.log("缩放数学:", JSON.stringify(r2));

// 播放中缩放漂移
const r3 = await page.evaluate(async () => {
  const ds = window.__ds;
  const e = ds.externalCharacters.getActive();
  const legDrift = () => {
    e.model.updateMatrixWorld(true);
    const BONE = { rightLeg: 10, leftLeg: 13 };
    const out = {};
    for (const [n, i] of Object.entries(BONE)) {
      const t = e.ikTargets[n]; const b = e.jointMap.get(i);
      const v = new b.position.constructor(); b.getWorldPosition(v);
      out[n] = Math.hypot(v.x - t.target.position.x, v.y - t.target.position.y, v.z - t.target.position.z);
    }
    return out;
  };
  const sample = async () => {
    let mx = 0;
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const d = legDrift();
      mx = Math.max(mx, d.rightLeg, d.leftLeg);
    }
    return mx;
  };
  const out = {};
  for (const act of ["idle", "walk"]) {
    ds.stopAllActions();
    ds.setCharacterScale(1);
    ds.playAction(e.id, act);
    await new Promise((r) => setTimeout(r, 400));
    const baseline = await sample();
    ds.setCharacterScale(2.0);
    const scaled = await sample();
    out[act] = { baseline, scaled };
  }
  ds.stopAllActions();
  return out;
});
console.log("播放漂移:", JSON.stringify(r3));

// gizmo 管线：旋转模式 handle → applyHandle → setCharacterRotation
const r4 = await page.evaluate(() => {
  const ds = window.__ds;
  ds.stopAllActions();
  ds.setCharacterScale(1);
  ds.setCharacterRotation({ x: 0, y: 0, z: 0 });
  const cg = ds.charGizmo;
  cg.setMode("rotate");
  cg.update();
  const undoBefore = ds.getUndoDepth();
  // 模拟一次 gizmo 拖拽：beginDrag → handle 转 90° → applyHandle → endDrag
  const e = ds.externalCharacters.getActive();
  cg.handle.position.copy(e.model.position);
  cg.handle.quaternion.copy(e.model.quaternion);
  cg.beginDrag();
  const q = new e.model.quaternion.constructor();
  const axis = new e.model.position.constructor(0, 1, 0);
  q.setFromAxisAngle(axis, Math.PI / 2);
  cg.handle.quaternion.copy(q);
  cg.applyHandle();
  const rot = ds.getCharacterRotation();
  cg.endDrag();
  const undoPushed = ds.getUndoDepth() - undoBefore;
  // undo/redo
  const undoOk = ds.performUndo();
  const rotUndone = ds.getCharacterRotation();
  const redoOk = ds.performRedo();
  const rotRedone = ds.getCharacterRotation();
  return { rot, undoPushed, undoOk, rotUndone, redoOk, rotRedone, attached: cg.attachedId, helperVisible: cg.helperVisible };
});
console.log("gizmo 旋转:", JSON.stringify(r4));

// gizmo 缩放模式
const r5 = await page.evaluate(() => {
  const ds = window.__ds;
  const cg = ds.charGizmo;
  cg.setMode("scale");
  cg.update();
  const e = ds.externalCharacters.getActive();
  ds.setCharacterScale(1);
  cg.handle.scale.set(1, 1, 1);
  const undoBefore = ds.getUndoDepth();
  cg.beginDrag();
  cg.handle.scale.set(1.8, 1.8, 1.8);
  cg.applyHandle();
  const s = ds.getCharacterScale();
  cg.endDrag();
  const undoPushed = ds.getUndoDepth() - undoBefore;
  const undoOk = ds.performUndo();
  const sUndone = ds.getCharacterScale();
  const redoOk = ds.performRedo();
  const sRedone = ds.getCharacterScale();
  // showX/Y/Z 状态
  const tc = cg._tc;
  const flags = { showX: tc.showX, showY: tc.showY, showZ: tc.showZ };
  cg.setMode("translate");
  return { s, undoPushed, undoOk, sUndone, redoOk, sRedone, flags };
});
console.log("gizmo 缩放:", JSON.stringify(r5));

// gizmo 移动模式
const r6 = await page.evaluate(() => {
  const ds = window.__ds;
  const cg = ds.charGizmo;
  cg.setMode("translate");
  const e = ds.externalCharacters.getActive();
  ds.setCharacterScale(1);
  const p0 = e.model.position.toArray();
  cg.update();
  cg.handle.position.set(p0[0], p0[1], p0[2]);
  cg.beginDrag();
  cg.handle.position.set(p0[0] + 0.5, p0[1], p0[2] + 0.3);
  cg.applyHandle();
  cg.endDrag();
  const p1 = e.model.position.toArray();
  return { p0, p1 };
});
console.log("gizmo 移动:", JSON.stringify(r6));

// UI
const r7 = await page.evaluate(() => {
  const ds = window.__ds;
  const btns = ["translate", "rotate", "scale"].map((m) => !!document.getElementById(`char-gizmo-mode-${m}`));
  const slider = document.getElementById("ext-scale");
  const val = document.getElementById("ext-scale-val");
  document.getElementById("char-gizmo-mode-scale").click();
  const modeAfterClick = ds.charGizmo.getMode();
  slider.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  slider.value = "1.5";
  slider.dispatchEvent(new Event("input", { bubbles: true }));
  const s = ds.getCharacterScale();
  const valText = val.textContent;
  document.getElementById("ext-scale-reset").click();
  const sReset = ds.getCharacterScale();
  document.getElementById("char-gizmo-mode-translate").click();
  return { btns, modeAfterClick, s, valText, sReset, panel: !!document.getElementById("ext-gizmo-panel") };
});
console.log("UI:", JSON.stringify(r7));

// 骨骼模式隐藏
const r8 = await page.evaluate(async () => {
  const ds = window.__ds;
  ds.boneEditor.setMode("bone");
  await new Promise((r) => setTimeout(r, 100));
  ds.charGizmo.update();
  const inBone = { attached: ds.charGizmo.attachedId, vis: ds.charGizmo.helperVisible };
  ds.boneEditor.setMode("ik");
  await new Promise((r) => setTimeout(r, 100));
  ds.charGizmo.update();
  const backIk = { attached: ds.charGizmo.attachedId, vis: ds.charGizmo.helperVisible };
  return { inBone, backIk };
});
console.log("骨骼模式共存:", JSON.stringify(r8));

console.log("JS 错误:", errors.length, errors.slice(0, 3));
await browser.close();
server.close();
