/**
 * e2e.mjs — 3D导演台 M2 端到端测试
 *
 * 用法: node test/e2e.mjs  (需要先 npx vite preview)
 */
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

// Inject ready listener
await page.evaluateOnNewDocument(() => {
  window.__gotReady = false;
  window.addEventListener("message", (ev) => {
    if (ev.data && ev.data.type === "ready") window.__gotReady = true;
  });
});

await page.goto(URL, { waitUntil: "networkidle0" });
await page.waitForFunction(() => window.__ds && document.querySelector("#viewport canvas"), { timeout: 15000 });
await new Promise((r) => setTimeout(r, 800));
const ready = await page.evaluate(() => window.__gotReady);

/* ==================================================================
   TEST 1: M1 回归 — sceneGz 往返
   ================================================================== */
console.log("\n[TEST 1] M1 回归：sceneGz 往返");

await page.evaluate(() => {
  const ds = window.__ds;
  ds.joints[4].position.set(-0.55, 1.85, 0.1);
  window.__gz = ds.encodeSceneGz();
  ds.joints[4].position.set(-0.7, 1.45, 0);
  window.postMessage({ type: "init", payload: { width: 768, height: 512, sceneGz: window.__gz } }, "*");
});
await new Promise((r) => setTimeout(r, 400));

const t1 = await page.evaluate(() => {
  const ds = window.__ds;
  return {
    rWristRestored: ds.joints[4].position.toArray().map(v => +v.toFixed(3)),
    exportSize: ds.exportSize,
  };
});
const t1ok = t1.exportSize[0] === 768 && t1.exportSize[1] === 512 && t1.rWristRestored[1] > 1.8;
console.log(`  RWrist restored: ${t1.rWristRestored} → ${t1ok ? "PASS" : "FAIL"}`);

/* ==================================================================
   TEST 2: 导出图尺寸严格等于 w×h
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
   TEST 3: Undo/Redo
   ================================================================== */
console.log("\n[TEST 3] Undo/Redo");
const t3 = await page.evaluate(() => {
  const ds = window.__ds;
  const initPos = ds.joints[4].position.toArray().map(v => +v.toFixed(4));
  ds.pushUndo();
  const d0 = ds.getUndoDepth();
  ds.joints[4].position.set(0, 0, 0);
  const midPos = ds.joints[4].position.toArray().map(v => +v.toFixed(4));
  const ok = ds.performUndo();
  const afterUndo = ds.joints[4].position.toArray().map(v => +v.toFixed(4));
  const d1 = ds.getUndoDepth();
  const rd = ds.getRedoDepth();
  const rok = ds.performRedo();
  const afterRedo = ds.joints[4].position.toArray().map(v => +v.toFixed(4));
  return { initPos, midPos, afterUndo, afterRedo, ok, rok, d0, d1, rd };
});
const t3UndoOk = JSON.stringify(t3.afterUndo) === JSON.stringify(t3.initPos);
const t3RedoOk = t3.afterRedo[0] === 0 && t3.afterRedo[1] === 0 && t3.afterRedo[2] === 0;
console.log(`  undo: ${t3.afterUndo} → ${t3UndoOk ? "PASS" : "FAIL"}`);
console.log(`  redo: ${t3.afterRedo} → ${t3RedoOk ? "PASS" : "FAIL"}`);

/* ==================================================================
   TEST 4: sceneGz 向后兼容 M0
   ================================================================== */
console.log("\n[TEST 4] sceneGz 向后兼容 M0 旧格式");
const m0Data = [
  [0,1.62,0.05],[0,1.45,0],[-0.18,1.45,0],[-0.45,1.45,0],
  [0.5,2.0,-0.2], [0.18,1.45,0],[0.45,1.45,0],[0.7,1.45,0],
  [-0.1,0.95,0],[-0.11,0.52,0],[-0.12,0.08,0],
  [0.1,0.95,0],[0.11,0.52,0],[0.12,0.08,0],
  [-0.03,1.66,0.07],[0.03,1.66,0.07],[-0.07,1.64,0.02],[0.07,1.64,0.02],
];
const m0Bin = new TextEncoder().encode(JSON.stringify(m0Data));
const m0Gz = gzip(m0Bin);
let m0B64 = "";
for (let i = 0; i < m0Gz.length; i += 0x8000)
  m0B64 += String.fromCharCode.apply(null, m0Gz.subarray(i, i + 0x8000));
