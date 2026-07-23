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

const CHAINS = ["rightArm", "leftArm", "rightLeg", "leftLeg"];

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

  // 初始 IK 姿势（= 站立基准）
  for (const [name, t] of Object.entries(entry.ikTargets || {})) {
    if (!t?.target || !t?.pole) continue;
    rig.home[name] = {
      target: t.target.getWorldPosition(new THREE.Vector3()),
      pole: t.pole.getWorldPosition(new THREE.Vector3()),
    };
  }

  const jw = (i) => {
    const b = entry.jointMap?.get(i);
    return b ? b.getWorldPosition(new THREE.Vector3()) : null;
  };
  rig.shoulderR = jw(2);
  rig.shoulderL = jw(5);

  // 角色面朝方向：right = up × forward → forward = right × up
  let R = new THREE.Vector3(1, 0, 0);
  if (rig.shoulderR && rig.shoulderL) {
    R = rig.shoulderR.clone().sub(rig.shoulderL);
    R.y = 0;
    if (R.lengthSq() < 1e-6) R.set(1, 0, 0);
    else R.normalize();
  }
  rig.R = R;
  rig.F = new THREE.Vector3().crossVectors(R, rig.up);
  if (rig.F.lengthSq() < 1e-6) rig.F.set(0, 0, 1);
  rig.F.normalize();

  // 骨盆：RHip(8) 的父骨骼
  const hipBone = entry.jointMap?.get(8);
  if (hipBone?.parent?.isBone) {
    rig.pelvis = hipBone.parent;
    rig.pelvisBaseLocal = rig.pelvis.position.clone();
    rig.pelvisBaseWorld = rig.pelvis.getWorldPosition(new THREE.Vector3());
  }

  entry._rig = rig;
  return rig;
}

/** 角色移除/模型换装后调用，丢弃缓存的基准数据 */
export function invalidateRig(entry) {
  if (entry) entry._rig = null;
}

