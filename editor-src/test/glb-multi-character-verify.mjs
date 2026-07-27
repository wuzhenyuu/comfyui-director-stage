/** glb-multi-character-verify.mjs — P1.5 多 3D角色（GLB）管理器验收（P3-1 适配 3D-only）
 *
 * 【3D-only 适配说明】契约 2 改为 manager 优先 + 自动加载兼容：
 * 3D-only 下默认启动即自动加载第 1 个 GLB（externalCharacters >= 1），
 * 「3D角色」切换按钮可能被核心移除，因此点击按钮仅作降级路径。
 * 另新增契约 2b：3D-only 下 figureGroup 必须不存在或隐藏。
 *
 * 验收契约（依赖核心「多 3D角色管理器」，若未实现则对应断言失败并明确报告缺什么）：
 *  1) 静态服务器映射 /director_stage/models/*.glb → assets/models（本脚本自带映射并验证可达）
 *  2) 默认自动加载（或降级点击「3D角色」按钮）进入第一个 GLB 3D角色模式
 *  3) 点击「添加GLB」按钮（文本包含「添加GLB」）加载第二个 GLB
 *  4) window.__ds.externalCharacters.getAll().length >= 2
 *  5) 两个 GLB entry 各有独立 model / ikTargets / ikTargetsGroup，出生位置不重叠
 *  6) __ds_jointScreen 包含两个角色的 IK target/pole，不包含隐藏火柴人关节
 *  7) 拖第二个角色 rightArm target：第二个角色骨骼移动，第一个角色骨骼不动
 *  8) 收集 sceneJSON 模拟 reload + init，两个 3D角色恢复且姿势不重置
 *  9) 截图 test/out/glb-multi-character.png
 *
 * 用法: node glb-multi-character-verify.mjs
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

// ---- 契约 1：/director_stage/models/*.glb 映射可达 ----
const glbName = "michelle.glb";
const glbLocal = path.join(repoRoot, "assets/models", glbName);
const resp = await fetch(`http://127.0.0.1:${port}/director_stage/models/${glbName}`);
// createReadStream 不带 Content-Length，必须读 body 判断字节数
const body = await resp.arrayBuffer().catch(() => new ArrayBuffer(0));
check("静态映射 /director_stage/models/*.glb → assets/models",
  resp.ok && fs.existsSync(glbLocal) && body.byteLength > 0,
  `HTTP ${resp.status}, body=${body.byteLength}B, 本地文件=${fs.existsSync(glbLocal) ? fs.statSync(glbLocal).size + "B" : "缺失"}`);

const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch({ channel: "chrome" }));
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => !!window.__ds, null, { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(1500);

/** 点击文本包含 txt 的按钮；excludeTxt 用于区分「3D角色」与「添加GLB」 */
async function clickButtonByText(txt, excludeTxt = null) {
  return page.evaluate(([t, ex]) => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      b.textContent.includes(t) && (!ex || !b.textContent.includes(ex)));
    if (!btn) return false;
    btn.click();
    return true;
  }, [txt, excludeTxt]);
}

/** 读取 externalCharacters 快照；核心未实现时返回 { ok:false, reason } */
async function readExternalState() {
  return page.evaluate(() => {
    const mgr = window.__ds?.externalCharacters;
    if (!mgr || typeof mgr.getAll !== "function") {
      return { ok: false, reason: "window.__ds.externalCharacters.getAll 不存在（核心多3D角色管理器未挂载）" };
    }
    const entries = mgr.getAll();
    return {
      ok: true,
      count: entries.length,
      entries: entries.map((e, i) => {
        const modelPos = e?.model ? e.model.getWorldPosition(new (e.model.position.constructor)()).toArray() : null;
        return {
          index: i,
          id: e?.id ?? null,
          hasModel: !!e?.model,
          hasIkTargets: !!e?.ikTargets,
          hasIkTargetsGroup: !!e?.ikTargetsGroup,
          modelVisible: e?.model?.visible ?? null,
          groupVisible: e?.ikTargetsGroup?.visible ?? null,
          modelPos,
          chains: e?.ikTargets ? Object.keys(e.ikTargets) : [],
          jointMapSize: e?.jointMap?.size ?? null,
        };
      }),
    };
  });
}

// ---- 契约 2：默认自动加载（3D-only）或降级点击「3D角色」加载第一个 GLB ----
// 3D-only：优先以 externalCharacters 管理器为准（__ds.glbData 为旧路径兼容兜底）
const hasFirst = async () => page.evaluate(() =>
  (window.__ds?.externalCharacters?.getAll?.().length ?? 0) >= 1
  || (window.__ds?.isGLBMode === true && !!window.__ds?.glbData));
