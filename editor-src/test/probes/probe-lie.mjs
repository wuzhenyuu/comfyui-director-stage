/** probe-lie.mjs — 数值验证 lie/punch 的骨盆旋转与链条 target 是否生效 */
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
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("[console] " + m.text()); });
page.on("dialog", (d) => d.accept());
await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => (window.__ds?.externalCharacters?.getAll?.().length ?? 0) >= 1, null, { timeout: 20000 });
await page.waitForTimeout(1500);

async function probe(actionId) {
  await page.evaluate((aid) => {
    document.querySelector(`[data-action-id="${aid}"]`)?.click();
  }, actionId);
  await page.waitForTimeout(1500);
  return page.evaluate(() => {
    const mgr = window.__ds.externalCharacters;
    const e = mgr.getActive() || mgr.getAll()[0];
    const rig = e._rig;
    const v3 = (v) => v ? [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)] : null;
    const jw = (i) => {
      const b = e.jointMap?.get(i);
      if (!b) return null;
      const v = new b.position.constructor();
      b.getWorldPosition(v);
      return v3(v);
    };
    const pq = rig?.pelvis ? new (Object.getPrototypeOf(rig.pelvis.quaternion).constructor)() : null;
    let pelvisWorldQuat = null;
    if (rig?.pelvis) {
      const q = rig.pelvis.getWorldQuaternion(new rig.pelvis.quaternion.constructor());
      pelvisWorldQuat = [+q.x.toFixed(3), +q.y.toFixed(3), +q.z.toFixed(3), +q.w.toFixed(3)];
    }
    return {
      action: e.actionState ? { id: e.actionState.id, playing: e.actionState.playing, blend: e.actionState.blend } : null,
      rigF: rig ? v3(rig.F) : null,
      rigR: rig ? v3(rig.R) : null,
      hasPelvisBaseQuat: !!rig?.pelvisBaseWorldQuat,
      hasParentQuatInv: !!rig?.pelvisParentWorldQuatInv,
      pelvisWorldQuat,
      pelvisWorldPos: rig?.pelvis ? v3(rig.pelvis.getWorldPosition(new rig.pelvis.position.constructor())) : null,
      pelvisBaseWorld: rig ? v3(rig.pelvisBaseWorld) : null,
      ikTargetRA: v3(e.ikTargets?.rightArm?.target?.position),
      ikTargetRL: v3(e.ikTargets?.rightLeg?.target?.position),
      nose: jw(0), rWrist: jw(4), rAnkle: jw(10),
    };
  });
}

console.log("== lie ==");
console.log(JSON.stringify(await probe("lie"), null, 1));
console.log("== punch ==");
console.log(JSON.stringify(await probe("punch"), null, 1));
console.log("errors:", errors.slice(0, 5));
await browser.close();
server.close();
