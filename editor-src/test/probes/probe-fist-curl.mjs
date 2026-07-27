/** probe-fist-curl.mjs — 数值验证 punch 后食指各节弯曲角度 */
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
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => (window.__ds?.externalCharacters?.getAll?.().length ?? 0) >= 1, null, { timeout: 20000 });
await page.waitForTimeout(1500);

async function angles(label) {
  const r = await page.evaluate(() => {
    const e = window.__ds.externalCharacters.getActive() || window.__ds.externalCharacters.getAll()[0];
    const V3 = e.model.position.constructor;
    const wp = (n) => { const b = e.allBones.find((x) => x.name === n); if (!b) return null; const v = new V3(); b.getWorldPosition(v); return v; };
    const names = ["mixamorigRightHandIndex1", "mixamorigRightHandIndex2", "mixamorigRightHandIndex3", "mixamorigRightHandIndex4"];
    const pts = names.map(wp);
    if (pts.some((p) => !p)) return { error: "missing" };
    const seg = (a, b) => b.clone().sub(a).normalize();
    const ang = (v1, v2) => Math.round(Math.acos(Math.max(-1, Math.min(1, v1.dot(v2)))) * 180 / Math.PI);
    const s1 = seg(pts[0], pts[1]), s2 = seg(pts[1], pts[2]), s3 = seg(pts[2], pts[3]);
    // 手指骨骼本地四元数 vs baseQuat
    const rig = e._rig;
    const f1 = rig?.fingers?.right?.find((f) => f.bone.name === "mixamorigRightHandIndex1");
    let localChanged = null;
    if (f1) {
      localChanged = f1.bone.quaternion.angleTo(f1.baseQuat);
      localChanged = +(localChanged * 180 / Math.PI).toFixed(1);
    }
    return { bend12: ang(s1, s2), bend23: ang(s2, s3), index1LocalRotDeg: localChanged, fistR: e._rig?._sampleOut?.fist?.right };
  });
  console.log(label, JSON.stringify(r));
}

await angles("T-pose:");
await page.evaluate(() => document.querySelector(`[data-action-id="punch"]`)?.click());
await page.waitForTimeout(1500);
await angles("punch: ");
await browser.close();
server.close();
