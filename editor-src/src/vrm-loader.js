/**
 * vrm-loader.js — VRM 模型加载与 humanoid 骨骼映射
 *
 * 将 VRM 模型加载到场景中，自动将 VRM humanoid 骨骼映射到 COCO-18 关节，
 * 提供与 char-loader.js 兼容的接口，支持 IK 驱动。
 *
 * 依赖: @pixiv/three-vrm (已安装于 node_modules)
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin } from "@pixiv/three-vrm";

/**
 * VRM humanoid bone name → COCO-18 关节索引映射
 * VRM 0.x 使用 "hips/spine/..." 命名; VRM 1.0 使用相同命名空间
 * 左右通过名称前缀区分
 */
const VRM_TO_COCO = {
  // Head
  head:          0,   // Nose → head
  neck:          1,   // Neck

  // Right arm (VRM: rightUpperArm → rightLowerArm → rightHand)
  rightUpperArm: 2,   // RShoulder
  rightLowerArm: 3,   // RElbow
  rightHand:     4,   // RWrist

  // Left arm
  leftUpperArm:  5,   // LShoulder
  leftLowerArm:  6,   // LElbow
  leftHand:      7,   // LWrist

  // Right leg
  rightUpperLeg: 8,   // RHip
  rightLowerLeg: 9,   // RKnee
  rightFoot:     10,  // RAnkle

  // Left leg
  leftUpperLeg:  11,  // LHip
  leftLowerLeg:  12,  // LKnee
  leftFoot:      13,  // LAnkle

  // Eyes
  leftEye:       15,  // LEye (COCO 15 = left eye)
  rightEye:      14,  // REye (COCO 14 = right eye)
};

/**
 * COCO 索引 16/17 (R/L Ear) 没有精确对应骨骼，近似用 head
 */
const EAR_FALLBACK = 0; // head bone index in VRM

/**
 * 从 VRM humanoid bones 建立 COCO-18 映射
 * @param {object} humanoid - vrm.humanoid (VRMHumanoid)
 * @returns {{ jointMap: Map<number,THREE.Bone>, allBones: THREE.Bone[] }}
 */
function buildJointMap(humanoid) {
  const jointMap = new Map();
  const allBones = [];

  // VRM humanoid.getNormalizedBoneNode(boneName) 或 .getRawBoneNode(boneName)
  // 遍历 VRM 标准骨骼名
  const vrmBoneNames = [
    "head", "neck",
    "rightUpperArm", "rightLowerArm", "rightHand",
    "leftUpperArm", "leftLowerArm", "leftHand",
    "rightUpperLeg", "rightLowerLeg", "rightFoot",
    "leftUpperLeg", "leftLowerLeg", "leftFoot",
    "leftEye", "rightEye",
  ];

  for (const boneName of vrmBoneNames) {
    const cocoIdx = VRM_TO_COCO[boneName];
    if (cocoIdx === undefined) continue;

    // 尝试获取骨骼节点
    let bone = null;
    try {
      // three-vrm v3 API: humanoid.getNormalizedBoneNode(name)
      const node = humanoid.getNormalizedBoneNode(boneName);
      if (node) {
        // normalized node 可能是 Transform 节点，需要找到实际 Bone
        node.traverse((child) => {
          if (child.isBone && !bone) bone = child;
        });
        if (!bone && node.isBone) bone = node;
      }
    } catch (_) { /* fallback below */ }

    if (!bone) {
      try {
        // Fallback: getRawBoneNode (older API)
        const rawNode = humanoid.getRawBoneNode(boneName);
        if (rawNode) {
          if (rawNode.isBone) bone = rawNode;
          else rawNode.traverse((c) => { if (c.isBone && !bone) bone = c; });
        }
      } catch (_) { /* skip */ }
    }

    if (bone) {
      jointMap.set(cocoIdx, bone);
      if (!allBones.includes(bone)) allBones.push(bone);
    }
  }

  // COCO 14/15 = R/L Eye — 已在上面处理
  // COCO 16/17 = R/L Ear — 近似用 head
  const headBone = jointMap.get(0); // head → COCO 0 (Nose)
  if (headBone) {
    if (!jointMap.has(16)) jointMap.set(16, headBone); // REar
    if (!jointMap.has(17)) jointMap.set(17, headBone); // LEar
  }

  return { jointMap, allBones };
}

