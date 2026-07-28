/**
 * external-characters.js — P1.5 多 3D角色管理器（GLB/VRM）
 *
 * 背景：此前 GLB/VRM 3D角色是 main.js 模块级单例（glbData/vrmData + characterMode）。
 * 本模块把外部角色统一收进 ExternalCharacterManager：
 *   - characters: Map<id, entry>（上限 8）
 *   - entry: { id, name, type:'glb'|'vrm', model, skeleton, jointMap, allBones,
 *              boneNames, ikTargets, ikTargetsGroup, visible, color, spawnSlot, url, fileName }
 *   - 每个角色独立 IK target/pole group；自动错位出生，避免重叠
 *   - entry 本身可直接作为 solveGLB_IK / solveVRM_IK 的 data 参数
 *     （字段 jointMap / ikTargets / allBones 齐全，_rootPrev 挂在 entry 上）
 *
 * 兼容契约：
 *   - window.__ds.glbData / vrmData 由 main.js 的 getter 指向活动 GLB/VRM entry
 *   - 旧 sceneJSON 无 externalCharacters 字段时不受影响（restore 不被调用）
 */
import * as THREE from "three";
import { loadGLBCharacter, createGLBIKTargets } from "./char-loader.js";
import { loadVRMCharacter } from "./vrm-loader.js";
import { ensureRig } from "./action-presets.js";

/** 外部角色上限 */
export const MAX_EXTERNAL_CHARACTERS = 8;

/** 出生错位（X/Z 平面）：slot 0 在原点，其余左右交替排开 */
const SPAWN_STEP = 0.9;
function spawnOffset(slot) {
  if (slot <= 0) return [0, 0];
  const side = slot % 2 === 1 ? 1 : -1;
  const rank = Math.ceil(slot / 2);
  return [side * rank * SPAWN_STEP, (slot % 3) * 0.25]; // z 轻微前后错开，减少重叠感
}

/** 角色标识色（面板/调试用途，按 slot 循环） */
const PALETTE = ["#44ccff", "#ffcc44", "#66ff99", "#ff66cc", "#ff9966", "#cc88ff", "#88ffee", "#ffee88"];

/* ---------- 资源释放：防止反复 add/remove 后显存泄漏 ---------- */
const MATERIAL_TEXTURE_KEYS = [
  "map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap",
  "alphaMap", "bumpMap", "displacementMap", "envMap", "lightMap", "matcap",
];

function disposeMaterial(material, disposed) {
  if (!material || disposed.has(material)) return;
  disposed.add(material);
  for (const key of MATERIAL_TEXTURE_KEYS) {
    const tex = material[key];
    if (tex && !disposed.has(tex)) {
      disposed.add(tex);
      tex.dispose?.();
    }
  }
  material.dispose?.();
}

function disposeObjectTree(root) {
  if (!root) return;
  const disposed = new WeakSet();
  root.traverse?.((obj) => {
    if (obj.geometry && !disposed.has(obj.geometry)) {
      disposed.add(obj.geometry);
      obj.geometry.dispose?.();
    }
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach((m) => disposeMaterial(m, disposed));
    }
    if (obj.skeleton) {
      const sk = obj.skeleton;
      if (sk.boneTexture && !disposed.has(sk.boneTexture)) {
        disposed.add(sk.boneTexture);
        sk.boneTexture.dispose?.();
      }
      if (!disposed.has(sk)) {
        disposed.add(sk);
        sk.dispose?.();
      }
    }
  });
}

function disposeVrmRuntime(entry) {
  const vrm = entry?.vrm;
  if (!vrm) return;
  try { vrm.springBoneManager?.dispose?.(); } catch (_) { /* ignore */ }
  try { vrm.humanoid?.dispose?.(); } catch (_) { /* ignore */ }
  try { vrm.dispose?.(); } catch (_) { /* ignore */ }
}

let _idCounter = 0;

/* ---------- 整体旋转：scratch 对象（函数同步执行、不可重入，安全复用） ---------- */
const _rotEuler = new THREE.Euler();
const _rotQNew = new THREE.Quaternion();
const _rotQOld = new THREE.Quaternion();
const _rotQDelta = new THREE.Quaternion();

/** 旋转 delta 应用到【世界坐标点】（绕 pivot）：v' = pivot + dq·(v − pivot) */
function _rotPointAboutPivot(v, pivot, dq) {
  v.sub(pivot).applyQuaternion(dq).add(pivot);
}

