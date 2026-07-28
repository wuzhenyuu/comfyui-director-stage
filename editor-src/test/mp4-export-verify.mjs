/** mp4-export-verify.mjs — V2-F2 MP4 参考视频导出 验证套件
 *
 * 依据：projects/director-stage-review/camera-trajectory/DESIGN-V2.md F2
 * 只写测试，不改 src 源码。
 *
 * 契约分组（playwright + 静态服务器，无 /upload/image 依赖）：
 *  M1 UI 挂载：#btnExportVideo 存在、点击弹出参数对话框（分辨率/fps 选项）
 *  M2 环境探测：页面报告 WebCodecs avc 编码支持情况（决定主/降级断言分支）
 *  M3 主路径（WebCodecs 支持时）：2s×24fps=48 帧 720p 导出 →
 *     ok/path=webcodecs、Blob size>0、MP4 ftyp box、stsz 样本数=48、
 *     导出中遮罩出现、导出后相机姿态恢复<1e-6、progress 恢复
 *  M4 降级路径（forceFallback 强制）：MediaRecorder 实时录制不崩 →
 *     ok/path=mediarecorder、Blob size>0、相机姿态恢复<1e-6
 *     （WebCodecs 不可用时 M3 自动降级为同一断言集：不崩+文件有效）
 *  M5 无轨迹/轨迹禁用：友好 {ok:false, reason:"no-trajectory"}，不抛异常
 *  M6 页面零 JS 错误
 *
 * 用法: node mp4-export-verify.mjs
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

// ================= 断言 harness =================
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const approxVec = (a, b, eps = 1e-6) =>
  !!a && !!b && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < eps);

// 契约M0：防恒绿自检
{
  const failBefore = fail;
  const savedLog = console.log;
  console.log = () => {};
  check("__selftest_fail__", false);
  console.log = savedLog;
  const counted = fail === failBefore + 1;
  fail = failBefore;
  check("契约M0 断言 harness 防恒绿自检（失败必被计数）", counted);
}

// ================= 静态服务器（与 trajectory-verify 同款） =================
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".glb": "model/gltf-binary", ".vrm": "model/gltf-binary" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/upload/image" && req.method === "POST") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ name: "mock.png", subfolder: "director_stage", type: "input" }));
    return;
  }
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
console.log("静态服务器端口:", port);

const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch({ channel: "chrome" })).catch(() => chromium.launch());
const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());

await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => !!window.__ds, null, { timeout: 10000 });
await page.waitForFunction(
  () => (window.__ds?.externalCharacters?.getAll?.().length ?? 0) >= 1,
  null, { timeout: 30000 }
);
await page.waitForFunction(() => typeof window.__ds?.exportTrajectoryMp4 === "function", null, { timeout: 15000 });

// 页面内小工具
await page.evaluate(() => {
  window.__t = {
    ac: () => window.__ds.cameraManager.getActiveCamera(),
    camPos: () => {
      const c = window.__ds.cameraManager.getActiveCamera().camera.position;
      return [c.x, c.y, c.z];
    },
    camQuat: () => {
      const q = window.__ds.cameraManager.getActiveCamera().camera.quaternion;
      return [q.x, q.y, q.z, q.w];
    },
    camFov: () => window.__ds.cameraManager.getActiveCamera().camera.fov,
    setCam: (px, py, pz, tx, ty, tz) => {
      const ac = window.__ds.cameraManager.getActiveCamera();
      ac.camera.position.set(px, py, pz);
      window.__ds__orbit.target.set(tx, ty, tz);
    },
  };
});

// ================= M1：UI 挂载 =================
console.log("\n--- M1 UI 挂载 ---");
const m1pre = await page.evaluate(() => ({
  btn: !!document.getElementById("btnExportVideo"),
  dlgDisplay: document.getElementById("mp4-export-dialog")?.style.display ?? "missing",
}));
check("M1a #btnExportVideo 顶栏按钮存在，对话框初始隐藏",
  m1pre.btn === true && (m1pre.dlgDisplay === "none" || m1pre.dlgDisplay === ""),
  JSON.stringify(m1pre));

await page.click("#btnExportVideo");
const m1open = await page.evaluate(() => {
  const dlg = document.getElementById("mp4-export-dialog");
  const res = document.getElementById("mp4-export-resolution");
  const fps = document.getElementById("mp4-export-fps");
  return {
    display: dlg?.style.display,
    resOpts: res ? [...res.options].map((o) => o.value) : [],
    fpsOpts: fps ? [...fps.options].map((o) => o.value) : [],
  };
});
check("M1b 点击按钮弹出对话框：分辨率 720p/1080p、fps 24/30/60",
  m1open.display === "block" &&
  m1open.resOpts.join() === "720p,1080p" &&
  m1open.fpsOpts.join() === "24,30,60",
  JSON.stringify(m1open));
await page.click("#mp4-export-dialog button:last-child"); // 取消
const m1closed = await page.evaluate(() => document.getElementById("mp4-export-dialog").style.display);
check("M1c 取消关闭对话框", m1closed === "none", `display=${m1closed}`);

// ================= 轨迹准备（2 点，duration=2s，linear/uniform） =================
console.log("\n--- 轨迹准备 ---");
await page.evaluate(() => {
  const ops = window.__ds.getTrajectoryUI()._ops;
  ops.createTrajectoryForActive();
  window.__t.setCam(2, 1.5, 4, 0, 1, 0);
});
await page.waitForTimeout(120);
await page.evaluate(() => window.__ds.getTrajectoryUI()._ops.recordPoint());
await page.evaluate(() => window.__t.setCam(-2, 2, 3, 0, 0.5, 0));
await page.waitForTimeout(120);
await page.evaluate(() => {
  const ops = window.__ds.getTrajectoryUI()._ops;
  ops.recordPoint();
  ops.updateGlobals({ duration: 2, curve: "linear", speed: "uniform" });
});
const trajInfo = await page.evaluate(() => {
  const t = window.__ds.cameraManager.getActiveCamera().trajectory;
  return { points: t.points.length, duration: t.duration, enabled: t.enabled !== false };
});
check("轨迹准备：2 点、duration=2s、enabled", trajInfo.points === 2 && trajInfo.duration === 2 && trajInfo.enabled,
  JSON.stringify(trajInfo));

// ================= M2：WebCodecs 环境探测 =================
console.log("\n--- M2 WebCodecs 探测 ---");
const m2 = await page.evaluate(async () => {
  if (typeof VideoEncoder === "undefined") return { webcodecs: false, h264: false };
  try {
    const s = await VideoEncoder.isConfigSupported({
      codec: "avc1.42001f", width: 1280, height: 720,
      bitrate: 5_000_000, framerate: 24, avc: { format: "avc" },
    });
    return { webcodecs: true, h264: !!s?.supported };
  } catch (e) {
    return { webcodecs: true, h264: false, err: String(e) };
  }
});
check("M2 环境探测完成（决定 M3 断言分支）", true,
  `WebCodecs=${m2.webcodecs} H264编码=${m2.h264}${m2.err ? " err=" + m2.err : ""}`);

// ================= M3：主路径 / 自动降级（2s×24fps=48 帧 720p） =================
console.log("\n--- M3 导出（主路径优先） ---");
// 反向探针：把相机摆到远离轨迹的姿态 + 记录导出前快照
await page.evaluate(() => window.__t.setCam(0, 3, 6, 0, 1, 0));
await page.waitForTimeout(120);
const m3pre = await page.evaluate(() => ({
  pos: window.__t.camPos(), quat: window.__t.camQuat(), fov: window.__t.camFov(),
  progress: window.__ds.trajectoryRuntime.progress,
}));

const m3 = await page.evaluate(async () => {
  window.__mp4OverlaySeen = null;
  const p = window.__ds.exportTrajectoryMp4({
    resolution: "720p", fps: 24, download: false,
    // 帧进度回调在遮罩存活期间必然触发（确定性，不靠墙钟）
    onProgress: (done, total) => {
      if (!window.__mp4OverlaySeen) {
        const el = document.getElementById("mp4-export-overlay");
        window.__mp4OverlaySeen = { exists: !!el, text: el?.textContent || "", done, total };
      }
    },
  });
  const result = await p;
  const overlayDuring = window.__mp4OverlaySeen?.exists === true;
  const overlayText = window.__mp4OverlaySeen?.text || "";
  const progressCb = window.__mp4OverlaySeen ? { done: window.__mp4OverlaySeen.done, total: window.__mp4OverlaySeen.total } : null;
  const overlayAfter = !!document.getElementById("mp4-export-overlay");
  if (!result?.ok) return { ok: false, reason: result?.reason, error: result?.error, overlayDuring, overlayText, overlayAfter };
  const buf = new Uint8Array(await result.blob.arrayBuffer());
  // base64 分块（避免 btoa 栈溢出）
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
  return {
    ok: true, path: result.path, mimeType: result.mimeType,
    frameCount: result.frameCount, fps: result.fps, width: result.width, height: result.height,
    size: buf.length, b64: btoa(bin),
    overlayDuring, overlayText, overlayAfter,
  };
});

check("M3a 导出返回 ok", m3.ok === true, m3.ok ? `path=${m3.path} size=${m3.size}` : JSON.stringify(m3));
check("M3b 导出中遮罩出现且带帧进度（onProgress 确定性采样）、结束后移除",
  m3.overlayDuring === true && /正在导出视频/.test(m3.overlayText) && m3.overlayAfter === false,
  `text="${m3.overlayText}"`);

if (m3.ok) {
  check("M3c 路径与探测一致（WebCodecs 可用→webcodecs，否则 mediarecorder 降级不崩）",
    m2.h264 ? m3.path === "webcodecs" : m3.path === "mediarecorder",
    `path=${m3.path} h264=${m2.h264}`);
  check("M3d Blob 大小 > 0", m3.size > 0, `${(m3.size / 1024).toFixed(1)} KB`);
  check("M3e 计划帧数=48（2s×24fps）", m3.frameCount === 48, `frameCount=${m3.frameCount}`);
  check("M3f 分辨率=1280×720", m3.width === 1280 && m3.height === 720, `${m3.width}x${m3.height}`);

  const buf = Buffer.from(m3.b64, "base64");
  if (m3.path === "webcodecs") {
    const ftyp = buf.subarray(4, 8).toString("latin1");
    check("M3g MP4 ftyp box 存在（offset 4）", ftyp === "ftyp", `bytes[4:8]=${ftyp}`);
    const stszIdx = buf.indexOf(Buffer.from("stsz", "latin1"));
    let sampleCount = -1;
    if (stszIdx > 0) sampleCount = buf.readUInt32BE(stszIdx + 12); // type 后 version/flags(4)+sample_size(4)+count(4)
    check("M3h stsz 样本数=48（实际编码帧数正确）", sampleCount === 48, `stsz@${stszIdx} samples=${sampleCount}`);
  } else {
    console.log("   （降级路径：跳过 ftyp/stsz 精确断言，webm/mp4 容器由 MediaRecorder 决定）");
  }
}

// 相机姿态 / 进度恢复
const m3post = await page.evaluate(() => ({
  pos: window.__t.camPos(), quat: window.__t.camQuat(), fov: window.__t.camFov(),
  progress: window.__ds.trajectoryRuntime.progress,
  orbitEnabled: window.__ds__orbit.enabled,
}));
check("M3i 导出后相机姿态恢复（position/quaternion/fov <1e-6）",
  approxVec(m3post.pos, m3pre.pos, 1e-6) && approxVec(m3post.quat, m3pre.quat, 1e-6) && approx(m3post.fov, m3pre.fov, 1e-9),
  `Δpos=${Math.hypot(m3post.pos[0]-m3pre.pos[0], m3post.pos[1]-m3pre.pos[1], m3post.pos[2]-m3pre.pos[2]).toExponential(2)}`);
check("M3j 导出后 progress 恢复、orbit 恢复启用",
  approx(m3post.progress, m3pre.progress, 1e-12) && m3post.orbitEnabled === true,
  `progress=${m3post.progress}（前=${m3pre.progress}）orbit=${m3post.orbitEnabled}`);

// ================= M4：强制降级路径（forceFallback） =================
console.log("\n--- M4 强制降级（MediaRecorder 实时录制，时长 2s） ---");
if (m2.h264) {
  await page.evaluate(() => window.__t.setCam(1, 2.5, 5, 0, 1, 0));
  await page.waitForTimeout(100);
  const m4pre = await page.evaluate(() => ({ pos: window.__t.camPos(), quat: window.__t.camQuat(), fov: window.__t.camFov() }));
  const m4 = await page.evaluate(async () => {
    const result = await window.__ds.exportTrajectoryMp4({ resolution: "720p", fps: 24, download: false, forceFallback: true });
    if (!result?.ok) return { ok: false, reason: result?.reason, error: result?.error };
    return { ok: true, path: result.path, mimeType: result.mimeType, size: result.blob.size };
  });
  check("M4a 强制降级：MediaRecorder 录制不崩、返回 ok", m4.ok === true, JSON.stringify(m4));
  if (m4.ok) {
    check("M4b 降级路径标记 path=mediarecorder、Blob size>0",
      m4.path === "mediarecorder" && m4.size > 0, `mime=${m4.mimeType} size=${(m4.size / 1024).toFixed(1)} KB`);
  }
  const m4post = await page.evaluate(() => ({ pos: window.__t.camPos(), quat: window.__t.camQuat(), fov: window.__t.camFov() }));
  check("M4c 降级导出后相机姿态恢复（<1e-6）",
    approxVec(m4post.pos, m4pre.pos, 1e-6) && approxVec(m4post.quat, m4pre.quat, 1e-6) && approx(m4post.fov, m4pre.fov, 1e-9));
} else {
  console.log("   （WebCodecs 不可用，M3 已经由降级路径覆盖，跳过 M4）");
}

// ================= M5：无轨迹/禁用 → 友好提示不崩 =================
console.log("\n--- M5 无轨迹友好路径 ---");
const m5 = await page.evaluate(async () => {
  const ops = window.__ds.getTrajectoryUI()._ops;
  ops.updateGlobals({ enabled: false }); // 禁用轨迹
  let r1, threw1 = null;
  try { r1 = await window.__ds.exportTrajectoryMp4({ resolution: "720p", fps: 24, download: false }); }
  catch (e) { threw1 = String(e); }
  ops.updateGlobals({ enabled: true });
  // 单点轨迹（删掉一个点）
  const pts = window.__ds.cameraManager.getActiveCamera().trajectory.points;
  const removed = pts.pop();
  window.dispatchEvent(new CustomEvent("ds-trajectory-changed"));
  let r2, threw2 = null;
  try { r2 = await window.__ds.exportTrajectoryMp4({ resolution: "720p", fps: 24, download: false }); }
  catch (e) { threw2 = String(e); }
  pts.push(removed); // 恢复
  window.dispatchEvent(new CustomEvent("ds-trajectory-changed"));
  return { r1, threw1, r2, threw2 };
});
check("M5a 轨迹禁用 → {ok:false, reason:no-trajectory} 不抛异常",
  m5.threw1 === null && m5.r1?.ok === false && m5.r1?.reason === "no-trajectory",
  JSON.stringify({ r1: m5.r1, threw: m5.threw1 }));
check("M5b 单点轨迹 → {ok:false} 不抛异常",
  m5.threw2 === null && m5.r2?.ok === false,
  JSON.stringify({ r2: m5.r2, threw: m5.threw2 }));

// ================= M6：页面零 JS 错误 =================
console.log("\n--- M6 页面错误 ---");
check("M6 页面零 JS 错误", errors.length === 0, errors.slice(0, 3).join(" | ") || "无");

// ================= 汇总 =================
console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
await browser.close();
server.close();
process.exit(fail > 0 ? 1 : 0);
