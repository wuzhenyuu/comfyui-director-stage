/** single-cam-chars-export-verify.mjs — P1-3/P1-4 修复验收探针
 *
 * 场景：单机位 + 2 个外部 3D角色（修复前恒走 M1 退化的最常见配置）。
 *
 * 验收契约：
 *  A) P1-3 路由：单机位 + 外部角色点击「应用」后走 batch 路径——
 *     1. manifest 无顶层 files（非 M1），cameras.length === 1
 *     2. manifest.masks 覆盖全部外部 charId（name/file 齐全）
 *     3. 每个 mask PNG 有真实白色内容（白色像素 > 500）
 *     4. openpose PNG 非空且 ≥2 种角色颜色（多角色肢体连线都画出）
 *  B) P1-4 辅助对象隐藏（render spy，确定性判定）：
 *     5. 导出期间所有 render-target 渲染调用中，ikTargetsGroup/grid/figureGroup
 *        均处于 visible=false（depth/normal/preview/mask 不混入 IK 球等辅助对象）
 *     6. 导出结束后 ikTargetsGroup/grid 可见性恢复导前值
 *  C) M1 行为保持：清空全部角色后（无角色单机位合法场景）再次「应用」——
 *     7. manifest 含顶层 files（M1 标识）且 masks 为空
 *     8. M1 渲染期间 grid 同样被隐藏（P1-4 对 M1 的修复生效）
 *  D) 页面无 JS 错误；截图 test/out/single-cam-chars-export.png
 *
 * 用法: node single-cam-chars-export-verify.mjs
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
const uploadDir = path.join(__dirname, "out", "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".glb": "model/gltf-binary" };

/** mock /upload/image：从 multipart body 中抠出 PNG 存盘，返回 ComfyUI 风格 JSON */
function handleMockUpload(req, res) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const m = /filename="([^"]+\.png)"/.exec(body.toString("latin1"));
    const name = m ? m[1] : `upload_${Date.now()}.png`;
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const start = body.indexOf(sig);
    const end = body.indexOf(Buffer.from("IEND"), start);
    if (start >= 0 && end > start) {
      fs.writeFileSync(path.join(uploadDir, name), body.subarray(start, end + 8));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ name, subfolder: "director_stage", type: "input" }));
  });
}

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/upload/image" && req.method === "POST") return handleMockUpload(req, res);
  let file;
  if (p.startsWith("/director_stage/models/")) {
    file = path.join(repoRoot, "assets/models", path.basename(p));
  } else {
    if (p === "/") p = "/index.html";
    file = path.join(webRoot, p);
  }
  if ((!file.startsWith(webRoot) && !file.startsWith(path.join(repoRoot, "assets"))) || !fs.existsSync(file)) {
    res.writeHead(404); res.end("nf"); return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
console.log("静态服务器端口:", port, "（/upload/image 已 mock →", uploadDir, "）");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch({ channel: "chrome" }));
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.stack || e.message));
await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => !!window.__ds, null, { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(1500);

// ---- 前置 1：第一个 GLB 自动/点击进入 3D角色模式 ----
const alreadyFirst = await page.evaluate(() => window.__ds?.isGLBMode === true && !!window.__ds?.glbData);
if (!alreadyFirst) {
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.includes("3D角色") && !b.textContent.includes("添加"));
    btn?.click();
  });
}
await page.waitForFunction(() => window.__ds?.isGLBMode === true && !!window.__ds?.glbData, null, { timeout: 15000 }).catch(() => {});
const firstReady = await page.evaluate(() => window.__ds?.isGLBMode === true && !!window.__ds?.glbData);
check("第一个 GLB 3D角色就绪", firstReady);

// ---- 前置 2：添加第二个 GLB ----
await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.includes("添加3D角色") || b.textContent.includes("添加GLB"));
  btn?.click();
});
const pickerAppeared = await page.waitForSelector("#model-picker-menu", { timeout: 5000 }).then(() => true).catch(() => false);
if (pickerAppeared) {
  await page.evaluate(() => {
    const menu = document.getElementById("model-picker-menu");
    const rows = menu ? [...menu.children].slice(1) : [];
    if (rows.length) rows[0].click();
  });
}
const twoReady = await page.waitForFunction(
  () => window.__ds?.externalCharacters?.getAll?.().length >= 2,
  null, { timeout: 20000 }
).then(() => true).catch(() => false);
const charIds = await page.evaluate(() =>
  (window.__ds?.externalCharacters?.getAll?.() || []).map((e) => ({ id: e.id, name: e.name })));
check("两个外部 3D角色就绪", twoReady && charIds.length >= 2, JSON.stringify(charIds));

