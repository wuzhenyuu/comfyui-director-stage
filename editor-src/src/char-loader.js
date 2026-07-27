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
/**
 * COCO-18 + Mixamo 手指/趾扩展骨骼映射表。
 *
 * COCO 0-17  = 18 个主干关节（用于 openpose 导出 / IK 求解）。
 * COCO 18-53 = Mixamo 手指/趾/额外脊柱骨骼（仅 char-loader 加载时识别，
 *              bone-editor 通过 _resolveAll 按名字直接匹配，不依赖此表）。
 *
 * COCO 扩展索引分配（与 bone-editor.js CANON_KEYS 对应）：
 *   18=spine1  19=spine2  20=headTop
 *   21=leftThumb1  22=leftThumb2  23=leftThumb3  24=leftThumb4
 *   25=leftIndex1  26=leftIndex2  27=leftIndex3  28=leftIndex4
 *   29=leftMiddle1 30=leftMiddle2 31=leftMiddle3 32=leftMiddle4
 *   33=leftRing1   34=leftRing2   35=leftRing3   36=leftRing4
 *   37=leftPinky1  38=leftPinky2  39=leftPinky3  40=leftPinky4
 *   41=rightThumb1 42=rightThumb2 43=rightThumb3 44=rightThumb4
 *   45=rightIndex1 46=rightIndex2 47=rightIndex3 48=rightIndex4
 *   49=rightMiddle1 50=rightMiddle2 51=rightMiddle3 52=rightMiddle4
 *   53=rightRing1  54=rightRing2  55=rightRing3  56=rightRing4
 *   57=rightPinky1 58=rightPinky2 59=rightPinky3 60=rightPinky4
 *   61=leftToeBase  62=leftToeEnd   63=rightToeBase  64=rightToeEnd
 */
