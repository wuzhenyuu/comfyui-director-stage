/** probe-fist-axis.mjs — 逐轴旋转手指骨骼，找出握拳弯曲轴 */
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

for (const axis of ["x", "y", "z"]) {
  // 重置 + 旋转右手全部指节（1-3节）绕该轴 -1.2 rad
  await page.evaluate((ax) => {
    const e = window.__ds.externalCharacters.getActive() || window.__ds.externalCharacters.getAll()[0];
    // 停掉动作防止 tick 覆盖
    const rt = window.__ds.actionRuntime;
    if (rt) { for (const [id] of rt.states) rt.states.get(id).playing = false; }
    for (const b of e.allBones) {
      const m = b.name.match(/mixamorigRightHand(Thumb|Index|Middle|Ring|Pinky)([123])/);
      if (!m) continue;
      if (!b.userData._baseQ) b.userData._baseQ = b.quaternion.clone();
      b.quaternion.copy(b.userData._baseQ);
      const q = new b.quaternion.constructor();
      q.setFromAxisAngle(new (b.position.constructor)(ax === "x" ? 1 : 0, ax === "y" ? 1 : 0, ax === "z" ? 1 : 0), -1.2);
      b.quaternion.multiply(q);
    }
    e.allBones.forEach((b) => b.updateMatrixWorld());
    // 相机对准右手
    const ds = window.__ds;
    const hand = e.allBones.find((b) => /mixamorigRightHand$/.test(b.name));
    const v = new (hand.position.constructor)();
    hand.getWorldPosition(v);
    const cam = ds?.camera || ds?.activeCamera;
    if (cam) {
      cam.position.set(v.x + 0.35, v.y + 0.15, v.z + 0.55);
      cam.lookAt(v.x, v.y, v.z);
      if (ds.controls?.target) { ds.controls.target.copy(v); ds.controls.update?.(); }
    }
  }, axis);
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(outDir, `fist-axis-${axis}.png`) });
  console.log(`axis ${axis} done`);
}
await browser.close();
server.close();
