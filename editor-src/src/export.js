/**
 * export.js — 批量导出：多相机 × 多通道渲染 → 上传到 ComfyUI
 *
 * Manifest v2 格式:
 * {
 *   "version": 2,
 *   "cameras": [{ "id", "name", "files": { openpose, depth, normal, lineart }, "width", "height", "focalMM", "pose": {pos,target}, "cameraParams": {...} }],
 *   "masks": [{ "charId", "cameraId", "file" }],
 *   "sceneGz": "..."
 * }
 */
import * as THREE from "three";
import { renderOpenPoseCanvas, renderOpenPoseCanvasMulti, renderDepthCanvas, renderNormalCanvas, renderLineartCanvas, renderCharacterMasks, renderPreviewCanvas } from "./pass-renderer.js";
import { getCamera as getSceneCamera, getRenderer, getScene, getSceneHelpers } from "./scene.js";
import { getParentOrigin } from "./protocol.js";
import { prepareTrajectory, evaluatePreparedTrajectory } from "./trajectory.js";

function canvasToBlob(cv) {
  return new Promise((resolve, reject) => {
    cv.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob 失败"))), "image/png");
  });
}

async function uploadCanvas(cv, filename) {
  const blob = await canvasToBlob(cv);
  const fd = new FormData();
  fd.append("image", blob, filename);
  fd.append("subfolder", "director_stage");
  fd.append("type", "input");
  const res = await fetch("/upload/image", { method: "POST", body: fd });
  if (!res.ok) throw new Error(`上传失败 HTTP ${res.status}`);
  const j = await res.json();
  return (j.subfolder ? j.subfolder + "/" : "") + j.name;
}

/**
 * 获取场景中所有需在渲染 pass 时隐藏的辅助对象
 */
function getHiddenObjects(propManager) {
  const { grid, axes } = getSceneHelpers();
  const hidden = [grid, axes];
  // Hide prop gizmo
  if (propManager) propManager.setGizmoVisible(false);
  // P3-1 3D-only：火柴人全部残留（figureGroup + 骨架组 + IK 球组）防御性隐藏，
  // 保证 depth/normal/preview/mask 绝不混入隐藏火柴人。
  const ds = typeof window !== "undefined" ? window.__ds : null;
  if (ds?.figureGroup) hidden.push(ds.figureGroup);
  // P2-fix：DS_FigureAPI 火柴人管理器分支已删除（3D-only 下恒不存在）
  // P2-4：全景球在所有通道隐藏（否则全景模式导出的是球内壁而非场景）
  const sphere = ds?.panorama?.getSphere?.();
  if (sphere) hidden.push(sphere);
  return hidden;
}

/**
 * P3-1：是否处于外部 3D角色模式（3D-only 下恒为 true）
 */
export function isExternalCharacterMode() {
  const ds = typeof window !== "undefined" ? window.__ds : null;
  return !!(ds && (ds.isGLBMode || ds.isVRMMode));
}

/**
 * 解析导出角色列表（P1.5b：外部 GLB/VRM 角色优先）
 *
 * 策略：
 * - window.__ds 处于 GLB/VRM 模式且 externalCharacters 非空时，
 *   使用所有可见外部 entry（group=entry.model，带 external/entry 标记）；
 * - 否则回退到火柴人路径（opts.characters，来自 getCharacterGroups()）。
 *
 * @param {Array<{id:string, group:THREE.Group}>} fallbackCharacters — 火柴人角色
 * @returns {Array<{id:string, name?:string, group:THREE.Object3D, external:boolean, entry?:object}>}
 */
export function resolveExportCharacters(fallbackCharacters = []) {
  const ds = typeof window !== "undefined" ? window.__ds : null;
  const mgr = ds?.externalCharacters;
  // P3-1 3D-only：外部角色模式下只导出 3D角色（即使为 0 个也绝不回退隐藏火柴人）
  if (isExternalCharacterMode() && mgr && typeof mgr.getAll === "function") {
    return mgr.getAll()
      .filter((e) => e && e.model && e.visible !== false)
      .map((e) => ({
        id: e.id,
        name: e.name || e.id,
        group: e.model,
        external: true,
        entry: e,
      }));
  }
  // 兼容回退（仅旧火柴人模式；3D-only 不会走到）
  if (mgr && typeof mgr.getAll === "function" && mgr.size > 0) {
    const entries = mgr.getAll().filter((e) => e && e.model && e.visible !== false);
    if (entries.length > 0) {
      return entries.map((e) => ({
        id: e.id,
        name: e.name || e.id,
        group: e.model,
        external: true,
        entry: e,
      }));
    }
  }
  return (fallbackCharacters || []).map((ch) => ({ ...ch, external: false }));
}