const BONE_PATTERNS = [
  // === COCO 0-17: 主干 18 关节（openpose / IK 必需） ===
  [0,  [/nose/i, /nosetip/i, /mixamorig[:]?Nose(?:Tip)?\b/i, /head/i, /mixamorig:Head/i]],
  [1,  [/neck/i, /mixamorig:Neck/i, /mixamorigNeck\b/i]],
  [1,  [/hips/i, /pelvis/i, /mixamorig:Hips\b/i]],  // Hips (重映射到 idx 1 Neck 链上层，实际在 bone-editor CANON_KEYS 中通过 allBones 名字单独匹配)
  [1,  [/^spine$/i, /mixamorig:Spine\b/i]],           // Spine (同上)
  [2,  [/rightshoulder/i, /RightShoulder/i, /mixamorig[:]?RightArm\b/i, /RightArm\b/i, /right[_\s]*upper[_\s]*arm/i, /R[_\s]*UpperArm/i, /upperarm[_\s]*r\b/i]],
  [3,  [/rightforearm/i, /right[_\s]*(forearm|elbow)/i, /mixamorig[:]?RightForeArm\b/i, /RightForeArm/i, /Forearm[_\s]*[rR]\b/i, /[rR][_\s]*Forearm/i, /lowerarm[_\s]*r\b/i]],
  [5,  [/leftshoulder/i, /LeftShoulder/i, /mixamorig[:]?LeftArm\b/i, /LeftArm\b/i, /left[_\s]*upper[_\s]*arm/i, /L[_\s]*UpperArm/i, /upperarm[_\s]*l\b/i]],
  [6,  [/leftforearm/i, /left[_\s]*(forearm|elbow)/i, /mixamorig[:]?LeftForeArm\b/i, /LeftForeArm/i, /Forearm[_\s]*[lL]\b/i, /[lL][_\s]*Forearm/i, /lowerarm[_\s]*l\b/i]],
  [8,  [/rightupleg/i, /RightUpLeg/i, /R[_\s]*Thigh/i, /right[_\s]*thigh/i, /upperleg[_\s]*r\b/i]],
  [9,  [/rightleg/i, /RightLeg/i, /R[_\s]*Calf/i, /right[_\s]*calf/i, /lowerleg[_\s]*r\b/i]],
  [10, [/rightfoot/i, /RightFoot/i, /R[_\s]*Foot/i, /right[_\s]*foot/i, /foot[_\s]*r\b/i]],
  [11, [/leftupleg/i, /LeftUpLeg/i, /L[_\s]*Thigh/i, /left[_\s]*thigh/i, /upperleg[_\s]*l\b/i]],
  [12, [/leftleg/i, /LeftLeg/i, /L[_\s]*Calf/i, /left[_\s]*calf/i, /lowerleg[_\s]*l\b/i]],
  [13, [/leftfoot/i, /LeftFoot/i, /L[_\s]*Foot/i, /left[_\s]*foot/i, /foot[_\s]*l\b/i]],
  [14, [/head/i, /mixamorig:Head/i]],  // REye
  [15, [/head/i, /mixamorig:Head/i]],  // LEye
  [16, [/head/i, /mixamorig:Head/i]],  // REar
  [17, [/head/i, /mixamorig:Head/i]],  // LEar

  // === COCO 18-20: 额外脊柱/头部 ===
  [18, [/spine1/i, /Spine1/i, /mixamorig:Spine1\b/i]],
  [19, [/spine2/i, /Spine2/i, /mixamorig:Spine2\b/i]],
  [20, [/headtop/i, /HeadTop/i, /mixamorig:HeadTop/i]],

  // === COCO 21-40: 左手五指（每指 4 节：base→mid→tip→nub） ===
  [21, [/left.*thumb1/i, /LeftHandThumb1/i, /mixamorig:LeftHandThumb1\b/i]],
  [22, [/left.*thumb2/i, /LeftHandThumb2/i, /mixamorig:LeftHandThumb2\b/i]],
  [23, [/left.*thumb3/i, /LeftHandThumb3/i, /mixamorig:LeftHandThumb3\b/i]],
  [24, [/left.*thumb4/i, /left.*thumbnub/i, /LeftHandThumb4/i, /mixamorig:LeftHandThumb4\b/i]],
  [25, [/left.*index1/i, /LeftHandIndex1/i, /mixamorig:LeftHandIndex1\b/i]],
  [26, [/left.*index2/i, /LeftHandIndex2/i, /mixamorig:LeftHandIndex2\b/i]],
  [27, [/left.*index3/i, /LeftHandIndex3/i, /mixamorig:LeftHandIndex3\b/i]],
  [28, [/left.*index4/i, /left.*indexnub/i, /LeftHandIndex4/i, /mixamorig:LeftHandIndex4\b/i]],
  [29, [/left.*middle1/i, /LeftHandMiddle1/i, /mixamorig:LeftHandMiddle1\b/i]],
  [30, [/left.*middle2/i, /LeftHandMiddle2/i, /mixamorig:LeftHandMiddle2\b/i]],
  [31, [/left.*middle3/i, /LeftHandMiddle3/i, /mixamorig:LeftHandMiddle3\b/i]],
  [32, [/left.*middle4/i, /left.*middlenub/i, /LeftHandMiddle4/i, /mixamorig:LeftHandMiddle4\b/i]],
  [33, [/left.*ring1/i, /LeftHandRing1/i, /mixamorig:LeftHandRing1\b/i]],
  [34, [/left.*ring2/i, /LeftHandRing2/i, /mixamorig:LeftHandRing2\b/i]],
  [35, [/left.*ring3/i, /LeftHandRing3/i, /mixamorig:LeftHandRing3\b/i]],
  [36, [/left.*ring4/i, /left.*ringnub/i, /LeftHandRing4/i, /mixamorig:LeftHandRing4\b/i]],
  [37, [/left.*pinky1/i, /LeftHandPinky1/i, /mixamorig:LeftHandPinky1\b/i]],
  [38, [/left.*pinky2/i, /LeftHandPinky2/i, /mixamorig:LeftHandPinky2\b/i]],
  [39, [/left.*pinky3/i, /LeftHandPinky3/i, /mixamorig:LeftHandPinky3\b/i]],
  [40, [/left.*pinky4/i, /left.*pinkynub/i, /LeftHandPinky4/i, /mixamorig:LeftHandPinky4\b/i]],

  // === COCO 41-60: 右手五指 ===
  [41, [/right.*thumb1/i, /RightHandThumb1/i, /mixamorig:RightHandThumb1\b/i]],
  [42, [/right.*thumb2/i, /RightHandThumb2/i, /mixamorig:RightHandThumb2\b/i]],
  [43, [/right.*thumb3/i, /RightHandThumb3/i, /mixamorig:RightHandThumb3\b/i]],
  [44, [/right.*thumb4/i, /right.*thumbnub/i, /RightHandThumb4/i, /mixamorig:RightHandThumb4\b/i]],
  [45, [/right.*index1/i, /RightHandIndex1/i, /mixamorig:RightHandIndex1\b/i]],
  [46, [/right.*index2/i, /RightHandIndex2/i, /mixamorig:RightHandIndex2\b/i]],
  [47, [/right.*index3/i, /RightHandIndex3/i, /mixamorig:RightHandIndex3\b/i]],
  [48, [/right.*index4/i, /right.*indexnub/i, /RightHandIndex4/i, /mixamorig:RightHandIndex4\b/i]],
  [49, [/right.*middle1/i, /RightHandMiddle1/i, /mixamorig:RightHandMiddle1\b/i]],
  [50, [/right.*middle2/i, /RightHandMiddle2/i, /mixamorig:RightHandMiddle2\b/i]],
  [51, [/right.*middle3/i, /RightHandMiddle3/i, /mixamorig:RightHandMiddle3\b/i]],
  [52, [/right.*middle4/i, /right.*middlenub/i, /RightHandMiddle4/i, /mixamorig:RightHandMiddle4\b/i]],
  [53, [/right.*ring1/i, /RightHandRing1/i, /mixamorig:RightHandRing1\b/i]],
  [54, [/right.*ring2/i, /RightHandRing2/i, /mixamorig:RightHandRing2\b/i]],
  [55, [/right.*ring3/i, /RightHandRing3/i, /mixamorig:RightHandRing3\b/i]],
  [56, [/right.*ring4/i, /right.*ringnub/i, /RightHandRing4/i, /mixamorig:RightHandRing4\b/i]],
  [57, [/right.*pinky1/i, /RightHandPinky1/i, /mixamorig:RightHandPinky1\b/i]],
  [58, [/right.*pinky2/i, /RightHandPinky2/i, /mixamorig:RightHandPinky2\b/i]],
  [59, [/right.*pinky3/i, /RightHandPinky3/i, /mixamorig:RightHandPinky3\b/i]],
  [60, [/right.*pinky4/i, /right.*pinkynub/i, /RightHandPinky4/i, /mixamorig:RightHandPinky4\b/i]],

  [4,  [/righthand\b/i, /RightHand\b/i, /mixamorig[:]?RightHand\b/i, /[rR][_\s]Hand/i, /palm2[_\s]*r\b/i]],
  [7,  [/lefthand\b/i, /LeftHand\b/i, /mixamorig[:]?LeftHand\b/i, /[lL][_\s]Hand/i, /palm2[_\s]*l\b/i]],
  // === COCO 61-64: 脚趾 ===
  [61, [/left.*toebase/i, /LeftToeBase/i, /mixamorig:LeftToeBase\b/i]],
  [62, [/left.*toe[_\s]*end/i, /LeftToe_End/i, /mixamorig:LeftToe_End\b/i]],
  [63, [/right.*toebase/i, /RightToeBase/i, /mixamorig:RightToeBase\b/i]],
  [64, [/right.*toe[_\s]*end/i, /RightToe_End/i, /mixamorig:RightToe_End\b/i]],
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

  // 检测"脱离链条"的末端骨（如 Rigify 扁平骨架：Foot 直接挂在根骨下，
  // 旋转 UpperLeg/LowerLeg 不会带动 Foot，CCD IK 对腿完全失效）。
  // 记录末端骨相对中段骨的绑定偏移矩阵，IK 求解后手动贴回（见 solveGLB_IK）。
  model.updateMatrixWorld(true);
  const detachedEnds = findDetachedChainEnds(jointMap);

  return {
    model,
    skeleton,
    jointMap,
    allBones: skeleton.bones,
    boneNames: skeleton.bones.map(b => b.name),
    // P3-2：保留 GLB 自带骨骼动画（AnimationClip[]），供动作预设播放
    animations: gltf.animations ?? [],
    detachedEnds,
  };
}

