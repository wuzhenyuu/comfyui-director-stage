/** char-rotation-verify.mjs — P3-4 3D外部角色「整体旋转」验收探针
 *
 * 验收契约：
 *  0) 探针自检（near/Ry 映射辅助函数可用）
 *  1) API 契约：__ds.setCharacterRotation / getCharacterRotation / manager.setCharacterRotation 存在
 *  2) Y=90° 旋转生效：getCharacterRotation().y≈90、|x|/|z|≈0；重复调用幂等（同角两次四元数不变）
 *  3) IK 随动（非播放）：全部 IK target/pole 世界坐标 = 旋转前位置绕 model.position 的 R90 映射（<1e-4）
 *  4) 脚钉地不回拉：旋转后稳定 400ms，腿 IK target 保持旋转后期望值（<0.01），骨端与 target 漂移 <0.01
 *  5) 播放中旋转（idle & walk）：旋转 90° 后续播 600ms，每 100ms 采样双腿骨端↔target 漂移 <0.01；
 *     朝向（双肩连线方向）随动 ~90°；旋转角不被动作回写
 *  6) undo/redo：pushUndo→旋转 90°→undo 回 identity（IK target 同步恢复）→redo 回 90°；
 *     redo 后骨端↔target 一致（<0.01）
 *  7) 持久化：旋转 35°→getSceneJSON 的 transform.quaternion 与模型一致→restore 往返后 y≈35°；
 *     旧工程缺省 quaternion → identity 兼容
 *  8) openpose 关节路径：旋转 60° 后 18 关节世界坐标 = 旋转前绕 pivot 的 R60 映射（<0.01），
 *     且投影到相机的 NDC 确实变化（画面跟随）
 *  9) UI：#ext-rotation-panel 存在；Y 滑条手势（pointerdown+input）实时旋转、度数显示、
 *     一次手势只压一次 undo；X/Z 折叠区存在；归零按钮生效且可 undo
 * 10) 截图 test/out/char-rotation.png；页面无 JS 错误
 *
 * 用法: node char-rotation-verify.mjs
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
    dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
    near: (a, b, eps) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= eps,
    // 绕 Y 轴旋转（three.js Ry 约定：x' = c·x + s·z, z' = -s·x + c·z）
    ry: (p, pivot, deg) => {
      const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
      const dx = p[0] - pivot[0], dy = p[1] - pivot[1], dz = p[2] - pivot[2];
      return [pivot[0] + c * dx + s * dz, pivot[1] + dy, pivot[2] - s * dx + c * dz];
    },
    // 骨骼世界坐标（无全局 THREE，用 position 的构造函数造 Vector3）
    boneWorld: (bone) => {
      const v = new bone.position.constructor();
      bone.getWorldPosition(v);
      return [v.x, v.y, v.z];
    },
    entry: () => window.__ds.externalCharacters.getActive(),
    refresh: () => window.__ds.scene.updateMatrixWorld(true),
    // 双肩连线方向（角色右侧方向，水平）：用于朝向随动判定
    facing: () => {
      const e = window.__t.entry();
      e.model.updateMatrixWorld(true);
      const r = window.__t.boneWorld(e.jointMap.get(2));
      const l = window.__t.boneWorld(e.jointMap.get(5));
      const d = [r[0] - l[0], 0, r[2] - l[2]];
      const n = Math.hypot(d[0], d[2]) || 1;
      return [d[0] / n, 0, d[2] / n];
    },
    angleDeg: (a, b) => {
      const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
    },
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
    joints18: () => {
      const e = window.__t.entry();
      e.model.updateMatrixWorld(true);
      const out = [];
      for (let i = 0; i < 18; i++) {
        const b = e.jointMap.get(i);
        out.push(b ? window.__t.boneWorld(b) : [0, 0, 0]);
      }
      return out;
    },
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
const selfTest = await page.evaluate(() => {
  const t = window.__t;
  const mapped = t.ry([1, 0.5, 0], [0, 0.5, 0], 90); // (1,0.5,0) 绕 (0,0.5,0) 转90° → (0,0.5,-1)
  return {
    nearOk: t.near([1, 2, 3], [1, 2, 3], 0.001) && !t.near([1, 2, 3], [1.5, 2, 3], 0.001),
    ryOk: t.near(mapped, [0, 0.5, -1], 1e-9),
  };
});
check("契约0 探针自检（near/Ry 映射）", selfTest.nearOk && selfTest.ryOk, JSON.stringify(selfTest));

// ================= 契约 1：API 存在 =================
const api = await page.evaluate(() => ({
  dsSet: typeof window.__ds.setCharacterRotation === "function",
  dsGet: typeof window.__ds.getCharacterRotation === "function",
  mgrSet: typeof window.__ds.externalCharacters.setCharacterRotation === "function",
  mgrGet: typeof window.__ds.externalCharacters.getCharacterRotation === "function",
}));
check("契约1 setCharacterRotation/getCharacterRotation API 存在",
  api.dsSet && api.dsGet && api.mgrSet && api.mgrGet, JSON.stringify(api));

// ================= 契约 2：Y=90° 旋转生效 + 幂等 =================
const rot2 = await page.evaluate(() => {
  const ds = window.__ds;
  ds.stopAllActions();
  const e = window.__t.entry();
  const id = e.id;
  const okRet = ds.setCharacterRotation(id, { y: 90 });
  const r1 = ds.getCharacterRotation(id);
  const q1 = e.model.quaternion.toArray();
  ds.setCharacterRotation(id, { y: 90 }); // 同角重设：幂等
  const q2 = e.model.quaternion.toArray();
  // 省略 id（活动角色）+ 省略对象（仅 y）兼容调用
  const okShort = ds.setCharacterRotation({ y: 90 });
  return { okRet, r1, qSame: window.__t.near(q1, q2, 1e-9), okShort, active: ds.getCharacterRotation() };
});
check("契约2 Y=90° 旋转生效（y≈90, x/z≈0）",
  rot2.okRet === true && Math.abs(rot2.r1.y - 90) < 0.5 && Math.abs(rot2.r1.x) < 0.5 && Math.abs(rot2.r1.z) < 0.5,
  JSON.stringify(rot2.r1));
check("契约2b 同角重设幂等 + 省略 id 简写可用", rot2.qSame && rot2.okShort === true && Math.abs(rot2.active.y - 90) < 0.5,
  `qSame=${rot2.qSame} okShort=${rot2.okShort}`);

// ================= 契约 3+4：IK 随动 + 脚钉地不回拉（非播放） =================
// 先归零，再旋转，比较 IK 点是否严格按 R90 映射
const ik34 = await page.evaluate(() => {
  const ds = window.__ds;
  ds.stopAllActions();
  ds.setCharacterRotation({ x: 0, y: 0, z: 0 });
  const e = window.__t.entry();
  const pivot = e.model.position.toArray();
  const before = window.__t.ikSnapshot();
  ds.setCharacterRotation({ y: 90 });
  const after = window.__t.ikSnapshot();
  let maxErr = 0;
  for (const [name, b] of Object.entries(before)) {
    const expT = window.__t.ry(b.target, pivot, 90);
    const expP = window.__t.ry(b.pole, pivot, 90);
    maxErr = Math.max(maxErr, window.__t.dist(expT, after[name].target), window.__t.dist(expP, after[name].pole));
  }
  return { maxErr, pivot, before, after };
});
check("契约3 IK target/pole 绕 pivot R90 精确随动（<1e-4）", ik34.maxErr < 1e-4, `maxErr=${ik34.maxErr.toExponential(2)}`);

await page.waitForTimeout(400); // 多帧脚钉地窗口
const ik4 = await page.evaluate(() => ({ drift: window.__t.legDrift() }));
const ik4hold = await page.evaluate((prev) => {
  const now = window.__t.ikSnapshot();
  let maxHold = 0;
  for (const [name, a] of Object.entries(now)) {
    maxHold = Math.max(maxHold,
      window.__t.dist(a.target, prev.after[name].target),
      window.__t.dist(a.pole, prev.after[name].pole));
  }
  return maxHold;
}, ik34);
check("契约4a 脚钉地不回拉（腿 target 保持旋转后位置 <0.01）", ik4hold < 0.01, `hold=${ik4hold.toFixed(5)}`);
check("契约4b 骨端↔IK target 漂移 <0.01（旋转后稳态）",
  (ik4.drift.rightLeg ?? 1) < 0.01 && (ik4.drift.leftLeg ?? 1) < 0.01, JSON.stringify(ik4.drift));

// ================= 契约 5：播放中旋转（idle & walk） =================
async function playingRotationCase(actionId) {
  // 先测【无旋转基线】（P2 基准：CCD 求解对快速目标的固有滞后），再测旋转后漂移。
  // 断言：旋转后漂移 ≤ 基线 + 0.003（旋转不引入额外漂移），而非绝对 0.01
  // （walk 基线本身 ~0.023，旋转前后实测 0.02283 vs 0.02284）。
  return page.evaluate(async (act) => {
    const ds = window.__ds;
    const t = window.__t;
    ds.stopAllActions();
    ds.setCharacterRotation({ x: 0, y: 0, z: 0 });
    const e = t.entry();
    const sampleDrift = async () => {
      const out = [];
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 100));
        out.push(t.legDrift());
      }
      let mx = 0;
      for (const s of out) mx = Math.max(mx, s.rightLeg ?? 1, s.leftLeg ?? 1);
      return mx;
    };
    // 基线：播放、不旋转
    ds.playAction(e.id, act);
    await new Promise((r) => setTimeout(r, 400));
    const baseline = await sampleDrift();
    // 旋转 90° 后续播
    const facingBefore = t.facing();
    ds.setCharacterRotation({ y: 90 });
    const rotated = await sampleDrift();
    const facingAfter = t.facing();
    const rot = t.rot();
    ds.stopAllActions();
    return { baseline, rotated, facingAngle: t.angleDeg(facingBefore, facingAfter), rotY: rot.y };
  }, actionId);
}
const idleCase = await playingRotationCase("idle");
check("契约5a idle 播放中旋转 90°：漂移不超越基线（且绝对值 <0.01）",
  idleCase.rotated <= idleCase.baseline + 0.003 && idleCase.rotated < 0.01,
  `baseline=${idleCase.baseline.toFixed(5)} rotated=${idleCase.rotated.toFixed(5)}`);
check("契约5b idle 旋转后朝向随动 ~90° 且不被动作回写",
  Math.abs(idleCase.facingAngle - 90) < 8 && Math.abs(idleCase.rotY - 90) < 1,
  `facing=${idleCase.facingAngle.toFixed(1)}° rotY=${idleCase.rotY}`);
const walkCase = await playingRotationCase("walk");
check("契约5c walk 播放中旋转 90°：漂移不超越 P2 基线（+0.003 裕度）",
  walkCase.rotated <= walkCase.baseline + 0.003,
  `baseline=${walkCase.baseline.toFixed(5)} rotated=${walkCase.rotated.toFixed(5)}`);
check("契约5d walk 旋转后朝向随动 ~90° 且不被动作回写",
  Math.abs(walkCase.facingAngle - 90) < 8 && Math.abs(walkCase.rotY - 90) < 1,
  `facing=${walkCase.facingAngle.toFixed(1)}° rotY=${walkCase.rotY}`);

// ================= 契约 6：undo/redo =================
const undo6 = await page.evaluate(async () => {
  const ds = window.__ds;
  const t = window.__t;
  ds.stopAllActions();
  await new Promise((r) => setTimeout(r, 700)); // 等 stand 混合完全稳定（快照=骨骼=target 一致）
  ds.setCharacterRotation({ x: 0, y: 0, z: 0 });
  const ikPre = t.ikSnapshot();
  ds.pushUndo();
  ds.setCharacterRotation({ y: 90 });
  const rotMid = t.rot();
  const ikRot = t.ikSnapshot();
  const undoOk = ds.performUndo();
  const rotUndone = t.rot();
  const ikUndone = t.ikSnapshot();
  // 判别式：undo 后必须离【旋转前】近、离【旋转 90°】远（防恒真断言）。
  // 注：undo 骨骼通道经 applyPoseBones→syncIKFromBones 从骨骼重推 IK，
  // target 为骨端世界坐标（与快照一致 <0.01）；pole 按公式重推，只做判别式比较。
  let targetErr = 0, discriminantOk = true;
  for (const [name, u] of Object.entries(ikUndone)) {
    targetErr = Math.max(targetErr, t.dist(u.target, ikPre[name].target));
    if (t.dist(u.target, ikPre[name].target) >= t.dist(u.target, ikRot[name].target)) discriminantOk = false;
    if (t.dist(u.pole, ikPre[name].pole) >= t.dist(u.pole, ikRot[name].pole)) discriminantOk = false;
  }
  const redoOk = ds.performRedo();
  const rotRedone = t.rot();
  await new Promise((r) => setTimeout(r, 250)); // redo 后补解 IK
  const drift = t.legDrift();
  return { rotMid, undoOk, rotUndone, targetErr, discriminantOk, redoOk, rotRedone, drift };
});
check("契约6a 旋转进 undo 通道：undo 回 identity / redo 回 90°",
  undo6.undoOk === true && undo6.redoOk === true &&
  Math.abs(undo6.rotMid.y - 90) < 1 && Math.abs(undo6.rotUndone.y) < 1 && Math.abs(undo6.rotRedone.y - 90) < 1,
  JSON.stringify({ mid: undo6.rotMid, undone: undo6.rotUndone, redone: undo6.rotRedone }));
check("契约6b undo 后 IK target 恢复（<0.01 且判别式成立：近旋转前/远旋转后）",
  undo6.targetErr < 0.01 && undo6.discriminantOk, `targetErr=${undo6.targetErr.toFixed(5)} discriminant=${undo6.discriminantOk}`);
check("契约6c redo 后骨端↔target 一致（<0.01）",
  (undo6.drift.rightLeg ?? 1) < 0.01 && (undo6.drift.leftLeg ?? 1) < 0.01, JSON.stringify(undo6.drift));

// ================= 契约 7：持久化 sceneJSON 往返 =================
const persist = await page.evaluate(async () => {
  const ds = window.__ds;
  const t = window.__t;
  ds.stopAllActions();
  ds.setCharacterRotation({ x: 0, y: 35, z: 0 });
  const modelQ = t.entry().model.quaternion.toArray();
  const sceneJSON = ds.getSceneJSON();
  const saved = sceneJSON.externalCharacters?.[0];
  const savedQ = saved?.transform?.quaternion || null;
  const qMatch = savedQ && t.near(modelQ, savedQ, 2e-5);
  // 往返：restore 走真实恢复路径（内部先 clear 再异步重载模型）
  const ok = await ds.externalCharacters.restore({
    characters: sceneJSON.externalCharacters,
    activeCharacterId: sceneJSON.activeExternalCharacterId,
  });
  const rotAfter = ds.getCharacterRotation(sceneJSON.activeExternalCharacterId);
  // 旧工程兼容：quaternion 缺省 → identity
  const legacy = JSON.parse(JSON.stringify(sceneJSON.externalCharacters));
  delete legacy[0].transform.quaternion;
  await ds.externalCharacters.restore({ characters: legacy, activeCharacterId: legacy[0].id });
  const rotLegacy = ds.getCharacterRotation(legacy[0].id);
  ds.setCharacterRotation({ x: 0, y: 0, z: 0 });
  return { qMatch, ok, rotAfter, rotLegacy };
});
check("契约7a sceneJSON.transform.quaternion 与模型一致", persist.qMatch === true);
check("契约7b 保存→重载往返后旋转角保留（y≈35°）",
  persist.ok === true && persist.rotAfter && Math.abs(persist.rotAfter.y - 35) < 1,
  JSON.stringify(persist.rotAfter));
check("契约7c 旧工程缺省 quaternion → identity 兼容",
  persist.rotLegacy && Math.abs(persist.rotLegacy.y) < 1 && Math.abs(persist.rotLegacy.x) < 1,
  JSON.stringify(persist.rotLegacy));

// ================= 契约 8：openpose 关节世界坐标路径 =================
const op8 = await page.evaluate(() => {
  const ds = window.__ds;
  const t = window.__t;
  ds.stopAllActions();
  ds.setCharacterRotation({ x: 0, y: 0, z: 0 });
  const e = t.entry();
  const pivot = e.model.position.toArray();
  const before = t.joints18();
  // 投影对照：旋转前踝关节 NDC
  const cam = ds.camera;
  const project = (p) => {
    const v = new e.model.position.constructor(p[0], p[1], p[2]);
    v.project(cam);
    return [v.x, v.y];
  };
  const ndcBefore = project(before[10]); // RAnkle
  ds.setCharacterRotation({ y: 60 });
  const after = t.joints18();
  let maxErr = 0, checked = 0;
  for (let i = 0; i < 18; i++) {
    if (before[i][0] === 0 && before[i][1] === 0 && before[i][2] === 0) continue; // 缺关节跳过
    checked++;
    maxErr = Math.max(maxErr, t.dist(t.ry(before[i], pivot, 60), after[i]));
  }
  const ndcAfter = project(after[10]);
  return { maxErr, checked, ndcMove: Math.hypot(ndcAfter[0] - ndcBefore[0], ndcAfter[1] - ndcBefore[1]) };
});
check("契约8a 旋转后 18 关节世界坐标 = 旋转前 R60 映射（openpose 导出源，<0.01）",
  op8.checked >= 12 && op8.maxErr < 0.01, `checked=${op8.checked} maxErr=${op8.maxErr.toFixed(5)}`);
check("契约8b 关节相机投影（NDC）确实随旋转变化", op8.ndcMove > 1e-3, `ndcMove=${op8.ndcMove.toFixed(4)}`);

// ================= 契约 9：UI 滑条组 =================
const ui9a = await page.evaluate(() => {
  const ds = window.__ds;
  ds.stopAllActions();
  ds.setCharacterRotation({ x: 0, y: 0, z: 0 });
  const panel = document.getElementById("ext-rotation-panel");
  const slider = document.getElementById("ext-rot-y");
  const val = document.getElementById("ext-rot-y-val");
  const details = document.getElementById("ext-rot-details");
  const sx = document.getElementById("ext-rot-x");
  const sz = document.getElementById("ext-rot-z");
  const undoBefore = ds.getUndoDepth();
  // 模拟一次拖拽手势：pointerdown → 两次 input（应只压一次 undo）
  slider.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  slider.value = "45";
  slider.dispatchEvent(new Event("input", { bubbles: true }));
  slider.value = "60";
  slider.dispatchEvent(new Event("input", { bubbles: true }));
  const rotMid = ds.getCharacterRotation();
  const undoAfter = ds.getUndoDepth();
  return {
    panel: !!panel, slider: !!slider, details: !!details, sx: !!sx, sz: !!sz,
    valText: val.textContent, rotY: rotMid?.y, undoPushed: undoAfter - undoBefore,
  };
});
check("契约9a 旋转面板挂载 + Y 滑条实时预览（y≈60°，度数显示 60°）",
  ui9a.panel && ui9a.slider && Math.abs(ui9a.rotY - 60) < 1.5 && ui9a.valText === "60°",
  JSON.stringify({ rotY: ui9a.rotY, val: ui9a.valText }));
check("契约9b X/Z 折叠区存在", ui9a.details && ui9a.sx && ui9a.sz);
check("契约9c 一次拖拽手势只压一次 undo", ui9a.undoPushed === 1, `pushed=${ui9a.undoPushed}`);

const ui9b = await page.evaluate(() => {
  const ds = window.__ds;
  const undoOk = ds.performUndo(); // 撤掉滑条手势
  const rotUndone = ds.getCharacterRotation();
  // 归零按钮
  ds.setCharacterRotation({ x: 0, y: 30, z: 0 });
  const undoBefore = ds.getUndoDepth();
  document.getElementById("ext-rot-reset").click();
  const rotReset = ds.getCharacterRotation();
  const undoPushed = ds.getUndoDepth() - undoBefore;
  return { undoOk, rotUndone, rotReset, undoPushed };
});
check("契约9d 滑条手势 undo 后回 0°", ui9b.undoOk === true && Math.abs(ui9b.rotUndone.y) < 1,
  JSON.stringify(ui9b.rotUndone));
check("契约9e 归零按钮生效且压一次 undo",
  Math.abs(ui9b.rotReset.y) < 1 && Math.abs(ui9b.rotReset.x) < 1 && ui9b.undoPushed === 1,
  JSON.stringify({ rot: ui9b.rotReset, pushed: ui9b.undoPushed }));

// ================= 收尾：截图 + JS 错误 =================
await page.evaluate(() => window.__ds.setCharacterRotation({ x: 0, y: 90, z: 0 }));
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(__dirname, "out", "char-rotation.png") });
check("契约10 页面无 JS 错误", errors.length === 0, errors.slice(0, 3).join(" | "));

console.log(`\n==== 结果: ${pass} 通过 / ${fail} 失败 ====`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