export class ExternalCharacterManager {
  /**
   * @param {THREE.Scene} scene
   */
  constructor(scene) {
    this.scene = scene;
    /** @type {Map<string, object>} */
    this.characters = new Map();
    this.activeCharacterId = null;
    /** 外部角色模式（glb/vrm）是否处于显示状态 —— 由 main.js setCharacterMode 驱动 */
    this._modeVisible = false;
    /** restore 进行中标记：main.js 默认角色自动加载据此避免与恢复竞争 */
    this._restorePending = false;
    /** P3-0：ActionRuntime 挂载点（由 action-runtime.js 构造函数赋值），snapshot/restore 动作状态用 */
    this.actionRuntime = null;
    /**
     * P2-fix：加载中占位（TOCTOU 防护）。addGLB/addVRM 在 await 前先登记，
     * 占住配额/slot/id；clear()/remove() 会作废占位，迟到的加载完成后自行清理并放弃。
     * @type {Map<string, {id:string, slot:number, valid:boolean}>}
     */
    this._pendingAdds = new Map();
  }

  get size() {
    return this.characters.size;
  }

  /** @returns {object[]} 所有外部角色 entry（数组，供 UI/测试/导出遍历） */
  getAll() {
    return Array.from(this.characters.values());
  }

  get(id) {
    return this.characters.get(id) || null;
  }

  getActive() {
    return this.activeCharacterId ? this.characters.get(this.activeCharacterId) || null : null;
  }

  /**
   * 兼容旧 API：取“活动 GLB / VRM”。
   * 活动角色类型匹配时返回活动角色；否则返回最近添加的该类型角色。
   * @param {"glb"|"vrm"} type
   */
  getActiveOfType(type) {
    const active = this.getActive();
    if (active && active.type === type) return active;
    let last = null;
    for (const entry of this.characters.values()) {
      if (entry.type === type) last = entry;
    }
    return last;
  }

  /**
   * 添加 GLB 3D角色
   * @param {string} url - GLB URL（如 /director_stage/models/xxx.glb）
   * @param {string} [name]
   * @param {object} [opts] - { id, spawnSlot }（restore 时保留原 id/槽位）
   * @returns {Promise<object|null>} entry；达到上限返回 null
   */
  async addGLB(url, name, opts = {}) {
    // P2-fix：配额检查把加载中占位也算上，防并发 add 突破上限
    if (this.characters.size + this._pendingAdds.size >= MAX_EXTERNAL_CHARACTERS) {
      console.warn("[外部角色] 已达上限", MAX_EXTERNAL_CHARACTERS);
      return null;
    }
    const slot = opts.spawnSlot ?? this._nextSlot();
    const id = opts.id || `ext-glb-${++_idCounter}`;
    // P2-fix：await 前占位（占住 slot/id），加载途中被 clear/remove 作废则放弃
    const ticket = { id, slot, valid: true };
    this._pendingAdds.set(id, ticket);

    try {
      const data = await loadGLBCharacter(url, this.scene);

      if (!ticket.valid) {
        // 加载期间用户 clear()/remove()：清理已加载模型，不再加回
        this.scene.remove(data.model);
        disposeObjectTree(data.model);
        return null;
      }

      // 错位出生：先挪模型、刷新世界矩阵，再按骨骼世界坐标创建 IK 球
      const [ox, oz] = spawnOffset(slot);
      data.model.position.x += ox;
      data.model.position.z += oz;
      data.model.updateMatrixWorld(true);

      const { targets, group } = createGLBIKTargets(data.jointMap);
      this.scene.add(group);

      const entry = {
        id,
        name: name || `3D角色${slot + 1}`,
        type: "glb",
        url,
        fileName: opts.fileName || null,
        model: data.model,
        skeleton: data.skeleton,
        jointMap: data.jointMap,
        allBones: data.allBones,
        boneNames: data.boneNames,
        ikTargets: targets,
        ikTargetsGroup: group,
        // 扁平骨架脱离末端骨（Rigify 脚挂根骨）：IK 求解后手动贴回
        detachedEnds: data.detachedEnds || null,
        // P3-2：模型自带骨骼动画 + 每角色独立 mixer
        animations: data.animations ?? [],
        mixer: (data.animations?.length ? new THREE.AnimationMixer(data.model) : null),
        visible: true,
        color: PALETTE[slot % PALETTE.length],
        spawnSlot: slot,
      };
      this._finalizeAdd(entry);
      return entry;
    } finally {
      this._pendingAdds.delete(id);
    }
  }