const _extJointV = new THREE.Vector3();

/**
 * 从外部角色 entry 的 jointMap 按 COCO-18 提取关节世界坐标。
 * 缺关节的索引填零向量（[0,0,0]），保证导出不因个别 GLB 骨骼缺失而中断。
 *
 * @param {object} entry — ExternalCharacterManager entry（含 model / jointMap）
 * @returns {THREE.Vector3[]} 18 个关节的世界坐标
 */
export function extractExternalJoints(entry) {
  const joints = [];
  try {
    // 确保骨骼世界矩阵最新（IK/拖拽后导出时 matrixWorld 可能滞后）
    entry?.model?.updateMatrixWorld?.(true);
  } catch { /* 忽略，继续用现有矩阵 */ }
  for (let i = 0; i < 18; i++) {
    const bone = entry?.jointMap?.get?.(i);
    if (bone) {
      try {
        bone.getWorldPosition(_extJointV);
        joints.push(_extJointV.clone());
        continue;
      } catch { /* 落到零向量 */ }
    }
    joints.push(new THREE.Vector3(0, 0, 0));
  }
  return joints;
}

function restoreGizmo(propManager) {
  // P1-fix：可见性恢复已全部交给 pass-renderer 内部的 was-restore（它记录先验状态，是对的）。
  // 原 restoreHiddenObjects 无条件 obj.visible = true 会把用户手动隐藏的 grid/axes 强制点亮、
  // 把 P3-1 要求永久隐藏的 figureGroup 点亮——与 pass-renderer 双重恢复且互相冲突，已删除。
  if (propManager) propManager.setGizmoVisible(true);
}

/**
 * 从 THREE.PerspectiveCamera 提取完整的相机内外参和矩阵
 * @param {THREE.PerspectiveCamera} cam - Three.js 透视相机
 * @param {number} focalMM - 焦距（mm）
 * @returns {Object} 相机参数对象
 */
function extractCameraParams(cam, focalMM) {
  // ─── 内参 ───
  const fovDeg = cam.fov;
  const aspect = cam.aspect;
  const near = cam.near;
  const far = cam.far;
  // 主点假设在图像中心
  const principalPoint = [0.5, 0.5];

  const intrinsics = {
    focalMM: focalMM || 35,
    fovDeg: parseFloat(fovDeg.toFixed(4)),
    aspect: parseFloat(aspect.toFixed(4)),
    near,
    far,
    principalPoint,
  };

  // ─── 外参 ───
  const position = cam.position.toArray().map((v) => parseFloat(v.toFixed(6)));

  // 计算 target：从相机位置沿朝向方向前进 3 个单位
  const dir = new THREE.Vector3();
  cam.getWorldDirection(dir);
  const target = cam.position.clone().add(dir.clone().multiplyScalar(3));
  const targetArr = target.toArray().map((v) => parseFloat(v.toFixed(6)));

  // 提取相机坐标轴（世界空间）
  const up = new THREE.Vector3(0, 1, 0);
  up.applyQuaternion(cam.quaternion).normalize();
  const upArr = up.toArray().map((v) => parseFloat(v.toFixed(6)));

  // forward 是相机朝向（-Z 在相机本地空间，转换为世界空间）
  const forward = dir.clone().normalize();
  const forwardArr = forward.toArray().map((v) => parseFloat(v.toFixed(6)));

  // right = forward × up（或从矩阵提取 X 轴）
  const right = new THREE.Vector3();
  right.crossVectors(forward, up).normalize();
  // 如果 right 为零向量（极端情况），回退到世界 X 轴
  if (right.lengthSq() < 1e-6) {
    right.set(1, 0, 0);
  }
  const rightArr = right.toArray().map((v) => parseFloat(v.toFixed(6)));

  const extrinsics = {
    position: position,
    target: targetArr,
    up: upArr,
    forward: forwardArr,
    right: rightArr,
  };

  // ─── 投影矩阵（4x4，列主序）───
  cam.updateProjectionMatrix();
  const projMatrix = cam.projectionMatrix.toArray().map((v) => parseFloat(v.toFixed(6)));

  // ─── 视图矩阵（4x4，列主序）───
  // Three.js 的 view matrix = camera.matrixWorldInverse
  cam.updateMatrixWorld();
  const viewMatrix = cam.matrixWorldInverse.toArray().map((v) => parseFloat(v.toFixed(6)));

  return {
    intrinsics,
    extrinsics,
    projectionMatrix: projMatrix,
    viewMatrix: viewMatrix,
  };
}

