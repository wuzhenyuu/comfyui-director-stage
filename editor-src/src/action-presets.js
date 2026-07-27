/**
 * action-presets.js — P3-0 3D角色动作预设（GLB/VRM 通用）
 *
 * 动作不依赖火柴人：直接驱动外部角色 entry 的 ikTargets（世界坐标）+ 骨盆位移，
 * 由 main.js 的 solveGLB_IK / solveVRM_IK 在每帧求解骨骼。
 *
 * 三类动作：
 *   - static   静态姿势：stand / sit / crouch / lie / punch（应用一次，播放结束）
 *   - loop     循环动作：idle / walk / run / wave（playing 期间每帧采样）
 *   - oneshot  一次性动作：jump（播完自动回 stand）
 *
 * 坐标系约定（rig，ensureRig 在角色初始姿势下捕获）：
 *   - anchor：角色脚底地面中心 (model.x, 0, model.z)
 *   - F：角色面朝方向（由左右肩世界坐标估计，水平单位向量）
 *   - R：角色右侧方向（水平单位向量）
 *   - home：各 IK 链 target/pole 的初始世界坐标（即"站立"基准姿势）
 *   - pelvis：骨盆骨骼（RHip 父骨），动作通过世界偏移驱动下蹲/跳跃
 */
import * as THREE from "three";

/** 动作清单（UI 顺序即此顺序） */
export const ACTIONS = [
  { id: "stand",  name: "站立", kind: "static" },
  { id: "sit",    name: "坐下", kind: "static" },
  { id: "crouch", name: "蹲下", kind: "static" },
  { id: "lie",    name: "躺下", kind: "static" },
  { id: "punch",  name: "出拳", kind: "static" },
  { id: "idle",   name: "待机", kind: "loop", freq: 0.5 },
  { id: "walk",   name: "走路", kind: "loop", freq: 0.9 },
  { id: "run",    name: "跑步", kind: "loop", freq: 1.7 },
  { id: "wave",   name: "挥手", kind: "loop", freq: 1.2 },
  { id: "jump",   name: "跳跃", kind: "oneshot", duration: 1.0 },
];

export function getAction(id) {
  return ACTIONS.find((a) => a.id === id) || null;
}

/* ============ P3-2：模型自带骨骼动画（AnimationClip）动作 ============ */

/** clip id 前缀（与程序化动作 id 区分） */
export const CLIP_PREFIX = "clip:";

/** clip 英文名 → 中文显示名 */
const CLIP_NAME_CN = {
  idle: "待机", walk: "走路", run: "跑步", wave: "挥手", jump: "跳跃",
  agree: "点头", headshake: "摇头", sad_pose: "难过", sneak_pose: "潜行",
  tpose: "T-Pose", dance: "跳舞", sambadance: "桑巴舞",
};

/** 判定 clip 是否循环动作（idle/walk/run/sneak 类） */
function isLoopClip(name) {
  return /idle|walk|run|sneak/i.test(name);
}

export function isClipActionId(id) {
  return typeof id === "string" && id.startsWith(CLIP_PREFIX);
}

/**
 * 读取 entry 模型自带动画，映射为动作清单项。
 * @param {object} entry — 外部角色 entry（含 animations: AnimationClip[]）
 * @returns {{id:string,name:string,kind:'clip',loop:boolean,duration:number,clipName:string}[]}
 */
export function getClipActions(entry) {
  const clips = entry?.animations;
  if (!Array.isArray(clips) || clips.length === 0) return [];
  return clips
    .filter((c) => c && c.name)
    .map((c) => {
      const key = c.name.toLowerCase().replace(/[\s_]+/g, "");
      const cn = CLIP_NAME_CN[key] || CLIP_NAME_CN[c.name.toLowerCase()];
      return {
        id: CLIP_PREFIX + c.name,
        name: cn ? `${cn} (动画)` : `${c.name} (动画)`,
        kind: "clip",
        loop: isLoopClip(c.name),
        duration: c.duration || 0,
        clipName: c.name,
      };
    });
}

