/** drag-verify.mjs — 关节拖拽功能验证：拖动手腕关节，对比位置变化 */
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
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.text().includes("[dbg")) console.log("  ", m.text()); });
await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForTimeout(2000);

// 读取右手腕（COCO idx=4）的屏幕坐标
async function wristScreenPos() {
  return await page.evaluate(() => {
    const ds = window.__ds;
    const j = ds.joints[4]; // RWrist
    const cam = ds.camera;
    const cv = document.getElementById("viewport").querySelector("canvas");
    const r = cv.getBoundingClientRect();
    const THREE_V = { x: j.position.x, y: j.position.y, z: j.position.z };
    // 手动投影（复用相机矩阵）
    const v = new (Object.getPrototypeOf(cam.position).constructor)(THREE_V.x, THREE_V.y, THREE_V.z);
    v.project(cam);
    return {
      sx: r.x + (v.x + 1) / 2 * r.width,
      sy: r.y + (1 - v.y) / 2 * r.height,
      world: [j.position.x, j.position.y, j.position.z],
    };
  });
}

const before = await wristScreenPos();
console.log("拖拽前 RWrist 世界坐标:", before.world.map((v) => v.toFixed(3)).join(", "));

// 拖到 +80x, +50y
await page.mouse.move(before.sx, before.sy);
await page.mouse.down();
await page.mouse.move(before.sx + 80, before.sy + 50, { steps: 15 });
await page.mouse.up();
await page.waitForTimeout(400);

const after = await wristScreenPos();
console.log("拖拽后 RWrist 世界坐标:", after.world.map((v) => v.toFixed(3)).join(", "));

const moved = Math.hypot(
  after.world[0] - before.world[0],
  after.world[1] - before.world[1],
  after.world[2] - before.world[2]
);
console.log("位移量:", moved.toFixed(4));

await page.screenshot({ path: path.join(__dirname, "out", "drag-verify.png") });
console.log("截图已存: test/out/drag-verify.png");
console.log("JS 错误:", errors.length ? errors : "无");
console.log(moved > 0.05 ? "\n✅ 关节拖拽生效" : "\n❌ 关节未移动");

await browser.close();
server.close();
process.exit(moved > 0.05 && errors.length === 0 ? 0 : 1);
