/**
 * bone-editor.js — 骨骼编辑模式（核心A：直接骨骼旋转/平移 + 3D Gizmo）
 *
 * 与既有模式的关系：
 *   - IK 模式（默认）：拖 IK target/pole 球 → CCD 解算骨骼（main.js renderLoop）
 *   - 整体移动：点身体拖整人（external-character-move.js）
 *   - 骨骼编辑模式（本模块）：直接点击骨骼节点 → TransformControls Gizmo
 *     三维旋转；hips/root 默认可平移；高级模式开放更多骨骼平移
 *
 * 模式同步策略：
 *   IK → 骨骼：先把 pending 的 IK 解算 flush 到骨骼（solveEntry），暂停动作动画
 *              （ActionRuntime.tick 在骨骼模式被 main.js 冻结 + 显式 pause），
 *              避免动画/IK 覆盖手动姿势。
 *   骨骼 → IK：syncIKFromBones() 按当前手/脚骨骼世界坐标刷新 IK target，
 *              pole 放在当前肘/膝弯曲平面内（bend normal 方向），保证 CCD
 *              首帧即收敛、姿势零漂移；重置 entry._rootPrev 防脚钉地跳变。
 *
 * 数据一致性：
 *   - 任何骨骼改动后：syncIKFromBones()（IK target 实时跟随骨骼）
 *     + skeletonHelpers.syncAll() + __ds.markSceneDirty?.()
 *   - openpose 数据源（jointMap 骨骼）天然同步（直接改的就是骨骼本体）
 *   - sceneJSON 经 manager.snapshot() 的 ikTargets 持久化（已同步）
 *
 * 跨 Agent 契约（pose-presets.js 优先调用）：
 *   - snapshotPoseBones() → { key:{ rotation:[x,y,z], position?:[x,y,z] } }
 *   - applyPoseBones(bones) → boolean（只应用允许平移骨骼的 position）
 *
 * UI 契约：
 *   - [data-edit-mode="ik"|"bone"]           模式切换按钮（active/aria-pressed 反映当前模式）
 *   - [data-gizmo-mode="rotate"|"translate"] Gizmo 模式按钮
 *   - [data-advanced-bone-translate]         高级平移开关（checkbox）
 *   - window.__ds_boneNodeScreen = [{key,name,boneName,x,y,allowTranslate,behind,bone,obj,charId}]
 *     （canvas 相对 CSS 像素，与 __ds_jointScreen 同约定）
 */
import * as THREE from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { selectJoint } from "./controls.js";

/* ========================= 骨骼规范 key ========================= */

/** 契约要求的规范骨骼 key（至少覆盖这些） */
const CANON_KEYS = [
  "hips", "root", "head", "neck", "spine", "chest",
  "rightUpperArm", "rightLowerArm", "rightHand",
  "leftUpperArm", "leftLowerArm", "leftHand",
  "rightUpperLeg", "rightLowerLeg", "rightFoot",
  "leftUpperLeg", "leftLowerLeg", "leftFoot",
];

/** 规范 key → COCO-18 jointMap 索引（GLB/VRM 共用） */
const JOINTMAP_INDEX = {
  head: 0, neck: 1,
  rightUpperArm: 2, rightLowerArm: 3, rightHand: 4,
  leftUpperArm: 5, leftLowerArm: 6, leftHand: 7,
  rightUpperLeg: 8, rightLowerLeg: 9, rightFoot: 10,
  leftUpperLeg: 11, leftLowerLeg: 12, leftFoot: 13,
};

