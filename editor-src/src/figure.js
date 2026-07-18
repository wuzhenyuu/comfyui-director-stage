/**
 * figure.js — 火柴人渲染 + 多角色管理 + IK 骨架系统 (M2)
 *
 * M1 兼容：createJoints / createBones / updateBones 保持不变
 * M2 新增：CharacterManager / IK 骨架 / 多角色
 */
import * as THREE from "three";
import {
  T_POSE, LIMB_SEQ, JOINT_COLOR, JOINT_EN,
  IK_CHAINS, CHARACTER_COLORS,
  RIGHT_JOINTS, LEFT_JOINTS,
} from "./constants.js";
import { createBoneHierarchy, solveCCDIK, getBoneWorldPos, updateBoneWorldMatrix } from "./ik-solver.js";

// ===================== 模块级状态 =====================
let charManager = null;

const _va = new THREE.Vector3();
const _vb = new THREE.Vector3();
const _vd = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

// ===================== CharacterManager =====================

export class CharacterManager {
  constructor(scene) {
    this.scene = scene;
    /** @type {Map<string, Object>} */
    this.characters = new Map();
    this.activeCharacterId = null;
    this._colorIdx = 0;

    // 脚钉地跟踪：上一帧活动的根骨骼世界位置
    this._prevRootPos = new THREE.Vector3();
    this._footPinInitialized = false;

    // 所有角色的 IK targets 放在一个独立 Group（不随骨架移动）
    this.ikTargetsGroup = new THREE.Group();
    this.ikTargetsGroup.name = "IK_Targets";
    scene.add(this.ikTargetsGroup);
  }

  /**
   * 创建角色
   * @param {string} id
   * @param {string} name
   * @param {string} [color] - 不传则自动分配
   * @returns {Object} character
   */
  create(id, name, color) {
    if (this.characters.has(id)) {
      console.warn(`[CharacterManager] 角色 ${id} 已存在`);
      return this.characters.get(id);
    }

    const charColor = color || CHARACTER_COLORS[this._colorIdx % CHARACTER_COLORS.length];
    this._colorIdx++;

    // 骨架 Group
    const skeletonGroup = new THREE.Group();
    skeletonGroup.name = `Skeleton_${id}`;
    this.scene.add(skeletonGroup);

    // 创建 Bone 层级
    const { rootBone, boneMap, allBones } = createBoneHierarchy(T_POSE);
    skeletonGroup.add(rootBone);

    // 创建关节球（18 个）
    const jointSpheres = createJointSpheresForCharacter(charColor);
    skeletonGroup.add(jointSpheres.group);

    // 创建骨圆柱（17 根）
    const boneMeshes = createBoneMeshesForCharacter();

    // IK 状态和目标
    const ikState = {};
    const ikTargets = {};
    for (const [chainName, chainDef] of Object.entries(IK_CHAINS)) {
      const chainBones = chainDef.bones.map((idx) => allBones[idx]);

      // target 球（手/脚位置，更大更明显）
      const targetGeo = new THREE.SphereGeometry(0.05, 24, 16);
      const targetMat = new THREE.MeshStandardMaterial({
        color: chainName.includes("Leg") ? 0xffcc44 : 0x44ccff,
        roughness: 0.2,
        metalness: 0.2,
        emissive: chainName.includes("Leg") ? 0x664400 : 0x003366,
        emissiveIntensity: 0.6,
      });
      const targetSphere = new THREE.Mesh(targetGeo, targetMat);
      targetSphere.name = `IK_Target_${id}_${chainName}`;
      targetSphere.userData.ikType = "target";
      targetSphere.userData.characterId = id;
      targetSphere.userData.chainName = chainName;

      // 初始位置 = 末端关节世界坐标
      const endIdx = chainDef.bones[2];
      targetSphere.position.set(T_POSE[endIdx][0], T_POSE[endIdx][1], T_POSE[endIdx][2]);

      this.ikTargetsGroup.add(targetSphere);

      // pole 球（肘/膝方向）
      const poleGeo = new THREE.SphereGeometry(0.025, 16, 8);
      const poleMat = new THREE.MeshStandardMaterial({
        color: 0x88aacc,
        roughness: 0.4,
        metalness: 0.05,
        transparent: true,
        opacity: 0.7,
      });
      const poleSphere = new THREE.Mesh(poleGeo, poleMat);
      poleSphere.name = `IK_Pole_${id}_${chainName}`;
      poleSphere.userData.ikType = "pole";
      poleSphere.userData.characterId = id;
      poleSphere.userData.chainName = chainName;

      // 初始 pole 位置 = 中骨位置 + 偏移
      const midIdx = chainDef.bones[1];
      const poleOffset = computePoleOffset(chainName);
      poleSphere.position.set(
        T_POSE[midIdx][0] + poleOffset[0],
        T_POSE[midIdx][1] + poleOffset[1],
        T_POSE[midIdx][2] + poleOffset[2],
      );

      this.ikTargetsGroup.add(poleSphere);

      ikState[chainName] = { enabled: true, target: targetSphere, pole: poleSphere };
      ikTargets[chainName] = { target: targetSphere, pole: poleSphere };
    }

    const character = {
      id,
      name,
      skeletonGroup,
      rootBone,
      boneMap,
      allBones,
      jointSpheres: jointSpheres.meshes,
      jointSpheresGroup: jointSpheres.group,
      boneMeshes,
      ikState,
      ikTargets,
      visible: true,
      color: charColor,
    };

    this.characters.set(id, character);

    // 如果是第一个角色，设为活动
    if (!this.activeCharacterId) {
      this.activeCharacterId = id;
      this._footPinInitialized = false;
    }

    // 初始同步关节球位置
    this._syncSpheresFromBones(character);

    return character;
  }

