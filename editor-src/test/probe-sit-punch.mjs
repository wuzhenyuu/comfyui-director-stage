/** probe-sit-punch.mjs — sit/punch 数值验证 + 正侧面截图 */
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

async function probe(actionId, camPos) {
  await page.evaluate((aid) => document.querySelector(`[data-action-id="${aid}"]`)?.click(), actionId);
  await page.waitForTimeout(1500);
  const nums = await page.evaluate(() => {
    const e = window.__ds.externalCharacters.getActive() || window.__ds.externalCharacters.getAll()[0];
    const jw = (i) => {
      const b = e.jointMap?.get(i);
      if (!b) return null;
      const v = new b.position.constructor();
      b.getWorldPosition(v);
      return [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)];
    };
    return { pelvisY: +e._rig.pelvis.getWorldPosition(new e._rig.pelvis.position.constructor()).y.toFixed(3),
             rKnee: jw(9), rAnkle: jw(10), rWrist: jw(4), lWrist: jw(7), nose: jw(0) };
  });
  // 正侧面相机（从角色右侧 -X 看过去，前方 +Z = 画面右侧）
  await page.evaluate((cp) => {
    const ds = window.__ds;
    const cam = ds?.camera || ds?.activeCamera;
    if (!cam) return;
    cam.position.set(cp[0], cp[1], cp[2]);
    cam.lookAt(0, 0.7, 0);
    if (ds.controls?.target) { ds.controls.target.set(0, 0.7, 0); ds.controls.update?.(); }
  }, camPos);
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(outDir, `profile-${actionId}.png`) });
  return nums;
}

console.log("sit:", JSON.stringify(await probe("sit", [-3.0, 1.0, 0.0])));
await page.evaluate(() => document.querySelector(`[data-action-id="stand"]`)?.click());
await page.waitForTimeout(500);
console.log("punch:", JSON.stringify(await probe("punch", [-3.0, 1.4, 0.0])));
await browser.close();
server.close();
