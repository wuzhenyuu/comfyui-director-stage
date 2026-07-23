/** prop-drag-verify.mjs — 2D 道具拖拽验证
 *  1) 默认拖：沿地面 X/Z 移动，Y 不变
 *  2) Alt 拖：只沿 Y 升降，X/Z 不变
 *  3) rotate 模式：左右拖旋转 Y
 *  4) scale 模式：上下拖缩放
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
await page.waitForTimeout(1500);

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

await page.evaluate(() => {
  document.querySelector('[data-panel="props-panel"]').click();
  [...document.querySelectorAll("#props-tab button")].find((b) => b.textContent.includes("盒"))?.click();
});
await page.waitForTimeout(300);

async function propPoint() {
  return await page.evaluate(() => {
    const s = (window.__ds_propScreen || [])[0];
    const cv = document.getElementById("viewport").querySelector("canvas");
    const r = cv.getBoundingClientRect();
    return { x: r.left + s.x, y: r.top + s.y };
  });
}
async function propState() {
  return await page.evaluate(() => {
    const p = window.__ds.propManager.props[0];
    return {
      pos: p.mesh.position.toArray(),
      rotY: p.mesh.rotation.y,
      scale: p.mesh.scale.toArray(),
      cam: window.__ds.camera.position.toArray(),
    };
  });
}
async function dragProp(dx, dy, alt = false) {
  const pt = await propPoint();
  if (alt) await page.keyboard.down("Alt");
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.down();
  await page.mouse.move(pt.x + dx, pt.y + dy, { steps: 12 });
  await page.mouse.up();
  if (alt) await page.keyboard.up("Alt");
  await page.waitForTimeout(250);
}

// 1) 默认地面 X/Z 拖
const s0 = await propState();
await dragProp(140, 90, false);
const s1 = await propState();
const dx1 = s1.pos[0] - s0.pos[0];
const dy1 = s1.pos[1] - s0.pos[1];
const dz1 = s1.pos[2] - s0.pos[2];
const camMoved1 = Math.hypot(s1.cam[0] - s0.cam[0], s1.cam[1] - s0.cam[1], s1.cam[2] - s0.cam[2]);
console.log("  默认拖 delta:", { dx1, dy1, dz1, camMoved1 });
check("默认拖：X/Z 地面移动", Math.abs(dx1) + Math.abs(dz1) > 0.1,
  `dx=${dx1.toFixed(3)}, dz=${dz1.toFixed(3)}`);
check("默认拖：Y 高度保持不变", Math.abs(dy1) < 0.001, `dy=${dy1.toFixed(4)}`);
check("默认拖：相机不跟着动", camMoved1 < 0.001, `cam=${camMoved1.toFixed(4)}`);

// 2) Alt 垂直 Y 拖
await dragProp(30, -120, true);
const s2 = await propState();
const dx2 = s2.pos[0] - s1.pos[0];
const dy2 = s2.pos[1] - s1.pos[1];
const dz2 = s2.pos[2] - s1.pos[2];
console.log("  Alt拖 delta:", { dx2, dy2, dz2 });
check("Alt拖：Y 垂直升降", Math.abs(dy2) > 0.1, `dy=${dy2.toFixed(3)}`);
check("Alt拖：X/Z 不漂移", Math.abs(dx2) < 0.001 && Math.abs(dz2) < 0.001,
  `dx=${dx2.toFixed(4)}, dz=${dz2.toFixed(4)}`);

// 3) rotate 模式
await page.evaluate(() => window.__ds.propManager.setTransformMode("rotate"));
await dragProp(120, 0, false);
const s3 = await propState();
check("rotate模式：左右拖旋转 Y", Math.abs(s3.rotY - s2.rotY) > 0.2,
  `rot=${(s3.rotY - s2.rotY).toFixed(3)}`);

// 4) scale 模式
await page.evaluate(() => window.__ds.propManager.setTransformMode("scale"));
await dragProp(0, -100, false);
const s4 = await propState();
const scaleDelta = Math.hypot(
  s4.scale[0] - s3.scale[0],
  s4.scale[1] - s3.scale[1],
  s4.scale[2] - s3.scale[2],
);
check("scale模式：上下拖缩放", scaleDelta > 0.05, `scaleDelta=${scaleDelta.toFixed(3)}`);

await page.screenshot({ path: path.join(__dirname, "out", "prop-drag.png") });
console.log("截图: test/out/prop-drag.png");
console.log("JS 错误:", errors.length ? errors : "无");
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
await browser.close();
server.close();
process.exit(fail === 0 && errors.length === 0 ? 0 : 1);
