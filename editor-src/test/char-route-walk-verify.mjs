/** char-route-walk-verify.mjs — V2-F3 人物行走路线集成验收探针
 *
 * 验收契约：
 *  1) __ds.charRoute = { setRoute, play, stop, isPlaying } 存在；setRoute 挂到角色 entry（sanitize 清洗）
 *  2) 路线 3D 常亮：绿色线 + 3 编号点标记（复用 F4 gizmo 机制，与时间轴开关无关）
 *  3) 角色面板「路线」页存在：点数/添加点/播放控件
 *  4) 播放：角色沿曲线移动（位置随时间推进），自动播 walk（有 clip 用 clip，否则程序化 walk）
 *  5) smoothHeading 平滑转向：L 形急转弯采样，相邻 100ms 转角 ≤ 上限+裕量
 *  6) loop=false 到终点停住：位置 = 末点，行走停止，动作回 stand
 *  7) seekTo 精确寻址（锚点过点）
 *  8) 路线点 gizmo 拖动：改点位置生效（ds-char-route-changed 广播）
 *  9) F0 旋转兼容：停止后 setCharacterRotation 生效不被回写
 * 10) 序列化往返：sceneJSON 带 route → reload + init → route 保留 + gizmo 常亮；
 *     旧工程无 route → 兼容（getRoute null，无错误）
 * 11) 与 trajectoryRuntime 共享 progress：相机轨迹播放 → 角色按同一进度行走；轨迹停 → 路线停
 * 12) 截图 test/out/char-route-walk.png；页面无 JS 错误
 *
 * 用法: node char-route-walk-verify.mjs
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
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".glb": "model/gltf-binary", ".vrm": "model/gltf-binary" };

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

const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch({ channel: "chrome" }));
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());

await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => !!window.__ds, null, { timeout: 10000 });
await page.waitForFunction(
  () => (window.__ds?.externalCharacters?.getAll?.().length ?? 0) >= 1,
  null, { timeout: 25000 }
);
await page.waitForTimeout(500);

// ================= 契约 1：API + setRoute =================
const setup = await page.evaluate(() => {
  const ds = window.__ds;
  const cr = ds.charRoute;
  const apiOk = cr && ["setRoute", "play", "stop", "isPlaying"].every((k) => typeof cr[k] === "function");
  const e = ds.externalCharacters.getActive();
  const ok = cr.setRoute(null, {
    points: [
      { position: [0, 0, 0], time: 0 },
      { position: [2, 0, 0], time: 0.5 },
      { position: [2, 0, 2], time: 1 },
    ],
    curve: "linear",
    duration: 2,
    loop: false,
  });
  const route = cr.getRoute(null);
  return {
    apiOk, ok, charId: e.id,
    pts: route?.points?.length,
    hasIds: route?.points?.every((p) => typeof p.id === "string"),
    clips: (e.animations || []).map((c) => c.name),
    modelPos: e.model.position.toArray(),
  };
});
check("契约1 __ds.charRoute API + setRoute 挂载（含 id 补全）",
  setup.apiOk && setup.ok && setup.pts === 3 && setup.hasIds,
  JSON.stringify({ pts: setup.pts, clips: setup.clips }));

// ================= 契约 2：路线 3D 常亮（gizmo 复用） =================
const giz = await page.evaluate(() => {
  const g = window.__ds.getTrajectoryUI().gizmo;
  const kids = g._group.children;
  const routeMarkers = kids.filter((c) => c.userData?.dsPoint?.source === "route");
  return {
    visible: g._group.visible,
    lines: kids.filter((c) => c.isLine).length,
    meshes: routeMarkers.filter((c) => c.isMesh).length,
    sprites: routeMarkers.filter((c) => c.isSprite).length,
    barOpen: document.getElementById("timeline-bar").style.display !== "none",
  };
});
check("契约2 路线 3D 常亮（时间轴未开也显示）+ 线 + 3 点标记",
  giz.visible && giz.lines >= 1 && giz.meshes === 3 && giz.sprites === 3 && !giz.barOpen,
  JSON.stringify(giz));

// ================= 契约 3：角色面板「路线」页 =================
const panel = await page.evaluate(() => {
  const root = document.getElementById("char-route-panel");
  return {
    exists: !!root,
    rows: root ? root.querySelectorAll("#route-play-btn").length : 0,
    status: root?.querySelector("#route-status")?.textContent || "",
    hasPlay: !!root?.querySelector("#route-play-btn"),
  };
});
check("契约3 角色面板「路线」页 + 播放控件 + 状态", panel.exists && panel.hasPlay && panel.status.includes("3"),
  JSON.stringify(panel));

// ================= 契约 4+5：播放 → 移动 + 自动 walk + 平滑转向 =================
const playStart = await page.evaluate(() => {
  const ds = window.__ds;
  const e = ds.externalCharacters.getActive();
  ds.stopAllActions();
  const ok = ds.charRoute.play(null);
  return {
    ok,
    playing: ds.charRoute.isPlaying(null),
    clips: (e.animations || []).map((c) => c.name),
  };
});
check("契约4 play 启动行走", playStart.ok && playStart.playing, JSON.stringify(playStart));
await page.waitForTimeout(150);
const walkState = await page.evaluate((charId) => {
  const st = window.__ds.getActionState(charId);
  return { id: st?.id, playing: st?.playing, isClip: !!st?.isClip };
}, setup.charId);
const walkOk = walkState.playing && (walkState.isClip ? /walk/i.test(walkState.id) : walkState.id === "walk");
check("契约4b 行走自动播 walk（clip 优先，回退程序化）", walkOk, JSON.stringify(walkState));

// 转向采样：每 100ms 记录 rot.y（L 形 90° 转弯在 t≈1s 处）
const rotSamples = [];
for (let i = 0; i < 14; i++) {
  const s = await page.evaluate(() => {
    const ds = window.__ds;
    const e = ds.externalCharacters.getActive();
    return {
      rotY: ds.getCharacterRotation(e.id)?.y,
      pos: e.model.position.toArray(),
      progress: ds.charRoute.getProgress(null),
      playing: ds.charRoute.isPlaying(null),
    };
  });
  rotSamples.push(s);
  await page.waitForTimeout(100);
}
// 移动距离
const movedDist = Math.hypot(
  rotSamples[6].pos[0] - setup.modelPos[0],
  rotSamples[6].pos[1] - setup.modelPos[1],
  rotSamples[6].pos[2] - setup.modelPos[2]);
check("契约4c 播放中角色沿路线移动", movedDist > 0.5, `700ms 移动 ${movedDist.toFixed(2)}m`);
// 平滑转向：相邻 100ms 转角 ≤ 45°（上限 6rad/s → 34° + 帧抖动裕量），且朝向确实变化（有转弯）
let maxDelta = 0;
let headingChanged = false;
for (let i = 1; i < rotSamples.length; i++) {
  const a = rotSamples[i - 1].rotY;
  const b = rotSamples[i].rotY;
  if (a == null || b == null) continue;
  let d = Math.abs(b - a) % 360;
  if (d > 180) d = 360 - d;
  maxDelta = Math.max(maxDelta, d);
}
const rotRange = Math.max(...rotSamples.map((s) => s.rotY ?? 0)) - Math.min(...rotSamples.map((s) => s.rotY ?? 0));
headingChanged = rotRange > 30;
check("契约5 smoothHeading 平滑转向（每 100ms ≤45°，且总转向 >30°）",
  maxDelta <= 45 && headingChanged, `maxDelta=${maxDelta.toFixed(1)}° range=${rotRange.toFixed(1)}°`);

// ================= 契约 6：loop=false 到终点停住 + 回 stand =================
await page.waitForTimeout(1200); // 全程 2s，前面已过 ~1.55s
const endState = await page.evaluate(() => {
  const ds = window.__ds;
  const e = ds.externalCharacters.getActive();
  return {
    playing: ds.charRoute.isPlaying(null),
    progress: ds.charRoute.getProgress(null),
    pos: e.model.position.toArray(),
    action: window.__ds.getActionState(e.id),
  };
});
const atEnd = Math.hypot(endState.pos[0] - 2, endState.pos[1] - 0, endState.pos[2] - 2);
check("契约6 到终点停住（isPlaying=false，位置=末点）",
  !endState.playing && endState.progress === 1 && atEnd < 0.1,
  `pos=${endState.pos.map((v) => v.toFixed(2))} atEnd=${atEnd.toFixed(3)}`);
await page.waitForTimeout(600);
const settled = await page.evaluate(() => {
  const ds = window.__ds;
  const e = ds.externalCharacters.getActive();
  const st = ds.getActionState(e.id);
  return { pos: e.model.position.toArray(), actionId: st?.id, actionPlaying: st?.playing };
});
const stillAtEnd = Math.hypot(settled.pos[0] - 2, settled.pos[1] - 0, settled.pos[2] - 2);
check("契约6b 停住不漂移 + 动作回 stand",
  stillAtEnd < 0.1 && (settled.actionId === "stand" || !settled.actionPlaying),
  JSON.stringify(settled));

// ================= 契约 7：seekTo 锚点过点 =================
const seek = await page.evaluate(() => {
  const ds = window.__ds;
  ds.charRoute.seekTo(null, 0.5); // 线性路线锚点 → 拐点 [2,0,0]
  const e = ds.externalCharacters.getActive();
  const pos = e.model.position.toArray();
  const rotY = ds.getCharacterRotation(e.id)?.y;
  ds.charRoute.stop(null);
  return { pos, rotY, progress: ds.charRoute.getProgress(null) };
});
check("契约7 seekTo(0.5) 精确到锚点（线性路线拐点）",
  Math.hypot(seek.pos[0] - 2, seek.pos[1], seek.pos[2]) < 0.05 && seek.progress === 0.5,
  JSON.stringify(seek));

// ================= 契约 8：路线点 gizmo 拖动 =================
const routeDrag = await page.evaluate(() => {
  const ds = window.__ds;
  const g = ds.getTrajectoryUI().gizmo;
  let routeEvent = 0;
  const onCh = () => routeEvent++;
  window.addEventListener("ds-char-route-changed", onCh, { once: true });
  g.select("route", 2, "pos");
  g._tctrl.dispatchEvent({ type: "dragging-changed", value: true });
  g._proxy.position.set(2, 0, 4);
  g._tctrl.dispatchEvent({ type: "objectChange" });
  g._tctrl.dispatchEvent({ type: "dragging-changed", value: false });
  const pt = ds.charRoute.getRoute(null)?.points?.[2]?.position;
  g.clearSelection();
  // 拖完 seek 到新末点验证
  ds.charRoute.seekTo(null, 1);
  const e = ds.externalCharacters.getActive();
  const endPos = e.model.position.toArray();
  ds.charRoute.stop(null);
  return { pt, routeEvent, endPos };
});
check("契约8 路线点 gizmo 拖动改点 + 广播 + 插值跟随",
  routeDrag.pt && Math.abs(routeDrag.pt[2] - 4) < 1e-6 && routeDrag.routeEvent === 1 &&
  Math.hypot(routeDrag.endPos[0] - 2, routeDrag.endPos[1], routeDrag.endPos[2] - 4) < 0.05,
  JSON.stringify(routeDrag));

// ================= 契约 9：F0 旋转兼容（停止后可手动旋转） =================
const f0 = await page.evaluate(() => {
  const ds = window.__ds;
  ds.setCharacterRotation({ y: 45 });
  const r = ds.getCharacterRotation();
  return { y: r?.y };
});
check("契约9 F0 旋转兼容（行走停止后手动旋转不被回写）", Math.abs(f0.y - 45) < 1, JSON.stringify(f0));

// ================= 契约 10：序列化往返 + 旧工程兼容 =================
const ser = await page.evaluate(() => {
  const sceneJSON = window.__ds.getSceneJSON();
  const route = sceneJSON?.externalCharacters?.[0]?.route;
  return {
    hasRoute: !!route,
    pts: route?.points?.length,
    curve: route?.curve,
    duration: route?.duration,
    sceneGz: window.__ds.encodeSceneGz(),
    sceneJSON,
  };
});
check("契约10 sceneJSON 含 route（3 点/linear/duration=2）",
  ser.hasRoute && ser.pts === 3 && ser.curve === "linear" && ser.duration === 2,
  JSON.stringify({ pts: ser.pts, curve: ser.curve, duration: ser.duration }));

await page.reload();
await page.waitForFunction(() => !!window.__ds, null, { timeout: 10000 });
await page.evaluate(({ sceneGz, sceneJSON }) => {
  window.postMessage({
    type: "init",
    payload: { width: 1024, height: 1024, sceneGz, sceneJSON: JSON.stringify(sceneJSON) },
  }, window.location.origin);
}, ser);
await page.waitForFunction(
  () => (window.__ds?.externalCharacters?.getAll?.().length ?? 0) >= 1,
  null, { timeout: 25000 }
);
await page.waitForTimeout(600);
const restored = await page.evaluate(() => {
  const ds = window.__ds;
  const route = ds.charRoute.getRoute(null);
  const g = ds.getTrajectoryUI().gizmo;
  const routeMarkers = g._group.children.filter((c) => c.userData?.dsPoint?.source === "route");
  return {
    pts: route?.points?.length,
    endPt: route?.points?.[2]?.position,
    gizmoVisible: g._group.visible,
    markers: routeMarkers.filter((c) => c.isMesh).length,
  };
});
check("契约10b 恢复后 route 保留（含拖动的末点 [2,0,4]）+ gizmo 常亮",
  restored.pts === 3 && restored.endPt && Math.abs(restored.endPt[2] - 4) < 1e-4 &&
  restored.gizmoVisible && restored.markers === 3,
  JSON.stringify(restored));

// 旧工程无 route 兼容
const legacy = await page.evaluate(({ sceneGz, sceneJSON }) => {
  const sj = JSON.parse(JSON.stringify(sceneJSON));
  for (const c of sj.externalCharacters || []) delete c.route;
  window.postMessage({
    type: "init",
    payload: { width: 1024, height: 1024, sceneGz, sceneJSON: JSON.stringify(sj) },
  }, window.location.origin);
  return true;
}, ser);
await page.waitForFunction(
  () => (window.__ds?.externalCharacters?.getAll?.().length ?? 0) >= 1 &&
    !window.__ds.externalCharacters.getActive()?.route,
  null, { timeout: 25000 }
);
await page.waitForTimeout(400);
const legacyOk = await page.evaluate(() => ({
  route: window.__ds.charRoute.getRoute(null),
  gizmoVisible: window.__ds.getTrajectoryUI().gizmo._group.visible,
}));
check("契约10c 旧工程无 route 兼容（getRoute=null，gizmo 隐藏，无错误）",
  legacyOk.route === null && legacyOk.gizmoVisible === false, JSON.stringify(legacyOk));

// ================= 契约 11：与 trajectoryRuntime 共享 progress（follow 联动） =================
const follow = await page.evaluate(() => {
  const ds = window.__ds;
  // 重建路线 + 相机轨迹（2 点，duration 2s）
  ds.charRoute.setRoute(null, {
    points: [{ position: [0, 0, 0], time: 0 }, { position: [3, 0, 0], time: 1 }],
    curve: "linear", duration: 99, loop: false, // duration 故意设大：follow 时进度由轨迹驱动
  });
  ds.charRoute.seekTo(null, 0);
  const ui = ds.getTrajectoryUI();
  ui._ops.createTrajectoryForActive();
  const ac = ds.cameraManager.getActiveCamera();
  ui._ops.mutate("follow 测试", () => {
    ac.trajectory.duration = 2;
    ac.trajectory.points.push(
      { id: "t0", position: [0, 2, 5], target: [0, 1, 0], fov: 50, time: 0, track: null },
      { id: "t1", position: [3, 2, 5], target: [0, 1, 0], fov: 50, time: 1, track: null });
  });
  const played = ds.playTrajectory();
  return { played };
});
check("契约11 相机轨迹可播放（follow 前提）", follow.played === true, JSON.stringify(follow));
await page.waitForTimeout(600);
const followMid = await page.evaluate(() => {
  const ds = window.__ds;
  return {
    trajProgress: ds.trajectoryRuntime.progress,
    routeProgress: ds.charRoute.getProgress(null),
    routePlaying: ds.charRoute.isPlaying(null),
    charX: ds.externalCharacters.getActive().model.position.x,
  };
});
check("契约11b 轨迹播放 → 角色按同一 progress 行走",
  followMid.routePlaying && Math.abs(followMid.routeProgress - followMid.trajProgress) < 0.03 &&
  followMid.charX > 0.3,
  JSON.stringify(followMid));
await page.evaluate(() => window.__ds.stopTrajectory());
await page.waitForTimeout(300);
const followStop = await page.evaluate(() => ({
  routePlaying: window.__ds.charRoute.isPlaying(null),
  trajPlaying: window.__ds.trajectoryRuntime.playing,
}));
check("契约11c 轨迹停 → 路线自动停", !followStop.routePlaying && !followStop.trajPlaying, JSON.stringify(followStop));

// ================= 收尾 =================
await page.screenshot({ path: path.join(__dirname, "out", "char-route-walk.png") });
check("页面无 JS 错误", errors.length === 0, errors.slice(0, 3).join(" | ") || "无");

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
