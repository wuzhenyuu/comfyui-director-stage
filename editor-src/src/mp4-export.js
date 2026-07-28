/**
 * mp4-export.js — V2-F2 MP4 参考视频导出
 *
 * 依据 DESIGN-V2.md F2 + research-3ddd.md §6/§9：
 *  - 主路径（确定性逐帧）：WebCodecs VideoEncoder (avc，按分辨率/fps 选 level)
 *    + mp4-muxer（vendored 单文件：src/vendor/mp4-muxer.mjs，来源/版本见文件头）。
 *    逐帧管线：trajectoryRuntime.seekTo(t_i) → 隐藏辅助对象渲染 →
 *    new VideoFrame(renderer.domElement, {timestamp}) → encoder.encode →
 *    muxer.addVideoChunk → finalize → Blob 触发下载。
 *  - 降级路径：无 WebCodecs / 编码器配置不支持 → MediaRecorder +
 *    canvas.captureStream(fps) 实时录制（console.warn 提示降级，时长=轨迹 duration）。
 *  - 参数：720p/1080p × 24/30/60fps；码率 720p≈5Mbps / 1080p≈8Mbps；时长=轨迹 duration。
 *  - 导出中全屏遮罩「正在导出视频 N/M 帧」防交互干扰；导出后相机姿态/轨道/进度
 *    完整恢复（快照模式，同多帧导出 performTrajectoryExport 口径）。
 *  - __ds.exportTrajectoryMp4(opts) 测试钩子；顶栏「🎬 导出视频」按钮 + 参数对话框。
 *
 * 辅助对象隐藏/恢复由本文件自实现（不改动 export.js），清单与 export.js
 * getHiddenObjects 口径一致（grid/axes/道具 gizmo/figureGroup/全景球/外部角色 IK 球），
 * 另经 __ds.boneEditor/__ds.skeletonHelpers 的 beginExport/endExport 包裹（与批量导出一致）。
 */
import * as THREE from "three";
// vendored：mp4-muxer v5.2.1（Vanilagy，MIT）ESM build，见 vendor 文件头
import { Muxer, ArrayBufferTarget } from "./vendor/mp4-muxer.mjs";
import { getRenderer, getScene, getSceneHelpers } from "./scene.js";
import { prepareTrajectory } from "./trajectory.js";

/* ==================== 依赖解析（createMp4ExportUI 注入；__ds 钩子懒回退） ==================== */

let _deps = null;

function resolveDeps() {
  const ds = typeof window !== "undefined" ? window.__ds || {} : {};
  return {
    runtime: _deps?.runtime || ds.trajectoryRuntime || null,
    cameraManager: _deps?.cameraManager || ds.cameraManager || null,
    propManager: _deps?.propManager || ds.propManager || null,
    orbit: _deps?.orbit || (typeof window !== "undefined" ? window.__ds__orbit : null) || null,
    showToast: _deps?.showToast || ((msg, isErr) => console.log(`[mp4-export]${isErr ? " [err]" : ""} ${msg}`)),
  };
}

/* ==================== 参数工具 ==================== */

const RESOLUTIONS = {
  "720p": { width: 1280, height: 720, bitrate: 5_000_000 },
  "1080p": { width: 1920, height: 1080, bitrate: 8_000_000 },
};
const FPS_OPTIONS = [24, 30, 60];

function normalizeResolution(input) {
  if (input && typeof input === "object" && Number.isFinite(input.width) && Number.isFinite(input.height)) {
    const width = Math.max(2, Math.floor(input.width / 2) * 2);   // avc 要求偶数
    const height = Math.max(2, Math.floor(input.height / 2) * 2);
    const bitrate = height >= 1080 ? 8_000_000 : 5_000_000;
    return { width, height, bitrate, label: `${width}x${height}` };
  }
  const key = input === "1080p" ? "1080p" : "720p";
  return { ...RESOLUTIONS[key], label: key };
}

function normalizeFps(input) {
  return FPS_OPTIONS.includes(input) ? input : 24;
}

/** 按分辨率/fps 选 avc level（720p≤30→3.1，720p60→3.2，1080p≤30→4.0，1080p60→4.2） */
function avcLevelHex(height, fps) {
  if (height <= 720) return fps <= 30 ? "1f" : "20";
  return fps <= 30 ? "28" : "2a";
}