/** 为 rig 分配/复用采样输出缓冲（避免每帧分配） */
function getSampleOut(rig) {
  if (rig._sampleOut) return rig._sampleOut;
  const out = { chains: {}, pelvis: new THREE.Vector3() };
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
  out = out || getSampleOut(rig);
  k = Math.max(0, Math.min(1, k));

  // 默认：全部回 home（站立基准）
  for (const name of CHAINS) {
    const home = rig.home[name];
    if (!home) continue;
    out.chains[name].target.copy(home.target);
    out.chains[name].pole.copy(home.pole);
  }
  out.pelvis.set(0, 0, 0);

  const { F, R, up } = rig;
  const place = (v3, base, fd, ud, rd) => {
    v3.copy(base);
    if (fd) v3.addScaledVector(F, fd);
    if (ud) v3.addScaledVector(up, ud);
    if (rd) v3.addScaledVector(R, rd);
  };

  switch (actionId) {
    /* ---------------- 静态姿势（按 k 与 home 插值） ---------------- */
    case "stand":
      break;

    case "sit": {
      out.pelvis.addScaledVector(up, -0.42);
      for (const leg of ["rightLeg", "leftLeg"]) {
        const c = out.chains[leg], h = rig.home[leg];
        if (!h) continue;
        place(c.pole, h.pole, 0.22, 0.05, 0); // 膝盖前顶
      }
      for (const arm of ["rightArm", "leftArm"]) {
        const c = out.chains[arm], h = rig.home[arm];
        if (!h) continue;
        place(c.target, h.target, 0.12, -0.30, 0); // 手落到膝部
      }
      break;
    }

    case "crouch": {
      out.pelvis.addScaledVector(up, -0.33);
      for (const leg of ["rightLeg", "leftLeg"]) {
        const c = out.chains[leg], h = rig.home[leg];
        if (!h) continue;
        place(c.pole, h.pole, 0.18, 0.02, 0);
      }
      for (const arm of ["rightArm", "leftArm"]) {
        const c = out.chains[arm], h = rig.home[arm];
        if (!h) continue;
        place(c.target, h.target, 0.05, -0.12, 0);
      }
      break;
    }

    case "lie": {
      // 骨盆贴地（仰躺）：以 anchor 为原点向前伸展
      if (rig.pelvisBaseWorld) {
        out.pelvis.addScaledVector(up, 0.14 - rig.pelvisBaseWorld.y);
      }
      for (const leg of ["rightLeg", "leftLeg"]) {
        const c = out.chains[leg], h = rig.home[leg];
        if (!h) continue;
        const side = leg === "rightLeg" ? 0.12 : -0.12;
        place(c.target, rig.anchor, 0.85, 0.10, side);
        place(c.pole, rig.anchor, 0.45, 0.30, side);
      }
      for (const arm of ["rightArm", "leftArm"]) {
        const c = out.chains[arm], h = rig.home[arm];
        if (!h) continue;
        const side = arm === "rightArm" ? 0.30 : -0.30;
        place(c.target, rig.anchor, 0.15, 0.10, side);
        place(c.pole, h.pole, 0, -0.5, 0);
      }
      break;
    }

    case "punch": {
      const c = out.chains.rightArm, h = rig.home.rightArm;
      if (c && h && rig.shoulderR) {
        place(c.target, rig.shoulderR, 0.55, -0.05, 0.05); // 右拳直击肩高
        place(c.pole, h.pole, 0, -0.15, 0);
      }
      break;
    }

    /* ---------------- 循环动作 ---------------- */
    case "idle": {
      const s = Math.sin(2 * Math.PI * time * 0.5);
      for (const arm of ["rightArm", "leftArm"]) {
        const c = out.chains[arm], h = rig.home[arm];
        if (!h) continue;
        place(c.target, h.target, 0, 0.02 * k * s, 0);
      }
      out.pelvis.addScaledVector(up, 0.008 * k * s);
      break;
    }

    case "walk":
    case "run": {
      const run = actionId === "run";
      const freq = run ? 1.7 : 0.9;
      const legAmp = (run ? 0.42 : 0.26) * k;
      const liftAmp = (run ? 0.16 : 0.09) * k;
      const armAmp = (run ? 0.30 : 0.20) * k;
      const bobAmp = (run ? 0.04 : 0.02) * k;
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
        const ch = out.chains[arm], h = rig.home[arm];
        if (!h) continue;
        const fwd = run ? 0.15 : 0;
        const down = run ? -0.10 : 0;
        place(ch.target, h.target, armAmp * as + fwd, down, 0);
      }
      out.pelvis.addScaledVector(up, bobAmp * Math.cos(4 * Math.PI * p));
      break;
    }

    case "wave": {
      const s = Math.sin(2 * Math.PI * time * 1.2);
      const ch = out.chains.rightArm, h = rig.home.rightArm;
      if (ch && h && rig.shoulderR) {
        place(ch.target, rig.shoulderR, 0.10, 0.40, -0.05); // 右手举过肩
        ch.target.addScaledVector(R, 0.15 * k * s);          // 左右挥动
        place(ch.pole, h.pole, 0, 0.10, 0);
      }
      out.pelvis.addScaledVector(R, 0.01 * k * s);
      break;
    }

    /* ---------------- 一次性动作 ---------------- */
    case "jump": {
      const D = 1.0;
      const p = Math.min(Math.max(time / D, 0), 1);
      let h = 0;      // 骨盆高度偏移
      let tuck = 0;   // 收腿系数（滞空期）
      if (p < 0.2) {
        h = -0.10 * k * Math.sin(Math.PI * p / 0.2); // 下蹲蓄力
      } else if (p < 0.8) {
        const q = (p - 0.2) / 0.6;
        h = 0.32 * k * Math.sin(Math.PI * q);        // 滞空抛物线
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
        const ch = out.chains[arm], hm = rig.home[arm];
        if (!hm) continue;
        place(ch.target, hm.target, 0, 0.25 * k * tuck, 0);
      }
      break;
    }

    default:
      break;
  }

  // 静态姿势：按 intensity 与 home 插值（k=1 全姿势，k=0 站立）
  const def = getAction(actionId);
  if (def?.kind === "static" && k < 1) {
    for (const name of CHAINS) {
      const home = rig.home[name];
      if (!home) continue;
      out.chains[name].target.lerpVectors(home.target, out.chains[name].target, k);
      out.chains[name].pole.lerpVectors(home.pole, out.chains[name].pole, k);
    }
    out.pelvis.multiplyScalar(k);
  }

  return out;
}