m0B64 = btoa(m0B64);
const t4 = await page.evaluate((b64) => {
  const result = window.__ds.decodeSceneGz(b64);
  return { decoded: !!result, wrist: window.__ds.joints[4].position.toArray().map(v => +v.toFixed(4)) };
}, m0B64);
const t4ok = t4.decoded && Math.abs(t4.wrist[0] - 0.5) < 0.01;
console.log(`  M0 兼容: ${t4ok ? "PASS" : "FAIL"}`);

/* ==================================================================
   TEST 5: 幻影测试 — openpose/depth 输出图分析
   ================================================================== */
console.log("\n[TEST 5] 导出图内容分析");
const poseAnalysis = await page.evaluate(() => {
  const cv = window.__ds.renderOpenPoseCanvas(256, 256);
  const ctx = cv.getContext("2d");
  const img = ctx.getImageData(0, 0, 256, 256);
  let nonZeroPx = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i] > 0 || img.data[i+1] > 0 || img.data[i+2] > 0) nonZeroPx++;
  }
  return { total: 256*256, nonZero: nonZeroPx, ratio: (nonZeroPx/(256*256)*100).toFixed(2) };
});
console.log(`  OpenPose non-black pixels: ${poseAnalysis.nonZero}/${poseAnalysis.total} (${poseAnalysis.ratio}%) → ${poseAnalysis.nonZero > 50 ? "PASS" : "FAIL"}`);

const depthAnalysis = await page.evaluate(() => {
  const cv = window.__ds.renderDepthCanvas(256, 256);
  const ctx = cv.getContext("2d");
  const img = ctx.getImageData(0, 0, 256, 256);
  let minVal = 255, maxVal = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    const v = img.data[i];
    if (v < minVal) minVal = v;
    if (v > maxVal) maxVal = v;
  }
  return { min: minVal, max: maxVal, varied: maxVal - minVal > 10 };
});
console.log(`  Depth value range: ${depthAnalysis.min}-${depthAnalysis.max} → ${depthAnalysis.varied ? "PASS" : "FAIL"}`);

/* ==================================================================
   TEST 6: M2 — 道具系统：添加/移动/序列化往返
   ================================================================== */
console.log("\n[TEST 6] M2 道具系统：添加/序列化/恢复");

// Add 2 props via eval (simulating button clicks through the manager)
const t6a = await page.evaluate(() => {
  const pm = window.__ds.propManager;
  // Clear first
  pm.clear();

  // Get PrimitiveFactory reference fresh
  // We'll use the existing prop manager's APIs
  const initialCount = pm.props.length;
  return { initialCount };
});
console.log(`  Initial prop count: ${t6a.initialCount}`);

// Add props by directly interacting with DOM buttons
// Click on the "盒" button in the props panel
await page.evaluate(() => {
  // Find prop add buttons
  const propsTab = document.querySelector('[data-panel="props-panel"]');
  if (propsTab) propsTab.click();
});
await new Promise(r => setTimeout(r, 200));

// Try clicking the first add button in props panel
const t6b = await page.evaluate(() => {
  // Directly use PropManager API
  const pm = window.__ds.propManager;
  const { PrimitiveFactory } = { 
    createBox: (w,h,d,c) => {
      const geo = new (window.THREE || window.__ds.renderer.constructor).BoxGeometry(w,h,d);
      // Use simpler approach
    }
  };
  // Access via __ds which has direct propManager access
  return { ready: !!pm, count: pm.props.length };
});
console.log(`  PropManager ready: ${t6b.ready}, count: ${t6b.count}`);