/** 按 clip 动作 id 找 AnimationClip */
export function findClip(entry, clipActionId) {
  if (!isClipActionId(clipActionId)) return null;
  const name = clipActionId.slice(CLIP_PREFIX.length);
  return entry?.animations?.find((c) => c?.name === name) || null;
}

const CHAINS = ["rightArm", "leftArm", "rightLeg", "leftLeg"];

/** 单位四元数（静态姿势 intensity 插值用） */
const _IDENTITY_QUAT = new THREE.Quaternion();

/**
 * 捕获角色基准骨架数据（懒构建，缓存到 entry._rig）。
 * 必须在角色初始（T/A-pose）状态下首次调用，才能保证 home = 站立姿势。
 */
export function ensureRig(entry) {
  if (entry._rig) return entry._rig;
  const rig = {
    up: new THREE.Vector3(0, 1, 0),
    home: {},
    pelvis: null,
    pelvisBaseLocal: null,
    pelvisBaseWorld: null,
    _sampleOut: null,
  };

  const m = entry.model;
  rig.anchor = new THREE.Vector3(m.position.x, 0, m.position.z);
  // P1-fix（rig 缓存随动）：记录捕获时刻的模型变换。
  // samplePose 每帧计算 delta（当前变换 vs 捕获变换），把缓存的世界坐标数据
  // （home/anchor/shoulder 等）映射到当前帧，角色移动/旋转后动作不再"飞回"原位。
  rig._capturePos = m.position.clone();
  rig._captureQuat = m.quaternion.clone();
  // P2-fix：记录捕获时刻的缩放（delta 随动支持运行时均匀缩放）
  rig._captureScale = m.scale.x || 1;

  // 初始 IK 姿势（= 站立基准）
  // 修复：从骨骼世界坐标推算 home，而非当前的 IK 球位置。
  // IK 球可能已被用户拖离骨架，用 IK 球位置做 home 会导致 stand 动作回不到 T-pose。
  const jm = entry.jointMap;
  const getEnd = (idx) => jm?.get?.(idx)?.getWorldPosition(new THREE.Vector3()) || null;
  const getMid = (idx) => jm?.get?.(idx)?.getWorldPosition(new THREE.Vector3()) || null;
  const jw = (i) => {
    const b = entry.jointMap?.get(i);
    return b ? b.getWorldPosition(new THREE.Vector3()) : null;
  };
  rig.shoulderR = jw(2);
  rig.shoulderL = jw(5);

  // 角色面朝方向（2026-07-27 修正：R = RShoulder - LShoulder = 解剖学右侧方向）
  //   实测 michelle.glb：RShoulder.x < LShoulder.x，面朝 +Z
  //   R = RSh - LSh → R = -X（角色右侧）；up(0,1,0) × R(-1,0,0) = F(0,0,1) = 面朝 +Z ✓
  //   （旧版 R = LSh - RSh 得到的是角色【左】侧方向，R/F 双翻转，
  //     导致 punch 向后打、lie 面朝下、relaxed 垂臂左右镜像）
  // 注意：R/F 必须先于 COCO_CHAIN_HOME 循环计算（循环内 pole 偏移依赖 R）
  let R = new THREE.Vector3(1, 0, 0);
  if (rig.shoulderR && rig.shoulderL) {
    R = rig.shoulderR.clone().sub(rig.shoulderL);  // RSh→LSh 的逆 = 角色右侧方向
    R.y = 0;
    if (R.lengthSq() < 1e-6) R.set(1, 0, 0);
    else R.normalize();
  }
  rig.R = R;
  rig.F = new THREE.Vector3().crossVectors(rig.up, R);  // up × right = forward
  if (rig.F.lengthSq() < 1e-6) rig.F.set(0, 0, 1);
  rig.F.normalize();

  const COCO_CHAIN_HOME = {
    rightArm: { end: 4, mid: 3 },  // RWrist, RElbow
    leftArm:  { end: 7, mid: 6 },  // LWrist, LElbow
    rightLeg: { end: 10, mid: 9 }, // RAnkle, RKnee
    leftLeg:  { end: 13, mid: 12 },// LAnkle, LKnee
  };
  for (const [name, def] of Object.entries(COCO_CHAIN_HOME)) {
    const endPos = getEnd(def.end);
    const midPos = getMid(def.mid);
    if (!endPos || !midPos) continue;
    // pole 放肘/膝外侧：mid + (right方向 * 0.15)
    const poleDir = name === 'rightArm' || name === 'rightLeg' ? R : R.clone().negate();
    rig.home[name] = {
      target: endPos.clone(),
      pole: midPos.clone().addScaledVector(poleDir, 0.15),
    };
  }

  // 骨盆：沿大腿（RHip）祖先链向上找名为 hips/pelvis 的骨骼。
  // 注意不能直接取大腿父骨——UE Biped 骨架大腿挂在 Spine 上（Thigh→Spine_04→Pelvis_03），
  // 直接取父骨会把脊柱当骨盆驱动，导致 lie/sit 时骨架被拉变形。
  const hipBone = entry.jointMap?.get(8);
  let pelvisBone = null;
  for (let b = hipBone?.parent; b && b.isBone; b = b.parent) {
    if (/hips|pelvis/i.test(b.name || "")) { pelvisBone = b; break; }
  }
  if (!pelvisBone && hipBone?.parent?.isBone) pelvisBone = hipBone.parent; // fallback
  if (pelvisBone) {
    rig.pelvis = pelvisBone;
    rig.pelvisBaseLocal = rig.pelvis.position.clone();
    rig.pelvisBaseWorld = rig.pelvis.getWorldPosition(new THREE.Vector3());
    // 骨盆旋转基准（lie/punch 等需要驱动躯干旋转的动作）
    rig.pelvisBaseWorldQuat = rig.pelvis.getWorldQuaternion(new THREE.Quaternion());
    rig.pelvisParentWorldQuatInv = rig.pelvis.parent
      ? rig.pelvis.parent.getWorldQuaternion(new THREE.Quaternion()).invert()
      : new THREE.Quaternion();
    // 体型缩放系数：以 michelle 骨盆高 1.113 为基准（该身高下偏移常量已验证），
    // 小个子角色（如 robot-expressive 骨盆 0.52）按比例缩小位移，避免 sit 沉到地下、
    // lie 脚伸不到目标等比例失调问题。
    rig.scale = Math.min(1.6, Math.max(0.35, rig.pelvisBaseWorld.y / 1.113));
  }

  // 自然垂臂基准（relaxed）：home 手臂是 T-pose 水平张开，直接当 stand/idle/walk
  // 基准会导致"全程 T-pose"的假姿势。relaxed = 手腕垂到大腿外侧（肩正下方略前略外），
  // 肘 pole 略向后外，双臂自然下垂内旋。
  rig.relaxed = {};
  const ARM_SIDE = { rightArm: 1, leftArm: -1 };
  for (const [name, side] of Object.entries(ARM_SIDE)) {
    const h = rig.home[name];
    const sh = side > 0 ? rig.shoulderR : rig.shoulderL;
    if (!h || !sh) continue;
    const armLen = h.target.distanceTo(sh); // T-pose 直臂 ≈ 全臂长
    const wrist = sh.clone()
      .addScaledVector(rig.up, -armLen * 0.92)
      .addScaledVector(rig.F, 0.06)
      .addScaledVector(rig.R, side * 0.07);
    const elbow = sh.clone()
      .addScaledVector(rig.up, -armLen * 0.45)
      .addScaledVector(rig.F, -0.02)
      .addScaledVector(rig.R, side * 0.06);
    const pole = elbow.clone()
      .addScaledVector(rig.F, -0.14)
      .addScaledVector(rig.R, side * 0.10);
    rig.relaxed[name] = { target: wrist, pole };
  }

  // 手指骨骼（出拳握拳用，Mixamo 命名风格；不含指尖末节）
  // P2-fix：兼容 VRM 命名（leftThumbProximal/Intermediate/Distal，无数字后缀）
  const VRM_JOINT = { proximal: 1, intermediate: 2, distal: 3 };
  rig.fingers = { right: [], left: [] };
  for (const b of entry.allBones || []) {
    // P2-fix：补 VRM 小指别名 little（leftLittleProximal 等），归一视同 pinky
    const m = b?.name?.match(/(left|right).*?(thumb|index|middle|ring|pinky|little)(?:_?(\d)|(proximal|intermediate|distal))/i);
    if (!m) continue;
    const joint = m[3] ? +m[3] : VRM_JOINT[m[4].toLowerCase()];
    if (!joint || joint < 1 || joint > 3) continue; // 跳过指尖末节
    const side = m[1].toLowerCase();
    if (side !== "right" && side !== "left") continue;
    const fingerRaw = m[2].toLowerCase();
    rig.fingers[side].push({ bone: b, baseQuat: b.quaternion.clone(), joint, finger: fingerRaw === "little" ? "pinky" : fingerRaw });
  }

  entry._rig = rig;
  return rig;
}

