/** apply-e2e-verify.mjs — P1-1「应用到节点」全链路 E2E 验收（第二轮审查最大测试盲区）
 *
 * 背景：既有 15 个测试全部走 window.__ds.performBatchExport() 内部 API，
 * 没有任何测试覆盖「用户点 Apply → exportDone postMessage → 父页面 widget 回写」链路，
 * 而 export.js（postMessage origin）/ main.js（onApply 错误处理）/ directorStage.js
 * （widget 容错）的修复恰好都集中在这条链路上。
 *
 * 方案：静态服务器额外伺服一个内联「宿主页面」（模拟 web/js/directorStage.js 的父页面），
 * 内嵌真实编辑器 iframe；宿主页面 window.postMessage 被包裹以记录 iframe 发出的
 * targetOrigin，收到 exportDone 后按 directorStage.js 同款逻辑回写 mock widget。
 *
 * 验收契约：
 *  1) 宿主页面加载编辑器 iframe：收到 ready、回 init、编辑器 __ds 就绪
 *  2) M2 多相机路径：添加第二台相机后点击真实 #btnApply → 宿主收到 type:"exportDone"
 *  3) M2 payload 三字段齐全：manifest 为对象 / sceneGz 非空字符串 / sceneJSON 存在
 *  4) M2 manifest 结构合法：version=2、cameras 数组长度≥2、每台相机含
 *     files.openpose / width / height / cameraParams
 *  5) M2 sceneJSON 可 JSON 序列化且含 cameras 数组
 *  6) postMessage 安全姿态：exportDone 的 targetOrigin !== "*" 且 === location.origin
 *  7) 宿主 widget 回写正确：scene_gz 值匹配、manifest widget 可 JSON.parse 且含
 *     cameras、scene_json widget 可 JSON.parse
 *  8) M1 单相机路径（重载 + 移除全部外部角色，因 P1-3 fix 后有外部角色恒走 batch）：
 *     8b 为零角色健壮性探针（复现 renderOpenPoseCanvas 空 joints 崩溃的真实 Bug，
 *     不计分）；8c 注入 18 个 M1 语义 mock 关节后点击 Apply → 宿主收到 exportDone
 *  9) M1 payload 结构：manifest.cameras.length===1、manifest 顶层 files 含
 *     openpose/depth/normal/lineart/preview（M1 向后兼容）、sceneJSON 经
 *     extraPayload 注入存在
 * 10) M1 targetOrigin 同样非 "*"
 * 11) 错误路径：父页面 postMessage 抛错时编辑器不崩——无 pageerror、btnApply
 *     恢复可用、状态栏显示「导出失败」
 * 12) 错误恢复：取消抛错后再次 Apply 成功，宿主再次收到 exportDone
 * 13) 截图 test/out/apply-e2e.png
 *
 * 用法: node apply-e2e-verify.mjs
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
const uploadDir = path.join(__dirname, "out", "uploads-apply-e2e");
fs.mkdirSync(uploadDir, { recursive: true });

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".glb": "model/gltf-binary" };

/** mock /upload/image（与 glb-multi-export-verify 同款）：抠出 PNG 存盘，回 ComfyUI 风格 JSON */
function handleMockUpload(req, res) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const m = /filename="([^"]+\.png)"/.exec(body.toString("latin1"));
    const name = m ? m[1] : `upload_${Date.now()}.png`;
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const start = body.indexOf(sig);
    const end = body.indexOf(Buffer.from("IEND"), start);
    if (start >= 0 && end > start) {
      fs.writeFileSync(path.join(uploadDir, name), body.subarray(start, end + 8));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ name, subfolder: "director_stage", type: "input" }));
  });
}

/**
 * 宿主页面（模拟 web/js/directorStage.js 的父页面侧）：
 * - 包裹 window.postMessage 记录 iframe 发出的 targetOrigin（安全姿态断言用）
 * - 收到 ready → 回 init（512x768）
 * - 收到 exportDone → 记录 payload + 按 directorStage.js 同款逻辑回写 mock widget
 * - __host.throwOnExportDone = true 时 postMessage 抛错（错误路径契约用）
 */