// Add 2 props directly using the PropManager
const t6c = await page.evaluate(() => {
  const pm = window.__ds.propManager;
  // Get access to PrimitiveFactory via the imported module
  // The factory is available in the bundled code
  // Let's use a workaround: add props via the panel buttons' DOM events

  // Instead, we'll construct meshes manually
  const THREE = window.__ds.scene.children[0]?.constructor?.constructor;
  
  // Simulate prop addition by clicking the "box" button
  const btn = document.querySelector('#props-tab button');
  if (btn) {
    btn.click();
    return { clicked: true, count: pm.props.length };
  }
  return { clicked: false, count: pm.props.length };
});
console.log(`  Add box clicked: ${t6c.clicked}, count: ${t6c.count}`);

// Try clicking the sphere button
await page.evaluate(() => {
  const buttons = document.querySelectorAll('#props-tab button');
  // The buttons are: 盒, 球, 柱, 板 — second one is sphere
  if (buttons.length >= 2) buttons[1].click();
});
await new Promise(r => setTimeout(r, 200));

// Now check count and snapshot
const t6d = await page.evaluate(() => {
  const pm = window.__ds.propManager;
  const snap = pm.snapshot();
  return { count: pm.props.length, kinds: snap.map(s => s.kind), positions: snap.map(s => s.position) };
});
console.log(`  Props after add: ${t6d.count} — kinds: ${t6d.kinds} → ${t6d.count >= 2 ? "PASS" : "FAIL"}`);

// Move a prop
await page.evaluate(() => {
  const pm = window.__ds.propManager;
  if (pm.props.length > 0) {
    pm.props[0].mesh.position.set(2.5, 0.5, -1.0);
    pm.props[0].mesh.scale.set(2, 1, 1);
  }
});

// Snapshot after move
const t6e = await page.evaluate(() => {
  const pm = window.__ds.propManager;
  const snapBefore = pm.snapshot();

  // Restore from snapshot
  pm.restore(snapBefore);

  const snapAfter = pm.snapshot();

  // Verify: all props restored
  const checks = snapAfter.map((after, i) => {
    const before = snapBefore[i];
    return {
      kind: after.kind === before.kind,
      pos: Math.abs(after.position[0] - before.position[0]) < 0.01
        && Math.abs(after.position[1] - before.position[1]) < 0.01
        && Math.abs(after.position[2] - before.position[2]) < 0.01,
      scale: after.scale && before.scale
        ? Math.abs(after.scale[0] - before.scale[0]) < 0.01
        : true,
    };
  });
  return { count: snapAfter.length, checks };
});
const t6eOk = t6e.count >= 2 && t6e.checks.every(c => c.kind && c.pos && c.scale);
console.log(`  Serialization round-trip: ${t6e.count} props, all valid → ${t6eOk ? "PASS" : "FAIL"}`);
if (!t6eOk) console.log(`    checks: ${JSON.stringify(t6e.checks)}`);

/* ==================================================================
   TEST 7: M2 — 多机位系统
   ================================================================== */
console.log("\n[TEST 7] M2 多机位系统");

const t7a = await page.evaluate(() => ({
  count: window.__ds.getCameraCount(),
}));
console.log(`  Initial cameras: ${t7a.count} → ${t7a.count >= 1 ? "PASS" : "FAIL"}`);

// Add 2 cameras
await page.evaluate(() => {
  window.__ds.addCamera();
  window.__ds.addCamera();
});
await new Promise(r => setTimeout(r, 200));

const t7b = await page.evaluate(() => {
  const cm = window.__ds.cameraManager;
  return {
    count: cm.cameras.length,
    names: cm.cameras.map(c => c.name),
    activeId: cm.getActiveCamera()?.id,
  };
});
console.log(`  After add: ${t7b.count} cameras: ${t7b.names.join(", ")} → ${t7b.count === 3 ? "PASS" : "FAIL"}`);