/**
 * 渲染单个视图（相机当前姿态）的全部启用通道并逐通道上传。
 * 从 performBatchExport 机位循环抽出的公共核心（波次2-D）：
 * batch 路径每个机位调用一次；轨迹多帧导出每帧调用一次。
 *
 * 注意：调用方负责机位 aspect 快照/恢复——本函数会把 cam.aspect 改成导出比例。
 *
 * @param {Object} ctx
 * @param {THREE.Scene} ctx.scene
 * @param {THREE.WebGLRenderer|null} ctx.renderer
 * @param {THREE.Mesh[]} ctx.joints — M1 单角色关节（openpose 回退路径）
 * @param {Array} ctx.characters — resolveExportCharacters 结果
 * @param {THREE.Object3D[]} ctx.hiddenObjects — 渲染 pass 时需隐藏的辅助对象
 * @param {number} ctx.exportW
 * @param {number} ctx.exportH
 * @param {Set<string>} ctx.enabledPasses
 * @param {number} ctx.t — 导出时间戳（文件名后缀，整个导出批次共享）
 * @param {Function} ctx.progress — 每完成一个上传操作调用一次
 * @param {Object} camEntry — { id, name, camera, focalMM }
 * @param {string} [nameSuffix] — 文件名中缀（轨迹帧号如 "_f0001"；batch 传 ""）
 * @returns {Promise<{ files:Object, cameraParams:Object, pose:{pos:number[],target:number[]},
 *   masks:Array<{charId:string, name:string, file:string}> }>}
 */
async function renderOneView(ctx, camEntry, nameSuffix = "") {
  const { scene, renderer, joints, characters, hiddenObjects, exportW, exportH, enabledPasses, t, progress } = ctx;
  const cam = camEntry.camera;
  cam.aspect = exportW / exportH;
  cam.updateProjectionMatrix();

  // 提取完整相机参数
  const cameraParams = extractCameraParams(cam, camEntry.focalMM);
  const pose = {
    pos: cam.position.toArray(),
    target: cameraParams.extrinsics.target,
  };

  const files = {};
  const viewMasks = [];

  // ─── OpenPose ───
  if (enabledPasses.has("openpose")) {
    let poseCv;
    // P3-1 3D-only：外部角色模式始终走多角色路径（0 个角色时输出空图，绝不回退火柴人关节）
    if (characters.length > 0 || isExternalCharacterMode()) {
      // Multi-character openpose（火柴人 + 外部 GLB/VRM 角色同图输出）
      try {
        const allJoints = [];
        characters.forEach((ch) => {
          if (ch.external) {
            // 外部 GLB/VRM 角色：从 jointMap 按 COCO-18 提取世界坐标
            allJoints.push({ id: ch.id, joints: extractExternalJoints(ch.entry) });
            return;
          }
          // P2-fix：火柴人（DS_FigureAPI）关节分支已删除（3D-only 不可达）
        });
        poseCv = renderOpenPoseCanvasMulti(allJoints, cam, exportW, exportH);
      } catch (e) {
        // Fallback: use M1 joints with the switched camera
        poseCv = renderOpenPoseCanvas(joints, cam, exportW, exportH);
      }
    } else {
      // M1 single character — use joints directly with this camera
      poseCv = renderOpenPoseCanvas(joints, cam, exportW, exportH);
    }
    const filename = `director_pose_${camEntry.id}${nameSuffix}_${t}.png`;
    files.openpose = await uploadCanvas(poseCv, filename);
    progress();
  }

  // P3-2：当视图的 depth/normal canvas 缓存——lineart 直接复用，
  // 避免 depth+normal+lineart 三通道同开时每视图重复渲染两次全场景
  let depthCvCached = null;
  let normalCvCached = null;

  // ─── Depth ───
  if (enabledPasses.has("depth")) {
    depthCvCached = renderDepthCanvas(scene, cam, renderer, exportW, exportH, hiddenObjects);
    const filename = `director_depth_${camEntry.id}${nameSuffix}_${t}.png`;
    files.depth = await uploadCanvas(depthCvCached, filename);
    progress();
  }

  // ─── Normal ───
  if (enabledPasses.has("normal")) {
    normalCvCached = renderNormalCanvas(scene, cam, renderer, exportW, exportH, hiddenObjects);
    const filename = `director_normal_${camEntry.id}${nameSuffix}_${t}.png`;
    files.normal = await uploadCanvas(normalCvCached, filename);
    progress();
  }

  // ─── Lineart ───
  if (enabledPasses.has("lineart")) {
    // Need depth + normal for lineart; 优先复用当视图已渲染的通道结果
    if (!depthCvCached) depthCvCached = renderDepthCanvas(scene, cam, renderer, exportW, exportH, hiddenObjects);
    if (!normalCvCached) normalCvCached = renderNormalCanvas(scene, cam, renderer, exportW, exportH, hiddenObjects);
    const lineartCv = renderLineartCanvas(depthCvCached, normalCvCached, exportW, exportH);
    const filename = `director_lineart_${camEntry.id}${nameSuffix}_${t}.png`;
    files.lineart = await uploadCanvas(lineartCv, filename);
    progress();
  }

  // ─── Preview（灰模光影参考）───
  if (enabledPasses.has("preview")) {
    const previewCv = renderPreviewCanvas(scene, cam, renderer, exportW, exportH, hiddenObjects);
    const filename = `director_preview_${camEntry.id}${nameSuffix}_${t}.png`;
    files.preview = await uploadCanvas(previewCv, filename);
    progress();
  }

  // ─── Character Masks ───
  if (enabledPasses.has("mask") && characters.length > 0) {
    // P1-fix：mask 通道额外隐藏道具——否则道具在每个角色 mask 里被渲染成白色块
    const maskHidden = hiddenObjects.slice();
    const pm = ctx.propManager;
    if (pm?.getAllMeshes) maskHidden.push(...pm.getAllMeshes());
    const masks = renderCharacterMasks(scene, cam, renderer, exportW, exportH, characters, maskHidden);
    for (const [charId, maskCv] of Object.entries(masks)) {
      const filename = `director_mask_${charId}_${camEntry.id}${nameSuffix}_${t}.png`;
      const maskPath = await uploadCanvas(maskCv, filename);
      const chInfo = characters.find((c) => c.id === charId);
      viewMasks.push({ charId, name: chInfo?.name || charId, file: maskPath });
      progress();
    }
  }

  return { files, cameraParams, pose, masks: viewMasks };
}

