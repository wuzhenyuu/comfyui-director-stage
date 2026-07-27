/** clip-actions-verify.mjs — P3-2「模型自带骨骼动画接入动作预设」验收
 *
 * 背景：Xbot(7动画)/Soldier(4动画)/Michelle(2动画) 等 GLB 自带 AnimationClip，
 * 本特性把它们作为 clip: 前缀动作接入 ActionRuntime，由 AnimationMixer 直接驱动骨骼，
 * 播放期间冻结 IK 求解，停止时 IK 球同步到骨骼姿势无缝接管。
 *
 * 注意：GLTFLoader 会清洗节点名（mixamorig:Spine1 -> mixamorigSpine1），
 * 页面内骨骼查询一律用无冒号命名。
 *
 * 验收契约：
 *  1) 静态映射 Xbot.glb / Soldier.glb 可达
 *  2) 默认角色 Michelle 自动加载后 entry.animations=2 且 mixer 存在
 *  3) 加载 Xbot -> animations=7，mixer 存在；加载 mixamo-rigged（无动画）-> animations=0
 *  4) 动作下拉框存在「模型动画」分组，切换到 Xbot 后含 7 个 clip: 选项
 *  5) play clip:idle -> state.isClip=true/playing=true，entry._clipPlaying=true
 *  6) clip 驱动骨骼：0.6s 后 Spine1 四元数发生变化，state.time 推进
 *  7) clip 播放期间 ikTargets 冻结（target 世界坐标不变）
 *  8) pause -> 骨骼与 time 冻结；resume -> 继续
 *  9) speed=2 -> time 推进速度约为 1x 的两倍
 * 10) stop -> _clipPlaying=false，IK target 同步到腕骨世界坐标（距离<0.15m）
 * 11) oneshot clip（agree）播完自动回 stand
 * 12) 多角色隔离：Xbot 播 clip:walk（骨骼动）+ Michelle 播程序化 walk（IK target 动）同时进行
 * 13) sceneJSON 保存 clip 状态 -> reload + init 恢复 -> clip 续播且骨骼继续动
 * 14) 无动画角色（mixamo-rigged）play clip:xxx 返回 false，且 UI 无「模型动画」组
 * 15) 截图 test/out/clip-actions.png
 *
 * 用法: node clip-actions-verify.mjs
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
console.log("静态服务器端口:", port);

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};
const dist = (a, b) => (a && b) ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : Infinity;
const qdist = (a, b) => (a && b) ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]) : Infinity;

// ---- 契约 1：模型文件可达 ----
for (const name of ["Xbot.glb", "Soldier.glb"]) {
  const resp = await fetch(`http://127.0.0.1:${port}/director_stage/models/${name}`);
  const body = await resp.arrayBuffer().catch(() => new ArrayBuffer(0));
  check(`契约1 静态映射 ${name}`, resp.ok && body.byteLength > 1000000, `HTTP ${resp.status}, body=${body.byteLength}B`);
}

const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch({ channel: "chrome" }));
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());
await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => !!window.__ds, null, { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(1500);

// ================= 页面内工具函数（reload 后需重新注入） =================
async function injectHelpers() {
  await page.evaluate(() => {
    /** clip 状态（纯数据，避免 AnimationAction 循环引用序列化问题） */
    window.__testClipState = (entryId) => {
      const s = window.__ds?.getActionState?.(entryId);
      if (!s) return null;
      return {
        id: s.id ?? null,
        playing: s.playing ?? null,
        isClip: !!s.isClip,
        speed: s.speed ?? null,
        time: typeof s.time === "number" ? s.time : null,
        actionRunning: !!s._action?.isRunning?.(),
        actionPaused: !!s._action?.paused,
      };
    };
    /** 骨骼四元数（名字已被 GLTFLoader 清洗为无冒号） */
    window.__testBoneQuat = (entry, name) => {
      const bone = entry?.allBones?.find?.((b) => b.name === name);
      if (!bone) return null;
      const q = bone.quaternion;
      return [q.x, q.y, q.z, q.w];
    };
    /** 关节世界坐标 */
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
    /** IK target/pole 世界坐标 */
    window.__testIKTarget = (entry, chain) => {
      const t = entry?.ikTargets?.[chain];
      if (!t) return null;
      return {
        target: t.target ? [t.target.position.x, t.target.position.y, t.target.position.z] : null,
        pole: t.pole ? [t.pole.position.x, t.pole.position.y, t.pole.position.z] : null,
      };
    };
    /** clip 基本信息 */
    window.__testClipInfo = (entry) => ({
      animCount: entry?.animations?.length ?? -1,
      clipNames: (entry?.animations || []).map((c) => c.name),
      mixerExists: !!entry?.mixer,
      clipPlaying: entry?._clipPlaying === true,
    });
  });
}
await injectHelpers();

