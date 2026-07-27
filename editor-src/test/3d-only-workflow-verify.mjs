/** 3d-only-workflow-verify.mjs — P3-1 「只保留 3D角色」工作流总验收
 *
 * 本脚本只写测试，不改核心源码。核心未实现的契约点会失败并在输出中明确报告缺什么。
 *
 * 验收契约：
 *  1) 静态服务器映射 /director_stage/models/*.glb → assets/models（本脚本自带映射并验证可达）
 *  2) 默认启动后【不点任何按钮】没有可见火柴人：figureGroup 不存在或 visible=false；
 *     且火柴人完全不可交互（拾取缓存 __ds_jointScreen 无 userData.isJoint 对象）
 *  3) 默认存在至少 1 个 3D角色：externalCharacters.getAll().length >= 1，
 *     model 可见，characterMode !== 'stick'
 *  4) 用户可见 UI 中没有「火柴人」「主角」「姿势库」「切换火柴人」入口
 *     （扫描可见元素的文本/title/aria-label；允许底层兼容代码存在，只查 UI 层）
 *  5) 点击身体拖动整个 3D角色：
 *       a) 默认拖：沿地面 X/Z 移动，Y 不变，相机不跟着动
 *       b) Alt 拖：只沿 Y 升降，X/Z 不变
 *       c) 同步：model / IK target / SkeletonHelper / openpose 数据源（jointMap 骨骼）
 *          全部平移相同 delta
 *  6) 连续添加第 2/3 个 3D角色成功：自动错位（两两间距 > 0.3m）、自动激活新角色
 *  7) IK 球拖拽仍可用：拖活动角色 rightArm target，target 与腕骨骼同步移动
 *  8) sceneJSON 保存 3 个角色，reload + init 后恢复（数量/可见性/位置）
 *  9) 截图 test/out/3d-only-workflow.png；页面无 JS 错误
 *
 * ── 对核心 Agent 的接口要求（本测试按以下形状探测，均做容错读取）──────────
 *  A. 自动加载：fresh init（无 sceneJSON）时自动加载默认 GLB 并进入 3D角色模式
 *     （__ds.externalCharacters.getAll().length >= 1 且 __ds.characterMode !== 'stick'）。
 *  B. 火柴人退场：figureGroup 从 scene 移除或 visible=false 且不参与拾取；
 *     UI 移除火柴人角色管理面板、姿势库面板、切回火柴人按钮（含按钮 title 提示文案）。
 *  C. 身体整体拖动（新交互）：pointerdown 命中外部角色 model 网格（非 IK 球）时，
 *     拖动平移整个 entry —— model.position 与 ikTargetsGroup 同步平移；
 *     默认在地面 X/Z 平面（与道具拖拽一致），按住 Alt 时屏幕纵向映射为 Y 升降。
 *     IK target 世界坐标、jointMap 骨骼世界坐标、SkeletonHelper 顶点必须随动。
 *     推荐实现：参照 props.js 的 prop 拖拽（X/Z + Alt=Y），在 controls.js 的
 *     pickAt/pointerdown 中加入 model mesh 射线命中分支。
 *  D. 多角色：「添加GLB」按钮保留；新角色自动错位出生并 setActive(新 id)。
 *  E. sceneJSON：externalCharacters 数组序列化全部角色；init 恢复数量/位置/可见性，
 *     且恢复后不再触发默认角色自动加载（防止 3 → 4 重复添加）。
 *
 * 用法: node 3d-only-workflow-verify.mjs
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

// ---- 契约 1：静态服务器（自带 /director_stage/models 映射）----
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

const glbName = "michelle.glb";
const glbLocal = path.join(repoRoot, "assets/models", glbName);
const resp = await fetch(`http://127.0.0.1:${port}/director_stage/models/${glbName}`);
const body = await resp.arrayBuffer().catch(() => new ArrayBuffer(0));
check("契约1 静态映射 /director_stage/models/*.glb → assets/models",
  resp.ok && fs.existsSync(glbLocal) && body.byteLength > 0,
  `HTTP ${resp.status}, body=${body.byteLength}B`);

const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch({ channel: "chrome" }));
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());
await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => !!window.__ds, null, { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(1500);

// ================= 契约 2/3：默认启动 = 3D-only（不点按钮） =================
const autoLoaded = await page.waitForFunction(
  () => (window.__ds?.externalCharacters?.getAll?.().length ?? 0) >= 1,
  null, { timeout: 25000 }
).then(() => true).catch(() => false);
check("契约3a 默认启动后存在至少 1 个 3D角色（无需点按钮）", autoLoaded,
  autoLoaded ? "" : "25s 内 externalCharacters 为空 — 契约未实现：核心需在 fresh init 时自动加载默认 GLB（接口要求 A）");

const boot = await page.evaluate(() => {
  const mgr = window.__ds?.externalCharacters;
  const entries = mgr?.getAll?.() || [];
  const first = entries[0] || null;
  const cache = window.__ds_jointScreen || [];
  return {
    count: entries.length,
    mode: window.__ds?.characterMode ?? null,
    figureExists: !!window.__ds?.figureGroup,
    figureVisible: window.__ds?.figureGroup?.visible ?? null,
    modelVisible: first?.model?.visible ?? null,
    ikGroupVisible: first?.ikTargetsGroup?.visible ?? null,
    stickJointCache: cache.filter((e) => e.obj?.userData?.isJoint).length,
    targetCache: cache.filter((e) => e.obj?.userData?.ikType === "target").length,
  };
});
console.log("  启动状态:", JSON.stringify(boot));
check("契约3b 默认处于 3D角色模式（characterMode !== 'stick'）",
  boot.mode !== null && boot.mode !== "stick",
  `mode=${boot.mode}`);
check("契约2a 默认无可见火柴人（figureGroup 不存在或隐藏）",
  !boot.figureExists || boot.figureVisible === false,
  (!boot.figureExists || boot.figureVisible === false)
    ? `exists=${boot.figureExists} visible=${boot.figureVisible}`
    : `exists=${boot.figureExists} visible=${boot.figureVisible} — 契约未实现：3D-only 下火柴人必须退场（接口要求 B）`);
check("契约2b 火柴人完全不可交互（拾取缓存无 isJoint 对象）",
  boot.stickJointCache === 0,
  `stickJoints=${boot.stickJointCache}`);
check("契约3c 默认 3D角色 model 可见", boot.modelVisible === true, `modelVisible=${boot.modelVisible}`);
check("契约3d 拾取缓存含 3D角色 IK target（>=4）", boot.targetCache >= 4, `targets=${boot.targetCache}`);

// ================= 契约 4：可见 UI 无火柴人/主角/姿势库/切换火柴人入口 =================
const uiHits = await page.evaluate(() => {
  const banned = ["火柴人", "主角", "姿势库", "切换火柴人"];
  const hits = [];
  const seen = new Set();
  for (const el of document.querySelectorAll("body *")) {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    // 叶子文本 + 交互元素的 title/aria-label（tooltip 也是用户可见文案）
    const ownText = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();
    const candidates = [];
    if (ownText) candidates.push(ownText);
    const title = el.getAttribute("title");
    if (title) candidates.push(`[title] ${title}`);
    const aria = el.getAttribute("aria-label");
    if (aria) candidates.push(`[aria] ${aria}`);
    for (const txt of candidates) {
      for (const b of banned) {
        if (txt.includes(b)) {
          const key = `${el.tagName}|${txt.slice(0, 50)}|${b}`;
          if (!seen.has(key)) { seen.add(key); hits.push({ tag: el.tagName, text: txt.slice(0, 50), banned: b }); }
        }
      }
    }
  }
  return hits.slice(0, 20);
});
console.log("  禁用入口扫描:", uiHits.length ? JSON.stringify(uiHits) : "（无命中）");
check("契约4 可见 UI 无「火柴人/主角/姿势库/切换火柴人」入口", uiHits.length === 0,
  uiHits.length === 0 ? "" :
  `命中 ${uiHits.length} 处：${uiHits.map((h) => `${h.tag}<${h.banned}>"${h.text}"`).join("；")} — 契约未实现：核心需移除/隐藏这些 UI 入口（接口要求 B，底层兼容代码可保留）`);

const d3 = (p, q) => (p && q ? Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) : null);

// ================= 契约 7：IK 球拖拽仍可用 =================
// 注：执行顺序提前到契约 5 之前 —— 契约 5 在核心未实现时会误触发 orbit 旋转相机，
// 导致 IK 球投影点失效；IK 可用性与身体拖动是独立契约，先用干净相机验证。
await page.waitForTimeout(400); // 等拾取缓存刷新
const ikBefore = await page.evaluate(() => {
  const mgr = window.__ds?.externalCharacters;
  const entry = mgr?.getActive?.() || mgr?.getAll?.()?.[0];
  if (!entry?.ikTargets?.rightArm?.target) return { ok: false, reason: "活动角色无 rightArm target" };
  const target = entry.ikTargets.rightArm.target;
  const s = (window.__ds_jointScreen || []).find((e) => e.obj === target && !e.behind);
  if (!s) return { ok: false, reason: "活动角色 rightArm target 不在可见拾取缓存" };
  const C = target.position.constructor;
  const world = (o) => { const v = new C(); o.getWorldPosition(v); return v.toArray(); };
  const canvas = [...document.querySelectorAll("#viewport canvas")].pop();
  const r = canvas.getBoundingClientRect();
  return {
    ok: true,
    sx: r.left + s.x, sy: r.top + s.y,
    targetWorld: world(target),
    wristWorld: entry.jointMap?.get?.(4) ? world(entry.jointMap.get(4)) : null,
  };
});
if (ikBefore.ok) {
  await page.mouse.move(ikBefore.sx, ikBefore.sy);
  await page.mouse.down();
  await page.mouse.move(ikBefore.sx + 100, ikBefore.sy + 70, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const ikAfter = await page.evaluate(() => {
    const mgr = window.__ds.externalCharacters;
    const entry = mgr?.getActive?.() || mgr?.getAll?.()?.[0];
    const C = entry.ikTargets.rightArm.target.position.constructor;
    const world = (o) => { const v = new C(); o.getWorldPosition(v); return v.toArray(); };
    return {
      targetWorld: world(entry.ikTargets.rightArm.target),
      wristWorld: entry.jointMap?.get?.(4) ? world(entry.jointMap.get(4)) : null,
    };
  });
  const dT = d3(ikAfter.targetWorld, ikBefore.targetWorld);
  const dW = d3(ikAfter.wristWorld, ikBefore.wristWorld);
  console.log("  IK 拖拽 delta:", JSON.stringify({ dT, dW }));
  check("契约7a IK 球（rightArm target）拖拽生效", dT !== null && dT > 0.05, `Δtarget=${dT?.toFixed?.(3)}`);
  check("契约7b 腕骨骼跟随 IK 移动", dW !== null && dW > 0.03, `Δwrist=${dW?.toFixed?.(3)}`);
} else {
  check("契约7a IK 球（rightArm target）拖拽生效", false, ikBefore.reason);
  check("契约7b 腕骨骼跟随 IK 移动", false, "跳过");
}

// ================= 契约 5：点击身体拖动整个 3D角色 =================
// ---- 5.0 找身体屏幕点（避开 IK 球 24px） ----
async function findBodyPoint() {
  return page.evaluate(() => {
    const mgr = window.__ds?.externalCharacters;
    const entry = mgr?.getActive?.() || mgr?.getAll?.()[0];
    if (!entry?.model) return { ok: false, reason: "无外部角色 model" };
    const canvas = [...document.querySelectorAll("#viewport canvas")].pop();
    const r = canvas.getBoundingClientRect();
    const mover = window.__ds?.externalBodyMover;
    const balls = (window.__ds_jointScreen || []).map((s) => ({ x: s.x, y: s.y }));

    // 优先用核心移动器的 hit-proxy 做网格扫描：比固定取髋/颈/原点更稳，
    // 角色被拖近镜头后也能找到可命中的身体区域。
    if (mover) {
      for (let y = r.top + 12; y <= r.bottom - 12; y += 10) {
        for (let x = r.left + 12; x <= r.right - 12; x += 10) {
          const hit = mover.pick(x, y, canvas);
          if (!hit || hit.id !== entry.id) continue;
          const sx = x - r.left;
          const sy = y - r.top;
          const nearIK = balls.some((b) => Math.hypot(b.x - sx, b.y - sy) < 24);
          if (!nearIK) return { ok: true, sx: x, sy: y, via: "hit-proxy-grid" };
        }
      }
    }

    // 兜底：躯干中心（两髋中点）→ 颈 → 模型原点
    const cam = window.__ds.camera;
    const C = entry.model.position.constructor;
    const candidates = [];
    const hipR = entry.jointMap?.get?.(8), hipL = entry.jointMap?.get?.(11);
    if (hipR && hipL) {
      const a = new C(), b = new C();
      hipR.getWorldPosition(a); hipL.getWorldPosition(b);
      candidates.push(a.add(b).multiplyScalar(0.5));
    }
    const neck = entry.jointMap?.get?.(1);
    if (neck) { const v = new C(); neck.getWorldPosition(v); candidates.push(v); }
    candidates.push(entry.model.getWorldPosition(new C()));
    for (const w of candidates) {
      const v = w.clone().project(cam);
      if (v.z > 1 || v.z < -1) continue;
      const sx = (v.x + 1) / 2 * r.width, sy = (1 - v.y) / 2 * r.height;
      if (sx < 20 || sx > r.width - 20 || sy < 20 || sy > r.height - 20) continue;
      const near = balls.some((b) => Math.hypot(b.x - sx, b.y - sy) < 24);
      if (!near) return { ok: true, sx: r.left + sx, sy: r.top + sy, via: "bone-candidate" };
    }
    return { ok: false, reason: "找不到避开 IK 球的身体投影点" };
  });
}
let bodyPt = await findBodyPoint();
console.log("  身体点击点:", JSON.stringify(bodyPt));

/** 抓取角色整体状态快照（model/target/wrist/helper 顶点/相机） */
async function snapshotChar(label) {
  return page.evaluate(() => {
    const mgr = window.__ds?.externalCharacters;
    const entry = mgr?.getActive?.() || mgr?.getAll?.()[0];
    if (!entry) return null;
    const C = entry.model.position.constructor;
    const world = (o) => { const v = new C(); o.getWorldPosition(v); return v.toArray(); };
    // SkeletonHelper 顶点采样（entry 挂载或 scene 遍历）
    let helper = entry.skeletonHelper || null;
    if (!helper) {
      window.__ds.scene?.traverse?.((o) => {
        if (!helper && (o.isSkeletonHelper || o.type === "SkeletonHelper")) helper = o;
      });
    }
    let helperPts = null;
    if (helper?.geometry) {
      const pos = helper.geometry.getAttribute("position");
      if (pos && pos.count > 0) {
        helperPts = [];
        const v = new C();
        for (let i = 0; i < Math.min(6, pos.count); i++) {
          v.fromBufferAttribute(pos, i);
          helper.localToWorld(v);
          helperPts.push(v.toArray());
        }
      }
    }
    return {
      modelPos: entry.model.position.toArray(),
      modelWorld: world(entry.model),
      targetWorld: entry.ikTargets?.rightArm?.target ? world(entry.ikTargets.rightArm.target) : null,
      wristWorld: entry.jointMap?.get?.(4) ? world(entry.jointMap.get(4)) : null,
      helperPts,
      camPos: window.__ds.camera.position.toArray(),
    };
  });
}
if (!bodyPt.ok) {
  check("契约5 点击身体拖动整个 3D角色", false, `跳过：${bodyPt.reason}`);
} else {
  // ---- 5a：默认拖 → X/Z 移动，Y 不变 ----
  const before = await snapshotChar();
  await page.mouse.move(bodyPt.sx, bodyPt.sy);
  await page.mouse.down();
  await page.mouse.move(bodyPt.sx + 140, bodyPt.sy + 70, { steps: 14 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const after = await snapshotChar();

  const dModel = before && after ? {
    x: after.modelPos[0] - before.modelPos[0],
    y: after.modelPos[1] - before.modelPos[1],
    z: after.modelPos[2] - before.modelPos[2],
  } : null;
  const camMoved = before && after ? d3(before.camPos, after.camPos) : null;
  console.log("  默认拖 model delta:", JSON.stringify(dModel), "camMoved=", camMoved);

  const xzMoved = dModel && (Math.abs(dModel.x) + Math.abs(dModel.z)) > 0.05;
  check("契约5a 默认拖身体：整个 3D角色沿地面 X/Z 移动", !!xzMoved,
    xzMoved ? `dx=${dModel.x.toFixed(3)} dz=${dModel.z.toFixed(3)}`
      : `dx=${dModel?.x?.toFixed?.(4)} dz=${dModel?.z?.toFixed?.(4)} camMoved=${camMoved?.toFixed?.(4)} — 契约未实现：点击身体整体拖动（接口要求 C：model mesh 命中 → 平移 entry，默认 X/Z 平面，参照 props.js 道具拖拽）`);
  check("契约5a2 默认拖：Y 高度不变", dModel && Math.abs(dModel.y) < 0.02, `dy=${dModel?.y?.toFixed?.(4)}`);
  check("契约5a3 默认拖：相机不跟着动", camMoved !== null && camMoved < 0.01, `cam=${camMoved?.toFixed?.(4)}（命中失败时相机会被 orbit 旋转，此项一并验证命中的是身体而非空白）`);

  // ---- 5c：同步性（target / wrist 骨骼 / SkeletonHelper 顶点 与 model 同 delta） ----
  const dTarget = before && after ? d3(before.targetWorld, after.targetWorld) : null;
  const dWrist = before && after ? d3(before.wristWorld, after.wristWorld) : null;
  const dModelWorld = before && after ? d3(before.modelWorld, after.modelWorld) : null;
  let dHelper = null;
  if (before?.helperPts && after?.helperPts) {
    dHelper = Math.max(...before.helperPts.map((p, i) => d3(p, after.helperPts[i])));
  }
  console.log("  同步 delta:", JSON.stringify({ dModelWorld, dTarget, dWrist, dHelper }));
  const syncTol = 0.05;
  const targetSynced = xzMoved && dTarget !== null && Math.abs(dTarget - dModelWorld) < syncTol;
  check("契约5c1 IK target 随角色同步移动（|Δtarget - Δmodel| < 0.05）",
    targetSynced,
    dTarget === null ? "跳过：无 target 数据"
      : `Δtarget=${dTarget?.toFixed?.(3)} Δmodel=${dModelWorld?.toFixed?.(3)}${targetSynced ? "" : " — IK target 未同步（接口要求 C：ikTargetsGroup 同步平移）"}`);
  check("契约5c2 openpose 数据源（jointMap 腕骨骼）同步移动",
    xzMoved && dWrist !== null && Math.abs(dWrist - dModelWorld) < syncTol,
    dWrist === null ? "跳过：无 jointMap 数据" : `Δwrist=${dWrist?.toFixed?.(3)} Δmodel=${dModelWorld?.toFixed?.(3)}`);
  check("契约5c3 SkeletonHelper 顶点同步移动",
    xzMoved && dHelper !== null && Math.abs(dHelper - dModelWorld) < syncTol,
    dHelper === null ? "跳过：未找到 SkeletonHelper（若核心尚未挂载，契约3c of action-presets 也会报）" : `Δhelper=${dHelper?.toFixed?.(3)} Δmodel=${dModelWorld?.toFixed?.(3)}`);

  // ---- 5b：Alt 拖 → Y 升降，X/Z 不变（第一次拖动后角色已移位，必须重新投影身体点）----
  const bodyPtAlt = await findBodyPoint();
  check("Alt拖前重新找到身体点击点", !!bodyPtAlt.ok, bodyPtAlt.ok ? "" : bodyPtAlt.reason);
  const beforeAlt = await snapshotChar();
  if (bodyPtAlt.ok) {
    await page.keyboard.down("Alt");
    await page.mouse.move(bodyPtAlt.sx, bodyPtAlt.sy);
    await page.mouse.down();
    await page.mouse.move(bodyPtAlt.sx + 20, bodyPtAlt.sy - 120, { steps: 12 });
    await page.mouse.up();
    await page.keyboard.up("Alt");
    await page.waitForTimeout(400);
  }
  const afterAlt = await snapshotChar();
  const dAlt = beforeAlt && afterAlt ? {
    x: afterAlt.modelPos[0] - beforeAlt.modelPos[0],
    y: afterAlt.modelPos[1] - beforeAlt.modelPos[1],
    z: afterAlt.modelPos[2] - beforeAlt.modelPos[2],
  } : null;
  console.log("  Alt拖 model delta:", JSON.stringify(dAlt));
  check("契约5b Alt 拖身体：Y 垂直升降（|dy| > 0.05）", dAlt && Math.abs(dAlt.y) > 0.05,
    `dy=${dAlt?.y?.toFixed?.(4)} — ${xzMoved ? "契约未实现：Alt+拖身体映射 Y 升降（接口要求 C，与道具 Alt 拖一致）" : "前置 5a 未通过"}`);
  check("契约5b2 Alt 拖：X/Z 不漂移", dAlt && Math.abs(dAlt.x) < 0.02 && Math.abs(dAlt.z) < 0.02,
    `dx=${dAlt?.x?.toFixed?.(4)} dz=${dAlt?.z?.toFixed?.(4)}`);
}

// ================= 契约 6：连续添加第 2/3 个 3D角色 =================
// P7：点「添加3D角色」弹出模型选择器，需再选一个模型才真正加载
async function pickModelFromPicker() {
  const ok = await page.waitForSelector("#model-picker-menu", { timeout: 5000 }).then(() => true).catch(() => false);
  if (!ok) return false;
  return page.evaluate(() => {
    const menu = document.getElementById("model-picker-menu");
    const rows = menu ? [...menu.children].slice(1) : [];
    if (!rows.length) return false;
    rows[0].click();
    return true;
  });
}
async function clickAddGLB() {
  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent.includes("添加3D角色") || b.textContent.includes("添加GLB")));
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!clicked) return false;
  return pickModelFromPicker();
}
const clicked2 = await clickAddGLB();
check("契约6a 找到并点击「添加GLB」（第 2 个）", clicked2,
  clicked2 ? "" : "契约未实现：顶栏缺少「添加GLB」按钮（接口要求 D）");
