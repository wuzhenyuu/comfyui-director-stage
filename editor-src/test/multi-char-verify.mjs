/** multi-char-verify.mjs — 多人功能集成验证：
 *  1) 添加 3 人 → 世界坐标各自错位（不重叠）
 *  2) 拾取缓存覆盖所有角色关节（3×18=54 项，FK 模式）
 *  3) 点击非活动角色关节 → 自动激活该角色
 *  4) 整人移动 ON → 拖一个关节 → 18 关节整体平移、其他角色不动
 *  5) 姿势应用只影响活动角色
 *  6) 8 人上限：加到 8 人后第 9 人返回 null
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
await page.waitForTimeout(2000);

let pass = 0, fail = 0;
const check = (name, ok) => { console.log(`${ok ? "✅" : "❌"} ${name}`); ok ? pass++ : fail++; };

// --- 用例 1：添加 3 人，错位不重叠 ---
await page.evaluate(() => {
  const api = window.DS_FigureAPI;
  api.addCharacter("乙");
  api.addCharacter("丙");
});
await page.waitForTimeout(300);
const spread = await page.evaluate(() => {
  const api = window.DS_FigureAPI;
  const hips = []; // COCO RHip=8 的 x/z
  api.getAllCharacters().forEach((ch) => {
    const p = ch.jointSpheres[8].position;
    hips.push([ch.id, +p.x.toFixed(2), +p.z.toFixed(2)]);
  });
  return hips;
});
console.log("  三人 RHip 位置:", JSON.stringify(spread));
const uniqueXZ = new Set(spread.map(([, x, z]) => `${x},${z}`));
check(`3 人错位出生不重叠 (${uniqueXZ.size}/3 唯一位置)`, uniqueXZ.size === 3);

// --- 用例 2：FK 拾取缓存覆盖所有角色（3×18=54）---
const cacheCount = await page.evaluate(() => (window.__ds_jointScreen || []).length);
check(`拾取缓存覆盖所有角色关节 (${cacheCount}/54)`, cacheCount === 54);

// --- 用例 3：点击非活动角色关节 → 自动激活 ---
const clickResult = await page.evaluate(() => {
  const api = window.DS_FigureAPI;
  api.setActive("char_01");
  const chars = [...api.getAllCharacters().values()];
  const target = chars.find((c) => c.id !== "char_01");
  const s = (window.__ds_jointScreen || []).find((e) => e.obj === target.jointSpheres[4]);
  const cv = document.getElementById("viewport").querySelector("canvas");
  const r = cv.getBoundingClientRect();
  return { sx: r.x + s.x, sy: r.y + s.y, targetId: target.id };
});
await page.mouse.click(clickResult.sx, clickResult.sy);
await page.waitForTimeout(150);
const activeAfter = await page.evaluate(() => window.DS_FigureAPI.getActiveCharacter()?.id);
check(`点击非活动角色关节自动激活 (期望=${clickResult.targetId}, 实际=${activeAfter})`, activeAfter === clickResult.targetId);

// --- 用例 4：整人移动 ON → 18 关节整体平移，其他角色不动 ---
await page.evaluate(() => {
  window.__ds_moveWholeBody = true;
  window.DS_FigureAPI.setActive("char_01");
});
await page.waitForTimeout(100);
const wholeResult = await page.evaluate(() => {
  const before1 = window.DS_FigureAPI.getAllCharacters().get("char_01").jointSpheres.map((j) => j.position.toArray());
  const before2 = window.DS_FigureAPI.getAllCharacters().get("char_02").jointSpheres.map((j) => j.position.toArray());
  const s = (window.__ds_jointScreen || []).find((e) => e.charId === "char_01");
  const cv = document.getElementById("viewport").querySelector("canvas");
  const r = cv.getBoundingClientRect();
  return { sx: r.x + s.x, sy: r.y + s.y, before1, before2 };
});
await page.mouse.move(wholeResult.sx, wholeResult.sy);
await page.mouse.down();
await page.mouse.move(wholeResult.sx + 100, wholeResult.sy + 60, { steps: 15 });
await page.mouse.up();
await page.waitForTimeout(300);
const wholeCheck = await page.evaluate((args) => {
  const after1 = window.DS_FigureAPI.getAllCharacters().get("char_01").jointSpheres.map((j) => j.position.toArray());
  const after2 = window.DS_FigureAPI.getAllCharacters().get("char_02").jointSpheres.map((j) => j.position.toArray());
  const deltas = after1.map((p, i) => Math.hypot(p[0] - args.before1[i][0], p[1] - args.before1[i][1], p[2] - args.before1[i][2]));
  const movedAll = deltas.every((d) => d > 0.01); // 18 关节都动了
  const uniform = Math.max(...deltas) - Math.min(...deltas) < 0.01; // 位移一致=平移
  const otherStill = after2.every((p, i) => Math.hypot(p[0] - args.before2[i][0], p[1] - args.before2[i][1], p[2] - args.before2[i][2]) < 0.001);
  return { movedAll, uniform, otherStill, minD: Math.min(...deltas).toFixed(3), maxD: Math.max(...deltas).toFixed(3) };
}, wholeResult);
check(`整人移动：18 关节全动 (${wholeCheck.minD}~${wholeCheck.maxD})`, wholeCheck.movedAll);
check(`整人移动：位移一致=平移`, wholeCheck.uniform);
check(`整人移动：其他角色不动`, wholeCheck.otherStill);
await page.evaluate(() => { window.__ds_moveWholeBody = false; });

// --- 用例 5：姿势应用只影响活动角色 ---
const poseCheck = await page.evaluate(() => {
  const api = window.DS_FigureAPI;
  const read = (id) => api.getAllCharacters().get(id).jointSpheres.map((j) => j.position.toArray());
  const sit = read("char_01");
  const before2 = read("char_02");
  // 模拟姿势库应用：给 char_01 一个夸张姿势（全 y 下压 0.3）
  api.setActive("char_01");
  const posed = sit.map((p) => [p[0], p[1] - 0.3, p[2]]);
  api.applyPoseToActive(posed);
  const after2 = read("char_02");
  const otherUnchanged = after2.every((p, i) => Math.hypot(p[0] - before2[i][0], p[1] - before2[i][1], p[2] - before2[i][2]) < 0.001);
  const selfChanged = read("char_01").some((p, i) => Math.abs(p[1] - sit[i][1]) > 0.2);
  return { selfChanged, otherUnchanged };
});
check(`姿势应用：活动角色生效`, poseCheck.selfChanged);
check(`姿势应用：其他角色不受影响`, poseCheck.otherUnchanged);

// --- 用例 6：8 人上限 ---
const limitCheck = await page.evaluate(() => {
  const api = window.DS_FigureAPI;
  while (api.getCharacterCount() < 8) api.addCharacter("填充");
  const ninth = api.addCharacter("第九人");
  return { count: api.getCharacterCount(), ninthIsNull: ninth === null };
});
check(`8 人上限：第 9 人被拦截 (count=${limitCheck.count}, null=${limitCheck.ninthIsNull})`, limitCheck.count === 8 && limitCheck.ninthIsNull);

await page.screenshot({ path: path.join(__dirname, "out", "multi-char.png") });
console.log("截图: test/out/multi-char.png");
console.log("JS 错误:", errors.length ? errors : "无");
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
await browser.close();
server.close();
process.exit(fail === 0 && errors.length === 0 ? 0 : 1);
