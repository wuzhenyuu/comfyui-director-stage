/** probe-ue-scale.mjs — UE mannequin 骨骼缩放/变换检查 + lie 状态数值 */
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
await page.waitForFunction(() => !!window.__ds, null, { timeout: 10000 });
await page.waitForTimeout(1500);
await page.evaluate(async () => {
  const mgr = window.__ds.externalCharacters;
  for (const e of mgr.getAll()) mgr.remove(e.id);
  const e = await mgr.addGLB("/director_stage/models/ue-mannequin-retopology.glb", "ue");
  mgr.setActive?.((e || mgr.getAll()[0]).id);
});
await page.waitForTimeout(2500);

const scales = await page.evaluate(() => {
  const e = window.__ds.externalCharacters.getActive();
  const out = [];
  // 模型根 + 前几个关键骨骼的 local scale / world scale
  const check = ["_rootJoint", "Bones_01", "Bip001_Pelvis_03", "Bip001_Spine_04", "Bip001_Neck_06", "Bip001_Head_055", "Bip001_R_Thigh_061", "Bip001_R_UpperArm_032"];
  const walk = (o) => {
    if (check.includes(o.name)) {
      const ws = new o.scale.constructor();
      o.getWorldScale(ws);
      out.push({ name: o.name, local: [+o.scale.x.toFixed(3), +o.scale.y.toFixed(3), +o.scale.z.toFixed(3)], world: [+ws.x.toFixed(3), +ws.y.toFixed(3), +ws.z.toFixed(3)] });
    }
    for (const c of o.children || []) walk(c);
  };
  walk(e.model);
  return { modelScale: [+e.model.scale.x.toFixed(4), +e.model.scale.y.toFixed(4), +e.model.scale.z.toFixed(4)], bones: out };
});
console.log("== 缩放 ==", JSON.stringify(scales, null, 1));

// 触发 lie 后读关键关节
await page.evaluate(() => document.querySelector(`[data-action-id="lie"]`)?.click());
await page.waitForTimeout(1500);
const lie = await page.evaluate(() => {
  const e = window.__ds.externalCharacters.getActive();
  const V3 = e.model.position.constructor;
  const jw = (i) => { const b = e.jointMap?.get(i); if (!b) return null; const v = new V3(); b.getWorldPosition(v); return [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)]; };
  const find = (n) => e.allBones.find((b) => b.name === n);
  const headB = find("Bip001_Head_055"), neckB = find("Bip001_Neck_06");
  const hp = new V3(); headB?.getWorldPosition(hp);
  const np = new V3(); neckB?.getWorldPosition(np);
  return { nose: jw(0), pelvis: jw(1), rHip: jw(8), rAnkle: jw(10), headWorld: [+hp.x.toFixed(3), +hp.y.toFixed(3), +hp.z.toFixed(3)], neckWorld: [+np.x.toFixed(3), +np.y.toFixed(3), +np.z.toFixed(3)] };
});
console.log("== lie ==", JSON.stringify(lie, null, 1));
await browser.close();
server.close();
