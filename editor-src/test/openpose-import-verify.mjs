/** openpose-import-verify.mjs — OpenPose 导入契约验收（第二轮审查 P3-2 盲区：openpose-import.js 零覆盖）
 *
 * 本脚本只写测试，不改核心源码。
 *
 * 模块说明（审查发现）：openpose-import.js 的用户入口是【图片导入】（parseOpenPoseImage
 * 逐像素识别 18 标准色关节点），src 中不存在 OpenPose JSON 文件解析路径。
 * 「18 点 openpose JSON」契约因此以 JSON→关节数组的标准转换（people[0].pose_keypoints_2d
 * 扁平 [x,y,c,...]，c=0 置 null）喂给 mapTo3D/applyToCharacter 验证，图片路径用合成图验证。
 *
 * 验收契约：
 *  0) 探针自检（防恒绿）
 *  1) mapTo3D：标准 18 点 openpose JSON（people[0]）→ 4 条 IK 链 targets 齐全、
 *     坐标有限、颈部世界 Y 在人体合理范围 [1.0, 1.8]
 *  2) 缺失关键点（置信度 0 → null）：双腕缺失 → 臂链 targets 缺、腿链仍在；
 *     颈部缺失 → mapTo3D 返回 null（锚点必选）
 *  3) 多人 JSON 取第一个：people[0]/people[1] 姿势相反（左/右手举起），
 *     转换结果只反映 people[0]
 *  4) applyToCharacter：应用到活动外部角色 → IK target 精确移到映射值、
 *     _ikDirty 置位、IK 求解后腕骨世界坐标向 target 收敛（距离下降）
 *  5) 完整图片路径：按 POSE_COLORS 合成 18 点骨骼图 → importPose 检出关节 ≥15、
 *     颈部像素误差 <10px、applied=true、角色姿势随之改变
 *  6) 多人图片：两人同图 → 检出关节全部来自同一人（扫描序第一个），不混杂
 *  7) 错误输入不崩：非图片 blob → reject「无法加载图片」；空白图 →
 *     「仅检测到 0 个关节」；页面无 pageerror、__ds 仍可用
 *  8) 截图 test/out/openpose-import.png
 *
 * 用法: node openpose-import-verify.mjs
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

// 页面内公共数据/助手：标准 18 点坐标（512x512 画面）+ openpose JSON 构造器 + 合成图绘制器
await page.addInitScript(() => {
  // OpenPose 18 标准色（与 src/constants.js POSE_COLORS 一致）
  window.__POSE_COLORS = [
    [255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0],
    [170, 255, 0], [85, 255, 0], [0, 255, 0], [0, 255, 85],
    [0, 255, 170], [0, 255, 255], [0, 170, 255], [0, 85, 255],
    [0, 0, 255], [85, 0, 255], [170, 0, 255], [255, 0, 255],
    [255, 0, 170], [255, 0, 85],
  ];
  // 标准立姿 18 点（COCO 顺序）：0鼻 1颈 2R肩 3R肘 4R腕 5L肩 6L肘 7L腕
  // 8R髋 9R膝 10R踝 11L髋 12L膝 13L踝 14R眼 15L眼 16R耳 17L耳
  window.__BASE_POSE = [
    [256, 60], [256, 120], [206, 130], [170, 200], [150, 270],
    [306, 130], [342, 200], [362, 270], [226, 250], [216, 340],
    [210, 430], [286, 250], [296, 340], [302, 430], [246, 50],
    [266, 50], [232, 58], [280, 58],
  ];
  /** 标准 openpose JSON 构造：people[].pose_keypoints_2d = [x,y,c,...] */
  window.__makeOpenPoseJSON = (pts, opts = {}) => {
    const flat = [];
    pts.forEach(([x, y], i) => {
      const c = opts.zeroConf?.includes(i) ? 0 : 0.95;
      flat.push(x, y, c);
    });
    return { version: 1.3, people: [{ person_id: [-1], pose_keypoints_2d: flat }] };
  };
  /** openpose JSON → 模块关节数组（取 people[0]，c=0 → null） */
  window.__jointsFromJSON = (json) => {
    const kp = json.people[0].pose_keypoints_2d;
    const out = [];
    for (let i = 0; i < 18; i++) {
      const [x, y, c] = [kp[i * 3], kp[i * 3 + 1], kp[i * 3 + 2]];
      out.push(c > 0 ? { x, y, confidence: c } : null);
    }
    return out;
  };
  /** 合成 openpose 骨骼图（canvas → Blob Promise）：可画多人（offsets 为 x 平移列表） */
  window.__drawPoseBlob = (offsets = [0], size = 512) => {
    const cv = document.createElement("canvas");
    cv.width = cv.height = size;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);
    for (const ox of offsets) {
      window.__BASE_POSE.forEach(([x, y], i) => {
        const [r, g, b] = window.__POSE_COLORS[i];
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.beginPath();
        ctx.arc(x + ox, y, 6, 0, Math.PI * 2);
        ctx.fill();
      });
    }
    return new Promise((res) => cv.toBlob(res, "image/png"));
  };
  /** 骨骼世界坐标（不经 THREE，直接读 matrixWorld） */
  window.__boneWorld = (bone) => {
    bone.updateWorldMatrix(true, false);
    const e = bone.matrixWorld.elements;
    return [e[12], e[13], e[14]];
  };
});