  /**
   * 添加 VRM 3D角色
   * @param {string} url - VRM URL
   * @param {string} [name]
   * @param {string} [fileName] - 原始文件名（持久化/展示用）
   * @param {object} [opts] - { id, spawnSlot }
   * @returns {Promise<object|null>}
   */
  async addVRM(url, name, fileName, opts = {}) {
    // P2-fix：配额检查把加载中占位也算上，防并发 add 突破上限
    if (this.characters.size + this._pendingAdds.size >= MAX_EXTERNAL_CHARACTERS) {
      console.warn("[外部角色] 已达上限", MAX_EXTERNAL_CHARACTERS);
      return null;
    }
    const slot = opts.spawnSlot ?? this._nextSlot();
    const id = opts.id || `ext-vrm-${++_idCounter}`;
    // P2-fix：await 前占位（占住 slot/id），加载途中被 clear/remove 作废则放弃
    const ticket = { id, slot, valid: true };
    this._pendingAdds.set(id, ticket);

    try {
      const data = await loadVRMCharacter(url, this.scene);

      if (!ticket.valid) {
        // 加载期间用户 clear()/remove()：清理已加载模型，不再加回
        if (data.group) { this.scene.remove(data.group); disposeObjectTree(data.group); }
        if (data.ikTargetsGroup) { this.scene.remove(data.ikTargetsGroup); disposeObjectTree(data.ikTargetsGroup); }
        disposeVrmRuntime({ vrm: data.vrm });
        return null;
      }

      // VRM 的 IK 球在 load 时已按原点骨骼坐标创建：模型错位后同步平移 IK 球
      const [ox, oz] = spawnOffset(slot);
      data.group.position.x += ox;
      data.group.position.z += oz;
      data.group.updateMatrixWorld(true);
      if (data.ikTargets) {
        for (const t of Object.values(data.ikTargets)) {
          t.target.position.x += ox;
          t.target.position.z += oz;
          t.pole.position.x += ox;
          t.pole.position.z += oz;
        }
      }
      if (data.ikTargetsGroup && !data.ikTargetsGroup.parent) this.scene.add(data.ikTargetsGroup);

      const entry = {
        id,
        name: name || fileName || `VRM角色${slot + 1}`,
        type: "vrm",
        url,
        fileName: fileName || null,
        model: data.group, // 归一化为 model 字段（旧 vrmData.model.visible 路径修复）
        skeleton: data.skeleton,
        jointMap: data.jointMap,
        allBones: data.allBones,
        boneNames: data.allBones ? data.allBones.map((b) => b.name) : [],
        ikTargets: data.ikTargets,
        ikTargetsGroup: data.ikTargetsGroup,
        vrm: data.vrm || null,
        // P2-fix：VRM 自带骨骼动画 + mixer（对齐 GLB 路径，clip 动作对 VRM 可用）
        animations: data.animations ?? [],
        mixer: (data.animations?.length ? new THREE.AnimationMixer(data.group) : null),
        visible: true,
        color: PALETTE[slot % PALETTE.length],
        spawnSlot: slot,
      };
      this._finalizeAdd(entry);
      return entry;
    } finally {
      this._pendingAdds.delete(id);
    }
  }

  _finalizeAdd(entry) {
    // 新角色/恢复角色需要先补解一次 IK，确保初始骨骼与 target/pole 对齐
    entry._ikDirty = true;
    // 标记 IK 球归属：controls.js 拾取后据此激活对应外部角色
    if (entry.ikTargets) {
      for (const t of Object.values(entry.ikTargets)) {
        if (t.target) t.target.userData.externalCharId = entry.id;
        if (t.pole) t.pole.userData.externalCharId = entry.id;
      }
    }
    this.characters.set(entry.id, entry);
    // P2-fix（ensureRig 懒捕获污染 home）：加载完成即捕获 rig 基准——
    // 此时模型必为绑定 T/A-pose，home 不会被"先摆姿势再播首个动作"的中间姿势污染。
    // restore 场景：捕获发生在变换恢复前（spawn 姿势），delta 随动数学保证映射精确。
    try { ensureRig(entry); } catch (_) { /* 捕获失败不阻塞加载（后续懒捕获兼容） */ }
    if (!this.activeCharacterId) this.activeCharacterId = entry.id;
    // 遵循当前模式可见性（例如 restore 发生在 stick 模式时保持隐藏）
    this._applyEntryVisibility(entry);
    this._emit();
  }

