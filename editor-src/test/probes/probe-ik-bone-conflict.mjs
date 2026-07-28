/** probe-ik-bone-conflict.mjs — IK 球 × 骨骼关节点冲突排查探针（只观察，不改源码）
 *
 * 探针清单（对应假设 1-5）：
 *  P0 骨骼模式下 IK 球可见性：ikTargetsGroup.visible / __ds_jointScreen 是否仍含 IK 球
 *  P1 拾取冲突：骨骼模式下点击 rightHand 骨骼标记位置 → 谁被选中（bone vs IK 球）
 *  P2 拖拽冲突：骨骼模式下在 leftHand 标记位置拖拽 → IK 球是否被拖走 / 骨骼是否被 IK 覆写
 *  P3 写入打架：骨骼模式 rotateBone 后等 2s，骨骼欧拉角是否漂移（IK solver 覆写）
 *  P4 模式泄漏：骨骼模式下 IK 球是否仍可点（pointerdown 是否选中 IK 球）
 *
 * 用法: node probe-ik-bone-conflict.mjs
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
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".glb": "model/gltf-binary" };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/upload/image" && req.method === "POST") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ name: "probe.png", subfolder: "director_stage", type: "input" }));
    return;
  }
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

const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch({ channel: "chrome" }));
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept("probe"));

await page.goto(`http://127.0.0.1:${port}/index.html?e2e=1`);
await page.waitForFunction(() => !!window.__ds, null, { timeout: 10000 }).catch(() => {});
await page.waitForFunction(
  () => (window.__ds?.externalCharacters?.getAll?.().length ?? 0) >= 1,
  null, { timeout: 25000 }
).catch(() => {});
await page.waitForTimeout(1500);

const out = {};

// ---------- 工具：canvas 相对坐标 → 页面坐标 ----------
async function toPagePt(node) {
  return page.evaluate((n) => {
    const canvas = [...document.querySelectorAll("#viewport canvas")].pop();
    const r = canvas.getBoundingClientRect();
    return { sx: r.left + n.x, sy: r.top + n.y };
  }, node);
}

// ---------- 确认初始为 IK 模式 ----------
out.boot = await page.evaluate(() => ({
  chars: window.__ds.externalCharacters.getAll().length,
  boneMode: window.__ds?.boneEditor?.getMode?.() ?? null,
  ikScreenBalls: (window.__ds_jointScreen || []).filter((s) => s.obj?.userData?.ikType).length,
}));

// ---------- 进入骨骼模式 ----------
await page.evaluate(() => document.querySelector('[data-edit-mode="bone"]')?.click());
await page.waitForTimeout(800);

// ---------- P0：骨骼模式下 IK 球可见性 ----------
out.P0_visibility = await page.evaluate(() => {
  const entries = window.__ds.externalCharacters.getAll();
  const e = entries[0];
  const ikBalls = (window.__ds_jointScreen || []).filter((s) => s.obj?.userData?.ikType);
  return {
    mode: window.__ds.boneEditor.getMode(),
    ikTargetsGroupVisible: e?.ikTargetsGroup?.visible ?? null,
    ikBallsInPickCache: ikBalls.length,
    ikBallSample: ikBalls.slice(0, 3).map((s) => ({
      chain: s.obj.userData.chainName, kind: s.obj.userData.ikType,
      x: Math.round(s.x), y: Math.round(s.y),
    })),
    boneMarkers: (window.__ds_boneNodeScreen || []).length,
  };
});

// ---------- P1：点击 rightHand 骨骼标记 → 谁被选中 ----------
const p1 = await page.evaluate(() => {
  const bone = (window.__ds_boneNodeScreen || []).find((n) => n.key === "rightHand" && !n.behind);
  const ik = (window.__ds_jointScreen || []).find(
    (s) => s.obj?.userData?.ikType === "target" && s.obj?.userData?.chainName === "rightArm"
  );
  return { bone: bone ? { x: bone.x, y: bone.y } : null, ik: ik ? { x: ik.x, y: ik.y } : null };
});
out.P1_positions = p1 && p1.bone && p1.ik
  ? { ...p1, distPx: Math.round(Math.hypot(p1.bone.x - p1.ik.x, p1.bone.y - p1.ik.y) * 10) / 10 }
  : p1;

if (p1?.bone) {
  const pt = await toPagePt(p1.bone);
  await page.mouse.click(pt.sx, pt.sy);
  await page.waitForTimeout(400);
  out.P1_clickResult = await page.evaluate(() => ({
    selectedBone: window.__ds.boneEditor.getSelectedBone(),
    selectedJointIsIK: window.__ds_selectedJoint?.userData?.ikType ?? null,
    selectedJointChain: window.__ds_selectedJoint?.userData?.chainName ?? null,
  }));
}

// 清理选择状态，避免 gizmo 影响下一步拖拽探针
await page.evaluate(() => window.__ds.boneEditor.selectBone(null));
await page.waitForTimeout(200);

// ---------- P2：骨骼模式下拖 leftHand 标记位置 → IK 球被拖走？ ----------
const p2before = await page.evaluate(() => {
  const bone = (window.__ds_boneNodeScreen || []).find((n) => n.key === "leftHand" && !n.behind);
  const e = window.__ds.externalCharacters.getAll()[0];
  const handBone = e.jointMap.get(7); // COCO-18 left wrist
  const v = new (handBone.getWorldPosition(new (handBone.position.constructor)()).constructor)();
  const wp = handBone.getWorldPosition(new handBone.position.constructor());
  const t = e.ikTargets?.leftArm?.target;
  return {
    bone: bone ? { x: bone.x, y: bone.y } : null,
    handWorld: wp ? [wp.x, wp.y, wp.z] : null,
    ikTargetPos: t ? [t.position.x, t.position.y, t.position.z] : null,
  };
});
if (p2before?.bone) {
  const pt = await toPagePt(p2before.bone);
  await page.mouse.move(pt.sx, pt.sy);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(pt.sx + i * 10, pt.sy - i * 3);
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
  await page.waitForTimeout(600);
  out.P2_dragResult = await page.evaluate((before) => {
    const e = window.__ds.externalCharacters.getAll()[0];
    const handBone = e.jointMap.get(7);
    const wp = handBone.getWorldPosition(new handBone.position.constructor());
    const t = e.ikTargets?.leftArm?.target;
    const movedHand = before.handWorld
      ? Math.hypot(wp.x - before.handWorld[0], wp.y - before.handWorld[1], wp.z - before.handWorld[2])
      : null;
    const movedIK = before.ikTargetPos && t
      ? Math.hypot(t.position.x - before.ikTargetPos[0], t.position.y - before.ikTargetPos[1], t.position.z - before.ikTargetPos[2])
      : null;
    return {
      handBoneMoved: movedHand, ikTargetMoved: movedIK,
      selectedBone: window.__ds.boneEditor.getSelectedBone(),
      dragHijackedByIK: movedIK !== null && movedIK > 0.02,
    };
  }, p2before);
} else {
  out.P2_dragResult = { skipped: "leftHand bone marker not found" };
}

// ---------- P3：写入打架——rotateBone 后等 2s 看漂移 ----------
out.P3_writeFight = await page.evaluate(async () => {
  const be = window.__ds.boneEditor;
  const read = () => {
    const s = be.getState();
    const b = s.bones?.rightUpperArm;
    return b ? b.rotation : null;
  };
  const r0 = read();
  be.rotateBone("rightUpperArm", [0.5, 0, 0.3]);
  const r1 = read();
  await new Promise((r) => setTimeout(r, 2000));
  const r2 = read();
  const drift = r1 && r2
    ? Math.hypot(r2[0] - r1[0], r2[1] - r1[1], r2[2] - r1[2])
    : null;
  return { before: r0, afterRotate: r1, after2s: r2, driftRad: drift, ikOverwrote: drift !== null && drift > 0.01 };
});

// ---------- P4：模式泄漏——骨骼模式下直接点 IK 球投影位置 ----------
out.P4_modeLeak = await page.evaluate(() => {
  const ik = (window.__ds_jointScreen || []).find(
    (s) => s.obj?.userData?.ikType === "target" && s.obj?.userData?.chainName === "rightArm" && !s.behind
  );
  return ik ? { x: ik.x, y: ik.y } : null;
});
if (out.P4_modeLeak) {
  const pt = await toPagePt(out.P4_modeLeak);
  await page.evaluate(() => window.__ds.boneEditor.selectBone(null));
  await page.mouse.move(pt.sx, pt.sy);
  await page.mouse.down();
  await page.waitForTimeout(120);
  const duringDown = await page.evaluate(() => ({
    selectedJointIsIK: window.__ds_selectedJoint?.userData?.ikType ?? null,
    chain: window.__ds_selectedJoint?.userData?.chainName ?? null,
    cursor: [...document.querySelectorAll("#viewport canvas")].pop()?.style?.cursor ?? null,
  }));
  await page.mouse.up();
  out.P4_result = duringDown;
} else {
  out.P4_result = { note: "no IK ball in pick cache (bone mode)" };
}

out.errors = errors;
console.log(JSON.stringify(out, null, 2));

await browser.close();
server.close();
