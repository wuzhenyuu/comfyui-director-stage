/** external-action-presets-verify.mjs — P3-0-B 「默认3D角色 + 骨骼显示 + 动作预设」验收（P3-1 适配 3D-only）
 *
 * 【3D-only 适配说明】本测试契约本就以 3D角色为中心（契约 2 已要求自动加载且非 stick 模式），
 * 无需结构性改动。降级路径（手动点「3D角色」按钮）在 3D-only 下按钮可能被移除，
 * 若自动加载未实现且按钮不存在，契约 2 失败信息即为核心待办。
 *
 * 本脚本只写测试，不改核心源码。核心未实现的契约点会失败并在输出中明确报告缺什么。
 *
 * 验收契约：
 *  1) 静态服务器映射 /director_stage/models/*.glb → assets/models（本脚本自带映射并验证可达；
 *     生产环境 ComfyUI 服务端也需同样映射）
 *  2) 打开页面后【不点击任何按钮】应自动加载默认 GLB 外部角色并进入 3D角色模式
 *     （__ds.externalCharacters.size >= 1 且 __ds.characterMode !== 'stick'）。
 *     若核心选择不自动加载 → 此契约失败，后续用例降级为手动点击「3D角色」按钮继续。
 *  3) 火柴人 figureGroup 隐藏、外部角色 model 可见、SkeletonHelper/骨骼线存在且可见
 *  4) 动作 UI 存在：idle/walk/run/wave/jump/stand/sit/crouch/lie/punch
 *     （[data-action-id="..."] 元素，或按钮文本匹配，支持中英文）
 *  5) 播放 walk：等待 500ms，active entry 的 action.time 增加，
 *     手腕/脚踝至少一个关节世界坐标发生周期性变化
 *  6) 暂停：action.time 基本不再增加
 *  7) 添加第二个 GLB，第一个播 walk、第二个播 wave：暂停第一个后，
 *     第一个 time/关节静止，第二个 time/关节继续动 → 两角色动作独立
 *  8) sceneJSON 保存 action state（id/playing/speed）；reload + init 后恢复
 *  9) 动作采样后的姿势反映在关节世界坐标上（openpose 导出的数据源）：
 *     同一动作不同采样时刻的腕/踝关节世界坐标不同
 * 10) 截图 test/out/external-action-presets.png
 *
 * ── 对核心 Agent 的接口要求（本测试按以下形状探测，均做容错读取）──────────
 *  A. 自动加载：fresh init（无 sceneJSON 恢复）时自动 loadGLB('/director_stage/models/michelle.glb')
 *     并 setCharacterMode('glb')。可配置开关，但默认开。
 *  B. SkeletonHelper：entry.skeletonHelper（THREE.SkeletonHelper，visible=true，已加入 scene）；
 *     或 scene 中可遍历到 isSkeletonHelper/type==='SkeletonHelper' 且 visible 的对象。
 *  C. 动作 UI：动作面板元素带 data-action-id="idle|walk|..."，或按钮文本含 动作名/中文。
 *  D. 动作状态（每个 entry，下列任一来源均可）：
 *       entry.actionState / entry.currentAction / __ds.getActionState(charId) / __ds.actionManager.getState(charId)
 *       形状：{ id:string, playing:boolean, speed:number, time:number }
 *       time 也可用 entry.threeAction / entry.animAction / state.action（THREE.AnimationAction）的 .time。
 *  E. 播放/暂停 API（UI 不可点时降级使用）：
 *       __ds.playAction(charId, actionId) / __ds.pauseAction(charId)
 *       或 entry.playAction(actionId) / entry.pauseAction()（或 entry.play/pause）
 *  F. sceneJSON：externalCharacters[i].action = { id, playing, speed }；init 恢复时还原。
 *
 * 用法: node external-action-presets-verify.mjs
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

// ---- 契约 1：静态服务器（自带映射，验证 /director_stage/models/*.glb 可达）----
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

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

const glbName = "michelle.glb";
const glbLocal = path.join(repoRoot, "assets/models", glbName);
const resp = await fetch(`http://127.0.0.1:${port}/director_stage/models/${glbName}`);
const body = await resp.arrayBuffer().catch(() => new ArrayBuffer(0));
check("契约1 静态映射 /director_stage/models/*.glb → assets/models",
  resp.ok && fs.existsSync(glbLocal) && body.byteLength > 0,
  `HTTP ${resp.status}, body=${body.byteLength}B`);

// ---- 启动浏览器，打开页面（不点任何按钮，先验证自动加载契约）----
const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch({ channel: "chrome" }));
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());
await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => !!window.__ds, null, { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(1500);

// ================= 页面内工具函数（每次 reload 后需重新注入） =================
async function injectHelpers() {
await page.evaluate(() => {
  /** 容错读取某 entry 的动作状态。返回 { found, id, playing, speed, time, source } */
  window.__testReadActionState = (entry) => {
    if (!entry) return { found: false, reason: "entry 为空" };
    const id = entry.id;
    const candidates = [];
    if (entry.actionState && typeof entry.actionState === "object") candidates.push(["entry.actionState", entry.actionState]);
    if (entry.currentAction && typeof entry.currentAction === "object") candidates.push(["entry.currentAction", entry.currentAction]);
    if (entry.action && typeof entry.action === "object" && ("id" in entry.action || "name" in entry.action) && !entry.action.isAnimationAction)
      candidates.push(["entry.action", entry.action]);
    const viaApi = window.__ds?.getActionState?.(id) || window.__ds?.actionManager?.getState?.(id);
    if (viaApi && typeof viaApi === "object") candidates.push(["__ds.getActionState", viaApi]);
    if (!candidates.length) return { found: false, reason: "entry 无 actionState/currentAction，__ds 无 getActionState（核心动作状态未挂载）" };
    const [source, st] = candidates[0];
    // time：优先 state.time，其次 THREE.AnimationAction
    let time = typeof st.time === "number" ? st.time : null;
    if (time === null) {
      const act = entry.threeAction || entry.animAction || st.action ||
        (entry.action && entry.action.isAnimationAction ? entry.action : null) ||
        (entry.mixer && entry.mixer._actions && entry.mixer._actions.find((a) => a.isRunning?.() || a.enabled));
      if (act && typeof act.time === "number") time = act.time;
    }
    return {
      found: true, source,
      id: st.id ?? st.name ?? st.actionId ?? null,
      playing: st.playing ?? st.isPlaying ?? null,
      speed: st.speed ?? st.timeScale ?? (st.action ? st.action.getEffectiveTimeScale?.() : null) ?? null,
      time,
    };
  };

  /** 读取 entry 的 COCO 关节世界坐标。joints: COCO index 数组 */
  window.__testJointWorld = (entry, joints) => {
    const out = {};
    for (const j of joints) {
      const bone = entry?.jointMap?.get?.(j);
      if (!bone) { out[j] = null; continue; }
      const v = new bone.position.constructor();
      bone.updateWorldMatrix(true, false);
      bone.getWorldPosition(v);
      out[j] = [v.x, v.y, v.z];
    }
    return out;
  };

  /** 在 scene 中查找可见的 SkeletonHelper（或挂在 entry 上的 skeletonHelper） */
  window.__testFindSkeletonHelpers = () => {
    const mgr = window.__ds?.externalCharacters;
    const entries = mgr?.getAll?.() || [];
    const perEntry = entries.map((e) => {
      const h = e.skeletonHelper || e.skelHelper || e.boneHelper || null;
      return { id: e.id, hasOwn: !!h, ownVisible: h?.visible ?? null, ownInScene: h ? !!h.parent : false };
    });
    const scene = window.__ds?.scene;
    let sceneHelpers = [];
    scene?.traverse?.((o) => {
      if (o.isSkeletonHelper || o.type === "SkeletonHelper" ||
          (o.isLineSegments && /skeleton|bone/i.test(o.name || ""))) {
        sceneHelpers.push({ name: o.name || o.type, visible: o.visible, isSkeletonHelper: !!o.isSkeletonHelper });
      }
    });
    return { perEntry, sceneHelpers };
  };
});
}
await injectHelpers();