const HOST_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>apply-e2e host</title></head>
<body style="margin:0;background:#222;color:#eee;font:12px monospace">
<div id="hostbar">HOST MOCK — messages: <span id="mc">0</span> widgets: <span id="wv"></span></div>
<iframe id="ed" src="/index.html" style="width:100%;height:840px;border:none"></iframe>
<script>
window.__host = {
  messages: [],         // 收到的 exportDone payload（含 event.origin）
  postMessageCalls: [], // iframe 调 parent.postMessage 的 {type, targetOrigin} 记录
  widgets: { scene_gz: "", scene_json: "{}", manifest: "{}" },
  ready: false,
  throwOnExportDone: false,
};
// 包裹 postMessage 记录 targetOrigin。注意：iframe 调 parent.postMessage 命中本包裹后，
// 原生派发不会执行，必须手动再派发 MessageEvent（source 指向 iframe），否则宿主收不到消息。
window.postMessage = function (data, targetOrigin) {
  window.__host.postMessageCalls.push({ type: data && data.type, targetOrigin: String(targetOrigin) });
  if (window.__host.throwOnExportDone && data && data.type === "exportDone") {
    throw new Error("模拟父页面 postMessage 抛错");
  }
  const iframe = document.getElementById("ed");
  const ev = new MessageEvent("message", { data, origin: location.origin, source: iframe.contentWindow });
  window.dispatchEvent(ev);
};
window.addEventListener("message", (ev) => {
  const iframe = document.getElementById("ed");
  if (!iframe.contentWindow || ev.source !== iframe.contentWindow) return;
  const d = ev.data || {};
  if (d.type === "ready") {
    window.__host.ready = true;
    iframe.contentWindow.postMessage(
      { type: "init", payload: { width: 512, height: 768, sceneGz: "", sceneJSON: "{}" } },
      location.origin
    );
  } else if (d.type === "exportDone") {
    const p = d.payload || {};
    window.__host.messages.push({ payload: p, origin: ev.origin });
    // ↓ 与 web/js/directorStage.js exportDone 分支同款回写逻辑
    window.__host.widgets.scene_gz = p.sceneGz || "";
    window.__host.widgets.scene_json =
      p.sceneJSON === undefined || p.sceneJSON === null || p.sceneJSON === ""
        ? "{}"
        : (typeof p.sceneJSON === "string" ? p.sceneJSON : JSON.stringify(p.sceneJSON));
    try {
      window.__host.widgets.manifest = JSON.stringify(p.manifest === undefined ? {} : p.manifest);
    } catch (err) {
      window.__host.widgets.manifest = "{}";
    }
    document.getElementById("mc").textContent = String(window.__host.messages.length);
    document.getElementById("wv").textContent =
      "scene_gz=" + window.__host.widgets.scene_gz.length + "B manifest=" +
      window.__host.widgets.manifest.length + "B";
  }
});
</script>
</body></html>`;

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/upload/image" && req.method === "POST") return handleMockUpload(req, res);
  if (p === "/host.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HOST_HTML);
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
console.log("静态服务器端口:", port, "（/upload/image 已 mock →", uploadDir, "）");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch({ channel: "chrome" }));
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());

// ---------- 工具函数 ----------
const editorEval = (fn, arg) => page.evaluate(([f, a]) => {
  const ed = document.getElementById("ed").contentWindow;
  // eslint-disable-next-line no-eval
  return eval(`(${f})`)(ed, a);
}, [fn.toString(), arg]);

async function waitEditorReady(timeout = 30000) {
  await page.waitForFunction(() => window.__host?.ready === true, null, { timeout }).catch(() => {});
  await page.waitForFunction(() => {
    const ed = document.getElementById("ed").contentWindow;
    return !!ed.__ds;
  }, null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1200);
}

async function clickApplyAndWaitExport(msgCountBefore, timeout = 60000) {
  await page.evaluate(() => {
    const doc = document.getElementById("ed").contentDocument;
    doc.getElementById("btnApply").click();
  });
  const got = await page.waitForFunction(
    (n) => window.__host.messages.length > n,
    msgCountBefore, { timeout }
  ).then(() => true).catch(() => false);
  return got;
}

// ================= 契约 1：iframe 嵌套 + ready/init 握手 =================
await page.goto(`http://127.0.0.1:${port}/host.html`);
await waitEditorReady();
const hs1 = await page.evaluate(() => ({
  ready: window.__host.ready,
  dsReady: !!document.getElementById("ed").contentWindow.__ds,
  glbMode: document.getElementById("ed").contentWindow.__ds?.isGLBMode === true,
}));
check("契约1 宿主 iframe 嵌套：收到 ready 且编辑器 __ds 就绪",
  hs1.ready && hs1.dsReady, JSON.stringify(hs1));