// ================= 契约 2：默认 Michelle 有动画 + mixer =================
await page.waitForFunction(() => (window.__ds?.externalCharacters?.getAll?.().length ?? 0) >= 1, null, { timeout: 30000 }).catch(() => {});
const michelleInfo = await page.evaluate(() => {
  const e = window.__ds.externalCharacters.getAll()[0];
  return e ? { id: e.id, ...window.__testClipInfo(e) } : null;
});
check("契约2 默认 Michelle 角色 animations=2 且 mixer 存在",
  !!michelleInfo && michelleInfo.animCount === 2 && michelleInfo.mixerExists,
  michelleInfo ? `${michelleInfo.id} clips=[${michelleInfo.clipNames}]` : "默认角色未加载");

// ================= 契约 3：加载 Xbot（7动画） =================
const xbotId = await page.evaluate(async () => {
  const mgr = window.__ds.externalCharacters;
  const e = await mgr.addGLB("/director_stage/models/Xbot.glb", "Xbot");
  if (e) mgr.setActive(e.id);
  return e?.id || null;
});
await page.waitForTimeout(500);
const xbotInfo = await page.evaluate((id) => {
  const e = window.__ds.externalCharacters.get(id);
  return e ? { ...window.__testClipInfo(e) } : null;
}, xbotId);
check("契约3a Xbot animations=7 且 mixer 存在",
  !!xbotInfo && xbotInfo.animCount === 7 && xbotInfo.mixerExists,
  xbotInfo ? `clips=[${xbotInfo.clipNames.join(",")}]` : "Xbot 未加载");

const riggedInfo = await page.evaluate(async () => {
  const mgr = window.__ds.externalCharacters;
  const e = await mgr.addGLB("/director_stage/models/mixamo-rigged-character.glb", "Rigged");
  const info = e ? { id: e.id, ...window.__testClipInfo(e) } : null;
  return info;
});
check("契约3b mixamo-rigged（对照组）animations=0",
  !!riggedInfo && riggedInfo.animCount === 0,
  riggedInfo ? `mixerExists=${riggedInfo.mixerExists}` : "加载失败");

// ================= 契约 4：UI 下拉框「模型动画」分组 =================
const uiGroups = await page.evaluate(async (ids) => {
  const mgr = window.__ds.externalCharacters;
  const sel = document.getElementById("ext-action-select");
  const read = () => {
    const groups = [...(sel?.querySelectorAll("optgroup") || [])].map((g) => ({
      label: g.label, count: g.querySelectorAll("option").length,
      values: [...g.querySelectorAll("option")].map((o) => o.value),
    }));
    return groups;
  };
  mgr.setActive(ids.rigged);
  window.dispatchEvent(new CustomEvent("ds-external-char-changed"));
  await new Promise((r) => setTimeout(r, 120));
  const noAnim = read();
  mgr.setActive(ids.xbot);
  window.dispatchEvent(new CustomEvent("ds-external-char-changed"));
  await new Promise((r) => setTimeout(r, 120));
  const withAnim = read();
  return { noAnim, withAnim };
}, { rigged: riggedInfo.id, xbot: xbotId });
const noAnimHasClipGroup = uiGroups.noAnim.some((g) => g.label === "模型动画");
const xbotClipGroup = uiGroups.withAnim.find((g) => g.label === "模型动画");
check("契约4 下拉框「模型动画」分组：无动画角色无此组，Xbot 有 7 个 clip: 选项",
  !noAnimHasClipGroup && !!xbotClipGroup && xbotClipGroup.count === 7 && xbotClipGroup.values.every((v) => v.startsWith("clip:")),
  `noAnim组=[${uiGroups.noAnim.map((g) => g.label)}] xbot模型动画=${xbotClipGroup?.count ?? "无"}`);

