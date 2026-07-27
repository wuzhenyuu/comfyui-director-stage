/** real-env-repro3.mjs — 真实环境复现：加载示例工作流 → 点「打开导演台」→ 查 iframe */
import { createRequire } from "module";
const require = createRequire("C:/Users/Administrator/AppData/Roaming/npm/node_modules/");
const { chromium } = require("playwright");
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "out");

const workflow = fs.readFileSync(path.resolve(__dirname, "../../examples/basic_openpose.json"), "utf-8");

const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch({ channel: "chrome" }));
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 400)));
const consoleErrs = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrs.push(m.text().slice(0, 250)); });

await page.goto("http://127.0.0.1:8388/", { waitUntil: "domcontentloaded" });
// 等 Vue 前端真正就绪：graph canvas 可见
await page.waitForSelector("canvas", { state: "visible", timeout: 60000 }).catch(() => {});
await page.waitForFunction(() => window.app?.graph && !document.querySelector(".comfy-loading, [class*='loading']"), null, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(12000); // 大量扩展初始化，保守等待

console.log("加载示例工作流…");
const loadResult = await page.evaluate(async (wf) => {
  try {
    await window.app.loadGraphData(JSON.parse(wf), true, true, "repro");
    await new Promise((r) => setTimeout(r, 1500));
    const nodes = (window.app.graph._nodes || []).map((n) => ({
      type: n.type,
      id: n.id,
      widgets: (n.widgets || []).map((w) => w.name),
    }));
    return { ok: true, nodes };
  } catch (e) { return { ok: false, err: String(e) }; }
}, workflow);
console.log("工作流:", JSON.stringify(loadResult, null, 1));

console.log("点击「打开导演台」…");
const clicked = await page.evaluate(() => {
  const node = (window.app.graph._nodes || []).find((n) => n.type === "DirectorStage");
  if (!node) return "no-node";
  const btn = (node.widgets || []).find((w) => (w.name || "").includes("打开导演台"));
  if (!btn) return "no-button widgets=" + JSON.stringify((node.widgets || []).map((w) => w.name));
  btn.callback();
  return "clicked";
});
console.log("按钮:", clicked);
await page.waitForTimeout(2000);

const overlay = await page.evaluate(() => {
  const ov = document.getElementById("director-stage-overlay");
  const iframe = ov?.querySelector("iframe");
  return { overlay: !!ov, src: iframe?.src || null };
});
console.log("overlay:", JSON.stringify(overlay));

let dsReady = false;
for (let i = 0; i < 25 && !dsReady; i++) {
  dsReady = await page.evaluate(() => {
    const iframe = document.querySelector("#director-stage-overlay iframe");
    try { return !!iframe?.contentWindow?.__ds; } catch { return false; }
  });
  if (!dsReady) await page.waitForTimeout(1000);
}
console.log("iframe __ds 就绪:", dsReady);

const iframeState = await page.evaluate(() => {
  const iframe = document.querySelector("#director-stage-overlay iframe");
  if (!iframe) return { err: "no iframe" };
  const doc = iframe.contentDocument;
  if (!doc) return { err: "no doc" };
  const vp = doc.getElementById("viewport");
  const win = iframe.contentWindow;
  return {
    viewport: vp ? { cw: vp.clientWidth, ch: vp.clientHeight } : null,
    canvasCount: vp ? vp.querySelectorAll("canvas").length : 0,
    dsLoaded: !!win.__ds,
    charCount: win.__ds?.externalCharacters?.getAll?.().length ?? null,
    renderMode: win.__ds?.renderMode ?? null,
  };
});
console.log("iframe 状态:", JSON.stringify(iframeState));

fs.mkdirSync(OUT, { recursive: true });
await page.screenshot({ path: path.join(OUT, "real-overlay.png") });
console.log("--- pageerror ---\n" + (pageErrors.join("\n") || "(无)"));
console.log("--- console.error 前10 ---\n" + (consoleErrs.slice(0, 10).join("\n") || "(无)"));
await browser.close();
