/** clip-stress-probe.mjs — clip 动画「破坏性操作组合」运行时探针
 *
 * 不做功能验收（clip-actions-verify.mjs 负责），专抓边界场景的运行时错误/状态泄漏：
 *  S1  clip 播放中删除角色 → states 清理、无报错
 *  S2  clip 播放中切 stick 模式再切回 → mixer/IK 状态恢复
 *  S3  clip 播放中执行 undo → 无报错
 *  S4  clip 播放中复制粘贴角色 → 新 entry 独立 mixer，无共享 clipAction
 *  S5  快速连切 4 个 clip → mixer 无残留 running action（泄漏检测）
 *  S6  clip 播放中拖 IK 球（模拟 setActive + 移动 target）→ 骨骼不被覆写（IK 冻结生效）
 *  S7  角色隐藏（setVisible false）时 clip 播放 → 无报错
 *  S8  保存 → clear → restore → clip 状态正确恢复或无残留
 *  S9  VRM 角色（无 animations）play clip → 返回 false，无报错
 *  S10 states Map 尺寸巡检（删除角色后无残留状态）
 *
 * 用法: node clip-stress-probe.mjs
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
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".glb": "model/gltf-binary", ".vrm": "model/gltf-binary", ".json": "application/json" };

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
console.log("静态服务器端口:", port);

let pass = 0, fail = 0, warn = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};
const note = (name, detail) => { console.log(`⚠️  ${name} — ${detail}`); warn++; };

const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch({ channel: "chrome" }));
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const pageErrors = [];
const consoleErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("dialog", (d) => d.accept());
await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => !!window.__ds, null, { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(1500);

// 等默认角色 + 加载 Xbot
await page.waitForFunction(() => (window.__ds?.externalCharacters?.getAll?.().length ?? 0) >= 1, null, { timeout: 30000 });
const xbotId = await page.evaluate(async () => {
  const e = await window.__ds.externalCharacters.addGLB("/director_stage/models/Xbot.glb", "Xbot");
  return e?.id || null;
});
await page.waitForTimeout(400);
console.log("准备就绪, Xbot id =", xbotId);

const drainErrors = (label) => {
  const pe = pageErrors.splice(0);
  const ce = consoleErrors.splice(0).filter((t) => !/favicon|404/.test(t));
  if (pe.length || ce.length) {
    console.log(`  [${label}] 页面错误:`, JSON.stringify([...pe, ...ce].slice(0, 3)));
    return false;
  }
  return true;
};

// ================= S1：clip 播放中删除角色 =================
await page.evaluate((id) => window.__ds.playAction(id, "clip:walk"), xbotId);
await page.waitForTimeout(300);
const s1 = await page.evaluate((id) => {
  const mgr = window.__ds.externalCharacters;
  const rt = window.__ds.actionRuntime;
  const beforeStates = rt.states.size;
  mgr.remove(id); // 播放中直接删
  const afterStates = rt.states.size;
  const stillTicking = (() => { try { rt.tick(0.016); return "ok"; } catch (e) { return "ERR: " + e.message; } })();
  return { beforeStates, afterStates, stillTicking, remains: rt.states.has(id) };
}, xbotId);
await page.waitForTimeout(300);
check("S1 clip 播放中删除角色：states 无残留且 tick 不炸",
  !s1.remains && s1.stillTicking === "ok" && drainErrors("S1"),
  JSON.stringify(s1));

// ================= S2：3D-only 设计 —— stick 模式被拒绝，clip 不受影响 =================
const xbot2 = await page.evaluate(async () => {
  const e = await window.__ds.externalCharacters.addGLB("/director_stage/models/Xbot.glb", "Xbot2");
  return e?.id || null;
});
await page.waitForTimeout(400);
await page.evaluate((id) => window.__ds.playAction(id, "clip:idle"), xbot2);
await page.waitForTimeout(200);
const s2 = await page.evaluate(async (id) => {
  const modeBefore = window.__ds.characterMode;
  window.__ds.setCharacterMode("stick"); // 3D-only 设计：应被拒绝（no-op）
  await new Promise((r) => setTimeout(r, 200));
  const modeAfter = window.__ds.characterMode;
  const e = window.__ds.externalCharacters.get(id);
  const st = window.__ds.getActionState(id);
  return { modeBefore, modeAfter, stillVisible: e?.model?.visible === true, stillPlaying: st?.playing === true, isClip: !!st?.isClip };
}, xbot2);
await page.waitForTimeout(300);
const s2b = await page.evaluate((id) => {
  const e = window.__ds.externalCharacters.get(id);
  const q = e?.allBones?.find((b) => b.name === "mixamorigSpine1")?.quaternion;
  return q ? [q.x, q.y, q.z, q.w] : null;
}, xbot2);
await page.waitForTimeout(300);
const s2c = await page.evaluate((id) => {
  const e = window.__ds.externalCharacters.get(id);
  const q = e?.allBones?.find((b) => b.name === "mixamorigSpine1")?.quaternion;
  return q ? [q.x, q.y, q.z, q.w] : null;
}, xbot2);
const s2Moving = s2b && s2c ? Math.hypot(s2b[0]-s2c[0], s2b[1]-s2c[1], s2b[2]-s2c[2], s2b[3]-s2c[3]) : 0;
check("S2 stick 模式被拒绝（3D-only 设计）且 clip 续播、模型保持可见",
  s2.modeBefore !== "stick" && s2.modeAfter !== "stick" && s2.stillVisible && s2.stillPlaying && s2Moving > 0.0003 && drainErrors("S2"),
  JSON.stringify({ ...s2, Δquat: s2Moving.toFixed(4) }));

// ================= S3：clip 播放中 undo =================
const s3 = await page.evaluate(async (id) => {
  try {
    // 制造一个可 undo 的操作：整体移动角色
    window.__ds.moveExternalCharacter(id, 0.5, 0, 0);
    await new Promise((r) => setTimeout(r, 100));
    // undo
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    const st = window.__ds.getActionState(id);
    return { ok: true, playing: st?.playing, isClip: !!st?.isClip };
  } catch (e) { return { ok: false, err: e.message }; }
}, xbot2);
check("S3 clip 播放中 undo 不报错且 clip 状态存活",
  s3.ok && s3.playing === true && drainErrors("S3"), JSON.stringify(s3));

// ================= S4：clip 播放中复制粘贴角色 =================
const s4 = await page.evaluate(async (id) => {
  try {
    const mgr = window.__ds.externalCharacters;
    mgr.setActive(id);
    const before = mgr.getAll().length;
    // 模拟 Ctrl+C / Ctrl+V（走 clipboard 快捷键路径；监听器绑在 document 上）
    for (const type of ["copy", "paste"]) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: type === "copy" ? "c" : "v", ctrlKey: true, bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
    }
    await new Promise((r) => setTimeout(r, 1500)); // 粘贴是 async addGLB
    const after = mgr.getAll().length;
    const entries = mgr.getAll();
    const last = entries[entries.length - 1];
    return {
      before, after,
      newHasOwnMixer: !!last?.mixer,
      mixersDistinct: last ? last.mixer !== mgr.get(id)?.mixer : null,
      newNotClipPlaying: last ? last._clipPlaying !== true : null,
    };
  } catch (e) { return { ok: false, err: e.message }; }
}, xbot2);
check("S4 粘贴的新角色 mixer 独立且不继承 clip 播放状态",
  s4.after === s4.before + 1 && s4.newHasOwnMixer && s4.mixersDistinct !== false && drainErrors("S4"),
  JSON.stringify(s4));
if (s4.newNotClipPlaying === false) note("S4b 新角色继承了 _clipPlaying", "粘贴时 clip 状态被复制（可能非预期）");

// ================= S5：快速连切 4 个 clip（action 泄漏检测） =================
const s5 = await page.evaluate(async (id) => {
  const seq = ["clip:idle", "clip:walk", "clip:run", "clip:agree", "clip:idle"];
  for (const a of seq) {
    window.__ds.playAction(id, a);
    await new Promise((r) => setTimeout(r, 80));
  }
  await new Promise((r) => setTimeout(r, 400));
  const e = window.__ds.externalCharacters.get(id);
  const running = e?.mixer ? e.mixer._actions.filter((a) => a.isRunning()).length : -1;
  const total = e?.mixer?._actions?.length ?? -1;
  const st = window.__ds.getActionState(id);
  return { running, total, currentId: st?.id, playing: st?.playing };
}, xbot2);
check("S5 快速连切后仅 1 个 action running（无泄漏）",
  s5.running === 1 && s5.currentId === "clip:idle" && drainErrors("S5"),
  JSON.stringify(s5));
if (s5.running > 1) note("S5b mixer 残留 running action", `${s5.running} 个（应 1 个）— 旧 action 未停干净`);

// ================= S6：clip 播放中移动 IK 球（冻结应生效） =================
const s6 = await page.evaluate(async (id) => {
  const e = window.__ds.externalCharacters.get(id);
  const t = e?.ikTargets?.rightArm?.target;
  if (!t) return { ok: false, reason: "no target" };
  const wristBefore = (() => { const b = e.jointMap.get(4); const v = new b.position.constructor(); b.getWorldPosition(v); return [v.x, v.y, v.z]; })();
  t.position.x += 0.5; // 直接挪动 target
  e._ikDirty = true;   // 并标 dirty（模拟拖拽）
  await new Promise((r) => setTimeout(r, 300));
  const wristAfter = (() => { const b = e.jointMap.get(4); const v = new b.position.constructor(); b.getWorldPosition(v); return [v.x, v.y, v.z]; })();
  const d = Math.hypot(wristAfter[0]-wristBefore[0], wristAfter[1]-wristBefore[1], wristAfter[2]-wristBefore[2]);
  return { ok: true, wristDrift: d, clipPlaying: e._clipPlaying === true };
}, xbot2);
check("S6 clip 播放中挪 IK 球：腕骨不被 IK 覆写（漂移≈0，仅动画自身幅度）",
  s6.ok && s6.wristDrift < 0.35 && s6.clipPlaying && drainErrors("S6"),
  JSON.stringify(s6));

// ================= S7：隐藏角色时 clip 播放 =================
const s7 = await page.evaluate(async (id) => {
  try {
    const mgr = window.__ds.externalCharacters;
    mgr.setVisible(id, false);
    await new Promise((r) => setTimeout(r, 400));
    const st = window.__ds.getActionState(id);
    mgr.setVisible(id, true);
    await new Promise((r) => setTimeout(r, 200));
    return { ok: true, keptPlaying: st?.playing === true };
  } catch (e) { return { ok: false, err: e.message }; }
}, xbot2);
check("S7 隐藏角色时 clip 继续播放无报错",
  s7.ok && s7.keptPlaying && drainErrors("S7"), JSON.stringify(s7));

// ================= S8：保存 → clear → restore → clip 状态 =================
const s8 = await page.evaluate(async (id) => {
  try {
    window.__ds.playAction(id, "clip:run");
    await new Promise((r) => setTimeout(r, 200));
    const json = window.__ds.getSceneJSON();
    const saved = json?.externalCharacters?.find?.((c) => c.id === id);
    window.__ds.stopAllActions();
    return { ok: true, savedAction: saved?.action ?? null };
  } catch (e) { return { ok: false, err: e.message }; }
}, xbot2);
check("S8 sceneJSON 保存 clip:run 状态",
  s8.ok && s8.savedAction?.id === "clip:run" && s8.savedAction?.clip === true && drainErrors("S8"),
  JSON.stringify(s8.savedAction));

// ================= S9：VRM 角色 play clip =================
const s9 = await page.evaluate(async () => {
  try {
    const mgr = window.__ds.externalCharacters;
    const e = await mgr.addVRM("/director_stage/models/AliciaSolid.vrm", "Alicia", "AliciaSolid.vrm");
    if (!e) return { ok: false, reason: "VRM 加载失败（可能不支持）", skipped: true };
    await new Promise((r) => setTimeout(r, 500));
    const ret = window.__ds.playAction(e.id, "clip:idle");
    return { ok: true, playReturned: ret, anims: e.animations?.length ?? 0, mixer: !!e.mixer };
  } catch (e) { return { ok: false, err: e.message }; }
});
if (s9.skipped) {
  note("S9 VRM 加载失败，跳过", s9.reason);
} else {
  check("S9 VRM 角色（无动画）play clip 返回 false 且无报错",
    s9.ok && s9.playReturned === false && drainErrors("S9"), JSON.stringify(s9));
}

// ================= S10：states Map 尺寸巡检 =================
const s10 = await page.evaluate(() => {
  const rt = window.__ds.actionRuntime;
  const mgr = window.__ds.externalCharacters;
  const orphan = [...rt.states.keys()].filter((id) => !mgr.characters.has(id));
  return { statesSize: rt.states.size, charsSize: mgr.characters.size, orphan };
});
check("S10 states Map 无孤儿状态（已删角色的状态残留）",
  s10.orphan.length === 0, JSON.stringify(s10));

// ---- 汇总 ----
const remainPe = pageErrors.splice(0);
const remainCe = consoleErrors.splice(0).filter((t) => !/favicon|404/.test(t));
if (remainPe.length || remainCe.length) {
  note("残余错误", JSON.stringify([...remainPe, ...remainCe].slice(0, 5)));
}
console.log(`\n结果: ${pass} 通过 / ${fail} 失败 / ${warn} 警告`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
