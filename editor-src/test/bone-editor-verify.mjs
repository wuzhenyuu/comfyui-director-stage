/** bone-editor-verify.mjs — 骨骼编辑模式 + 姿态预设 验收契约测试（测试C：Playwright 验收）
 *
 * 本脚本只写测试，不改核心源码。核心（boneEditor / posePresets / 编辑模式 UI）由其他
 * Agent 并行实现；未实现的契约点会失败并在输出中明确报告缺什么。
 *
 * ── 验收契约 ────────────────────────────────────────────────────────────────
 *  1) 默认 3D-only：至少 1 个 GLB 角色，火柴人不可见；
 *  2) 找到并点击 [data-edit-mode="bone"] 进入骨骼编辑模式；
 *  3) window.__ds_boneNodeScreen 至少包含 hips/head/rightUpperArm/rightLowerArm/
 *     rightUpperLeg/rightLowerLeg 等节点；
 *  4) 点击 rightUpperArm 骨骼节点后：__ds.boneEditor.getState().selectedBone 匹配，
 *     且出现 Gizmo（TransformControls 或 boneEditor 状态可见）；
 *  5) 三维旋转：API 或拖 Gizmo 让 rightUpperArm rotation 变化；手腕世界坐标位移 > 0.05；
 *     模型整体 position 不变；相机不动；
 *  6) IK 分离：骨骼旋转后切回 [data-edit-mode="ik"]，IK target 刷新到当前手腕附近
 *     （距离 < 0.15）；切回 bone 后骨骼姿势不重置；
 *  7) Root/Hips 平移：默认 allowTranslate=true；translate hips Y > 0.05；
 *     高级模式关闭时 rightUpperArm allowTranslate=false；
 *  8) 高级模式：打开 [data-advanced-bone-translate] 后 rightUpperArm allowTranslate=true，
 *     可平移 selected bone；
 *  9) 保存姿态：点击 [data-save-pose]，输入/生成名称「E2E姿态」；
 *     __ds.posePresets.list() 包含该姿态；bones 至少包含 rightUpperArm；
 * 10) 改变姿势后 apply 姿态：rightUpperArm rotation 恢复到保存值附近（误差 < 0.05 rad）；
 * 11) sceneJSON 包含 posePresets；reload + init 后姿态仍在，apply 仍可用；
 * 12) 多角色：添加第 2 个 GLB，应用同一姿态只影响活动角色，不影响另一个角色；
 * 13) openpose/mask 导出仍只含外部角色，页面无 JS 错误；
 * 14) 截图 test/out/bone-editor.png。
 *
 * ── 对核心 Agent 的接口假设（本测试按以下形状探测，均做容错读取）──────────
 *  A. 编辑模式 UI：存在 [data-edit-mode="ik"|"bone"] 按钮/控件；当前模式可从
 *     [data-edit-mode].active/aria-pressed 或 __ds.boneEditor.getState().mode 读取。
 *  B. 骨骼节点投影：window.__ds_boneNodeScreen 为数组，元素至少含
 *     { name, x, y }（canvas 相对像素坐标，同 __ds_jointScreen 约定），可选
 *     behind/bone/obj 字段。name 使用规范名：hips/head/rightUpperArm/...
 *  C. boneEditor API（__ds.boneEditor）：
 *     - getState() → { mode, selectedBone, bones?: { [name]: { allowTranslate, rotation } }, gizmoVisible? }
 *     - 旋转（任一）：rotateBone(name, [dx,dy,dz]) / setBoneRotation(name,[x,y,z]) /
 *       setRotation(name,[x,y,z])；否则测试回退到屏幕节点上的 bone 对象直接改 rotation。
 *     - 平移（任一）：translateBone(name, [dx,dy,dz]) / setBonePosition(name,[x,y,z])；
 *       同上回退。
 *     - allowTranslate 读取（任一）：getState().bones[name].allowTranslate /
 *       isTranslateAllowed(name) / canTranslate(name) / getAllowTranslate(name)。
 *  D. 姿态预设 API（__ds.posePresets）：
 *     - list() → [{ name, bones? }] 或 [name]
 *     - apply(name) 或 apply(name, charId)；可选 get(name) 返回 { bones: {...} }
 *  E. 保存姿态 UI：[data-save-pose] 按钮；点击后 window.prompt 输入名称，
 *     或出现 [data-pose-name-input] 输入框 + 确认按钮。
 *  F. 高级平移开关：[data-advanced-bone-translate]（checkbox 或按钮）。
 *  G. sceneJSON：getSceneJSON() 解析后含 posePresets 字段；init 恢复后 list() 仍在。
 *
 * 用法: node bone-editor-verify.mjs
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
const uploadDir = path.join(__dirname, "out", "uploads");
fs.mkdirSync(uploadDir, { recursive: true });
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".glb": "model/gltf-binary" };

// ---- 契约 1a：静态服务器（随机端口 + /director_stage/models 映射 + mock 上传）----
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
console.log("静态服务器端口:", port, "（随机端口；/upload/image 已 mock）");

const glbName = "michelle.glb";
const glbResp = await fetch(`http://127.0.0.1:${port}/director_stage/models/${glbName}`);
const glbBody = await glbResp.arrayBuffer().catch(() => new ArrayBuffer(0));

let pass = 0, fail = 0, skip = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};
const checkSkip = (name, reason) => {
  console.log(`⏭️  ${name} — SKIPPED: ${reason}`);
  skip++;
};
check("契约1a 静态映射 /director_stage/models/*.glb → assets/models",
  glbResp.ok && glbBody.byteLength > 0, `HTTP ${glbResp.status}, body=${glbBody.byteLength}B`);

const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch({ channel: "chrome" }));
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
let currentStep = "boot";
const mark = (s) => { currentStep = s; };
page.on("pageerror", (e) => errors.push(`[step=${currentStep}] ${e.message}`));
// 姿态保存名称弹窗（window.prompt 形态）统一应答「E2E姿态」
page.on("dialog", (d) => d.accept("E2E姿态"));

// 契约要求：?e2e=1 启动
await page.goto(`http://127.0.0.1:${port}/index.html?e2e=1`);
await page.waitForFunction(() => !!window.__ds, null, { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(1500);

const d3 = (p, q) => (p && q ? Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) : null);

// ================= 契约 1：默认 3D-only =================
mark("contract1-boot");
const autoLoaded = await page.waitForFunction(
  () => (window.__ds?.externalCharacters?.getAll?.().length ?? 0) >= 1,
  null, { timeout: 25000 }
).then(() => true).catch(() => false);
const boot = await page.evaluate(() => {
  const entries = window.__ds?.externalCharacters?.getAll?.() || [];
  return {
    count: entries.length,
    mode: window.__ds?.characterMode ?? null,
    figureExists: !!window.__ds?.figureGroup,
    figureVisible: window.__ds?.figureGroup?.visible ?? null,
    modelVisible: entries[0]?.model?.visible ?? null,
  };
});
console.log("  启动状态:", JSON.stringify(boot));
check("契约1b 默认启动后存在至少 1 个 GLB 角色", autoLoaded && boot.count >= 1,
  `count=${boot.count}`);
check("契约1c 默认 3D-only（火柴人不可见）",
  boot.mode !== "stick" && (!boot.figureExists || boot.figureVisible === false),
  `mode=${boot.mode} figureExists=${boot.figureExists} figureVisible=${boot.figureVisible}`);
check("契约1d GLB 角色 model 可见", boot.modelVisible === true, `modelVisible=${boot.modelVisible}`);

// ================= 契约 2：进入骨骼编辑模式 =================
mark("contract2-enter-bone-mode");
const boneModeBtn = await page.evaluate(() => {
  const el = document.querySelector('[data-edit-mode="bone"]');
  if (!el) return { ok: false, reason: '页面无 [data-edit-mode="bone"] 控件' };
  el.click();
  return { ok: true };
});
check("契约2a 找到并点击 [data-edit-mode=\"bone\"]", boneModeBtn.ok,
  boneModeBtn.ok ? "" : `${boneModeBtn.reason} — 契约未实现：核心需提供编辑模式切换 UI（接口假设 A）`);
await page.waitForTimeout(600);
const modeState = await page.evaluate(() => {
  const st = window.__ds?.boneEditor?.getState?.() || {};
  const activeBtn = document.querySelector('[data-edit-mode="bone"]');
  return {
    stateMode: st.mode ?? null,
    btnActive: activeBtn
      ? (activeBtn.classList.contains("active") || activeBtn.getAttribute("aria-pressed") === "true" || activeBtn.dataset.active === "true")
      : null,
    hasBoneEditor: !!window.__ds?.boneEditor,
  };
});
console.log("  模式状态:", JSON.stringify(modeState));
check("契约2b 已进入骨骼编辑模式（state.mode==='bone' 或按钮 active）",
  modeState.hasBoneEditor && (modeState.stateMode === "bone" || modeState.btnActive === true),
  JSON.stringify(modeState) + (modeState.hasBoneEditor ? "" : " — 契约未实现：__ds.boneEditor 不存在（接口假设 C）"));

// ================= 契约 3：__ds_boneNodeScreen 覆盖关键骨骼 =================
mark("contract3-bone-node-screen");
const REQUIRED_BONES = ["hips", "head", "rightUpperArm", "rightLowerArm", "rightUpperLeg", "rightLowerLeg"];
const nodeScreen = await page.waitForFunction(
  () => Array.isArray(window.__ds_boneNodeScreen) && window.__ds_boneNodeScreen.length >= 6,
  null, { timeout: 8000 }
).then(() => true).catch(() => false);
const boneNodes = await page.evaluate(() =>
  (window.__ds_boneNodeScreen || []).map((e) => ({ name: e.name ?? e.boneName ?? null, x: e.x, y: e.y, behind: !!e.behind })));
const nodeNames = new Set(boneNodes.map((n) => n.name).filter(Boolean));
const missingBones = REQUIRED_BONES.filter((b) => !nodeNames.has(b));
console.log("  骨骼节点:", JSON.stringify([...nodeNames]));
check("契约3 __ds_boneNodeScreen 包含 hips/head/rightUpperArm/rightLowerArm/rightUpperLeg/rightLowerLeg",
  nodeScreen && missingBones.length === 0,
  nodeScreen
    ? (missingBones.length ? `缺少: ${missingBones.join(",")} — 契约未实现：投影节点命名需用规范名（接口假设 B）` : `共 ${boneNodes.length} 节点`)
    : "8s 内 __ds_boneNodeScreen 为空/不足 6 个 — 契约未实现：核心需在骨骼编辑模式投影骨骼节点（接口假设 B）");

// ================= 页面侧辅助函数（注入一次，后续复用） =================
await page.evaluate(() => {
  window.__t = {
    /** 读指定骨骼的 rotation euler [x,y,z]（多 API 形状容错） */
    readBoneEuler(name) {
      const be = window.__ds?.boneEditor;
      if (!be) return null;
      if (be.getBoneRotation) { const r = be.getBoneRotation(name); if (r) return [...r]; }
      const st = be.getState?.();
      const r2 = st?.bones?.[name]?.rotation;
      if (Array.isArray(r2)) return [...r2];
      const node = (window.__ds_boneNodeScreen || []).find((e) => (e.name ?? e.boneName) === name);
      const bone = node?.bone || node?.obj || null;
      if (bone?.rotation) return [bone.rotation.x, bone.rotation.y, bone.rotation.z];
      return null;
    },
    /** 读骨骼世界坐标 */
    boneWorld(name) {
      const node = (window.__ds_boneNodeScreen || []).find((e) => (e.name ?? e.boneName) === name);
      const bone = node?.bone || node?.obj || null;
      if (bone) {
        const v = new bone.position.constructor();
        bone.getWorldPosition(v);
        return v.toArray();
      }
      return null;
    },
    /** 活动角色右手腕世界坐标（openpose 数据源：jointMap RWrist=4，兼容 rightWrist 键） */
    wristWorld(charIndex = null) {
      const mgr = window.__ds?.externalCharacters;
      const entries = mgr?.getAll?.() || [];
      const entry = charIndex === null ? (mgr?.getActive?.() || entries[0]) : entries[charIndex];
      if (!entry) return null;
      const bone = entry.jointMap?.get?.(4) || entry.jointMap?.get?.("rightWrist") || entry.jointMap?.rightWrist || null;
      if (!bone) return null;
      const v = new bone.position.constructor();
      bone.getWorldPosition(v);
      return v.toArray();
    },
    /** 活动角色 model.position（本地坐标，整体平移检测用） */
    modelPos(charIndex = null) {
      const mgr = window.__ds?.externalCharacters;
      const entries = mgr?.getAll?.() || [];
      const entry = charIndex === null ? (mgr?.getActive?.() || entries[0]) : entries[charIndex];
      return entry?.model?.position?.toArray?.() ?? null;
    },
    camPos() { return window.__ds?.camera?.position?.toArray?.() ?? null; },
    /** 旋转指定骨骼（API 优先，回退屏幕节点 bone 对象） */
    rotateBone(name, d) {
      const be = window.__ds?.boneEditor;
      if (!be) return { ok: false, via: null };
      if (be.rotateBone) { be.rotateBone(name, d); return { ok: true, via: "rotateBone" }; }
      const cur = this.readBoneEuler(name);
      if (be.setBoneRotation && cur) { be.setBoneRotation(name, [cur[0] + d[0], cur[1] + d[1], cur[2] + d[2]]); return { ok: true, via: "setBoneRotation" }; }
      if (be.setRotation && cur) { be.setRotation(name, [cur[0] + d[0], cur[1] + d[1], cur[2] + d[2]]); return { ok: true, via: "setRotation" }; }
      const node = (window.__ds_boneNodeScreen || []).find((e) => (e.name ?? e.boneName) === name);
      const bone = node?.bone || node?.obj || null;
      if (bone?.rotation) {
        bone.rotation.x += d[0]; bone.rotation.y += d[1]; bone.rotation.z += d[2];
        bone.updateMatrixWorld?.(true);
        be.refresh?.(); be.update?.(); be.onBoneChanged?.(name);
        return { ok: true, via: "bone-object-fallback" };
      }
      return { ok: false, via: null };
    },
    /** 平移指定骨骼（API 优先，回退 bone 对象 position） */
    translateBone(name, d) {
      const be = window.__ds?.boneEditor;
      if (!be) return { ok: false, via: null };
      if (be.translateBone) { be.translateBone(name, d); return { ok: true, via: "translateBone" }; }
      if (be.setBonePosition) {
        const node = (window.__ds_boneNodeScreen || []).find((e) => (e.name ?? e.boneName) === name);
        const bone = node?.bone || node?.obj || null;
        if (bone) { be.setBonePosition(name, [bone.position.x + d[0], bone.position.y + d[1], bone.position.z + d[2]]); return { ok: true, via: "setBonePosition" }; }
      }
      const node = (window.__ds_boneNodeScreen || []).find((e) => (e.name ?? e.boneName) === name);
      const bone = node?.bone || node?.obj || null;
      if (bone?.position) {
        bone.position.x += d[0]; bone.position.y += d[1]; bone.position.z += d[2];
        bone.updateMatrixWorld?.(true);
        be.refresh?.(); be.update?.(); be.onBoneChanged?.(name);
        return { ok: true, via: "bone-object-fallback" };
      }
      return { ok: false, via: null };
    },
    /** 读 allowTranslate（多形状容错） */
    allowTranslate(name) {
      const be = window.__ds?.boneEditor;
      if (!be) return null;
      const st = be.getState?.();
      const v = st?.bones?.[name]?.allowTranslate;
      if (typeof v === "boolean") return v;
      if (be.isTranslateAllowed) return !!be.isTranslateAllowed(name);
      if (be.canTranslate) return !!be.canTranslate(name);
      if (be.getAllowTranslate) return !!be.getAllowTranslate(name);
      return null;
    },
    /** 当前模式（state 或按钮态） */
    editMode() {
      const m = window.__ds?.boneEditor?.getState?.()?.mode;
      if (m) return m;
      for (const el of document.querySelectorAll("[data-edit-mode]")) {
        if (el.classList.contains("active") || el.getAttribute("aria-pressed") === "true") return el.dataset.editMode;
      }
      return null;
    },
  };
});

