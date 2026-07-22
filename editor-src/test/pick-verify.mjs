/** pick-verify.mjs — 屏幕空间拾取验证：
 *  1) 点击偏离关节中心 8px 处（视觉圆点边缘）→ 必须命中（旧射线方案会落空）
 *  2) 相机拉远 2.5 倍后点击关节 → 必须命中（旧方案球体投影过小必落空）
 *  3) 点击远离任何关节的空白处 → 必须不命中（防止误选）
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

// 取关节屏幕坐标（读 2D 绘制缓存，与视觉完全一致）
async function jointScreen(idx) {
  return await page.evaluate((i) => {
    const s = (window.__ds_jointScreen || []).find((e) => e.obj === window.__ds.joints[i]);
    if (!s) return null;
    const cv = document.getElementById("viewport").querySelector("canvas");
    const r = cv.getBoundingClientRect();
    return { sx: r.x + s.x, sy: r.y + s.y };
  }, idx);
}

async function clickAndGetSelected(x, y) {
  await page.mouse.click(x, y);
  await page.waitForTimeout(150);
  return await page.evaluate(() => {
    const j = window.__ds_selectedJoint;
    return j ? j.userData.index : null;
  });
}

let pass = 0, fail = 0;
function check(name, ok) {
  console.log(`${ok ? "✅" : "❌"} ${name}`);
  ok ? pass++ : fail++;
}

// --- 用例 1：偏离中心 8px 点击（手腕 RWrist=4，膝盖 RKnee=9） ---
for (const [idx, name] of [[4, "RWrist"], [9, "RKnee"]]) {
  const p = await jointScreen(idx);
  if (!p) { check(`${name} 屏幕坐标存在`, false); continue; }
  const sel = await clickAndGetSelected(p.sx + 8, p.sy - 8);
  check(`${name} 偏离中心 8px 点击命中 (选中 idx=${sel})`, sel === idx);
}

// --- 用例 2：相机拉远 2.5 倍后点击 ---
await page.evaluate(() => {
  const cam = window.__ds.camera;
  cam.position.multiplyScalar(2.5);
});
await page.waitForTimeout(300);
{
  const p = await jointScreen(4);
  const sel = p ? await clickAndGetSelected(p.sx, p.sy) : null;
  check(`拉远 2.5x 后点击 RWrist 命中 (选中 idx=${sel})`, sel === 4);
}

// --- 用例 3：空白处不误选 ---
{
  // 先取消选中
  await page.evaluate(() => { window.__ds_selectedJoint = null; });
  const cv = await page.evaluate(() => {
    const c = document.getElementById("viewport").querySelector("canvas").getBoundingClientRect();
    return { x: c.x + 20, y: c.y + 20 }; // 左上角空白
  });
  const sel = await clickAndGetSelected(cv.x, cv.y);
  check(`空白处点击不误选 (选中 idx=${sel})`, sel === null);
}

console.log("JS 错误:", errors.length ? errors : "无");
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
await browser.close();
server.close();
process.exit(fail === 0 && errors.length === 0 ? 0 : 1);