// ---- 通用小工具 ----
async function clickButtonByText(txt, excludeTxt = null) {
  return page.evaluate(([t, ex]) => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      b.textContent.includes(t) && (!ex || !b.textContent.includes(ex)));
    if (!btn) return false;
    btn.click();
    return true;
  }, [txt, excludeTxt]);
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

const ACTION_IDS = ["idle", "walk", "run", "wave", "jump", "stand", "sit", "crouch", "lie", "punch"];
const ACTION_TEXT = {
  idle: ["idle", "待机"], walk: ["walk", "走路", "行走"], run: ["run", "跑步", "奔跑"],
  wave: ["wave", "挥手", "招手"], jump: ["jump", "跳跃", "跳"], stand: ["stand", "站立"],
  sit: ["sit", "坐下", "坐"], crouch: ["crouch", "蹲下", "蹲"], lie: ["lie", "躺下", "躺"],
  punch: ["punch", "出拳", "拳击", "拳"],
};

/** 探测动作 UI：返回 { byDataAttr: [...], byText: {actionId: bool} } */
async function probeActionUI() {
  return page.evaluate((ACTION_IDS) => {
    const dataEls = [...document.querySelectorAll("[data-action-id]")];
    const byDataAttr = [...new Set(dataEls.map((el) => el.dataset.actionId))];
    const clickables = [...document.querySelectorAll("button, [role='button'], [data-action-id]")];
    const byText = {};
    const TEXT = {
      idle: ["idle", "待机"], walk: ["walk", "走路", "行走"], run: ["run", "跑步", "奔跑"],
      wave: ["wave", "挥手", "招手"], jump: ["jump", "跳跃"], stand: ["stand", "站立"],
      sit: ["sit", "坐下"], crouch: ["crouch", "蹲下"], lie: ["lie", "躺下"], punch: ["punch", "出拳", "拳击"],
    };
    for (const id of ACTION_IDS) {
      const kws = TEXT[id] || [id];
      byText[id] = clickables.some((el) => {
        const t = (el.textContent || "").trim().toLowerCase();
        return t.length > 0 && t.length <= 12 && kws.some((k) => t.includes(k.toLowerCase()));
      });
    }
    return { byDataAttr, byText, dataAttrCount: dataEls.length };
  }, ACTION_IDS);
}