// ================= 契约 4：点击 rightUpperArm 节点 → 选中 + Gizmo =================
mark("contract4-select-bone");
const armNodePt = await page.evaluate(() => {
  const node = (window.__ds_boneNodeScreen || []).find((e) => (e.name ?? e.boneName) === "rightUpperArm" && !e.behind);
  if (!node) return { ok: false, reason: "rightUpperArm 不在可见投影缓存（或 behind=true）" };
  const canvas = [...document.querySelectorAll("#viewport canvas")].pop();
  const r = canvas.getBoundingClientRect();
  return { ok: true, sx: r.left + node.x, sy: r.top + node.y };
});
console.log("  rightUpperArm 投影点:", JSON.stringify(armNodePt));
let selectedOk = false;
if (armNodePt.ok) {
  await page.mouse.click(armNodePt.sx, armNodePt.sy);
  await page.waitForTimeout(500);
} else {
  // 回退：用 API 选中（若核心提供 selectBone）
  const apiSel = await page.evaluate(() => {
    const be = window.__ds?.boneEditor;
    if (be?.selectBone) { be.selectBone("rightUpperArm"); return true; }
    return false;
  });
  if (!apiSel) check("契约4a 点击 rightUpperArm 骨骼节点", false, armNodePt.reason + "；且 boneEditor 无 selectBone API 可回退");
  else check("契约4a 点击 rightUpperArm 骨骼节点", false, armNodePt.reason + "（已用 selectBone API 回退选中）");
}
const selState = await page.evaluate(() => {
  const st = window.__ds?.boneEditor?.getState?.() || {};
  let hasGizmoObj = false;
  window.__ds?.scene?.traverse?.((o) => { if (o.isTransformControls || o.type === "TransformControls") hasGizmoObj = true; });
  return {
    selectedBone: st.selectedBone ?? null,
    gizmoVisible: st.gizmoVisible ?? st.hasGizmo ?? null,
    hasGizmoObj,
  };
});
console.log("  选中状态:", JSON.stringify(selState));
selectedOk = selState.selectedBone === "rightUpperArm" ||
  (typeof selState.selectedBone === "string" && selState.selectedBone.includes("rightUpperArm"));