const twoReady = clicked2 && await page.waitForFunction(
  () => window.__ds?.externalCharacters?.getAll?.().length >= 2, null, { timeout: 25000 }
).then(() => true).catch(() => false);
check("契约6b 第 2 个 3D角色加载成功", twoReady, twoReady ? "" : "25s 内未达到 2 个角色");

const clicked3 = twoReady && await clickAddGLB();
const threeReady = clicked3 && await page.waitForFunction(
  () => window.__ds?.externalCharacters?.getAll?.().length >= 3, null, { timeout: 25000 }
).then(() => true).catch(() => false);
check("契约6c 第 3 个 3D角色加载成功", threeReady, threeReady ? "" : "25s 内未达到 3 个角色");

const multi = await page.evaluate(() => {
  const entries = window.__ds?.externalCharacters?.getAll?.() || [];
  const C = entries[0]?.model?.position?.constructor;
  const pos = entries.map((e) => e.model.getWorldPosition(new C()).toArray());
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  return {
    count: entries.length,
    ids: entries.map((e) => e.id),
    activeId: window.__ds.externalCharacters.activeCharacterId,
    d01: pos.length >= 2 ? dist(pos[0], pos[1]) : null,
    d02: pos.length >= 3 ? dist(pos[0], pos[2]) : null,
    d12: pos.length >= 3 ? dist(pos[1], pos[2]) : null,
    visible: entries.map((e) => !!e.model.visible),
  };
});
console.log("  多角色:", JSON.stringify(multi));
check("契约6d 三个角色自动错位出生（两两间距 > 0.3m）",
  multi.d01 !== null && multi.d02 !== null && multi.d12 !== null &&
  multi.d01 > 0.3 && multi.d02 > 0.3 && multi.d12 > 0.3,
  `d01=${multi.d01?.toFixed?.(3)} d02=${multi.d02?.toFixed?.(3)} d12=${multi.d12?.toFixed?.(3)}`);