/**
 * 检测 IK 四链中端骨不在 root→mid 子树内的链（扁平骨架）。
 * @param {Map<number,THREE.Bone>} jointMap
 * @returns {Object<string,{mid:THREE.Bone,end:THREE.Bone,offsetMatrix:THREE.Matrix4}>}
 */
export function findDetachedChainEnds(jointMap) {
  const chains = { rightArm: [2, 3, 4], leftArm: [5, 6, 7], rightLeg: [8, 9, 10], leftLeg: [11, 12, 13] };
  const out = {};
  for (const [name, [, m, e]] of Object.entries(chains)) {
    const mid = jointMap.get(m), end = jointMap.get(e);
    if (!mid || !end) continue;
    let p = end.parent, desc = false;
    while (p) { if (p === mid) { desc = true; break; } p = p.parent; }
    if (!desc) {
      mid.updateWorldMatrix(true, false);
      end.updateWorldMatrix(true, false);
      out[name] = {
        mid, end,
        offsetMatrix: mid.matrixWorld.clone().invert().multiply(end.matrixWorld),
      };
    }
  }
  return out;
}

/**
 * 获取 GLB 角色的完整关节世界坐标（65 个，COCO-18 + Mixamo 手指/趾/脊柱扩展）
 */
export function getGLBJointPositions(jointMap) {
  const joints = [];
  for (let i = 0; i < 65; i++) {
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