let alreadyFirst = await hasFirst();
if (!alreadyFirst) {
  // 等默认自动加载（3D-only 工作流）
  alreadyFirst = await page.waitForFunction(
    () => (window.__ds?.externalCharacters?.getAll?.().length ?? 0) >= 1
      || (window.__ds?.isGLBMode === true && !!window.__ds?.glbData),
    null, { timeout: 20000 }
  ).then(() => true).catch(() => false);
}
const clickedFirst = alreadyFirst || await clickButtonByText("3D角色", "添加");
check("默认自动加载（或降级点击）进入第一个 GLB 3D角色模式", clickedFirst,
  clickedFirst ? (alreadyFirst ? "自动加载命中" : "降级：点击按钮") : "未自动加载且未找到文本包含「3D角色」的按钮");
if (!alreadyFirst) {
  await page.waitForFunction(
    () => (window.__ds?.externalCharacters?.getAll?.().length ?? 0) >= 1
      || (window.__ds?.isGLBMode === true && !!window.__ds?.glbData),
    null, { timeout: 15000 }
  ).catch(() => {});
}
const firstLoaded = await hasFirst();
check("第一个 GLB 加载并进入 3D角色模式", firstLoaded,
  firstLoaded ? "" : "15s 内 externalCharacters/glbData 均未就绪");
const bootVis = await page.evaluate(() => ({
  figureExists: !!window.__ds?.figureGroup,
  figureVisible: window.__ds?.figureGroup?.visible ?? null,
}));
check("契约2b 3D-only：figureGroup 不存在或已隐藏",
  !bootVis.figureExists || bootVis.figureVisible === false,
  JSON.stringify(bootVis) + " — 契约未实现：3D-only 下火柴人必须退场");

// ---- 契约 3：点击「添加GLB」按钮 ----
const clickedAdd = (await clickButtonByText("添加3D角色")) || (await clickButtonByText("添加GLB"));
check("找到并点击「添加GLB」按钮", clickedAdd,
  clickedAdd ? "" : "契约未实现：不存在文本包含「添加GLB」的按钮，待核心 Agent 在角色工具栏添加");
// P7：按钮弹出模型选择器，需再选一个模型才真正加载
if (clickedAdd) {
  const appeared = await page.waitForSelector("#model-picker-menu", { timeout: 5000 }).then(() => true).catch(() => false);
  if (appeared) await page.evaluate(() => {
    const menu = document.getElementById("model-picker-menu");
    const rows = menu ? [...menu.children].slice(1) : [];
    if (rows.length) rows[0].click();
  });
}

// ---- 契约 4：等待 externalCharacters.getAll().length >= 2 ----
let mgrReady = false;
if (clickedAdd) {
  mgrReady = await page.waitForFunction(
    () => window.__ds?.externalCharacters?.getAll?.().length >= 2,
    null, { timeout: 20000 }
  ).then(() => true).catch(() => false);
}
const state = await readExternalState();
console.log("  externalCharacters 状态:", JSON.stringify(state));
check("externalCharacters.getAll().length >= 2", mgrReady && state.ok && state.count >= 2,
  state.ok ? `实际=${state.count}` : state.reason);

// ---- 契约 5：两个 entry 独立 model/ikTargets/ikTargetsGroup，出生位置不重叠 ----
if (state.ok && state.count >= 2) {
  const [a, b] = state.entries;
  check("两个 entry 均有 model/ikTargets/ikTargetsGroup",
    [a, b].every((e) => e.hasModel && e.hasIkTargets && e.hasIkTargetsGroup),
    JSON.stringify({ a: { m: a.hasModel, t: a.hasIkTargets, g: a.hasIkTargetsGroup }, b: { m: b.hasModel, t: b.hasIkTargets, g: b.hasIkTargetsGroup } }));
  check("两个 entry 均有四条 IK 链（rightArm/leftArm/rightLeg/leftLeg）",
    [a, b].every((e) => ["rightArm", "leftArm", "rightLeg", "leftLeg"].every((c) => e.chains.includes(c))),
    `a=[${a.chains}], b=[${b.chains}]`);

  const independence = await page.evaluate(() => {
    const [a, b] = window.__ds.externalCharacters.getAll();
    const dist = a.model.getWorldPosition(new a.model.position.constructor())
      .distanceTo(b.model.getWorldPosition(new b.model.position.constructor()));
    return {
      modelDistinct: a.model !== b.model,
      groupDistinct: a.ikTargetsGroup !== b.ikTargetsGroup,
      targetDistinct: a.ikTargets.rightArm.target !== b.ikTargets.rightArm.target,
      spawnDist: dist,
    };
  });
  console.log("  独立性:", JSON.stringify(independence));
  check("两个 entry 的 model/ikTargetsGroup/target 均为独立实例",
    independence.modelDistinct && independence.groupDistinct && independence.targetDistinct,
    JSON.stringify(independence));
  check("出生位置不重叠（间距 > 0.3m）", independence.spawnDist > 0.3,
    `dist=${independence.spawnDist.toFixed(3)}`);
} else {
  check("两个 entry 均有 model/ikTargets/ikTargetsGroup", false, "跳过：externalCharacters 未就绪");
  check("两个 entry 的 model/ikTargetsGroup/target 均为独立实例", false, "跳过：externalCharacters 未就绪");
  check("出生位置不重叠（间距 > 0.3m）", false, "跳过：externalCharacters 未就绪");
}

