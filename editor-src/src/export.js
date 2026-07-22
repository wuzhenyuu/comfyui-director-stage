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
  return hidden;
}

function restoreHiddenObjects(propManager) {
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
    characters = [],
  } = opts;

  const scene = getScene();
  const renderer = getRenderer(); // 懒加载，无 WebGL 环境为 null

  // WebGL 依赖通道守卫：depth/normal/lineart/preview/mask 需要 WebGL
  const WEBGL_PASSES = ["depth", "normal", "lineart", "preview", "mask"];
  const needWebGL = [...enabledPasses].some((p) => WEBGL_PASSES.includes(p));
  if (needWebGL && !renderer) {
    throw new Error("当前环境 WebGL 不可用，depth/normal/lineart/preview/mask 通道无法导出。请只勾选 openpose 重试。");
  }
  const hiddenObjects = getHiddenObjects(propManager);

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
        if (characters.length > 0) {
          // Multi-character openpose
          try {
            const allJoints = [];
            characters.forEach((ch) => {
              // Get joints from DS_FigureAPI
              if (window.DS_FigureAPI && window.DS_FigureAPI.getCharacterJoints) {
                const jointData = window.DS_FigureAPI.getCharacterJoints(ch.id);
                if (jointData) {
                  const jointNames = ["Nose", "Neck", "RShoulder", "RElbow", "RWrist",
                    "LShoulder", "LElbow", "LWrist", "RHip", "RKnee", "RAnkle",
                    "LHip", "LKnee", "LAnkle", "REye", "LEye", "REar", "LEar"];
                  const posArr = jointNames.map((n) => {
                    const p = jointData[n];
                    return p ? new THREE.Vector3(p[0], p[1], p[2]) : new THREE.Vector3();
                  });
                  allJoints.push({ id: ch.id, joints: posArr });
                }
              }
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
        const masks = renderCharacterMasks(scene, cam, renderer, exportW, exportH, characters, hiddenObjects);
        for (const [charId, maskCv] of Object.entries(masks)) {
          const filename = `director_mask_${charId}_${camEntry.id}_${t}.png`;
          const maskPath = await uploadCanvas(maskCv, filename);
          manifest.masks.push({ charId, cameraId: camEntry.id, file: maskPath });
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
    restoreHiddenObjects(propManager);
  }

  return { manifest, sceneGz };
}

/**
 * M1-style single-camera apply (backward compatible)
 */
export async function performApply(joints, exportW, exportH, sceneGz) {
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
    { type: "exportDone", payload: { manifest, sceneGz } },
    "*"
  );
  return { manifest, sceneGz };
}

/**
 * 向后兼容：M1 的老 export 函数（避免破坏 __ds 钩子）
 */
export function renderLegacyPoseCanvas(joints, w, h) {
  const cam = getSceneCamera();
  return renderOpenPoseCanvas(joints, cam, w, h);
}

export function renderLegacyDepthCanvas(joints, w, h) {
  const scene = getScene();
  const renderer = getRenderer();
  if (!renderer) return null; // 无 WebGL：depth 通道不可用
  const cam = getSceneCamera();
  const { grid, axes } = getSceneHelpers();
  const pg = grid.visible, pa = axes.visible;
  grid.visible = false;
  axes.visible = false;
  const cv = renderDepthCanvas(scene, cam, renderer, w, h, []);
  grid.visible = pg;
  axes.visible = pa;
  return cv;
}
