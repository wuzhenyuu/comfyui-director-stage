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
import { getAction, ensureRig, samplePose } from "./action-presets.js";

/** 动作切换混合时长（秒） */
const BLEND_TIME = 0.28;

const _tmpW = new THREE.Vector3();
const _tmpFrom = new THREE.Vector3();

function emitChanged() {
  window.dispatchEvent(new CustomEvent("ds-action-changed"));
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

/** 捕获 entry 当前 IK 姿势（混合起点） */
function captureCurrentPose(entry, rig) {
  const from = { chains: {}, pelvis: new THREE.Vector3() };
  for (const [name, t] of Object.entries(entry.ikTargets || {})) {
    if (!t?.target || !t?.pole) continue;
    from.chains[name] = {
      target: t.target.position.clone(),
      pole: t.pole.position.clone(),
    };
  }
  if (rig?.pelvis && rig.pelvisBaseWorld) {
    rig.pelvis.getWorldPosition(from.pelvis).sub(rig.pelvisBaseWorld);
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
    const def = getAction(actionId);
    if (!entry || !def) return false;
    const rig = ensureRig(entry);
    const prev = this.getState(entryId);
    this.states.set(entryId, {
      id: def.id,
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

  pause(entryId) {
    const state = this.states.get(entryId);
    if (!state || !state.playing) return false;
    state.playing = false;
    emitChanged();
    return true;
  }

  resume(entryId) {
    const state = this.states.get(entryId);
    if (!state || state.playing) return false;
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
    if (!state.playing && state.id === actionId && this.states.has(entryId) && getAction(actionId)?.kind === "loop") {
      return this.resume(entryId);
    }
    return this.play(entryId, actionId);
  }

  /** 停止并回站立（静态 stand 混合完成后自动 playing=false） */
  stop(entryId) {
    if (!this.manager.get(entryId)) return false;
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
    if (state) state.speed = s;
    else this.states.set(entryId, { ...this._defaultState(), speed: s });
  }

  setIntensity(entryId, intensity) {
    const k = Math.max(0, Math.min(1, Number(intensity)));
    if (Number.isNaN(k)) return;
    const state = this.states.get(entryId);
    if (state) state.intensity = k;
    else this.states.set(entryId, { ...this._defaultState(), intensity: k });
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