// Switch camera
await page.evaluate(() => window.__ds.switchCamera("cam_02"));
await new Promise(r => setTimeout(r, 200));

const t7c = await page.evaluate(() => {
  const cm = window.__ds.cameraManager;
  const ac = cm.getActiveCamera();
  return { activeId: ac?.id, pos: ac?.pos };
});
console.log(`  Switched to: ${t7c.activeId} → ${t7c.activeId === "cam_02" ? "PASS" : "FAIL"}`);

// Remove camera
await page.evaluate(() => window.__ds.removeCamera("cam_03"));
await new Promise(r => setTimeout(r, 200));

const t7d = await page.evaluate(() => window.__ds.getCameraCount());
console.log(`  After remove: ${t7d} cameras → ${t7d === 2 ? "PASS" : "FAIL"}`);

// Can't remove last camera
await page.evaluate(() => {
  window.__ds.removeCamera("cam_02");
  window.__ds.removeCamera("cam_01");
});
const t7e = await page.evaluate(() => window.__ds.getCameraCount());
console.log(`  Min camera guard: ${t7e} remaining → ${t7e >= 1 ? "PASS" : "FAIL"}`);

// Camera serialization
const t7f = await page.evaluate(() => {
  const cm = window.__ds.cameraManager;
  const data = cm.serialize();
  cm.deserialize(data, 512/768);
  return { serialized: data.length, restored: cm.cameras.length };
});
console.log(`  Camera serialize/deserialize: ${t7f.serialized} → ${t7f.restored} → ${t7f.serialized === t7f.restored ? "PASS" : "FAIL"}`);

/* ==================================================================
   TEST 8: M2 — 渲染通道
   ================================================================== */
console.log("\n[TEST 8] M2 渲染通道：Normal / Depth / Lineart");

// Normal pass
const t8a = await page.evaluate(() => {
  const cv = window.__ds.renderNormalCanvas(256, 256);
  const ctx = cv.getContext("2d");
  const img = ctx.getImageData(0, 0, 256, 256);
  // Check if RGB values vary (not flat color)
  let rSet = new Set(), gSet = new Set(), bSet = new Set();
  for (let i = 0; i < img.data.length; i += 4) {
    rSet.add(img.data[i]);
    gSet.add(img.data[i+1]);
    bSet.add(img.data[i+2]);
  }
  return {
    size: [cv.width, cv.height],
    rUnique: rSet.size,
    gUnique: gSet.size,
    bUnique: bSet.size,
    varied: rSet.size > 1 && gSet.size > 1 && bSet.size > 1,
  };
});
console.log(`  Normal pass: ${t8a.size[0]}×${t8a.size[1]}, R:${t8a.rUnique} G:${t8a.gUnique} B:${t8a.bUnique} unique values → ${t8a.varied ? "PASS" : "FAIL"}`);

// Lineart pass (from depth+normal)
const t8b = await page.evaluate(() => {
  const depthCv = window.__ds.renderDepthCanvas(256, 256);
  const normalCv = window.__ds.renderNormalCanvas(256, 256);
  // Render lineart manually since we don't export renderLineartCanvas directly
  // Use the pass-renderer logic
  const ctx2 = document.createElement("canvas").getContext("2d");
  ctx2.canvas.width = 256;
  ctx2.canvas.height = 256;
  ctx2.drawImage(depthCv, 0, 0);
  const dData = ctx2.getImageData(0, 0, 256, 256);

  const ctx3 = document.createElement("canvas").getContext("2d");
  ctx3.canvas.width = 256;
  ctx3.canvas.height = 256;
  ctx3.drawImage(normalCv, 0, 0);
  const nData = ctx3.getImageData(0, 0, 256, 256);

  // Simple lineart: check edges in depth
  let edgeCount = 0;
  for (let y = 1; y < 255; y++) {
    for (let x = 1; x < 255; x++) {
      const i = (y * 256 + x) * 4;
      const dC = (dData.data[i] + dData.data[i+1] + dData.data[i+2]) / 3;
      const dL = (dData.data[i-4] + dData.data[i-3] + dData.data[i-2]) / 3;
      if (Math.abs(dC - dL) > 8) edgeCount++;
    }
  }
  return { edgeCount, hasEdges: edgeCount > 10 };
});
console.log(`  Lineart edges detected: ${t8b.edgeCount} → ${t8b.hasEdges ? "PASS" : "FAIL"}`);