// ---- 契约 6：__ds_jointScreen 含两角色 IK target/pole，无隐藏火柴人关节 ----
await page.waitForTimeout(400); // 等一帧刷新拾取缓存
const cacheInfo = await page.evaluate(() => {
  const cache = window.__ds_jointScreen || [];
  const mgr = window.__ds?.externalCharacters;
  const entries = mgr?.getAll?.() || [];
  const perEntry = entries.map((e) => {
    const objs = new Set();
    for (const chain of Object.values(e.ikTargets || {})) {
      if (chain.target) objs.add(chain.target);
      if (chain.pole) objs.add(chain.pole);
    }
    let hit = 0;
    for (const item of cache) if (objs.has(item.obj)) hit++;
    return { expected: objs.size, cached: hit };
  });
  return {
    cacheCount: cache.length,
    stickJointCount: cache.filter((e) => e.obj?.userData?.isJoint).length,
    targetCount: cache.filter((e) => e.obj?.userData?.ikType === "target").length,
    poleCount: cache.filter((e) => e.obj?.userData?.ikType === "pole").length,
    perEntry,
  };
});
console.log("  拾取缓存:", JSON.stringify(cacheInfo));
check("拾取缓存包含两个角色的 IK target（>= 8）", cacheInfo.targetCount >= 8,
  `targets=${cacheInfo.targetCount}`);
check("拾取缓存包含两个角色的 IK pole（>= 8）", cacheInfo.poleCount >= 8,
  `poles=${cacheInfo.poleCount}`);
check("每个 entry 的 target/pole 都在拾取缓存中",
  cacheInfo.perEntry.length >= 2 && cacheInfo.perEntry.every((e) => e.cached === e.expected),
  JSON.stringify(cacheInfo.perEntry));
check("拾取缓存不包含隐藏火柴人关节", cacheInfo.stickJointCount === 0,
  `stickJoints=${cacheInfo.stickJointCount}`);