check("契约4a2 点击/选中 rightUpperArm 后 getState().selectedBone 匹配", selectedOk,
  `selectedBone=${selState.selectedBone}`);
check("契约4b 出现 Gizmo（TransformControls 或 boneEditor 状态可见）",
  selState.gizmoVisible === true || selState.hasGizmoObj === true,
  `gizmoVisible=${selState.gizmoVisible} hasGizmoObj=${selState.hasGizmoObj} — 若为 false：契约未实现，选中骨骼后需显示 TransformControls（接口假设 C）`);

// ================= 契约 5：三维旋转 rightUpperArm =================
mark("contract5-rotate");
const rotBefore = await page.evaluate(() => ({
  euler: window.__t.readBoneEuler("rightUpperArm"),
  wrist: window.__t.wristWorld(),
  modelPos: window.__t.modelPos(),
  camPos: window.__t.camPos(),
}));
const rotResult = await page.evaluate(() => window.__t.rotateBone("rightUpperArm", [0.6, 0, 0.4]));
console.log("  旋转方式:", JSON.stringify(rotResult), "before euler:", JSON.stringify(rotBefore.euler));
await page.waitForTimeout(600);
const rotAfter = await page.evaluate(() => ({
  euler: window.__t.readBoneEuler("rightUpperArm"),
  wrist: window.__t.wristWorld(),
  modelPos: window.__t.modelPos(),
  camPos: window.__t.camPos(),
}));
const eulerChanged = rotBefore.euler && rotAfter.euler &&
  Math.hypot(rotAfter.euler[0] - rotBefore.euler[0], rotAfter.euler[1] - rotBefore.euler[1], rotAfter.euler[2] - rotBefore.euler[2]) > 0.05;