/**
 * 执行批量导出
 * @param {Object} opts
 * @param {import("./cameras.js").CameraManager} opts.cameraManager
 * @param {import("./props.js").PropManager} opts.propManager
 * @param {THREE.Mesh[]} opts.joints — M1 单角色关节（向后兼容）
 * @param {Function} opts.getSceneGz — () => string
 * @param {number} opts.exportW
 * @param {number} opts.exportH
 * @param {Set<string>} opts.enabledPasses — e.g. new Set(["openpose","depth","normal","lineart","mask"])
 * @param {Function} opts.onProgress — (msg: string) => void
 * @param {Array<{id:string, group:THREE.Group}>} [opts.characters] — 多角色
 * @returns {Promise<{manifest: object, sceneGz: string}>}
 */
export async function performBatchExport(opts) {
  const {
    cameraManager,
    propManager,
    joints,
    getSceneGz,
    exportW,
    exportH,
    enabledPasses,
    onProgress,
    characters: optsCharacters = [],
  } = opts;

  const scene = getScene();
  const renderer = getRenderer(); // 懒加载，无 WebGL 环境为 null

  // WebGL 依赖通道守卫：depth/normal/lineart/preview/mask 需要 WebGL
  const WEBGL_PASSES = ["depth", "normal", "lineart", "preview", "mask"];
  const needWebGL = [...enabledPasses].some((p) => WEBGL_PASSES.includes(p));
  if (needWebGL && !renderer) {
    throw new Error("当前环境 WebGL 不可用，depth/normal/lineart/preview/mask 通道无法导出。请只勾选 openpose 重试。");
  }
  // P1.5b：GLB/VRM 模式下用外部角色替换火柴人角色列表
  const characters = resolveExportCharacters(optsCharacters);

  const hiddenObjects = getHiddenObjects(propManager);
  // 外部角色的 IK target/pole 球也须隐藏，否则会混入 depth/normal/mask
  characters.forEach((ch) => {
    if (ch.external && ch.entry?.ikTargetsGroup) hiddenObjects.push(ch.entry.ikTargetsGroup);
  });

  const sceneGz = getSceneGz();
  const t = Date.now();
  const manifest = { version: 2, cameras: [], masks: [], sceneGz };

  const allCameras = cameraManager.cameras;
  // P3-1：导出会把每个机位的 cam.aspect 改成导出比例，先快照原始视口比例，
  // 结束后统一恢复（否则视口渲染沿用错误 aspect 直到下次 resize）
  const savedAspects = allCameras.map((c) => c.camera.aspect);
  let totalOps = 0;
  let completedOps = 0;

  // Count total operations
  allCameras.forEach((camEntry) => {
    enabledPasses.forEach((pass) => {
      if (pass === "mask") {
        totalOps += characters.length;
      } else {
        totalOps++;
      }
    });
  });

  function progress() {
    completedOps++;
    if (onProgress) {
      onProgress(`导出中 ${completedOps}/${totalOps}…`);
    }
  }

  // renderOneView 共享上下文（波次2-D 抽取；batch 每个机位调用一次）
  const viewCtx = {
    scene, renderer, joints, characters, hiddenObjects,
    exportW, exportH, enabledPasses, t, progress, propManager,
  };

  try {
    const savedCamId = cameraManager.getActiveCamera()?.id;

    for (const camEntry of allCameras) {
      const { files, cameraParams, pose, masks: viewMasks } = await renderOneView(viewCtx, camEntry);

      const camManifest = {
        id: camEntry.id,
        name: camEntry.name,
        files,
        width: exportW,
        height: exportH,
        focalMM: camEntry.focalMM,
        pose,
        cameraParams: cameraParams,
      };

      for (const m of viewMasks) {
        manifest.masks.push({ charId: m.charId, name: m.name, cameraId: camEntry.id, file: m.file });
      }

      manifest.cameras.push(camManifest);
    }

    // Restore active camera
    if (savedCamId) {
      cameraManager.switchCamera(savedCamId);
    }

  } finally {
    // P3-1：恢复所有机位的视口 aspect（成功/失败都恢复）
    allCameras.forEach((c, i) => {
      if (typeof savedAspects[i] === "number" && c.camera.aspect !== savedAspects[i]) {
        c.camera.aspect = savedAspects[i];
        c.camera.updateProjectionMatrix();
      }
    });
    restoreGizmo(propManager);
  }

  return { manifest, sceneGz };
}