/** jointMap 缺失时的骨骼名模糊匹配 fallback（按优先级排列） */
const NAME_FALLBACKS = {
  head: [/^head$/i, /head/i],
  neck: [/neck/i],
  spine: [/spine[_\s-]*0?1\b/i, /spine/i],
  chest: [/chest/i, /upperchest/i, /spine[_\s-]*0?3\b/i, /spine[_\s-]*0?2\b/i],
  rightUpperArm: [/rightshoulder/i, /right[_\s-]*upper[_\s-]*arm/i, /upperarm[_\s-]*r\b/i, /r[_\s-]*upperarm/i, /shoulder[_\s-]*r\b/i, /mixamorig:rightarm\b/i, /rightarm\b/i],
  rightLowerArm: [/rightforearm/i, /right[_\s-]*(lower[_\s-]*arm|forearm)/i, /forearm[_\s-]*r\b/i, /lowerarm[_\s-]*r\b/i, /r[_\s-]*forearm/i, /rightarm/i, /mixamorig:rightforearm/i],
  rightHand: [/righthand/i, /right[_\s-]*(hand|wrist)/i, /hand[_\s-]*r\b/i, /r[_\s-]*hand/i, /mixamorig:righthand/i],
  leftUpperArm: [/leftshoulder/i, /left[_\s-]*upper[_\s-]*arm/i, /upperarm[_\s-]*l\b/i, /l[_\s-]*upperarm/i, /shoulder[_\s-]*l\b/i, /mixamorig:leftarm\b/i, /leftarm\b/i],
  leftLowerArm: [/leftforearm/i, /left[_\s-]*(lower[_\s-]*arm|forearm)/i, /forearm[_\s-]*l\b/i, /lowerarm[_\s-]*l\b/i, /l[_\s-]*forearm/i, /leftarm/i, /mixamorig:leftforearm/i],
  leftHand: [/lefthand/i, /left[_\s-]*(hand|wrist)/i, /hand[_\s-]*l\b/i, /l[_\s-]*hand/i, /mixamorig:lefthand/i],
  rightUpperLeg: [/rightupleg/i, /right[_\s-]*(up[_\s-]*leg|thigh)/i, /thigh[_\s-]*r\b/i, /upleg[_\s-]*r\b/i, /r[_\s-]*thigh/i, /mixamorig:rightupleg\b/i],
  rightLowerLeg: [/right[_\s-]*(lower[_\s-]*leg|calf|shin)/i, /calf[_\s-]*r\b/i, /shin[_\s-]*r\b/i, /r[_\s-]*calf/i, /rightleg\b/i, /mixamorig:rightleg\b/i],
  rightFoot: [/rightfoot/i, /right[_\s-]*(foot|ankle)/i, /foot[_\s-]*r\b/i, /r[_\s-]*foot/i, /mixamorig:rightfoot/i],
  leftUpperLeg: [/leftupleg/i, /left[_\s-]*(up[_\s-]*leg|thigh)/i, /thigh[_\s-]*l\b/i, /upleg[_\s-]*l\b/i, /l[_\s-]*thigh/i, /mixamorig:leftupleg\b/i],
  leftLowerLeg: [/left[_\s-]*(lower[_\s-]*leg|calf|shin)/i, /calf[_\s-]*l\b/i, /shin[_\s-]*l\b/i, /l[_\s-]*calf/i, /leftleg\b/i, /mixamorig:leftleg\b/i],
  leftFoot: [/leftfoot/i, /left[_\s-]*(foot|ankle)/i, /foot[_\s-]*l\b/i, /l[_\s-]*foot/i, /mixamorig:leftfoot/i],
};

/** IK 链 ↔ 骨骼 key（同步 IK target/pole 用） */
const CHAIN_DEFS = {
  rightArm: { root: "rightUpperArm", mid: "rightLowerArm", end: "rightHand", poleDir: [0, 0, 0.3] },
  leftArm: { root: "leftUpperArm", mid: "leftLowerArm", end: "leftHand", poleDir: [0, 0, 0.3] },
  rightLeg: { root: "rightUpperLeg", mid: "rightLowerLeg", end: "rightFoot", poleDir: [0, 0, -0.3] },
  leftLeg: { root: "leftUpperLeg", mid: "leftLowerLeg", end: "leftFoot", poleDir: [0, 0, -0.3] },
};

/** 默认允许平移的 key（骨盆/根骨骼） */
const DEFAULT_TRANSLATE_KEYS = new Set(["hips", "root"]);

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();

function _round(v, p = 6) {
  return +v.toFixed(p);
}

/* ========================= BoneEditor ========================= */

/**
 * @param {object} deps
 * @param {THREE.Scene} deps.scene
 * @param {import("./external-characters.js").ExternalCharacterManager} deps.manager
 * @param {import("./action-runtime.js").ActionRuntime} [deps.actionRuntime]
 * @param {import("./skeleton-helper.js").SkeletonHelperManager} [deps.skeletonHelpers]
 * @param {() => THREE.Camera} deps.getCamera
 * @param {HTMLElement} deps.dom — 视口 canvas（拾取/投影/Gizmo 事件源）
 * @param {() => object} [deps.getOrbit] — OrbitControls getter（拖拽 Gizmo 时禁用）
 * @param {(entry:object) => void} [deps.solveEntry] — flush 一次 IK 解算到骨骼
 */
