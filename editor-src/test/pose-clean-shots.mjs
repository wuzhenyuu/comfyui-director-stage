/** pose-clean-shots.mjs — 干净单角色截图：先删自动加载角色再加目标模型
 * 用法: node pose-clean-shots.mjs <modelFile> <pose1,pose2,...>
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
const outBase = path.join(__dirname, "out", "pose-check", "clean");
fs.mkdirSync(outBase, { recursive: true });
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

const jobs = [
  ["ue-mannequin-retopology.glb", ["stand", "sit", "lie", "punch", "walk"]],
  ["robot-expressive.glb", ["stand", "lie", "punch"]],
];

const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch({ channel: "chrome" }));
for (const [mf, poses] of jobs) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.waitForFunction(() => !!window.__ds, null, { timeout: 10000 });
  await page.waitForTimeout(1500);
  const isVRM = mf.endsWith(".vrm");
  await page.evaluate(async ([mf, vrm]) => {
    const mgr = window.__ds.externalCharacters;
    for (const e of mgr.getAll()) mgr.remove(e.id); // 删掉自动加载的角色
    const url = "/director_stage/models/" + mf;
    const e = vrm ? await mgr.addVRM(url, mf, mf) : await mgr.addGLB(url, mf);
    mgr.setActive?.((e || mgr.getAll()[0]).id);
  }, [mf, isVRM]);
  await page.waitForTimeout(2500);
  for (const pose of poses) {
    await page.evaluate((aid) => document.querySelector(`[data-action-id="${aid}"]`)?.click(), pose);
    await page.waitForTimeout(1400);
    await page.evaluate(() => {
      const ds = window.__ds;
      const e = ds.externalCharacters.getActive();
      const px = e?.model?.position?.x ?? 0, pz = e?.model?.position?.z ?? 0;
      const cam = ds?.camera || ds?.activeCamera;
      if (cam) { cam.position.set(px + 2.2, 1.6, pz + 2.4); cam.lookAt(px, 0.8, pz); }
      if (ds?.controls?.target) { ds.controls.target.set(px, 0.8, pz); ds.controls.update?.(); }
    });
    await page.waitForTimeout(120);
    const fn = `${mf.replace(/\.\w+$/, "")}-${pose}.png`;
    await page.screenshot({ path: path.join(outBase, fn) });
    console.log("✔", fn);
    await page.evaluate(() => document.querySelector(`[data-action-id="stand"]`)?.click());
    await page.waitForTimeout(400);
  }
  await page.close();
}
await browser.close();
server.close();
