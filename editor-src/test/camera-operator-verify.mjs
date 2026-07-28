/** camera-operator-verify.mjs — V2-F1 WASD 掌镜打点 验证套件
 *
 * 依据：projects/director-stage-review/camera-trajectory/DESIGN-V2.md F1
 * 契约：
 *  C1  入口：顶栏 #btnPilot + __ds.cameraOperator 钩子（enter/exit/isActive/isDegraded/recordPoint/toggleLock）
 *  C2  [反向] 进入前 isActive=false、orbit.enabled=true
 *  C3  enter → isActive、HUD 显示、orbit 禁用；headless 无 pointer lock → 优雅降级
 *      （不崩 + console.warn + isDegraded()=true；若环境拿到锁则跳过降级断言）
 *  C4  WASD 平移 + E 升降（键盘事件驱动相机位移）
 *  C5  滚轮调 FOV（cam.fov 变化 + focalMM 同步）
 *  C6  Enter 打点：自动建轨迹、字段 {id,position,target(视线前方5m),fov,time,track:null}、时间均分 retime
 *  C7  F 锁定：准星 raycast 命中道具 → lockedTarget；A/D 环绕（半径不变）、W 推拉（半径减小）；
 *      锁定中打点 track={kind:'prop',id}；解锁后 lockedTarget=null
 *  C8  空格播停（无角色场景不崩）
 *  C9  轨迹播放中 enter → 轨迹自动暂停
 *  C10 exit → orbit 恢复原值、HUD 隐藏；Esc 键路径同样退出
 *  C11 页面零 JS 错误
 *
 * 用法: node camera-operator-verify.mjs
 */
import { createRequire } from "module";
const require = createRequire("C:/Users/Administrator/AppData/Roaming/npm/node_modules/");
const { chromium } = require("playwright");
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "../../web/editor");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const file = path.join(webRoot, p);
  if (!file.startsWith(webRoot) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch({ channel: "chrome" }));
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
const warns = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "warning") warns.push(m.text()); });
await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForTimeout(1500);

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const approxVec = (a, b, eps = 1e-3) =>
  !!a && !!b && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < eps);
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// ================= C1：入口与钩子 =================
console.log("\n--- C1 入口与 __ds 钩子 ---");
const c1 = await page.evaluate(() => {
  const btn = document.getElementById("btnPilot");
  const op = window.__ds?.cameraOperator;
  return {
    btnExists: !!btn,
    btnText: btn?.textContent || "",
    apiExists: !!op,
    fns: op ? ["enter", "exit", "isActive", "isDegraded", "recordPoint", "toggleLock"]
      .every((k) => typeof op[k] === "function") : false,
  };
});
check("C1a 顶栏「🎥 掌镜」按钮存在", c1.btnExists && c1.btnText.includes("掌镜"), c1.btnText);
check("C1b __ds.cameraOperator 钩子完整", c1.apiExists && c1.fns);

// ================= C2：[反向] 进入前状态 =================
const c2 = await page.evaluate(() => ({
  active: window.__ds.cameraOperator.isActive(),
  orbitEnabled: window.__ds__orbit.enabled,
}));
check("C2 [反向] 进入前 isActive=false、orbit.enabled=true",
  c2.active === false && c2.orbitEnabled === true, JSON.stringify(c2));

// ================= C3：enter → HUD / orbit 禁用 / 降级 =================
console.log("\n--- C3 进入掌镜 ---");
const c3 = await page.evaluate(() => {
  const ok = window.__ds.cameraOperator.enter();
  return {
    ok,
    active: window.__ds.cameraOperator.isActive(),
    hudShown: document.getElementById("pilot-hud")?.style.display === "block",
    crosshair: !!document.getElementById("pilot-crosshair"),
    hint: !!document.getElementById("pilot-hint"),
    orbitEnabled: window.__ds__orbit.enabled,
  };
});
check("C3a enter → isActive=true、HUD(准星+提示条)显示、orbit.enabled=false",
  c3.ok === true && c3.active === true && c3.hudShown && c3.crosshair && c3.hint && c3.orbitEnabled === false,
  JSON.stringify(c3));