  /** 创建默认角色 */
  createDefault() {
    return this.create("char_01", "主角");
  }

  /** 删除角色 */
  remove(id) {
    const char = this.characters.get(id);
    if (!char) return false;

    // 清理 IK targets
    for (const state of Object.values(char.ikState)) {
      this.ikTargetsGroup.remove(state.target);
      this.ikTargetsGroup.remove(state.pole);
      state.target.geometry?.dispose();
      state.target.material?.dispose();
      state.pole.geometry?.dispose();
      state.pole.material?.dispose();
    }

    // 清理关节球
    for (const m of char.jointSpheres) {
      m.geometry?.dispose();
      m.material?.dispose();
    }
    // 清理骨圆柱
    for (const m of char.boneMeshes) {
      m.geometry?.dispose();
      m.material?.dispose();
    }

    // 移除骨架
    this.scene.remove(char.skeletonGroup);
    char.skeletonGroup.traverse((c) => {
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
    });

    this.characters.delete(id);

    // 如果删除的是活动角色，切换到下一个
    if (this.activeCharacterId === id) {
      const remaining = Array.from(this.characters.keys());
      this.activeCharacterId = remaining.length > 0 ? remaining[0] : null;
    }

    return true;
  }

  /** 切换活动角色 */
  setActive(id) {
    if (!this.characters.has(id)) return false;
    this.activeCharacterId = id;
    this._footPinInitialized = false;
    this._updateVisibility();
    return true;
  }

  /** 获取当前活动角色 */
  get active() {
    return this.characters.get(this.activeCharacterId);
  }

  /** 更新角色可见性 */
  _updateVisibility() {
    for (const [id, char] of this.characters) {
      const isActive = id === this.activeCharacterId;
      // 非活动角色半透明
      const opacity = isActive ? 1 : 0.25;
      for (const m of char.jointSpheres) {
        m.material.transparent = true;
        m.material.opacity = isActive ? 1 : 0.3;
        if (!isActive) {
          m.material.color.setHex(0x555555);
        } else {
          // 恢复角色颜色
          const idx = m.userData.index;
          if (RIGHT_JOINTS.has(idx)) m.material.color.setHex(0xff9966);
          else if (LEFT_JOINTS.has(idx)) m.material.color.setHex(0x6699ff);
          else m.material.color.setHex(0xffffff);
        }
      }
      for (const m of char.boneMeshes) {
        m.material.transparent = true;
        m.material.opacity = opacity;
      }
      // IK targets visible only for active
      for (const state of Object.values(char.ikState)) {
        state.target.visible = isActive;
        state.pole.visible = isActive;
      }
      // Skeleton group
      char.skeletonGroup.visible = char.visible;
    }
  }

