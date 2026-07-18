/**
 * ik-solver.js — THREE.Bone 骨架层级 + CCD IK 求解器
 *
 * 提供：
 *   createBoneHierarchy(tPose) → { rootBone, boneMap: {name→Bone} }
 *   solveCCDIK(chainBones, targetWorldPos, poleWorldPos, maxIter, tolerance)
 *   getBoneWorldPos(bone) → THREE.Vector3
 */
import * as THREE from "three";
import { JOINT_EN, JOINT_PARENT, JOINT_CHILDREN, LIMB_SEQ } from "./constants.js";

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();

/**
 * 创建 THREE.Bone 层级骨架
 * @param {number[][]} tPose - T-pose 世界坐标 [18][x,y,z]
 * @returns {{ rootBone: THREE.Bone, boneMap: Map<string,THREE.Bone>, allBones: THREE.Bone[] }}
 */
export function createBoneHierarchy(tPose) {
  const boneMap = new Map();     // jointName → Bone
  const allBones = [];           // index order

  // 第一遍：创建所有 Bone 对象
  for (let i = 0; i < 18; i++) {
    const bone = new THREE.Bone();
    bone.name = JOINT_EN[i];
    bone.userData.jointIndex = i;
    boneMap.set(JOINT_EN[i], bone);
    allBones.push(bone);
  }

  // 第二遍：建立父子关系（按 JOINT_PARENT）
  for (let i = 0; i < 18; i++) {
    const pi = JOINT_PARENT[i];
    if (pi !== undefined) {
      const parentBone = allBones[pi];
      parentBone.add(allBones[i]);
    }
  }

  // Neck(1) 为根骨骼
  const rootBone = allBones[1];

  // 第三遍：设置每个 Bone 的本地位置（相对于父骨骼在 T-pose 下的偏移）
  for (let i = 0; i < 18; i++) {
    const bone = allBones[i];
    const pi = JOINT_PARENT[i];
    if (pi !== undefined) {
      const parentPos = tPose[pi];
      const myPos = tPose[i];
      bone.position.set(
        myPos[0] - parentPos[0],
        myPos[1] - parentPos[1],
        myPos[2] - parentPos[2],
      );
    } else {
      // Neck 根骨骼：直接设置世界位置
      bone.position.set(tPose[i][0], tPose[i][1], tPose[i][2]);
    }
  }

  return { rootBone, boneMap, allBones };
}

/**
 * 获取骨骼世界坐标
 */
export function getBoneWorldPos(bone) {
  const pos = new THREE.Vector3();
  bone.getWorldPosition(pos);
  return pos;
}

/**
 * CCD IK 求解器（单链）
 *
 * 算法：从末梢前一节向根逐节旋转，使末梢向 target 靠拢。
 * 收敛后施加 pole 约束：绕 root→target 轴旋转使中骨指向 pole。
 *
 * @param {THREE.Bone[]} chainBones - [rootBone, midBone, endBone]
 * @param {THREE.Vector3} targetWorldPos - 末端目标世界位置
 * @param {THREE.Vector3|null} poleWorldPos - 极向量世界位置（可选）
 * @param {number} maxIter - 最大迭代次数
 * @param {number} tolerance - 收敛容差（米）
 * @returns {boolean} 是否收敛
 */
export function solveCCDIK(chainBones, targetWorldPos, poleWorldPos, maxIter = 15, tolerance = 0.0005) {
  if (!chainBones || chainBones.length < 3) return false;

  const rootBone = chainBones[0];
  const midBone  = chainBones[1];
  const endBone  = chainBones[2];

  // 确保世界矩阵是最新的
  // 从根开始递归更新整个子树的 world matrix
  updateBoneWorldMatrix(rootBone);

  const endPos  = new THREE.Vector3();
  const bonePos = new THREE.Vector3();

  let converged = false;

  for (let iter = 0; iter < maxIter; iter++) {
    endBone.getWorldPosition(endPos);

    // 检查收敛
    if (endPos.distanceTo(targetWorldPos) < tolerance) {
      converged = true;
      break;
    }

    // Step 1: 旋转 midBone → 使 mid→end 指向 target
    applyCCDRotationToBone(midBone, targetWorldPos, endPos);

    // 更新世界矩阵
    updateBoneWorldMatrix(rootBone);

    endBone.getWorldPosition(endPos);
    if (endPos.distanceTo(targetWorldPos) < tolerance) {
      converged = true;
      break;
    }

    // Step 2: 旋转 rootBone → 使 root→end 指向 target
    applyCCDRotationToBone(rootBone, targetWorldPos, endPos);

    // 更新世界矩阵
    updateBoneWorldMatrix(rootBone);
  }

  // 施加 pole 约束
  if (poleWorldPos && converged) {
    applyPoleConstraint(rootBone, midBone, endBone, poleWorldPos);
    updateBoneWorldMatrix(rootBone);
  }

  return converged;
}