/** 触发动作：优先 [data-action-id]，其次文本按钮，最后 API。返回触发方式或 null */
async function triggerAction(charId, actionId) {
  // UI 触发只作用于活动角色；如果调用方指定了 charId，先模拟用户点击角色行激活它
  if (charId) {
    await page.evaluate((cid) => window.__ds?.externalCharacters?.setActive?.(cid), charId);
    await page.waitForTimeout(80);
  }
  // 1) data-action-id 元素
  const viaAttr = await page.evaluate((aid) => {
    const el = document.querySelector(`[data-action-id="${aid}"]`);
    if (!el) return false;
    el.click();
    return true;
  }, actionId);
  if (viaAttr) return "ui:data-action-id";
  // 2) 文本按钮
  const kws = ACTION_TEXT[actionId] || [actionId];
  const viaText = await page.evaluate((kws) => {
    const els = [...document.querySelectorAll("button, [role='button']")];
    const el = els.find((b) => {
      const t = (b.textContent || "").trim().toLowerCase();
      return t.length > 0 && t.length <= 12 && kws.some((k) => t.includes(k.toLowerCase()));
    });
    if (!el) return false;
    el.click();
    return true;
  }, kws);
  if (viaText) return "ui:text";
  // 3) API
  const viaApi = await page.evaluate(([cid, aid]) => {
    const mgr = window.__ds?.externalCharacters;
    const entry = cid ? mgr?.get?.(cid) : mgr?.getActive?.();
    if (typeof window.__ds?.playAction === "function") { window.__ds.playAction(cid, aid); return "api:__ds.playAction"; }
    if (typeof entry?.playAction === "function") { entry.playAction(aid); return "api:entry.playAction"; }
    if (typeof entry?.play === "function") { entry.play(aid); return "api:entry.play"; }
    return null;
  }, [charId, actionId]);
  return viaApi || null;
}

/** 暂停动作：优先暂停 UI，其次 API。返回触发方式或 null */
async function triggerPause(charId) {
  // UI 暂停只作用于活动角色；指定 charId 时先激活
  if (charId) {
    await page.evaluate((cid) => window.__ds?.externalCharacters?.setActive?.(cid), charId);
    await page.waitForTimeout(80);
  }
  const viaAttr = await page.evaluate(() => {
    const el = document.querySelector("[data-action-pause]") ||
      [...document.querySelectorAll("button, [role='button']")].find((b) => {
        const t = (b.textContent || "").trim().toLowerCase();
        return t.length <= 8 && (t.includes("暂停") || t.includes("pause") || t === "⏸" || t.includes("stop") || t.includes("停止"));
      });
    if (!el) return false;
    el.click();
    return true;
  });
  if (viaAttr) return "ui:pause";
  const viaApi = await page.evaluate((cid) => {
    const mgr = window.__ds?.externalCharacters;
    const entry = cid ? mgr?.get?.(cid) : mgr?.getActive?.();
    if (typeof window.__ds?.pauseAction === "function") { window.__ds.pauseAction(cid); return "api:__ds.pauseAction"; }
    if (typeof entry?.pauseAction === "function") { entry.pauseAction(); return "api:entry.pauseAction"; }
    if (typeof entry?.pause === "function") { entry.pause(); return "api:entry.pause"; }
    return null;
  }, charId);
  return viaApi || null;
}