export function createBoneEditor({ scene, manager, actionRuntime, skeletonHelpers, getCamera, dom, getOrbit, solveEntry }) {
  /* ---------- 状态 ---------- */
  let mode = "ik";                 // 'ik' | 'bone'
  let gizmoMode = "rotate";        // 'rotate' | 'translate'
  let selectedBone = null;         // 规范 key
  let advancedTranslation = false;
  let markersVisible = true;      // 骨骼标记球显示开关（骨骼模式下生效）
  /** 进入骨骼模式时被我们暂停的动作（退出时恢复） */
  const _pausedByUs = new Set();
  /** 骨骼解析缓存：entry → Map<key, Bone> */
  let _cacheEntry = null;
  let _cacheMap = null;
  /** 导出期间隐藏的临时状态 */
  let _exportSaved = null;

  /* ---------- Gizmo（独立 TransformControls，不影响 controls.js 的 tctrl） ---------- */
  const gizmo = new TransformControls(getCamera(), dom);
  gizmo.setMode("rotate");
  gizmo.setSize(0.55);
  const gizmoHelper = typeof gizmo.getHelper === "function" ? gizmo.getHelper() : gizmo;
  // 契约探测兼容：让 scene.traverse 能找到 isTransformControls 标记
  gizmoHelper.isTransformControls = true;
  gizmoHelper.visible = false;
  scene.add(gizmoHelper);

  gizmo.addEventListener("dragging-changed", (e) => {
    const orbit = getOrbit?.();
    if (orbit) orbit.enabled = !e.value;
    if (!e.value) _afterBoneChange(selectedBone); // 拖拽结束：全量同步
  });
  gizmo.addEventListener("objectChange", () => {
    // 拖拽中：实时保持 IK target / 投影一致
    _liveSync();
  });

  /* ---------- 骨骼节点标记（WebGL 可视化；2D 由 draw2D 绘制） ---------- */
  const markerGroup = new THREE.Group();
  markerGroup.name = "bone-editor-markers";
  markerGroup.visible = false;
  scene.add(markerGroup);
  const _markerGeo = new THREE.SphereGeometry(0.025, 16, 10);
  /** @type {Map<string, THREE.Mesh>} key → marker */
  const _markers = new Map();

  function _markerFor(key) {
    let m = _markers.get(key);
    if (!m) {
      m = new THREE.Mesh(_markerGeo, new THREE.MeshBasicMaterial({
        color: 0xffaa33, depthTest: false, transparent: true, opacity: 0.95,
      }));
      m.renderOrder = 999;
      m.name = `bone-marker:${key}`;
      m.userData.boneEditorMarker = true;
      markerGroup.add(m);
      _markers.set(key, m);
    }
    return m;
  }

  /* ========================= 骨骼解析 ========================= */

  function _activeEntry() {
    return manager?.getActive?.() || null;
  }

  /**
   * 解析 entry 的规范骨骼 key → Bone 映射（带缓存）
   * @returns {Map<string, THREE.Bone>}
   */
  function _resolveAll(entry) {
    if (!entry) return new Map();
    if (_cacheEntry === entry && _cacheMap) return _cacheMap;

    const map = new Map();
    const used = new Set();
    const jm = entry.jointMap;
    for (const [key, idx] of Object.entries(JOINTMAP_INDEX)) {
      const b = jm?.get?.(idx);
      if (b?.isBone && !used.has(b)) {
        map.set(key, b);
        used.add(b);
      }
    }

    // 名称 fallback（jointMap 缺失的 key）
    const bones = (entry.allBones || []).filter((b) => b?.isBone);
    for (const [key, patterns] of Object.entries(NAME_FALLBACKS)) {
      if (map.has(key)) continue;
      for (const re of patterns) {
        const hit = bones.find((b) => !used.has(b) && re.test(b.name || ""));
        if (hit) {
          map.set(key, hit);
          used.add(hit);
          break;
        }
      }
    }

    // hips/root：优先 pelvis/hips 命名；否则顶层骨骼（parent 不是 Bone）
    let hips =
      bones.find((b) => /pelvis|hips/i.test(b.name || "") && !b.parent?.isBone) ||
      bones.find((b) => /pelvis|hips/i.test(b.name || "")) ||
      bones.find((b) => !b.parent?.isBone) ||
      null;
    if (hips) {
      if (!map.has("hips")) map.set("hips", hips);
      if (!map.has("root")) map.set("root", map.get("hips"));
    }

    _cacheEntry = entry;
    _cacheMap = map;
    return map;
  }

  function _bone(key) {
    return _resolveAll(_activeEntry()).get(key) || null;
  }

  /* ========================= 平移权限 ========================= */

  function isTranslateAllowed(key) {
    if (!key) return false;
    if (DEFAULT_TRANSLATE_KEYS.has(key)) return true;
    return advancedTranslation === true && !!_bone(key);
  }

  /* ========================= 数据一致性同步 ========================= */

  function _markDirty() {
    if (typeof window.__ds?.markSceneDirty === "function") window.__ds.markSceneDirty();
  }

  /**
   * 按当前骨骼刷新 IK target/pole（骨骼 → IK 方向同步）。
   * pole 放在当前肘/膝弯曲平面法向（bend normal）上，保证 CCD 首帧收敛零漂移。
   * 作用于全部可见外部角色（多角色快照一致性）。
   */
  function syncIKFromBones() {
    if (!manager?.characters) return;
    for (const entry of manager.characters.values()) {
      if (!entry?.ikTargets) continue;
      const map = _resolveAll(entry);
      for (const [chainName, def] of Object.entries(CHAIN_DEFS)) {
        const t = entry.ikTargets[chainName];
        if (!t?.target || !t?.pole) continue;
        const endBone = map.get(def.end);
        const midBone = map.get(def.mid);
        const rootBone = map.get(def.root);
        if (!endBone) continue;

        // target ← 手/脚骨骼世界坐标（target/pole 球挂在场景级 group 下，position 即世界坐标）
        endBone.getWorldPosition(_v1);
        t.target.position.copy(_v1);

        // pole ← 当前弯曲平面：mid 相对 root→end 轴的垂直分量方向
        if (midBone && rootBone) {
          midBone.getWorldPosition(_v2);   // m
          rootBone.getWorldPosition(_v3);  // r
          const axis = _v1.clone().sub(_v3); // e - r
          if (axis.lengthSq() > 1e-10) {
            axis.normalize();
            const perp = _v2.clone().sub(_v3);
            perp.sub(axis.clone().multiplyScalar(perp.dot(axis)));
            if (perp.lengthSq() > 1e-10) {
              perp.normalize().multiplyScalar(0.3);
              t.pole.position.copy(_v2).add(perp);
            } else {
              t.pole.position.set(
                _v2.x + def.poleDir[0], _v2.y + def.poleDir[1], _v2.z + def.poleDir[2]
              );
            }
          }
        }
      }

      // 重置脚钉地基准，避免 hips 平移后回 IK 模式时腿 target 被 delta 拉飞
      const neck = entry.jointMap?.get?.(1);
      if (neck) {
        if (!entry._rootPrev) entry._rootPrev = new THREE.Vector3();
        neck.getWorldPosition(entry._rootPrev);
      }
    }
  }

  /** 骨骼被改动后的完整同步（IK target + 骨骼显示 + dirty + 投影） */
  function _afterBoneChange(key) {
    const entry = _activeEntry();
    if (entry) entry.allBones?.forEach?.((b) => b.updateMatrixWorld?.());
    syncIKFromBones();
    skeletonHelpers?.syncAll?.();
    _markDirty();
    _refreshProjection();
    window.dispatchEvent(new CustomEvent("ds-bone-editor-changed", {
      detail: { mode, selectedBone, key: key || null },
    }));
  }

  /** 拖拽中的轻量同步（同 _afterBoneChange，成本低，直接复用） */
  function _liveSync() {
    _afterBoneChange(selectedBone);
  }

  /* ========================= 模式切换 ========================= */

  function setMode(next) {
    if (next !== "ik" && next !== "bone") return getMode();
    if (next === mode) {
      _refreshUI();
      return mode;
    }

    if (next === "bone") {
      // IK → 骨骼：flush pending IK 解算到骨骼，保证骨骼模式从最新 IK 姿势开始
      if (manager?.characters && typeof solveEntry === "function") {
        for (const entry of manager.characters.values()) {
          if (entry?._ikDirty) {
            try { solveEntry(entry); } catch (e) { console.warn("[骨骼编辑] IK flush 失败:", e); }
          }
        }
      }
      // 暂停动作动画（避免动画覆盖手动姿势）；退出时恢复
      _pausedByUs.clear();
      if (manager?.characters && actionRuntime) {
        for (const entry of manager.characters.values()) {
          if (actionRuntime.isPlaying?.(entry.id)) {
            actionRuntime.pause(entry.id);
            _pausedByUs.add(entry.id);
          }
        }
      }
      mode = "bone";
      selectJoint(null); // 清掉 IK 球/关节选中，避免高亮串台
      selectedBone = null;
      gizmo.detach();
      gizmoHelper.visible = false;
      markerGroup.visible = markersVisible;
      _refreshProjection();
      window.__ds?.showToast?.("🦴 骨骼编辑：点击标记点选中骨骼，拖拽 Gizmo 旋转/平移", false);
    } else {
      // 骨骼 → IK：按当前骨骼刷新 IK target/pole，IK 解算首帧即收敛（姿势不重置）
      syncIKFromBones();
      mode = "ik";
      selectedBone = null;
      gizmo.detach();
      gizmoHelper.visible = false;
      markerGroup.visible = false;
      window.__ds_boneNodeScreen = [];
      // 恢复我们暂停的动作
      for (const id of _pausedByUs) {
        try { actionRuntime?.resume?.(id); } catch (_) { /* ignore */ }
      }
      _pausedByUs.clear();
      manager?.markAllIKDirty?.();
    }

    _refreshUI();
    window.dispatchEvent(new CustomEvent("ds-bone-editor-changed", {
      detail: { mode, selectedBone },
    }));
    return mode;
  }

  function getMode() {
    return mode;
  }

  function isBoneMode() {
    return mode === "bone";
  }

  /* ========================= 选择 & Gizmo ========================= */

  function selectBone(key) {
    if (key && !_bone(key)) {
      console.warn(`[骨骼编辑] 未解析到骨骼: ${key}`);
      return false;
    }
    selectedBone = key || null;
    if (selectedBone) {
      _attachGizmo();
    } else {
      gizmo.detach();
      gizmoHelper.visible = false;
    }
    _refreshMarkerColors();
    _refreshProjection();
    window.dispatchEvent(new CustomEvent("ds-bone-editor-changed", {
      detail: { mode, selectedBone },
    }));
    return !!selectedBone;
  }

  function getSelectedBone() {
    return selectedBone;
  }

  function _attachGizmo() {
    const bone = _bone(selectedBone);
    if (!bone) {
      gizmo.detach();
      gizmoHelper.visible = false;
      return;
    }
    // 平移权限不足时强制 rotate（ hips/root 或高级模式才放行 translate ）
    const eff = gizmoMode === "translate" && isTranslateAllowed(selectedBone) ? "translate" : "rotate";
    gizmo.setMode(eff);
    gizmo.attach(bone);
    gizmoHelper.visible = true;
  }

  function setGizmoMode(m) {
    if (m !== "rotate" && m !== "translate") return gizmoMode;
    gizmoMode = m;
    if (selectedBone) _attachGizmo();
    _refreshUI();
    return gizmoMode;
  }

  function getGizmoMode() {
    return gizmoMode;
  }

  function setAdvancedTranslation(v) {
    advancedTranslation = !!v;
    // 关闭时若 Gizmo 处于 translate 但骨骼不再允许平移 → 降级 rotate
    if (selectedBone) _attachGizmo();
    _refreshUI();
    _refreshProjection(); // allowTranslate 标志变化，刷新投影缓存
    return advancedTranslation;
  }

  function isAdvancedTranslation() {
    return advancedTranslation;
  }

  function setMarkersVisible(v) {
    markersVisible = !!v;
    markerGroup.visible = isBoneMode() && markersVisible;
    _refreshUI();
    return markersVisible;
  }

  function isMarkersVisible() {
    return markersVisible;
  }

  /* ========================= 骨骼读写 API ========================= */

  function getBoneRotation(key) {
    const b = _bone(key);
    return b ? [b.rotation.x, b.rotation.y, b.rotation.z] : null;
  }

  function getBonePosition(key) {
    const b = _bone(key);
    return b ? [b.position.x, b.position.y, b.position.z] : null;
  }

  function setBoneRotation(key, rot) {
    const b = _bone(key);
    if (!b || !Array.isArray(rot) || rot.length < 3) return false;
    b.rotation.set(+rot[0] || 0, +rot[1] || 0, +rot[2] || 0);
    _afterBoneChange(key);
    return true;
  }

  function setBonePosition(key, pos) {
    const b = _bone(key);
    if (!b || !Array.isArray(pos) || pos.length < 3) return false;
    if (!isTranslateAllowed(key)) return false;
    b.position.set(+pos[0] || 0, +pos[1] || 0, +pos[2] || 0);
    _afterBoneChange(key);
    return true;
  }

  /** 旋转骨骼（局部欧拉角增量，弧度） */
  function rotateBone(key, delta) {
    const b = _bone(key);
    if (!b || !Array.isArray(delta)) return false;
    b.rotation.x += +delta[0] || 0;
    b.rotation.y += +delta[1] || 0;
    b.rotation.z += +delta[2] || 0;
    _afterBoneChange(key);
    return true;
  }

  /**
   * 平移骨骼（世界坐标增量，米）——内部换算到父空间，保证世界位移方向正确
   * （armature 可能带旋转/缩放，直接加局部坐标会跑偏）
   */
  function translateBone(key, delta) {
    const b = _bone(key);
    if (!b || !Array.isArray(delta)) return false;
    if (!isTranslateAllowed(key)) {
      console.warn(`[骨骼编辑] ${key} 不允许平移（hips/root 默认允许，其余需开启高级平移）`);
      return false;
    }
    _v1.set(+delta[0] || 0, +delta[1] || 0, +delta[2] || 0);
    const p = b.parent;
    if (p) {
      p.getWorldQuaternion(_q1).invert();
      _v1.applyQuaternion(_q1);
      p.getWorldScale(_v2);
      if (Math.abs(_v2.x) > 1e-8) _v1.x /= _v2.x;
      if (Math.abs(_v2.y) > 1e-8) _v1.y /= _v2.y;
      if (Math.abs(_v2.z) > 1e-8) _v1.z /= _v2.z;
    }
    b.position.add(_v1);
    _afterBoneChange(key);
    return true;
  }

  function getSelectedTransform() {
    if (!selectedBone) return null;
    const b = _bone(selectedBone);
    if (!b) return null;
    return {
      key: selectedBone,
      boneName: b.name,
      rotation: [b.rotation.x, b.rotation.y, b.rotation.z],
      position: [b.position.x, b.position.y, b.position.z],
      allowTranslate: isTranslateAllowed(selectedBone),
    };
  }

  /* ========================= 姿态快照/应用（pose-presets 契约） ========================= */

  /**
   * 快照活动角色规范骨骼姿势。
   * @returns {{ [key]: { rotation:[x,y,z], position?:[x,y,z] } }}
   */
  function snapshotPoseBones() {
    const map = _resolveAll(_activeEntry());
    const out = {};
    for (const [key, b] of map) {
      if (!b?.isBone) continue;
      const rec = { rotation: [_round(b.rotation.x), _round(b.rotation.y), _round(b.rotation.z)] };
      if (isTranslateAllowed(key)) {
        rec.position = [_round(b.position.x, 5), _round(b.position.y, 5), _round(b.position.z, 5)];
      }
      out[key] = rec;
    }
    return out;
  }

  /**
   * 应用骨骼姿势到活动角色（只影响活动角色）。
   * - 规范 key：按 key 匹配；position 仅应用到当前允许平移的骨骼
   * - 非规范 key（fallback 快照的原始骨骼名）：按骨骼名匹配；
   *   position 仅应用到顶层骨骼（parent 不是 Bone）
   * @param {object} bones
   * @returns {boolean} 至少应用 1 根骨骼
   */
  function applyPoseBones(bones) {
    const entry = _activeEntry();
    if (!entry || !bones || typeof bones !== "object") return false;
    const map = _resolveAll(entry);
    const all = (entry.allBones || []).filter((b) => b?.isBone);
    let applied = 0;

    for (const [key, rec] of Object.entries(bones)) {
      if (!rec) continue;
      let b = map.get(key) || null;
      let allowPos = b ? isTranslateAllowed(key) : false;
      if (!b) {
        // 原始骨骼名路径（pose-presets fallback 快照）
        b = all.find((x) => x.name === key) || null;
        allowPos = !!(b && !b.parent?.isBone);
      }
      if (!b) continue;
      if (Array.isArray(rec.rotation) && rec.rotation.length >= 3) {
        b.rotation.set(+rec.rotation[0] || 0, +rec.rotation[1] || 0, +rec.rotation[2] || 0);
      }
      if (allowPos && Array.isArray(rec.position) && rec.position.length >= 3) {
        b.position.set(+rec.position[0] || 0, +rec.position[1] || 0, +rec.position[2] || 0);
      }
      applied++;
    }

    if (applied === 0) { console.warn("[bone-editor] applyPoseBones applied 0 bones"); return false; }
    console.log("[bone-editor] applyPoseBones applied", applied, "bones");
    // 跳过后 60 帧 IK 求解（约 1 秒）：避免 renderLoop 的 CCD solver 覆盖刚写入的骨骼旋转
    if (entry) entry._skipIKFrames = 60;
    _afterBoneChange(null); // 内含 syncIKFromBones + skeletonHelpers.syncAll + dirty
    return true;
  }

  /* ========================= 状态 ========================= */

  function getState() {
    const map = _resolveAll(_activeEntry());
    const bonesState = {};
    for (const [key, b] of map) {
      if (!b?.isBone) continue;
      bonesState[key] = {
        allowTranslate: isTranslateAllowed(key),
        rotation: [b.rotation.x, b.rotation.y, b.rotation.z],
        position: [b.position.x, b.position.y, b.position.z],
      };
    }
    return {
      mode,
      gizmoMode,
      selectedBone,
      advancedTranslation,
      gizmoVisible: isBoneMode() && !!selectedBone && gizmoHelper.visible === true,
      bones: bonesState,
    };
  }

  /* ========================= 屏幕投影 & 拾取 ========================= */

  function _refreshProjection() {
    if (!isBoneMode()) {
      window.__ds_boneNodeScreen = [];
      return;
    }
    const cam = getCamera?.();
    const entry = _activeEntry();
    if (!cam || !entry || !dom) {
      window.__ds_boneNodeScreen = [];
      return;
    }
    const w = dom.clientWidth || 0;
    const h = dom.clientHeight || 0;
    if (w <= 0 || h <= 0) {
      window.__ds_boneNodeScreen = [];
      return;
    }
    const map = _resolveAll(entry);
    const out = [];
    for (const [key, b] of map) {
      if (!b?.isBone) continue;
      b.getWorldPosition(_v1).project(cam);
      const behind = _v1.z > 1;
      out.push({
        key,
        name: key,          // 契约 B：name 用规范名
        boneName: b.name,   // 原始骨骼名
        x: (_v1.x + 1) / 2 * w,
        y: (1 - _v1.y) / 2 * h,
        allowTranslate: isTranslateAllowed(key),
        behind,
        bone: b,            // 测试容错读取路径（node.bone / node.obj）
        obj: b,
        charId: entry.id,
      });
    }
    window.__ds_boneNodeScreen = out;
  }

  /** 更新标记球位置（WebGL 可视化） */
  function _refreshMarkers() {
    if (!isBoneMode()) {
      markerGroup.visible = false;
      return;
    }
    markerGroup.visible = markersVisible;
    const map = _resolveAll(_activeEntry());
    for (const [key, m] of _markers) {
      const b = map.get(key);
      if (!b) { m.visible = false; continue; }
      b.getWorldPosition(m.position);
      m.visible = true;
    }
    _refreshMarkerColors();
  }

  function _refreshMarkerColors() {
    for (const [key, m] of _markers) {
      if (key === selectedBone) m.material.color.setHex(0xffffff);
      else if (isTranslateAllowed(key)) m.material.color.setHex(0x66ff99);
      else m.material.color.setHex(0xffaa33);
    }
  }

  /**
   * Canvas2D 骨骼节点绘制（scene.js drawFrame 钩子 → main.js 转发）。
   * 仅骨骼模式绘制；WebGL 模式下节点由 markerGroup 3D 球显示。
   */
  function draw2D(camRef, w, h, ctx2d) {
    if (!isBoneMode() || !ctx2d) return;
    const list = window.__ds_boneNodeScreen || [];
    for (const n of list) {
      if (n.behind) continue;
      const isSel = n.key === selectedBone;
      const r = isSel ? 8 : 5.5;
      ctx2d.beginPath();
      ctx2d.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx2d.fillStyle = isSel ? "#ffffff" : n.allowTranslate ? "#66ff99" : "#ffaa33";
      ctx2d.fill();
      ctx2d.strokeStyle = isSel ? "#ffcc33" : "#000000";
      ctx2d.lineWidth = isSel ? 2.5 : 1;
      ctx2d.stroke();
    }
  }

  /* ---------- 指针拾取（骨骼模式下接管 canvas 点击选择；controls.js 已让路） ---------- */

  let _downXY = null;
  dom.addEventListener("pointerdown", (e) => {
    if (!isBoneMode() || e.button !== 0) return;
    _downXY = [e.clientX, e.clientY];
  });
  dom.addEventListener("pointerup", (e) => {
    if (!isBoneMode() || e.button !== 0) return;
    if (!_downXY) return;
    const moved = Math.hypot(e.clientX - _downXY[0], e.clientY - _downXY[1]) > 5;
    _downXY = null;
    if (moved) return;                 // 拖拽（orbit/Gizmo）不算点击
    if (gizmo.dragging) return;        // 点在 Gizmo 手柄上不改选

    const r = dom.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    let best = null;
    let bestD = 16; // 命中半径（px）
    for (const n of window.__ds_boneNodeScreen || []) {
      if (n.behind) continue;
      const d = Math.hypot(n.x - mx, n.y - my);
      if (d < bestD) { bestD = d; best = n; }
    }
    selectBone(best ? best.key : null); // 点空白取消选择
  });
  dom.addEventListener("pointerleave", () => { _downXY = null; });

  /* ========================= 每帧更新（main.js renderLoop 调用） ========================= */

  function update() {
    // Gizmo 相机跟随活动机位
    const cam = getCamera?.();
    if (cam && gizmo.camera !== cam) gizmo.camera = cam;

    if (!isBoneMode()) {
      if ((window.__ds_boneNodeScreen || []).length) window.__ds_boneNodeScreen = [];
      if (markerGroup.visible) markerGroup.visible = false;
      return;
    }
    _refreshProjection();
    _refreshMarkers();
  }

  /* ========================= 导出保护（标记/Gizmo 不混入导出通道） ========================= */

  function beginExport() {
    if (_exportSaved) return;
    _exportSaved = { markers: markerGroup.visible, gizmo: gizmoHelper.visible };
    markerGroup.visible = false;
    gizmoHelper.visible = false;
  }

  function endExport() {
    if (!_exportSaved) return;
    markerGroup.visible = _exportSaved.markers;
    gizmoHelper.visible = _exportSaved.gizmo;
    _exportSaved = null;
  }

  /* ========================= UI（模式/Gizmo/高级平移控件） ========================= */

  let _ui = null;

  function mountUI() {
    if (_ui) return _ui;
    const anchor = document.getElementById("btnCancel");
    if (!anchor) return null;

    const wrap = document.createElement("span");
    wrap.id = "bone-editor-controls";
    wrap.style.cssText = "display:flex;align-items:center;gap:3px;margin:0 6px;";

    const mkBtn = (text, title, dataAttr, dataVal) => {
      const b = document.createElement("button");
      b.textContent = text;
      b.title = title;
      b.dataset[dataAttr] = dataVal;
      b.style.cssText = "padding:6px 8px;font-size:12px;";
      return b;
    };

    // 编辑模式切换
    const ikBtn = mkBtn("🎯IK", "IK 模式：拖 IK 球摆姿势（默认）", "editMode", "ik");
    const boneBtn = mkBtn("🦴骨骼", "骨骼编辑模式：点骨骼节点，Gizmo 三维旋转；hips/root 可平移", "editMode", "bone");
    ikBtn.addEventListener("click", () => setMode("ik"));
    boneBtn.addEventListener("click", () => setMode("bone"));
    wrap.appendChild(ikBtn);
    wrap.appendChild(boneBtn);

    // Gizmo 模式
    const rotBtn = mkBtn("⟳旋转", "Gizmo 旋转模式（默认，全部骨骼可用）", "gizmoMode", "rotate");
    const traBtn = mkBtn("✥平移", "Gizmo 平移模式（hips/root 默认可用，其余骨骼需开高级平移）", "gizmoMode", "translate");
    rotBtn.addEventListener("click", () => setGizmoMode("rotate"));
    traBtn.addEventListener("click", () => setGizmoMode("translate"));
    wrap.appendChild(rotBtn);
    wrap.appendChild(traBtn);

    // 高级平移开关
    const advLabel = document.createElement("label");
    advLabel.style.cssText = "display:flex;align-items:center;gap:3px;font-size:12px;color:#8a90a0;cursor:pointer;margin:0 2px;";
    const advBox = document.createElement("input");
    advBox.type = "checkbox";
    advBox.dataset.advancedBoneTranslate = "1";
    advBox.title = "高级模式：开放手臂/腿/头等更多骨骼的平移（默认仅 hips/root）";
    advBox.style.cssText = "accent-color:#2f9e63;";
    advBox.addEventListener("change", () => setAdvancedTranslation(advBox.checked));
    advLabel.appendChild(advBox);
    advLabel.appendChild(document.createTextNode("高级平移"));
    wrap.appendChild(advLabel);

    // 标记球显示开关
    const markerLabel = document.createElement("label");
    markerLabel.style.cssText = "display:flex;align-items:center;gap:3px;font-size:12px;color:#8a90a0;cursor:pointer;margin:0 2px;";
    const markerBox = document.createElement("input");
    markerBox.type = "checkbox";
    markerBox.checked = true;
    markerBox.title = "显示/隐藏骨骼节点标记球（不影响调试，只是视觉辅助）";
    markerBox.style.cssText = "accent-color:#2f9e63;";
    markerBox.addEventListener("change", () => setMarkersVisible(markerBox.checked));
    markerLabel.appendChild(markerBox);
    markerLabel.appendChild(document.createTextNode("标记"));
    wrap.appendChild(markerLabel);

    anchor.insertAdjacentElement("afterend", wrap);
    _ui = { wrap, ikBtn, boneBtn, rotBtn, traBtn, advBox, markerBox };
    _refreshUI();
    return _ui;
  }

  function _refreshUI() {
    if (!_ui) return;
    const { ikBtn, boneBtn, rotBtn, traBtn, advBox } = _ui;
    const setActive = (btn, on) => {
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.style.background = on ? "#2f9e63" : "";
      btn.style.color = on ? "#fff" : "";
    };
    setActive(ikBtn, mode === "ik");
    setActive(boneBtn, mode === "bone");
    setActive(rotBtn, gizmoMode === "rotate");
    setActive(traBtn, gizmoMode === "translate");
    advBox.checked = advancedTranslation;
  }

  /* ========================= 外部事件 ========================= */

  // 活动角色切换/增删：骨骼解析缓存失效；骨骼模式下同名 key 重挂 Gizmo
  window.addEventListener("ds-external-char-changed", () => {
    _cacheEntry = null;
    _cacheMap = null;
    if (!isBoneMode()) return;
    if (selectedBone && _bone(selectedBone)) _attachGizmo();
    else if (selectedBone) selectBone(null);
    _refreshProjection();
    _refreshMarkers();
  });
  window.addEventListener("ds-project-loaded", () => {
    _cacheEntry = null;
    _cacheMap = null;
    if (isBoneMode()) {
      if (selectedBone && !_bone(selectedBone)) selectBone(null);
      _refreshProjection();
    }
  });

  /* ========================= 公共 API ========================= */

  return {
    // 模式
    setMode, getMode, isBoneMode,
    // 选择
    selectBone, getSelectedBone, getSelectedTransform,
    // Gizmo
    setGizmoMode, getGizmoMode,
    // 高级平移
    setAdvancedTranslation, isAdvancedTranslation, isTranslateAllowed,
    // 标记显示
    setMarkersVisible, isMarkersVisible,
    // 骨骼读写
    rotateBone, translateBone,
    setBoneRotation, setBonePosition, getBoneRotation, getBonePosition,
    // 姿态契约（pose-presets 优先调用）
    snapshotPoseBones, applyPoseBones,
    // 同步
    syncIKFromBones,
    // 状态
    getState,
    // 主循环/绘制/导出
    update, draw2D, beginExport, endExport,
    // UI
    mountUI,
    // 测试容错钩子（直接改 bone 对象后手动触发刷新）
    refresh: _refreshProjection,
    onBoneChanged: (key) => _afterBoneChange(key || null),
  };
}