/**
 * 对单个骨骼施加 CCD 旋转：使 bone→end 指向 target
 */
function applyCCDRotationToBone(bone, targetWorldPos, endEffectorWorldPos) {
  bone.getWorldPosition(bonePos);

  _v1.copy(endEffectorWorldPos).sub(bonePos);
  _v2.copy(targetWorldPos).sub(bonePos);

  const len1 = _v1.length();
  const len2 = _v2.length();
  if (len1 < 1e-8 || len2 < 1e-8) return;

  _v1.normalize();
  _v2.normalize();

  // 计算世界空间旋转
  _q1.setFromUnitVectors(_v1, _v2);

  // 转换为 bone 本地空间
  convertWorldRotationToLocal(bone, _q1, _q2);

  // 应用（premultiply 到当前 quaternion）
  bone.quaternion.premultiply(_q2);
  bone.quaternion.normalize();
}

/**
 * 将世界空间旋转四元数转换为骨骼本地空间
 * localQ = parentWorldQ⁻¹ * worldQ * parentWorldQ
 */
function convertWorldRotationToLocal(bone, worldQ, outQ) {
  if (bone.parent && bone.parent.isBone) {
    bone.parent.getWorldQuaternion(_q1);
    _q1.invert();                         // parentWorldQ⁻¹
    outQ.copy(_q1).multiply(worldQ);
    _q1.invert();                         // 还原为 parentWorldQ
    outQ.multiply(_q1);
  } else {
    outQ.copy(worldQ);
  }
}

/**
 * 施加 pole 约束：绕 root→target 轴旋转 rootBone，
 * 使中骨朝向 pole 方向（控制肘/膝朝向）
 */
function applyPoleConstraint(rootBone, midBone, endBone, poleWorldPos) {
  const rootPos = getBoneWorldPos(rootBone);
  const endPos  = getBoneWorldPos(endBone);
  const midPos  = getBoneWorldPos(midBone);

  // root → end 轴
  const axis = _v1.copy(endPos).sub(rootPos);
  const axisLen = axis.length();
  if (axisLen < 1e-6) return;
  axis.normalize();

  // 将 mid 投影到垂直于 axis 的平面
  const midVec = _v2.copy(midPos).sub(rootPos);
  const midProj = midVec.clone().sub(
    _v3.copy(axis).multiplyScalar(midVec.dot(axis))
  );

  // 将 pole 投影到同一平面
  const poleVec = _v3.copy(poleWorldPos).sub(rootPos);
  const poleProj = poleVec.clone().sub(
    new THREE.Vector3().copy(axis).multiplyScalar(poleVec.dot(axis))
  );

  const midLen = midProj.length();
  const poleLen = poleProj.length();
  if (midLen < 1e-6 || poleLen < 1e-6) return;

  midProj.normalize();
  poleProj.normalize();

  // 计算旋转角度和方向
  const dot = Math.max(-1, Math.min(1, midProj.dot(poleProj)));
  const angle = Math.acos(dot);
  if (angle < 1e-6) return;

  const cross = new THREE.Vector3().crossVectors(midProj, poleProj);
  const sign = cross.dot(axis) > 0 ? 1 : -1;

  // 构造绕 axis 旋转
  _q1.setFromAxisAngle(axis, sign * angle);

  // 转换为 bone 本地空间
  convertWorldRotationToLocal(rootBone, _q1, _q2);
  rootBone.quaternion.premultiply(_q2);
  rootBone.quaternion.normalize();
}

/**
 * 递归更新 Bone 子树的世界矩阵
 */
function updateBoneWorldMatrix(bone) {
  bone.updateMatrix();
  for (const child of bone.children) {
    if (child.isBone) updateBoneWorldMatrix(child);
  }
}