// 等 600ms 让 pointer lock 兜底探测（400ms 定时器）生效
await page.waitForTimeout(600);
const c3b = await page.evaluate(() => ({
  lockHeld: !!document.pointerLockElement,
  degraded: window.__ds.cameraOperator.isDegraded(),
}));
if (c3b.lockHeld) {
  check("C3b 环境持有 pointer lock（非降级路径）", true, "lockHeld=true");
} else {
  const warned = warns.some((w) => w.includes("掌镜") && w.includes("降级"));
  check("C3b headless 无 pointer lock → 优雅降级：isDegraded()=true 且 console.warn 提示",
    c3b.degraded === true && warned, JSON.stringify({ ...c3b, warned }));
}

// ================= C4：WASD 平移 + E 升降 =================
console.log("\n--- C4 WASD/EQ 移动 ---");
const c4pre = await page.evaluate(() => {
  const cam = window.__ds.cameraManager.getActiveCamera().camera;
  cam.position.set(0, 1.5, 5);
  cam.lookAt(0, 1, 0);
  window.__ds.cameraOperator.exit();
  window.__ds.cameraOperator.enter(); // 重新接管新姿态
  return cam.position.toArray();
});
await page.keyboard.down("w");
await page.waitForTimeout(400);
await page.keyboard.up("w");
const c4w = await page.evaluate(() => window.__ds.cameraManager.getActiveCamera().camera.position.toArray());
const c4wDelta = dist3(c4w, c4pre);
check("C4a W 前进：相机位移 >0.3m 且 Z 减小（朝 -Z 看）",
  c4wDelta > 0.3 && c4w[2] < c4pre[2], `Δ=${c4wDelta.toFixed(2)} z:${c4pre[2].toFixed(2)}→${c4w[2].toFixed(2)}`);

await page.keyboard.down("e");
await page.waitForTimeout(300);
await page.keyboard.up("e");
const c4e = await page.evaluate(() => window.__ds.cameraManager.getActiveCamera().camera.position.toArray());
check("C4b E 升降：Y 增加 >0.2m", c4e[1] - c4w[1] > 0.2, `y:${c4w[1].toFixed(2)}→${c4e[1].toFixed(2)}`);

// ================= C5：滚轮调 FOV =================
console.log("\n--- C5 滚轮 FOV ---");
const c5pre = await page.evaluate(() => ({
  fov: window.__ds.cameraManager.getActiveCamera().camera.fov,
  focal: window.__ds.cameraManager.getActiveCamera().focalMM,
}));
const canvasBox = await page.locator("#viewport canvas").first().boundingBox();
await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
await page.mouse.wheel(0, 240);
await page.waitForTimeout(100);
const c5post = await page.evaluate(() => ({
  fov: window.__ds.cameraManager.getActiveCamera().camera.fov,
  focal: window.__ds.cameraManager.getActiveCamera().focalMM,
}));
check("C5 滚轮 → FOV 变化且 focalMM 同步",
  Math.abs(c5post.fov - c5pre.fov) > 0.05 && Math.abs(c5post.focal - c5pre.focal) > 0.01,
  `fov:${c5pre.fov.toFixed(1)}→${c5post.fov.toFixed(1)} focal:${c5pre.focal}→${c5post.focal}`);

// ================= C6：Enter 打点（字段 + 时间均分） =================
console.log("\n--- C6 Enter 打点 ---");
const c6pre = await page.evaluate(() => {
  const ac = window.__ds.cameraManager.getActiveCamera();
  return { hasTraj: !!ac.trajectory, depth: window.__ds.getTrajectoryUndoDepth() };
});
check("C6a [反向] 打点前无轨迹", c6pre.hasTraj === false);

