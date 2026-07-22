/**
 * smoke-2d.mjs — 2D Canvas 重写后的启动冒烟测试
 * 验证：页面加载无 JS 错误 / canvas 已挂载且非零尺寸 / 火柴人实际绘制（有彩色像素）
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
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const errors = [];
const logs = [];
page.on("console", (m) => { logs.push(`[${m.type()}] ${m.text()}`); });
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForTimeout(2500);

// 1. canvas 挂载检查
const canvasInfo = await page.evaluate(() => {
  const vp = document.getElementById("viewport");
  const cv = vp?.querySelector("canvas");
  if (!cv) return null;
  return {
    cssW: cv.clientWidth, cssH: cv.clientHeight,
    w: cv.width, h: cv.height,
    vpW: vp.clientWidth, vpH: vp.clientHeight,
  };
});

// 2. 画布像素检查：火柴人/网格/信标是否真画上去了（非纯色）
let pixelStats = null;
if (canvasInfo) {
  pixelStats = await page.evaluate(() => {
    const cv = document.getElementById("viewport").querySelector("canvas");
    const ctx = cv.getContext("2d");
    const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const colors = new Set();
    let nonBg = 0;
    for (let i = 0; i < data.length; i += 4 * 97) { // 抽样
      const key = `${data[i]},${data[i+1]},${data[i+2]}`;
      colors.add(key);
      // 背景色 #222233 = 34,34,51
      if (!(data[i] === 34 && data[i+1] === 34 && data[i+2] === 51)) nonBg++;
    }
    return { sampledColors: colors.size, nonBgSamples: nonBg };
  });
}

// 3. 模拟拖拽：从视口中心附近拖到偏移位置（火柴人颈部区域大致在画面中上部）
let dragOk = null;
try {
  const box = await page.evaluate(() => {
    const cv = document.getElementById("viewport").querySelector("canvas");
    const r = cv.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  // 沿垂直中线扫描找关节点（颈部在中心略偏上）
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h * 0.45;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 60, cy + 40, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  dragOk = "拖拽事件完成（无异常）";
} catch (e) {
  dragOk = "拖拽模拟失败: " + e.message;
}

// 4. 右键旋转视角（orbit）— 验证相机位置真的变了
let orbitOk = null;
try {
  const camBefore = await page.evaluate(() => window.__ds.camera.position.toArray());
  const box2 = await page.evaluate(() => {
    const cv = document.getElementById("viewport").querySelector("canvas");
    const r = cv.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await page.mouse.move(box2.x + box2.w / 2, box2.y + box2.h / 2);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(box2.x + box2.w / 2 + 80, box2.y + box2.h / 2, { steps: 8 });
  await page.mouse.up({ button: "right" });
  await page.waitForTimeout(500);
  const camAfter = await page.evaluate(() => window.__ds.camera.position.toArray());
  const camMoved = Math.hypot(camAfter[0]-camBefore[0], camAfter[1]-camBefore[1], camAfter[2]-camBefore[2]);
  orbitOk = camMoved > 0.01 ? `orbit 生效（相机位移 ${camMoved.toFixed(3)}）` : `❌ orbit 无效（位移 ${camMoved}）`;
} catch (e) {
  orbitOk = "orbit 模拟失败: " + e.message;
}

console.log("\n========== 冒烟结果 ==========");
console.log("canvas 信息:", JSON.stringify(canvasInfo));
console.log("像素统计:", JSON.stringify(pixelStats));
console.log("拖拽:", dragOk);
console.log("orbit:", orbitOk);
console.log("\n--- Console 日志（前 15 条）---");
logs.slice(0, 15).forEach((l) => console.log(l));
console.log("\n--- JS 错误 ---");
if (errors.length) { errors.forEach((e) => console.log("❌", e)); }
else console.log("✅ 无页面错误");

const pass =
  canvasInfo && canvasInfo.cssW > 100 && canvasInfo.cssH > 100 &&
  pixelStats && pixelStats.nonBgSamples > 50 &&
  errors.length === 0;
console.log("\n========== 总结论:", pass ? "✅ 通过" : "❌ 未通过", "==========");

await browser.close();
server.close();
process.exit(pass ? 0 : 1);