/**
 * M1-style single-camera apply (backward compatible)
 */
export async function performApply(joints, exportW, exportH, sceneGz, extraPayload = null) {
  const scene = getScene();
  const renderer = getRenderer(); // 懒加载，无 WebGL 环境为 null
  if (!renderer) {
    throw new Error("当前环境 WebGL 不可用，无法导出 depth/normal 等 3D 通道。");
  }
  const cam = getSceneCamera();

  // P1-4 fix：与 performBatchExport 对齐——渲染前隐藏全部编辑器辅助对象，
  // 否则 IK 球/骨骼标记/Gizmo/火柴人残留/全景球会污染 depth/normal/preview/lineart。
  const ds = typeof window !== "undefined" ? window.__ds : null;
  const propManager = ds?.propManager || null;
  const boneEditor = ds?.boneEditor || null;
  // getHiddenObjects 覆盖 grid/axes/道具 Gizmo/figureGroup 残留/全景球
  const hiddenObjects = getHiddenObjects(propManager);
  // 防御：外部角色 IK target/pole 球同样隐藏（P1-3 后 M1 正常不含外部角色，双保险）
  const mgr = ds?.externalCharacters;
  if (mgr && typeof mgr.getAll === "function") {
    for (const e of mgr.getAll()) {
      if (e?.ikTargetsGroup) hiddenObjects.push(e.ikTargetsGroup);
    }
  }
  // 骨骼编辑标记/Gizmo 由本函数自行包裹（调用方 onApply 只在 batch 分支包裹）；
  // 骨骼线 skeletonHelpers 由 onApply 统一包裹，此处不重复（begin/endExport 非嵌套安全）。
  boneEditor?.beginExport?.();

  const t = Date.now();

  let poseCv, depthCv, normalCv, previewCv, lineartCv;
  try {
    // 无角色场景（joints 为空）：renderOpenPoseCanvas 无法处理空数组（LIMB_SEQ 索引越界），
    // 输出全黑 openpose 底图，保证「无角色单机位」合法场景 M1 导出不中断。
    if (joints && joints.length) {
      poseCv = renderOpenPoseCanvas(joints, cam, exportW, exportH);
    } else {
      poseCv = document.createElement("canvas");
      poseCv.width = exportW;
      poseCv.height = exportH;
      const ctx = poseCv.getContext("2d");
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, exportW, exportH);
    }
    depthCv = renderDepthCanvas(scene, cam, renderer, exportW, exportH, hiddenObjects);
    normalCv = renderNormalCanvas(scene, cam, renderer, exportW, exportH, hiddenObjects);
    previewCv = renderPreviewCanvas(scene, cam, renderer, exportW, exportH, hiddenObjects);

    // Lineart from depth+normal
    lineartCv = renderLineartCanvas(depthCv, normalCv, exportW, exportH);
  } finally {
    boneEditor?.endExport?.();
    restoreGizmo(propManager);
  }

  const [openpose, depth, normal, lineart, preview] = await Promise.all([
    uploadCanvas(poseCv, `director_pose_${t}.png`),
    uploadCanvas(depthCv, `director_depth_${t}.png`),
    uploadCanvas(normalCv, `director_normal_${t}.png`),
    uploadCanvas(lineartCv, `director_lineart_${t}.png`),
    uploadCanvas(previewCv, `director_preview_${t}.png`),
  ]);

  // 提取完整相机参数
  const cameraParams = extractCameraParams(cam, 35);

  // M1 backward-compat: put files at top level AND include v2 cameras array
  const manifest = {
    version: 2,
    files: { openpose, depth, normal, lineart, preview },
    cameras: [{
      id: "cam_01",
      name: "主镜头",
      files: { openpose, depth, normal, lineart, preview },
      width: exportW,
      height: exportH,
      focalMM: 35,
      pose: { pos: cam.position.toArray(), target: cameraParams.extrinsics.target },
      cameraParams: cameraParams,
    }],
    masks: [],
    sceneGz,
  };

  window.parent.postMessage(
    {
      type: "exportDone",
      payload: {
        manifest,
        sceneGz,
        ...(extraPayload || {}),
      },
    },
    getParentOrigin() // P2-fix：不用 "*"，与 protocol.js 的安全姿态统一
  );
  return { manifest, sceneGz };
}

