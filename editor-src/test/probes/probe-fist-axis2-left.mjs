/** probe-fist-axis2.mjs �?数值法找手指弯曲轴：旋转食指根节，测食指尖位移方向 */
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

const result = await page.evaluate(() => {
  const e = window.__ds.externalCharacters.getActive() || window.__ds.externalCharacters.getAll()[0];
  const rt = window.__ds.actionRuntime;
  if (rt) { for (const [id] of rt.states) rt.states.get(id).playing = false; }
  const V3 = e.model.position.constructor;
  const Q = e.model.quaternion.constructor;
  const find = (n) => e.allBones.find((b) => b.name === n);
  const root = find("mixamorigLeftHandIndex1");
  const tip = find("mixamorigLeftHandIndex4"); // 指尖
  if (!root || !tip) return { error: "bones not found" };
  const baseQ = root.quaternion.clone();
  const wp = (b) => { const v = new V3(); b.getWorldPosition(v); return v; };
  const out = {};
  e.allBones.forEach((b) => b.updateMatrixWorld(true));
  const before = wp(tip);
  for (const [ax, sign] of [["x", 1], ["x", -1], ["y", 1], ["y", -1], ["z", 1], ["z", -1]]) {
    root.quaternion.copy(baseQ);
    const q = new Q();
    q.setFromAxisAngle(new V3(ax === "x" ? 1 : 0, ax === "y" ? 1 : 0, ax === "z" ? 1 : 0), 1.2 * sign);
    root.quaternion.multiply(q);
    root.updateMatrixWorld(true);
    const after = wp(tip);
    const d = after.clone().sub(before);
    out[`${ax}${sign > 0 ? "+" : "-"}`] = [+d.x.toFixed(3), +d.y.toFixed(3), +d.z.toFixed(3)];
  }
  root.quaternion.copy(baseQ);
  root.updateMatrixWorld(true);
  return { tipBefore: [+before.x.toFixed(3), +before.y.toFixed(3), +before.z.toFixed(3)], deltas: out };
});
console.log(JSON.stringify(result, null, 1));
await browser.close();
server.close();