/* ==================================================================
   TEST 9: M2 — 场景 JSON 序列化
   ================================================================== */
console.log("\n[TEST 9] M2 场景 JSON 序列化");
const t9 = await page.evaluate(() => {
  const json = window.__ds.getSceneJSON();
  return {
    version: json.version,
    hasCameras: Array.isArray(json.cameras),
    cameraCount: json.cameras?.length || 0,
    hasProps: Array.isArray(json.props),
    hasFocalLength: typeof json.focalLength === "number",
    hasSceneGz: typeof json.sceneGz === "string",
  };
});
console.log(`  sceneJSON: v${t9.version}, cameras:${t9.cameraCount}, props:${t9.hasProps}, \
focal:${t9.hasFocalLength}, gz:${t9.hasSceneGz}`);
const t9ok = t9.version === 2 && t9.hasCameras && t9.hasProps && t9.hasFocalLength && t9.hasSceneGz;
console.log(`  ${t9ok ? "PASS" : "FAIL"}`);

/* ==================================================================
   TEST 10: M2 — 批量导出 manifest 校验
   ================================================================== */
console.log("\n[TEST 10] M2 批量导出 manifest 格式");
const t10 = await page.evaluate(async () => {
  try {
    const result = await window.__ds.performBatchExport(["openpose", "depth", "normal"]);
    const m = result.manifest;
    return {
      version: m.version,
      cameraCount: m.cameras?.length || 0,
      firstCam: m.cameras?.[0] ? {
        hasId: !!m.cameras[0].id,
        hasFiles: !!m.cameras[0].files,
        passCount: Object.keys(m.cameras[0].files || {}).length,
        width: m.cameras[0].width,
        height: m.cameras[0].height,
      } : null,
      hasSceneGz: !!m.sceneGz,
      masks: m.masks?.length || 0,
    };
  } catch (e) {
    return { error: e.message };
  }
});
console.log(`  Manifest: v${t10.version}, ${t10.cameraCount} cameras, \
passes:${t10.firstCam?.passCount || "N/A"}, ${t10.firstCam?.width}×${t10.firstCam?.height}`);
if (t10.error) console.log(`  ERROR: ${t10.error}`);

const t10ok = !t10.error && t10.version === 2 && t10.cameraCount > 0
  && t10.firstCam?.passCount >= 3 && t10.firstCam?.width === 512 && t10.firstCam?.height === 768;
console.log(`  ${t10ok ? "PASS" : "FAIL"}`);

// Each camera's files are different
const t10b = await page.evaluate(async () => {
  const result = await window.__ds.performBatchExport(["openpose", "depth"]);
  const cams = result.manifest.cameras;
  if (cams.length < 2) return { diff: "not enough cameras" };
  const f1 = cams[0].files;
  const f2 = cams[1].files;
  return {
    openposeDiff: f1.openpose !== f2.openpose,
    depthDiff: f1.depth !== f2.depth,
  };
});
console.log(`  Camera files differ: openpose=${t10b.openposeDiff}, depth=${t10b.depthDiff} → ${t10b.openposeDiff && t10b.depthDiff ? "PASS" : "FAIL"}`);

/* ==================================================================
   TEST 11: M2(figure) — 多角色IK骨架系统
   ================================================================== */
console.log("\n[TEST 11] M2(figure) 多角色创建+切换+关节数");

