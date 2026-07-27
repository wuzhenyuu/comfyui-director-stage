/** probe-facing.mjs — 探测角色实际面朝方向 vs rig.F */
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
await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => (window.__ds?.externalCharacters?.getAll?.().length ?? 0) >= 1, null, { timeout: 20000 });
await page.waitForTimeout(1500);

const info = await page.evaluate(async () => {
  const mgr = window.__ds.externalCharacters;
  const entry = mgr.getActive() || mgr.getAll()[0];
  const mod = await import("/assets/index-8AwoxI5z.js").catch(() => null); // 不行就换全局
  // 直接读 rig
  const rig = entry._rig || null;
  const jw = (i) => {
    const b = entry.jointMap?.get(i);
    if (!b) return null;
    const v = new b.position.constructor();
    b.getWorldPosition(v);
    return [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)];
  };
  return {
    rigF: rig ? [+rig.F.x.toFixed(3), +rig.F.y.toFixed(3), +rig.F.z.toFixed(3)] : null,
    rigR: rig ? [+rig.R.x.toFixed(3), +rig.R.y.toFixed(3), +rig.R.z.toFixed(3)] : null,
    nose: jw(0), neck: jw(1),
    rShoulder: jw(2), lShoulder: jw(5),
    rWrist: jw(4), lWrist: jw(7),
    rAnkle: jw(10), lAnkle: jw(13),
    modelPos: entry.model ? [entry.model.position.x, entry.model.position.y, entry.model.position.z] : null,
    modelRotY: entry.model ? entry.model.rotation.y : null,
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
server.close();