// ================= 契约 5/6/7：播放 clip:idle -> 骨骼动 + IK 冻结 =================
const playOk = await page.evaluate((id) => window.__ds.playAction(id, "clip:idle"), xbotId);
await page.waitForTimeout(150);
const st5 = await page.evaluate((id) => ({
  state: window.__testClipState(id),
  info: window.__testClipInfo(window.__ds.externalCharacters.get(id)),
}), xbotId);
check("契约5 play clip:idle -> isClip=true/playing=true/_clipPlaying=true/actionRunning",
  playOk === true && st5.state?.isClip && st5.state.playing && st5.info.clipPlaying && st5.state.actionRunning,
  JSON.stringify({ playOk, id: st5.state?.id, running: st5.state?.actionRunning }));

const before6 = await page.evaluate((id) => {
  const e = window.__ds.externalCharacters.get(id);
  return {
    quat: window.__testBoneQuat(e, "mixamorigSpine1"),
    ik: window.__testIKTarget(e, "rightArm"),
    time: window.__testClipState(id)?.time,
  };
}, xbotId);
await page.waitForTimeout(600);
const after6 = await page.evaluate((id) => {
  const e = window.__ds.externalCharacters.get(id);
  return {
    quat: window.__testBoneQuat(e, "mixamorigSpine1"),
    ik: window.__testIKTarget(e, "rightArm"),
    time: window.__testClipState(id)?.time,
  };
}, xbotId);
const quatFound6 = !!(before6.quat && after6.quat);
const dQuat = quatFound6 ? qdist(before6.quat, after6.quat) : -1;
const dTime = (after6.time ?? 0) - (before6.time ?? 0);
const dIK = dist(before6.ik?.target, after6.ik?.target);
check("契约6 clip 驱动骨骼：Spine1 四元数变化且 time 推进",
  quatFound6 && dQuat > 0.001 && dTime > 0.15,
  `Δquat=${dQuat < 0 ? "骨骼未找到(mixamorigSpine1)" : dQuat.toFixed(4)} Δtime=${dTime.toFixed(3)}`);
check("契约7 clip 播放期间 ikTargets 冻结（target 世界坐标不变）",
  dIK < 1e-6, `Δtarget=${dIK.toFixed(6)}`);

// ================= 契约 8：pause / resume =================
await page.evaluate((id) => window.__ds.pauseAction(id), xbotId);
const pauseA = await page.evaluate((id) => ({
  quat: window.__testBoneQuat(window.__ds.externalCharacters.get(id), "mixamorigSpine1"),
  time: window.__testClipState(id)?.time,
}), xbotId);
await page.waitForTimeout(500);
const pauseB = await page.evaluate((id) => ({
  quat: window.__testBoneQuat(window.__ds.externalCharacters.get(id), "mixamorigSpine1"),
  time: window.__testClipState(id)?.time,
}), xbotId);
const pauseFrozen = !!(pauseA.quat && pauseB.quat) && qdist(pauseA.quat, pauseB.quat) < 0.0005 && Math.abs((pauseB.time ?? 0) - (pauseA.time ?? 0)) < 0.05;
await page.evaluate((id) => window.__ds.resumeAction(id), xbotId);
await page.waitForTimeout(400);
const resumeC = await page.evaluate((id) => ({
  quat: window.__testBoneQuat(window.__ds.externalCharacters.get(id), "mixamorigSpine1"),
  time: window.__testClipState(id)?.time,
}), xbotId);
const resumeMoving = !!(pauseB.quat && resumeC.quat) && (qdist(pauseB.quat, resumeC.quat) > 0.0005 || (resumeC.time ?? 0) > (pauseB.time ?? 0) + 0.1);
check("契约8 pause 冻结骨骼/time，resume 继续", pauseFrozen && resumeMoving,
  `冻结Δquat=${(pauseA.quat && pauseB.quat) ? qdist(pauseA.quat, pauseB.quat).toFixed(5) : "骨骼未找到"} 恢复后Δtime=${((resumeC.time ?? 0) - (pauseB.time ?? 0)).toFixed(3)}`);

// ================= 契约 9：speed=2 -> time 两倍速 =================
await page.evaluate((id) => window.__ds.actionRuntime.setSpeed(id, 2), xbotId);
const spA = await page.evaluate((id) => window.__testClipState(id)?.time, xbotId);
await page.waitForTimeout(500);
const spB = await page.evaluate((id) => window.__testClipState(id)?.time, xbotId);
const speedRatio = ((spB ?? 0) - (spA ?? 0)) / 0.5;
check("契约9 speed=2 时 time 推进约 2x", speedRatio > 1.5 && speedRatio < 2.6, `实测 ${speedRatio.toFixed(2)}x`);
await page.evaluate((id) => window.__ds.actionRuntime.setSpeed(id, 1), xbotId);