/** 角色移除/模型换装后调用，丢弃缓存的基准数据 */
export function invalidateRig(entry) {
  if (entry) entry._rig = null;
}

const _tmpCaptureScaled = new THREE.Vector3();

/**
 * P1-fix：每帧刷新 rig 的 delta 变换（捕获帧 → 当前帧）。
 * 角色被 bodyMover 移动/旋转后，缓存的世界坐标数据通过该 delta 随动，
 * 无需失效重捕（避免在动作播放中重捕到动作中间姿势污染 home）。
 *
 * P2-fix（旋转支点 + scale）：delta 旋转的正确支点是【捕获时刻的模型原点】
 * （模型绕自身 model.position 旋转），而非世界原点。完整映射式：
 *   v' = ds·dq·(v − capturePos) + pos_now
 *      = ds·dq·v + (pos_now − ds·dq·capturePos)
 * 故 _dp = pos_now − ds·dq·capturePos，_ds = 当前缩放 / 捕获缩放（仅支持均匀缩放，
 * 非均匀缩放取 x 分量）。dq=I 且 ds=1 时退化为原平移公式 _dp = pos_now − capturePos，
 * 平移随动行为与此前完全一致（零漂移回归不变）。
 */
export function updateRigFrame(entry) {
  const rig = entry?._rig;
  if (!rig || !entry.model) return null;
  if (!rig._dq) {
    rig._dq = new THREE.Quaternion();
    rig._dp = new THREE.Vector3();
    rig._ds = 1;
    rig._captureQuatInv = rig._captureQuat
      ? rig._captureQuat.clone().invert()
      : new THREE.Quaternion();
    if (!rig._capturePos) rig._capturePos = entry.model.position.clone();
    if (!rig._captureScale) rig._captureScale = entry.model.scale.x || 1;
  }
  rig._dq.copy(entry.model.quaternion).multiply(rig._captureQuatInv);
  const s = entry.model.scale.x / (rig._captureScale || 1);
  rig._ds = Number.isFinite(s) && s > 0 ? s : 1;
  _tmpCaptureScaled.copy(rig._capturePos).multiplyScalar(rig._ds).applyQuaternion(rig._dq);
  rig._dp.copy(entry.model.position).sub(_tmpCaptureScaled);
  return rig;
}

