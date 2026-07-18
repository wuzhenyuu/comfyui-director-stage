/**
 * figure.js — 火柴人（18关节球体 + 连接圆柱）
 */
import * as THREE from "three";
import { T_POSE, LIMB_SEQ, JOINT_COLOR } from "./constants.js";

const _va = new THREE.Vector3();
const _vb = new THREE.Vector3();
const _vd = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/** 创建 18 个关节球体 */
export function createJoints(figureGroup) {
  const jointGeo = new THREE.SphereGeometry(0.035, 24, 16);
  const mat = new THREE.MeshStandardMaterial({ color: JOINT_COLOR, roughness: 0.5, metalness: 0.05 });
  return T_POSE.map((p, i) => {
    const mesh = new THREE.Mesh(jointGeo, mat.clone()); // clone mat so selection can recolor independently
    mesh.position.set(p[0], p[1], p[2]);
    mesh.userData.index = i;
    figureGroup.add(mesh);
    return mesh;
  });
}

/** 创建 17 根骨头圆柱 */
export function createBones(figureGroup) {
  const boneGeo = new THREE.CylinderGeometry(0.012, 0.012, 1, 10, 1, true);
  const boneMat = new THREE.MeshStandardMaterial({ color: 0x9fb8cc, roughness: 0.6, metalness: 0.05 });
  return LIMB_SEQ.map(() => {
    const b = new THREE.Mesh(boneGeo, boneMat);
    figureGroup.add(b);
    return b;
  });
}

/** 根据当前关节位置更新所有骨头圆柱的变换 */
export function updateBones(joints, bones) {
  for (let i = 0; i < LIMB_SEQ.length; i++) {
    const [a, b] = LIMB_SEQ[i];
    _va.copy(joints[a].position);
    _vb.copy(joints[b].position);
    const bone = bones[i];
    bone.position.copy(_va).add(_vb).multiplyScalar(0.5);
    _vd.copy(_vb).sub(_va);
    const len = Math.max(_vd.length(), 1e-6);
    bone.scale.set(1, len, 1);
    bone.quaternion.setFromUnitVectors(_up, _vd.normalize());
  }
}
