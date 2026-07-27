/**
 * action-runtime.js — P3-0 3D角色动作运行时（每 external entry 独立 action state）
 *
 * 职责：
 *   - play / pause / resume / stop（stop = 回站立）
 *   - loop / speed / intensity
 *   - 每帧 tick(dt)：采样 action-presets → 写入 entry.ikTargets（世界坐标）+ 骨盆位移，
 *     标记 entry._ikDirty，由 main.js 的 solveGLB_IK / solveVRM_IK 求解骨骼
 *   - 动作状态快照/恢复（sceneJSON.externalCharacters[].action）
 *
 * 性能策略：活动角色每帧标 dirty（每帧解 IK）；非活动角色隔帧标 dirty（轮询降载），
 * 动作本身（target 位置）仍每帧推进，视觉上连续。
 */
import * as THREE from "three";
import { getAction, ensureRig, samplePose, isClipActionId, findClip, getClipActions } from "./action-presets.js";

/** 动作切换混合时长（秒） */
const BLEND_TIME = 0.28;

const _tmpW = new THREE.Vector3();
const _tmpFrom = new THREE.Vector3();
const _tmpPole = new THREE.Vector3();
const _tmpSide = new THREE.Vector3();
const _tmpQTarget = new THREE.Quaternion();
const _tmpQFrom = new THREE.Quaternion();
const _tmpQFist = new THREE.Quaternion();
const _Z_AXIS = new THREE.Vector3(0, 0, 1);

/**
 * P3-2：clip 停止时把 IK 球同步到骨骼当前姿势，让 IK 求解无缝接管。
 * target = 末端骨骼世界坐标；pole = 中段骨骼 + 外侧偏移（与 ensureRig 同公式）。
 */
function syncIKFromBones(entry) {
  const rig = ensureRig(entry);
  entry.model?.updateMatrixWorld?.(true);
  const ENDS = { rightArm: 4, leftArm: 7, rightLeg: 10, leftLeg: 13 };
  const MIDS = { rightArm: 3, leftArm: 6, rightLeg: 9, leftLeg: 12 };
  for (const [name, endIdx] of Object.entries(ENDS)) {
    const t = entry.ikTargets?.[name];
    if (!t?.target || !t?.pole) continue;
    const endBone = entry.jointMap?.get(endIdx);
    const midBone = entry.jointMap?.get(MIDS[name]);
    if (endBone) endBone.getWorldPosition(t.target.position);
    if (midBone) {
      midBone.getWorldPosition(_tmpPole);
      _tmpSide.copy(rig.R);
      if (!name.startsWith("right")) _tmpSide.negate();
      t.pole.position.copy(_tmpPole).addScaledVector(_tmpSide, 0.15);
    }
  }
}