const dist = (p, q) => (p && q ? Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) : 0);
/** 采样某 entry 的腕/踝关节世界坐标 n 次，返回样本数组 */
async function sampleJoints(entryId, n = 6, intervalMs = 150) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    const s = await page.evaluate(([id]) => {
      const mgr = window.__ds?.externalCharacters;
      const entry = id ? mgr?.get?.(id) : mgr?.getActive?.();
      if (!entry) return null;
      return { time: window.__testReadActionState(entry).time, joints: window.__testJointWorld(entry, [4, 7, 10, 13]) };
    }, [entryId]);
    samples.push(s);
    if (i < n - 1) await page.waitForTimeout(intervalMs);
  }
  return samples;
}
/** 样本中任一关节的最大位移 + 方向反转检测（周期性证据） */
function analyzeSamples(samples) {
  const jointIds = [4, 7, 10, 13];
  let maxDisp = 0, bestJoint = null, reversal = false;
  for (const j of jointIds) {
    const pts = samples.map((s) => s?.joints?.[j]).filter(Boolean);
    if (pts.length < 3) continue;
    for (let a = 0; a < pts.length; a++) {
      for (let b = a + 1; b < pts.length; b++) {
        const d = dist(pts[a], pts[b]);
        if (d > maxDisp) { maxDisp = d; bestJoint = j; }
      }
    }
    // 方向反转：相邻位移向量点积 < 0 → 存在往返运动（周期性证据）
    for (let i = 0; i + 2 < pts.length; i++) {
      const v1 = [pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1], pts[i + 1][2] - pts[i][2]];
      const v2 = [pts[i + 2][0] - pts[i + 1][0], pts[i + 2][1] - pts[i + 1][1], pts[i + 2][2] - pts[i + 1][2]];
      const dot = v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2];
      if (dot < -1e-8) { reversal = true; break; }
    }
  }
  return { maxDisp, bestJoint, reversal };
}

// ================= 契约 2：自动加载默认 3D角色（不点按钮） =================
const autoLoaded = await page.waitForFunction(
  () => (window.__ds?.externalCharacters?.size ?? window.__ds?.externalCharacters?.getAll?.().length ?? 0) >= 1
      && window.__ds?.characterMode && window.__ds.characterMode !== "stick",
  null, { timeout: 20000 }
).then(() => true).catch(() => false);
check("契约2 打开页面自动加载默认 GLB 并进入 3D角色模式", autoLoaded,
  autoLoaded ? "" : "20s 内 externalCharacters 为空或仍为 stick 模式 — 契约未实现：核心需在 fresh init 时自动 loadGLB 默认模型并 setCharacterMode('glb')");

// 降级：若未自动加载，手动点「3D角色」按钮让后续用例可继续
if (!autoLoaded) {
  console.log("  [降级] 手动点击「3D角色」按钮加载 GLB，继续后续用例…（3D-only 下按钮可能已移除，点不到则后续契约无法验证）");
  await clickButtonByText("3D角色", "添加");
  await page.waitForFunction(() => window.__ds?.isGLBMode === true, null, { timeout: 15000 }).catch(() => {});
}
const charReady = await page.evaluate(() =>
  (window.__ds?.externalCharacters?.getAll?.().length ?? 0) >= 1 && window.__ds?.characterMode !== "stick");
check("前置：至少一个外部角色且处于 3D角色模式（自动或降级手动）", charReady,
  charReady ? "" : "无法加载任何外部角色，后续契约全部无法验证");

// ================= 契约 3：火柴人隐藏 / model 可见 / SkeletonHelper 可见 =================
const vis = await page.evaluate(() => {
  const mgr = window.__ds?.externalCharacters;
  const active = mgr?.getActive?.() || mgr?.getAll?.()[0] || null;
  return {
    figureGroupVisible: window.__ds?.figureGroup?.visible ?? null,
    modelVisible: active?.model?.visible ?? null,
    helpers: window.__testFindSkeletonHelpers(),
  };
});
console.log("  可见性:", JSON.stringify(vis));
check("契约3a 火柴人 figureGroup 已隐藏", vis.figureGroupVisible === false,
  `figureGroup.visible=${vis.figureGroupVisible}`);
