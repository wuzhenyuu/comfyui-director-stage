/** orbit-verify.mjs — 左键交互验证：
 *  1) 左键空白拖动 → 相机旋转（position 变化）
 *  2) 左键单击关节（不拖）→ 选中关节
 *  3) 左键拖关节 → 关节移动且相机不动（拖拽优先于旋转）
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
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const file = path.join(webRoot, p);
  if (!file.startsWith(webRoot) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
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
await page.waitForTimeout(2000);

let pass = 0, fail = 0;
const check = (name, ok) => { console.log(`${ok ? "✅" : "❌"} ${name}`); ok ? pass++ : fail++; };

const camPos = () => page.evaluate(() => window.__ds.camera.position.toArray());
const canvasRect = () => page.evaluate(() => {
  const r = document.getElementById("viewport").querySelector("canvas").getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});

// --- 用例 1：左键空白拖动 → 相机旋转 ---
{
  const before = await camPos();
  const r = await canvasRect();
  const sx = r.x + 30, sy = r.y + 30; // 左上角空白
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 150, sy + 80, { steps: 20 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const after = await camPos();
  const moved = Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]);
  check(`左键空白拖动旋转相机 (位移=${moved.toFixed(3)})`, moved > 0.1);
}

// --- 用例 2：左键单击关节 → 选中 ---
{
  const p = await page.evaluate(() => {
    const s = (window.__ds_jointScreen || []).find((e) => e.obj === window.__ds.joints[4]);
    const cv = document.getElementById("viewport").querySelector("canvas");
    const r = cv.getBoundingClientRect();
    return s ? { sx: r.x + s.x, sy: r.y + s.y } : null;
  });
  await page.mouse.click(p.sx, p.sy);
  await page.waitForTimeout(150);
  const sel = await page.evaluate(() => window.__ds_selectedJoint?.userData?.index ?? null);
  check(`左键单击 RWrist 选中 (idx=${sel})`, sel === 4);
}

// --- 用例 3：左键拖关节 → 关节移动且相机不动 ---
{
  const camBefore = await camPos();
  const wristBefore = await page.evaluate(() => window.__ds.joints[4].position.toArray());
  const p = await page.evaluate(() => {
    const s = (window.__ds_jointScreen || []).find((e) => e.obj === window.__ds.joints[4]);
    const cv = document.getElementById("viewport").querySelector("canvas");
    const r = cv.getBoundingClientRect();
    return s ? { sx: r.x + s.x, sy: r.y + s.y } : null;
  });
  await page.mouse.move(p.sx, p.sy);
  await page.mouse.down();
  await page.mouse.move(p.sx + 60, p.sy + 40, { steps: 15 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const camAfter = await camPos();
  const wristAfter = await page.evaluate(() => window.__ds.joints[4].position.toArray());
  const camMoved = Math.hypot(camAfter[0] - camBefore[0], camAfter[1] - camBefore[1], camAfter[2] - camBefore[2]);
  const wristMoved = Math.hypot(...wristAfter.map((v, i) => v - wristBefore[i]));
  check(`拖关节时关节移动 (位移=${wristMoved.toFixed(3)})`, wristMoved > 0.05);
  check(`拖关节时相机不动 (位移=${camMoved.toFixed(3)})`, camMoved < 0.01);
}

console.log("JS 错误:", errors.length ? errors : "无");
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
await browser.close();
server.close();
process.exit(fail === 0 && errors.length === 0 ? 0 : 1);