const wristDelta = d3(rotAfter.wrist, rotBefore.wrist);
const modelDelta = d3(rotAfter.modelPos, rotBefore.modelPos);
const camDelta = d3(rotAfter.camPos, rotBefore.camPos);
console.log("  旋转结果:", JSON.stringify({ eulerChanged, wristDelta, modelDelta, camDelta }));
if (!rotResult.ok && !eulerChanged) {
  check("契约5a 三维旋转 rightUpperArm（rotation 变化）", false,
    "boneEditor 无 rotateBone/setBoneRotation/setRotation API，且屏幕节点无 bone 引用可回退 — 契约未实现（接口假设 C）");
} else {
  check("契约5a 三维旋转 rightUpperArm（rotation 变化）", !!eulerChanged,
    `via=${rotResult.via} Δeuler=${rotBefore.euler && rotAfter.euler ? Math.hypot(rotAfter.euler[0] - rotBefore.euler[0], rotAfter.euler[1] - rotBefore.euler[1], rotAfter.euler[2] - rotBefore.euler[2]).toFixed(3) : "n/a"}`);
}
check("契约5b 手腕世界坐标/openpose 数据源位移 > 0.05", wristDelta !== null && wristDelta > 0.05,
  `Δwrist=${wristDelta?.toFixed?.(3)}${wristDelta !== null && wristDelta <= 0.05 ? " — 骨骼旋转未带动手腕：骨骼层级联动未实现" : ""}`);
check("契约5c 模型整体 position 不变（骨骼编辑 ≠ 身体拖动）", modelDelta !== null && modelDelta < 0.02,
  `Δmodel=${modelDelta?.toFixed?.(4)}`);
check("契约5d 相机不动", camDelta !== null && camDelta < 0.01, `Δcam=${camDelta?.toFixed?.(4)}`);

// ================= 契约 6：IK 分离（旋转姿势在模式切换后保持） =================
mark("contract6-ik-separation");
const poseAfterRotate = rotAfter.euler;
const ikTargetInfo = await page.evaluate(() => {
  const entry = window.__ds?.externalCharacters?.getActive?.() || window.__ds?.externalCharacters?.getAll?.()?.[0];
  const t = entry?.ikTargets?.rightArm?.target;
  if (!t) return null;
  const v = new t.position.constructor();
  t.getWorldPosition(v);
  return v.toArray();
});
// 切回 IK 模式
const ikBtn = await page.evaluate(() => {
  const el = document.querySelector('[data-edit-mode="ik"]');
  if (!el) return false;
  el.click();
  return true;
});
await page.waitForTimeout(800);
const ikRefresh = await page.evaluate(() => {
  const entry = window.__ds?.externalCharacters?.getActive?.() || window.__ds?.externalCharacters?.getAll?.()?.[0];
  const t = entry?.ikTargets?.rightArm?.target;
  if (!t) return { target: null, wrist: window.__t.wristWorld() };
  const v = new t.position.constructor();
  t.getWorldPosition(v);
  return { target: v.toArray(), wrist: window.__t.wristWorld(), mode: window.__t.editMode() };
});
const targetWristDist = d3(ikRefresh.target, ikRefresh.wrist);
console.log("  IK 刷新: target↔wrist =", targetWristDist?.toFixed?.(3), "mode=", ikRefresh.mode);
check("契约6a 存在 [data-edit-mode=\"ik\"] 并可切回", ikBtn, ikBtn ? "" : "契约未实现：缺少 IK 模式切换控件（接口假设 A）");
check("契约6b 切回 IK 后 target 刷新到当前手腕附近（距离 < 0.15）",
  ikBtn && targetWristDist !== null && targetWristDist < 0.15,
  `dist=${targetWristDist?.toFixed?.(3)}${ikBtn && targetWristDist !== null && targetWristDist >= 0.15 ? " — IK target 停留在旧位置，未随骨骼旋转刷新（接口假设 A：模式切换时同步 IK target ← 骨骼）" : ""}`);