check("契约3b 外部角色 model 可见", vis.modelVisible === true, `model.visible=${vis.modelVisible}`);
const helperOk =
  (vis.helpers.perEntry.length > 0 && vis.helpers.perEntry.some((h) => h.hasOwn && h.ownVisible === true && h.ownInScene)) ||
  vis.helpers.sceneHelpers.some((h) => h.visible);
check("契约3c SkeletonHelper/骨骼线存在且可见", helperOk,
  helperOk ? JSON.stringify(vis.helpers.sceneHelpers.slice(0, 3))
    : "契约未实现：entry 无 skeletonHelper 且 scene 中未找到可见 SkeletonHelper — 核心需为外部角色添加 THREE.SkeletonHelper 并加入 scene");

// ================= 契约 4：动作 UI 存在 =================
const ui = await probeActionUI();
console.log("  动作 UI:", JSON.stringify(ui));
const uiFound = ACTION_IDS.filter((id) => ui.byDataAttr.includes(id) || ui.byText[id]);
check("契约4 动作 UI 存在（10 个动作预设）", uiFound.length === ACTION_IDS.length,
  uiFound.length === ACTION_IDS.length
    ? `方式=${ui.byDataAttr.length ? "data-action-id" : "文本"}`
    : `仅找到 [${uiFound.join(",")}]，缺 [${ACTION_IDS.filter((a) => !uiFound.includes(a)).join(",")}] — 核心需提供动作面板（data-action-id 或按钮文本）`);

// ================= 契约 5：播放 walk —— time 增加 + 关节周期性变化 =================
const activeId1 = await page.evaluate(() =>
  window.__ds?.externalCharacters?.activeCharacterId ?? window.__ds?.externalCharacters?.getAll?.()[0]?.id ?? null);
const playVia = charReady ? await triggerAction(activeId1, "walk") : null;
check("契约5a 可触发 walk 动作", !!playVia,
  playVia ? `触发方式=${playVia}` : "契约未实现：无 [data-action-id=\"walk\"]/文本按钮/__ds.playAction/entry.playAction");
let walkMoving = false, walkStateOk = false;
if (playVia) {
  await page.waitForTimeout(500); // 等动作跑起来
  const s1 = await page.evaluate((id) => {
    const mgr = window.__ds.externalCharacters;
    const e = id ? mgr.get(id) : mgr.getActive();
    return window.__testReadActionState(e);
  }, activeId1);
  const samples = await sampleJoints(activeId1, 6, 150); // ~750ms 采样窗口
  const s2 = await page.evaluate((id) => {
    const mgr = window.__ds.externalCharacters;
    const e = id ? mgr.get(id) : mgr.getActive();
    return window.__testReadActionState(e);
  }, activeId1);
  console.log("  walk 状态:", JSON.stringify({ s1, s2 }));
  walkStateOk = s1.found && s2.found && s1.time !== null && s2.time !== null && s2.time > s1.time + 0.1;
  check("契约5b action.time 随播放增加", walkStateOk,
    walkStateOk ? `time ${s1.time.toFixed(2)} → ${s2.time.toFixed(2)}`
      : `state=${JSON.stringify({ found1: s1.found, t1: s1.time, found2: s2.found, t2: s2.time, reason: s1.reason || s2.reason || "" })}`);
  const ana = analyzeSamples(samples);
  console.log("  关节采样:", JSON.stringify(ana));
  walkMoving = ana.maxDisp > 0.02;
  check("契约5c 手腕/脚踝至少一个关节世界坐标变化（>0.02m）", walkMoving,
    `maxDisp=${ana.maxDisp.toFixed(4)} joint=${ana.bestJoint}`);
  check("契约5d 关节运动呈周期性（存在方向反转）", ana.reversal,
    ana.reversal ? "检测到往返运动" : "750ms 内未检测到方向反转（可能动作未循环或未真正采样到骨骼）");
} else {
  check("契约5b action.time 随播放增加", false, "跳过：无法触发 walk");
  check("契约5c 手腕/脚踝至少一个关节世界坐标变化（>0.02m）", false, "跳过：无法触发 walk");
  check("契约5d 关节运动呈周期性（存在方向反转）", false, "跳过：无法触发 walk");
}