  /** 从骨架刷新关节球位置 */
  _syncSpheresFromBones(char) {
    for (let i = 0; i < 18; i++) {
      const bone = char.allBones[i];
      const pos = getBoneWorldPos(bone);
      char.jointSpheres[i].position.copy(pos);
    }
  }

  /** 运行 IK 并刷新视觉效果（由动画循环调用） */
  update(char) {
    if (!char) return;

    // 脚钉地：检测活动角色根骨骼位移，补偿腿部 IK targets
    this._applyFootPinning(char);

    // 运行四肢 IK
    for (const [chainName, state] of Object.entries(char.ikState)) {
      if (!state.enabled) continue;
      const chainDef = IK_CHAINS[chainName];
      if (!chainDef) continue;
      const chainBones = chainDef.bones.map((idx) => char.allBones[idx]);

      const targetWorldPos = state.target.position.clone();
      const poleWorldPos = state.pole.position.clone();

      solveCCDIK(
        chainBones,
        targetWorldPos,
        poleWorldPos,
        chainDef.maxIterations,
        chainDef.tolerance,
      );
    }

    // 从骨骼同步关节球位置
    this._syncSpheresFromBones(char);

    // 更新骨圆柱
    updateBoneMeshesFromSpheres(char.jointSpheres, char.boneMeshes);
  }

  /** 脚钉地：根位移 → 补偿腿部 IK targets */
  _applyFootPinning(char) {
    const rootBone = char.rootBone;
    const rootPos = getBoneWorldPos(rootBone);

    if (!this._footPinInitialized) {
      this._prevRootPos.copy(rootPos);
      this._footPinInitialized = true;
      return;
    }

    const delta = rootPos.clone().sub(this._prevRootPos);
    const dLen = delta.length();
    if (dLen < 1e-6) {
      this._prevRootPos.copy(rootPos);
      return;
    }

    // 腿部 IK targets 反向偏移（保持脚在世界空间不动）
    for (const legName of ["leftLeg", "rightLeg"]) {
      const state = char.ikState[legName];
      if (!state || !state.enabled) continue;
      state.target.position.sub(delta);
      state.pole.position.sub(delta);
    }

    this._prevRootPos.copy(rootPos);
  }

  /** 获取角色所有关节世界坐标 */
  getCharacterJoints(id) {
    const char = this.characters.get(id);
    if (!char) return null;
    const result = {};
    for (let i = 0; i < 18; i++) {
      const pos = getBoneWorldPos(char.allBones[i]);
      result[JOINT_EN[i]] = [pos.x, pos.y, pos.z];
    }
    return result;
  }

  /** 获取单个关节世界坐标 */
  getJointWorldPos(id, jointName) {
    const char = this.characters.get(id);
    if (!char) return null;
    const bone = char.boneMap.get(jointName);
    if (!bone) return null;
    const pos = getBoneWorldPos(bone);
    return [pos.x, pos.y, pos.z];
  }

  /** 重命名角色 */
  rename(id, newName) {
    const char = this.characters.get(id);
    if (!char) return false;
    char.name = newName;
    return true;
  }
}

// ===================== 关节球创建 =====================

function createJointSpheresForCharacter(colorHex) {
  const group = new THREE.Group();
  const meshes = [];

  // M2 IK模式：关节球缩小到0.02（纯视觉指示器），IK targets变大到0.05（交互目标）
  const jointGeo = new THREE.SphereGeometry(0.02, 24, 16);
  for (let i = 0; i < 18; i++) {
    let col;
    if (RIGHT_JOINTS.has(i)) col = 0xff9966;
    else if (LEFT_JOINTS.has(i)) col = 0x6699ff;
    else col = 0xffffff;

    const mat = new THREE.MeshStandardMaterial({
      color: col,
      roughness: 0.5,
      metalness: 0.05,
      emissive: col,
      emissiveIntensity: 0.08,
      transparent: true,
      opacity: 0.6,
    });
    const mesh = new THREE.Mesh(jointGeo, mat);
    mesh.position.set(T_POSE[i][0], T_POSE[i][1], T_POSE[i][2]);
    mesh.userData.index = i;
    mesh.userData.isJoint = true;
    mesh.name = `Joint_${i}_${JOINT_EN[i]}`;
    group.add(mesh);
    meshes.push(mesh);
  }

  return { group, meshes };
}

