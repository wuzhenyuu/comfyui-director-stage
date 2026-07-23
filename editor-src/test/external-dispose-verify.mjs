/** external-dispose-verify.mjs — 外部 3D角色 add/remove 资源释放冒烟
 *  1) 连续添加/删除 6 个 GLB 角色
 *  2) 每次删除后 manager 清空、活动 ID 清空
 *  3) scene 中不残留 GLB model / GLB_IK_Targets
 *  4) 再添加两个角色仍可正常 IK / 序列化
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
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".glb": "model/gltf-binary" };
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
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => !!window.__ds, null, { timeout: 10000 });
await page.waitForTimeout(1200);
// 默认工作流会自动加载 1 个角色；本测试聚焦 add/remove 资源释放，先清空
await page.evaluate(() => window.__ds.externalCharacters.clear());
await page.waitForTimeout(250);

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`); ok ? pass++ : fail++; };

for (let i = 0; i < 6; i++) {
  const result = await page.evaluate(async (idx) => {
    const mgr = window.__ds.externalCharacters;
    const entry = await mgr.addGLB("/director_stage/models/michelle.glb", `临时角色${idx}`);
    if (!entry) return { ok: false, reason: "addGLB returned null" };
    const id = entry.id;
    mgr.setActive(id);
    const before = {
      size: mgr.size,
      modelInScene: !!entry.model.parent,
      ikInScene: !!entry.ikTargetsGroup.parent,
    };
    mgr.remove(id);
    const leftovers = [];
    window.__ds.scene.traverse((obj) => {
      if (obj.name === "GLB_IK_Targets") leftovers.push(obj.name);
    });
    return {
      ok: true,
      id,
      before,
      after: { size: mgr.size, activeId: mgr.activeCharacterId },
      leftovers,
    };
  }, i);
  check(`第 ${i + 1} 次 add/remove 成功`, result.ok && result.before.size === 1 && result.before.modelInScene && result.before.ikInScene,
    result.ok ? `${result.id}, before=${JSON.stringify(result.before)}` : result.reason);
  check(`第 ${i + 1} 次删除后 manager 清空`, result.ok && result.after.size === 0 && result.after.activeId === null,
    result.ok ? JSON.stringify(result.after) : "add failed");
  check(`第 ${i + 1} 次删除后场景无 IK 组残留`, result.ok && result.leftovers.length === 0,
    result.ok ? `leftovers=${result.leftovers.length}` : "add failed");
}

const finalState = await page.evaluate(async () => {
  const mgr = window.__ds.externalCharacters;
  const a = await mgr.addGLB("/director_stage/models/michelle.glb", "恢复A");
  const b = await mgr.addGLB("/director_stage/models/michelle.glb", "恢复B");
  mgr.setActive(b.id);
  const target = b.ikTargets.rightArm.target;
  const before = target.position.toArray();
  target.position.x += 0.2;
  target.position.y += 0.1;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const joints = window.__ds._glbJointRef().map((m) => m.position.toArray());
  return {
    count: mgr.size,
    activeId: mgr.activeCharacterId,
    targetMoved: Math.hypot(...target.position.toArray().map((v, i) => v - before[i])),
    wrist: joints[4],
    snapshotChars: window.__ds.getSceneJSON().externalCharacters?.length || 0,
  };
});
check("删除循环后可重新添加 2 个角色", finalState.count === 2, `count=${finalState.count}`);
check("重新添加后活动角色与 IK 可用", finalState.activeId && finalState.targetMoved > 0.2, JSON.stringify(finalState));
check("sceneJSON 包含恢复后的 2 个角色", finalState.snapshotChars === 2, `snapshot=${finalState.snapshotChars}`);
check("页面无 JS 错误", errors.length === 0, errors.join("; ") || "无");
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
await browser.close();
server.close();
process.exit(fail === 0 && errors.length === 0 ? 0 : 1);