  _nextSlot() {
    // 取未被占用的最小槽位（remove 后可复用，上限由 size 检查保证）
    // P2-fix：加载中占位的 slot 也算已用，防并发 add 拿到同一槽位
    const used = new Set([...this.characters.values()].map((e) => e.spawnSlot));
    for (const t of this._pendingAdds.values()) used.add(t.slot);
    for (let s = 0; s < MAX_EXTERNAL_CHARACTERS; s++) {
      if (!used.has(s)) return s;
    }
    return this.characters.size + this._pendingAdds.size;
  }

  /**
   * 整体旋转外部角色（绕模型自身原点 model.position）。
   *
   * 语义：把模型旋转【设为】给定欧拉角（度，YXZ 顺序——Y 偏航为主轴，
   * 与 UI 滑条一致）；缺省轴保持当前值。内部写入 model.quaternion。
   *
   * 随动保证（与 translateExternalCharacter 同级契约）：
   *   1) IK target/pole 世界坐标绕 pivot 同步旋转 delta —— 非播放状态下
   *      骨骼已被模型带到旋转后位置、IK 球同步到达，求解零漂移；
   *   2) 动作播放中：samplePose/updateRigFrame 的 dq 路径每帧把 home
   *      映射到当前帧（P2 预埋的支点公式），target 由采样重写，天然跟随；
   *   3) 混合中（blendFrom 世界坐标快照）同步旋转，避免 0.28s 混合窗口内
   *      从旧朝向插值造成瞬时回摆；
   *   4) 脚钉地基准 _rootPrev 重置 —— 根骨世界位置随模型旋转已变化，
   *      不重置会把脚钉地误判为根骨漂移、把腿 IK 拉回旋转前位置；
   *   5) 骨骼标记/SkeletonHelper/openpose 走骨骼世界矩阵，自动跟随。
   *
   * @param {string} id
   * @param {{x?:number, y?:number, z?:number}} eulerDeg — 目标欧拉角（度）
   * @returns {boolean} 是否成功
   */
  setCharacterRotation(id, eulerDeg = {}) {
    const entry = this.characters.get(id);
    if (!entry || !entry.model) return false;
    const m = entry.model;

    // 当前欧拉角（YXZ：与 UI「Y 主、X/Z 次要」一致）
    _rotEuler.setFromQuaternion(m.quaternion, "YXZ");
    const toRad = (v, fallback) =>
      v === undefined || v === null || !Number.isFinite(+v)
        ? fallback
        : THREE.MathUtils.degToRad(+v);
    _rotEuler.set(
      toRad(eulerDeg.x, _rotEuler.x),
      toRad(eulerDeg.y, _rotEuler.y),
      toRad(eulerDeg.z, _rotEuler.z),
      "YXZ"
    );
    _rotQNew.setFromEuler(_rotEuler);
    if (m.quaternion.angleTo(_rotQNew) < 1e-7) return true; // 无变化

    // 世界空间 delta：dq = qNew · qOld⁻¹（左乘；invert 原地取逆避免分配）
    _rotQOld.copy(m.quaternion);
    _rotQDelta.copy(_rotQOld).invert().premultiply(_rotQNew);

    const pivot = m.position; // 模型绕自身原点旋转（updateRigFrame 支点公式同源）
    m.quaternion.copy(_rotQNew);
    m.updateMatrixWorld(true);

    // 1) IK target/pole 同步旋转
    if (entry.ikTargets) {
      for (const t of Object.values(entry.ikTargets)) {
        if (t?.target) _rotPointAboutPivot(t.target.position, pivot, _rotQDelta);
        if (t?.pole) _rotPointAboutPivot(t.pole.position, pivot, _rotQDelta);
      }
    }

    // 3) 动作混合起点（世界坐标快照）同步旋转，防混合窗口内回摆
    const st = this.actionRuntime?.states?.get?.(entry.id);
    const bf = st?.blendFrom;
    if (bf) {
      for (const c of Object.values(bf.chains || {})) {
        if (c?.target) _rotPointAboutPivot(c.target, pivot, _rotQDelta);
        if (c?.pole) _rotPointAboutPivot(c.pole, pivot, _rotQDelta);
      }
      if (bf.pelvis) bf.pelvis.applyQuaternion(_rotQDelta); // 世界偏移向量（非点）
      if (bf.pelvisWorldQuat) bf.pelvisWorldQuat.premultiply(_rotQDelta);
    }

    // 4) 脚钉地基准重置（根骨世界位置已随模型旋转变化）
    entry._rootPrev = null;
    entry._ikDirty = true; // 非活动角色也补解一次，保证姿态立即正确
    return true;
  }

