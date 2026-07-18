/**
 * export.js — 批量导出：多相机 × 多通道渲染 → 上传到 ComfyUI
 *
 * Manifest v2 格式:
 * {
 *   "version": 2,
 *   "cameras": [{ "id", "name", "files": { openpose, depth, normal, lineart }, "width", "height", "focalMM", "pose": {pos,target} }],
 *   "masks": [{ "charId", "cameraId", "file" }],
 *   "sceneGz": "..."
 * }
 */
import { renderOpenPoseCanvas, renderOpenPoseCanvasMulti, renderDepthCanvas, renderNormalCanvas, renderLineartCanvas, renderCharacterMasks } from "./pass-renderer.js";
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
  const renderer = getRenderer();
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

      const camManifest = {
        id: camEntry.id,
        name: camEntry.name,
        files: {},
        width: exportW,
        height: exportH,
        focalMM: camEntry.focalMM,
        pose: {
          pos: cam.position.toArray(),
          target: new THREE.Vector3(0, 1, 0).toArray(), // approximate target
        },
      };

      // Compute render target from camera direction
      const dir = new THREE.Vector3();
      cam.getWorldDirection(dir);
      const target = cam.position.clone().add(dir.multiplyScalar(3));
      camManifest.pose.target = target.toArray();

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
  const renderer = getRenderer();
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

  // Lineart from depth+normal
  const lineartCv = renderLineartCanvas(depthCv, normalCv, exportW, exportH);

  grid.visible = prevGrid;
  axes.visible = prevAxes;

  const [openpose, depth, normal, lineart] = await Promise.all([
    uploadCanvas(poseCv, `director_pose_${t}.png`),
    uploadCanvas(depthCv, `director_depth_${t}.png`),
    uploadCanvas(normalCv, `director_normal_${t}.png`),
    uploadCanvas(lineartCv, `director_lineart_${t}.png`),
  ]);

  // M1 backward-compat: put files at top level AND include v2 cameras array
  const manifest = {
    version: 2,
    files: { openpose, depth, normal, lineart },
    cameras: [{
      id: "cam_01",
      name: "主镜头",
      files: { openpose, depth, normal, lineart },
      width: exportW,
      height: exportH,
      focalMM: 35,
      pose: { pos: [0, 1.4, 3.2], target: [0, 1, 0] },
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