/**
 * P2-fix：把捕获帧的世界坐标点映射到当前帧（v' = ds·dq·v + dp）。
 * 所有 delta 随动消费点统一走此函数，保证支点/scale 数学一致。
 * @param {object} rig — updateRigFrame 刷新后的 rig
 * @param {THREE.Vector3} v — 原地修改
 * @returns {THREE.Vector3} v
 */
export function mapRigPoint(rig, v) {
  if (!rig || !rig._dq) return v;
  if (rig._ds && rig._ds !== 1) v.multiplyScalar(rig._ds);
  return v.applyQuaternion(rig._dq).add(rig._dp);
}

/** 为 rig 分配/复用采样输出缓冲（避免每帧分配） */
function getSampleOut(rig) {
  if (rig._sampleOut) return rig._sampleOut;
  const out = { chains: {}, pelvis: new THREE.Vector3(), pelvisRot: new THREE.Quaternion(), fist: { right: 0, left: 0 } };
  for (const name of CHAINS) {
    out.chains[name] = { target: new THREE.Vector3(), pole: new THREE.Vector3() };
  }
  rig._sampleOut = out;
  return out;
}

/**
 * 采样动作在 time 时刻的 IK 目标姿势。
 *
 * @param {object} entry    外部角色 entry
 * @param {string} actionId 动作 id（ACTIONS）
 * @param {number} time     动作时间（秒，已被 speed 缩放）
 * @param {number} k        intensity 强度 0~1（循环振幅 / 静态姿势插值比例）
 * @param {object} [out]    复用输出缓冲
 * @returns {{ chains: Object<string,{target:THREE.Vector3,pole:THREE.Vector3}>, pelvis: THREE.Vector3 }}
 *          pelvis 为骨盆世界坐标偏移（相对 pelvisBaseWorld）
 */