// ---- 前置 3：确认单机位 ----
const camCount = await page.evaluate(() => window.__ds?.cameraManager?.cameras?.length ?? -1);
check("场景为单机位（cameras.length === 1）", camCount === 1, `cameras=${camCount}`);

// ---- 安装 render spy + exportDone 捕获 ----
await page.evaluate(() => {
  window.__exportDones = [];
  window.addEventListener("message", (e) => {
    if (e.data?.type === "exportDone") window.__exportDones.push(e.data.payload);
  });
  const r = window.__ds.renderer;
  window.__renderSpy = [];
  if (r && !r.__spyPatched) {
    r.__spyPatched = true;
    const orig = r.render.bind(r);
    r.render = (sc, cam) => {
      // 只记录 render-target 渲染（导出通道），排除视口主循环渲染
      if (r.getRenderTarget() !== null) {
        let gridVis = null;
        sc.traverse((o) => { if (o.type === "GridHelper" && gridVis === null) gridVis = o.visible; });
        const ikVis = (window.__ds?.externalCharacters?.getAll?.() || []).map((e) => e?.ikTargetsGroup?.visible ?? null);
        window.__renderSpy.push({
          grid: gridVis,
          figure: window.__ds?.figureGroup ? window.__ds.figureGroup.visible : null,
          ik: ikVis,
        });
      }
      return orig(sc, cam);
    };
  }
});

// 导出前可见性基线
const visBaseline = await page.evaluate(() => {
  const out = { grid: null, ik: [] };
  const sc = window.__ds?.scene;
  if (sc) sc.traverse((o) => { if (o.type === "GridHelper" && out.grid === null) out.grid = o.visible; });
  out.ik = (window.__ds?.externalCharacters?.getAll?.() || []).map((e) => e?.ikTargetsGroup?.visible ?? null);
  return out;
});
console.log("  导出前可见性基线:", JSON.stringify(visBaseline));

// ---- 点击「应用」触发导出（单机位 + 2 角色）----
await page.evaluate(() => document.getElementById("btnApply")?.click());
const gotExport1 = await page.waitForFunction(() => window.__exportDones?.length >= 1, null, { timeout: 30000 })
  .then(() => true).catch(() => false);
check("单击「应用」后收到 exportDone（第 1 轮）", gotExport1);

const payload1 = gotExport1 ? await page.evaluate(() => window.__exportDones[0]) : null;
const manifest1 = payload1?.manifest || null;

// ---- A) P1-3 路由与内容 ----
check("契约A1 单机位走 batch 路径（manifest 无顶层 files，cameras.length===1）",
  !!manifest1 && manifest1.files === undefined && manifest1.cameras?.length === 1,
  manifest1 ? `files=${typeof manifest1.files} cameras=${manifest1.cameras?.length} masks=${manifest1.masks?.length}` : "manifest 缺失");

const maskIds1 = (manifest1?.masks || []).map((m) => m.charId);
const masksCoverAll = charIds.length >= 2 && charIds.every((c) => maskIds1.includes(c.id)) &&
  (manifest1?.masks || []).every((m) => m.name && m.file);
check("契约A2 manifest.masks 覆盖全部外部 charId（name/file 齐全）", masksCoverAll,
  `期望=${charIds.map((c) => c.id).join(",")} 实际=${maskIds1.join(",")}`);

// 像素分析工具（在页面内解码 PNG）
async function analyzePng(b64) {
  return page.evaluate(async (b) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b;
    await img.decode();
    const cv = document.createElement("canvas");
    cv.width = img.width; cv.height = img.height;
    const ctx = cv.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const colors = new Set();
    let nonBlack = 0, white = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], bl = data[i + 2];
      if (r > 16 || g > 16 || bl > 16) nonBlack++;
      if (r > 200 && g > 200 && bl > 200) white++;
      if ((r > 16 || g > 16 || bl > 16) && colors.size < 64) colors.add(`${r},${g},${bl}`);
    }
    return { w: cv.width, h: cv.height, nonBlack, white, uniqueColors: colors.size };
  }, b64);
}

// 契约A3：每个 mask PNG 有真实内容
for (const c of charIds.slice(0, 2)) {
  const entry = (manifest1?.masks || []).find((m) => m.charId === c.id);
  const f = entry ? path.join(uploadDir, path.basename(entry.file)) : null;
  const exists = f && fs.existsSync(f) && fs.statSync(f).size > 0;
  if (exists) {
    const stats = await analyzePng(fs.readFileSync(f).toString("base64"));
    check(`契约A3 mask[${c.id}] 有真实白色内容（white > 500）`, stats.white > 500,
      `white=${stats.white} nonBlack=${stats.nonBlack}`);
  } else {
    check(`契约A3 mask[${c.id}] 有真实白色内容（white > 500）`, false, "文件未落盘");
  }
}