// 切回 bone 模式，姿势不重置
await page.evaluate(() => document.querySelector('[data-edit-mode="bone"]')?.click());
await page.waitForTimeout(600);
const poseBackBone = await page.evaluate(() => window.__t.readBoneEuler("rightUpperArm"));
const poseDrift = poseAfterRotate && poseBackBone
  ? Math.hypot(poseBackBone[0] - poseAfterRotate[0], poseBackBone[1] - poseAfterRotate[1], poseBackBone[2] - poseAfterRotate[2])
  : null;
check("契约6c 切回 bone 模式后骨骼姿势不重置（漂移 < 0.05 rad）",
  poseDrift !== null && poseDrift < 0.05,
  poseDrift === null
    ? "无法对比：契约5 未产生有效旋转（前置失败，随核心实现后自动恢复）"
    : `drift=${poseDrift?.toFixed?.(4)} rad`);

// 重新选中 rightUpperArm（模式切换可能清掉选择；供契约 8 使用）
await page.evaluate(() => {
  const node = (window.__ds_boneNodeScreen || []).find((e) => (e.name ?? e.boneName) === "rightUpperArm" && !e.behind);
  const canvas = [...document.querySelectorAll("#viewport canvas")].pop();
  if (node && canvas) {
    const r = canvas.getBoundingClientRect();
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      canvas.dispatchEvent(new MouseEvent(type, { clientX: r.left + node.x, clientY: r.top + node.y, bubbles: true }));
    }
  }
  window.__ds?.boneEditor?.selectBone?.("rightUpperArm");
});
await page.waitForTimeout(300);

// ================= 契约 7：Root/Hips 平移（默认 allowTranslate） =================
mark("contract7-hips-translate");
const hipsAllow = await page.evaluate(() => window.__t.allowTranslate("hips"));
const armAllowBefore = await page.evaluate(() => window.__t.allowTranslate("rightUpperArm"));
console.log("  allowTranslate: hips=", hipsAllow, "rightUpperArm=", armAllowBefore);
check("契约7a 默认 hips allowTranslate=true", hipsAllow === true,
  `hips=${hipsAllow}${hipsAllow === null ? " — 无法读取 allowTranslate（接口假设 C：getState().bones[name].allowTranslate 或 isTranslateAllowed(name)）" : ""}`);
check("契约7c 高级模式关闭时 rightUpperArm allowTranslate=false", armAllowBefore === false,
  `rightUpperArm=${armAllowBefore}${armAllowBefore === null ? " — 无法读取（同上接口假设）" : ""}`);

const hipsBefore = await page.evaluate(() => ({
  world: window.__t.boneWorld("hips"),
  euler: window.__t.readBoneEuler("hips"),
}));
const hipsMove = await page.evaluate(() => window.__t.translateBone("hips", [0, 0.12, 0]));
await page.waitForTimeout(500);
const hipsAfter = await page.evaluate(() => ({ world: window.__t.boneWorld("hips") }));
const hipsDy = hipsBefore.world && hipsAfter.world ? hipsAfter.world[1] - hipsBefore.world[1] : null;
console.log("  hips 平移:", JSON.stringify({ via: hipsMove.via, hipsDy }));
check("契约7b 平移 hips：Y 位移 > 0.05", hipsDy !== null && hipsDy > 0.05,
  `via=${hipsMove.via} dy=${hipsDy?.toFixed?.(4)}${!hipsMove.ok ? " — boneEditor 无 translateBone/setBonePosition API 且屏幕节点无 bone 引用（接口假设 C）" : ""}`);

// ================= 契约 8：高级模式 → rightUpperArm 可平移 =================
mark("contract8-advanced-translate");
const advToggle = await page.evaluate(() => {
  const el = document.querySelector("[data-advanced-bone-translate]");
  if (!el) return { ok: false, reason: "页面无 [data-advanced-bone-translate] 控件" };
  if (el.type === "checkbox") { if (!el.checked) el.click(); }
  else el.click();
  return { ok: true, checked: el.type === "checkbox" ? el.checked : null };
});
check("契约8a 找到并打开 [data-advanced-bone-translate]", advToggle.ok,
  advToggle.ok ? "" : `${advToggle.reason} — 契约未实现（接口假设 F）`);
await page.waitForTimeout(400);
const armAllowAfter = await page.evaluate(() => window.__t.allowTranslate("rightUpperArm"));
check("契约8b 高级模式开启后 rightUpperArm allowTranslate=true", advToggle.ok && armAllowAfter === true,
  `rightUpperArm=${armAllowAfter}`);
// 平移选中的 rightUpperArm
const armPosBefore = await page.evaluate(() => window.__t.boneWorld("rightUpperArm"));
const armMove = await page.evaluate(() => window.__t.translateBone("rightUpperArm", [0, 0.08, 0]));
await page.waitForTimeout(400);
const armPosAfter = await page.evaluate(() => window.__t.boneWorld("rightUpperArm"));
const armDy = armPosBefore && armPosAfter ? armPosAfter[1] - armPosBefore[1] : null;
check("契约8c 高级模式下可平移 selected bone（rightUpperArm Y 位移 > 0.03）",
  advToggle.ok && armDy !== null && armDy > 0.03,
  `via=${armMove.via} dy=${armDy?.toFixed?.(4)}`);