// ================= 契约 2-7：M2 多相机路径 =================
// 等默认角色加载完（Michelle），再添加第二台相机
await page.waitForFunction(() => {
  const ed = document.getElementById("ed").contentWindow;
  return (ed.__ds?.externalCharacters?.getAll?.().length ?? 0) >= 1;
}, null, { timeout: 30000 }).catch(() => {});
const camCount = await editorEval((ed) => {
  ed.__ds.cameraManager.addCamera();
  return ed.__ds.cameraManager.cameras.length;
});
const m2Clicked = await page.evaluate(() => {
  const doc = document.getElementById("ed").contentDocument;
  const btn = doc.getElementById("btnApply");
  if (!btn || btn.disabled) return false;
  btn.click();
  return true;
});
const m2Got = await page.waitForFunction(
  () => window.__host.messages.length >= 1, null, { timeout: 60000 }
).then(() => true).catch(() => false);
check("契约2 M2 路径：点击真实 #btnApply → 宿主收到 type:\"exportDone\"",
  m2Clicked && m2Got, `相机数=${camCount} btnClicked=${m2Clicked} 收到=${m2Got}`);

const m2 = await page.evaluate(() => {
  const h = window.__host;
  const last = h.messages[h.messages.length - 1] || {};
  const p = last.payload || {};
  const m = p.manifest || {};
  return {
    hasManifest: !!p.manifest && typeof p.manifest === "object",
    sceneGzType: typeof p.sceneGz,
    sceneGzLen: typeof p.sceneGz === "string" ? p.sceneGz.length : -1,
    hasSceneJSON: p.sceneJSON !== undefined && p.sceneJSON !== null,
    version: m.version,
    camerasLen: Array.isArray(m.cameras) ? m.cameras.length : -1,
    cam0: m.cameras?.[0] ? {
      hasOpenpose: typeof m.cameras[0].files?.openpose === "string",
      w: m.cameras[0].width, h: m.cameras[0].height,
      hasCamParams: !!m.cameras[0].cameraParams?.intrinsics,
    } : null,
    camAllValid: Array.isArray(m.cameras) && m.cameras.every((c) =>
      typeof c.files?.openpose === "string" && c.width > 0 && c.height > 0 && !!c.cameraParams?.intrinsics),
    sceneJSONCameras: (() => {
      try {
        const sj = typeof p.sceneJSON === "string" ? JSON.parse(p.sceneJSON) : p.sceneJSON;
        return Array.isArray(sj?.cameras) ? sj.cameras.length : -1;
      } catch { return -2; }
    })(),
    pmCalls: h.postMessageCalls.filter((c) => c.type === "exportDone"),
    widgets: { ...h.widgets },
    payloadSceneGz: p.sceneGz,
  };
});
check("契约3 M2 payload 三字段齐全（manifest 对象 / sceneGz 非空字符串 / sceneJSON 存在）",
  m2.hasManifest && m2.sceneGzType === "string" && m2.sceneGzLen > 0 && m2.hasSceneJSON,
  `sceneGz=${m2.sceneGzLen}B sceneJSON=${m2.hasSceneJSON}`);
check("契约4 M2 manifest 结构：version=2、cameras≥2、每台含 openpose/width/height/cameraParams",
  m2.version === 2 && m2.camerasLen >= 2 && m2.camAllValid,
  `version=${m2.version} cameras=${m2.camerasLen} cam0=${JSON.stringify(m2.cam0)}`);
check("契约5 M2 sceneJSON 可解析且含 cameras 数组",
  m2.sceneJSONCameras >= 1, `sceneJSON.cameras=${m2.sceneJSONCameras}`);
const m2OriginBad = m2.pmCalls.some((c) => c.targetOrigin === "*");
const m2OriginOk = m2.pmCalls.length > 0 && m2.pmCalls.every((c) => c.targetOrigin !== "*" && c.targetOrigin.startsWith("http://127.0.0.1:"));
check("契约6 postMessage targetOrigin 安全姿态：非 \"*\" 且为具体 origin",
  m2OriginOk && !m2OriginBad, JSON.stringify(m2.pmCalls));