/**
 * 获取骨骼世界位置
 */
function getWorldPos(obj) {
  const v = new THREE.Vector3();
  if (obj.isBone) {
    obj.getWorldPosition(v);
  } else if (obj.position) {
    obj.getWorldPosition(v);
  }
  return v;
}

/**
 * 加载 VRM 角色并建立 COCO-18 映射
 * @param {string} url - VRM 文件 URL
 * @param {THREE.Scene} scene - 场景引用
 * @returns {Promise<{group:THREE.Group, jointMap:Map<number,THREE.Bone>, ikTargets:object, allBones:THREE.Bone[], vrm:object}>}
 */
export async function loadVRMCharacter(url, scene) {
  // Register VRM plugin with GLTFLoader
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));

  const gltf = await new Promise((resolve, reject) => {
    loader.load(
      url,
      (result) => resolve(result),
      undefined,
      (err) => reject(new Error(err.message || "VRM 加载失败"))
    );
  });

  // Extract VRM instance from GLTF userData
  const vrmInstance = gltf.userData.vrm;
  if (!vrmInstance) {
    throw new Error("VRM 数据解析失败：未找到 userData.vrm");
  }

  const vrmModel = gltf.scene;

  // 缩放到标准身高 1.8m
  const bbox = new THREE.Box3().setFromObject(vrmModel);
  const size = new THREE.Vector3();
  bbox.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);
  const targetHeight = 1.8;
  const scale = maxDim > 0 ? targetHeight / maxDim : 1;
  vrmModel.scale.setScalar(scale);

  // 居中贴地
  const center = new THREE.Vector3();
  bbox.getCenter(center);
  vrmModel.position.set(-center.x * scale, -bbox.min.y * scale, -center.z * scale);

  scene.add(vrmModel);

  // 提取 humanoid 骨骼映射
  const humanoid = vrmInstance.humanoid;
  if (!humanoid) {
    throw new Error("VRM 文件缺少 humanoid 骨骼定义");
  }

  const { jointMap, allBones } = buildJointMap(humanoid);

  // 创建 IK 目标
  const { targets, group: ikGroup } = createVRMIKTargets(jointMap);

  return {
    group: vrmModel,
    jointMap,
    ikTargets: targets,
    ikTargetsGroup: ikGroup,
    allBones,
    vrm: vrmInstance,
    skeleton: findSkeleton(vrmModel),
  };
}

/**
 * 从模型中查找 skeleton（用于 updateMatrixWorld 等）
 */
function findSkeleton(model) {
  let skeleton = null;
  model.traverse((child) => {
    if (child.isSkinnedMesh && child.skeleton && !skeleton) {
      skeleton = child.skeleton;
    }
  });
  return skeleton;
}

/**
 * 为 VRM 角色的 IK 链创建 target/pole 球
 * 与 char-loader.js 的 createGLBIKTargets 接口一致
 * @param {Map<number,THREE.Bone>} jointMap
 * @returns {{ targets: object, group: THREE.Group }}
 */