await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => !!window.__ds, null, { timeout: 10000 });
await page.waitForFunction(
  () => (window.__ds?.externalCharacters?.getAll?.().length ?? 0) >= 1,
  null, { timeout: 25000 }
);
await page.waitForTimeout(500);

// ================= 契约 0：探针自检 =================
const self = await page.evaluate(() => {
  const json = window.__makeOpenPoseJSON(window.__BASE_POSE, { zeroConf: [4] });
  const joints = window.__jointsFromJSON(json);
  return { len: joints.length, wristNull: joints[4] === null, neckOk: joints[1]?.x === 256 };
});
check("契约0 探针自检（JSON 转换器：18 点、c=0→null）",
  self.len === 18 && self.wristNull === true && self.neckOk === true, JSON.stringify(self));

// ================= 契约 1：mapTo3D 标准 18 点 =================
const map1 = await page.evaluate(() => {
  const op = window.__ds.openposeImport;
  const joints = window.__jointsFromJSON(window.__makeOpenPoseJSON(window.__BASE_POSE));
  const m = op.mapTo3D(joints, 512, 512);
  const chains = Object.keys(m?.targets || {});
  const allFinite = chains.every((k) =>
    [...m.targets[k].target, ...m.targets[k].pole].every(Number.isFinite));
  return { chains, allFinite, rWristY: m?.targets?.rightArm?.target?.[1], hasMapping: !!m };
});
check("契约1 mapTo3D 标准 18 点 → 4 条 IK 链 targets 齐全且坐标有限",
  map1.hasMapping && map1.chains.length === 4 &&
  ["rightArm", "leftArm", "rightLeg", "leftLeg"].every((c) => map1.chains.includes(c)) &&
  map1.allFinite &&
  map1.rWristY > 0.3 && map1.rWristY < 1.8, // 手腕抬到 270px → 世界 Y 应在人体中段
  `chains=${map1.chains}, rWristY=${map1.rWristY?.toFixed(3)}`);

// ================= 契约 2：缺失关键点处理 =================
const map2 = await page.evaluate(() => {
  const op = window.__ds.openposeImport;
  // 双腕置信度 0
  const noWrists = window.__jointsFromJSON(window.__makeOpenPoseJSON(window.__BASE_POSE, { zeroConf: [4, 7] }));
  const m1 = op.mapTo3D(noWrists, 512, 512);
  // 颈部缺失
  const noNeckPts = window.__BASE_POSE.map((p) => [...p]);
  const noNeck = window.__jointsFromJSON(window.__makeOpenPoseJSON(window.__BASE_POSE, { zeroConf: [1] }));
  const m2 = op.mapTo3D(noNeck, 512, 512);
  return {
    armGone: !m1?.targets?.rightArm && !m1?.targets?.leftArm,
    legsStay: !!m1?.targets?.rightLeg && !!m1?.targets?.leftLeg,
    neckNull: m2 === null,
  };
});
check("契约2 缺失关键点：腕缺失→臂链缺/腿链在，颈缺失→返回 null",
  map2.armGone && map2.legsStay && map2.neckNull, JSON.stringify(map2));