// ================= 契约 6：暂停 —— time 基本不再增加 =================
const pauseVia = playVia ? await triggerPause(activeId1) : null;
check("契约6a 可触发暂停", !!pauseVia,
  pauseVia ? `触发方式=${pauseVia}` : "契约未实现：无暂停按钮/__ds.pauseAction/entry.pauseAction");
if (pauseVia) {
  await page.waitForTimeout(200);
  const t1 = await page.evaluate((id) => {
    const e = window.__ds.externalCharacters.get(id) || window.__ds.externalCharacters.getActive();
    return window.__testReadActionState(e).time;
  }, activeId1);
  await page.waitForTimeout(600);
  const t2 = await page.evaluate((id) => {
    const e = window.__ds.externalCharacters.get(id) || window.__ds.externalCharacters.getActive();
    return window.__testReadActionState(e).time;
  }, activeId1);
  const frozen = t1 !== null && t2 !== null && Math.abs(t2 - t1) < 0.05;
  check("契约6b 暂停后 action.time 基本不再增加", frozen,
    `time ${t1?.toFixed?.(3)} → ${t2?.toFixed?.(3)}（Δ=${t1 !== null && t2 !== null ? Math.abs(t2 - t1).toFixed(4) : "n/a"}）`);
} else {
  check("契约6b 暂停后 action.time 基本不再增加", false, "跳过：无法触发暂停");
}