// 契约 10 需要「apply 后恢复到保存姿态」：先把 rightUpperArm 恢复为纯旋转姿势
// （保存前记录当前姿态即保存值；apply 对比的也是它，无需恢复）
// 但为避免平移污染姿态对比，记录保存值以 getState 为准（契约 9 之后立刻读取）。

// ================= 契约 9：保存姿态「E2E姿态」 =================
mark("contract9-save-pose");
const POSE_NAME = "E2E姿态";
const saveBtn = await page.evaluate(() => {
  const el = document.querySelector("[data-save-pose]");
  if (!el) return { ok: false, reason: "页面无 [data-save-pose] 控件" };
  el.click();
  return { ok: true };
});
await page.waitForTimeout(600);
// 若非 prompt 而是输入框 UI，则填名并确认
await page.evaluate((name) => {
  const input = document.querySelector("[data-pose-name-input]") ||
    [...document.querySelectorAll("input")].find((i) => i.offsetParent !== null && /姿态|pose|名称|name/i.test(i.placeholder || ""));
  if (input && !input.value) {
    input.value = name;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  const confirm = document.querySelector("[data-pose-save-confirm]") ||
    [...document.querySelectorAll("button")].find((b) => b.offsetParent !== null && /^(确定|保存|OK)$/i.test(b.textContent.trim()));
  confirm?.click();
}, POSE_NAME);
await page.waitForTimeout(600);
const poseSaved = await page.evaluate((name) => {
  const pp = window.__ds?.posePresets;
  if (!pp?.list) return { ok: false, reason: "__ds.posePresets.list 不存在（接口假设 D）" };
  const list = pp.list() || [];
  const names = list.map((p) => (typeof p === "string" ? p : p?.name));
  const entry = list.find((p) => (typeof p === "string" ? p : p?.name) === name);
  const bones = entry && typeof entry === "object"
    ? (Array.isArray(entry.bones) ? entry.bones : (entry.bones ? Object.keys(entry.bones) : null))
    : (pp.get ? Object.keys(pp.get(name)?.bones || {}) : null);
  return { ok: names.includes(name), names, bones };
}, POSE_NAME);
console.log("  姿态列表:", JSON.stringify(poseSaved.names), "bones:", JSON.stringify(poseSaved.bones?.slice?.(0, 12)));
check("契约9a 点击 [data-save-pose] 可保存姿态", saveBtn.ok && poseSaved.ok,
  saveBtn.ok ? (poseSaved.ok ? "" : poseSaved.reason || `list() 不含「${POSE_NAME}」：${JSON.stringify(poseSaved.names)}`)
    : `${saveBtn.reason} — 契约未实现（接口假设 E）`);
check("契约9b 姿态 bones 至少包含 rightUpperArm",
  !!(poseSaved.bones && poseSaved.bones.includes("rightUpperArm")),
  `bones=${JSON.stringify(poseSaved.bones)}`);

// 保存值（对比基准）：保存姿态后立即读 rightUpperArm rotation
const savedEuler = await page.evaluate(() => window.__t.readBoneEuler("rightUpperArm"));
console.log("  保存基准 euler:", JSON.stringify(savedEuler));

// ================= 契约 10：改变姿势后 apply 恢复 =================
mark("contract10-apply-pose");
await page.evaluate(() => window.__t.rotateBone("rightUpperArm", [0.9, 0.3, 0]));
await page.waitForTimeout(400);
const disturbedEuler = await page.evaluate(() => window.__t.readBoneEuler("rightUpperArm"));
const disturbDelta = savedEuler && disturbedEuler
  ? Math.hypot(disturbedEuler[0] - savedEuler[0], disturbedEuler[1] - savedEuler[1], disturbedEuler[2] - savedEuler[2])
  : null;
console.log("  扰动后 Δeuler=", disturbDelta?.toFixed?.(3));
// apply：API 优先，UI 回退
const applied = await page.evaluate((name) => {
  const pp = window.__ds?.posePresets;
  if (pp?.apply) { pp.apply(name); return { ok: true, via: "posePresets.apply" }; }
  const item = document.querySelector(`[data-apply-pose="${name}"]`) ||
    [...document.querySelectorAll("[data-pose-name]")].find((e) => e.dataset.poseName === name);
  if (item) { item.click(); return { ok: true, via: "ui" }; }
  return { ok: false, via: null };
}, POSE_NAME);
await page.waitForTimeout(600);
const appliedEuler = await page.evaluate(() => window.__t.readBoneEuler("rightUpperArm"));
const applyErr = savedEuler && appliedEuler
  ? Math.hypot(appliedEuler[0] - savedEuler[0], appliedEuler[1] - savedEuler[1], appliedEuler[2] - savedEuler[2])
  : null;
console.log("  apply:", JSON.stringify(applied), "误差=", applyErr?.toFixed?.(4), "rad");
check("契约10a apply 姿态接口可用", applied.ok, applied.ok ? `via=${applied.via}` : "posePresets.apply 不存在且无 UI 回退（接口假设 D）");
check("契约10b apply 后 rightUpperArm rotation 恢复到保存值附近（误差 < 0.05 rad）",
  applyErr !== null && applyErr < 0.05,
  `err=${applyErr?.toFixed?.(4)} rad（=${applyErr !== null ? (applyErr * 180 / Math.PI).toFixed(1) : "?"}°）`);

// ================= 契约 11：sceneJSON 含 posePresets；reload + init 后仍可用 =================
mark("contract11-scenejson-reload");
const snap11 = await page.evaluate(() => {
  const raw = window.__ds.getSceneJSON?.() ?? null;
  return { sceneGz: window.__ds.encodeSceneGz?.() ?? null, sceneJSON: raw };
});
const snapJson11 = snap11.sceneJSON
  ? (typeof snap11.sceneJSON === "string" ? JSON.parse(snap11.sceneJSON) : snap11.sceneJSON)
  : null;
const hasPoseField = !!(snapJson11 && snapJson11.posePresets &&
  (Array.isArray(snapJson11.posePresets) ? snapJson11.posePresets.length > 0 : Object.keys(snapJson11.posePresets).length > 0));
check("契约11a sceneJSON 包含 posePresets", hasPoseField,
  hasPoseField ? "" : `keys=${snapJson11 ? Object.keys(snapJson11).join(",") : "(sceneJSON 为空)"} — 契约未实现（接口假设 G）`);

await page.reload();
await page.waitForFunction(() => !!window.__ds, null, { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(1500);
await page.evaluate(({ sceneGz, sceneJSON }) => {
  window.postMessage({
    type: "init",
    payload: { width: 1024, height: 1024, sceneGz, sceneJSON: JSON.stringify(sceneJSON) },
  }, window.location.origin);
}, snap11);
await page.waitForFunction(
  () => (window.__ds?.externalCharacters?.getAll?.().length ?? 0) >= 1,
  null, { timeout: 30000 }
).catch(() => {});
await page.waitForTimeout(1500);
// reload 后重新注入辅助函数
await page.evaluate(() => {
  window.__t = {
    readBoneEuler(name) {
      const be = window.__ds?.boneEditor;
      if (!be) return null;
      if (be.getBoneRotation) { const r = be.getBoneRotation(name); if (r) return [...r]; }
      const r2 = be.getState?.()?.bones?.[name]?.rotation;
      if (Array.isArray(r2)) return [...r2];
      const node = (window.__ds_boneNodeScreen || []).find((e) => (e.name ?? e.boneName) === name);
      const bone = node?.bone || node?.obj || null;
      return bone?.rotation ? [bone.rotation.x, bone.rotation.y, bone.rotation.z] : null;
    },
  };
});
const restoredPose = await page.evaluate((name) => {
  const pp = window.__ds?.posePresets;
  const list = pp?.list?.() || [];
  const names = list.map((p) => (typeof p === "string" ? p : p?.name));
  return { names, has: names.includes(name) };
}, POSE_NAME);
check("契约11b reload + init 后姿态仍在 list()", restoredPose.has,
  `list=${JSON.stringify(restoredPose.names)}`);
// apply 仍可用：先记录 apply 前 euler，apply 后应向保存值收敛
const preApply = await page.evaluate(() => window.__t.readBoneEuler("rightUpperArm"));
const applyAfterReload = await page.evaluate((name) => {
  const pp = window.__ds?.posePresets;
  if (pp?.apply) { pp.apply(name); return true; }
  return false;
}, POSE_NAME);
await page.waitForTimeout(600);
const postApply = await page.evaluate(() => window.__t.readBoneEuler("rightUpperArm"));
const applyErr2 = savedEuler && postApply
  ? Math.hypot(postApply[0] - savedEuler[0], postApply[1] - savedEuler[1], postApply[2] - savedEuler[2])
  : null;
const preApplyErr = savedEuler && preApply
  ? Math.hypot(preApply[0] - savedEuler[0], preApply[1] - savedEuler[1], preApply[2] - savedEuler[2])
  : null;
console.log("  reload 后 apply: preErr=", preApplyErr?.toFixed?.(4), "postErr=", applyErr2?.toFixed?.(4));
check("契约11c reload 后 apply 仍可用（恢复到保存值附近 < 0.05 rad）",
  applyAfterReload && applyErr2 !== null && applyErr2 < 0.05,
  `applyCalled=${applyAfterReload} err=${applyErr2?.toFixed?.(4)}`);

// ================= 契约 12：多角色 — 姿态只影响活动角色 =================
mark("contract12-multi-char");
// 确保骨骼编辑模式（reload 后可能回到默认模式；apply 不依赖模式则不影响）
await page.evaluate(() => document.querySelector('[data-edit-mode="bone"]')?.click());
await page.waitForTimeout(400);
const added2 = await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent.includes("添加3D角色") || b.textContent.includes("添加GLB")));
  if (!btn) return false;
  btn.click();
  return true;
});
// P7：按钮弹出模型选择器，需再选一个模型才真正加载
if (added2) {
  const appeared = await page.waitForSelector("#model-picker-menu", { timeout: 5000 }).then(() => true).catch(() => false);
  if (appeared) await page.evaluate(() => {
    const menu = document.getElementById("model-picker-menu");
    const rows = menu ? [...menu.children].slice(1) : [];
    if (rows.length) rows[0].click();
  });
}
const twoChars = added2 && await page.waitForFunction(
  () => window.__ds?.externalCharacters?.getAll?.().length >= 2,
  null, { timeout: 25000 }
).then(() => true).catch(() => false);
check("契约12a 添加第 2 个 GLB 角色成功", twoChars,
  twoChars ? "" : (added2 ? "25s 内未达到 2 个角色" : "未找到「添加GLB」按钮"));