/**
 * 探测可用的 VideoEncoder 配置（high → main → constrained baseline 逐个 isConfigSupported）。
 * @returns {Promise<object|null>} null = WebCodecs 不可用或全部配置不支持（走降级）
 */
async function pickEncoderConfig(width, height, fps, bitrate) {
  if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") return null;
  if (typeof VideoEncoder.isConfigSupported !== "function") return null;
  const level = avcLevelHex(height, fps);
  for (const profile of ["64", "4d", "42"]) { // High / Main / Constrained Baseline
    const config = {
      codec: `avc1.${profile}00${level}`,
      width,
      height,
      bitrate,
      framerate: fps,
      avc: { format: "avc" }, // mp4-muxer 需要 avcc（非 annexb）
    };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support && support.supported) return config;
    } catch { /* 尝试下一档 */ }
  }
  return null;
}

/* ==================== 辅助对象隐藏（本文件自实现，不改 export.js） ==================== */

/**
 * 收集需在导出渲染时隐藏的辅助对象（口径同 export.js getHiddenObjects）。
 * @returns {THREE.Object3D[]}
 */
function collectHelperObjects() {
  const ds = typeof window !== "undefined" ? window.__ds || {} : {};
  const list = [];
  try {
    const { grid, axes } = getSceneHelpers();
    if (grid) list.push(grid);
    if (axes) list.push(axes);
  } catch { /* 忽略 */ }
  if (ds.figureGroup) list.push(ds.figureGroup);
  const sphere = ds.panorama?.getSphere?.();
  if (sphere) list.push(sphere);
  const mgr = ds.externalCharacters;
  if (mgr && typeof mgr.getAll === "function") {
    for (const e of mgr.getAll()) {
      if (e?.ikTargetsGroup) list.push(e.ikTargetsGroup);
    }
  }
  return list;
}

/** 隐藏并记录先验状态（was-restore，尊重用户手动隐藏的对象） */
function hideHelpers() {
  return collectHelperObjects().map((o) => {
    const was = o.visible;
    o.visible = false;
    return { obj: o, was };
  });
}

function restoreHelpers(vis) {
  for (const { obj, was } of vis) {
    try { obj.visible = was; } catch { /* 忽略 */ }
  }
}

/* ==================== 遮罩 ==================== */

function createOverlay() {
  const el = document.createElement("div");
  el.id = "mp4-export-overlay";
  el.style.cssText = [
    "position:fixed", "inset:0", "z-index:99999",
    "background:rgba(10,12,18,0.72)", "display:flex",
    "align-items:center", "justify-content:center",
    "color:#e6e9f0", "font-size:14px", "letter-spacing:0.5px",
    "user-select:none", "cursor:wait",
  ].join(";");
  el.textContent = "正在导出视频…";
  document.body.appendChild(el);
  return el;
}

function setOverlay(el, text) {
  if (el) el.textContent = text;
}

/* ==================== 帧渲染（直接渲染场景原貌到导出 canvas） ==================== */

function renderFrame(renderer, scene, cam, w, h) {
  renderer.setSize(w, h, false);
  renderer.render(scene, cam);
}

/* ==================== 主路径：WebCodecs 逐帧 ==================== */