// ================= 契约 7：第二个 GLB，双角色动作独立 =================
const addedSecond = (await clickButtonByText("添加3D角色")) || (await clickButtonByText("添加GLB"));
if (addedSecond) await pickModelFromPicker(); // P7：选模型后才真正加载
if (!addedSecond) {
  check("契约7a 添加第二个 GLB", false, "未找到「添加GLB」按钮，契约7 无法验证");
  check("契约7b 两角色动作状态独立", false, "跳过");
  check("契约7c 暂停角色1后角色2继续动", false, "跳过");
} else {
  const twoReady = await page.waitForFunction(
    () => window.__ds?.externalCharacters?.getAll?.().length >= 2, null, { timeout: 20000 }
  ).then(() => true).catch(() => false);
  check("契约7a 添加第二个 GLB", twoReady, twoReady ? "" : "20s 内 externalCharacters 未达到 2");
  if (twoReady) {
    const [id1, id2] = await page.evaluate(() => window.__ds.externalCharacters.getAll().map((e) => e.id));
    // 角色1 播 walk，角色2 播 wave（通过 API 定向触发，避免 UI 只作用 active）
    const setRes = await page.evaluate(async ([i1, i2]) => {
      const mgr = window.__ds.externalCharacters;
      const play = (cid, aid) => {
        const e = mgr.get(cid);
        if (typeof window.__ds?.playAction === "function") return window.__ds.playAction(cid, aid) ?? true;
        if (typeof e?.playAction === "function") return e.playAction(aid) ?? true;
        if (typeof e?.play === "function") return e.play(aid) ?? true;
        return null;
      };
      const r1 = await play(i1, "walk");
      const r2 = await play(i2, "wave");
      return { r1: r1 !== null, r2: r2 !== null };
    }, [id1, id2]);
    // 若无 API，则降级用 UI（先激活对应角色再点）
    if (!setRes.r1 || !setRes.r2) {
      console.log("  [降级] 无定向 playAction API，尝试 UI 逐个激活后触发…");
      await page.evaluate((i) => { window.__ds.externalCharacters.activeCharacterId = i; document.querySelector(`#ext-char-list [data-ext-char-id="${i}"]`)?.click(); }, id1);
      await triggerAction(id1, "walk");
      await page.evaluate((i) => { window.__ds.externalCharacters.activeCharacterId = i; document.querySelector(`#ext-char-list [data-ext-char-id="${i}"]`)?.click(); }, id2);
      await triggerAction(id2, "wave");
    }
    await page.waitForTimeout(700);
    const dual = await page.evaluate(([i1, i2]) => {
      const mgr = window.__ds.externalCharacters;
      const s1 = window.__testReadActionState(mgr.get(i1));
      const s2 = window.__testReadActionState(mgr.get(i2));
      return { s1, s2 };
    }, [id1, id2]);
    console.log("  双角色状态:", JSON.stringify(dual));
    check("契约7b 两角色动作状态独立（id 不同：walk vs wave）",
      dual.s1.found && dual.s2.found && dual.s1.id !== dual.s2.id,
      `char1=${dual.s1.id}(${dual.s1.found ? "" : "state缺失"}) char2=${dual.s2.id}(${dual.s2.found ? "" : "state缺失"})`);

    // 暂停角色1 → 角色1 静止，角色2 继续
    const paused1 = await page.evaluate(async (i1) => {
      const e = window.__ds.externalCharacters.get(i1);
      if (typeof window.__ds?.pauseAction === "function") { window.__ds.pauseAction(i1); return true; }
      if (typeof e?.pauseAction === "function") { e.pauseAction(); return true; }
      if (typeof e?.pause === "function") { e.pause(); return true; }
      return false;
    }, id1);
    if (!paused1) {
      // 降级：激活角色1 后用全局暂停 UI
      await page.evaluate((i) => { window.__ds.externalCharacters.activeCharacterId = i; }, id1);
      const v = await triggerPause(id1);
      if (!v) console.log("  [警告] 角色1 无法暂停");
    }
    const before = await page.evaluate(([i1, i2]) => {
      const mgr = window.__ds.externalCharacters;
      return {
        t1: window.__testReadActionState(mgr.get(i1)).time,
        t2: window.__testReadActionState(mgr.get(i2)).time,
        j1: window.__testJointWorld(mgr.get(i1), [4, 10]),
        j2: window.__testJointWorld(mgr.get(i2), [4, 10]),
      };
    }, [id1, id2]);
    await page.waitForTimeout(600);
    const after = await page.evaluate(([i1, i2]) => {
      const mgr = window.__ds.externalCharacters;
      return {
        t1: window.__testReadActionState(mgr.get(i1)).time,
        t2: window.__testReadActionState(mgr.get(i2)).time,
        j1: window.__testJointWorld(mgr.get(i1), [4, 10]),
        j2: window.__testJointWorld(mgr.get(i2), [4, 10]),
      };
    }, [id1, id2]);
    const d1 = Math.max(dist(before.j1?.[4], after.j1?.[4]), dist(before.j1?.[10], after.j1?.[10]));
    const d2 = Math.max(dist(before.j2?.[4], after.j2?.[4]), dist(before.j2?.[10], after.j2?.[10]));
    const t1Frozen = before.t1 !== null && after.t1 !== null && Math.abs(after.t1 - before.t1) < 0.05;
    const t2Advancing = before.t2 !== null && after.t2 !== null && after.t2 > before.t2 + 0.1;
    console.log("  独立性: ", JSON.stringify({ d1, d2, t1: [before.t1, after.t1], t2: [before.t2, after.t2] }));
    check("契约7c 暂停角色1后：角色1 静止（time冻结+关节不动），角色2 继续（time增加+关节动）",
      t1Frozen && t2Advancing && d1 < 0.02 && d2 > 0.01,
      `char1 Δtime=${before.t1 !== null && after.t1 !== null ? Math.abs(after.t1 - before.t1).toFixed(3) : "n/a"} Δjoint=${d1.toFixed(4)} | char2 Δtime=${before.t2 !== null && after.t2 !== null ? (after.t2 - before.t2).toFixed(3) : "n/a"} Δjoint=${d2.toFixed(4)}`);
  } else {
    check("契约7b 两角色动作状态独立", false, "跳过：第二个角色未就绪");
    check("契约7c 暂停角色1后角色2继续动", false, "跳过：第二个角色未就绪");
  }
}

// ================= 契约 8：sceneJSON 保存/恢复 action state =================
const snap = await page.evaluate(() => ({
  sceneJSON: window.__ds.getSceneJSON?.() ?? null,
  states: (window.__ds?.externalCharacters?.getAll?.() || []).map((e) => {
    const s = window.__testReadActionState(e);
    return { charId: e.id, id: s.id, playing: s.playing, speed: s.speed, found: s.found };
  }),
}));
const jsonStr = snap.sceneJSON ? (typeof snap.sceneJSON === "string" ? snap.sceneJSON : JSON.stringify(snap.sceneJSON)) : "";
const jsonHasAction = /"action"\s*:|"actionState"\s*:|"actionId"\s*:/.test(jsonStr);
check("契约8a sceneJSON 包含 action state", !!snap.sceneJSON && jsonHasAction,
  jsonHasAction ? snap.states.map((s) => `${s.id}@${s.playing ? "play" : "pause"} x${s.speed}`).join(", ")
    : "契约未实现：sceneJSON 中未找到 action/actionState/actionId 字段 — 核心需序列化每角色 {id, playing, speed}");

