/** pose-visual-check.mjs — 预设姿势可视化检查：逐动作截图，人工核对姿势是否正确
 * 用法: node pose-visual-check.mjs [actionId...]（默认全部 10 个）
 * 输出: test/out/pose-check/<action>.png（3D 视口裁剪截图）
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
const outDir = path.join(__dirname, "out", "pose-check");
fs.mkdirSync(outDir, { recursive: true });

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

const ALL = ["stand", "sit", "crouch", "lie", "punch", "idle", "walk", "run", "wave", "jump"];
const targets = process.argv.slice(2).filter((a) => ALL.includes(a));
const actions = targets.length ? targets : ALL;

const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch({ channel: "chrome" }));
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
page.on("dialog", (d) => d.accept());
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => !!window.__ds, null, { timeout: 10000 });
// 等自动加载默认角色
await page.waitForFunction(
  () => (window.__ds?.externalCharacters?.getAll?.().length ?? 0) >= 1,
  null, { timeout: 20000 }
);
await page.waitForTimeout(1500);

// 找 3D 视口 canvas 的裁剪区域
async function viewportClip() {
  return page.evaluate(() => {
    const mgr = window.__ds?.externalCharacters;
    const entry = mgr?.getActive?.() || mgr?.getAll?.()[0];
    const canvas = entry?.renderer?.domElement || document.querySelector("canvas");
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
}

// 触发动作（优先 UI，降级 API）
async function trigger(actionId) {
  const via = await page.evaluate((aid) => {
    const el = document.querySelector(`[data-action-id="${aid}"]`);
    if (el) { el.click(); return "ui"; }
    const mgr = window.__ds?.externalCharacters;
    const e = mgr?.getActive?.() || mgr?.getAll?.()[0];
    if (typeof e?.playAction === "function") { e.playAction(aid); return "api"; }
    if (typeof window.__ds?.playAction === "function") { window.__ds.playAction(e?.id, aid); return "api2"; }
    return null;
  }, actionId);
  return via;
}

// 把相机转到 3/4 侧视角（lie/punch 等朝镜头方向的姿势在正脸视角无法辨认）
async function setObliqueCamera() {
  await page.evaluate(() => {
    const ds = window.__ds;
    const cam = ds?.camera || ds?.activeCamera;
    if (!cam) return;
    cam.position.set(2.4, 1.7, 2.6);
    cam.lookAt(0, 0.8, 0);
    if (ds.controls?.target) {
      ds.controls.target.set(0, 0.8, 0);
      ds.controls.update?.();
    }
  });
}

for (const aid of actions) {
  const via = await trigger(aid);
  if (!via) { console.log(`❌ ${aid}: 无法触发`); continue; }
  // 等 IK 收敛 / 动作进入中段
  const wait = aid === "jump" ? 500 : 1200;
  await page.waitForTimeout(wait);
  await setObliqueCamera();
  await page.waitForTimeout(120);
  // 循环动作：停在相位清晰的时刻再截一张
  const clip = await viewportClip();
  const file = path.join(outDir, `${aid}.png`);
  await page.screenshot({ path: file, clip: clip || undefined });
  console.log(`✅ ${aid}.png (via ${via})`);
  // 回站立，避免串姿势
  await trigger("stand");
  await page.waitForTimeout(400);
}

await browser.close();
server.close();
console.log("输出目录:", outDir);