if (twoChars) {
  // 活动角色应为新添加的第 2 个；记录两个角色的 rightUpperArm euler
  const readEulerFor = async (idx) => page.evaluate((i) => {
    // 多角色下 boneEditor 作用于活动角色；非活动角色通过 jointMap 骨骼近似读取
    const entries = window.__ds?.externalCharacters?.getAll?.() || [];
    const entry = entries[i];
    if (!entry) { window.__t12cDiag = { idx: i, entryExists: false }; return null; }
    const activeId = window.__ds?.externalCharacters?.activeCharacterId;
    if (entry.id === activeId) return window.__t.readBoneEuler("rightUpperArm");
    // 非活动角色：优先 jointMap（COCO 2 = rightUpperArm，对任意骨架命名均适用）。
    // 原探针只按规范名/UE 名遍历 skeleton，Mixamo 命名（"RightArm"）不含
    // "rightupperarm"/"upperarmr" → 取不到 bone → Δchar1=undefined（探针盲区，非真实回归）。
    let bone = entry.jointMap?.get?.(2) || null;
    let via = bone ? "jointMap[2]" : null;
    if (!bone) {
      entry.model?.traverse?.((o) => {
        if (bone || !o.isBone) return;
        const n = (o.name || "").toLowerCase().replace(/[_\s-]/g, "");
        if (n.includes("rightupperarm") || n === "upperarmr" || n.includes("upperarmr") || n.includes("rightarm")) bone = o;
      });
      via = bone ? "name-traverse" : null;
    }
    // 12c 诊断：记录读取路径；失败时记录现场（entry/model/jointMap/骨骼名样本）以区分探针盲区 vs 真实回归
    if (!bone) {
      const names = [];
      entry.model?.traverse?.((o) => { if (o.isBone && names.length < 12) names.push(o.name); });
      window.__t12cDiag = {
        idx: i, entryExists: true, modelExists: !!entry.model, jointMapExists: !!entry.jointMap,
        jointMapKeys: entry.jointMap ? [...entry.jointMap.keys()].slice(0, 24) : null,
        sampleBones: names,
      };
      return null;
    }
    window.__t12cDiag = { idx: i, via, boneName: bone.name };
    return bone.rotation ? [bone.rotation.x, bone.rotation.y, bone.rotation.z] : null;
  }, idx);
  // 把活动切回第 1 个角色，验证 apply 只改它（第 1 个是姿态保存来源）
  await page.evaluate(() => {
    const mgr = window.__ds?.externalCharacters;
    const first = mgr?.getAll?.()?.[0];
    if (first && mgr.setActive) mgr.setActive(first.id);
  });
  await page.waitForTimeout(400);
  const char0Before = await readEulerFor(0);
  const char1Before = await readEulerFor(1);
  await page.evaluate((name) => window.__ds?.posePresets?.apply?.(name), POSE_NAME);
  await page.waitForTimeout(600);
  const char0After = await readEulerFor(0);
  const char1After = await readEulerFor(1);
  const dChar0 = char0Before && char0After
    ? Math.hypot(char0After[0] - char0Before[0], char0After[1] - char0Before[1], char0After[2] - char0Before[2]) : null;
  const dChar1 = char1Before && char1After
    ? Math.hypot(char1After[0] - char1Before[0], char1After[1] - char1Before[1], char1After[2] - char1Before[2]) : null;
  console.log("  多角色 apply: Δchar0=", dChar0?.toFixed?.(4), "Δchar1=", dChar1?.toFixed?.(4));
  const t12cDiag = await page.evaluate(() => window.__t12cDiag || null);
  if (t12cDiag) console.log("  12c 探针诊断:", JSON.stringify(t12cDiag));
  check("契约12b apply 姿态影响活动角色（char0 rotation 收敛到保存值）",
    char0After !== null && savedEuler !== null &&
    Math.hypot(char0After[0] - savedEuler[0], char0After[1] - savedEuler[1], char0After[2] - savedEuler[2]) < 0.05,
    `ΔvsSaved=${char0After && savedEuler ? Math.hypot(char0After[0] - savedEuler[0], char0After[1] - savedEuler[1], char0After[2] - savedEuler[2]).toFixed(4) : "n/a"}`);
  check("契约12c apply 不影响另一个角色（char1 rotation 不变）",
    dChar1 !== null && dChar1 < 0.01,
    `Δchar1=${dChar1?.toFixed?.(4)}${dChar1 !== null && dChar1 >= 0.01 ? " — 姿态应用泄漏到非活动角色（接口假设 D：apply 应只作用于 activeCharacter）" : ""}`);
} else {
  checkSkip("契约12b apply 姿态影响活动角色", "第 2 个角色未就绪");
  checkSkip("契约12c apply 不影响另一个角色", "第 2 个角色未就绪");
}

