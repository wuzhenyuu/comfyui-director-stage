/** glb-character-verify.mjs — GLB 3D角色模式验证（P3-1 已升级为 3D-only 契约）
 *
 * 【3D-only 变更说明】原契约 4/5（再点按钮切回火柴人、往返切换）是火柴人专有测试，
 * 已按「只保留 3D角色」契约移除，替换为契约 4（无任何切回火柴人路径）。
 * 若核心仍未完成 3D-only 改造，契约 1/4 会失败并明确报告缺什么。
 *
 * 验收契约：
 *  1) 默认启动即为 3D-only：externalCharacters >= 1 且 characterMode !== 'stick'
 *     （无需点按钮；核心未完成自动加载时降级手动点「3D角色」继续后续用例）
 *  2) figureGroup 不存在或隐藏；拾取缓存不含火柴人关节，只含外部角色 IK target/pole
 *  3) 外部角色 model / ikTargetsGroup 可见
 *  4) 3D-only：不存在切回火柴人路径 ——
 *     a) UI 无文本/title 含「火柴人」的切换按钮
 *     b) __ds.setCharacterMode('stick')（若 API 仍存在）必须被拒绝，mode 保持非 stick
 *  5) 拖 rightArm target，GLB 骨骼关节真实移动（IK 仍可用）
 *  6) 截图 test/out/glb-character.png；页面无 JS 错误
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

const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch({ channel: "chrome" }));
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => !!window.__ds, null, { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(1500);

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

// ---- 契约 1：默认启动即为 3D-only ----
const autoLoaded = await page.waitForFunction(
  () => (window.__ds?.externalCharacters?.getAll?.().length ?? 0) >= 1
     && window.__ds?.characterMode && window.__ds.characterMode !== "stick",
  null, { timeout: 25000 }
).then(() => true).catch(() => false);
check("契约1 默认启动即为 3D-only（自动加载 3D角色，非 stick 模式）", autoLoaded,
  autoLoaded ? "" : "25s 内无外部角色或仍为 stick — 契约未实现：核心需在 fresh init 自动加载默认 GLB 并进入 3D角色模式");
if (!autoLoaded) {
  // 降级：手动进入 GLB 模式，让契约 2/3/5 可继续验证
  console.log("  [降级] 手动点击「3D角色」按钮…");
  await page.evaluate(() => {
    [...document.querySelectorAll("button")].find((b) => b.textContent.includes("3D角色") && !b.textContent.includes("添加"))?.click();
  });
  await page.waitForFunction(() => window.__ds?.isGLBMode === true, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
}

// ---- 契约 2/3：火柴人退场 + 外部角色可见 ----
const state = await page.evaluate(() => {
  const mgr = window.__ds?.externalCharacters;
  const entry = mgr?.getActive?.() || mgr?.getAll?.()[0] || null;
  const cache = window.__ds_jointScreen || [];
  return {
    mode: window.__ds?.characterMode ?? null,
    figureExists: !!window.__ds?.figureGroup,
    figureVisible: window.__ds?.figureGroup?.visible ?? null,
    modelVisible: entry?.model?.visible ?? null,
    ikGroupVisible: entry?.ikTargetsGroup?.visible ?? null,
    stickJointCache: cache.filter((e) => e.obj?.userData?.isJoint).length,
    targetCache: cache.filter((e) => e.obj?.userData?.ikType === "target").length,
    poleCache: cache.filter((e) => e.obj?.userData?.ikType === "pole").length,
  };
});
console.log("  状态:", JSON.stringify(state));
check("契约2a figureGroup 不存在或已隐藏", !state.figureExists || state.figureVisible === false,
  `exists=${state.figureExists} visible=${state.figureVisible} — 契约未实现：3D-only 下火柴人必须退场`);
check("契约2b 拾取缓存不含火柴人关节", state.stickJointCache === 0, `stickJoints=${state.stickJointCache}`);
check("契约2c 拾取缓存只含外部角色 IK target/pole", state.targetCache >= 4 && state.poleCache >= 4,
  `targets=${state.targetCache} poles=${state.poleCache}`);
check("契约3 外部角色 model / ikTargetsGroup 可见",
  state.modelVisible === true && state.ikGroupVisible === true,
  `model=${state.modelVisible} ikGroup=${state.ikGroupVisible}`);

// ---- 契约 4：3D-only 无切回火柴人路径 ----
const stickEntries = await page.evaluate(() => {
  const hits = [];
  for (const el of document.querySelectorAll("button, [role='button'], label")) {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const txt = ((el.textContent || "") + " " + (el.getAttribute("title") || "")).trim();
    if (txt.includes("火柴人")) hits.push(txt.slice(0, 60));
  }
  return hits.slice(0, 10);
});
check("契约4a UI 无「火柴人」切换入口（按钮/label 文本+title）", stickEntries.length === 0,
  stickEntries.length === 0 ? "" :
  `命中：${stickEntries.join("；")} — 契约未实现：核心需移除切回火柴人按钮及其 title 提示（底层兼容代码可保留）`);

const stickApi = await page.evaluate(() => {
  const before = window.__ds?.characterMode ?? null;
  const apiExists = typeof window.__ds?.setCharacterMode === "function" || typeof window.__dsSetCharacterMode === "function";
  if (!apiExists) return { apiExists: false, before, after: before };
  try { window.__ds?.setCharacterMode?.("stick") ?? window.__dsSetCharacterMode?.("stick"); } catch { /* 拒绝也算通过 */ }
  return { apiExists: true, before, after: window.__ds?.characterMode ?? null };
});
check("契约4b setCharacterMode('stick') 不可达（API 不存在或被拒绝）",
  !stickApi.apiExists || stickApi.after !== "stick",
  JSON.stringify(stickApi) + (stickApi.after === "stick"
    ? " — 契约未实现：3D-only 下 setCharacterMode('stick') 应被拒绝或忽略" : ""));
