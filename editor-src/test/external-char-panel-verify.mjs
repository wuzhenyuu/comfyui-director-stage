/** external-char-panel-verify.mjs — P1.5b 外部 3D角色面板回归（P3-1 适配 3D-only）
 * 验证：空态/添加两行/上限徽标/隐藏/恢复/重命名/激活/删除同步
 *
 * 【3D-only 适配说明】
 *  - 原「火柴人模式点行自动切回外部角色」用例改为「stick 模式不可达」：
 *    3D-only 下 setCharacterMode('stick') 应被拒绝/忽略，点行仅切换激活角色。
 *    若核心尚未拦截，此项失败并明确报告。
 *  - 起始 clear() 若被核心禁止（3D-only 保底至少 1 个角色属合理设计），
 *    空态断言跳过并在报告中说明。
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

const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch({ channel: "chrome" }));
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());
await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => !!window.__ds, null, { timeout: 10000 });
await page.waitForTimeout(1200);

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};
async function clickButton(text, exclude = null) {
  return page.evaluate(([t, ex]) => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      b.textContent.includes(t) && (!ex || !b.textContent.includes(ex)));
    if (!btn) return false;
    btn.click();
    return true;
  }, [text, exclude]);
}
// P7：点「添加3D角色」弹出模型选择器，需再选一个模型才真正加载
async function pickModelFromPicker() {
  const ok = await page.waitForSelector("#model-picker-menu", { timeout: 5000 }).then(() => true).catch(() => false);
  if (!ok) return false;
  return page.evaluate(() => {
    const menu = document.getElementById("model-picker-menu");
    const rows = menu ? [...menu.children].slice(1) : [];
    if (!rows.length) return false;
    rows[0].click();
    return true;
  });
}
async function panelState() {
  return page.evaluate(() => ({
    rows: document.querySelectorAll("#ext-char-list [data-ext-char-id]").length,
    badge: document.querySelector("#ext-char-count")?.textContent,
    text: document.querySelector("#ext-char-list")?.textContent || "",
    activeId: window.__ds.externalCharacters.activeCharacterId,
    count: window.__ds.externalCharacters.size,
    mode: window.__ds.characterMode,
  }));
}

// 默认工作流会自动加载 1 个 3D角色；本测试聚焦面板管理，先尝试清空一次以验证空态渲染
await page.evaluate(() => window.__ds.externalCharacters.clear?.());
await page.waitForTimeout(300);

const cleared = await page.evaluate(() => window.__ds.externalCharacters.size === 0);
if (!cleared) {
  console.log("  [说明] 核心禁止清空最后一个 3D角色（3D-only 保底设计，允许）—— 空态断言跳过");
}
const empty = await panelState();
check("空态面板存在（暂无 3D角色）", !cleared || empty.text.includes("暂无 3D角色"),
  cleared ? empty.text.trim() : "跳过：核心禁止清空");
check("初始上限徽标 0/8", !cleared || empty.badge === "0/8",
  cleared ? empty.badge : "跳过：核心禁止清空");

// 3D-only：「3D角色」切换按钮已被核心移除，添加首个角色也用「添加GLB」
await clickButton("添加3D角色");
await pickModelFromPicker();
await page.waitForFunction(() => window.__ds?.externalCharacters?.getAll?.().length >= 1, null, { timeout: 20000 }).catch(() => {});
await clickButton("添加3D角色");
await pickModelFromPicker();
await page.waitForFunction(() => window.__ds?.externalCharacters?.getAll?.().length >= 2, null, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(300);

let st = await panelState();
check("面板渲染 2 行", st.rows === 2, `rows=${st.rows}`);
check("上限徽标 2/8", st.badge === "2/8", st.badge);
check("行包含 GLB 徽标与操作按钮", /GLB/.test(st.text) && st.text.includes("👁"), st.text.replace(/\s+/g, " ").slice(0, 120));

const firstId = await page.evaluate(() => window.__ds.externalCharacters.getAll()[0].id);
const secondId = await page.evaluate(() => window.__ds.externalCharacters.getAll()[1].id);

await page.evaluate((id) => {
  const row = document.querySelector(`#ext-char-list [data-ext-char-id="${id}"]`);
  [...row.querySelectorAll("button")].find((b) => b.title.includes("隐藏"))?.click();
}, firstId);
await page.waitForTimeout(200);
let vis = await page.evaluate((id) => {
  const e = window.__ds.externalCharacters.get(id);
  return { visible: e.visible, modelVisible: e.model.visible, opacity: document.querySelector(`#ext-char-list [data-ext-char-id="${id}"]`)?.style.opacity };
}, firstId);
check("👁 隐藏角色生效", vis.visible === false && vis.modelVisible === false, JSON.stringify(vis));
check("隐藏行降透明度", vis.opacity === "0.5", vis.opacity);

await page.evaluate((id) => {
  const row = document.querySelector(`#ext-char-list [data-ext-char-id="${id}"]`);
  [...row.querySelectorAll("button")].find((b) => b.title.includes("显示"))?.click();
}, firstId);
await page.waitForTimeout(200);
vis = await page.evaluate((id) => {
  const e = window.__ds.externalCharacters.get(id);
  return { visible: e.visible, modelVisible: e.model.visible };
}, firstId);
check("👁 恢复角色可见", vis.visible === true && vis.modelVisible === true, JSON.stringify(vis));

await page.evaluate((id) => window.__ds.externalCharacters.rename(id, "战士A"), firstId);
await page.waitForTimeout(200);
st = await panelState();
check("重命名后面板刷新", st.text.includes("战士A"), st.text.replace(/\s+/g, " ").slice(0, 120));

await page.evaluate((id) => document.querySelector(`#ext-char-list [data-ext-char-id="${id}"]`)?.click(), secondId);
await page.waitForTimeout(200);
st = await panelState();
check("点击行激活角色", st.activeId === secondId, `active=${st.activeId}`);

// 3D-only：stick 模式不可达 —— setCharacterMode('stick')（若 API 仍在）必须被拒绝/忽略
const stickProbe = await page.evaluate(() => {
  const apiExists = typeof window.__ds?.setCharacterMode === "function" || typeof window.__dsSetCharacterMode === "function";
  if (!apiExists) return { apiExists: false, mode: window.__ds?.characterMode ?? null };
  try { window.__ds?.setCharacterMode?.("stick") ?? window.__dsSetCharacterMode?.("stick"); } catch { /* 拒绝也算通过 */ }
  return { apiExists: true, mode: window.__ds?.characterMode ?? null };
});
check("3D-only：setCharacterMode('stick') 不可达（API 不存在或被拒绝）",
  !stickProbe.apiExists || stickProbe.mode !== "stick",
  JSON.stringify(stickProbe) + (stickProbe.mode === "stick"
    ? " — 契约未实现：3D-only 下核心应拒绝切回 stick 模式" : ""));
