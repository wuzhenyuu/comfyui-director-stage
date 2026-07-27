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

  try {
    const savedCamId = cameraManager.getActiveCamera()?.id;

    for (const camEntry of allCameras) {
      // Switch to this camera for rendering
      const cam = camEntry.camera;
      cam.aspect = exportW / exportH;
      cam.updateProjectionMatrix();

      // 提取完整相机参数
      const cameraParams = extractCameraParams(cam, camEntry.focalMM);

      const camManifest = {
        id: camEntry.id,
        name: camEntry.name,
        files: {},
        width: exportW,
        height: exportH,
        focalMM: camEntry.focalMM,
        pose: {
          pos: cam.position.toArray(),
          target: cameraParams.extrinsics.target,
        },
        cameraParams: cameraParams,
      };

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
        const filename = `director_pose_${camEntry.id}_${t}.png`;
        camManifest.files.openpose = await uploadCanvas(poseCv, filename);
        progress();
      }

      // ─── Depth ───
      if (enabledPasses.has("depth")) {
        const depthCv = renderDepthCanvas(scene, cam, renderer, exportW, exportH, hiddenObjects);
        const filename = `director_depth_${camEntry.id}_${t}.png`;
        camManifest.files.depth = await uploadCanvas(depthCv, filename);
        progress();
      }

      // ─── Normal ───
      if (enabledPasses.has("normal")) {
        const normalCv = renderNormalCanvas(scene, cam, renderer, exportW, exportH, hiddenObjects);
        const filename = `director_normal_${camEntry.id}_${t}.png`;
        camManifest.files.normal = await uploadCanvas(normalCv, filename);
        progress();
      }

      // ─── Lineart ───
      if (enabledPasses.has("lineart")) {
        // Need depth + normal for lineart; render them as intermediate
        const depthCv2 = renderDepthCanvas(scene, cam, renderer, exportW, exportH, hiddenObjects);
        const normalCv2 = renderNormalCanvas(scene, cam, renderer, exportW, exportH, hiddenObjects);
        const lineartCv = renderLineartCanvas(depthCv2, normalCv2, exportW, exportH);
        const filename = `director_lineart_${camEntry.id}_${t}.png`;
        camManifest.files.lineart = await uploadCanvas(lineartCv, filename);
        progress();
      }

      // ─── Preview（灰模光影参考）───
      if (enabledPasses.has("preview")) {
        const previewCv = renderPreviewCanvas(scene, cam, renderer, exportW, exportH, hiddenObjects);
        const filename = `director_preview_${camEntry.id}_${t}.png`;
        camManifest.files.preview = await uploadCanvas(previewCv, filename);
        progress();
      }

      // ─── Character Masks ───
      if (enabledPasses.has("mask") && characters.length > 0) {
        // P1-fix：mask 通道额外隐藏道具——否则道具在每个角色 mask 里被渲染成白色块
        const maskHidden = hiddenObjects.slice();
        if (propManager?.getAllMeshes) maskHidden.push(...propManager.getAllMeshes());
        const masks = renderCharacterMasks(scene, cam, renderer, exportW, exportH, characters, maskHidden);
        for (const [charId, maskCv] of Object.entries(masks)) {
          const filename = `director_mask_${charId}_${camEntry.id}_${t}.png`;
          const maskPath = await uploadCanvas(maskCv, filename);
          const chInfo = characters.find((c) => c.id === charId);
          manifest.masks.push({ charId, name: chInfo?.name || charId, cameraId: camEntry.id, file: maskPath });
          progress();
        }
      }

      manifest.cameras.push(camManifest);
    }

    // Restore active camera
    if (savedCamId) {
      cameraManager.switchCamera(savedCamId);
    }

  } finally {
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
  const { grid, axes } = getSceneHelpers();

  const prevGrid = grid.visible;
  const prevAxes = axes.visible;
  grid.visible = false;
  axes.visible = false;

  const t = Date.now();

  const poseCv = renderOpenPoseCanvas(joints, cam, exportW, exportH);
  const depthCv = renderDepthCanvas(scene, cam, renderer, exportW, exportH, []);
  const normalCv = renderNormalCanvas(scene, cam, renderer, exportW, exportH, []);
  const previewCv = renderPreviewCanvas(scene, cam, renderer, exportW, exportH, []);

  // Lineart from depth+normal
  const lineartCv = renderLineartCanvas(depthCv, normalCv, exportW, exportH);

  grid.visible = prevGrid;
  axes.visible = prevAxes;

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