// ================= 契约 13：openpose/mask 导出仍只含外部角色 =================
mark("contract13-export");
let exportResult = null, exportErr = null;
try {
  exportResult = await page.evaluate(() => window.__ds.performBatchExport(["openpose", "mask"]));
} catch (e) {
  exportErr = e?.message || String(e);
}
const extIds = await page.evaluate(() =>
  (window.__ds?.externalCharacters?.getAll?.() || []).map((e) => e.id));
const maskIds13 = (exportResult?.manifest?.masks || []).map((m) => m.charId);
const alien13 = maskIds13.filter((id) => !extIds.includes(id));
check("契约13a performBatchExport(['openpose','mask']) 成功返回", !!exportResult && !exportErr,
  exportErr || `cameras=${exportResult?.manifest?.cameras?.length} masks=${maskIds13.length}`);
check("契约13b manifest.masks 只含外部 3D角色 charId（无火柴人混入）",
  maskIds13.length > 0 && alien13.length === 0,
  `masks=[${maskIds13.join(",")}] external=[${extIds.join(",")}]${alien13.length ? " 混入=" + alien13.join(",") : ""}`);

// ================= 契约 14：截图 + JS 错误 =================
mark("contract14-screenshot");
await page.evaluate(() => document.querySelector('[data-edit-mode="bone"]')?.click());
await page.waitForTimeout(400);
fs.mkdirSync(path.join(__dirname, "out"), { recursive: true });
await page.screenshot({ path: path.join(__dirname, "out", "bone-editor.png") });
console.log("截图: test/out/bone-editor.png");
check("契约14b 页面无 JS 错误", errors.length === 0, errors.slice(0, 3).join(" | ") || "无");

console.log(`\n结果: ${pass} 通过 / ${fail} 失败 / ${skip} 跳过`);
await browser.close();
server.close();
process.exit(fail === 0 ? 0 : 1);