/* ========================= 轨迹多帧导出（波次2-D） ========================= */

const _trackV1 = new THREE.Vector3();
const _trackV2 = new THREE.Vector3();
const _trackBox = new THREE.Box3();

/**
 * 创建跟踪目标实时世界坐标解析器（export.js 侧自实现，不经 main.js）。
 *  - character：外部角色（GLB/VRM）骨盆 ≈ COCO-18 左右髋（8/11）世界坐标中点；
 *    关节缺失时回退单个髋，再回退模型原点世界坐标。
 *  - prop：道具网格包围盒中心（Box3.setFromObject），失败回退网格原点世界坐标。
 * 找不到目标 / 任何异常 → 返回 null（trajectory.js 回退静态 target）。
 *
 * @returns {(track:{kind:string, id:string}) => number[]|null}
 */
export function createTrackResolver() {
  return (track) => {
    if (!track || !track.id) return null;
    const ds = typeof window !== "undefined" ? window.__ds : null;
    try {
      if (track.kind === "character") {
        const mgr = ds?.externalCharacters;
        const entry = mgr?.get?.(track.id);
        if (!entry?.model) return null;
        try { entry.model.updateMatrixWorld?.(true); } catch { /* 用现有矩阵 */ }
        const lHip = entry.jointMap?.get?.(8);  // COCO-18 右髋
        const rHip = entry.jointMap?.get?.(11); // COCO-18 左髋
        if (lHip && rHip) {
          lHip.getWorldPosition(_trackV1);
          rHip.getWorldPosition(_trackV2);
          return [(_trackV1.x + _trackV2.x) / 2, (_trackV1.y + _trackV2.y) / 2, (_trackV1.z + _trackV2.z) / 2];
        }
        const hip = lHip || rHip;
        if (hip) {
          hip.getWorldPosition(_trackV1);
          return [_trackV1.x, _trackV1.y, _trackV1.z];
        }
        entry.model.getWorldPosition(_trackV1);
        return [_trackV1.x, _trackV1.y, _trackV1.z];
      }
      if (track.kind === "prop") {
        const pm = ds?.propManager;
        const entry = pm?.props?.find?.((p) => p && p.id === track.id);
        if (!entry?.mesh) return null;
        try {
          _trackBox.setFromObject(entry.mesh);
          if (!_trackBox.isEmpty()) {
            _trackBox.getCenter(_trackV1);
            return [_trackV1.x, _trackV1.y, _trackV1.z];
          }
        } catch { /* 落到原点回退 */ }
        entry.mesh.getWorldPosition(_trackV1);
        return [_trackV1.x, _trackV1.y, _trackV1.z];
      }
    } catch {
      return null;
    }
    return null;
  };
}

