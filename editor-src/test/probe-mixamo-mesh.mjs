/** probe-mixamo-mesh.mjs — mixamo-rigged 绑定姿势 vs 动作后 正面截图对比 */
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
const outDir = path.join(__dirname, "out", "pose-check", "clean");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".glb": "model/gltf-binary" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  let file = p.startsWith("/director_stage/models/") ? path.join(repoRoot, "assets/models", path.basename(p)) : path.join(webRoot, p === "/" ? "/index.html" : p);
  if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch({ channel: "chrome" }));
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
page.on("dialog", (d) => d.accept());
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => !!window.__ds, null, { timeout: 10000 });
await page.waitForTimeout(1500);
await page.evaluate(async () => {
  const mgr = window.__ds.externalCharacters;
  for (const e of mgr.getAll()) mgr.remove(e.id);
  const e = await mgr.addGLB("/director_stage/models/mixamo-rigged-character.glb", "mixamo");
  mgr.setActive?.((e || mgr.getAll()[0]).id);
});
await page.waitForTimeout(2500);

async function shot(name) {
  await page.evaluate(() => {
    const ds = window.__ds;
    const e = ds.externalCharacters.getActive();
    const px = e?.model?.position?.x ?? 0, pz = e?.model?.position?.z ?? 0;
    const cam = ds?.camera || ds?.activeCamera;
    if (cam) { cam.position.set(px + 0.4, 1.3, pz + 2.8); cam.lookAt(px, 0.9, pz); }
    if (ds?.controls?.target) { ds.controls.target.set(px, 0.9, pz); ds.controls.update?.(); }
  });
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(outDir, name) });
  console.log("✔", name);
}

await shot("mixamo-bind-front.png");   // 绑定初始姿势（未触发任何动作）
await page.evaluate(() => document.querySelector(`[data-action-id="stand"]`)?.click());
await page.waitForTimeout(1500);
await shot("mixamo-stand-front.png");  // stand 动作后
await browser.close();
server.close();
