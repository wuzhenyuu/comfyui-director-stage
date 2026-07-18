import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const URL = "http://localhost:4173/";
const OUT = path.resolve("test/out");
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
await page.setViewport({ width: 1280, height: 800 });

await page.evaluateOnNewDocument(() => {
  window.__gotReady = false;
  window.addEventListener("message", (ev) => {
    if (ev.data && ev.data.type === "ready") window.__gotReady = true;
  });
});

await page.goto(URL, { waitUntil: "networkidle0" });
await page.waitForFunction(() => window.__ds && document.querySelector("#viewport canvas"), { timeout: 10000 });
await new Promise((r) => setTimeout(r, 500));
const ready = await page.evaluate(() => window.__gotReady);

// 模拟宿主发 init：改导出分辨率 768x512 + 带 sceneGz（右腕抬高的姿势）做 gzip 往返验证
await page.evaluate(() => {
  const ds = window.__ds;
  ds.joints[4].position.set(-0.55, 1.85, 0.1);
  window.__gz = ds.encodeSceneGz();
  ds.joints[4].position.set(-0.7, 1.45, 0); // 先复位，验证 init 能恢复
  window.postMessage({ type: "init", payload: { width: 768, height: 512, sceneGz: window.__gz } }, "*");
});
await new Promise((r) => setTimeout(r, 400));

const state = await page.evaluate(() => {
  const ds = window.__ds;
  const p = ds.joints[4].position;
  const cv = document.querySelector("#viewport canvas");
  return {
    exportSize: ds.exportSize,
    cameraAspect: +ds.camera.aspect.toFixed(4),
    rWristRestored: [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)],
    viewportCss: [cv.clientWidth, cv.clientHeight],
    gzLen: window.__gz.length,
  };
});

const poseUrl = await page.evaluate(() => window.__ds.renderOpenPoseCanvas(...window.__ds.exportSize).toDataURL("image/png"));
const depthUrl = await page.evaluate(() => window.__ds.renderDepthCanvas(...window.__ds.exportSize).toDataURL("image/png"));
fs.writeFileSync(path.join(OUT, "openpose.png"), Buffer.from(poseUrl.split(",")[1], "base64"));
fs.writeFileSync(path.join(OUT, "depth.png"), Buffer.from(depthUrl.split(",")[1], "base64"));
await page.screenshot({ path: path.join(OUT, "viewport.png") });

console.log(JSON.stringify({ ready, state, errors }, null, 2));
await browser.close();