  /**
   * 读取角色当前旋转（欧拉角，度，YXZ 顺序）
   * @param {string} id
   * @returns {{x:number,y:number,z:number}|null}
   */
  getCharacterRotation(id) {
    const entry = this.characters.get(id);
    if (!entry || !entry.model) return null;
    _rotEuler.setFromQuaternion(entry.model.quaternion, "YXZ");
    return {
      x: +THREE.MathUtils.radToDeg(_rotEuler.x).toFixed(2),
      y: +THREE.MathUtils.radToDeg(_rotEuler.y).toFixed(2),
      z: +THREE.MathUtils.radToDeg(_rotEuler.z).toFixed(2),
    };
  }

  setActive(id) {
    if (!this.characters.has(id)) return false;
    if (this.activeCharacterId !== id) {
      this.activeCharacterId = id;
      const entry = this.characters.get(id);
      if (entry) entry._ikDirty = true;
      this._emit();
    }
    return true;
  }

  /**
   * 设置单个外部角色可见性（与模式可见性叠加）
   * @param {string} id
   * @param {boolean} visible
   * @returns {boolean} 是否成功
   */
  setVisible(id, visible) {
    const entry = this.characters.get(id);
    if (!entry) return false;
    const next = !!visible;
    if ((entry.visible !== false) === next) return true; // 无变化
    entry.visible = next;
    this._applyEntryVisibility(entry);
    this._emit();
    return true;
  }

  /**
   * 重命名外部角色
   * @param {string} id
   * @param {string} name
   * @returns {boolean} 是否成功
   */
  rename(id, name) {
    const entry = this.characters.get(id);
    if (!entry) return false;
    const next = String(name || "").trim();
    if (!next || next === entry.name) return false;
    entry.name = next;
    this._emit();
    return true;
  }

  /**
   * 移除外部角色（释放场景对象）
   */
  remove(id) {
    const entry = this.characters.get(id);
    if (!entry) {
      // P2-fix：同 id 的加载中占位一并作废（迟到加载不会"复活"该角色）
      const pend = this._pendingAdds.get(id);
      if (pend) { pend.valid = false; this._pendingAdds.delete(id); }
      return false;
    }
    if (entry.model) {
      this.scene.remove(entry.model);
      disposeObjectTree(entry.model);
    }
    if (entry.ikTargetsGroup) {
      this.scene.remove(entry.ikTargetsGroup);
      disposeObjectTree(entry.ikTargetsGroup);
    }
    disposeVrmRuntime(entry);
    // P3-2：清理 AnimationMixer（解除对骨骼的绑定引用）
    if (entry.mixer) {
      try { entry.mixer.stopAllAction(); } catch (_) { /* ignore */ }
      try { entry.mixer.uncacheRoot(entry.model); } catch (_) { /* ignore */ }
      entry.mixer = null;
    }
    if (entry.skeleton) {
      try { entry.skeleton.boneTexture?.dispose?.(); } catch (_) { /* ignore */ }
      try { entry.skeleton.dispose?.(); } catch (_) { /* ignore */ }
    }
    this.characters.delete(id);
    // P3-2：清理动作运行时状态（含 clip 的 _action 引用），防孤儿状态/内存泄漏
    if (this.actionRuntime) {
      const st = this.actionRuntime.states.get(id);
      if (st?._action) { try { st._action.stop(); } catch (_) { /* ignore */ } }
      this.actionRuntime.states.delete(id);
    }
    if (this.activeCharacterId === id) {
      this.activeCharacterId = this.characters.keys().next().value || null;
    }
    this._emit();
    return true;
  }

  clear() {
    // P2-fix：先作废所有加载中占位——迟到的 add 完成后自行清理，不再"复活"
    for (const t of this._pendingAdds.values()) t.valid = false;
    this._pendingAdds.clear();
    for (const id of Array.from(this.characters.keys())) {
      this.remove(id);
    }
    this.activeCharacterId = null;
  }

  /**
   * 外部角色模式显示/隐藏（由 main.js setCharacterMode 调用）。
   * 单角色 visible 标记与模式叠加：entry.model.visible = show && entry.visible
   * @param {boolean} show
   */
  setModeVisible(show) {
    this._modeVisible = !!show;
    for (const entry of this.characters.values()) {
      this._applyEntryVisibility(entry);
    }
  }