await page.reload();
await page.waitForFunction(() => !!window.__ds, null, { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(1500);
await injectHelpers(); // reload 后页面上下文重置，必须重新注入
await page.evaluate((sceneJSON) => {
  window.postMessage({
    type: "init",
    payload: { width: 1024, height: 1024, sceneJSON: typeof sceneJSON === "string" ? sceneJSON : JSON.stringify(sceneJSON) },
  }, window.location.origin);
}, snap.sceneJSON);
const expectedRestoredCount = Array.isArray(snap.sceneJSON?.externalCharacters)
  ? snap.sceneJSON.externalCharacters.length
  : snap.states.length;
const restoredChars = await page.waitForFunction(
  (expected) => window.__ds?.externalCharacters?.getAll?.().length >= expected,
  expectedRestoredCount, { timeout: 30000 }
).then(() => true).catch(() => false);
const restoredStates = restoredChars ? await page.evaluate(() =>
  (window.__ds?.externalCharacters?.getAll?.() || []).map((e) => {
    const s = window.__testReadActionState(e);
    return { charId: e.id, id: s.id, playing: s.playing, speed: s.speed, found: s.found };
  })) : [];
console.log("  恢复前:", JSON.stringify(snap.states), " 恢复后:", JSON.stringify(restoredStates));
const restoreOk = snap.states.length > 0 && restoredStates.length >= snap.states.length &&
  snap.states.every((before, i) => {
    const after = restoredStates[i];
    if (!after?.found || !before.found) return false;
    const idOk = before.id === after.id;
    const playingOk = before.playing === after.playing;
    const speedOk = before.speed === null || after.speed === null || Math.abs(before.speed - after.speed) < 1e-6;
    return idOk && playingOk && speedOk;
  });
check("契约8b reload + init 后恢复 action id/playing/speed", restoreOk,
  restoreOk ? "" : `before=${JSON.stringify(snap.states)} after=${JSON.stringify(restoredStates)}${restoredChars ? "" : "（角色本身未恢复）"}`);

// ================= 契约 9：动作采样姿势反映到关节世界坐标（openpose 数据源） =================
// 恢复后若有播放中的动作，直接采样；否则重新播 walk
let exportOk = false;
const hasChar = await page.evaluate(() => (window.__ds?.externalCharacters?.getAll?.().length ?? 0) >= 1);
if (hasChar) {
  const rid = await page.evaluate(() => window.__ds.externalCharacters.getAll()[0].id);
  const st = await page.evaluate((id) => window.__testReadActionState(window.__ds.externalCharacters.get(id)), rid);
  if (!st.playing) await triggerAction(rid, "walk");
  await page.waitForTimeout(400);
  const poseA = await page.evaluate((id) => window.__testJointWorld(window.__ds.externalCharacters.get(id), [4, 7, 10, 13]), rid);
  await page.waitForTimeout(400);
  const poseB = await page.evaluate((id) => window.__testJointWorld(window.__ds.externalCharacters.get(id), [4, 7, 10, 13]), rid);
  const moved = [4, 7, 10, 13].some((j) => dist(poseA?.[j], poseB?.[j]) > 0.005);
  // openpose 导出（renderOpenPoseCanvasMulti → extractExternalJoints）消费的正是 jointMap 世界坐标，
  // 关节世界坐标随动作采样变化 ⇔ openpose 导出能反映动作姿势
  exportOk = moved;
  check("契约9 动作采样后的姿势反映在关节世界坐标上（openpose 导出数据源）", exportOk,
    exportOk ? "腕/踝关节世界坐标随采样时刻变化" : `两个采样时刻关节坐标无变化 poseA=${JSON.stringify(poseA)}`);
} else {
  check("契约9 动作采样后的姿势反映在关节世界坐标上（openpose 导出数据源）", false, "跳过：无可用角色");
}

// ================= 契约 10：截图 + JS 错误 =================
fs.mkdirSync(path.join(__dirname, "out"), { recursive: true });
await page.screenshot({ path: path.join(__dirname, "out", "external-action-presets.png") });
console.log("截图: test/out/external-action-presets.png");
check("页面无 JS 错误", errors.length === 0, errors.slice(0, 3).join(" | ") || "无");

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
await browser.close();
server.close();
process.exit(fail === 0 ? 0 : 1);