// ===================== 骨圆柱创建 =====================

function createBoneMeshesForCharacter() {
  const boneGeo = new THREE.CylinderGeometry(0.008, 0.008, 1, 10, 1, true);
  const boneMat = new THREE.MeshStandardMaterial({
    color: 0x888899,
    roughness: 0.6,
    metalness: 0.05,
  });
  return LIMB_SEQ.map(() => new THREE.Mesh(boneGeo, boneMat));
}

/**
 * 根据关节球位置更新骨圆柱
 */
function updateBoneMeshesFromSpheres(spheres, boneMeshes) {
  for (let i = 0; i < LIMB_SEQ.length; i++) {
    const [a, b] = LIMB_SEQ[i];
    _va.copy(spheres[a].position);
    _vb.copy(spheres[b].position);
    const bone = boneMeshes[i];
    bone.position.copy(_va).add(_vb).multiplyScalar(0.5);
    _vd.copy(_vb).sub(_va);
    const len = Math.max(_vd.length(), 1e-6);
    bone.scale.set(1, len, 1);
    bone.quaternion.setFromUnitVectors(_up, _vd.normalize());
  }
}

// ===================== Pole 偏移 =====================

function computePoleOffset(chainName) {
  // 胳膊 pole 在后方（+Z），腿 pole 在前方（-Z）
  const isLeg = chainName.includes("Leg");
  const zOff = isLeg ? -0.25 : 0.25;
  // 左侧 X 正偏移，右侧 X 负偏移
  const isLeft = chainName.includes("left") || chainName === "leftArm";
  const xOff = isLeft ? 0.15 : -0.15;
  return [xOff, 0, zOff];
}

// ============================================================
//  M1 向后兼容 API（现有 main.js 调用）
// ============================================================

/**
 * 创建 18 个关节球体（M1 兼容）
 * 如果未初始化 CharacterManager，则自动初始化并创建默认角色
 */
export function createJoints(figureGroup) {
  // 惰性初始化 CharacterManager
  if (!charManager) {
    const scene = figureGroup.parent || figureGroup;
    charManager = new CharacterManager(scene);
    const char = charManager.createDefault();

    // 把关节球从 skeletonGroup 移到 figureGroup
    // （M1 期望关节球直接在 figureGroup 下）
    char.skeletonGroup.remove(char.jointSpheresGroup);
    figureGroup.add(char.jointSpheresGroup);

    // 骨圆柱也移到 figureGroup
    for (const bm of char.boneMeshes) {
      figureGroup.add(bm);
    }

    // 暴露 API
    exposeAPI();
  }

  // 返回当前活动角色的关节球（保证永远是 18 个对象引用）
  return charManager.active ? charManager.active.jointSpheres : [];
}

/**
 * 创建骨圆柱（M1 兼容）
 */
export function createBones(figureGroup) {
  if (!charManager || !charManager.active) return [];
  return charManager.active.boneMeshes;
}

/**
 * 更新骨圆柱 + 运行 IK（M1 兼容）
 * 在 animation loop 中每帧调用
 */
export function updateBones(joints, bones) {
  if (!charManager) return;
  const char = charManager.active;
  if (!char) return;

  // FK 模式：完全不运行 IK，允许自由拖拽关节（M1 兼容）
  if (window.__ds?.fkMode) {
    updateBoneMeshesFromSpheres(char.jointSpheres, char.boneMeshes);
    return;
  }

  // 关键修复：TransformControls 正在拖拽时，
  // 仅运行 IK solve（让 IK target 拖动实时反馈），
  // 但不同步骨骼→关节球（避免覆盖用户拖动）
  const tctrl = window.__ds?.__tctrl;
  if (tctrl && tctrl.dragging) {
    _runIKOnly(char);
    return;
  }

  charManager.update(char);
}

// ===================== API 暴露 =====================

