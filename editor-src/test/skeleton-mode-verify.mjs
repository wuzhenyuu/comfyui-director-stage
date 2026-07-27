/** skeleton-mode-verify.mjs — P8 骨骼视图模式（TE_MAN 式）验收
 *
 * 验收契约：
 *  1) __ds.setSkeletonMode(true) 后 __ds.skeletonMode === true，顶栏 #skeletonModeCheckbox 联动勾选
 *  2) 视口 2D canvas readback：黑底占比 > 60%，且存在 OpenPose 彩色像素（骨骼确实画出）
 *  3) 骨骼模式下 __ds_jointScreen 仍含 IK target/pole（编辑不中断）
 *  4) 点击复选框关闭后 __ds.skeletonMode === false，视口恢复非黑底（3D 视图回来）
 *  5) 截图 test/out/skeleton-mode.png；页面无 JS 错误
 *
 * 用法: node skeleton-mode-verify.mjs
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

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

// ---- 前置：等默认 3D 角色加载 ----
const charReady = await page.waitForFunction(
  () => (window.__ds?.externalCharacters?.getAll?.().length ?? 0) >= 1,
  null, { timeout: 25000 }
).then(() => true).catch(() => false);
check("前置：默认 3D 角色已加载", charReady);
await page.waitForTimeout(1000);

// ---- 契约 1：开启骨骼模式（API + 复选框联动）----
await page.evaluate(() => window.__ds.setSkeletonMode(true));
await page.waitForTimeout(600); // 等几帧
const onState = await page.evaluate(() => ({
  api: window.__ds.skeletonMode,
  flag: window.__ds_skeletonMode === true,
  checkbox: document.getElementById("skeletonModeCheckbox")?.checked ?? null,
}));
console.log("  开启后状态:", JSON.stringify(onState));
check("契约1a __ds.skeletonMode === true", onState.api === true);
check("契约1b 顶栏复选框联动勾选", onState.checkbox === true);

// ---- 契约 2：视口像素 = 黑底 + 彩色骨骼 ----
const pixels = await page.evaluate(() => {
  // 视口可能有多个 canvas（WebGL 层 + 2D 交互层），取 2D context 可用的那个
  const cv = [...document.querySelectorAll("#viewport canvas")]
    .find((c) => c.dataset.role !== "webgl-viewport");
  if (!cv) return null;
  const ctx = cv.getContext("2d");
  if (!ctx) return null;
  const w = cv.width, h = cv.height;
  const data = ctx.getImageData(0, 0, w, h).data;
  let black = 0, colorful = 0, total = 0;
  for (let i = 0; i < data.length; i += 4 * 7) { // 抽样提速
    const r = data[i], g = data[i + 1], b = data[i + 2];
    total++;
    if (r < 12 && g < 12 && b < 12) black++;
    else if (Math.max(r, g, b) - Math.min(r, g, b) > 100 && Math.max(r, g, b) > 120) colorful++;
  }
  return { blackRatio: black / total, colorful };
});
console.log("  像素统计:", JSON.stringify(pixels));
check("契约2a 黑底占比 > 60%", pixels && pixels.blackRatio > 0.6,
  pixels ? `black=${(pixels.blackRatio * 100).toFixed(1)}%` : "canvas 不可用");
check("契约2b 存在 OpenPose 彩色骨骼像素", pixels && pixels.colorful > 50,
  pixels ? `colorful=${pixels.colorful}` : "canvas 不可用");

// ---- 契约 3：IK 拾取缓存仍然填充（编辑不中断）----
const pickCache = await page.evaluate(() => {
  const cache = window.__ds_jointScreen || [];
  return {
    targets: cache.filter((e) => e.obj?.userData?.ikType === "target").length,
    poles: cache.filter((e) => e.obj?.userData?.ikType === "pole").length,
  };
});
console.log("  拾取缓存:", JSON.stringify(pickCache));
check("契约3 骨骼模式下 IK target/pole 仍可拾取",
  pickCache.targets >= 4 && pickCache.poles >= 4,
  `targets=${pickCache.targets} poles=${pickCache.poles}`);

// ---- 截图（骨骼模式）----
fs.mkdirSync(path.join(__dirname, "out"), { recursive: true });
await page.screenshot({ path: path.join(__dirname, "out", "skeleton-mode.png") });

// ---- 契约 4：点击复选框关闭 → 恢复 3D 视图 ----
await page.click("#skeletonModeCheckbox");
await page.waitForTimeout(600);
const offState = await page.evaluate(() => {
  const cv = [...document.querySelectorAll("#viewport canvas")]
    .find((c) => c.dataset.role !== "webgl-viewport");
  let blackRatio = 1, transparentRatio = 0;
  if (cv) {
    const ctx = cv.getContext("2d");
    if (ctx) {
      const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
      let black = 0, transparent = 0, total = 0;
      for (let i = 0; i < data.length; i += 4 * 7) {
        total++;
        if (data[i + 3] < 10) transparent++; // WebGL 模式：2D 叠加层恢复透明 = 3D 视图透出
        else if (data[i] < 12 && data[i + 1] < 12 && data[i + 2] < 12) black++;
      }
      blackRatio = black / total;
      transparentRatio = transparent / total;
    }
  }
  return { api: window.__ds.skeletonMode, checkbox: document.getElementById("skeletonModeCheckbox")?.checked, blackRatio, transparentRatio };
});
console.log("  关闭后状态:", JSON.stringify(offState));
check("契约4a 复选框关闭后 __ds.skeletonMode === false", offState.api === false && offState.checkbox === false);
// WebGL 模式：2D 叠加层恢复透明（3D 透出）；Canvas2D 模式：恢复 #222233 底色
const restored = offState.transparentRatio > 0.5 || offState.blackRatio < 0.5;
check("契约4b 视口恢复 3D 视图（叠加层透明或底色非黑）", restored,
  `black=${(offState.blackRatio * 100).toFixed(1)}% transparent=${(offState.transparentRatio * 100).toFixed(1)}%`);

// ---- 契约 5：无 JS 错误 ----
check("契约5 页面无 JS 错误", errors.length === 0, errors.slice(0, 3).join(" | "));

console.log(`\n结果: ${pass} passed, ${fail} failed`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
