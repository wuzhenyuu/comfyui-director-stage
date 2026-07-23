/** prop-restore-verify.mjs — 道具可见 + 重新打开恢复完整场景状态验证
 *  1) 添加道具后，2D 视口产生道具投影（__ds_propScreen）
 *  2) 收集 sceneGz + sceneJSON，模拟关闭后重新 init
 *  3) 道具/机位/角色数量完整恢复，不重置
 *  4) 恢复后新增道具/机位不发生 ID 冲突
 */
import { createRequire } from "module";
const require = createRequire("C:/Users/Administrator/AppData/Roaming/npm/node_modules/");
const { chromium } = require("playwright");
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "../../web/editor");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const file = path.join(webRoot, p);
  if (!file.startsWith(webRoot) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
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
await page.waitForTimeout(1500);

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

// --- 初始构造：1 个外部 3D角色 + 2 机位 + 1 道具 ---
await page.evaluate(() => {
  // 使用外部角色替代火柴人（P3-2：火柴人已删除）
  window.__dsAddExternalCharacter?.();
  window.__ds.addCamera();
  document.querySelector('[data-panel="props-panel"]').click();
  [...document.querySelectorAll("#props-tab button")].find((b) => b.textContent.includes("盒"))?.click();
});
await page.waitForTimeout(2000); // 等待 GLB 异步加载

const before = await page.evaluate(() => ({
  charCount: window.__ds?.externalCharacters?.getAll?.().length || 0,
  cameraCount: window.__ds.getCameraCount(),
  propCount: window.__ds.getPropCount(),
  propScreenCount: (window.__ds_propScreen || []).length,
  sceneGz: window.__ds.encodeSceneGz(),
  sceneJSON: window.__ds.getSceneJSON(),
}));
console.log("  初始状态:", JSON.stringify({
  charCount: before.charCount,
  cameraCount: before.cameraCount,
  propCount: before.propCount,
  propScreenCount: before.propScreenCount,
}));

check("添加道具后框内出现道具投影", before.propCount === 1 && before.propScreenCount >= 1,
  `prop=${before.propCount}, screen=${before.propScreenCount}`);
check("sceneJSON 包含角色/机位/道具",
  before.sceneJSON.characters?.length === before.charCount &&
  before.sceneJSON.cameras?.length === before.cameraCount &&
  before.sceneJSON.props?.length === before.propCount);

// --- 模拟关闭窗口后重新打开：reload + 用保存状态 init ---
await page.reload();
await page.waitForTimeout(1500);
await page.evaluate(({ sceneGz, sceneJSON }) => {
  window.postMessage({
    type: "init",
    payload: {
      width: 1024,
      height: 1024,
      sceneGz,
      sceneJSON: JSON.stringify(sceneJSON),
    },
  }, window.location.origin);
}, before);
await page.waitForTimeout(700);

const after = await page.evaluate(() => ({
  charCount: window.__ds?.externalCharacters?.getAll?.().length || 0,
  cameraCount: window.__ds.getCameraCount(),
  propCount: window.__ds.getPropCount(),
  propScreenCount: (window.__ds_propScreen || []).length,
  propIds: window.__ds.propManager.props.map((p) => p.id),
  cameraIds: window.__ds.cameraManager.cameras.map((c) => c.id),
}));
console.log("  重开状态:", JSON.stringify(after));

check("重新打开后角色数量不重置", after.charCount === before.charCount, `${after.charCount}/${before.charCount}`);
check("重新打开后机位数量不重置", after.cameraCount === before.cameraCount, `${after.cameraCount}/${before.cameraCount}`);
check("重新打开后道具数量不重置", after.propCount === before.propCount, `${after.propCount}/${before.propCount}`);
check("重新打开后道具仍在框内投影", after.propScreenCount >= 1, `screen=${after.propScreenCount}`);

// --- 恢复后新增对象：ID 必须唯一 ---
const uniqueness = await page.evaluate(() => {
  const beforePropIds = new Set(window.__ds.propManager.props.map((p) => p.id));
  const beforeCamIds = new Set(window.__ds.cameraManager.cameras.map((c) => c.id));
  [...document.querySelectorAll("#props-tab button")].find((b) => b.textContent.includes("球"))?.click();
  const cam = window.__ds.addCamera();
  const propIds = window.__ds.propManager.props.map((p) => p.id);
  const camIds = window.__ds.cameraManager.cameras.map((c) => c.id);
  return {
    camId: cam.id,
    propIds,
    camIds,
    propUnique: new Set(propIds).size === propIds.length,
    camUnique: new Set(camIds).size === camIds.length,
    propAdded: propIds.length === beforePropIds.size + 1,
    camAdded: camIds.length === beforeCamIds.size + 1,
  };
});
check("恢复后新增道具 ID 不冲突", uniqueness.propAdded && uniqueness.propUnique, uniqueness.propIds.join(","));
check("恢复后新增机位 ID 不冲突", uniqueness.camAdded && uniqueness.camUnique, uniqueness.camIds.join(","));

await page.screenshot({ path: path.join(__dirname, "out", "prop-restore.png") });
console.log("截图: test/out/prop-restore.png");
console.log("JS 错误:", errors.length ? errors : "无");
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
await browser.close();
server.close();
process.exit(fail === 0 && errors.length === 0 ? 0 : 1);