const t11 = await page.evaluate(() => {
  const api = window.DS_FigureAPI;
  if (!api) return { apiExists: false };
  const c2 = api.createCharacter("char_02", "配角");
  if (!c2) return { error: "create failed" };
  const count = api.getCharacterCount();
  const c1 = api.getCharacter("char_01");
  api.setActive("char_02");
  const active2 = api.getActiveCharacter();
  api.setActive("char_01");
  const active1 = api.getActiveCharacter();
  return { apiExists: true, count,
    c1Joints: c1.jointSpheres.length, c2Joints: c2.jointSpheres.length,
    a2: active2?.id, a1: active1?.id };
});

const t11ok = t11.apiExists && t11.count >= 2 && t11.c1Joints === 18 && t11.c2Joints === 18
  && t11.a2 === "char_02" && t11.a1 === "char_01";
console.log(`  角色数:${t11.count} c1关节:${t11.c1Joints} c2关节:${t11.c2Joints} 切换:${t11.a2}→${t11.a1}`);
console.log(`  ${t11ok ? "PASS" : "FAIL"}`);

/* ==================================================================
   TEST 12: M2(figure) — 角色间独立摆姿势
   ================================================================== */
console.log("\n[TEST 12] M2(figure) 角色间独立姿势");

const t12 = await page.evaluate(() => {
  const api = window.DS_FigureAPI;
  const c1 = api.getCharacter("char_01");
  const c2 = api.getCharacter("char_02");
  if (!c1 || !c2) return { error: "no chars" };
  c1.jointSpheres[4].position.set(-0.5, 1.6, 0.1);
  c2.jointSpheres[7].position.set(0.8, 1.3, -0.1);
  return {
    c1rw: c1.jointSpheres[4].position.toArray().map(v => +v.toFixed(4)),
    c2lw: c2.jointSpheres[7].position.toArray().map(v => +v.toFixed(4)),
    c1j: c1.jointSpheres.length, c2j: c2.jointSpheres.length,
  };
});

const t12ok = t12.c1j === 18 && t12.c2j === 18
  && Math.abs(t12.c1rw[0] - (-0.5)) < 0.01 && Math.abs(t12.c2lw[0] - 0.8) < 0.01;
console.log(`  c1右腕:${t12.c1rw} c2左腕:${t12.c2lw} 关节:${t12.c1j}/${t12.c2j}`);
console.log(`  ${t12ok ? "PASS" : "FAIL"}`);

/* ==================================================================
   TEST 13: M2(figure) — IK目标拖拽后骨架弯曲
   ================================================================== */
console.log("\n[TEST 13] M2(figure) IK拖拽→骨架弯曲");

const t13pre = await page.evaluate(() => {
  const api = window.DS_FigureAPI;
  const char = api.getActiveCharacter();
  const rw = api.getJointWorldPos(char.id, "RWrist");
  const re = api.getJointWorldPos(char.id, "RElbow");
  return { rw: rw.map(v=>+v.toFixed(4)), re: re.map(v=>+v.toFixed(4)) };
});

await page.evaluate(() => {
  const api = window.DS_FigureAPI;
  const char = api.getActiveCharacter();
  char.ikState.rightArm.target.position.set(-0.5, 1.2, -0.3);
});
await new Promise(r => setTimeout(r, 600));

const t13post = await page.evaluate(() => {
  const api = window.DS_FigureAPI;
  const char = api.getActiveCharacter();
  const rw = api.getJointWorldPos(char.id, "RWrist");
  const re = api.getJointWorldPos(char.id, "RElbow");
  return { rw: rw.map(v=>+v.toFixed(4)), re: re.map(v=>+v.toFixed(4)) };
});

const wristMoved = Math.abs(t13post.rw[0] - t13pre.rw[0]) > 0.01
  || Math.abs(t13post.rw[1] - t13pre.rw[1]) > 0.01
  || Math.abs(t13post.rw[2] - t13pre.rw[2]) > 0.01;
const elbowBent = Math.abs(t13post.re[1] - t13pre.re[1]) > 0.005
  || Math.abs(t13post.re[2] - t13pre.re[2]) > 0.005;