function exposeAPI() {
  if (!charManager) return;

  window.DS_FigureAPI = {
    getActiveCharacter: () => charManager.active,
    getAllCharacters: () => charManager.characters,
    getCharacterList: () => Array.from(charManager.characters.values()).map(c => ({id:c.id, name:c.name, color:c.color})),
    getCharacter: (id) => charManager.characters.get(id),
    createCharacter: (id, name) => charManager.create(id, name),
    addCharacter: (name) => charManager.create(`char_${String(charManager.characters.size + 1).padStart(2,'0')}`, name),
    removeCharacter: (id) => charManager.remove(id),
    setActive: (id) => charManager.setActive(id),
    updateJointsFromSkeleton: (id) => {
      const c = charManager.characters.get(id);
      if (c) charManager._syncSpheresFromBones(c);
    },
    getJointWorldPos: (id, jointName) => charManager.getJointWorldPos(id, jointName),
    getCharacterJoints: (id) => charManager.getCharacterJoints(id),
    getCharacterCount: () => charManager.characters.size,
    getManager: () => charManager,
    applySpheresToBones,
    applyPoseToActive: (jointCoords) => {
      const ch = charManager.active;
      if (!ch) return;
      for (let i = 0; i < 18 && i < jointCoords.length; i++) {
        ch.jointSpheres[i].position.set(jointCoords[i][0], jointCoords[i][1], jointCoords[i][2]);
      }
      applySpheresToBones();

      // 关键：同步 IK targets 到新的手脚位置，防止 IK 求解器拉回旧姿势
      const wristR = ch.jointSpheres[4];   // COCO: RWrist=4
      const wristL = ch.jointSpheres[7];   // LWrist=7
      const ankleR = ch.jointSpheres[10];  // RAnkle=10
      const ankleL = ch.jointSpheres[13];  // LAnkle=13
      const elbowR = ch.jointSpheres[3];   // RElbow=3
      const elbowL = ch.jointSpheres[6];   // LElbow=6
      const kneeR = ch.jointSpheres[9];    // RKnee=9
      const kneeL = ch.jointSpheres[12];   // LKnee=12

      if (ch.ikState.rightArm) {
        ch.ikState.rightArm.target.position.copy(wristR.position);
        ch.ikState.rightArm.pole.position.copy(elbowR.position).add(new THREE.Vector3(0, 0, 0.3));
      }
      if (ch.ikState.leftArm) {
        ch.ikState.leftArm.target.position.copy(wristL.position);
        ch.ikState.leftArm.pole.position.copy(elbowL.position).add(new THREE.Vector3(0, 0, 0.3));
      }
      if (ch.ikState.rightLeg) {
        ch.ikState.rightLeg.target.position.copy(ankleR.position);
        ch.ikState.rightLeg.pole.position.copy(kneeR.position).add(new THREE.Vector3(0, 0, -0.3));
      }
      if (ch.ikState.leftLeg) {
        ch.ikState.leftLeg.target.position.copy(ankleL.position);
        ch.ikState.leftLeg.pole.position.copy(kneeL.position).add(new THREE.Vector3(0, 0, -0.3));
      }

      // 重置脚钉地基准，避免 pose 应用后根位移触发补偿
      charManager._footPinInitialized = false;
    },
  };
}

/**
 * 仅运行 IK 求解，不把骨骼位置同步回关节球
 */
function _runIKOnly(char) {
  const cm = charManager;
  cm._applyFootPinning(char);
  for (const [chainName, state] of Object.entries(char.ikState)) {
    if (!state.enabled) continue;
    const chainDef = IK_CHAINS[chainName];
    if (!chainDef) continue;
    const chainBones = chainDef.bones.map((idx) => char.allBones[idx]);
    const targetWorldPos = state.target.position.clone();
    const poleWorldPos = state.pole.position.clone();
    solveCCDIK(chainBones, targetWorldPos, poleWorldPos, chainDef.maxIterations, chainDef.tolerance);
  }
  updateBoneMeshesFromSpheres(char.jointSpheres, char.boneMeshes);
}

/** 将关节球位置反向应用回骨骼 */
export function applySpheresToBones() {
  if (!charManager) return;
  const char = charManager.active;
  if (!char) return;
  for (let i = 0; i < 18; i++) {
    const pi = JOINT_PARENT[i];
    if (pi === undefined) continue;
    const bone = char.allBones[i];
    const parentBone = char.allBones[pi];
    const targetPos = char.jointSpheres[i].position.clone();
    parentBone.worldToLocal(targetPos);
    bone.position.copy(targetPos);
  }
  updateBoneWorldMatrix(char.allBones[1]);
}