function emitChanged() {
  window.dispatchEvent(new CustomEvent("ds-action-changed"));
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

/** 捕获 entry 当前 IK 姿势（混合起点） */
function captureCurrentPose(entry, rig) {
  const from = { chains: {}, pelvis: new THREE.Vector3(), pelvisWorldQuat: null };
  for (const [name, t] of Object.entries(entry.ikTargets || {})) {
    if (!t?.target || !t?.pole) continue;
    from.chains[name] = {
      target: t.target.position.clone(),
      pole: t.pole.position.clone(),
    };
  }
  if (rig?.pelvis && rig.pelvisBaseWorld) {
    rig.pelvis.getWorldPosition(from.pelvis).sub(rig.pelvisBaseWorld);
    from.pelvisWorldQuat = rig.pelvis.getWorldQuaternion(new THREE.Quaternion());
  }
  return from;
}

export class ActionRuntime {
  /**
   * @param {import("./external-characters.js").ExternalCharacterManager} manager
   */
  constructor(manager) {
    this.manager = manager;
    /** @type {Map<string, object>} entryId → action state */
    this.states = new Map();
    this._frame = 0;
    // 让 manager.snapshot()/restore() 能挂上 action state
    manager.actionRuntime = this;
  }

  _defaultState() {
    return { id: "stand", time: 0, playing: false, loop: false, speed: 1, intensity: 1, blend: 1, blendFrom: null };
  }

  /** 读取动作状态（无状态时返回默认 stand/stopped，不写入 Map） */
  getState(entryId) {
    return this.states.get(entryId) || this._defaultState();
  }

  isPlaying(entryId) {
    return this.getState(entryId).playing === true;
  }

  /**
   * 播放动作
   * @param {string} entryId
   * @param {string} actionId — ACTIONS 中的 id
   * @param {object} [opts] — { speed, intensity }
   */
  play(entryId, actionId, opts = {}) {
    const entry = this.manager.get(entryId);
    if (!entry) return false;

    // P3-2：模型自带动画分支
    if (isClipActionId(actionId)) {
      return this._playClip(entry, actionId, opts);
    }

    const def = getAction(actionId);
    if (!def) return false;
    // 从 clip 切到程序化动作：先停 clip 并把 IK 球对齐骨骼，避免姿势跳变
    const prevRaw = this.states.get(entryId);
    if (prevRaw?.isClip) this._stopClip(entry, prevRaw, true);

    const rig = ensureRig(entry);
    const prev = this.getState(entryId);
    this.states.set(entryId, {
      id: def.id,
      isClip: false,
      time: 0,
      playing: true,
      loop: def.kind === "loop",
      speed: opts.speed ?? prev.speed ?? 1,
      intensity: opts.intensity ?? prev.intensity ?? 1,
      blend: 0,
      blendFrom: captureCurrentPose(entry, rig),
    });
    entry._ikDirty = true;
    emitChanged();
    return true;
  }

  /**
   * P3-2：播放模型自带 AnimationClip（骨骼关键帧动画）
   * clip 播放期间骨骼由 mixer 直接驱动，IK 求解被冻结（entry._clipPlaying = true）
   */
  _playClip(entry, clipActionId, opts = {}) {
    const clip = findClip(entry, clipActionId);
    if (!clip || !entry.mixer) return false;
    const clipDef = getClipActions(entry).find((a) => a.id === clipActionId);
    const loop = clipDef?.loop ?? false;
    const prev = this.getState(entry.id);
    const speed = opts.speed ?? prev.speed ?? 1;
    const intensity = opts.intensity ?? prev.intensity ?? 1;

    // 确保 rig 在站立姿势下已捕获（防护：首个动作就是 clip 时 home 不会错捕成 clip 姿势）
    ensureRig(entry);

    entry.mixer.stopAllAction();
    const action = entry.mixer.clipAction(clip);
    action.reset();
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = true;
    action.setEffectiveTimeScale(speed);
    action.setEffectiveWeight(Math.max(0.01, intensity));
    action.fadeIn(BLEND_TIME).play();

    this.states.set(entry.id, {
      id: clipActionId,
      isClip: true,
      loopClip: loop,
      clipDuration: clip.duration || 0,
      time: 0,
      playing: true,
      loop,
      speed,
      intensity,
      blend: 1, // clip 的混合由 fadeIn 负责
      blendFrom: null,
      _action: action,
    });

    // 冻结 IK：clip 播放期间骨骼由 mixer 驱动，IK 不得覆写
    entry._clipPlaying = true;
    entry._ikDirty = false;
    emitChanged();
    return true;
  }

  /**
   * P3-2：停止 clip。syncIK=true 时把 IK 球对齐到 clip 最终骨骼姿势，IK 立即接管锁定姿势。
   */
  _stopClip(entry, state, syncIK) {
    if (!entry) return;
    if (state?._action) {
      try { state._action.stop(); } catch (_) { /* ignore */ }
    } else {
      try { entry.mixer?.stopAllAction(); } catch (_) { /* ignore */ }
    }
    entry._clipPlaying = false;
    if (syncIK) {
      syncIKFromBones(entry);
      entry._ikDirty = true; // 立即解算一次，锁定 clip 结束姿势
    }
  }

  pause(entryId) {
    const state = this.states.get(entryId);
    if (!state || !state.playing) return false;
    state.playing = false;
    if (state.isClip && state._action) state._action.paused = true;
    emitChanged();
    return true;
  }

  resume(entryId) {
    const state = this.states.get(entryId);
    if (!state || state.playing) return false;
    // P3-2：clip 恢复
    if (state.isClip) {
      state.playing = true;
      if (state._action) state._action.paused = false;
      emitChanged();
      return true;
    }
    // 静态/一次性已播完的状态：等价重新播放
    const def = getAction(state.id);
    if (!def) return false;
    if (def.kind !== "loop" && (state.blend >= 1 || state.time <= 0)) {
      return this.play(entryId, state.id, { speed: state.speed, intensity: state.intensity });
    }
    state.playing = true;
    emitChanged();
    return true;
  }

  /**
   * 面板切换：同一动作播放中→暂停；暂停中→继续；否则播放新动作
   */
  toggle(entryId, actionId) {
    const state = this.getState(entryId);
    if (state.playing && state.id === actionId) return this.pause(entryId);
    if (!state.playing && state.id === actionId && this.states.has(entryId)) {
      // P3-2：clip 动画暂停后再点 = 恢复续播
      if (state.isClip) return this.resume(entryId);
      if (getAction(actionId)?.kind === "loop") return this.resume(entryId);
    }
    return this.play(entryId, actionId);
  }

  /** 停止并回站立（静态 stand 混合完成后自动 playing=false） */
  stop(entryId) {
    const entry = this.manager.get(entryId);
    if (!entry) return false;
    const prev = this.getState(entryId);
    return this.play(entryId, "stand", { speed: prev.speed, intensity: 1 });
  }

  stopAll() {
    for (const id of this.manager.characters.keys()) {
      const state = this.states.get(id);
      if (state?.playing) this.stop(id);
    }
  }

  setSpeed(entryId, speed) {
    const s = Math.max(0.1, Math.min(4, Number(speed) || 1));
    const state = this.states.get(entryId);
    if (state) {
      state.speed = s;
      if (state.isClip && state._action) state._action.setEffectiveTimeScale(s);
    } else this.states.set(entryId, { ...this._defaultState(), speed: s });
  }

  setIntensity(entryId, intensity) {
    const k = Math.max(0, Math.min(1, Number(intensity)));
    if (Number.isNaN(k)) return;
    const state = this.states.get(entryId);
    if (state) {
      state.intensity = k;
      if (state.isClip && state._action) state._action.setEffectiveWeight(Math.max(0.01, k));
    } else this.states.set(entryId, { ...this._defaultState(), intensity: k });
  }

  /**
   * 每帧推进（renderLoop 调用）。
   * @param {number} dt — 秒
   */
  tick(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    if (dt > 0.1) dt = 0.1; // 掉帧保护：避免大步长跳变
    this._frame++;

    let idx = 0;
    for (const entry of this.manager.characters.values()) {
      idx++;
      const state = this.states.get(entry.id);
      if (!state || !state.playing) continue;

      // P3-2：clip 动画分支 — 骨骼由 mixer 驱动，不走 IK 采样
      if (state.isClip) {
        if (!entry.mixer) { state.playing = false; entry._clipPlaying = false; continue; }
        entry.mixer.update(dt); // timeScale 已设在 action 上
        state.time += dt * state.speed;
        // oneshot clip 播完（paused=clampWhenFinished 停帧）→ 回站立
        if (!state.loopClip && state._action?.paused) {
          this._stopClip(entry, state, true);
          this.play(entry.id, "stand", { speed: state.speed, intensity: state.intensity });
        }
        continue;
      }

      const def = getAction(state.id);
      if (!def) { state.playing = false; continue; }

      state.time += dt * state.speed;
      if (state.blend < 1) state.blend = Math.min(1, state.blend + dt / BLEND_TIME);

      const rig = ensureRig(entry);
      const out = samplePose(entry, state.id, state.time, state.intensity);
      this._applySample(entry, rig, state, out);

      // 性能策略：活动角色每帧解 IK；非活动角色隔帧标 dirty（轮询）
      if (entry.id === this.manager.activeCharacterId || (this._frame + idx) % 2 === 0) {
        entry._ikDirty = true;
      }

      // 结束条件
      if (def.kind === "oneshot" && state.time >= (def.duration || 1)) {
        // 播完自动回站立
        this.states.set(entry.id, {
          ...this._defaultState(),
          speed: state.speed,
          intensity: state.intensity,
          id: "stand",
          playing: true,
          blend: 0,
          blendFrom: captureCurrentPose(entry, rig),
        });
        emitChanged();
      } else if (def.kind === "static" && state.blend >= 1) {
        state.playing = false;
        emitChanged();
      }
    }

    // 偶发清理已删除角色的状态
    if (this.states.size > this.manager.characters.size + 4) {
      for (const id of this.states.keys()) {
        if (!this.manager.characters.has(id)) this.states.delete(id);
      }
    }
  }

  /** 将采样结果写入 ikTargets（世界坐标）与骨盆 */
  _applySample(entry, rig, state, out) {
    const b = smoothstep(state.blend);
    const blending = state.blendFrom && b < 1;

    for (const [name, pose] of Object.entries(out.chains)) {
      const t = entry.ikTargets?.[name];
      if (!t) continue;
      if (blending && state.blendFrom.chains[name]) {
        t.target.position.lerpVectors(state.blendFrom.chains[name].target, pose.target, b);
        t.pole.position.lerpVectors(state.blendFrom.chains[name].pole, pose.pole, b);
      } else {
        t.target.position.copy(pose.target);
        t.pole.position.copy(pose.pole);
      }
    }

    // 骨盆世界偏移 → 骨骼本地坐标
    if (rig.pelvis && rig.pelvisBaseWorld && rig.pelvis.parent) {
      _tmpW.copy(rig.pelvisBaseWorld).add(out.pelvis);
      if (blending) {
        _tmpFrom.copy(rig.pelvisBaseWorld).add(state.blendFrom.pelvis);
        _tmpW.lerpVectors(_tmpFrom, _tmpW, b);
      }
      rig.pelvis.position.copy(rig.pelvis.parent.worldToLocal(_tmpW));
    }

    // 骨盆旋转（lie/punch 等驱动躯干的动作）：世界空间 delta 四元数 → 本地
    // world = delta * base；混合时从当前世界旋转 slerp 到目标
    if (rig.pelvis && rig.pelvisBaseWorldQuat && rig.pelvisParentWorldQuatInv && out.pelvisRot) {
      _tmpQTarget.copy(out.pelvisRot).multiply(rig.pelvisBaseWorldQuat);
      if (blending && state.blendFrom.pelvisWorldQuat) {
        _tmpQFrom.copy(state.blendFrom.pelvisWorldQuat).slerp(_tmpQTarget, b);
        _tmpQTarget.copy(_tmpQFrom);
      }
      rig.pelvis.quaternion.copy(rig.pelvisParentWorldQuatInv).multiply(_tmpQTarget);
    }

    // 手指握拳（punch 等）：局部 Z 轴旋转，右手 +Z / 左手 -Z（实测弯曲轴），
    // curl=0 时回绑定姿势
    if (rig.fingers && out.fist) {
      const bm = blending ? b : 1;
      for (const side of ["right", "left"]) {
        const curl = (out.fist[side] || 0) * bm;
        const sign = side === "right" ? 1 : -1;
        for (const f of rig.fingers[side]) {
          if (!curl) {
            f.bone.quaternion.copy(f.baseQuat);
            continue;
          }
          const factor = f.finger === "thumb" ? 0.4 : f.joint === 1 ? 0.7 : 1.0;
          _tmpQFist.setFromAxisAngle(_Z_AXIS, sign * 1.1 * curl * factor);
          f.bone.quaternion.copy(f.baseQuat).multiply(_tmpQFist);
        }
      }
    }
  }

  /**
   * 快照 entry 动作状态（sceneJSON.externalCharacters[].action）
   * @returns {{id,time,playing,loop,speed,intensity}|null}
   */
  snapshotState(entryId) {
    const s = this.states.get(entryId);
    if (!s) return null;
    return {
      id: s.id,
      time: +s.time.toFixed(3),
      playing: s.playing === true,
      loop: s.loop === true,
      speed: s.speed,
      intensity: s.intensity,
      ...(s.isClip ? { clip: true } : {}),
    };
  }

  /**
   * 恢复动作状态（manager.restore 调用）。
   * - 循环动作播放中：从保存的 time 续播（从当前姿势混合过去）
   * - 静态/未播放：仅记录状态；姿势由 ikTargets 恢复负责，不重采样
   */
  restoreState(entryId, data) {
    if (!data || typeof data !== "object") return;
    const entry = this.manager.get(entryId);
    if (!entry) return;

    // P3-2：clip 动作恢复 — 播放中则重新播放；未播放仅记录状态
    if (isClipActionId(data.id)) {
      if (data.playing) {
        this.play(entryId, data.id, {
          speed: Math.max(0.1, Math.min(4, Number(data.speed) || 1)),
          intensity: Math.max(0, Math.min(1, data.intensity === undefined ? 1 : Number(data.intensity))),
        });
      } else {
        const clipDef = getClipActions(entry).find((a) => a.id === data.id);
        this.states.set(entryId, {
          ...this._defaultState(),
          id: data.id,
          isClip: true,
          loopClip: clipDef?.loop ?? false,
          clipDuration: clipDef?.duration ?? 0,
          time: Math.max(0, Number(data.time) || 0),
          speed: Math.max(0.1, Math.min(4, Number(data.speed) || 1)),
          intensity: Math.max(0, Math.min(1, data.intensity === undefined ? 1 : Number(data.intensity))),
        });
      }
      return;
    }

    const def = getAction(data.id) || getAction("stand");
    const state = {
      id: def.id,
      time: Math.max(0, Number(data.time) || 0),
      playing: false,
      loop: def.kind === "loop",
      speed: Math.max(0.1, Math.min(4, Number(data.speed) || 1)),
      intensity: Math.max(0, Math.min(1, data.intensity === undefined ? 1 : Number(data.intensity))),
      blend: 1,
      blendFrom: null,
    };
    if (data.playing && def.kind === "loop") {
      const rig = ensureRig(entry);
      state.playing = true;
      state.blend = 0;
      state.blendFrom = captureCurrentPose(entry, rig);
    } else if (data.playing && def.kind === "oneshot") {
      // 一次性动作跨 reload 续播意义不大，重新播放
      this.states.set(entryId, state);
      this.play(entryId, def.id, { speed: state.speed, intensity: state.intensity });
      return;
    }
    this.states.set(entryId, state);
  }
}