// ---- 契约 7：拖第二个角色 rightArm target —— 老二动、老大不动 ----
let dragOk = false;
const beforeDrag = await page.evaluate(() => {
  const entries = window.__ds?.externalCharacters?.getAll?.() || [];
  if (entries.length < 2) return { ok: false };
  const [a, b] = entries;
  const wrist = (e) => {
    const bone = e.jointMap?.get(4); // COCO RWrist
    if (!bone) return null;
    const v = new bone.position.constructor();
    bone.getWorldPosition(v);
    return v.toArray();
  };
  const target = b.ikTargets.rightArm.target;
  const s = (window.__ds_jointScreen || []).find((e) => e.obj === target);
  if (!s) return { ok: false, reason: "第二个角色 rightArm target 不在拾取缓存" };
  const canvases = [...document.querySelectorAll("#viewport canvas")];
  const r = canvases[canvases.length - 1].getBoundingClientRect();
  return {
    ok: true,
    sx: r.left + s.x, sy: r.top + s.y,
    wristA: wrist(a), wristB: wrist(b),
    targetB: target.getWorldPosition(new target.position.constructor()).toArray(),
  };
});
if (beforeDrag.ok && beforeDrag.wristA && beforeDrag.wristB) {
  await page.mouse.move(beforeDrag.sx, beforeDrag.sy);
  await page.mouse.down();
  await page.mouse.move(beforeDrag.sx + 120, beforeDrag.sy + 80, { steps: 14 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const afterDrag = await page.evaluate(() => {
    const [a, b] = window.__ds.externalCharacters.getAll();
    const wrist = (e) => {
      const bone = e.jointMap?.get(4);
      const v = new bone.position.constructor();
      bone.getWorldPosition(v);
      return v.toArray();
    };
    return {
      wristA: wrist(a), wristB: wrist(b),
      targetB: b.ikTargets.rightArm.target.getWorldPosition(new b.ikTargets.rightArm.target.position.constructor()).toArray(),
    };
  });
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  const dTargetB = dist(afterDrag.targetB, beforeDrag.targetB);
  const dWristB = dist(afterDrag.wristB, beforeDrag.wristB);
  const dWristA = dist(afterDrag.wristA, beforeDrag.wristA);
  console.log("  拖拽 delta:", JSON.stringify({ dTargetB, dWristB, dWristA }));
  check("拖动第二个角色 rightArm target 生效", dTargetB > 0.05, `target=${dTargetB.toFixed(3)}`);
  check("第二个角色骨骼跟随移动", dWristB > 0.03, `wristB=${dWristB.toFixed(3)}`);
  check("第一个角色骨骼保持不动", dWristA < 0.01, `wristA=${dWristA.toFixed(3)}`);
  dragOk = dWristB > 0.03;
} else {
  check("拖动第二个角色 rightArm target 生效", false, beforeDrag.reason || "跳过：externalCharacters 未就绪");
  check("第二个角色骨骼跟随移动", false, "跳过");
  check("第一个角色骨骼保持不动", false, "跳过");
}

// ---- 契约 8：sceneJSON 模拟 reload + init —— 两 3D角色恢复且姿势不重置 ----
const snapshotState = await page.evaluate(() => ({
  sceneGz: window.__ds.encodeSceneGz?.() ?? null,
  sceneJSON: window.__ds.getSceneJSON?.() ?? null,
  wristBAfterDrag: (() => {
    const entries = window.__ds?.externalCharacters?.getAll?.() || [];
    if (entries.length < 2) return null;
    const bone = entries[1].jointMap?.get(4);
    if (!bone) return null;
    const v = new bone.position.constructor();
    bone.getWorldPosition(v);
    return v.toArray();
  })(),
  targetBAfterDrag: (() => {
    const entries = window.__ds?.externalCharacters?.getAll?.() || [];
    if (entries.length < 2) return null;
    const t = entries[1].ikTargets.rightArm.target;
    return t.getWorldPosition(new t.position.constructor()).toArray();
  })(),
}));
check("sceneJSON 可收集（含多3D角色数据）",
  !!snapshotState.sceneJSON,
  snapshotState.sceneJSON ? "" : "window.__ds.getSceneJSON() 返回空");

await page.reload();
await page.waitForFunction(() => !!window.__ds, null, { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(1500);
await page.evaluate(({ sceneGz, sceneJSON }) => {
  window.postMessage({
    type: "init",
    payload: { width: 1024, height: 1024, sceneGz, sceneJSON: JSON.stringify(sceneJSON) },
  }, window.location.origin);
}, snapshotState);
const restoredReady = await page.waitForFunction(
  () => window.__ds?.externalCharacters?.getAll?.().length >= 2,
  null, { timeout: 20000 }
).then(() => true).catch(() => false);
const restored = await page.evaluate(() => {
  const entries = window.__ds?.externalCharacters?.getAll?.() || [];
  return {
    count: entries.length,
    modelsVisible: entries.map((e) => !!e?.model?.visible),
    wristB: (() => {
      const bone = entries[1]?.jointMap?.get(4);
      if (!bone) return null;
      const v = new bone.position.constructor();
      bone.getWorldPosition(v);
      return v.toArray();
    })(),
  };
});
console.log("  恢复状态:", JSON.stringify(restored));
check("reload + init 后两个 3D角色恢复", restoredReady && restored.count >= 2,
  `count=${restored.count}${restoredReady ? "" : "（20s 内 externalCharacters 未达到 2，契约未实现：init 未恢复多3D角色）"}`);
check("恢复后两个 3D角色模型可见",
  restored.count >= 2 && restored.modelsVisible.every((v) => v === true),
  JSON.stringify(restored.modelsVisible));
if (dragOk && restored.wristB && snapshotState.wristBAfterDrag) {
  const drift = Math.hypot(
    restored.wristB[0] - snapshotState.wristBAfterDrag[0],
    restored.wristB[1] - snapshotState.wristBAfterDrag[1],
    restored.wristB[2] - snapshotState.wristBAfterDrag[2]);
  check("恢复后第二个角色姿势不重置（腕关节漂移 < 0.15m）", drift < 0.15,
    `drift=${drift.toFixed(3)}`);
} else {
  check("恢复后第二个角色姿势不重置（腕关节漂移 < 0.15m）", false,
    "跳过：恢复数据不足或拖拽未生效");
}

// ---- 契约 9：截图 + JS 错误 ----
fs.mkdirSync(path.join(__dirname, "out"), { recursive: true });
await page.screenshot({ path: path.join(__dirname, "out", "glb-multi-character.png") });
console.log("截图: test/out/glb-multi-character.png");
check("页面无 JS 错误", errors.length === 0, errors.slice(0, 3).join(" | "));

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
await browser.close();
server.close();
process.exit(fail === 0 ? 0 : 1);
