/** glb-multi-export-verify.mjs — P1.5b 多 GLB 3D角色导出链路验收（P3-1 适配 3D-only）
 *
 * 【3D-only 适配说明】契约 2 本已兼容自动加载；新增：
 *  - 契约 2b：3D-only 下 figureGroup 不存在或隐藏（火柴人不参与导出）
 *  - 契约 7c：manifest.masks 的 charId 全部来自 externalCharacters（无火柴人角色混入）
 *
 * 验收契约（依赖 export.js 的外部角色导出支持）：
 *  1) 静态服务器映射 /director_stage/models/*.glb → assets/models；
 *     同时 mock /upload/image：接收上传 PNG 并存到 test/out/uploads/（模拟 ComfyUI）
 *  2) 点击「3D角色」加载第一个 GLB，点击「添加GLB」加载第二个 GLB
 *  3) 摆第二个角色右手（移动 rightArm IK target，等 IK 求解帧）
 *  4) 调用 window.__ds.performBatchExport(["openpose","mask","depth"]) 测试钩子
 *  5) openpose PNG 非空（非黑像素达标，且 ≥2 种角色颜色）
 *  6) 两角色关节经 manifest.cameraParams 投影后像素坐标明显不同
 *  7) manifest.cameras 每台相机含 openpose/depth；manifest.masks 含两个外部 charId
 *     （charId/name/file 与 externalCharacters entry 对应）
 *  8) 每个 mask PNG 非空（白色像素 > 0）
 *  9) 截图 test/out/glb-multi-export.png；页面无 JS 错误
 *
 * 用法: node glb-multi-export-verify.mjs
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
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => !!window.__ds, null, { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(1500);

async function clickButtonByText(txt, excludeTxt = null) {
  return page.evaluate(([t, ex]) => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      b.textContent.includes(t) && (!ex || !b.textContent.includes(ex)));
    if (!btn) return false;
    btn.click();
    return true;
  }, [txt, excludeTxt]);
}

// ---- 契约 2：默认或点击加载第一个 GLB，再添加第二个 ----
const alreadyFirst = await page.evaluate(() => window.__ds?.isGLBMode === true && !!window.__ds?.glbData);
const clickedFirst = alreadyFirst || await clickButtonByText("3D角色", "添加");
check("默认/点击进入第一个 GLB 3D角色模式", clickedFirst);
await page.waitForFunction(() => window.__ds?.isGLBMode === true && !!window.__ds?.glbData, null, { timeout: 15000 }).catch(() => {});
check("第一个 GLB 加载并进入 3D角色模式", await page.evaluate(() => window.__ds?.isGLBMode === true && !!window.__ds?.glbData));

const clickedAdd = await clickButtonByText("添加GLB");
check("找到并点击「添加GLB」按钮", clickedAdd);
const twoReady = await page.waitForFunction(
  () => window.__ds?.externalCharacters?.getAll?.().length >= 2,
  null, { timeout: 20000 }
).then(() => true).catch(() => false);
const charIds = await page.evaluate(() =>
  (window.__ds?.externalCharacters?.getAll?.() || []).map((e) => ({ id: e.id, name: e.name })));
console.log("  外部角色:", JSON.stringify(charIds));
check("externalCharacters.getAll().length >= 2", twoReady && charIds.length >= 2,
  `实际=${charIds.length}`);

// ---- 契约 2b：3D-only 下火柴人不参与导出（figureGroup 不存在或隐藏）----
const bootVis = await page.evaluate(() => ({
  figureExists: !!window.__ds?.figureGroup,
  figureVisible: window.__ds?.figureGroup?.visible ?? null,
}));
check("契约2b 3D-only：figureGroup 不存在或已隐藏（火柴人不参与导出）",
  !bootVis.figureExists || bootVis.figureVisible === false,
  JSON.stringify(bootVis));

// ---- 契约 3：摆第二个角色右手 ----
const wristBefore = await page.evaluate(() => {
  const entries = window.__ds.externalCharacters.getAll();
  if (entries.length < 2) return null;
  const t = entries[1].ikTargets.rightArm.target;
  t.position.x += 0.45;
  t.position.y += 0.35;
  const bone = entries[1].jointMap.get(4); // RWrist
  const v = new bone.position.constructor();
  bone.getWorldPosition(v);
  return v.toArray();
});
await page.waitForTimeout(600); // 等 IK 求解若干帧
const wristAfter = await page.evaluate(() => {
  const entries = window.__ds.externalCharacters.getAll();
  const bone = entries[1].jointMap.get(4);
  const v = new bone.position.constructor();
  bone.getWorldPosition(v);
  return v.toArray();
});
const wristDelta = wristBefore && wristAfter
  ? Math.hypot(wristAfter[0] - wristBefore[0], wristAfter[1] - wristBefore[1], wristAfter[2] - wristBefore[2])
  : 0;
check("第二个角色右手姿势已改变（IK 生效）", wristDelta > 0.03, `delta=${wristDelta.toFixed(3)}`);

// 导出前抓取两角色 COCO-18 世界坐标（供投影对比）
const worldJoints = await page.evaluate(() => {
  return window.__ds.externalCharacters.getAll().map((e) => {
    const out = [];
    for (let i = 0; i < 18; i++) {
      const bone = e.jointMap?.get?.(i);
      if (bone) {
        const v = new bone.position.constructor();
        bone.getWorldPosition(v);
        out.push([v.x, v.y, v.z]);
      } else {
        out.push([0, 0, 0]);
      }
    }
    return { id: e.id, joints: out };
  });
});

// ---- 契约 4：__ds.performBatchExport 测试钩子 ----
let exportResult = null;
let exportErr = null;
try {
  exportResult = await page.evaluate(() =>
    window.__ds.performBatchExport(["openpose", "mask", "depth"]));
} catch (e) {
  exportErr = e?.message || String(e);
}
check("performBatchExport(['openpose','mask','depth']) 成功返回", !!exportResult && !exportErr,
  exportErr || (exportResult ? `cameras=${exportResult.manifest?.cameras?.length}, masks=${exportResult.manifest?.masks?.length}` : "无返回"));

const manifest = exportResult?.manifest || null;

// ---- 契约 7：manifest 结构 ----
const camOk = !!manifest && Array.isArray(manifest.cameras) && manifest.cameras.length >= 1 &&
  manifest.cameras.every((c) => c.files?.openpose && c.files?.depth);
check("manifest.cameras 每台相机含 openpose/depth 文件", camOk,
  manifest ? JSON.stringify(manifest.cameras.map((c) => ({ id: c.id, files: Object.keys(c.files || {}) }))) : "manifest 缺失");

const maskIds = (manifest?.masks || []).map((m) => m.charId);
const masksHaveBoth = charIds.length >= 2 && charIds.every((c) => maskIds.includes(c.id));
check("manifest.masks 含两个外部 charId", masksHaveBoth,
  `期望=${charIds.map((c) => c.id).join(",")} 实际=${maskIds.join(",")}`);
const extIdSet = new Set(charIds.map((c) => c.id));
const alienMasks = maskIds.filter((id) => !extIdSet.has(id));
check("契约7c manifest.masks 全部来自外部 3D角色（无火柴人 charId 混入）",
  maskIds.length > 0 && alienMasks.length === 0,
  alienMasks.length ? `外部之外的 charId=${alienMasks.join(",")} — 契约未实现：3D-only 下导出角色列表必须只含 externalCharacters` : `masks=[${maskIds.join(",")}]`);
const masksHaveNames = (manifest?.masks || []).length >= 2 &&
  manifest.masks.every((m) => m.name && m.file);
check("manifest.masks 每条含 name/file（与外部 entry 对应）", masksHaveNames,
  JSON.stringify((manifest?.masks || []).map((m) => ({ charId: m.charId, name: m.name }))));

// ---- 契约 5/8：上传 PNG 落盘 + 像素分析 ----
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
    let nonBlack = 0, white = 0, samples = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], bl = data[i + 2];
      samples++;
      if (r > 16 || g > 16 || bl > 16) nonBlack++;
      if (r > 200 && g > 200 && bl > 200) white++;
      if ((r > 16 || g > 16 || bl > 16) && colors.size < 64) colors.add(`${r},${g},${bl}`);
    }
    return { w: cv.width, h: cv.height, nonBlack, white, samples, uniqueColors: colors.size };
  }, b64);
}

// openpose 文件名：manifest.cameras[0].files.openpose = "director_stage/director_pose_...png"
const openposeRel = manifest?.cameras?.[0]?.files?.openpose || "";
const openposeFile = path.join(uploadDir, path.basename(openposeRel));
const openposeExists = fs.existsSync(openposeFile) && fs.statSync(openposeFile).size > 0;
check("openpose PNG 已上传落盘", openposeExists, path.basename(openposeFile));
if (openposeExists) {
  const stats = await analyzePng(fs.readFileSync(openposeFile).toString("base64"));
  console.log("  openpose 像素:", JSON.stringify(stats));
  check("openpose 非空（非黑像素 > 100）", stats.nonBlack > 100,
    `nonBlack=${stats.nonBlack}/${stats.samples}`);
  check("openpose 含 ≥2 种角色颜色（多角色同图输出）", stats.uniqueColors >= 2,
    `uniqueColors=${stats.uniqueColors}`);
} else {
  check("openpose 非空（非黑像素 > 100）", false, "跳过：文件未落盘");
  check("openpose 含 ≥2 种角色颜色（多角色同图输出）", false, "跳过：文件未落盘");
}

// mask PNG 检查（每个外部 charId 一张）
for (const c of charIds.slice(0, 2)) {
  const maskEntry = (manifest?.masks || []).find((m) => m.charId === c.id);
  const maskFile = maskEntry ? path.join(uploadDir, path.basename(maskEntry.file)) : null;
  const exists = maskFile && fs.existsSync(maskFile) && fs.statSync(maskFile).size > 0;
  if (!exists) {
    check(`mask[${c.id}] PNG 非空（白色像素 > 50）`, false, "文件未落盘");
    continue;
  }
  const stats = await analyzePng(fs.readFileSync(maskFile).toString("base64"));
  console.log(`  mask[${c.id}] 像素:`, JSON.stringify(stats));
  check(`mask[${c.id}] PNG 非空（白色像素 > 50）`, stats.white > 50,
    `white=${stats.white}/${stats.samples}`);
}

// ---- 契约 6：两角色投影不同（用 manifest.cameraParams 的 view/projection 矩阵投影） ----
function projectPoint(p, view, proj, w, h) {
  // THREE Matrix4.toArray() 为列主序：m[col*4+row]
  const mul = (m, v) => {
    const o = [0, 0, 0, 0];
    for (let r = 0; r < 4; r++) {
      o[r] = m[0 * 4 + r] * v[0] + m[1 * 4 + r] * v[1] + m[2 * 4 + r] * v[2] + m[3 * 4 + r] * v[3];
    }
    return o;
  };
  const vv = mul(view, [p[0], p[1], p[2], 1]);
  const clip = mul(proj, vv);
  if (Math.abs(clip[3]) < 1e-9) return null;
  const ndcX = clip[0] / clip[3], ndcY = clip[1] / clip[3];
  return [((ndcX + 1) / 2) * w, ((1 - ndcY) / 2) * h];
}

if (manifest?.cameras?.[0]?.cameraParams && worldJoints.length >= 2) {
  const cam = manifest.cameras[0];
  const { viewMatrix, projectionMatrix } = cam.cameraParams;
  const W = cam.width, H = cam.height;
  const projA = worldJoints[0].joints.map((j) => projectPoint(j, viewMatrix, projectionMatrix, W, H));
  const projB = worldJoints[1].joints.map((j) => projectPoint(j, viewMatrix, projectionMatrix, W, H));
  const dists = projA.map((pa, i) => {
    const pb = projB[i];
    if (!pa || !pb) return 0;
    return Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
  });
  const meanDist = dists.reduce((s, d) => s + d, 0) / dists.length;
  const minDist = Math.min(...dists);
  console.log(`  投影差异: mean=${meanDist.toFixed(1)}px min=${minDist.toFixed(1)}px (W=${W},H=${H})`);
  check("两角色投影明显不同（平均关节像素距离 > 20px）", meanDist > 20,
    `mean=${meanDist.toFixed(1)}px`);
} else {
  check("两角色投影明显不同（平均关节像素距离 > 20px）", false,
    "跳过：cameraParams 或关节数据不足");
}

// ---- 契约 9：截图 + JS 错误 ----
fs.mkdirSync(path.join(__dirname, "out"), { recursive: true });
await page.screenshot({ path: path.join(__dirname, "out", "glb-multi-export.png") });
console.log("截图: test/out/glb-multi-export.png");
check("页面无 JS 错误", errors.length === 0, errors.slice(0, 3).join(" | "));

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
await browser.close();
server.close();
process.exit(fail === 0 ? 0 : 1);
