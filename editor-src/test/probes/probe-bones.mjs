/** probe-bones.mjs — 列出每个模型的骨骼名 + jointMap 命中情况 */
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
const MIME = { ".html": "text/html", ".js": "text/javascript", ".glb": "model/gltf-binary", ".vrm": "model/gltf-binary" };
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

const MODELS = ["mixamo-rigged-character.glb", "ue-mannequin-retopology.glb", "AliciaSolid.vrm", "Soldier.glb", "Xbot.glb"];
const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch({ channel: "chrome" }));

const out = {};
for (const mf of MODELS) {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.waitForFunction(() => !!window.__ds, null, { timeout: 10000 });
  await page.waitForTimeout(1200);
  const isVRM = mf.endsWith(".vrm");
  const data = await page.evaluate(async ([mf, vrm]) => {
    const mgr = window.__ds.externalCharacters;
    const url = "/director_stage/models/" + mf;
    const e = vrm ? await mgr.addVRM(url, mf, mf) : await mgr.addGLB(url, mf);
    const entry = e || mgr.getAll()[mgr.getAll().length - 1];
    const jm = {};
    if (entry.jointMap) for (const [k, b] of entry.jointMap) jm[k] = b?.name || null;
    return {
      id: entry.id, type: entry.type,
      boneCount: (entry.allBones || []).length,
      bones: (entry.allBones || []).map((b) => b.name),
      jointMap: jm,
    };
  }, [mf, isVRM]);
  out[mf] = data;
  console.log(`✔ ${mf}: ${data.boneCount} bones, jointMap ${Object.keys(data.jointMap).length} entries`);
  await page.close();
}
fs.writeFileSync(path.join(__dirname, "out", "pose-check", "bones-report.json"), JSON.stringify(out, null, 1));
console.log("written: out/pose-check/bones-report.json");
await browser.close();
server.close();