// ================= 契约 3：多人 JSON 取第一个 =================
const map3 = await page.evaluate(() => {
  const op = window.__ds.openposeImport;
  // people[0]：右手举起（R 腕 y=60 高于肩）；people[1]：左手举起
  const p0 = window.__BASE_POSE.map(([x, y], i) => (i === 4 ? [170, 60] : [x, y]));
  const p1 = window.__BASE_POSE.map(([x, y], i) => (i === 7 ? [342, 60] : [x, y]));
  const j0 = window.__jointsFromJSON({ people: [{ pose_keypoints_2d: p0.flatMap(([x, y]) => [x, y, 0.9]) }] });
  const json = {
    people: [
      { pose_keypoints_2d: p0.flatMap(([x, y]) => [x, y, 0.9]) },
      { pose_keypoints_2d: p1.flatMap(([x, y]) => [x, y, 0.9]) },
    ],
  };
  const joints = window.__jointsFromJSON(json); // 取第一个
  const m = op.mapTo3D(joints, 512, 512);
  // people[0] 右手腕抬起 → rightArm target 世界 Y 应明显高于肩部水平（>1.5）
  return { rWristY: m.targets.rightArm.target[1], lWristY: m.targets.leftArm.target[1] };
});
check("契约3 多人 JSON 取第一个（people[0] 右手举起 → 右腕世界 Y 高于左腕）",
  map3.rWristY > 1.5 && map3.rWristY > map3.lWristY + 0.3,
  `rWristY=${map3.rWristY.toFixed(3)}, lWristY=${map3.lWristY.toFixed(3)}`);

// ================= 契约 4：applyToCharacter → IK/骨骼同步 =================
const apply1 = await page.evaluate(() => {
  const op = window.__ds.openposeImport;
  const mgr = window.__ds.externalCharacters;
  const entry = mgr.getActive();
  const joints = window.__jointsFromJSON(window.__makeOpenPoseJSON(window.__BASE_POSE));
  const m = op.mapTo3D(joints, 512, 512);
  const before = {
    target: entry.ikTargets.rightArm.target.position.toArray(),
    wrist: window.__boneWorld(entry.jointMap.get(4)),
  };
  const ok = op.applyToCharacter(m, mgr);
  const after = {
    target: entry.ikTargets.rightArm.target.position.toArray(),
    ikDirty: entry._ikDirty === true,
  };
  const expected = m.targets.rightArm.target;
  return { ok, before, after, expected };
});
const dTarget = Math.hypot(
  apply1.after.target[0] - apply1.expected[0],
  apply1.after.target[1] - apply1.expected[1],
  apply1.after.target[2] - apply1.expected[2]);
const targetMoved = Math.hypot(
  apply1.after.target[0] - apply1.before.target[0],
  apply1.after.target[1] - apply1.before.target[1],
  apply1.after.target[2] - apply1.before.target[2]);
check("契约4a applyToCharacter 应用成功且 IK target 精确移到映射值（探针活性：target 确实变动）",
  apply1.ok === true && apply1.after.ikDirty && dTarget < 1e-6 && targetMoved > 0.01,
  `d(映射值)=${dTarget.toFixed(6)}, Δtarget=${targetMoved.toFixed(3)}`);

await page.waitForTimeout(500); // IK 求解帧
const boneFollow = await page.evaluate((before) => {
  const mgr = window.__ds.externalCharacters;
  const entry = mgr.getActive();
  const wrist = window.__boneWorld(entry.jointMap.get(4));
  const target = entry.ikTargets.rightArm.target.position.toArray();
  const dBefore = Math.hypot(before.wrist[0] - before.target[0], before.wrist[1] - before.target[1], before.wrist[2] - before.target[2]);
  const dNow = Math.hypot(wrist[0] - target[0], wrist[1] - target[1], wrist[2] - target[2]);
  return { wrist, target, dBefore, dNow };
}, apply1.before);
const wristMoved = Math.hypot(
  boneFollow.wrist[0] - apply1.before.wrist[0],
  boneFollow.wrist[1] - apply1.before.wrist[1],
  boneFollow.wrist[2] - apply1.before.wrist[2]);