async function exportWithWebCodecs(ctx) {
  const { renderer, scene, cam, runtime, config, width, height, fps, frameCount, overlay } = ctx;

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width, height },
    fastStart: "in-memory",
  });

  let encodeError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      try { muxer.addVideoChunk(chunk, meta); } catch (e) { encodeError = encodeError || e; }
    },
    error: (e) => { encodeError = encodeError || e; },
  });
  encoder.configure(config);

  const frameDuration = Math.round(1_000_000 / fps); // μs
  const keyInterval = Math.max(1, fps * 2);          // 每 2 秒一个关键帧

  try {
    for (let i = 0; i < frameCount; i++) {
      if (encodeError) throw encodeError;
      const t01 = frameCount > 1 ? i / (frameCount - 1) : 0;
      runtime.seekTo(t01);
      renderFrame(renderer, scene, cam, width, height);
      const frame = new VideoFrame(renderer.domElement, {
        timestamp: i * frameDuration,
        duration: frameDuration,
      });
      encoder.encode(frame, { keyFrame: i % keyInterval === 0 });
      frame.close();
      setOverlay(overlay, `正在导出视频 ${i + 1}/${frameCount} 帧`);
      if (ctx.onProgress) { try { ctx.onProgress(i + 1, frameCount); } catch { /* 回调容错 */ } }
      // 背压：队列积压时等 dequeue，避免内存膨胀
      if (encoder.encodeQueueSize > 8) {
        await new Promise((r) => encoder.addEventListener("dequeue", r, { once: true }));
      }
      await new Promise((r) => setTimeout(r, 0)); // 让遮罩/进度绘制
    }
    await encoder.flush();
    if (encodeError) throw encodeError;
    muxer.finalize();
  } finally {
    try { if (encoder.state !== "closed") encoder.close(); } catch { /* 忽略 */ }
  }

  const blob = new Blob([muxer.target.buffer], { type: "video/mp4" });
  return { ok: true, path: "webcodecs", blob, mimeType: "video/mp4", frameCount, fps, width, height };
}

/* ==================== 降级路径：MediaRecorder 实时录制 ==================== */

function pickRecorderMime() {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return null;
  const candidates = [
    'video/mp4;codecs="avc1.42E01E"',
    "video/mp4;codecs=avc1",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm",
  ];
  for (const m of candidates) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch { /* 下一个 */ }
  }
  return null;
}