export function samplePose(entry, actionId, time, k = 1, out = null) {
  const rig = ensureRig(entry);
  updateRigFrame(entry); // P1-fix：刷新 delta 变换
  out = out || getSampleOut(rig);
  k = Math.max(0, Math.min(1, k));

  // 默认：腿回 home（站立基准），手臂回 relaxed（自然垂臂，而非 T-pose）
  const baseOf = (name) =>
    (name === "rightArm" || name === "leftArm") && rig.relaxed?.[name]
      ? rig.relaxed[name]
      : rig.home[name];
  const written = (out._written = out._written || {});
  for (const name of CHAINS) {
    const base = baseOf(name);
    written[name] = !!base;
    if (!base) continue;
    out.chains[name].target.copy(base.target);
    out.chains[name].pole.copy(base.pole);
  }
  out.pelvis.set(0, 0, 0);
  out.pelvisRot.identity();
  out.fist.right = 0;
  out.fist.left = 0;

  const { F, R, up } = rig;
  const S = rig.scale || 1; // 体型缩放：所有位移偏移按角色身高比例缩放
  const place = (v3, base, fd, ud, rd) => {
    v3.copy(base);
    if (fd) v3.addScaledVector(F, fd * S);
    if (ud) v3.addScaledVector(up, ud * S);
    if (rd) v3.addScaledVector(R, rd * S);
  };

  switch (actionId) {
    /* ---------------- 静态姿势（按 k 与 home 插值） ---------------- */
    case "stand":
      break;

    case "sit": {
      // 坐椅子：骨盆落到座面高度，大腿水平前伸、小腿垂直踩地，手搭膝上
      out.pelvis.addScaledVector(up, -0.55 * S);
      for (const leg of ["rightLeg", "leftLeg"]) {
        const c = out.chains[leg];
        if (!c) continue;
        const footSide = leg === "rightLeg" ? 0.13 : -0.13;
        const kneeSide = leg === "rightLeg" ? 0.14 : -0.14;
        place(c.target, rig.anchor, 0.38, 0.08, footSide); // 脚踩地，膝前下方
        place(c.pole, rig.anchor, 0.45, 0.52, kneeSide);   // 膝盖朝前，大腿水平
      }
      for (const arm of ["rightArm", "leftArm"]) {
        const c = out.chains[arm];
        if (!c) continue;
        const side = arm === "rightArm" ? 0.16 : -0.16;
        place(c.target, rig.anchor, 0.36, 0.50, side); // 手掌搭在膝盖上
        // pole 保持 relaxed（肘自然朝下后）
      }
      break;
    }

    case "crouch": {
      // 蹲下：骨盆下降，膝盖前顶，双臂自然垂放略前伸（不再 T-pose 张开）
      out.pelvis.addScaledVector(up, -0.33 * S);
      for (const leg of ["rightLeg", "leftLeg"]) {
        const c = out.chains[leg], h = rig.home[leg];
        if (!h) continue;
        place(c.pole, h.pole, 0.20, 0.04, 0);
      }
      for (const arm of ["rightArm", "leftArm"]) {
        const c = out.chains[arm], h = baseOf(arm);
        if (!h) continue;
        place(c.target, h.target, 0.14, -0.02, 0); // 手略前伸保持平衡
      }
      break;
    }

    case "lie": {
      // 仰躺：骨盆贴地 + 躯干绕 R 轴旋转 90°（头朝 -F、脚朝 F、面朝上）
      if (rig.pelvisBaseWorld) {
        out.pelvis.addScaledVector(up, 0.13 - rig.pelvisBaseWorld.y);
      }
      out.pelvisRot.setFromAxisAngle(R, Math.PI / 2);
      for (const leg of ["rightLeg", "leftLeg"]) {
        const c = out.chains[leg];
        if (!c) continue;
        const side = leg === "rightLeg" ? 0.12 : -0.12;
        place(c.target, rig.anchor, 0.80, 0.06, side);  // 脚向前伸平
        place(c.pole, rig.anchor, 0.42, 0.50, side);    // 膝盖朝上
      }
      for (const arm of ["rightArm", "leftArm"]) {
        const c = out.chains[arm];
        if (!c) continue;
        const side = arm === "rightArm" ? 0.28 : -0.28;
        place(c.target, rig.anchor, -0.05, 0.05, side);       // 手放体侧地面
        place(c.pole, rig.anchor, -0.18, 0.04, side * 1.6);   // 肘略外展贴地
      }
      break;
    }

    case "punch": {
      // 右拳直线前冲（肩高），左拳收护下颌，躯干微转送肩
      const c = out.chains.rightArm;
      if (c && rig.shoulderR) {
        place(c.target, rig.shoulderR, 0.55, -0.05, 0.08);
        c.pole.copy(rig.shoulderR)
          .addScaledVector(F, 0.25)
          .addScaledVector(up, -0.25)
          .addScaledVector(R, 0.10); // 肘朝下，手臂自然伸直
      }
      const g = out.chains.leftArm;
      if (g && rig.shoulderL) {
        place(g.target, rig.shoulderL, 0.22, -0.12, -0.12);
        g.pole.copy(rig.shoulderL)
          .addScaledVector(F, 0.05)
          .addScaledVector(up, -0.30)
          .addScaledVector(R, -0.15);
      }
      out.pelvisRot.setFromAxisAngle(up, 0.35); // 躯干右旋送肩
      out.pelvis.addScaledVector(F, 0.04 * S);
      out.fist.right = 1;  // 右手握拳
      out.fist.left = 0.6; // 左手半握
      break;
    }

    /* ---------------- 循环动作 ---------------- */
    case "idle": {
      // 待机：自然垂臂 + 呼吸起伏（不再是 T-pose 微动）
      const s = Math.sin(2 * Math.PI * time * 0.5);
      for (const arm of ["rightArm", "leftArm"]) {
        const c = out.chains[arm], h = baseOf(arm);
        if (!h) continue;
        place(c.target, h.target, 0.015 * k * s, 0.02 * k * s, 0);
      }
      out.pelvis.addScaledVector(up, 0.008 * k * s * S);
      break;
    }

    case "walk":
    case "run": {
      const run = actionId === "run";
      const freq = run ? 1.7 : 0.9;
      const legAmp = (run ? 0.46 : 0.26) * k * S;
      const liftAmp = (run ? 0.22 : 0.09) * k * S;
      const armAmp = (run ? 0.30 : 0.20) * k * S;
      const bobAmp = (run ? 0.05 : 0.02) * k * S;
      const p = time * freq;
      const s = Math.sin(2 * Math.PI * p);
      const c = Math.cos(2 * Math.PI * p);

      // 右腿相位 0 / 左腿相位 π；手臂与对侧腿同相
      const legs = [["rightLeg", s, c], ["leftLeg", -s, -c]];
      for (const [leg, ls, lc] of legs) {
        const ch = out.chains[leg], h = rig.home[leg];
        if (!h) continue;
        const lift = Math.max(0, -lc) * liftAmp;
        place(ch.target, h.target, legAmp * ls, lift, 0);
        place(ch.pole, h.pole, legAmp * ls * 0.5 + 0.03, 0.03 + lift * 0.5, 0);
      }
      const arms = [["rightArm", -s], ["leftArm", s]];
      for (const [arm, as] of arms) {
        const ch = out.chains[arm], h = baseOf(arm);
        if (!h) continue;
        // 跑步时屈肘抬拳，走路时垂臂摆动
        const fwd = run ? 0.14 : 0;
        const lift = run ? 0.20 : 0;
        place(ch.target, h.target, armAmp * as + fwd, lift, 0);
      }
      out.pelvis.addScaledVector(up, bobAmp * Math.cos(4 * Math.PI * p));
      break;
    }

    case "wave": {
      const s = Math.sin(2 * Math.PI * time * 1.2);
      const ch = out.chains.rightArm, h = baseOf("rightArm");
      if (ch && h && rig.shoulderR) {
        place(ch.target, rig.shoulderR, 0.10, 0.40, -0.05); // 右手举过肩
        ch.target.addScaledVector(R, 0.15 * k * s);          // 左右挥动
        place(ch.pole, h.pole, 0, 0.10, 0);
      }
      out.pelvis.addScaledVector(R, 0.01 * k * s * S);
      break;
    }

    /* ---------------- 一次性动作 ---------------- */
    case "jump": {
      // P2-fix：时长统一从动作定义读取（原与 ACTIONS.jump.duration 双写硬编码）
      const D = getAction("jump")?.duration || 1.0;
      const p = Math.min(Math.max(time / D, 0), 1);
      let h = 0;      // 骨盆高度偏移
      let tuck = 0;   // 收腿系数（滞空期）
      if (p < 0.2) {
        h = -0.10 * k * S * Math.sin(Math.PI * p / 0.2); // 下蹲蓄力
      } else if (p < 0.8) {
        const q = (p - 0.2) / 0.6;
        h = 0.32 * k * S * Math.sin(Math.PI * q);        // 滞空抛物线
        tuck = Math.sin(Math.PI * q);
      }
      out.pelvis.addScaledVector(up, h);
      for (const leg of ["rightLeg", "leftLeg"]) {
        const ch = out.chains[leg], hm = rig.home[leg];
        if (!hm) continue;
        place(ch.target, hm.target, 0.05 * tuck, 0.22 * k * tuck, 0);
        place(ch.pole, hm.pole, 0.10 * tuck, 0.10 * k * tuck, 0);
      }
      for (const arm of ["rightArm", "leftArm"]) {
        const ch = out.chains[arm], hm = baseOf(arm);
        if (!hm) continue;
        // 滞空时双臂从下垂向上张开
        const side = arm === "rightArm" ? 1 : -1;
        place(ch.target, hm.target, 0.05 * tuck, 0.55 * k * tuck, side * 0.12 * tuck);
      }
      break;
    }

    default:
      break;
  }

  // 静态姿势：按 intensity 与站立基准（垂臂）插值（k=1 全姿势，k=0 站立）
  const def = getAction(actionId);
  if (def?.kind === "static" && k < 1) {
    for (const name of CHAINS) {
      const base = baseOf(name);
      if (!base) continue;
      out.chains[name].target.lerpVectors(base.target, out.chains[name].target, k);
      out.chains[name].pole.lerpVectors(base.pole, out.chains[name].pole, k);
    }
    out.pelvis.multiplyScalar(k);
    out.pelvisRot.slerp(_IDENTITY_QUAT, 1 - k); // k=0 时旋转归零
  }

  // P1-fix：把捕获帧的世界坐标输出映射到当前帧（模型平移/旋转随动）。
  // P2-fix：统一走 mapRigPoint（正确支点 + scale）。
  // 骨盆部分在 action-runtime._applySample 中处理（其 worldToLocal 用当前矩阵）。
  if (rig._dq) {
    for (const name of CHAINS) {
      if (!written[name]) continue; // 未重写的链保留上帧值，不得重复叠加 delta
      const c = out.chains[name];
      if (!c) continue;
      mapRigPoint(rig, c.target);
      mapRigPoint(rig, c.pole);
    }
  }

  return out;
}