  _applyEntryVisibility(entry) {
    const show = this._modeVisible && entry.visible !== false;
    if (entry.model) entry.model.visible = show;
    if (entry.ikTargetsGroup) entry.ikTargetsGroup.visible = show;
  }

  /** 模式切换/批量恢复后，让所有角色在下一帧补解一次 IK */
  markAllIKDirty() {
    for (const entry of this.characters.values()) {
      entry._ikDirty = true;
    }
  }

  /**
   * 序列化：sceneJSON.externalCharacters
   * @returns {{ characters: object[], activeCharacterId: string|null }}
   */
  snapshot() {
    const characters = [];
    for (const entry of this.characters.values()) {
      const ikTargets = {};
      if (entry.ikTargets) {
        for (const [chainName, t] of Object.entries(entry.ikTargets)) {
          ikTargets[chainName] = {
            target: t.target.position.toArray().map((v) => +v.toFixed(4)),
            pole: t.pole.position.toArray().map((v) => +v.toFixed(4)),
          };
        }
      }
      characters.push({
        id: entry.id,
        name: entry.name,
        type: entry.type,
        url: entry.url,
        fileName: entry.fileName || null,
        visible: entry.visible !== false,
        color: entry.color,
        spawnSlot: entry.spawnSlot,
        transform: {
          position: entry.model.position.toArray().map((v) => +v.toFixed(4)),
          quaternion: entry.model.quaternion.toArray().map((v) => +v.toFixed(6)),
          scale: entry.model.scale.toArray().map((v) => +v.toFixed(6)),
        },
        ikTargets,
        // P3-0：动作状态（id,time,playing,loop,speed,intensity）
        action: this.actionRuntime?.snapshotState?.(entry.id) || null,
      });
    }
    return { characters, activeCharacterId: this.activeCharacterId };
  }

  /**
   * 从 sceneJSON 快照恢复（异步逐个加载模型）。
   * 旧 sceneJSON 无该数据时调用方不应触发本函数。
   * @param {{ characters: object[], activeCharacterId?: string|null }} data
   * @returns {Promise<boolean>} 是否成功恢复至少一个角色
   */
  async restore(data) {
    if (!data || !Array.isArray(data.characters) || data.characters.length === 0) return false;
    this._restorePending = true;
    this.clear();

    for (const c of data.characters.slice(0, MAX_EXTERNAL_CHARACTERS)) {
      if (!c || !c.url) continue;
      try {
        const opts = { id: c.id, spawnSlot: c.spawnSlot, fileName: c.fileName };
        const entry = c.type === "vrm"
          ? await this.addVRM(c.url, c.name, c.fileName, opts)
          : await this.addGLB(c.url, c.name, opts);
        if (!entry) continue;

        // 覆盖自动错位：恢复保存的模型变换
        if (c.transform) {
          if (Array.isArray(c.transform.position)) entry.model.position.fromArray(c.transform.position);
          if (Array.isArray(c.transform.quaternion)) entry.model.quaternion.fromArray(c.transform.quaternion);
          if (Array.isArray(c.transform.scale)) entry.model.scale.fromArray(c.transform.scale);
          entry.model.updateMatrixWorld(true);
        }
        entry.visible = c.visible !== false;

        if (c.ikTargets && entry.ikTargets) {
          for (const [chainName, pos] of Object.entries(c.ikTargets)) {
            const t = entry.ikTargets[chainName];
            if (!t) continue;
            if (Array.isArray(pos.target)) t.target.position.fromArray(pos.target);
            if (Array.isArray(pos.pole)) t.pole.position.fromArray(pos.pole);
          }
          entry._ikDirty = true;
        }
        this._applyEntryVisibility(entry);

        // P3-0：恢复动作状态（循环动作续播；静态/未播放仅记录状态）
        if (c.action && this.actionRuntime) {
          this.actionRuntime.restoreState(entry.id, c.action);
        }
      } catch (err) {
        console.warn(`[外部角色] 恢复失败（${c.name || c.id || c.url}）:`, err.message || err);
      }
    }

    if (data.activeCharacterId && this.characters.has(data.activeCharacterId)) {
      this.setActive(data.activeCharacterId);
    } else if (this.characters.size > 0) {
      this.setActive(this.characters.keys().next().value);
    }
    this._restorePending = false;
    this._emit();
    return this.characters.size > 0;
  }

  _emit() {
    window.dispatchEvent(new CustomEvent("ds-external-char-changed", {
      detail: { activeId: this.activeCharacterId, size: this.characters.size },
    }));
  }
}
