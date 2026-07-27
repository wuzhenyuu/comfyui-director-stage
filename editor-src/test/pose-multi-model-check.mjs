/** pose-multi-model-check.mjs — 全模型预设姿势巡检：每个模型应用关键姿势，截图+数值
 * 用法: node pose-multi-model-check.mjs [modelFile...]（默认全部 6 个）
 * 输出: test/out/pose-check/<model>/<pose>.png + report.json
 */
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
const outBase = path.join(__dirname, "out", "pose-check");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".glb": "model/gltf-binary", ".vrm": "model/gltf-binary" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  let file;
  if (p.startsWith("/director_stage/models/")) file = path.join(repoRoot, "assets/models", path.basename(p));
  else { if (p === "/") p = "/index.html"; file = path.join(webRoot, p); }
  if ((!file.startsWith(webRoot) && !file.startsWith(path.join(repoRoot, "assets"))) || !fs.existsSync(file)) { res.writeHead(404); res.end("nf"); return; }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const ALL_MODELS = ["michelle.glb", "ue-mannequin-retopology.glb", "AliciaSolid.vrm", "Xbot.glb", "Soldier.glb", "robot-expressive.glb"];
const argModels = process.argv.slice(2).filter((a) => ALL_MODELS.includes(a));
const models = argModels.length ? argModels : ALL_MODELS;
const POSES = ["stand", "sit", "lie", "punch", "walk"];

const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch({ channel: "chrome" }));
const report = {};

for (const modelFile of models) {
  const modelDir = path.join(outBase, modelFile.replace(/\W+/g, "_"));
  fs.mkdirSync(modelDir, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  page.on("dialog", (d) => d.accept());
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.waitForFunction(() => !!window.__ds, null, { timeout: 10000 });
  await page.waitForTimeout(1200);

  // 直接调 API 加载指定模型（绕过模型选择器 UI，避免文本匹配不可靠）
  const isVRM = modelFile.toLowerCase().endsWith(".vrm");
  const loadResult = await page.evaluate(async ([mf, vrm]) => {
    const mgr = window.__ds.externalCharacters;
    const url = "/director_stage/models/" + mf;
    const name = mf.replace(/\.\w+$/, "");
    try {
      const entry = vrm
        ? await mgr.addVRM(url, name, mf)
        : await mgr.addGLB(url, name);
      const e = entry || mgr.getAll()[mgr.getAll().length - 1];
      mgr.setActive?.(e.id);
      return { ok: true, id: e.id, type: e.type, pos: [e.model.position.x, e.model.position.z] };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }, [modelFile, isVRM]);
  if (!loadResult.ok) {
    console.log(`✘ ${modelFile} 加载失败: ${loadResult.error}`);
    report[modelFile] = { info: loadResult, poses: {}, errors: [loadResult.error] };
    await page.close();
    continue;
  }
  await page.waitForTimeout(2500);
  const info = loadResult;

  const modelReport = { info, poses: {}, errors: errs };
  for (const poseId of POSES) {
    await page.evaluate((aid) => document.querySelector(`[data-action-id="${aid}"]`)?.click(), poseId);
    await page.waitForTimeout(1300);
    // 数值采样
    const nums = await page.evaluate(() => {
      const mgr = window.__ds.externalCharacters;
      const e = mgr.getActive();
      if (!e) return null;
      const rig = e._rig;
      const V3 = e.model.position.constructor;
      const Q = e.model.quaternion.constructor;
      const jw = (i) => { const b = e.jointMap?.get(i); if (!b) return null; const v = new V3(); b.getWorldPosition(v); return [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)]; };
      const v3 = (v) => (v ? [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)] : null);
      let pq = null;
      if (rig?.pelvis) { const q = rig.pelvis.getWorldQuaternion(new Q()); pq = [+q.x.toFixed(3), +q.y.toFixed(3), +q.z.toFixed(3), +q.w.toFixed(3)]; }
      return {
        F: rig ? v3(rig.F) : null, R: rig ? v3(rig.R) : null,
        pelvisQuat: pq,
        pelvisY: rig?.pelvis ? +rig.pelvis.getWorldPosition(new V3()).y.toFixed(3) : null,
        nose: jw(0), rWrist: jw(4), lWrist: jw(7), rAnkle: jw(10), lAnkle: jw(13),
        relaxedR: rig?.relaxed?.rightArm ? v3(rig.relaxed.rightArm.target) : null,
        fingersR: rig?.fingers?.right?.length ?? -1,
      };
    });
    modelReport.poses[poseId] = nums;
    // 3/4 视角截图（对准活动角色实际位置）
    await page.evaluate(() => {
      const ds = window.__ds;
      const e = ds.externalCharacters.getActive();
      const px = e?.model?.position?.x ?? 0, pz = e?.model?.position?.z ?? 0;
      const cam = ds?.camera || ds?.activeCamera;
      if (cam) { cam.position.set(px + 2.4, 1.7, pz + 2.6); cam.lookAt(px, 0.8, pz); }
      if (ds?.controls?.target) { ds.controls.target.set(px, 0.8, pz); ds.controls.update?.(); }
    });
    await page.waitForTimeout(120);
    await page.screenshot({ path: path.join(modelDir, `${poseId}.png`) });
    await page.evaluate(() => document.querySelector(`[data-action-id="stand"]`)?.click());
    await page.waitForTimeout(400);
  }
  report[modelFile] = modelReport;
  console.log(`✔ ${modelFile} (${info.type}) done`);
  await page.close();
}

fs.writeFileSync(path.join(outBase, "multi-model-report.json"), JSON.stringify(report, null, 1));
console.log("报告: out/pose-check/multi-model-report.json");
await browser.close();
server.close();