await page.keyboard.press("Enter");
await page.waitForTimeout(120);
const c6p1 = await page.evaluate(() => {
  const ac = window.__ds.cameraManager.getActiveCamera();
  const cam = ac.camera;
  const p = ac.trajectory?.points?.[0];
  const fwd = new (cam.position.constructor)();
  cam.getWorldDirection(fwd);
  const expectTarget = cam.position.clone().addScaledVector(fwd, 5);
  return {
    trajCreated: !!ac.trajectory,
    len: ac.trajectory?.points?.length ?? -1,
    p,
    camPos: cam.position.toArray(),
    camFov: cam.fov,
    expectTarget: expectTarget.toArray(),
    undoDepth: window.__ds.getTrajectoryUndoDepth(),
  };
});
check("C6b 打点1：自动创建轨迹 + 字段正确（pos=相机位、target=视线前方5m、fov、time=0、track=null）",
  c6p1.trajCreated && c6p1.len === 1 &&
  approxVec(c6p1.p.position, c6p1.camPos, 1e-6) &&
  approxVec(c6p1.p.target, c6p1.expectTarget, 1e-3) &&
  approx(c6p1.p.fov, c6p1.camFov, 1e-6) &&
  c6p1.p.time === 0 && c6p1.p.track === null && typeof c6p1.p.id === "string",
  JSON.stringify({ len: c6p1.len, time: c6p1.p?.time, track: c6p1.p?.track }));
check("C6c 打点进轨迹独立 undo 栈", c6p1.undoDepth > c6pre.depth, `depth:${c6pre.depth}→${c6p1.undoDepth}`);

// 移动后再打两点 → 时间均分 [0, 0.5, 1]
await page.keyboard.down("w");
await page.waitForTimeout(250);
await page.keyboard.up("w");
await page.keyboard.press("Enter");
await page.waitForTimeout(100);
const c6p2 = await page.evaluate(() =>
  window.__ds.cameraManager.getActiveCamera().trajectory.points.map((p) => p.time));
await page.keyboard.down("d");
await page.waitForTimeout(250);
await page.keyboard.up("d");
await page.evaluate(() => window.__ds.cameraOperator.recordPoint()); // api 路径等价
await page.waitForTimeout(100);
const c6p3 = await page.evaluate(() =>
  window.__ds.cameraManager.getActiveCamera().trajectory.points.map((p) => p.time));
check("C6d 打点2后时间均分 [0,1]",
  c6p2.length === 2 && approx(c6p2[0], 0, 1e-9) && approx(c6p2[1], 1, 1e-9), JSON.stringify(c6p2));
check("C6e api.recordPoint 打点3后时间均分 [0,0.5,1]",
  c6p3.length === 3 && approx(c6p3[0], 0, 1e-9) && approx(c6p3[1], 0.5, 1e-9) && approx(c6p3[2], 1, 1e-9),
  JSON.stringify(c6p3));

// ================= C9：轨迹播放中 enter → 自动暂停 =================
console.log("\n--- C9 播放中进入掌镜 ---");
const c9 = await page.evaluate(() => {
  window.__ds.cameraOperator.exit();
  const played = window.__ds.playTrajectory();
  const playingBefore = window.__ds.trajectoryRuntime.playing;
  window.__ds.cameraOperator.enter();
  return { played, playingBefore, playingAfter: window.__ds.trajectoryRuntime.playing };
});
check("C9 轨迹播放中 enter → 轨迹自动暂停（双方不抢相机）",
  c9.played === true && c9.playingBefore === true && c9.playingAfter === false, JSON.stringify(c9));

// ================= C7：F 锁定 → 环绕/推拉/打点带 track =================
console.log("\n--- C7 F 锁定跟踪 ---");
const c7setup = await page.evaluate(() => {
  // 添加道具盒并摆到相机正前方
  document.querySelector('[data-panel="props-panel"]').click();
  [...document.querySelectorAll("#props-tab button")].find((b) => b.textContent.includes("盒"))?.click();
  const prop = window.__ds.propManager.props[0];
  if (!prop) return { ok: false, reason: "no prop" };
  prop.mesh.position.set(0, 0.5, 0);
  prop.mesh.updateMatrixWorld(true);
  // 相机摆位对准道具
  const cam = window.__ds.cameraManager.getActiveCamera().camera;
  cam.position.set(0, 1.0, 3.0);
  cam.lookAt(0, 0.5, 0);
  cam.updateMatrixWorld(true);
  // 重新进入掌镜接管新姿态
  window.__ds.cameraOperator.exit();
  window.__ds.cameraOperator.enter();
  return { ok: true, propId: prop.id };
});
check("C7a 道具就位 + 相机对准", c7setup.ok === true, c7setup.propId || c7setup.reason);