async function exportWithMediaRecorder(ctx) {
  const { renderer, scene, cam, runtime, width, height, fps, frameCount, duration, bitrate, overlay } = ctx;

  const mime = pickRecorderMime();
  if (!mime) throw new Error("WebCodecs 与 MediaRecorder 均不可用，无法导出视频");

  renderer.setSize(width, height, false);
  const stream = renderer.domElement.captureStream(fps);
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
  const stopped = new Promise((r) => { recorder.onstop = r; });
  recorder.start(250);

  try {
    // 实时遍历轨迹（录制是实时的，不是逐帧确定性渲染——低端机可能掉帧）
    const startT = performance.now();
    await new Promise((resolve) => {
      const step = () => {
        const elapsed = (performance.now() - startT) / 1000;
        const t01 = Math.min(1, elapsed / duration);
        runtime.seekTo(t01);
        renderFrame(renderer, scene, cam, width, height);
        const done = Math.min(frameCount, Math.floor(elapsed * fps) + 1);
        setOverlay(overlay, `正在导出视频 ${done}/${frameCount} 帧（实时录制）`);
        if (ctx.onProgress) { try { ctx.onProgress(done, frameCount); } catch { /* 回调容错 */ } }
        if (elapsed >= duration) resolve();
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  } finally {
    try { if (recorder.state !== "inactive") recorder.stop(); } catch { /* 忽略 */ }
    await stopped;
    for (const t of stream.getTracks()) { try { t.stop(); } catch { /* 忽略 */ } }
  }

  const baseMime = mime.split(";")[0];
  const blob = new Blob(chunks, { type: baseMime });
  return { ok: true, path: "mediarecorder", blob, mimeType: baseMime, frameCount, fps, width, height };
}

/* ==================== 导出入口 ==================== */

let _exporting = false;

/**
 * 沿当前机位轨迹导出 MP4 参考视频。
 *
 * @param {Object} [opts]
 * @param {"720p"|"1080p"|{width:number,height:number}} [opts.resolution="720p"]
 * @param {24|30|60} [opts.fps=24]
 * @param {boolean} [opts.download=true] — false 时只返回 Blob 不触发下载（测试用）
 * @param {boolean} [opts.forceFallback=false] — 强制走 MediaRecorder 降级路径（测试用）
 * @param {Function} [opts.onProgress] — (done:number, total:number) => void
 * @returns {Promise<{ok:boolean, path?:"webcodecs"|"mediarecorder", blob?:Blob,
 *   mimeType?:string, frameCount?:number, fps?:number, width?:number, height?:number,
 *   reason?:string, error?:string}>}
 */
export async function exportTrajectoryMp4(opts = {}) {
  if (_exporting) {
    resolveDeps().showToast("已有视频导出任务进行中", true);
    return { ok: false, reason: "busy" };
  }
  const { runtime, cameraManager, propManager, orbit, showToast } = resolveDeps();
  const toast = (msg, isErr) => { try { showToast(msg, isErr); } catch { console.log("[mp4-export]", msg); } };

  const res = normalizeResolution(opts.resolution ?? "720p");
  const fps = normalizeFps(opts.fps);
  const download = opts.download !== false;

  // ── 轨迹校验（无轨迹/<2 点：友好提示不崩） ──
  const ac = cameraManager?.getActiveCamera?.();
  const traj = ac?.trajectory;
  if (!ac || !traj || traj.enabled === false || !Array.isArray(traj.points) || traj.points.length < 2) {
    toast("当前机位无可用轨迹（需 ≥2 个轨迹点），无法导出视频", true);
    return { ok: false, reason: "no-trajectory" };
  }
  if (!runtime || typeof runtime.seekTo !== "function") {
    toast("轨迹运行时不可用，无法导出视频", true);
    return { ok: false, reason: "no-runtime" };
  }
  const prepared = prepareTrajectory(traj);
  if (!prepared) {
    toast("当前机位轨迹无效（需 ≥2 个轨迹点），无法导出视频", true);
    return { ok: false, reason: "no-trajectory" };
  }

  const renderer = getRenderer();
  if (!renderer) {
    toast("当前环境 WebGL 不可用，无法导出视频", true);
    return { ok: false, reason: "no-webgl" };
  }

  const duration = Number.isFinite(traj.duration) ? Math.min(Math.max(traj.duration, 0.1), 30) : 1;
  const frameCount = Math.max(1, Math.round(duration * fps));
  if (frameCount > 1800) {
    console.warn(`[mp4-export] 帧数 ${frameCount} 超过 1800（${duration}s × ${fps}fps），导出可能耗时较长`);
  }

  const cam = ac.camera;
  const scene = getScene();

  // ── 相机/轨道/进度/renderer 完整快照（导出后恢复，同多帧导出快照模式） ──
  const snapshot = {
    position: cam.position.clone(),
    quaternion: cam.quaternion.clone(),
    fov: cam.fov,
    aspect: cam.aspect,
    pos: Array.isArray(ac.pos) ? ac.pos.slice() : ac.pos,
    target: Array.isArray(ac.target) ? ac.target.slice() : ac.target,
    orbitTarget: orbit?.target?.clone?.() || null,
    orbitEnabled: orbit ? orbit.enabled !== false : null,
    progress: runtime.progress,
    playing: runtime.playing,
    rendererSize: renderer.getSize(new THREE.Vector2()).clone(),
  };

  _exporting = true;
  const overlay = createOverlay();
  const ds = typeof window !== "undefined" ? window.__ds || {} : {};
  const boneEditor = ds.boneEditor || null;
  const skeletonHelpers = ds.skeletonHelpers || null;

  let result;
  try {
    // 播放中先暂停（pause 会恢复 orbit；下方重新锁定），导出全程禁用交互轨道
    if (runtime.playing) runtime.pause();
    if (orbit) orbit.enabled = false;
    propManager?.setGizmoVisible?.(false);
    boneEditor?.beginExport?.();
    skeletonHelpers?.beginExport?.();
    const hiddenVis = hideHelpers();

    // 导出画幅（finally 中随快照恢复）
    cam.aspect = res.width / res.height;
    cam.updateProjectionMatrix();

    const frameCtx = {
      renderer, scene, cam, runtime,
      width: res.width, height: res.height, fps, frameCount, duration,
      bitrate: res.bitrate, overlay,
      onProgress: opts.onProgress,
    };

    try {
      const config = opts.forceFallback ? null : await pickEncoderConfig(res.width, res.height, fps, res.bitrate);
      if (config) {
        frameCtx.config = config;
        result = await exportWithWebCodecs(frameCtx);
      } else {
        if (!opts.forceFallback) {
          console.warn("[mp4-export] WebCodecs 不可用或编码器配置不支持，降级 MediaRecorder 实时录制（非逐帧确定性渲染，低端机可能掉帧）");
        }
        result = await exportWithMediaRecorder(frameCtx);
      }
    } finally {
      restoreHelpers(hiddenVis);
    }
  } catch (e) {
    console.error("[mp4-export] 导出失败:", e);
    toast(`视频导出失败：${e?.message || e}`, true);
    result = { ok: false, reason: "error", error: String(e?.message || e) };
  } finally {
    // ── 恢复（成功/失败都恢复） ──
    try { skeletonHelpers?.endExport?.(); } catch { /* 忽略 */ }
    try { boneEditor?.endExport?.(); } catch { /* 忽略 */ }
    try { propManager?.setGizmoVisible?.(true); } catch { /* 忽略 */ }
    cam.position.copy(snapshot.position);
    cam.quaternion.copy(snapshot.quaternion);
    cam.fov = snapshot.fov;
    cam.aspect = snapshot.aspect;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    if (Array.isArray(snapshot.pos)) ac.pos = snapshot.pos;
    if (Array.isArray(snapshot.target)) ac.target = snapshot.target;
    if (orbit) {
      if (snapshot.orbitTarget) { try { orbit.target.copy(snapshot.orbitTarget); } catch { /* 忽略 */ } }
      orbit.enabled = snapshot.orbitEnabled !== null ? snapshot.orbitEnabled : true;
    }
    // 进度恢复（不触发 seek，避免覆写已恢复的相机姿态；仅同步 UI 滑条）
    runtime.progress = snapshot.progress;
    try { runtime.onUpdate?.(); } catch { /* 忽略 */ }
    try { renderer.setSize(snapshot.rendererSize.width, snapshot.rendererSize.height, false); } catch { /* 忽略 */ }
    overlay.remove();
    _exporting = false;
  }

  if (result?.ok && download) {
    const ext = result.mimeType === "video/mp4" ? "mp4" : "webm";
    const filename = `director_trajectory_${ac.id}_${res.width}x${res.height}_${fps}fps_${Date.now()}.${ext}`;
    triggerDownload(result.blob, filename);
    toast(`🎬 视频已导出：${filename}（${result.path === "webcodecs" ? "逐帧" : "实时录制"}）`, false);
  }
  return result;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ==================== 顶栏按钮 + 参数对话框 ==================== */

const OPTS_STORAGE_KEY = "ds_mp4_export_opts_v1";

function loadSavedOpts() {
  try {
    const raw = localStorage.getItem(OPTS_STORAGE_KEY);
    if (raw) {
      const j = JSON.parse(raw);
      return { resolution: j.resolution === "1080p" ? "1080p" : "720p", fps: normalizeFps(j.fps) };
    }
  } catch { /* 忽略 */ }
  return { resolution: "720p", fps: 24 };
}

function saveOpts(o) {
  try { localStorage.setItem(OPTS_STORAGE_KEY, JSON.stringify(o)); } catch { /* 忽略 */ }
}

/**
 * 构建顶栏「🎬 导出视频」按钮 + 导出参数对话框（自包含 DOM）。
 * main.js 通过动态 import 调用本函数（唯一挂载点）。
 */
export function createMp4ExportUI(deps) {
  _deps = deps || null;
  mountDsHook();

  // ── 顶栏按钮 ──
  const btn = document.createElement("button");
  btn.id = "btnExportVideo";
  btn.textContent = "🎬 导出视频";
  btn.title = "沿当前机位轨迹导出 MP4 参考视频（720p/1080p × 24/30/60fps）";
  btn.style.cssText = "padding:6px 10px;font-size:12px;";
  btn.addEventListener("click", () => toggleDialog());
  const tlBtn = document.getElementById("btnTimeline");
  if (tlBtn) tlBtn.insertAdjacentElement("afterend", btn);
  else {
    const cancelBtn = document.getElementById("btnCancel");
    if (cancelBtn) cancelBtn.insertAdjacentElement("afterend", btn);
    else document.body.appendChild(btn);
  }

  // ── 参数对话框 ──
  const dlg = document.createElement("div");
  dlg.id = "mp4-export-dialog";
  dlg.style.cssText = [
    "display:none", "position:fixed", "right:12px", "top:60px", "width:240px",
    "z-index:9000", "background:var(--panel,#171a22)",
    "border:1px solid var(--border,#2a2f3d)", "border-radius:8px",
    "padding:12px 14px", "font-size:12px", "color:#e6e9f0",
    "box-shadow:0 8px 32px rgba(0,0,0,0.5)",
  ].join(";");
  document.body.appendChild(dlg);

  const saved = loadSavedOpts();
  const rowCss = "display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;";
  const selectCss = "background:#232836;border:1px solid #2a2f3d;color:#e6e9f0;border-radius:4px;padding:3px 6px;font-size:12px;";

  const title = document.createElement("div");
  title.style.cssText = "font-weight:600;font-size:13px;margin-bottom:10px;";
  title.textContent = "🎬 导出轨迹参考视频";
  dlg.appendChild(title);

  // 分辨率
  const resRow = document.createElement("div");
  resRow.style.cssText = rowCss;
  const resLabel = document.createElement("span");
  resLabel.style.cssText = "color:#8a90a0;";
  resLabel.textContent = "分辨率";
  const resSel = document.createElement("select");
  resSel.id = "mp4-export-resolution";
  resSel.style.cssText = selectCss;
  for (const [v, t] of [["720p", "1280 × 720"], ["1080p", "1920 × 1080"]]) {
    const o = document.createElement("option"); o.value = v; o.textContent = t; resSel.appendChild(o);
  }
  resSel.value = saved.resolution;
  resRow.appendChild(resLabel);
  resRow.appendChild(resSel);
  dlg.appendChild(resRow);

  // 帧率
  const fpsRow = document.createElement("div");
  fpsRow.style.cssText = rowCss;
  const fpsLabel = document.createElement("span");
  fpsLabel.style.cssText = "color:#8a90a0;";
  fpsLabel.textContent = "帧率 (fps)";
  const fpsSel = document.createElement("select");
  fpsSel.id = "mp4-export-fps";
  fpsSel.style.cssText = selectCss;
  for (const v of FPS_OPTIONS) {
    const o = document.createElement("option"); o.value = String(v); o.textContent = String(v); fpsSel.appendChild(o);
  }
  fpsSel.value = String(saved.fps);
  fpsRow.appendChild(fpsLabel);
  fpsRow.appendChild(fpsSel);
  dlg.appendChild(fpsRow);

  // 提示行
  const hint = document.createElement("div");
  hint.style.cssText = "color:#8a90a0;font-size:11px;margin-bottom:10px;line-height:1.5;";
  hint.textContent = "时长=轨迹时长；画面自动隐藏网格/Gizmo 等辅助对象；导出后相机姿态自动恢复。";
  dlg.appendChild(hint);

  // 操作行
  const opRow = document.createElement("div");
  opRow.style.cssText = "display:flex;gap:6px;";
  const goBtn = document.createElement("button");
  goBtn.id = "mp4-export-go";
  goBtn.textContent = "开始导出";
  goBtn.style.cssText = "flex:1;padding:5px 8px;font-size:12px;background:#2f9e63;border:none;border-radius:4px;color:#fff;cursor:pointer;";
  goBtn.addEventListener("click", async () => {
    const o = { resolution: resSel.value, fps: parseInt(fpsSel.value, 10) };
    saveOpts(o);
    toggleDialog(false);
    await exportTrajectoryMp4(o);
  });
  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "取消";
  cancelBtn.style.cssText = "padding:5px 10px;font-size:12px;";
  cancelBtn.addEventListener("click", () => toggleDialog(false));
  opRow.appendChild(goBtn);
  opRow.appendChild(cancelBtn);
  dlg.appendChild(opRow);

  let dlgVisible = false;
  function toggleDialog(force) {
    dlgVisible = force !== undefined ? !!force : !dlgVisible;
    dlg.style.display = dlgVisible ? "block" : "none";
    btn.style.background = dlgVisible ? "#2f9e6340" : "";
  }

  return { toggleDialog, button: btn, dialog: dlg };
}

/* ==================== __ds 测试钩子 ==================== */

function mountDsHook() {
  if (typeof window === "undefined") return;
  window.__ds = window.__ds || {};
  window.__ds.exportTrajectoryMp4 = (opts = {}) => exportTrajectoryMp4(opts);
}

// 模块加载即挂载（动态 import 在 main.js 的 __ds 重建之后执行，不会被覆盖）
mountDsHook();
