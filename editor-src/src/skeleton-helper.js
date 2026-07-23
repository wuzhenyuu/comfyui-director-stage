/**
 * skeleton-helper.js — P3-0 GLB/VRM 骨骼显示管理器
 *
 * 双通道骨骼显示：
 *   1) WebGL 视口：为每个外部角色 entry 创建 THREE.SkeletonHelper（跟随模型骨骼实时更新）
 *   2) Canvas2D 视口：drawSkeleton2D 把骨骼父子连线投影到 2D（scene.js drawFrame 钩子调用）
 *
 * 可见性规则：enabled（全局开关，默认开） && entry.model.visible（模式 × 单角色可见性叠加）。
 * 导出时 main.js 用 beginExport/endExport 临时隐藏，避免骨骼线混入 depth/normal/preview。
 */
import * as THREE from "three";

export class SkeletonHelperManager {
  /**
   * @param {THREE.Scene} scene
   * @param {import("./external-characters.js").ExternalCharacterManager} manager
   */
  constructor(scene, manager) {
    this.scene = scene;
    this.manager = manager;
    /** 全局骨骼显示开关（默认开） */
    this.enabled = true;
    /** @type {Map<string, THREE.SkeletonHelper>} entryId → helper */
    this.helpers = new Map();
    this._exportSaved = null;
  }

  setEnabled(v) {
    this.enabled = !!v;
    this.syncAll();
    window.dispatchEvent(new CustomEvent("ds-skeleton-changed", { detail: { enabled: this.enabled } }));
  }

  /** 每帧/事件后调用：补齐新角色、清理已删角色、同步可见性 */
  syncAll() {
    for (const entry of this.manager.characters.values()) {
      let h = this.helpers.get(entry.id);
      if (!h && entry.model) {
        try {
          h = new THREE.SkeletonHelper(entry.model);
          h.name = `skeleton-helper:${entry.id}`;
          this.scene.add(h);
          this.helpers.set(entry.id, h);
        } catch (e) {
          console.warn("[骨骼显示] SkeletonHelper 创建失败:", e.message || e);
          continue;
        }
      }
      if (h) {
        h.visible = this.enabled && entry.model?.visible !== false;
      }
    }
    // 清理已删除角色
    for (const [id, h] of Array.from(this.helpers.entries())) {
      if (!this.manager.characters.has(id)) {
        this.scene.remove(h);
        try { h.geometry?.dispose?.(); } catch (_) { /* ignore */ }
        try { h.material?.dispose?.(); } catch (_) { /* ignore */ }
        this.helpers.delete(id);
      }
    }
  }

  /** 导出前临时隐藏全部骨骼线（记录原状态） */
  beginExport() {
    if (this._exportSaved) return;
    this._exportSaved = new Map();
    for (const [id, h] of this.helpers) {
      this._exportSaved.set(id, h.visible);
      h.visible = false;
    }
  }

  /** 导出后恢复骨骼线可见性 */
  endExport() {
    if (!this._exportSaved) return;
    for (const [id, v] of this._exportSaved) {
      const h = this.helpers.get(id);
      if (h) h.visible = v;
    }
    this._exportSaved = null;
  }
}

/**
 * Canvas2D 骨骼投影：把每个可见外部角色的骨骼父子连线画到 2D 视口。
 * 由 scene.js drawFrame 在 window.__ds_drawBones2D 钩子中间接调用，
 * 仅在 2D 绘制模式（paint2dEnabled=true）下由调用方保证触发。
 *
 * @param {import("./external-characters.js").ExternalCharacterManager} manager
 * @param {THREE.Camera} cameraRef
 * @param {number} w — 视口 CSS 宽
 * @param {number} h — 视口 CSS 高
 * @param {CanvasRenderingContext2D} ctx2d
 */
export function drawSkeleton2D(manager, cameraRef, w, h, ctx2d) {
  if (!manager || !cameraRef || !ctx2d) return;
  const _a = new THREE.Vector3();
  const _b = new THREE.Vector3();

  for (const entry of manager.characters.values()) {
    if (!entry.model || entry.model.visible === false) continue;
    const bones = entry.allBones;
    if (!bones || !bones.length) continue;

    const isActive = entry.id === manager.activeCharacterId;
    ctx2d.strokeStyle = entry.color || "#66ffcc";
    ctx2d.globalAlpha = isActive ? 0.85 : 0.45;
    ctx2d.lineWidth = isActive ? 1.6 : 1.1;
    ctx2d.beginPath();
    for (const bone of bones) {
      if (!bone?.isBone || !bone.parent?.isBone) continue;
      bone.getWorldPosition(_a).project(cameraRef);
      bone.parent.getWorldPosition(_b).project(cameraRef);
      if (_a.z > 1 || _b.z > 1) continue; // 相机背后
      ctx2d.moveTo((_a.x + 1) / 2 * w, (1 - _a.y) / 2 * h);
      ctx2d.lineTo((_b.x + 1) / 2 * w, (1 - _b.y) / 2 * h);
    }
    ctx2d.stroke();
    ctx2d.globalAlpha = 1;
  }
}
