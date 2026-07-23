/**
 * char-loader.js — GLB 3D角色模型加载与骨骼映射
 * 
 * 将 GLB 人物模型（UE mannequin 等）加载，自动映射骨骼到 COCO-18 关节，
 * 替换火柴人为真实3D人物。IK 求解器直接驱动 GLB 骨骼。
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

/**
 * UE/Mixamo 骨骼名 → COCO-18 关节索引 的模糊匹配表
 * 按优先级排列，第一个命中即匹配
 */
const BONE_PATTERNS = [
  // [COCO index, regex patterns]
  // 注意：14(Nose)/15(Neck) 等头部关节共享 head 骨骼在一般 GLB 中是预期行为；
  // Nose 用 nose/nosetip 优先匹配，兜底到 head；Eyes/Ears 始终走 head。
  [0,  [/nose/i, /nosetip/i, /mixamorig[:]?Nose(?:Tip)?\b/i, /head/i, /mixamorig:Head/i]],
  [1,  [/neck/i, /mixamorig:Neck/i, /mixamorigNeck\b/i]],
  [2,  [/rightshoulder/i, /RightShoulder/i, /mixamorig[:]?RightArm\b/i, /RightArm\b/i, /right[_\s]*upper[_\s]*arm/i, /R[_\s]*UpperArm/i, /upperarm[_\s]*r\b/i]],
  [3,  [/rightforearm/i, /right[_\s]*(forearm|elbow)/i, /mixamorig[:]?RightForeArm\b/i, /RightForeArm/i, /Forearm[_\s]*[rR]\b/i, /[rR][_\s]*Forearm/i]],
  [4,  [/righthand/i, /RightHand/i, /mixamorig[:]?RightHand\b/i, /R[_\s]*Hand/i, /right[_\s]*hand/i]],
  [5,  [/leftshoulder/i, /LeftShoulder/i, /mixamorig[:]?LeftArm\b/i, /LeftArm\b/i, /left[_\s]*upper[_\s]*arm/i, /L[_\s]*UpperArm/i, /upperarm[_\s]*l\b/i]],
  [6,  [/leftforearm/i, /left[_\s]*(forearm|elbow)/i, /mixamorig[:]?LeftForeArm\b/i, /LeftForeArm/i, /Forearm[_\s]*[lL]\b/i, /[lL][_\s]*Forearm/i]],
  [7,  [/lefthand/i, /LeftHand/i, /mixamorig[:]?LeftHand\b/i, /L[_\s]*Hand/i, /left[_\s]*hand/i]],
  [8,  [/rightupleg/i, /RightUpLeg/i, /R[_\s]*Thigh/i, /right[_\s]*thigh/i]],
  [9,  [/rightleg/i, /RightLeg/i, /R[_\s]*Calf/i, /right[_\s]*calf/i]],
  [10, [/rightfoot/i, /RightFoot/i, /R[_\s]*Foot/i, /right[_\s]*foot/i]],
  [11, [/leftupleg/i, /LeftUpLeg/i, /L[_\s]*Thigh/i, /left[_\s]*thigh/i]],
  [12, [/leftleg/i, /LeftLeg/i, /L[_\s]*Calf/i, /left[_\s]*calf/i]],
  [13, [/leftfoot/i, /LeftFoot/i, /L[_\s]*Foot/i, /left[_\s]*foot/i]],
  [14, [/head/i, /mixamorig:Head/i]],                             // REye — 共享 head
  [15, [/head/i, /mixamorig:Head/i]],                             // LEye
  [16, [/head/i, /mixamorig:Head/i]],                             // REar
  [17, [/head/i, /mixamorig:Head/i]],                             // LEar
];

/**
 * 尝试将骨骼名映射到 COCO-18 关节索引
 */
function mapBoneToJoint(boneName) {
  for (const [jointIdx, patterns] of BONE_PATTERNS) {
    for (const pat of patterns) {
      if (pat.test(boneName)) return jointIdx;
    }
  }
  return -1;
}

/**
 * 从 GLB skeleton 提取 COCO-18 骨骼映射
 * @param {THREE.Skeleton} skeleton
 * @returns {{ bones: THREE.Bone[], mapping: Map<number,THREE.Bone>, boneNames: string[] }}
 */
function extractSkeletonMapping(skeleton) {
  const mapping = new Map();
  const boneNames = skeleton.bones.map(b => b.name);
  
  for (const bone of skeleton.bones) {
    const jointIdx = mapBoneToJoint(bone.name);
    if (jointIdx >= 0 && !mapping.has(jointIdx)) {
      mapping.set(jointIdx, bone);
    }
  }

  return { bones: skeleton.bones, mapping, boneNames };
}

/**
 * 获取骨世界位置（兼容 GLB skeleton bones）
 */
function getWorldPos(obj) {
  const v = new THREE.Vector3();
  if (obj.isBone) {
    obj.getWorldPosition(v);
  } else if (obj.position) {
    v.copy(obj.position);
    if (obj.parent) obj.parent.localToWorld(v);
  }
  return v;
}

/**
 * 加载 GLB 角色并建立 COCO-18 映射
 * @param {string} url - GLB 文件 URL（如 /director_stage/models/ue-mannequin-retopology.glb）
 * @param {THREE.Scene} scene - 场景引用
 * @returns {Promise<{model:THREE.Group, skeleton:THREE.Skeleton, jointMap:Map<number,THREE.Bone>, allBones:THREE.Bone[]}>}
 */
export async function loadGLBCharacter(url, scene) {
  const loader = new GLTFLoader();
  const gltf = await new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, (err) => reject(new Error(err.message || "加载失败")));
  });

  const model = gltf.scene;
  
  // 找到第一个 skinned mesh 的 skeleton
  let skeleton = null;
  model.traverse((child) => {
    if (child.isSkinnedMesh && child.skeleton && !skeleton) {
      skeleton = child.skeleton;
    }
  });

  if (!skeleton) {
    throw new Error("GLB 文件中未找到骨骼（SkinnedMesh.skeleton）");
  }

  // 缩放模型到目标高度
  const bbox = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  bbox.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);
  const targetHeight = 1.8;
  const scale = maxDim > 0 ? targetHeight / maxDim : 1;
  model.scale.setScalar(scale);

  // 居中+贴地
  const center = new THREE.Vector3();
  bbox.getCenter(center);
  model.position.set(-center.x * scale, -bbox.min.y * scale, -center.z * scale);

  scene.add(model);

  // 提取骨骼映射
  const { mapping: jointMap } = extractSkeletonMapping(skeleton);

  return {
    model,
    skeleton,
    jointMap,
    allBones: skeleton.bones,
    boneNames: skeleton.bones.map(b => b.name),
  };
}

/**
 * 获取 GLB 角色的 COCO-18 关节世界坐标
 */
export function getGLBJointPositions(jointMap) {
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
 * 为 GLB 角色的 IK 链创建 target/pole 球
 */
export function createGLBIKTargets(jointMap) {
  const targets = {};
  const group = new THREE.Group();
  group.name = "GLB_IK_Targets";

  // IK 链: rightArm[RShoulder→RElbow→RWrist], leftArm, rightLeg[RHip→RKnee→RAnkle], leftLeg
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
      poleSphere.position.set(mp.x + chain.poleDir[0], mp.y + chain.poleDir[1], mp.z + chain.poleDir[2]);
    }
    poleSphere.userData.ikType = "pole";
    poleSphere.userData.chainName = name;
    group.add(poleSphere);

    targets[name] = { target: targetSphere, pole: poleSphere };
  }

  return { targets, group };
}
