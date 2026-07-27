/** repro-remove-char-pageerror.mjs — 复现“删除最后一个外部3D角色后 pageerror”探针
 *
 * 策略：静态服务器 + playwright；加载默认 GLB →（可选播放动作）→ 删除 →
 * 跑 renderLoop（默认每帧都在跑）→ 收集 pageerror 完整 stack。
 * 循环多轮提高命中竞态概率。
 *
 * 用法: node repro-remove-char-pageerror.mjs [轮数]
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
const ROUNDS = Number(process.argv[2]) || 10;

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
console.log("静态服务器端口:", port, "轮数:", ROUNDS);

const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch({ channel: "chrome" }));
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.stack || e.message));
await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => !!window.__ds, null, { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(1500);

// 加载第一个 GLB（与 single-cam 测试同款入口）
const alreadyFirst = await page.evaluate(() => window.__ds?.isGLBMode === true && !!window.__ds?.glbData);
if (!alreadyFirst) {
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.includes("3D角色") && !b.textContent.includes("添加"));
    btn?.click();
  });
}
await page.waitForFunction(() => window.__ds?.isGLBMode === true && !!window.__ds?.glbData, null, { timeout: 15000 }).catch(() => {});
console.log("首个 GLB 就绪:", await page.evaluate(() => !!window.__ds?.glbData));

let totalHits = 0;
for (let round = 1; round <= ROUNDS; round++) {
  errors.length = 0;
  // 确保有角色：若已删光，重新添加
  const has = await page.evaluate(() => (window.__ds?.externalCharacters?.size ?? 0) > 0);
  if (!has) {
    const ok = await page.evaluate(async () => {
      const mgr = window.__ds?.externalCharacters;
      if (!mgr?.addGLB) return false;
      const entry = await mgr.addGLB("/director_stage/models/michelle.glb", "repro");
      if (entry) mgr.setActive(entry.id);
      return !!entry;
    }).catch((e) => { console.log(`round ${round}: addGLB 异常`, e.message); return false; });
    if (!ok) { console.log(`round ${round}: 重新添加角色失败，跳过`); continue; }
    await page.waitForTimeout(300);
  }
  // 交替施加不同前置状态，覆盖竞态面：
  //  A) 播放循环动作（rig 缓存/采样路径）
  //  B) 播放 clip 动画（mixer 路径）
  //  C) 纯待机
  const mode = ["A", "B", "C"][round % 3];
  await page.evaluate((m) => {
    const mgr = window.__ds?.externalCharacters;
    const entry = mgr?.getAll?.()[0];
    if (!entry) return;
    const rt = window.__ds?.actionRuntime;
    if (m === "A" && rt) rt.play(entry.id, "walk");
    else if (m === "B" && rt) {
      const clips = (entry.animations || []);
      if (clips.length) rt.play(entry.id, "clip:" + clips[0].name);
    }
  }, mode);
  await page.waitForTimeout(250); // 让动作跑几帧，rig/mixer 缓存建立

  // 删除最后一个角色（与测试一致的同步 remove 路径）
  await page.evaluate(() => {
    const mgr = window.__ds?.externalCharacters;
    for (const e of mgr?.getAll?.() || []) mgr.remove(e.id);
  });
  // 覆盖原触发链：切换机位 → 200ms 后 captureCameraThumbnail（getScissor 修复点）
  await page.evaluate(() => {
    const cm = window.__ds?.cameraManager;
    if (cm?.cameras?.length) cm.switchCamera(cm.cameras[0].id);
  });
  await page.waitForTimeout(700); // 跑 ~40 帧 renderLoop

  if (errors.length) {
    totalHits += errors.length;
    console.log(`\n=== round ${round} (mode ${mode}) 命中 ${errors.length} 个 pageerror ===`);
    for (const s of errors) console.log(s.split("\n").slice(0, 12).join("\n"), "\n---");
  } else {
    console.log(`round ${round} (mode ${mode}): 无 pageerror`);
  }
}

console.log(`\n总计 pageerror: ${totalHits} / ${ROUNDS} 轮`);
await browser.close();
server.close();
process.exit(totalHits ? 1 : 0);