/**
 * 沿轨迹多帧导出（波次2-D 核心价值）。
 *
 * 帧数 = duration × fps（>300 帧 console.warn）。逐帧：
 *   evaluatePreparedTrajectory(traj, t01, resolveTrack) → 应用相机 pose
 *   （position / lookAt target / fov / updateProjectionMatrix）→ renderOneView
 *   渲染各通道 → 每帧独立上传（文件名带 1 起始的 4 位帧号中缀，如
 *   director_depth_cam_01_f0001_<t>.png）。
 *
 * 帧采样：t01 = f / (frameCount - 1)（含首尾端点，首帧=轨迹起点姿态，末帧=终点）。
 *
 * 相机状态完整快照（position/quaternion/fov/aspect + entry.pos/target），
 * finally 中恢复——导出后相机姿态与导出前一致。
 *
 * 失败语义：单帧渲染/上传抛错 → console.error 记录帧号，跳过该帧继续后续帧；
 * 已上传帧不清理（后端按 str[] 数组加载，缺失文件兜底空白）；全部帧失败才 throw。
 *
 * manifest：cameras[0].files 各通道为帧序文件名数组（str[]）；顶层 masks 同角色
 * 聚合为 file: str[]；顶层另带 fps / frameCount 元信息。无轨迹机位仍走
 * performBatchExport（单帧 str），本函数不产生 str 形式。
 *
 * @param {Object} camEntry — 机位条目 { id, name, camera: THREE.PerspectiveCamera, focalMM }
 * @param {Object} traj — 轨迹数据（cameras[i].trajectory，见 DESIGN.md §1）
 * @param {Object} [opts]
 * @param {number} [opts.exportW=512]
 * @param {number} [opts.exportH=512]
 * @param {Set<string>} [opts.enabledPasses] — 默认 openpose/depth/normal/lineart/preview
 * @param {Function} [opts.onProgress] — (msg: string) => void
 * @param {THREE.Mesh[]} [opts.joints] — M1 openpose 回退关节
 * @param {Array} [opts.characters] — 火柴人回退角色列表（经 resolveExportCharacters）
 * @param {Object} [opts.propManager] — 道具管理器（mask 隐藏道具 / gizmo 恢复）
 * @param {Function} [opts.getSceneGz] — () => string
 * @param {Function} [opts.resolveTrack] — 自定义跟踪解析器（默认 createTrackResolver()）
 * @returns {Promise<{ manifest:object, sceneGz:string }>}
 */
