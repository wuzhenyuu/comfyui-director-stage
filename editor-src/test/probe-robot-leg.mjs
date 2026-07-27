/** probe-robot-leg.mjs — 机器人腿部 IK 现场调试 */
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
  let file = p.startsWith("/director_stage/models/") ? path.join(repoRoot, "assets/models", path.basename(p)) : path.join(webRoot, p === "/" ? "/index.html" : p);
  if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
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
  const e = await mgr.addGLB("/director_stage/models/robot-expressive.glb", "robot");
  mgr.setActive?.((e || mgr.getAll()[0]).id);
});
await page.waitForTimeout(2500);

const out = await page.evaluate(() => {
  const e = window.__ds.externalCharacters.getActive();
  const V3 = e.model.position.constructor;
  const Q = e.model.quaternion.constructor;
  const jm = e.jointMap;
  const find = (n) => e.allBones.find((b) => b.name === n);
  const wp = (b) => { const v = new V3(); b.getWorldPosition(v); return [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)]; };
  const upperLeg = jm.get(8), lowerLeg = jm.get(9), foot = jm.get(10);
  // 手动旋转 UpperLegR 测试骨骼是否可驱动
  const footBefore = wp(foot);
  const q = new Q();
  q.setFromAxisAngle(new V3(1, 0, 0), 0.6);
  upperLeg.quaternion.multiply(q);
  upperLeg.updateMatrixWorld(true);
  const footAfter = wp(foot);
  // 恢复
  q.setFromAxisAngle(new V3(1, 0, 0), -0.6);
  upperLeg.quaternion.multiply(q);
  upperLeg.updateMatrixWorld(true);
  return {
    legChain: { root: upperLeg?.name, mid: lowerLeg?.name, end: foot?.name },
    rootParent: upperLeg?.parent?.name,
    rootParentIsBone: upperLeg?.parent?.isBone,
    footBefore, footAfter,
    ikLegTarget: e.ikTargets?.rightLeg?.target ? wp(e.ikTargets.rightLeg.target) : null,
    ikArmTarget: e.ikTargets?.rightArm?.target ? wp(e.ikTargets.rightArm.target) : null,
    mixerActions: e.mixer ? e.mixer._actions.length : -1,
    clipPlaying: e._clipPlaying ?? null,
  };
});
console.log(JSON.stringify(out, null, 1));

// 触发 walk 后观察腿 target 与脚踝
await page.evaluate(() => document.querySelector(`[data-action-id="walk"]`)?.click());
await page.waitForTimeout(800);
const live = await page.evaluate(() => {
  const e = window.__ds.externalCharacters.getActive();
  const V3 = e.model.position.constructor;
  const wp = (b) => { const v = new V3(); b.getWorldPosition(v); return [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)]; };
  return {
    legTarget: wp(e.ikTargets.rightLeg.target),
    legPole: wp(e.ikTargets.rightLeg.pole),
    ankle: wp(e.jointMap.get(10)),
    ikDirty: e._ikDirty,
  };
});
console.log("walk 中:", JSON.stringify(live, null, 1));
await browser.close();
server.close();