check("契约6e 自动激活新角色（activeId === 第 3 个）",
  multi.count >= 3 && multi.activeId === multi.ids[2],
  `active=${multi.activeId} 期望=${multi.ids[2]}`);

// ================= 契约 8：sceneJSON 保存 3 角色，reload + init 恢复 =================
const snap = await page.evaluate(() => {
  const C = window.__ds?.externalCharacters?.getAll?.()[0]?.model?.position?.constructor;
  return {
    sceneGz: window.__ds.encodeSceneGz?.() ?? null,
    sceneJSON: window.__ds.getSceneJSON?.() ?? null,
    positions: (window.__ds?.externalCharacters?.getAll?.() || []).map((e) => {
      const v = new C(); e.model.getWorldPosition(v); return v.toArray();
    }),
  };
});
const snapJson = snap.sceneJSON
  ? (typeof snap.sceneJSON === "string" ? JSON.parse(snap.sceneJSON) : snap.sceneJSON)
  : null;
const savedChars = Array.isArray(snapJson?.externalCharacters) ? snapJson.externalCharacters.length : 0;
check("契约8a sceneJSON 保存 3 个 3D角色", savedChars >= 3,
  `externalCharacters=${savedChars}${snapJson ? "" : "（getSceneJSON 返回空）"}`);