export async function performTrajectoryExport(camEntry, traj, opts = {}) {
  const {
    exportW = 512,
    exportH = 512,
    onProgress,
    joints = [],
    characters: optsCharacters = [],
    propManager = null,
    getSceneGz = () => "",
    resolveTrack = createTrackResolver(),
  } = opts;
  // enabledPasses 容忍 Array / Set（main.js 调用方惯用数组）
  const enabledPasses = opts.enabledPasses instanceof Set
    ? opts.enabledPasses
    : new Set(opts.enabledPasses || ["openpose", "depth", "normal", "lineart", "preview"]);

  if (!camEntry || !camEntry.camera) {
    throw new Error("performTrajectoryExport: 无效机位（缺 camera）");
  }
  const prepared = prepareTrajectory(traj);
  if (!prepared) {
    throw new Error("performTrajectoryExport: 轨迹为空或单点，无法多帧导出");
  }

  const duration = Number.isFinite(traj.duration) ? Math.min(Math.max(traj.duration, 0.1), 30) : 1;
  const fps = Number.isFinite(traj.fps) && traj.fps > 0 ? traj.fps : 24;
  const frameCount = Math.max(1, Math.round(duration * fps));
  if (frameCount > 300) {
    console.warn(`[trajectory-export] 帧数 ${frameCount} 超过 300（${duration}s × ${fps}fps），导出可能耗时较长`);
  }

  const scene = getScene();
  const renderer = getRenderer(); // 懒加载，无 WebGL 环境为 null

  // WebGL 依赖通道守卫（与 performBatchExport 同一规则）
  const WEBGL_PASSES = ["depth", "normal", "lineart", "preview", "mask"];
  const needWebGL = [...enabledPasses].some((p) => WEBGL_PASSES.includes(p));
  if (needWebGL && !renderer) {
    throw new Error("当前环境 WebGL 不可用，depth/normal/lineart/preview/mask 通道无法导出。请只勾选 openpose 重试。");
  }

  const characters = resolveExportCharacters(optsCharacters);
  const hiddenObjects = getHiddenObjects(propManager);
  characters.forEach((ch) => {
    if (ch.external && ch.entry?.ikTargetsGroup) hiddenObjects.push(ch.entry.ikTargetsGroup);
  });

  const cam = camEntry.camera;
  // 相机状态完整快照（导出后恢复）
  const snapshot = {
    position: cam.position.clone(),
    quaternion: cam.quaternion.clone(),
    fov: cam.fov,
    aspect: cam.aspect,
    pos: Array.isArray(camEntry.pos) ? camEntry.pos.slice() : camEntry.pos,
    target: Array.isArray(camEntry.target) ? camEntry.target.slice() : camEntry.target,
  };

  const t = Date.now();
  const sceneGz = getSceneGz();
  const manifest = { version: 2, fps, frameCount, cameras: [], masks: [], sceneGz };

  // 进度计数：帧数 × 通道数（mask 通道按角色数计）
  let totalOps = 0;
  enabledPasses.forEach((pass) => {
    totalOps += (pass === "mask" ? characters.length : 1) * frameCount;
  });
  let completedOps = 0;
  function progress() {
    completedOps++;
    if (onProgress) onProgress(`导出中 ${completedOps}/${totalOps}…`);
  }

  const viewCtx = {
    scene, renderer, joints, characters, hiddenObjects,
    exportW, exportH, enabledPasses, t, progress, propManager,
  };

  const frameTag = (n) => `_f${String(n).padStart(4, "0")}`;
  const filesAcc = {};               // pass -> 帧序文件名数组
  const masksAcc = new Map();        // charId -> { charId, name, files: [] }
  let exportedFrames = 0;
  let firstFrameView = null;         // 首帧 cameraParams/pose（多帧序列的代表性相机参数）

  try {
    for (let f = 0; f < frameCount; f++) {
      const t01 = frameCount > 1 ? f / (frameCount - 1) : 0;
      const pose = evaluatePreparedTrajectory(prepared, t01, resolveTrack);
      cam.position.set(pose.position[0], pose.position[1], pose.position[2]);
      cam.up.set(0, 1, 0);
      cam.lookAt(pose.target[0], pose.target[1], pose.target[2]);
      cam.fov = pose.fov;
      cam.aspect = exportW / exportH;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);

      try {
        const frame = await renderOneView(viewCtx, camEntry, frameTag(f + 1));
        // 帧原子提交：整帧成功才把文件名并入数组（避免跨通道帧错位）
        for (const [pass, file] of Object.entries(frame.files)) {
          (filesAcc[pass] = filesAcc[pass] || []).push(file);
        }
        for (const m of frame.masks) {
          let acc = masksAcc.get(m.charId);
          if (!acc) {
            acc = { charId: m.charId, name: m.name, files: [] };
            masksAcc.set(m.charId, acc);
          }
          acc.files.push(m.file);
        }
        if (!firstFrameView) firstFrameView = { cameraParams: frame.cameraParams, pose: frame.pose };
        exportedFrames++;
      } catch (e) {
        // 已上传帧不清理（后端按数组加载、缺失文件兜底空白）；记录帧号后继续后续帧
        console.error(`[trajectory-export] 帧 ${f + 1}/${frameCount} 导出失败:`, e);
      }
    }
  } finally {
    // 恢复相机状态（成功/失败都恢复）
    cam.position.copy(snapshot.position);
    cam.quaternion.copy(snapshot.quaternion);
    cam.fov = snapshot.fov;
    cam.aspect = snapshot.aspect;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    if (Array.isArray(snapshot.pos)) camEntry.pos = snapshot.pos;
    if (Array.isArray(snapshot.target)) camEntry.target = snapshot.target;
    restoreGizmo(propManager);
  }

  if (exportedFrames === 0) {
    throw new Error(`performTrajectoryExport: ${frameCount} 帧全部导出失败`);
  }
  if (exportedFrames < frameCount) {
    console.warn(`[trajectory-export] ${frameCount - exportedFrames}/${frameCount} 帧失败，manifest 仅含 ${exportedFrames} 帧`);
  }

  const camManifest = {
    id: camEntry.id,
    name: camEntry.name,
    files: filesAcc,
    width: exportW,
    height: exportH,
    focalMM: camEntry.focalMM,
    pose: firstFrameView.pose,
    cameraParams: firstFrameView.cameraParams,
    trajectory: {
      duration,
      fps,
      frameCount,
      exportedFrames,
    },
  };
  manifest.cameras.push(camManifest);
  for (const acc of masksAcc.values()) {
    manifest.masks.push({ charId: acc.charId, name: acc.name, cameraId: camEntry.id, file: acc.files });
  }

  return { manifest, sceneGz };
}

// 波次2-D：挂载轨迹多帧导出到 window.__ds（main.js 用 _prevDsModules 合并保留
// 其他模块在 main.js 之前注入的 __ds 属性，本挂载因此可穿透 __ds 重建）。
if (typeof window !== "undefined") {
  window.__ds = window.__ds || {};
  window.__ds.performTrajectoryExport = (camEntry, traj, opts = {}) =>
    performTrajectoryExport(camEntry, traj, {
      // 默认值在调用时读取（__ds 可能在本模块加载后才重建）
      propManager: window.__ds?.propManager || null,
      joints: window.__ds?.joints || [],
      ...opts,
    });
}