export function createVRMIKTargets(jointMap) {
  const targets = {};
  const group = new THREE.Group();
  group.name = "VRM_IK_Targets";

  // IK 链定义（与 char-loader.js 一致）
  const chains = {
    rightArm: { root: 2, mid: 3, end: 4, color: 0x44ccff, poleDir: [0, 0, 0.3] },
    leftArm:  { root: 5, mid: 6, end: 7, color: 0x44ccff, poleDir: [0, 0, 0.3] },
    rightLeg: { root: 8, mid: 9, end: 10, color: 0xffcc44, poleDir: [0, 0, -0.3] },
    leftLeg:  { root: 11, mid: 12, end: 13, color: 0xffcc44, poleDir: [0, 0, -0.3] },
  };

  for (const [name, chain] of Object.entries(chains)) {
    const endBone = jointMap.get(chain.end);
    const midBone = jointMap.get(chain.mid);

    // Target 球
    const targetGeo = new THREE.SphereGeometry(0.05, 20, 12);
    const targetMat = new THREE.MeshStandardMaterial({
      color: chain.color, roughness: 0.3, metalness: 0.1,
      emissive: chain.color, emissiveIntensity: 0.5,
    });
    const targetSphere = new THREE.Mesh(targetGeo, targetMat);
    if (endBone) targetSphere.position.copy(getWorldPos(endBone));
    targetSphere.userData.ikType = "target";
    targetSphere.userData.chainName = name;
    group.add(targetSphere);

    // Pole 球
    const poleGeo = new THREE.SphereGeometry(0.03, 16, 8);
    const poleMat = new THREE.MeshStandardMaterial({
      color: 0x88aacc, roughness: 0.4, metalness: 0.05,
      transparent: true, opacity: 0.7,
    });
    const poleSphere = new THREE.Mesh(poleGeo, poleMat);
    if (midBone) {
      const mp = getWorldPos(midBone);
      poleSphere.position.set(
        mp.x + chain.poleDir[0],
        mp.y + chain.poleDir[1],
        mp.z + chain.poleDir[2]
      );
    }
    poleSphere.userData.ikType = "pole";
    poleSphere.userData.chainName = name;
    group.add(poleSphere);

    targets[name] = { target: targetSphere, pole: poleSphere };
  }

  return { targets, group };
}

/**
 * 获取 VRM 角色的 COCO-18 关节世界坐标
 * 返回 18 个 [x,y,z] 数组，与 char-loader.js 的 getGLBJointPositions 接口一致
 * @param {Map<number,THREE.Bone>} jointMap
 * @returns {number[][]}
 */
export function getVRMJointPositions(jointMap) {
  const joints = [];
  for (let i = 0; i < 18; i++) {
    const bone = jointMap.get(i);
    if (bone) {
      const p = getWorldPos(bone);
      joints.push([p.x, p.y, p.z]);
    } else {
      joints.push([0, 0, 0]);
    }
  }
  return joints;
}

/**
 * VRM 文件导入按钮创建（类似 glb-import.js 的模式）
 * 上传到 ComfyUI 后端，返回可加载的 URL
 * @param {Function} onToast - (msg, isErr) => void
 * @returns {{ button: HTMLElement, fileInput: HTMLInputElement }}
 */
export function createVRMImport(onToast) {
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".vrm";
  fileInput.style.display = "none";

  const button = document.createElement("button");
  button.textContent = "📦 导入VRM";
  button.title = "从本地选择 .vrm 文件导入（自动映射 humanoid 骨骼到 COCO-18）";
  button.style.cssText = "padding:6px 12px;font-size:13px;";

  button.addEventListener("click", () => {
    onToast("请选择 .vrm 格式的 VRM 模型文件（可从 VRoid Hub / Booth 等获取）", false);
    fileInput.value = "";
    fileInput.click();
  });

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) return;

    try {
      onToast(`正在导入 VRM: ${file.name}…`, false);

      // 1) 上传到 ComfyUI
      const formData = new FormData();
      formData.append("image", file, file.name);
      formData.append("type", "input");
      formData.append("subfolder", "director_stage");
      formData.append("overwrite", "true");

      const uploadRes = await fetch("/upload/image", { method: "POST", body: formData });
      if (!uploadRes.ok) throw new Error(`上传失败 HTTP ${uploadRes.status}`);
      const uploadJson = await uploadRes.json();
      const relativePath = (uploadJson.subfolder ? uploadJson.subfolder + "/" : "") + uploadJson.name;

      // 2) 构造加载 URL
      const url = `/view?filename=${encodeURIComponent(relativePath)}&type=input`;

      // 3) 通过回调通知 main.js 加载
      if (window.__ds && typeof window.__ds._onVRMLoad === "function") {
        await window.__ds._onVRMLoad(url, file.name);
      } else {
        onToast("VRM 已上传，但加载回调未注册", true);
      }
    } catch (err) {
      console.error("[VRM导入]", err);
      onToast(`❌ VRM导入失败：${err.message || err}`, true);
    }
  });

  return { button, fileInput };
}