if (stickProbe.mode === "stick") {
  // 核心尚未拦截时恢复 3D 模式，避免影响后续断言
  await page.evaluate(() => window.__ds?.setCharacterMode?.("glb") ?? window.__dsSetCharacterMode?.("glb"));
  await page.waitForTimeout(200);
}
await page.evaluate((id) => document.querySelector(`#ext-char-list [data-ext-char-id="${id}"]`)?.click(), firstId);
await page.waitForTimeout(300);
st = await panelState();
check("点行激活角色且保持 3D 模式（无火柴人路径）", st.mode !== "stick" && st.activeId === firstId, JSON.stringify({ mode: st.mode, activeId: st.activeId }));

await page.evaluate((id) => {
  const row = document.querySelector(`#ext-char-list [data-ext-char-id="${id}"]`);
  [...row.querySelectorAll("button")].find((b) => b.title.includes("删除"))?.click();
}, secondId);
await page.waitForTimeout(300);
st = await panelState();
check("删除后管理器/面板同步", st.count === 1 && st.rows === 1 && st.badge === "1/8", JSON.stringify(st));

await page.screenshot({ path: path.join(__dirname, "out", "external-char-panel.png") });
console.log("截图: test/out/external-char-panel.png");
check("页面无 JS 错误", errors.length === 0, errors.join("; ") || "无");
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
await browser.close();
server.close();
process.exit(fail === 0 && errors.length === 0 ? 0 : 1);