const c7lock = await page.evaluate(() => {
  const ok = window.__ds.cameraOperator.toggleLock();
  const lt = window.__ds.cameraOperator.lockedTarget;
  const labelShown = document.getElementById("pilot-lock-label")?.style.display === "block";
  return { ok, lt, labelShown };
});
check("C7b F 锁定：准星 raycast 命中道具 → lockedTarget={kind:prop,id} + HUD 标签",
  c7lock.ok !== false && c7lock.lt?.kind === "prop" && c7lock.lt?.id === c7setup.propId && c7lock.labelShown,
  JSON.stringify(c7lock.lt));

// A/D 环绕：半径不变、位置变化
const c7orbitPre = await page.evaluate(() => {
  const cam = window.__ds.cameraManager.getActiveCamera().camera;
  return { pos: cam.position.toArray(), center: [0, 0.5, 0] };
});
await page.keyboard.down("a");
await page.waitForTimeout(350);
await page.keyboard.up("a");
const c7orbitPost = await page.evaluate(() => {
  const cam = window.__ds.cameraManager.getActiveCamera().camera;
  const fwd = new (cam.position.constructor)();
  cam.getWorldDirection(fwd);
  // 相机→目标方向应指向锁定中心（lookAt 生效）
  const toCenter = new (cam.position.constructor)(0, 0.5, 0).sub(cam.position).normalize();
  return { pos: cam.position.toArray(), dot: fwd.dot(toCenter) };
});
const rPre = dist3(c7orbitPre.pos, c7orbitPre.center);
const rPost = dist3(c7orbitPost.pos, c7orbitPre.center);
const moved = dist3(c7orbitPre.pos, c7orbitPost.pos);
check("C7c 锁定中 A 环绕：位置移动 >0.3m 且半径保持（±1%）且始终朝向目标",
  moved > 0.3 && Math.abs(rPost - rPre) / rPre < 0.01 && c7orbitPost.dot > 0.999,
  `moved=${moved.toFixed(2)} r:${rPre.toFixed(3)}→${rPost.toFixed(3)} dot=${c7orbitPost.dot.toFixed(4)}`);

// W 推拉：半径减小
await page.keyboard.down("w");
await page.waitForTimeout(300);
await page.keyboard.up("w");
const c7push = await page.evaluate(() => window.__ds.cameraManager.getActiveCamera().camera.position.toArray());
const rPush = dist3(c7push, c7orbitPre.center);
check("C7d 锁定中 W 推拉：半径减小 >0.3m", rPost - rPush > 0.3, `r:${rPost.toFixed(3)}→${rPush.toFixed(3)}`);

// 锁定中打点带 track
await page.keyboard.press("Enter");
await page.waitForTimeout(100);
const c7mark = await page.evaluate(() => {
  const pts = window.__ds.cameraManager.getActiveCamera().trajectory.points;
  return { len: pts.length, last: pts[pts.length - 1] };
});
check("C7e 锁定中 Enter 打点 → track={kind:prop,id}",
  c7mark.last?.track?.kind === "prop" && c7mark.last?.track?.id === c7setup.propId,
  JSON.stringify(c7mark.last?.track));

const c7unlock = await page.evaluate(() => {
  window.__ds.cameraOperator.toggleLock();
  return { lt: window.__ds.cameraOperator.lockedTarget };
});
check("C7f 再按 F 解锁 → lockedTarget=null", c7unlock.lt === null);

// ================= C8：空格播停（无角色不崩） =================
await page.keyboard.press(" ");
await page.waitForTimeout(100);
check("C8 空格播停（场景无角色）不崩", errors.length === 0, errors[0] || "");