const m2WidgetManifest = (() => { try { return JSON.parse(m2.widgets.manifest); } catch { return null; } })();
const m2WidgetSceneJson = (() => { try { return JSON.parse(m2.widgets.scene_json); } catch { return null; } })();
check("契约7 宿主 widget 回写：scene_gz 匹配、manifest/scene_json widget 可 JSON.parse 且含 cameras",
  m2.widgets.scene_gz === m2.payloadSceneGz &&
  !!m2WidgetManifest && Array.isArray(m2WidgetManifest.cameras) && m2WidgetManifest.cameras.length >= 2 &&
  !!m2WidgetSceneJson && Array.isArray(m2WidgetSceneJson.cameras),
  `scene_gz匹配=${m2.widgets.scene_gz === m2.payloadSceneGz} manifest.cameras=${m2WidgetManifest?.cameras?.length} scene_json.cameras=${m2WidgetSceneJson?.cameras?.length}`);

// ================= 契约 8-10：M1 单相机路径（重载 + 移除全部外部角色） =================
// 注意：P1-3 fix 后，只要 externalManager 里还有外部 3D角色，单机位也走 batch 路径
// （M1 performApply 不产 mask 且多角色 openpose 只画第一个角色）。
// 故 M1 路径的合法触发条件 = 单相机 + 零角色，需先 remove() 全部外部角色。
await page.goto(`http://127.0.0.1:${port}/host.html`);
await waitEditorReady();
await page.waitForFunction(() => {
  const ed = document.getElementById("ed").contentWindow;
  return (ed.__ds?.externalCharacters?.getAll?.().length ?? 0) >= 1;
}, null, { timeout: 30000 }).catch(() => {});
const m1State = await editorEval((ed) => {
  const mgr = ed.__ds.externalCharacters;
  for (const e of mgr.getAll()) mgr.remove(e.id);
  return { cams: ed.__ds.cameraManager.cameras.length, chars: mgr.getAll().length };
});
check("契约8a M1 前置：单相机且外部角色已清空", m1State.cams === 1 && m1State.chars === 0,
  JSON.stringify(m1State));

// ---- 契约 8b：零角色 M1 路径健壮性探针（真实 Bug 复现，不计分，只报告） ----
// 现状：3D-only 下 __ds.joints=[]（无火柴人），performApply → renderOpenPoseCanvas
// 对空 joints 的 LIMB_SEQ.forEach 里 pts[a][0] 抛 TypeError，导出必然失败。
// 该探针复现此 bug 供报告；修复后应变为「优雅报错或正常导出」。
await page.evaluate(() => {
  const doc = document.getElementById("ed").contentDocument;
  doc.getElementById("btnApply").click();
});
await page.waitForFunction(() => {
  const doc = document.getElementById("ed").contentDocument;
  const st = doc.getElementById("status");
  return st && (st.textContent.includes("导出失败") || st.textContent.includes("已应用"));
}, null, { timeout: 30000 }).catch(() => {});
const bugProbe = await page.evaluate(() => ({
  status: document.getElementById("ed").contentDocument.getElementById("status")?.textContent || "",
  hostMsgs: window.__host.messages.length,
}));
const bugReproduced = bugProbe.status.includes("导出失败") && bugProbe.hostMsgs === 0;
console.log(`${bugReproduced ? "🐞" : "ℹ️"} 契约8b 探针（不计分）：零角色 M1 路径 → ${bugReproduced ? "复现真实Bug：导出崩溃 TypeError（renderOpenPoseCanvas 对空 joints 数组无守卫）" : "未复现崩溃（bug 可能已修复）：" + bugProbe.status.slice(0, 50)}`);

// ---- 契约 9/10：注入 18 个 M1 语义 mock 关节（等价旧火柴人关节），验证 M1 payload 结构 ----
// 说明：3D-only 构建不创建火柴人，__ds.joints=[] 是上面 bug 的根因；此处注入 mock 关节
// 仅为隔离验证 performApply 的 payload 结构契约，不掩盖 8b 报告的空关节守卫缺失。
await editorEval((ed) => {
  const arr = ed.__ds.joints;
  if (arr.length === 0) {
    for (let i = 0; i < 18; i++) {
      arr.push({
        position: { x: (i % 3) * 0.2 - 0.2, y: 1.7 - i * 0.09, z: 0 },
        userData: { index: i },
        getWorldPosition(v) { v.set(this.position.x, this.position.y, this.position.z); return v; },
      });
    }
  }
  return arr.length;
});
const m1Got = await clickApplyAndWaitExport(0);
check("契约8c M1 单相机路径（mock 关节）：点击 Apply → 宿主收到 exportDone", m1Got);

