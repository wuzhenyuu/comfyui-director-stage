/** webgl-mode-verify.mjs — P1 WebGL 双模渲染：WebGL 模式验收
 *
 * 验收契约（依赖核心 P1-A 渲染模式管理器，若未实现则对应断言失败并给出说明）：
 *  1) 默认启动（不带任何查询参数）后 window.__ds.renderMode === 'webgl'
 *  2) 页面无 JS 错误
 *  3) 视口非黑屏：截图像素多样性达标（WebGL canvas 无法 2D readback，
 *     故用 Playwright 截图回灌页面内 canvas 统计颜色数/非黑像素数，与渲染实现解耦）
 *  4) 添加道具后场景对象数量增加（__ds.getPropCount() / propManager.props.length +1）
 *
 * 用法: node webgl-mode-verify.mjs
 * 截图: test/out/webgl-mode.png
 */
import { createRequire } from "module";
const require = createRequire("C:/Users/Administrator/AppData/Roaming/npm/node_modules/");
const { chromium } = require("playwright");
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "../../web/editor");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const file = path.join(webRoot, p);
  if (!file.startsWith(webRoot) || !fs.existsSync(file)) { res.writeHead(404); res.end("nf"); return; }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
console.log("静态服务器端口:", port);

const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch({ channel: "chrome" }));
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

// ---- 1. 启动（默认 = auto，应在有 GPU 的 Edge/Chrome 下进入 WebGL） ----
await page.goto(`http://127.0.0.1:${port}/index.html`);
try {
  await page.waitForFunction(() => !!window.__ds, null, { timeout: 10000 });
} catch {
  check("__ds 初始化", false, "10s 内 window.__ds 未就绪");
}
await page.waitForTimeout(2500); // 等首帧渲染稳定

// ---- 2. 渲染模式契约 ----
const modeInfo = await page.evaluate(() => {
  const cv = document.getElementById("viewport")?.querySelector("canvas");
  let ctxType = "none";
  if (cv) {
    // getContext 用与现有不同类型调用会返回 null，不产生副作用
    if (cv.getContext("webgl2") || cv.getContext("webgl")) ctxType = "webgl";
    else if (cv.getContext("2d")) ctxType = "canvas2d";
  }
  return {
    renderMode: window.__ds?.renderMode ?? null,
    ctxType,
    hasCanvas: !!cv,
  };
});
console.log("  模式信息:", JSON.stringify(modeInfo));

if (modeInfo.renderMode === null) {
  check("renderMode === 'webgl'", false,
    "契约未实现：__ds.renderMode 不存在，待核心 P1-A 渲染模式管理器落地后本断言生效");
} else {
  check("renderMode === 'webgl'", modeInfo.renderMode === "webgl",
    `实际=${modeInfo.renderMode}`);
}
check("视口 canvas 上下文为 WebGL", modeInfo.ctxType === "webgl",
  `实际=${modeInfo.ctxType}${modeInfo.ctxType === "canvas2d" ? "（当前为 2D 兜底，WebGL 模式未挂载）" : ""}`);

// ---- 3. 非黑屏：截图像素多样性（与渲染实现解耦） ----
const clip = await page.evaluate(() => {
  const cv = document.getElementById("viewport").querySelector("canvas");
  const r = cv.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
});
const shotBuf = await page.screenshot({ clip });
const pixelStats = await page.evaluate(async (b64) => {
  const img = new Image();
  img.src = "data:image/png;base64," + b64;
  await img.decode();
  const cv = document.createElement("canvas");
  cv.width = img.width; cv.height = img.height;
  const ctx = cv.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
  const colors = new Set();
  let nonBlack = 0, samples = 0;
  for (let i = 0; i < data.length; i += 4 * 97) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    colors.add(`${r},${g},${b}`);
    samples++;
    if (r > 16 || g > 16 || b > 16) nonBlack++;
  }
  return { uniqueColors: colors.size, nonBlack, samples };
}, shotBuf.toString("base64"));
console.log("  像素统计:", JSON.stringify(pixelStats));
check("视口非黑屏（像素多样性）",
  pixelStats.uniqueColors >= 5 && pixelStats.nonBlack > 20,
  `uniqueColors=${pixelStats.uniqueColors}, nonBlack=${pixelStats.nonBlack}/${pixelStats.samples}`);

// ---- 4. 添加道具后对象数量增加 ----
const countBefore = await page.evaluate(() =>
  window.__ds?.getPropCount?.() ?? window.__ds?.propManager?.props?.length ?? 0);
await page.evaluate(() => {
  document.querySelector('[data-panel="props-panel"]').click();
  [...document.querySelectorAll("#props-tab button")].find((b) => b.textContent.includes("盒"))?.click();
});
await page.waitForTimeout(400);
const countAfter = await page.evaluate(() =>
  window.__ds?.getPropCount?.() ?? window.__ds?.propManager?.props?.length ?? 0);
check("添加道具后对象数量 +1", countAfter === countBefore + 1,
  `before=${countBefore}, after=${countAfter}`);

// ---- 5. JS 错误 ----
check("页面无 JS 错误", errors.length === 0, errors.join(" | "));

fs.mkdirSync(path.join(__dirname, "out"), { recursive: true });
await page.screenshot({ path: path.join(__dirname, "out", "webgl-mode.png") });
console.log("截图: test/out/webgl-mode.png");
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
await browser.close();
server.close();
process.exit(fail === 0 ? 0 : 1);