// ================= 契约 10：stop -> IK 同步到骨骼姿势 =================
await page.evaluate((id) => window.__ds.stopAllActions(), xbotId);
await page.waitForTimeout(120);
const st10 = await page.evaluate((id) => {
  const e = window.__ds.externalCharacters.get(id);
  return {
    clipPlaying: e._clipPlaying === true,
    ik: window.__testIKTarget(e, "rightArm"),
    wrist: window.__testJointWorld(e, [4])?.[4],
    state: window.__testClipState(id),
  };
}, xbotId);
const syncDist = dist(st10.ik?.target, st10.wrist);
check("契约10 stop 后 _clipPlaying=false 且 IK target 同步到腕骨（<0.15m）",
  !st10.clipPlaying && syncDist < 0.15,
  `距离=${syncDist.toFixed(4)}m state=${st10.state?.id}/${st10.state?.isClip ? "clip" : "prog"}`);

// ================= 契约 11：oneshot clip（agree）播完自动回 stand =================
const agreeDuration = await page.evaluate((id) => {
  const e = window.__ds.externalCharacters.get(id);
  const c = e?.animations?.find((c) => c.name === "agree");
  return c?.duration ?? 0;
}, xbotId);
if (agreeDuration > 0) {
  await page.evaluate((id) => window.__ds.playAction(id, "clip:agree"), xbotId);
  await page.waitForTimeout(Math.ceil((agreeDuration + 1.5) * 1000));
  const st11 = await page.evaluate((id) => window.__testClipState(id), xbotId);
  check("契约11 oneshot clip(agree) 播完自动回 stand",
    st11?.id === "stand" && st11?.isClip === false,
    `duration=${agreeDuration.toFixed(2)}s 播放后 state=${st11?.id}`);
} else {
  check("契约11 oneshot clip(agree) 播完自动回 stand", false, "agree 动画不存在");
}

// ================= 契约 12：多角色隔离（clip + 程序化同时进行） =================
const michelleId = michelleInfo.id;
await page.evaluate(([xId, mId]) => {
  window.__ds.playAction(xId, "clip:walk");
  window.__ds.playAction(mId, "walk");
}, [xbotId, michelleId]);
const isoA = await page.evaluate(([xId, mId]) => {
  const xe = window.__ds.externalCharacters.get(xId);
  const me = window.__ds.externalCharacters.get(mId);
  return {
    xQuat: window.__testBoneQuat(xe, "mixamorigSpine1"),
    mIK: window.__testIKTarget(me, "rightLeg"),
  };
}, [xbotId, michelleId]);
await page.waitForTimeout(600);
const isoB = await page.evaluate(([xId, mId]) => {
  const xe = window.__ds.externalCharacters.get(xId);
  const me = window.__ds.externalCharacters.get(mId);
  return {
    xQuat: window.__testBoneQuat(xe, "mixamorigSpine1"),
    mIK: window.__testIKTarget(me, "rightLeg"),
  };
}, [xbotId, michelleId]);
const xQuatOk = !!(isoA.xQuat && isoB.xQuat);
const xMoving = xQuatOk && qdist(isoA.xQuat, isoB.xQuat) > 0.001;
const mMoving = dist(isoA.mIK?.target, isoB.mIK?.target) > 0.005;
check("契约12 多角色隔离：Xbot clip:walk 骨骼动 + Michelle 程序化 walk IK动（同时进行）",
  xMoving && mMoving,
  `XbotΔquat=${xQuatOk ? qdist(isoA.xQuat, isoB.xQuat).toFixed(4) : "骨骼未找到"} MichelleΔtarget=${dist(isoA.mIK?.target, isoB.mIK?.target).toFixed(4)}`);

