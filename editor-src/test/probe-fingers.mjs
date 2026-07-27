/** probe-fingers.mjs — 探测手指骨骼匹配情况 + 试探各轴向的握拳效果 */
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
const MIME = { ".html": "text/html", ".js": "text/javascript", ".glb": "model/gltf-binary" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  let file;
  if (p.startsWith("/director_stage/models/")) file = path.join(repoRoot, "assets/models", path.basename(p));
  else { if (p === "/") p = "/index.html"; file = path.join(webRoot, p); }
  if ((!file.startsWith(webRoot) && !file.startsWith(path.join(repoRoot, "assets"))) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch({ channel: "chrome" }));
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
page.on("dialog", (d) => d.accept());
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => (window.__ds?.externalCharacters?.getAll?.().length ?? 0) >= 1, null, { timeout: 20000 });
await page.waitForTimeout(1500);

// 1) 列出所有含 finger/thumb/index 等的骨骼名 + rig.fingers 匹配数
const info = await page.evaluate(() => {
  const e = window.__ds.externalCharacters.getActive() || window.__ds.externalCharacters.getAll()[0];
  const names = (e.allBones || []).map((b) => b.name).filter((n) => /thumb|index|middle|ring|pinky|finger/i.test(n));
  // 先触发一次动作确保 rig 已捕获
  document.querySelector(`[data-action-id="punch"]`)?.click();
  return { fingerBoneNames: names, totalBones: (e.allBones || []).length };
});
console.log("手指骨骼名:", JSON.stringify(info, null, 1));
await page.waitForTimeout(1200);

const rigInfo = await page.evaluate(() => {
  const e = window.__ds.externalCharacters.getActive() || window.__ds.externalCharacters.getAll()[0];
  const rig = e._rig;
  return {
    rightCount: rig?.fingers?.right?.length ?? -1,
    leftCount: rig?.fingers?.left?.length ?? -1,
    sampleRight: (rig?.fingers?.right || []).slice(0, 5).map((f) => f.bone.name),
  };
});
console.log("rig.fingers:", JSON.stringify(rigInfo, null, 1));
await browser.close();
server.close();