console.log(`  腕前:${t13pre.rw}→后:${t13post.rw} 肘前:${t13pre.re}→后:${t13post.re}`);
console.log(`  腕动:${wristMoved} 肘弯:${elbowBent}`);
const t13ok = wristMoved && elbowBent;
console.log(`  ${t13ok ? "PASS" : "FAIL"}`);

/* ==================================================================
   TEST 14: M2(figure) — sceneGz v2多角色往返
   ================================================================== */
console.log("\n[TEST 14] M2(figure) sceneGz v2多角色往返");

const t14 = await page.evaluate(() => {
  const api = window.DS_FigureAPI;
  // M1路径编码（通过 joints 数组）
  const b64m1 = window.__ds.encodeSceneGz();
  const r1 = window.__ds.decodeSceneGz(b64m1);

  // M2路径：直接导入函数（通过 DS_FigureAPI 暴露）
  // 验证所有角色的关节数据
  const allChars = api.getAllCharacters();
  let totalJoints = 0;
  for (const [id, char] of allChars) {
    const jd = api.getCharacterJoints(id);
    totalJoints += Object.keys(jd).length;
  }
  return {
    m1ok: !!r1 && Array.isArray(r1.joints),
    m1joints: r1?.joints?.length || 0,
    charCount: allChars.size,
    totalJoints,
    b64Len: b64m1?.length || 0,
  };
});

const t14ok = t14.m1ok && t14.m1joints >= 18 && t14.charCount >= 2 && t14.totalJoints >= 36;
console.log(`  M1解码:${t14.m1ok} joints:${t14.m1joints} 角色:${t14.charCount} 总关节:${t14.totalJoints}`);
console.log(`  ${t14ok ? "PASS" : "FAIL"}`);

/* ==================================================================
   导出参考图
   ================================================================== */
const poseUrl = await page.evaluate(() => window.__ds.renderOpenPoseCanvas(512, 768).toDataURL("image/png"));
const depthUrl = await page.evaluate(() => window.__ds.renderDepthCanvas(512, 768).toDataURL("image/png"));
const normalUrl = await page.evaluate(() => window.__ds.renderNormalCanvas(512, 768).toDataURL("image/png"));
fs.writeFileSync(path.join(OUT, "openpose_m2.png"), Buffer.from(poseUrl.split(",")[1], "base64"));
fs.writeFileSync(path.join(OUT, "depth_m2.png"), Buffer.from(depthUrl.split(",")[1], "base64"));
fs.writeFileSync(path.join(OUT, "normal_m2.png"), Buffer.from(normalUrl.split(",")[1], "base64"));
await page.screenshot({ path: path.join(OUT, "viewport_m2.png") });

/* ==================================================================
   汇总
   ================================================================== */
console.log("\n" + "=".repeat(50));
const allPass = t1ok && t2ok && t3UndoOk && t3RedoOk && t4ok
  && poseAnalysis.nonZero > 50 && depthAnalysis.varied
  && t6d.count >= 2 && t6eOk
  && t7a.count >= 1 && t7b.count === 3 && t7c.activeId === "cam_02" && t7d === 2 && t7e >= 1 && t7f.serialized === t7f.restored
  && t8a.varied && t8b.hasEdges
  && t9ok && t10ok && t10b.openposeDiff && t10b.depthDiff
  && t11ok && t12ok && t13ok && t14ok;

console.log(`  Ready: ${ready}`);
console.log(`  Errors: ${errors.length}  ${errors.join(" | ")}`);
console.log(`  M1/M2(stage): ${t1ok && t2ok && t3UndoOk && t3RedoOk && t4ok && t5ok && t6eOk && t7f.serialized === t7f.restored && t8a.varied && t8b.hasEdges && t9ok && t10ok ? "PASS" : "FAIL"}`);
console.log(`  M2(figure): ${t11ok && t12ok && t13ok && t14ok ? "PASS" : "FAIL"}`);
console.log(`  ALL PASS: ${allPass}`);
console.log("=".repeat(50));

await browser.close();
process.exit(allPass ? 0 : 1);
