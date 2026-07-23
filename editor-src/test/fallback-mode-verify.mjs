/** fallback-mode-verify.mjs — P1 WebGL 双模渲染：2D 兜底模式验收
 *
 * 验收契约（依赖核心 P1-A 渲染模式管理器识别 ?force2d=1，若未实现则对应断言失败并给出说明）：
 *  1) 带 ?force2d=1 启动后 window.__ds.renderMode === 'canvas2d'
 *  2) #viewport 内存在 2D canvas（getContext("2d") 可用）
 *  3) 添加道具后 window.__ds_propScreen 长度 >= 1（2D 投影拾取缓存被填充）
 *  4) 页面无 JS 错误
 *  5) 视口非纯色（2D readback 像素多样性）
 *
 * 用法: node fallback-mode-verify.mjs
 * 截图: test/out/fallback-mode.png
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

// ---- 1. 强制 2D 启动 ----
await page.goto(`http://127.0.0.1:${port}/index.html?force2d=1`);
try {
  await page.waitForFunction(() => !!window.__ds, null, { timeout: 10000 });
} catch {
  check("__ds 初始化", false, "10s 内 window.__ds 未就绪");
}
await page.waitForTimeout(2500); // 等 drawFrame 循环跑起来

// ---- 2. 渲染模式契约 ----
const modeInfo = await page.evaluate(() => {
  const cv = document.getElementById("viewport")?.querySelector("canvas");
  let ctxType = "none";
  if (cv) {
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
  check("renderMode === 'canvas2d'", false,
    "契约未实现：__ds.renderMode 不存在 / ?force2d=1 未被识别，待核心 P1-A 渲染模式管理器落地后本断言生效");
} else {
  check("renderMode === 'canvas2d'", modeInfo.renderMode === "canvas2d",
    `实际=${modeInfo.renderMode}`);
}
check("2D canvas 存在", modeInfo.hasCanvas && modeInfo.ctxType === "canvas2d",
  `ctxType=${modeInfo.ctxType}`);

// ---- 3. 视口非纯色（2D readback 像素多样性） ----
const pixelStats = await page.evaluate(() => {
  const cv = document.getElementById("viewport").querySelector("canvas");
  if (!cv) return null;
  const ctx = cv.getContext("2d");
  if (!ctx) return null;
  const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
  const colors = new Set();
  let nonBg = 0;
  for (let i = 0; i < data.length; i += 4 * 97) {
    colors.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    // 背景 #222233 = 34,34,51
    if (!(data[i] === 34 && data[i + 1] === 34 && data[i + 2] === 51)) nonBg++;
  }
  return { uniqueColors: colors.size, nonBg };
});
console.log("  像素统计:", JSON.stringify(pixelStats));
check("视口非纯色（2D 绘制生效）",
  !!pixelStats && pixelStats.uniqueColors >= 3 && pixelStats.nonBg > 20,
  pixelStats ? `uniqueColors=${pixelStats.uniqueColors}, nonBg=${pixelStats.nonBg}` : "canvas 无法 readback");

// ---- 4. 添加道具后 __ds_propScreen 长度 >= 1 ----
await page.evaluate(() => {
  document.querySelector('[data-panel="props-panel"]').click();
  [...document.querySelectorAll("#props-tab button")].find((b) => b.textContent.includes("盒"))?.click();
});
await page.waitForTimeout(500); // 等下一帧 drawProps2D 填充拾取缓存
const propScreen = await page.evaluate(() => ({
  len: (window.__ds_propScreen || []).length,
  propCount: window.__ds?.getPropCount?.() ?? window.__ds?.propManager?.props?.length ?? 0,
}));
console.log("  道具状态:", JSON.stringify(propScreen));
check("添加道具成功（propCount >= 1）", propScreen.propCount >= 1, `propCount=${propScreen.propCount}`);
check("__ds_propScreen 长度 >= 1（2D 投影可见）", propScreen.len >= 1, `len=${propScreen.len}`);

// ---- 5. JS 错误 ----
check("页面无 JS 错误", errors.length === 0, errors.join(" | "));

fs.mkdirSync(path.join(__dirname, "out"), { recursive: true });
await page.screenshot({ path: path.join(__dirname, "out", "fallback-mode.png") });
console.log("截图: test/out/fallback-mode.png");
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
await browser.close();
server.close();
process.exit(fail === 0 ? 0 : 1);
