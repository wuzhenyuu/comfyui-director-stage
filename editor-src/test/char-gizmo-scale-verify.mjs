/** char-gizmo-scale-verify.mjs — P3-5 角色视口 gizmo（移动/旋转/缩放）+ 人物缩放 验收探针
 *
 * 验收契约：
 *  0) 探针自检（near/dist 辅助函数可用 + 防恒绿反向断言可用）
 *  1) API 契约：__ds.setCharacterScale / getCharacterScale / manager.setCharacterScale /
 *     getCharacterScale / charGizmo 存在
 *  2) 缩放生效：setCharacterScale(2.0) → getCharacterScale≈2.0；幂等；钳制 0.2/3.0；省略 id 简写
 *  3) IK 随动（非播放）：全部 IK target/pole 世界坐标 = 缩放前位置绕 model.position 按实际 ds
 *     映射（<1e-4）；反向验证：用错误 ds 计算期望则误差显著（>0.05，防恒绿）
 *  4) 脚钉地贴地：缩放后稳定 400ms，腿 IK target 保持缩放后期望值（<0.01）、骨端↔target 漂移
 *     <0.01、脚踝骨端世界 y = pivot.y + ds·(y0−pivot.y)（<0.01，脚不浮不沉）
 *  5) 播放中缩放（idle & walk）：缩放 2.0 后续播 600ms 采样，漂移 ≤ 基线×ds×1.25
 *     （CCD 求解残差与角色尺寸成正比——walk 基线本身 ~0.021 > 0.01，绝对 0.01 物理不可达，
 *       故采用与 F0 旋转同级的基线相对断言）；缩放值不被动作回写
 *  6) undo/redo：pushUndo→缩放 2.0→undo 回原缩放（IK target 同步恢复，判别式：近原/远缩放后）
 *     →redo 回 2.0；redo 后骨端↔target 一致（<0.01）
 *  7) 持久化：缩放 1.5 + 旋转 35°→getSceneJSON transform.scale/quaternion 与模型一致→restore
 *     往返后保留；旧工程缺省 scale 字段 → 保持模型加载自然缩放（与旧版恢复行为逐像素一致）
 *  8) gizmo 挂载：charGizmo.attachedId=活动角色、helperVisible=true（webgl 模式）、
 *     TransformControls 实例就绪
 *  9) gizmo 模式切换：按钮 × 3 + setMode；scale 模式 showX/Y/Z 全 false（仅等比中心柄）；
 *     rotate 模式仅 Y 环；W/E/R 快捷键切换
 * 10) gizmo 拖拽管线（beginDrag/applyHandle/endDrag 测试钩子 = 真实 dragging-changed/
 *     objectChange 同一代码路径）：
 *     a) 旋转：handle 转 90° → y≈90°（反向：非 0°，防恒绿）；一次手势压一次 undo；undo/redo 恢复；
 *        与旋转滑条读数一致（轮询同步后 #ext-rot-y-val = 90°）
 *     b) 缩放：handle.scale=1.8 → getCharacterScale≈1.8；拖拽结束 #ext-scale-val=180%；undo/redo
 *     c) 移动：handle 平移 → 模型 + IK target 同步平移（<1e-6）
 * 11) 骨骼模式共存：bone 模式 gizmo detach + helper 隐藏；回 IK 模式恢复 attach
 * 12) 缩放滑条 UI：手势（pointerdown+input）实时缩放、百分比显示、一次手势压一次 undo；
 *     归零按钮回 100% 且压一次 undo；API 缩放后滑条轮询同步（双向）
 * 13) 截图 test/out/char-gizmo-scale.png；页面无 JS 错误
 *
 * 用法: node char-gizmo-scale-verify.mjs
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
    dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
    near: (a, b, eps) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= eps,
    // 绕 pivot 等比缩放映射：v' = pivot + ds·(v − pivot)
    sp: (p, pivot, ds) => [
      pivot[0] + ds * (p[0] - pivot[0]),
      pivot[1] + ds * (p[1] - pivot[1]),
      pivot[2] + ds * (p[2] - pivot[2]),
    ],
    boneWorld: (bone) => {
      const v = new bone.position.constructor();
      bone.getWorldPosition(v);
      return [v.x, v.y, v.z];
    },
    entry: () => window.__ds.externalCharacters.getActive(),
    scale: () => window.__ds.getCharacterScale(),
    rot: () => window.__ds.getCharacterRotation(),
    ikSnapshot: () => {
      const e = window.__t.entry();
      const out = {};
      for (const [name, t] of Object.entries(e.ikTargets || {})) {
        out[name] = { target: t.target.position.toArray(), pole: t.pole.position.toArray() };
      }
      return out;
    },
    legDrift: () => {
      const e = window.__t.entry();
      e.model.updateMatrixWorld(true);
      const BONE = { rightLeg: 10, leftLeg: 13 };
      const out = {};
      for (const [name, idx] of Object.entries(BONE)) {
        const t = e.ikTargets?.[name];
        const bone = e.jointMap.get(idx);
        if (!t || !bone) { out[name] = null; continue; }
        out[name] = window.__t.dist(window.__t.boneWorld(bone), t.target.position.toArray());
      }
      return out;
    },
  };
});

await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => !!window.__ds, null, { timeout: 15000 });
await page.waitForFunction(
  () => (window.__ds?.externalCharacters?.getAll?.().length ?? 0) >= 1,
  null, { timeout: 25000 }
);
await page.waitForTimeout(500);

// ================= 契约 0：探针自检 =================
const selfTest = await page.evaluate(() => {
  const t = window.__t;
  const mapped = t.sp([1, 0.5, 0], [0, 0.5, 0], 2); // (1,0.5,0) 绕 (0,0.5,0) 放大2倍 → (2,0.5,0)
  return {
    nearOk: t.near([1, 2, 3], [1, 2, 3], 0.001) && !t.near([1, 2, 3], [1.5, 2, 3], 0.001),
    spOk: t.near(mapped, [2, 0.5, 0], 1e-9),
  };
});
check("契约0 探针自检（near/sp 映射）", selfTest.nearOk && selfTest.spOk, JSON.stringify(selfTest));

// ================= 契约 1：API 存在 =================
const api = await page.evaluate(() => ({
  dsSet: typeof window.__ds.setCharacterScale === "function",
  dsGet: typeof window.__ds.getCharacterScale === "function",
  mgrSet: typeof window.__ds.externalCharacters.setCharacterScale === "function",
  mgrGet: typeof window.__ds.externalCharacters.getCharacterScale === "function",
  gizmo: !!window.__ds.charGizmo,
  gizmoSetMode: typeof window.__ds.charGizmo?.setMode === "function",
}));
check("契约1 setCharacterScale/getCharacterScale/charGizmo API 存在",
  api.dsSet && api.dsGet && api.mgrSet && api.mgrGet && api.gizmo && api.gizmoSetMode, JSON.stringify(api));

// ================= 契约 2：缩放生效 + 幂等 + 钳制 + 简写 =================
const sc2 = await page.evaluate(() => {
  const ds = window.__ds;
  ds.stopAllActions();
  const e = window.__t.entry();
  const id = e.id;
  ds.setCharacterScale(id, 1);
  const okRet = ds.setCharacterScale(id, 2.0);
  const s1 = ds.getCharacterScale(id);
  const arr1 = e.model.scale.toArray();
  ds.setCharacterScale(id, 2.0); // 同值重设：幂等
  const arr2 = e.model.scale.toArray();
  const okShort = ds.setCharacterScale(2.0); // 省略 id（活动角色）
  ds.setCharacterScale(99); const hi = ds.getCharacterScale();
  ds.setCharacterScale(0.01); const lo = ds.getCharacterScale();
  ds.setCharacterScale(2.0);
  return { okRet, s1, qSame: window.__t.near(arr1, arr2, 1e-9), okShort, hi, lo };
});
check("契约2 缩放 2.0 生效（s≈2.0）", sc2.okRet === true && Math.abs(sc2.s1 - 2.0) < 1e-3, `s=${sc2.s1}`);
check("契约2b 幂等 + 省略 id 简写 + 钳制 [0.2, 3.0]",
  sc2.qSame && sc2.okShort === true && Math.abs(sc2.hi - 3.0) < 1e-6 && Math.abs(sc2.lo - 0.2) < 1e-6,
  JSON.stringify({ qSame: sc2.qSame, hi: sc2.hi, lo: sc2.lo }));

// ================= 契约 3：IK 随动精确映射（含防恒绿反向验证） =================
const ik3 = await page.evaluate(() => {
  const ds = window.__ds;
  const t = window.__t;
  ds.stopAllActions();
  ds.setCharacterScale(1);
  const e = t.entry();
  const pivot = e.model.position.toArray();
  const s0 = e.model.scale.x;
  const before = t.ikSnapshot();
  ds.setCharacterScale(2.0);
  const dsr = e.model.scale.x / s0; // 实际 delta（含加载自然缩放）
  const after = t.ikSnapshot();
  let maxErr = 0, maxErrWrong = 0;
  for (const [name, b] of Object.entries(before)) {
    const expT = t.sp(b.target, pivot, dsr);
    const expP = t.sp(b.pole, pivot, dsr);
    maxErr = Math.max(maxErr, t.dist(expT, after[name].target), t.dist(expP, after[name].pole));
    // 反向：用错误 ds（一半）计算期望 → 误差必须显著（证明正向断言非恒绿）
    const badT = t.sp(b.target, pivot, dsr * 0.5);
    const badP = t.sp(b.pole, pivot, dsr * 0.5);
    maxErrWrong = Math.max(maxErrWrong, t.dist(badT, after[name].target), t.dist(badP, after[name].pole));
  }
  return { maxErr, maxErrWrong, dsr, before, after };
});
check("契约3a IK target/pole 绕 pivot 按 ds 精确随动（<1e-4）", ik3.maxErr < 1e-4,
  `maxErr=${ik3.maxErr.toExponential(2)} ds=${ik3.dsr.toFixed(4)}`);
check("契约3b 反向验证：错误 ds 期望误差显著（>0.05，防恒绿）", ik3.maxErrWrong > 0.05,
  `maxErrWrong=${ik3.maxErrWrong.toFixed(4)}`);

// ================= 契约 4：脚钉地贴地（非播放稳态） =================
await page.waitForTimeout(400); // 多帧脚钉地窗口
const ik4 = await page.evaluate((prev) => {
  const t = window.__t;
  const e = t.entry();
  e.model.updateMatrixWorld(true);
  // 腿 target 保持缩放后位置
  const now = t.ikSnapshot();
  let maxHold = 0;
  for (const [name, a] of Object.entries(now)) {
    maxHold = Math.max(maxHold,
      t.dist(a.target, prev.after[name].target),
      t.dist(a.pole, prev.after[name].pole));
  }
  const drift = t.legDrift();
  // 脚踝骨端 y 贴地：= pivot.y + ds·(y0 − pivot.y)（缩放前踝骨端 y 经同一映射）
  const pivotY = e.model.position.y;
  const ankles = {};
  for (const [name, idx] of Object.entries({ rightLeg: 10, leftLeg: 13 })) {
    const bone = e.jointMap.get(idx);
    if (!bone) { ankles[name] = null; continue; }
    const yNow = t.boneWorld(bone)[1];
    const y0 = prev.before[name].target[1]; // 缩放前踝 target y（骨端↔target 已一致）
    const yExp = pivotY + prev.dsr * (y0 - pivotY);
    ankles[name] = Math.abs(yNow - yExp);
  }
  return { maxHold, drift, ankles };
}, ik3);
check("契约4a 脚钉地不回拉（腿 target 保持缩放后位置 <0.01）", ik4.maxHold < 0.01, `hold=${ik4.maxHold.toFixed(5)}`);
check("契约4b 骨端↔IK target 漂移 <0.01（缩放后稳态）",
  (ik4.drift.rightLeg ?? 1) < 0.01 && (ik4.drift.leftLeg ?? 1) < 0.01, JSON.stringify(ik4.drift));
check("契约4c 脚底贴地（踝骨端 y = 映射期望值 <0.01，不浮不沉）",
  (ik4.ankles.rightLeg ?? 1) < 0.01 && (ik4.ankles.leftLeg ?? 1) < 0.01, JSON.stringify(ik4.ankles));

// ================= 契约 5：播放中缩放（idle & walk） =================
async function playingScaleCase(actionId) {
  // CCD 求解残差与角色尺寸成正比（walk 基线本身 ~0.021 > 0.01，绝对 0.01 物理不可达），
  // 断言：缩放后漂移 ≤ 基线 × ds × 1.25（缩放不引入超越比例的额外漂移）。
  return page.evaluate(async (act) => {
    const ds = window.__ds;
    const t = window.__t;
    ds.stopAllActions();
    ds.setCharacterScale(1);
    const e = t.entry();
    const sampleDrift = async () => {
      let mx = 0;
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const d = t.legDrift();
        mx = Math.max(mx, d.rightLeg ?? 1, d.leftLeg ?? 1);
      }
      return mx;
    };
    ds.playAction(e.id, act);
    await new Promise((r) => setTimeout(r, 400));
    const baseline = await sampleDrift();
    const s0 = e.model.scale.x;
    ds.setCharacterScale(2.0);
    const dsr = e.model.scale.x / s0;
    const scaled = await sampleDrift();
    const scaleHeld = t.scale();
    ds.stopAllActions();
    return { baseline, scaled, dsr, scaleHeld };
  }, actionId);
}
const idleCase = await playingScaleCase("idle");
check("契约5a idle 播放中缩放 2.0：漂移 ≤ 基线×ds×1.25",
  idleCase.scaled <= idleCase.baseline * idleCase.dsr * 1.25 + 1e-4,
  `baseline=${idleCase.baseline.toFixed(5)} scaled=${idleCase.scaled.toFixed(5)} ds=${idleCase.dsr.toFixed(3)}`);
check("契约5b idle 缩放后缩放值不被动作回写（s≈2.0）",
  Math.abs(idleCase.scaleHeld - 2.0) < 1e-3, `s=${idleCase.scaleHeld}`);
const walkCase = await playingScaleCase("walk");
check("契约5c walk 播放中缩放 2.0：漂移 ≤ 基线×ds×1.25",
  walkCase.scaled <= walkCase.baseline * walkCase.dsr * 1.25 + 1e-4,
  `baseline=${walkCase.baseline.toFixed(5)} scaled=${walkCase.scaled.toFixed(5)} ds=${walkCase.dsr.toFixed(3)}`);
check("契约5d walk 缩放后缩放值不被动作回写（s≈2.0）",
  Math.abs(walkCase.scaleHeld - 2.0) < 1e-3, `s=${walkCase.scaleHeld}`);

// ================= 契约 6：undo/redo 缩放 =================
const undo6 = await page.evaluate(async () => {
  const ds = window.__ds;
  const t = window.__t;
  ds.stopAllActions();
  await new Promise((r) => setTimeout(r, 700)); // 等 stand 混合完全稳定
  ds.setCharacterScale(1);
  const sPre = t.scale();
  const ikPre = t.ikSnapshot();
  ds.pushUndo();
  ds.setCharacterScale(2.0);
  const sMid = t.scale();
  const ikScaled = t.ikSnapshot();
  const undoOk = ds.performUndo();
  const sUndone = t.scale();
  const ikUndone = t.ikSnapshot();
  // 判别式：undo 后必须离【缩放前】近、离【缩放 2.0】远（防恒绿断言）
  let targetErr = 0, discriminantOk = true;
  for (const [name, u] of Object.entries(ikUndone)) {
    targetErr = Math.max(targetErr, t.dist(u.target, ikPre[name].target));
    if (t.dist(u.target, ikPre[name].target) >= t.dist(u.target, ikScaled[name].target)) discriminantOk = false;
    if (t.dist(u.pole, ikPre[name].pole) >= t.dist(u.pole, ikScaled[name].pole)) discriminantOk = false;
  }
  const redoOk = ds.performRedo();
  const sRedone = t.scale();
  await new Promise((r) => setTimeout(r, 250));
  const drift = t.legDrift();
  return { sPre, sMid, undoOk, sUndone, targetErr, discriminantOk, redoOk, sRedone, drift };
});
check("契约6a 缩放进 undo 通道：undo 回原缩放 / redo 回 2.0",
  undo6.undoOk === true && undo6.redoOk === true &&
  Math.abs(undo6.sMid - 2.0) < 1e-3 && Math.abs(undo6.sUndone - undo6.sPre) < 1e-3 && Math.abs(undo6.sRedone - 2.0) < 1e-3,
  JSON.stringify({ pre: undo6.sPre, mid: undo6.sMid, undone: undo6.sUndone, redone: undo6.sRedone }));
check("契约6b undo 后 IK target 恢复（<0.01 且判别式成立：近缩放前/远缩放后）",
  undo6.targetErr < 0.01 && undo6.discriminantOk, `targetErr=${undo6.targetErr.toFixed(5)} discriminant=${undo6.discriminantOk}`);
check("契约6c redo 后骨端↔target 一致（<0.01）",
  (undo6.drift.rightLeg ?? 1) < 0.01 && (undo6.drift.leftLeg ?? 1) < 0.01, JSON.stringify(undo6.drift));

// ================= 契约 7：持久化 sceneJSON 往返（scale + rotation） =================
const persist = await page.evaluate(async () => {
  const ds = window.__ds;
  const t = window.__t;
  ds.stopAllActions();
  ds.setCharacterRotation({ x: 0, y: 35, z: 0 });
  ds.setCharacterScale(1.5);
  const e = t.entry();
  const modelS = e.model.scale.x;
  const modelQ = e.model.quaternion.toArray();
  const sceneJSON = ds.getSceneJSON();
  const saved = sceneJSON.externalCharacters?.[0];
  const sMatch = saved?.transform?.scale && Math.abs(saved.transform.scale[0] - modelS) < 1e-4;
  const qMatch = saved?.transform?.quaternion && t.near(modelQ, saved.transform.quaternion, 2e-5);
  // 往返：restore 走真实恢复路径（内部先 clear 再异步重载模型）
  const ok = await ds.externalCharacters.restore({
    characters: sceneJSON.externalCharacters,
    activeCharacterId: sceneJSON.activeExternalCharacterId,
  });
  const sAfter = ds.getCharacterScale(sceneJSON.activeExternalCharacterId);
  const rotAfter = ds.getCharacterRotation(sceneJSON.activeExternalCharacterId);
  // 旧工程兼容：scale 缺省 → 保持模型加载自然缩放（与旧版恢复行为一致，不强行覆写）
  const legacy = JSON.parse(JSON.stringify(sceneJSON.externalCharacters));
  delete legacy[0].transform.scale;
  const e2pre = t.entry(); // 当前活动（往返后）自然加载缩放基准在 restore 内重载
  await ds.externalCharacters.restore({ characters: legacy, activeCharacterId: legacy[0].id });
  const sLegacy = ds.getCharacterScale(legacy[0].id);
  const rotLegacy = ds.getCharacterRotation(legacy[0].id); // rotation 字段仍在
  // 恢复常态
  ds.setCharacterScale(1);
  ds.setCharacterRotation({ x: 0, y: 0, z: 0 });
  return { sMatch, qMatch, ok, sAfter, rotAfter, sLegacy, rotLegacy };
});
check("契约7a sceneJSON.transform.scale/quaternion 与模型一致",
  persist.sMatch === true && persist.qMatch === true);
check("契约7b 保存→重载往返后缩放/旋转保留（s≈1.5, y≈35°）",
  persist.ok === true && Math.abs(persist.sAfter - 1.5) < 1e-3 && Math.abs(persist.rotAfter.y - 35) < 1,
  JSON.stringify({ s: persist.sAfter, rot: persist.rotAfter }));
check("契约7c 旧工程缺省 scale → 加载自然缩放兼容（>0.5 且有限；rotation 字段不受影响）",
  Number.isFinite(persist.sLegacy) && persist.sLegacy > 0.5 && Math.abs(persist.rotLegacy.y - 35) < 1,
  JSON.stringify({ s: persist.sLegacy, rot: persist.rotLegacy }));

// ================= 契约 8：gizmo 挂载 =================
const gz8 = await page.evaluate(() => {
  const ds = window.__ds;
  const cg = ds.charGizmo;
  cg.update();
  const e = window.__t.entry();
  return {
    attachedId: cg.attachedId,
    activeId: e.id,
    helperVisible: cg.helperVisible,
    renderMode: ds.renderMode,
    tcOk: !!cg._tc && typeof cg._tc.attach === "function" && typeof cg._tc.setMode === "function",
    mode: cg.getMode(),
  };
});
check("契约8 gizmo 挂载到活动角色（attachedId=active，helper 可见，TC 就绪）",
  gz8.attachedId === gz8.activeId && gz8.helperVisible === true && gz8.tcOk,
  JSON.stringify(gz8));

// ================= 契约 9：模式切换（按钮 + setMode + 轴柄可见性 + W/E/R） =================
const gz9 = await page.evaluate(() => {
  const ds = window.__ds;
  const cg = ds.charGizmo;
  const tc = cg._tc;
  const btns = ["translate", "rotate", "scale"].map((m) => !!document.getElementById(`char-gizmo-mode-${m}`));
  // setMode 轴柄可见性
  cg.setMode("rotate");
  const rotFlags = { x: tc.showX, y: tc.showY, z: tc.showZ, mode: cg.getMode() };
  cg.setMode("scale");
  const scaleFlags = { x: tc.showX, y: tc.showY, z: tc.showZ, mode: cg.getMode() };
  cg.setMode("translate");
  const traFlags = { x: tc.showX, y: tc.showY, z: tc.showZ, mode: cg.getMode() };
  // 按钮点击
  document.getElementById("char-gizmo-mode-scale").click();
  const clickMode = cg.getMode();
  // W/E/R 快捷键（合成 keydown 事件，target=body）
  const press = (code) => window.dispatchEvent(new KeyboardEvent("keydown", { code, bubbles: true }));
  press("KeyW"); const kw = cg.getMode();
  press("KeyE"); const ke = cg.getMode();
  press("KeyR"); const kr = cg.getMode();
  cg.setMode("translate");
  return { btns, rotFlags, scaleFlags, traFlags, clickMode, kw, ke, kr };
});
check("契约9a 模式按钮 × 3 存在且点击切换", gz9.btns.every(Boolean) && gz9.clickMode === "scale",
  JSON.stringify({ btns: gz9.btns, click: gz9.clickMode }));
check("契约9b rotate 仅 Y 环 / scale 仅等比柄 / translate 三轴全开",
  gz9.rotFlags.mode === "rotate" && !gz9.rotFlags.x && gz9.rotFlags.y && !gz9.rotFlags.z &&
  gz9.scaleFlags.mode === "scale" && !gz9.scaleFlags.x && !gz9.scaleFlags.y && !gz9.scaleFlags.z &&
  gz9.traFlags.mode === "translate" && gz9.traFlags.x && gz9.traFlags.y && gz9.traFlags.z,
  JSON.stringify({ rot: gz9.rotFlags, scale: gz9.scaleFlags, tra: gz9.traFlags }));
check("契约9c W/E/R 快捷键切换模式（W=移动 E=旋转 R=缩放）",
  gz9.kw === "translate" && gz9.ke === "rotate" && gz9.kr === "scale",
  JSON.stringify({ kw: gz9.kw, ke: gz9.ke, kr: gz9.kr }));

// ================= 契约 10a：gizmo 旋转拖拽管线 =================
const gz10a = await page.evaluate(() => {
  const ds = window.__ds;
  const t = window.__t;
  ds.stopAllActions();
  ds.setCharacterScale(1);
  ds.setCharacterRotation({ x: 0, y: 0, z: 0 });
  const cg = ds.charGizmo;
  cg.setMode("rotate");
  cg.update();
  const e = t.entry();
  cg.handle.position.copy(e.model.position);
  cg.handle.quaternion.copy(e.model.quaternion);
  cg.handle.scale.set(1, 1, 1);
  const undoBefore = ds.getUndoDepth();
  cg.beginDrag(); // = dragging-changed(true) 同路径
  const q = new e.model.quaternion.constructor();
  const axis = new e.model.position.constructor(0, 1, 0);
  q.setFromAxisAngle(axis, Math.PI / 2);
  cg.handle.quaternion.copy(q);
  cg.applyHandle(); // = objectChange 同路径
  const rot = t.rot();
  cg.endDrag();   // = dragging-changed(false) 同路径
  const undoPushed = ds.getUndoDepth() - undoBefore;
  const undoOk = ds.performUndo();
  const rotUndone = t.rot();
  const redoOk = ds.performRedo();
  const rotRedone = t.rot();
  return { rot, undoPushed, undoOk, rotUndone, redoOk, rotRedone };
});
check("契约10a1 gizmo 旋转拖拽 → y≈90°（反向：非 0°，防恒绿）",
  Math.abs(gz10a.rot.y - 90) < 1 && Math.abs(gz10a.rot.y) > 1 && Math.abs(gz10a.rot.x) < 1,
  JSON.stringify(gz10a.rot));
check("契约10a2 一次拖拽手势只压一次 undo；undo 回 0° / redo 回 90°",
  gz10a.undoPushed === 1 && gz10a.undoOk === true && gz10a.redoOk === true &&
  Math.abs(gz10a.rotUndone.y) < 1 && Math.abs(gz10a.rotRedone.y - 90) < 1,
  JSON.stringify({ pushed: gz10a.undoPushed, undone: gz10a.rotUndone, redone: gz10a.rotRedone }));
// 与旋转滑条读数一致（300ms 轮询同步）
await page.waitForTimeout(450);
const gz10aSync = await page.evaluate(() => ({
  slider: document.getElementById("ext-rot-y")?.value,
  val: document.getElementById("ext-rot-y-val")?.textContent,
}));
check("契约10a3 gizmo 旋转与滑条读数双向同步（90°）",
  gz10aSync.val === "90°" && Math.abs(parseFloat(gz10aSync.slider) - 90) < 1.5,
  JSON.stringify(gz10aSync));

// ================= 契约 10b：gizmo 缩放拖拽管线 =================
const gz10b = await page.evaluate(() => {
  const ds = window.__ds;
  const t = window.__t;
  ds.setCharacterRotation({ x: 0, y: 0, z: 0 });
  ds.setCharacterScale(1);
  const cg = ds.charGizmo;
  cg.setMode("scale");
  cg.update();
  const e = t.entry();
  cg.handle.position.copy(e.model.position);
  cg.handle.scale.set(1, 1, 1);
  const undoBefore = ds.getUndoDepth();
  cg.beginDrag();
  cg.handle.scale.set(1.8, 1.8, 1.8);
  cg.applyHandle();
  const s = t.scale();
  cg.endDrag(); // 触发 ds-char-gizmo-dragend → 面板即时同步
  const undoPushed = ds.getUndoDepth() - undoBefore;
  const valText = document.getElementById("ext-scale-val")?.textContent;
  const undoOk = ds.performUndo();
  const sUndone = t.scale();
  const redoOk = ds.performRedo();
  const sRedone = t.scale();
  return { s, undoPushed, valText, undoOk, sUndone, redoOk, sRedone };
});
check("契约10b1 gizmo 缩放拖拽 → s≈1.8（反向：非 1.0，防恒绿）",
  Math.abs(gz10b.s - 1.8) < 1e-3 && Math.abs(gz10b.s - 1.0) > 0.1, `s=${gz10b.s}`);
check("契约10b2 拖拽结束面板即时同步（#ext-scale-val=180%）", gz10b.valText === "180%", gz10b.valText);
check("契约10b3 一次手势压一次 undo；undo 回 1.0 / redo 回 1.8",
  gz10b.undoPushed === 1 && gz10b.undoOk === true && gz10b.redoOk === true &&
  Math.abs(gz10b.sUndone - 1.0) < 1e-3 && Math.abs(gz10b.sRedone - 1.8) < 1e-3,
  JSON.stringify({ pushed: gz10b.undoPushed, undone: gz10b.sUndone, redone: gz10b.sRedone }));

// ================= 契约 10c：gizmo 移动拖拽管线 =================
const gz10c = await page.evaluate(() => {
  const ds = window.__ds;
  const t = window.__t;
  ds.setCharacterScale(1);
  const cg = ds.charGizmo;
  cg.setMode("translate");
  cg.update();
  const e = t.entry();
  const p0 = e.model.position.toArray();
  const ik0 = t.ikSnapshot();
  cg.handle.position.set(p0[0], p0[1], p0[2]);
  cg.beginDrag();
  cg.handle.position.set(p0[0] + 0.5, p0[1], p0[2] + 0.3);
  cg.applyHandle();
  cg.endDrag();
  const p1 = e.model.position.toArray();
  const ik1 = t.ikSnapshot();
  // 模型与全部 IK 点同步平移 (+0.5, 0, +0.3)
  let maxErr = 0;
  for (const [name, a] of Object.entries(ik1)) {
    maxErr = Math.max(maxErr,
      t.dist(a.target, [ik0[name].target[0] + 0.5, ik0[name].target[1], ik0[name].target[2] + 0.3]),
      t.dist(a.pole, [ik0[name].pole[0] + 0.5, ik0[name].pole[1], ik0[name].pole[2] + 0.3]));
  }
  const modelMoved = t.dist(p1, [p0[0] + 0.5, p0[1], p0[2] + 0.3]);
  // 复位
  ds.moveExternalCharacter(e.id, -0.5, 0, -0.3);
  return { modelMoved, maxErr };
});
check("契约10c gizmo 移动拖拽 → 模型 + IK target 同步平移（<1e-6）",
  gz10c.modelMoved < 1e-6 && gz10c.maxErr < 1e-6,
  JSON.stringify(gz10c));

// ================= 契约 11：骨骼模式共存 =================
const gz11 = await page.evaluate(async () => {
  const ds = window.__ds;
  const cg = ds.charGizmo;
  ds.boneEditor.setMode("bone");
  await new Promise((r) => setTimeout(r, 120));
  cg.update();
  const inBone = { attached: cg.attachedId, vis: cg.helperVisible, ikSuppressed: !!ds.externalCharacters._ikTargetsSuppressed };
  ds.boneEditor.setMode("ik");
  await new Promise((r) => setTimeout(r, 120));
  cg.update();
  const e = window.__t.entry();
  const backIk = { attached: cg.attachedId, vis: cg.helperVisible, activeId: e.id };
  return { inBone, backIk };
});
check("契约11 骨骼模式 gizmo 隐藏/detach；回 IK 模式恢复 attach",
  gz11.inBone.attached === null && gz11.inBone.vis === false &&
  gz11.backIk.attached === gz11.backIk.activeId && gz11.backIk.vis === true,
  JSON.stringify(gz11));

// ================= 契约 12：缩放滑条 UI =================
const ui12a = await page.evaluate(() => {
  const ds = window.__ds;
  ds.stopAllActions();
  ds.setCharacterScale(1);
  const panel = document.getElementById("ext-gizmo-panel");
  const slider = document.getElementById("ext-scale");
  const val = document.getElementById("ext-scale-val");
  const undoBefore = ds.getUndoDepth();
  // 模拟一次拖拽手势：pointerdown → 两次 input（应只压一次 undo）
  slider.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  slider.value = "1.4";
  slider.dispatchEvent(new Event("input", { bubbles: true }));
  slider.value = "1.6";
  slider.dispatchEvent(new Event("input", { bubbles: true }));
  const s = ds.getCharacterScale();
  const undoPushed = ds.getUndoDepth() - undoBefore;
  return { panel: !!panel, slider: !!slider, s, valText: val.textContent, undoPushed };
});
check("契约12a 缩放滑条实时预览（s≈1.6，百分比 160%）",
  ui12a.panel && ui12a.slider && Math.abs(ui12a.s - 1.6) < 0.02 && ui12a.valText === "160%",
  JSON.stringify({ s: ui12a.s, val: ui12a.valText }));
check("契约12b 一次拖拽手势只压一次 undo", ui12a.undoPushed === 1, `pushed=${ui12a.undoPushed}`);

const ui12b = await page.evaluate(() => {
  const ds = window.__ds;
  const undoOk = ds.performUndo(); // 撤掉滑条手势
  const sUndone = ds.getCharacterScale();
  // 归零按钮
  ds.setCharacterScale(1.5);
  const undoBefore = ds.getUndoDepth();
  document.getElementById("ext-scale-reset").click();
  const sReset = ds.getCharacterScale();
  const undoPushed = ds.getUndoDepth() - undoBefore;
  return { undoOk, sUndone, sReset, undoPushed };
});
check("契约12c 滑条手势 undo 后回原缩放", ui12b.undoOk === true && Math.abs(ui12b.sUndone - 1.0) < 1e-3,
  `s=${ui12b.sUndone}`);
check("契约12d 归零按钮回 100% 且压一次 undo",
  Math.abs(ui12b.sReset - 1.0) < 1e-3 && ui12b.undoPushed === 1,
  JSON.stringify({ s: ui12b.sReset, pushed: ui12b.undoPushed }));

// 双向同步：API 缩放 → 300ms 轮询 → 滑条/读数跟随
await page.evaluate(() => window.__ds.setCharacterScale(1.3));
await page.waitForTimeout(450);
const ui12e = await page.evaluate(() => ({
  slider: parseFloat(document.getElementById("ext-scale").value),
  val: document.getElementById("ext-scale-val").textContent,
}));
check("契约12e API→滑条双向同步（s=1.3 → 130%）",
  Math.abs(ui12e.slider - 1.3) < 0.02 && ui12e.val === "130%", JSON.stringify(ui12e));

// ================= 收尾：截图 + JS 错误 =================
await page.evaluate(() => {
  window.__ds.setCharacterScale(2.0);
  window.__ds.setCharacterRotation({ x: 0, y: 45, z: 0 });
  window.__ds.charGizmo.setMode("scale");
});
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(__dirname, "out", "char-gizmo-scale.png") });
check("契约13 页面无 JS 错误", errors.length === 0, errors.slice(0, 3).join(" | "));

console.log(`\n==== 结果: ${pass} 通过 / ${fail} 失败 ====`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