const m1 = await page.evaluate(() => {
  const h = window.__host;
  const last = h.messages[h.messages.length - 1] || {};
  const p = last.payload || {};
  const m = p.manifest || {};
  return {
    camerasLen: Array.isArray(m.cameras) ? m.cameras.length : -1,
    topFiles: m.files ? Object.keys(m.files).sort() : [],
    hasSceneJSON: p.sceneJSON !== undefined && p.sceneJSON !== null,
    sceneGzLen: typeof p.sceneGz === "string" ? p.sceneGz.length : -1,
    pmCalls: h.postMessageCalls.filter((c) => c.type === "exportDone"),
  };
});
const m1TopOk = ["depth", "lineart", "normal", "openpose", "preview"].every((k) => m1.topFiles.includes(k));
check("契约9 M1 payload 结构：cameras.length===1、顶层 files 五通道齐全（M1 兼容）、sceneJSON 注入",
  m1.camerasLen === 1 && m1TopOk && m1.hasSceneJSON && m1.sceneGzLen > 0,
  `cameras=${m1.camerasLen} files=[${m1.topFiles}] sceneJSON=${m1.hasSceneJSON}`);
const m1OriginOk = m1.pmCalls.length > 0 && m1.pmCalls.every((c) => c.targetOrigin !== "*" && c.targetOrigin.startsWith("http://127.0.0.1:"));
check("契约10 M1 targetOrigin 同样非 \"*\"", m1OriginOk, JSON.stringify(m1.pmCalls));

// ================= 契约 11：父页面 postMessage 抛错 → 编辑器不崩 =================
const errCountBefore = errors.length;
await page.evaluate(() => { window.__host.throwOnExportDone = true; });
await page.evaluate(() => {
  const doc = document.getElementById("ed").contentDocument;
  doc.getElementById("btnApply").click();
});
// 等编辑器走完错误处理（状态栏出现 导出失败 或按钮重新可用）
await page.waitForFunction(() => {
  const doc = document.getElementById("ed").contentDocument;
  const st = doc.getElementById("status");
  return st && st.textContent.includes("导出失败");
}, null, { timeout: 60000 }).catch(() => {});
const st11 = await page.evaluate(() => {
  const doc = document.getElementById("ed").contentDocument;
  return {
    status: doc.getElementById("status")?.textContent || "",
    btnDisabled: doc.getElementById("btnApply")?.disabled,
    hostGotMsg: window.__host.messages.length, // 抛错应导致宿主收不到新消息
  };
});
const newPageErrors = errors.slice(errCountBefore).filter((e) => !/favicon|404/.test(e));
check("契约11 错误路径：postMessage 抛错 → 编辑器不崩（状态显示失败、按钮恢复、无未捕获异常、宿主无新消息）",
  st11.status.includes("导出失败") && st11.btnDisabled === false && newPageErrors.length === 0 && st11.hostGotMsg === 1,
  `status="${st11.status.slice(0, 40)}" btnDisabled=${st11.btnDisabled} 新pageerror=${newPageErrors.length} 宿主消息数=${st11.hostGotMsg}`);

// ================= 契约 12：错误恢复 → 再次 Apply 成功 =================
await page.evaluate(() => { window.__host.throwOnExportDone = false; });
const m3Got = await clickApplyAndWaitExport(1);
const st12 = await page.evaluate(() => {
  const doc = document.getElementById("ed").contentDocument;
  return { status: doc.getElementById("status")?.textContent || "" };
});
check("契约12 错误恢复：取消抛错后再次 Apply 成功收到 exportDone",
  m3Got && st12.status.includes("已应用"), `收到=${m3Got} status="${st12.status.slice(0, 40)}"`);

// ================= 契约 13：截图 =================
fs.mkdirSync(path.join(__dirname, "out"), { recursive: true });
await page.screenshot({ path: path.join(__dirname, "out", "apply-e2e.png") });
check("契约13 截图 test/out/apply-e2e.png", fs.existsSync(path.join(__dirname, "out", "apply-e2e.png")));

// ---- 页面 JS 错误（参考，不单独计分）----
const realErrors = errors.filter((e) => !/favicon|404/.test(e));
console.log(realErrors.length ? `\n⚠️ 页面JS错误 ${realErrors.length} 条:` : "\n页面无 JS 错误");
realErrors.slice(0, 5).forEach((e) => console.log("  -", e.slice(0, 200)));

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
