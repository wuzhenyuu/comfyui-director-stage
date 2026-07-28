/** vrm-loader-verify.mjs — VRM 加载契约验收（第二轮审查 P3-2 盲区：vrm-loader.js 零覆盖）
 *
 * 本脚本只写测试，不改核心源码。
 *
 * 测试资产：assets/models/AliciaSolid.vrm（仓库自带，无需下载）
 *   来源：assets/models/index.json 注明「VRM Consortium 官方示例角色，CC0 协议，7.5MB」。
 *
 * 验收契约：
 *  0) 资产可达：/director_stage/models/AliciaSolid.vrm HTTP 200 且体积 >1MB
 *  1) addVRM 成功：entry.type="vrm"、model 已入场景且可见、角色数 +1
 *  2) humanoid 校验：entry.vrm.humanoid 存在（无 humanoid 的 VRM 应被拒）
 *  3) jointMap 映射：joint1=Neck（COCO 1，名含 neck）、rigRoot=Hips（名含 hip）、
 *     手指含 little（COCO 37/57，名含 little/pinkie）、四肢端点（4/7/10/13）齐全
 *  4) animations 字段透传：entry.animations 为数组（透传 gltf.animations，空数组合法）
 *  5) IK targets：四链 target/pole 存在，target 贴近末端骨世界坐标（<0.3m）
 *  6) 标准化缩放：模型包围盒高度 ≈1.8m（±0.3）
 *  7) IK 驱动可用：移动 rightArm target 后腕骨跟随（收敛 <0.25 且腕骨确实位移）
 *  8) 加载失败路径：损坏 .vrm（垃圾字节）→ addVRM reject、角色数不变、
 *     无 pageerror、管理器不残留 pending 占位（随后可再次正常加载）
 *  9) 截图 test/out/vrm-loader.png
 *
 * 用法: node vrm-loader-verify.mjs
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
const vrmLocal = path.join(repoRoot, "assets/models/AliciaSolid.vrm");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".glb": "model/gltf-binary", ".vrm": "model/gltf-binary" };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  // 损坏 VRM：返回垃圾字节（200 但非合法 GLB/VRM）
  if (p === "/director_stage/models/__corrupt__.vrm") {
    res.writeHead(200, { "Content-Type": "model/gltf-binary" });
    res.end(Buffer.from("THIS IS NOT A VRM FILE — corrupt payload for failure-path test"));
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
console.log("测试资产:", vrmLocal, fs.existsSync(vrmLocal) ? `（存在，${(fs.statSync(vrmLocal).size / 1024 / 1024).toFixed(1)}MB，仓库自带 CC0）` : "（缺失！）");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

// 契约 0：资产可达
const resp = await fetch(`http://127.0.0.1:${port}/director_stage/models/AliciaSolid.vrm`);
const body = await resp.arrayBuffer().catch(() => new ArrayBuffer(0));
check("契约0 测试资产 AliciaSolid.vrm 可达（仓库自带，来源见 index.json：VRM Consortium CC0）",
  resp.ok && body.byteLength > 1024 * 1024 && fs.existsSync(vrmLocal),
  `HTTP ${resp.status}, ${(body.byteLength / 1024 / 1024).toFixed(1)}MB`);

const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch({ channel: "chrome" }));
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());

await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => !!window.__ds, null, { timeout: 10000 });
await page.waitForTimeout(1200); // 默认 GLB 自动加载不阻塞本测试

// ================= 契约 1-6：加载 AliciaSolid.vrm =================
const loaded = await page.evaluate(async () => {
  const mgr = window.__ds.externalCharacters;
  const before = mgr.getAll().length;
  const entry = await mgr.addVRM("/director_stage/models/AliciaSolid.vrm", "Alicia", "AliciaSolid.vrm");
  if (!entry) return { ok: false, before };
  const boneWorld = (bone) => {
    bone.updateWorldMatrix(true, false);
    const e = bone.matrixWorld.elements;
    return [e[12], e[13], e[14]];
  };
  const jm = entry.jointMap;
  const jointName = (k) => jm.get(k)?.name || null;
  // 包围盒高度
  let minY = Infinity, maxY = -Infinity;
  entry.model.updateMatrixWorld(true);
  entry.model.traverse((c) => {
    if (c.isMesh || c.isSkinnedMesh) {
      c.geometry.computeBoundingBox();
      const bb = c.geometry.boundingBox;
      for (const cx of [bb.min.x, bb.max.x]) for (const cy of [bb.min.y, bb.max.y]) for (const cz of [bb.min.z, bb.max.z]) {
        const v = { x: cx, y: cy, z: cz };
        const w = c.localToWorld(new c.position.constructor(v.x, v.y, v.z));
        minY = Math.min(minY, w.y); maxY = Math.max(maxY, w.y);
      }
    }
  });
  // IK target 与末端骨距离
  const chainEnd = { rightArm: 4, leftArm: 7, rightLeg: 10, leftLeg: 13 };
  const ikDist = {};
  for (const [chain, endIdx] of Object.entries(chainEnd)) {
    const t = entry.ikTargets?.[chain]?.target;
    const b = jm.get(endIdx);
    if (t && b) {
      const w = boneWorld(b);
      ikDist[chain] = Math.hypot(t.position.x - w[0], t.position.y - w[1], t.position.z - w[2]);
    } else ikDist[chain] = null;
  }
  return {
    ok: true, before, after: mgr.getAll().length,
    type: entry.type,
    inScene: !!entry.model.parent,
    visible: entry.model.visible,
    hasHumanoid: !!entry.vrm?.humanoid,
    animationsIsArray: Array.isArray(entry.animations),
    animationsLen: entry.animations?.length,
    names: {
      neck: jointName(1), rigRoot: jointName("rigRoot"),
      littleL: jointName(37), littleR: jointName(57),
      rWrist: jointName(4), lWrist: jointName(7), rAnkle: jointName(10), lAnkle: jointName(13),
      head: jointName(0),
    },
    distinct: new Set([jm.get(1), jm.get("rigRoot"), jm.get(37), jm.get(57), jm.get(4)]).size,
    height: maxY - minY,
    ikDist,
  };
});
console.log("  VRM 加载结果:", JSON.stringify({ type: loaded.type, names: loaded.names, height: loaded.height?.toFixed(3), ikDist: loaded.ikDist, animationsLen: loaded.animationsLen }));

check("契约1 addVRM 成功：type=vrm、model 入场景可见、角色数 +1",
  loaded.ok && loaded.type === "vrm" && loaded.inScene && loaded.visible && loaded.after === loaded.before + 1,
  `chars ${loaded.before}→${loaded.after}`);
check("契约2 humanoid 校验：entry.vrm.humanoid 存在", loaded.hasHumanoid === true);
check("契约3a jointMap：joint1=Neck、rigRoot=Hips",
  /neck/i.test(loaded.names.neck || "") && /hip/i.test(loaded.names.rigRoot || ""),
  `neck="${loaded.names.neck}", rigRoot="${loaded.names.rigRoot}"`);
check("契约3b jointMap：手指含 little（COCO 37/57），四肢端点齐全且骨骼互不相同",
  /little|pink(y|ie)/i.test(loaded.names.littleL || "") && /little|pink(y|ie)/i.test(loaded.names.littleR || "") &&
  !!loaded.names.rWrist && !!loaded.names.lWrist && !!loaded.names.rAnkle && !!loaded.names.lAnkle &&
  loaded.distinct === 5,
  `littleL="${loaded.names.littleL}", littleR="${loaded.names.littleR}", distinct=${loaded.distinct}`);
check("契约4 animations 字段透传（数组，透传 gltf.animations）",
  loaded.animationsIsArray === true,
  `length=${loaded.animationsLen}`);
check("契约5 IK targets 四链齐全且 target 贴近末端骨（<0.3m）",
  Object.values(loaded.ikDist).every((d) => d !== null && d < 0.3),
  JSON.stringify(Object.fromEntries(Object.entries(loaded.ikDist).map(([k, v]) => [k, v?.toFixed(3)]))));
check("契约6 标准化缩放：包围盒高度 ≈1.8m（±0.3）",
  loaded.height > 1.5 && loaded.height < 2.1, `height=${loaded.height?.toFixed(3)}`);

// ================= 契约 7：IK 驱动可用 =================
const ikDrive = await page.evaluate(() => {
  const mgr = window.__ds.externalCharacters;
  const entry = mgr.getAll().find((e) => e.type === "vrm");
  mgr.setActive(entry.id);
  const boneWorld = (bone) => {
    bone.updateWorldMatrix(true, false);
    const e = bone.matrixWorld.elements;
    return [e[12], e[13], e[14]];
  };
  const wrist = entry.jointMap.get(4);
  const before = boneWorld(wrist);
  entry.ikTargets.rightArm.target.position.y += 0.3;
  entry.ikTargets.rightArm.target.position.x += 0.15;
  entry._ikDirty = true;
  return { before, id: entry.id };
});
await page.waitForTimeout(500);
const ikAfter = await page.evaluate((id) => {
  const mgr = window.__ds.externalCharacters;
  const entry = mgr.get(id);
  const boneWorld = (bone) => {
    bone.updateWorldMatrix(true, false);
    const e = bone.matrixWorld.elements;
    return [e[12], e[13], e[14]];
  };
  const wrist = boneWorld(entry.jointMap.get(4));
  const t = entry.ikTargets.rightArm.target.position.toArray();
  return { wrist, dTarget: Math.hypot(wrist[0] - t[0], wrist[1] - t[1], wrist[2] - t[2]) };
}, ikDrive.id);
const wristMoved = Math.hypot(ikAfter.wrist[0] - ikDrive.before[0], ikAfter.wrist[1] - ikDrive.before[1], ikAfter.wrist[2] - ikDrive.before[2]);
check("契约7 IK 驱动：移动 rightArm target 后 VRM 腕骨跟随（收敛 <0.25，位移 >0.1）",
  ikAfter.dTarget < 0.25 && wristMoved > 0.1,
  `d(腕骨→target)=${ikAfter.dTarget.toFixed(3)}, 腕骨位移=${wristMoved.toFixed(3)}`);

// ================= 契约 8：损坏文件不崩 =================
const corrupt = await page.evaluate(async () => {
  const mgr = window.__ds.externalCharacters;
  const before = mgr.getAll().length;
  let errMsg = null;
  try {
    await mgr.addVRM("/director_stage/models/__corrupt__.vrm", "bad", "__corrupt__.vrm");
  } catch (e) { errMsg = e.message || String(e); }
  return {
    errMsg,
    countSame: mgr.getAll().length === before,
    pendingClean: (mgr._pendingAdds?.size ?? 0) === 0,
    dsAlive: typeof window.__ds.getSceneJSON === "function",
  };
});
check("契约8 损坏 VRM：addVRM reject、角色数不变、pending 占位清理、页面不崩",
  typeof corrupt.errMsg === "string" && corrupt.errMsg.length > 0 &&
  corrupt.countSame && corrupt.pendingClean && corrupt.dsAlive,
  `err="${corrupt.errMsg}"`);

// 失败路径后再次正常加载可用（防状态污染）
const reload2 = await page.evaluate(async () => {
  const mgr = window.__ds.externalCharacters;
  const before = mgr.getAll().length;
  const entry = await mgr.addVRM("/director_stage/models/AliciaSolid.vrm", "Alicia-2", "AliciaSolid.vrm");
  return { ok: !!entry, after: mgr.getAll().length, before };
});
check("契约8b 失败路径后可再次正常加载 VRM（无状态污染）",
  reload2.ok && reload2.after === reload2.before + 1,
  `chars ${reload2.before}→${reload2.after}`);

await page.screenshot({ path: path.join(__dirname, "out", "vrm-loader.png") });
console.log("截图: test/out/vrm-loader.png");
console.log("JS 错误:", errors.length ? errors : "无");
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
await browser.close();
server.close();
process.exit(fail === 0 && errors.length === 0 ? 0 : 1);