await page.reload();
await page.waitForFunction(() => !!window.__ds, null, { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(1500);
await page.evaluate(({ sceneGz, sceneJSON }) => {
  window.postMessage({
    type: "init",
    payload: { width: 1024, height: 1024, sceneGz, sceneJSON: JSON.stringify(sceneJSON) },
  }, window.location.origin);
}, snap);
const restoredReady = await page.waitForFunction(
  () => window.__ds?.externalCharacters?.getAll?.().length >= 3,
  null, { timeout: 30000 }
).then(() => true).catch(() => false);
// 恢复后多等一拍，给可能误触发的自动加载留出暴露时间
await page.waitForTimeout(1500);
const restored = await page.evaluate(() => {
  const entries = window.__ds?.externalCharacters?.getAll?.() || [];
  const C = entries[0]?.model?.position?.constructor;
  return {
    count: entries.length,
    visible: entries.map((e) => !!e?.model?.visible),
    positions: entries.map((e) => { const v = new C(); e.model.getWorldPosition(v); return v.toArray(); }),
    mode: window.__ds?.characterMode ?? null,
    figureVisible: window.__ds?.figureGroup?.visible ?? null,
  };
});
console.log("  恢复状态:", JSON.stringify(restored));
check("契约8b reload + init 后恢复 3 个 3D角色（不多不少）",
  restoredReady && restored.count === 3,
  `count=${restored.count}${restored.count > 3 ? " — 恢复后默认角色自动加载未抑制，重复添加（接口要求 E）" : ""}${restoredReady ? "" : " — 30s 内未恢复到 3 个"}`);
check("契约8c 恢复后 3 个角色 model 均可见",
  restored.count >= 3 && restored.visible.slice(0, 3).every((v) => v === true),
  JSON.stringify(restored.visible));
if (restored.count >= 3 && snap.positions.length >= 3) {
  const drifts = restored.positions.slice(0, 3).map((p, i) => d3(p, snap.positions[i]));
  check("契约8d 恢复后角色位置保持（漂移 < 0.3m）",
    drifts.every((d) => d !== null && d < 0.3),
    drifts.map((d) => d?.toFixed?.(3)).join(","));
} else {
  check("契约8d 恢复后角色位置保持（漂移 < 0.3m）", false, "跳过：恢复数据不足");
}
check("契约8e 恢复后仍为 3D-only（无可见火柴人）",
  restored.mode !== "stick" && restored.figureVisible !== true,
  `mode=${restored.mode} figureVisible=${restored.figureVisible}`);

// ================= 契约 9：截图 + JS 错误 =================
fs.mkdirSync(path.join(__dirname, "out"), { recursive: true });
await page.screenshot({ path: path.join(__dirname, "out", "3d-only-workflow.png") });
console.log("截图: test/out/3d-only-workflow.png");
check("页面无 JS 错误", errors.length === 0, errors.slice(0, 3).join(" | ") || "无");

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
await browser.close();
server.close();
process.exit(fail === 0 ? 0 : 1);