// ================= 契约 13：sceneJSON 保存 clip 状态 -> reload 恢复续播 =================
await page.evaluate(([xId, mId]) => {
  window.__ds.playAction(xId, "clip:idle");
  window.__ds.playAction(mId, "stand");
}, [xbotId, michelleId]);
await page.waitForTimeout(300);
const snap13 = await page.evaluate((xId) => ({
  sceneJSON: window.__ds.getSceneJSON?.() ?? null,
  state: window.__testClipState(xId),
}), xbotId);
const xbotSaved = snap13.sceneJSON?.externalCharacters?.find?.((c) => c.id === xbotId);
check("契约13a sceneJSON 保存 clip 状态（action.id 以 clip: 开头且 playing=true）",
  !!xbotSaved?.action && String(xbotSaved.action.id).startsWith("clip:") && xbotSaved.action.playing === true,
  JSON.stringify(xbotSaved?.action ?? null));

await page.reload();
await page.waitForFunction(() => !!window.__ds, null, { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(1500);
await injectHelpers();
await page.evaluate((sceneJSON) => {
  window.postMessage({
    type: "init",
    payload: { width: 1024, height: 1024, sceneJSON: typeof sceneJSON === "string" ? sceneJSON : JSON.stringify(sceneJSON) },
  }, window.location.origin);
}, snap13.sceneJSON);
const restored = await page.waitForFunction(
  (n) => window.__ds?.externalCharacters?.getAll?.().length >= n,
  snap13.sceneJSON?.externalCharacters?.length ?? 3, { timeout: 30000 }
).then(() => true).catch(() => false);
const st13 = restored ? await page.evaluate((xId) => {
  const e = window.__ds.externalCharacters.get(xId);
  return {
    state: window.__testClipState(xId),
    quat: window.__testBoneQuat(e, "mixamorigSpine1"),
    exists: !!e,
  };
}, xbotId) : null;
await page.waitForTimeout(600);
const st13b = st13 ? await page.evaluate((xId) => {
  const e = window.__ds.externalCharacters.get(xId);
  return { quat: window.__testBoneQuat(e, "mixamorigSpine1") };
}, xbotId) : null;
const restoredMoving = (st13?.quat && st13b?.quat) ? qdist(st13.quat, st13b.quat) > 0.0005 : false;
check("契约13b reload 恢复后 clip:idle 续播且骨骼继续动",
  !!st13?.exists && st13.state?.id === "clip:idle" && st13.state.playing === true && restoredMoving,
  st13 ? `state=${st13.state?.id} playing=${st13.state?.playing} Δquat=${(st13.quat && st13b?.quat) ? qdist(st13.quat, st13b.quat).toFixed(4) : "骨骼未找到"}` : "角色未恢复");

// ================= 契约 14：无动画角色 play clip 返回 false =================
const st14 = await page.evaluate(async (rId) => {
  const mgr = window.__ds.externalCharacters;
  const e = mgr.get(rId);
  if (!e) return { ok: null, reason: "rigged 角色未恢复" };
  mgr.setActive(rId);
  window.dispatchEvent(new CustomEvent("ds-external-char-changed"));
  await new Promise((r) => setTimeout(r, 120));
  const ok = window.__ds.playAction(rId, "clip:idle");
  const sel = document.getElementById("ext-action-select");
  const hasClipGroup = !![...(sel?.querySelectorAll("optgroup") || [])].find((g) => g.label === "模型动画");
  return { ok, hasClipGroup, animCount: e.animations?.length ?? -1, mixer: !!e.mixer };
}, riggedInfo.id);
check("契约14 无动画角色 play clip:xxx 返回 false 且 UI 无「模型动画」组",
  st14.ok === false && st14.hasClipGroup === false,
  JSON.stringify(st14));

// ================= 契约 15：截图 =================
await page.evaluate((xId) => {
  const mgr = window.__ds.externalCharacters;
  if (mgr.get(xId)) mgr.setActive(xId);
  window.__ds.playAction(xId, "clip:walk");
}, xbotId).catch(() => {});
await page.waitForTimeout(700);
fs.mkdirSync(path.join(__dirname, "out"), { recursive: true });
await page.screenshot({ path: path.join(__dirname, "out", "clip-actions.png") });
check("契约15 截图 test/out/clip-actions.png", fs.existsSync(path.join(__dirname, "out", "clip-actions.png")));

// ---- 页面 JS 错误（参考，不单独计分）----
const realErrors = errors.filter((e) => !/favicon|404/.test(e));
console.log(realErrors.length ? `\n⚠️ 页面JS错误 ${realErrors.length} 条:` : "\n页面无 JS 错误");
realErrors.slice(0, 5).forEach((e) => console.log("  -", e.slice(0, 200)));

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