if (stickApi.after === "stick") {
  // 恢复 3D 模式，避免影响后续用例
  await page.evaluate(() => window.__ds?.setCharacterMode?.("glb") ?? window.__dsSetCharacterMode?.("glb"));
  await page.waitForTimeout(300);
}

// ---- 契约 5：拖 rightArm target，骨骼关节真实移动 ----
const beforeDrag = await page.evaluate(() => {
  const mgr = window.__ds?.externalCharacters;
  const entry = mgr?.getActive?.() || mgr?.getAll?.()[0];
  if (!entry?.ikTargets?.rightArm?.target) return { ok: false, reason: "无外部角色 rightArm target" };
  const target = entry.ikTargets.rightArm.target;
  const s = (window.__ds_jointScreen || []).find((e) => e.obj === target);
  if (!s) return { ok: false, reason: "rightArm target 不在拾取缓存" };
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
if (beforeDrag.ok) {
  await page.mouse.move(beforeDrag.sx, beforeDrag.sy);
  await page.mouse.down();
  await page.mouse.move(beforeDrag.sx + 120, beforeDrag.sy + 80, { steps: 14 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const afterDrag = await page.evaluate(() => {
    const mgr = window.__ds.externalCharacters;
    const entry = mgr?.getActive?.() || mgr?.getAll?.()[0];
    const C = entry.ikTargets.rightArm.target.position.constructor;
    const world = (o) => { const v = new C(); o.getWorldPosition(v); return v.toArray(); };
    return {
      targetWorld: world(entry.ikTargets.rightArm.target),
      wristWorld: entry.jointMap?.get?.(4) ? world(entry.jointMap.get(4)) : null,
    };
  });
  const d = (p, q) => (p && q ? Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) : null);
  const dT = d(afterDrag.targetWorld, beforeDrag.targetWorld);
  const dW = d(afterDrag.wristWorld, beforeDrag.wristWorld);
  console.log("  拖拽 delta:", JSON.stringify({ dT, dW }));
  check("契约5a 拖动 GLB IK target 生效", dT !== null && dT > 0.05, `target=${dT?.toFixed?.(3)}`);
  check("契约5b GLB 骨骼关节跟随移动", dW !== null && dW > 0.03, `wrist=${dW?.toFixed?.(3)}`);
} else {
  check("契约5a 拖动 GLB IK target 生效", false, beforeDrag.reason);
  check("契约5b GLB 骨骼关节跟随移动", false, "跳过");
}

await page.screenshot({ path: path.join(__dirname, "out", "glb-character.png") });
console.log("截图: test/out/glb-character.png");
console.log("JS 错误:", errors.length ? errors : "无");
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
await browser.close();
server.close();
process.exit(fail === 0 && errors.length === 0 ? 0 : 1);