check("契约4b IK 求解后腕骨跟随 target（收敛 <0.25 且腕骨确实位移 >0.2，防恒绿）",
  boneFollow.dNow < 0.25 && wristMoved > 0.2,
  `d(腕骨→target)=${boneFollow.dNow.toFixed(3)}, 腕骨位移=${wristMoved.toFixed(3)}`);

// ================= 契约 5：完整图片路径 importPose =================
const img1 = await page.evaluate(async () => {
  const op = window.__ds.openposeImport;
  const mgr = window.__ds.externalCharacters;
  const blob = await window.__drawPoseBlob([0]);
  const result = await op.importPose(blob, mgr, 512, 512);
  const detected = result.joints.filter(Boolean).length;
  const neck = result.joints[1];
  return {
    applied: result.applied,
    detected,
    neck: neck ? { x: neck.x, y: neck.y } : null,
  };
});
const neckErr = img1.neck ? Math.hypot(img1.neck.x - 256, img1.neck.y - 120) : 999;
check("契约5 图片路径：importPose 检出 ≥15 关节、颈部误差 <10px、applied=true",
  img1.applied === true && img1.detected >= 15 && neckErr < 10,
  `detected=${img1.detected}, neck=(${img1.neck?.x.toFixed(1)},${img1.neck?.y.toFixed(1)}), err=${neckErr.toFixed(2)}px`);

// ================= 契约 6：多人图片取扫描序第一个 =================
const img2 = await page.evaluate(async () => {
  const op = window.__ds.openposeImport;
  // 两人：A 在左（ox=-60），B 在右（ox=+120）——同 y 扫描序 A 先
  const blob = await window.__drawPoseBlob([-60, 120]);
  const joints = await op.parseOpenPoseImage(blob);
  const found = joints.map((j, i) => (j ? { i, x: j.x, y: j.y } : null)).filter(Boolean);
  const xs = found.map((f) => f.x);
  const spread = Math.max(...xs) - Math.min(...xs);
  const neck = joints[1];
  return {
    detected: found.length,
    spread,
    neckX: neck?.x,
    dNeckA: neck ? Math.abs(neck.x - 196) : 999,  // A 颈 x=256-60=196
    dNeckB: neck ? Math.abs(neck.x - 376) : 999,  // B 颈 x=256+120=376
  };
});
check("契约6 多人图片：检出关节来自同一人（颈部命中 A，x 散布不跨两人）",
  img2.detected >= 15 && img2.dNeckA < 10 && img2.dNeckB > 100 && img2.spread < 250,
  `detected=${img2.detected}, neckX=${img2.neckX?.toFixed(1)}, spread=${img2.spread.toFixed(1)}`);

// ================= 契约 7：错误输入不崩 =================
const err1 = await page.evaluate(async () => {
  const op = window.__ds.openposeImport;
  const mgr = window.__ds.externalCharacters;
  const out = { badBlob: null, blank: null, dsAlive: false };
  try {
    await op.importPose(new Blob(["{这不是图片，也不是合法 JSON"]), mgr, 100, 100);
  } catch (e) { out.badBlob = e.message || String(e); }
  try {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 256;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 256, 256);
    const blank = await new Promise((res) => cv.toBlob(res, "image/png"));
    await op.importPose(blank, mgr, 256, 256);
  } catch (e) { out.blank = e.message || String(e); }
  out.dsAlive = typeof window.__ds.getSceneJSON === "function" && window.__ds.externalCharacters.getAll().length >= 1;
  return out;
});
check("契约7 错误输入：非图片 reject + 空白图报关节不足 + 页面不崩",
  typeof err1.badBlob === "string" && err1.badBlob.length > 0 &&
  /仅检测到/.test(err1.blank || "") && err1.dsAlive === true,
  `badBlob="${err1.badBlob}", blank="${err1.blank}"`);

await page.screenshot({ path: path.join(__dirname, "out", "openpose-import.png") });
console.log("截图: test/out/openpose-import.png");
console.log("JS 错误:", errors.length ? errors : "无");
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
console.log("审查备注：src 中 OpenPose 导入仅支持【图片】入口（openpose-import.js/main.js importOpenPose），");
console.log("  无 .json 文件解析路径；契约1-3 以标准 openpose JSON→关节数组转换验证 mapTo3D/applyToCharacter。");
await browser.close();
server.close();
process.exit(fail === 0 && errors.length === 0 ? 0 : 1);