// 契约A4：openpose 多角色
const openposeRel = manifest1?.cameras?.[0]?.files?.openpose || "";
const openposeFile = path.join(uploadDir, path.basename(openposeRel));
if (fs.existsSync(openposeFile)) {
  const stats = await analyzePng(fs.readFileSync(openposeFile).toString("base64"));
  check("契约A4a openpose 非空（nonBlack > 100）", stats.nonBlack > 100, `nonBlack=${stats.nonBlack}`);
  check("契约A4b openpose ≥2 种角色颜色（多角色连线均画出）", stats.uniqueColors >= 2,
    `uniqueColors=${stats.uniqueColors}`);
} else {
  check("契约A4a openpose 非空（nonBlack > 100）", false, "文件未落盘");
  check("契约A4b openpose ≥2 种角色颜色（多角色连线均画出）", false, "文件未落盘");
}

// ---- B) P1-4 render spy：导出渲染期间辅助对象全部隐藏 ----
const spy1 = await page.evaluate(() => window.__renderSpy || []);
const spyOk1 = spy1.length > 0 && spy1.every((s) =>
  s.grid === false && (s.figure === null || s.figure === false) && s.ik.every((v) => v === false));
check("契约B1 导出渲染期间 ikTargetsGroup/grid/figureGroup 全部隐藏（render spy）", spyOk1,
  `renders=${spy1.length} 样本=${JSON.stringify(spy1.slice(0, 3))}`);

// 契约B2：导出后可见性恢复
const visAfter1 = await page.evaluate(() => {
  const out = { grid: null, ik: [] };
  const sc = window.__ds?.scene;
  if (sc) sc.traverse((o) => { if (o.type === "GridHelper" && out.grid === null) out.grid = o.visible; });
  out.ik = (window.__ds?.externalCharacters?.getAll?.() || []).map((e) => e?.ikTargetsGroup?.visible ?? null);
  return out;
});
check("契约B2 导出后 ikTargetsGroup/grid 可见性恢复", 
  JSON.stringify(visAfter1) === JSON.stringify(visBaseline),
  `前=${JSON.stringify(visBaseline)} 后=${JSON.stringify(visAfter1)}`);

// ---- C) M1 行为保持：清空角色后再导出 ----
console.log("  第 1 轮期间 pageerror:", errors.length ? errors.join(" || ") : "无");
errors.length = 0;
await page.evaluate(() => {
  const mgr = window.__ds?.externalCharacters;
  for (const e of mgr?.getAll?.() || []) mgr.remove(e.id);
  window.__renderSpy.length = 0;
});
const zeroChars = await page.evaluate(() => (window.__ds?.externalCharacters?.size ?? -1) === 0);
check("已清空全部外部角色（构造无角色单机位合法场景）", zeroChars);
await page.waitForTimeout(800);
console.log("  清空角色后 pageerror:", errors.length ? errors.join(" || ") : "无");
errors.length = 0;

await page.evaluate(() => document.getElementById("btnApply")?.click());
const gotExport2 = await page.waitForFunction(() => window.__exportDones?.length >= 2, null, { timeout: 30000 })
  .then(() => true).catch(() => false);
check("无角色单机位再次「应用」收到 exportDone（第 2 轮）", gotExport2);

const payload2 = gotExport2 ? await page.evaluate(() => window.__exportDones[1]) : null;
const manifest2 = payload2?.manifest || null;
check("契约C1 无角色单机位仍走 M1（顶层 files 存在，masks 为空，cameras.length===1）",
  !!manifest2 && !!manifest2.files && (manifest2.masks || []).length === 0 && manifest2.cameras?.length === 1,
  manifest2 ? `files=${typeof manifest2.files} masks=${manifest2.masks?.length} cameras=${manifest2.cameras?.length}` : "manifest 缺失");

const spy2 = await page.evaluate(() => window.__renderSpy || []);
const spyOk2 = spy2.length > 0 && spy2.every((s) => s.grid === false);
check("契约C2 M1 渲染期间 grid 等辅助对象同样被隐藏（P1-4 对 M1 生效）", spyOk2,
  `renders=${spy2.length} 样本=${JSON.stringify(spy2.slice(0, 2))}`);

// ---- D) 截图 + JS 错误 ----
await page.screenshot({ path: path.join(__dirname, "out", "single-cam-chars-export.png") });
check("页面无 JS 错误", errors.length === 0, errors.slice(0, 3).join(" | ") || "无");

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