// ================= C10：exit 恢复 orbit + Esc 退出路径 =================
console.log("\n--- C10 退出 ---");
const c10 = await page.evaluate(() => {
  const ok = window.__ds.cameraOperator.exit();
  return {
    ok,
    active: window.__ds.cameraOperator.isActive(),
    orbitEnabled: window.__ds__orbit.enabled,
    hudShown: document.getElementById("pilot-hud")?.style.display,
  };
});
check("C10a exit → isActive=false、orbit.enabled 恢复 true、HUD 隐藏",
  c10.ok === true && c10.active === false && c10.orbitEnabled === true && c10.hudShown === "none",
  JSON.stringify(c10));

// Esc 路径：重新进入后按 Esc 退出
await page.evaluate(() => window.__ds.cameraOperator.enter());
await page.waitForTimeout(600); // 等降级探测落定
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
const c10b = await page.evaluate(() => ({
  active: window.__ds.cameraOperator.isActive(),
  orbitEnabled: window.__ds__orbit.enabled,
}));
check("C10b Esc 键退出掌镜（降级模式直接退 / 持锁则由浏览器丢锁退）",
  c10b.active === false && c10b.orbitEnabled === true, JSON.stringify(c10b));

// ================= C12：强制降级路径（模拟 requestPointerLock 拒绝） =================
console.log("\n--- C12 强制降级 ---");
const warnsBeforeC12 = warns.length;
const c12 = await page.evaluate(async () => {
  // 2D canvas（dom）与 WebGL canvas 叠在同一容器，全部覆盖确保命中 pointer lock 目标
  document.querySelectorAll("#viewport canvas").forEach((c) => {
    c.requestPointerLock = () => Promise.reject(new Error("simulated headless denial"));
  });
  window.__ds.cameraOperator.enter();
  await new Promise((r) => setTimeout(r, 500)); // 等 promise.catch + 400ms 兜底探测
  return {
    active: window.__ds.cameraOperator.isActive(),
    degraded: window.__ds.cameraOperator.isDegraded(),
    orbitEnabled: window.__ds__orbit.enabled,
    hudShown: document.getElementById("pilot-hud")?.style.display === "block",
  };
});
check("C12a requestPointerLock 拒绝 → 优雅降级不崩：active=true、isDegraded()=true、orbit 仍禁用、HUD 仍显示",
  c12.active === true && c12.degraded === true && c12.orbitEnabled === false && c12.hudShown === true,
  JSON.stringify(c12));
await page.waitForTimeout(100);
check("C12b 降级路径 console.warn 提示（含「掌镜」「降级」）",
  warns.slice(warnsBeforeC12).some((w) => w.includes("掌镜") && w.includes("降级")),
  warns.slice(warnsBeforeC12).join(" | ") || "无新 warn");

// 降级模式键盘移动仍可用（仅鼠标转视角失效）
const c12pre = await page.evaluate(() => window.__ds.cameraManager.getActiveCamera().camera.position.toArray());
await page.keyboard.down("w");
await page.waitForTimeout(300);
await page.keyboard.up("w");
const c12post = await page.evaluate(() => window.__ds.cameraManager.getActiveCamera().camera.position.toArray());
check("C12c 降级模式键盘移动仍可用", dist3(c12pre, c12post) > 0.2,
  `Δ=${dist3(c12pre, c12post).toFixed(2)}`);

// 降级模式 Esc 直接退出
await page.keyboard.press("Escape");
await page.waitForTimeout(150);
const c12esc = await page.evaluate(() => ({
  active: window.__ds.cameraOperator.isActive(),
  orbitEnabled: window.__ds__orbit.enabled,
}));
check("C12d 降级模式 Esc 直接退出 + orbit 恢复",
  c12esc.active === false && c12esc.orbitEnabled === true, JSON.stringify(c12esc));

// ================= C11：零 JS 错误 =================
check("C11 页面零 JS 错误", errors.length === 0, errors.slice(0, 3).join(" | ") || "无");

await page.screenshot({ path: path.join(__dirname, "out", "camera-operator.png") });
console.log("截图: test/out/camera-operator.png");
console.log("JS 错误:", errors.length ? errors : "无");
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
await browser.close();
server.close();
process.exit(fail === 0 && errors.length === 0 ? 0 : 1);
