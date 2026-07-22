/**
 * cameras.js — 多机位系统
 *
 * 导出接口（供 main.js 调用）：
 *   - CameraManager 类（含 viewMode / toggleViewMode）
 *   - renderCameraListEntry(cam, isActive)  生成带缩略图的机位行 HTML
 *   - focalMMToVFov / vFovToFocalMM
 *
 * 挂载到 window.__ds：
 *   - togglePovMode()      POV 一键切换
 *   - captureActiveThumbnail()  手动触发缩略图生成
 */
import * as THREE from "three";
import { captureCameraThumbnail } from "./thumbnail-capture.js";

/** 垂直 fov 公式：vFov = 2*atan(12/focalMM) */
export function focalMMToVFov(mm) {
  return (2 * Math.atan(12 / mm) * 180) / Math.PI;
}

/** vFov → focalMM */
export function vFovToFocalMM(fovDeg) {
  return 12 / Math.tan((fovDeg * Math.PI) / 360);
}

let _camNextId = 1;

export class CameraManager {
  constructor() {
    /** @type {Array<{id:string, name:string, camera:THREE.PerspectiveCamera, pos:number[], target:number[], focalMM:number}>} */
    this.cameras = [];
    this._activeCameraId = null;
  }

  /**
   * 初始化默认相机
   * @param {number} aspect — 画幅比例
   * @param {number} focalMM
   */
  initDefaultCamera(aspect = 1, focalMM = 35) {
    const fov = focalMMToVFov(focalMM);
    const cam = new THREE.PerspectiveCamera(fov, aspect, 0.1, 100);
    cam.position.set(0, 1.4, 3.2);
    cam.lookAt(0, 1, 0);
    const entry = {
      id: "cam_01",
      name: "主镜头",
      camera: cam,
      pos: [0, 1.4, 3.2],
      target: [0, 1, 0],
      focalMM,
      dataUrl: null,
    };
    this.cameras.push(entry);
    this._activeCameraId = entry.id;
    _camNextId = Math.max(_camNextId, 1) + 1;
    return entry;
  }

  /** 获取活动相机 */
  getActiveCamera() {
    if (!this._activeCameraId || this.cameras.length === 0) return null;
    return this.cameras.find((c) => c.id === this._activeCameraId) || this.cameras[0];
  }

  /** 获取活动相机的 THREE.PerspectiveCamera */
  getActiveThreeCamera() {
    const entry = this.getActiveCamera();
    return entry ? entry.camera : null;
  }

  /** 当前视图模式：'director'（导演模式）| 'camera'（POV 模式） */
  get viewMode() {
    return this._viewMode || "director";
  }
  set viewMode(v) {
    this._viewMode = v;
  }

  /** 切换活动相机（触发缩略图生成） */
  switchCamera(id) {
    const entry = this.cameras.find((c) => c.id === id);
    if (!entry) return false;
    this._activeCameraId = id;
    // 同步 orbit 到新相机（否则轨道控制还绑在旧相机对象上，转了没反应）
    if (window.__ds__orbit) this.syncOrbitToActiveCamera(window.__ds__orbit);
    // 相机 aspect 可能不同，重排 2D 画布信箱
    if (window.__ds_layoutCanvas) window.__ds_layoutCanvas();
    // 延迟 200ms 自动生成缩略图
    this._scheduleThumbnail();
    return true;
  }

  /**
   * 调度缩略图生成（200ms 延迟，等视口渲染完）
   */
  _scheduleThumbnail() {
    const renderer = window.__ds?.renderer;
    const scene = window.__ds?.scene;
    if (!renderer || !scene) return;
    const ac = this.getActiveCamera();
    if (!ac) return;
    const self = this;
    setTimeout(() => {
      const dataUrl = captureCameraThumbnail(ac.camera, renderer, scene);
      if (dataUrl) {
        ac.dataUrl = dataUrl;
      }
    }, 200);
  }

  /**
   * 生成活动相机缩略图（同步，供 POV 切换等场景调用）
   */
  generateActiveThumbnail(renderer, scene) {
    const ac = this.getActiveCamera();
    if (!ac || !renderer || !scene) return null;
    const dataUrl = captureCameraThumbnail(ac.camera, renderer, scene);
    if (dataUrl) ac.dataUrl = dataUrl;
    return dataUrl;
  }

  /** 添加新相机（复制当前活动相机的参数） */
  addCamera(name) {
    if (!name) {
      name = `cam_${String(_camNextId).padStart(2, "0")}`;
    }
    const active = this.getActiveCamera();
    const aspect = active ? active.camera.aspect : 1;
    const focalMM = active ? active.focalMM : 35;
    const fov = focalMMToVFov(focalMM);

    const cam = new THREE.PerspectiveCamera(fov, aspect, 0.1, 100);
    // 复制当前相机的位置和朝向
    if (active) {
      cam.position.copy(active.camera.position);
      cam.quaternion.copy(active.camera.quaternion);
    } else {
      cam.position.set(0, 1.4, 3.2);
      cam.lookAt(0, 1, 0);
    }

    const target = new THREE.Vector3(0, 1, 0);
    // Compute target from camera direction
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    target.copy(cam.position).add(dir.multiplyScalar(3));

    const entry = {
      id: `cam_${String(_camNextId).padStart(2, "0")}`,
      name,
      camera: cam,
      pos: cam.position.toArray(),
      target: target.toArray(),
      focalMM,
      dataUrl: null,
    };
    this.cameras.push(entry);
    _camNextId++;
    return entry;
  }

  /** 删除相机（至少保留 1 个） */
  removeCamera(id) {
    if (this.cameras.length <= 1) return false;
    const idx = this.cameras.findIndex((c) => c.id === id);
    if (idx < 0) return false;
    // 如果删除的是当前活动相机，切换到第一个
    if (this._activeCameraId === id) {
      this._activeCameraId = this.cameras[0].id === id
        ? this.cameras[1].id
        : this.cameras[0].id;
    }
    this.cameras.splice(idx, 1);
    return true;
  }

  /** 将当前 OrbitControls 的位置/目标写入选中机位 */
  snapCurrentView(orbitControls, cameraId) {
    const entry = cameraId
      ? this.cameras.find((c) => c.id === cameraId)
      : this.getActiveCamera();
    if (!entry) return false;

    entry.camera.position.copy(orbitControls.object.position);
    entry.camera.quaternion.copy(orbitControls.object.quaternion);
    entry.camera.fov = orbitControls.object.fov;

    entry.pos = entry.camera.position.toArray();
    entry.target = orbitControls.target.toArray();
    entry.focalMM = vFovToFocalMM(orbitControls.object.fov);
    return true;
  }

  /** 更新活动相机的 aspect（viewport resize 时调用） */
  updateAspect(aspect) {
    this.cameras.forEach((c) => {
      c.camera.aspect = aspect;
      c.camera.updateProjectionMatrix();
    });
  }

  /** 根据 focalMM 更新所有相机 fov */
  setFocalMM(cameraId, mm) {
    const entry = this.cameras.find((c) => c.id === cameraId);
    if (!entry) return;
    entry.focalMM = mm;
    entry.camera.fov = focalMMToVFov(mm);
    entry.camera.updateProjectionMatrix();
  }

  /* ---- 序列化 ---- */
  serialize() {
    return this.cameras.map((c) => ({
      id: c.id,
      name: c.name,
      pos: c.pos.length ? c.pos : c.camera.position.toArray(),
      target: c.target.length ? c.target : c.target,
      focalMM: c.focalMM,
      dataUrl: c.dataUrl || null,
    }));
  }

  /** 从序列化数据恢复 */
  deserialize(data, aspect) {
    // 清除现有相机
    this.cameras = [];
    this._activeCameraId = null;

    data.forEach((item, i) => {
      const fov = focalMMToVFov(item.focalMM || 35);
      const cam = new THREE.PerspectiveCamera(fov, aspect, 0.1, 100);
      if (item.pos) cam.position.fromArray(item.pos);
      if (item.target) {
        cam.lookAt(new THREE.Vector3().fromArray(item.target));
      }
      const entry = {
        id: item.id || `cam_${String(i + 1).padStart(2, "0")}`,
        name: item.name || `镜头 ${i + 1}`,
        camera: cam,
        pos: item.pos || [0, 1.4, 3.2],
        target: item.target || [0, 1, 0],
        focalMM: item.focalMM || 35,
        dataUrl: item.dataUrl || null,
      };
      this.cameras.push(entry);
      if (!this._activeCameraId) this._activeCameraId = entry.id;
    });

    // If no cameras deserialized, init default
    if (this.cameras.length === 0) {
      this.initDefaultCamera(aspect);
    }
  }

  /** 同步 OrbitControls 到活动相机 */
  syncOrbitToActiveCamera(orbitControls) {
    const ac = this.getActiveCamera();
    if (!ac) return;
    // Replace the camera that OrbitControls is using
    orbitControls.object = ac.camera;
    orbitControls.target.copy(new THREE.Vector3().fromArray(ac.target));
    orbitControls.update();
  }

  /* ==================== POV 一键切换 ==================== */

  /**
   * 切换导演模式 ↔ 相机 POV 模式
   * director → camera：OrbitControls 禁用旋转/平移（只读视角），
   *                    视图自动跟随活动相机位置/朝向
   * camera → director：恢复完全控制
   * @param {import('three/addons/controls/OrbitControls.js').OrbitControls} [orbit]
   */
  toggleViewMode(orbit) {
    // 获取 orbit 引用（优先参数，其次全局）
    const _orbit = orbit || window.__ds__orbit;
    if (!_orbit) {
      console.warn("[CameraManager] toggleViewMode: orbit 不可用");
      return;
    }

    if (this._viewMode !== "camera") {
      // ── 导演 → POV ──
      this._viewMode = "camera";
      // 保存当前 orbit 状态
      this._savedOrbitState = {
        enableRotate: _orbit.enableRotate,
        enablePan: _orbit.enablePan,
        enableZoom: _orbit.enableZoom,
      };
      // 禁用旋转/平移（只读视角）
      _orbit.enableRotate = false;
      _orbit.enablePan = false;
      _orbit.enableZoom = false;
      // 视图跟随活动相机
      this._syncPOV(_orbit);
    } else {
      // ── POV → 导演 ──
      this._viewMode = "director";
      // 恢复 orbit 状态
      if (this._savedOrbitState) {
        _orbit.enableRotate = this._savedOrbitState.enableRotate;
        _orbit.enablePan = this._savedOrbitState.enablePan;
        _orbit.enableZoom = this._savedOrbitState.enableZoom;
        this._savedOrbitState = null;
      }
      // 恢复：保持当前活动相机的视角
      this.syncOrbitToActiveCamera(_orbit);
    }

    // 切换后生成缩略图
    const renderer = window.__ds?.renderer;
    const scene = window.__ds?.scene;
    if (renderer && scene) {
      // 延迟等视口更新完再抓缩略图
      setTimeout(() => {
        this.generateActiveThumbnail(renderer, scene);
      }, 200);
    }
  }

  /**
   * POV 模式下将视图同步到活动相机位置/朝向
   * @private
   */
  _syncPOV(orbit) {
    const ac = this.getActiveCamera();
    if (!ac) return;
    orbit.object.position.copy(ac.camera.position);
    orbit.object.quaternion.copy(ac.camera.quaternion);
    // 根据相机朝向计算 lookAt target
    const dir = new THREE.Vector3(0, 0, -1);
    dir.applyQuaternion(ac.camera.quaternion);
    orbit.target.copy(ac.camera.position).add(dir.multiplyScalar(3));
    orbit.update();
  }
}

/* ==================== 机位列表 UI 渲染 ==================== */

/**
 * 渲染单个机位行 HTML（含缩略图）
 * 供 main.js 的 refreshCameraList 调用，替换内部的行渲染逻辑
 *
 * @param {Object} cam - 机位 entry { id, name, focalMM, dataUrl }
 * @param {boolean} isActive - 是否为活动相机
 * @returns {string} HTML 字符串
 */
export function renderCameraListEntry(cam, isActive) {
  const bg = isActive ? "background:#2f9e6340;" : "";
  const vignetteCss = [
    "position:relative;overflow:hidden;border-radius:3px;",
    "flex-shrink:0;",
  ].join("");

  const thumbHtml = cam.dataUrl
    ? `<img src="${cam.dataUrl}" style="width:32px;height:24px;object-fit:cover;display:block;" />`
    : `<span style="color:#555;font-size:14px;line-height:24px;">📷</span>`;

  const vignetteOverlay = [
    "position:absolute;inset:0;pointer-events:none;",
    "box-shadow:inset 0 0 6px 2px rgba(0,0,0,0.55);",
    "border-radius:3px;",
  ].join("");

  return [
    `<div style="padding:6px 10px;cursor:pointer;font-size:12px;` +
      `display:flex;align-items:center;justify-content:space-between;` +
      `transition:background 0.15s;${bg}"` +
      ` data-cam-id="${cam.id}">`,
    `<span style="display:flex;align-items:center;gap:5px;flex:1;">`,
    `<span style="${vignetteCss}">`,
    thumbHtml,
    `<span style="${vignetteOverlay}"></span>`,
    `</span>`,
    `${cam.name} <span style="color:#8a90a0;font-size:10px;">${cam.focalMM}mm</span>`,
    `</span>`,
    `<button style="padding:2px 6px;font-size:10px;background:transparent;` +
      `border:1px solid #2a2f3d;color:#8a90a0;"` +
      ` data-remove-cam="${cam.id}">✕</button>`,
    `</div>`,
  ].join("");
}

/* ---- 挂载全局 POV 切换函数 ---- */

/**
 * 初始化 cameras.js 全局挂载
 * 由 main.js 在 CameraManager 创建后调用
 */
export function mountCameraGlobals(orbit) {
  if (!window.__ds) window.__ds = {};

  /**
   * POV 一键切换（供 main.js 按钮调用）
   */
  window.__ds.togglePovMode = function () {
    const cm = window.__ds.cameraManager;
    if (!cm) {
      console.warn("[cameras] cameraManager 未就绪");
      return;
    }
    cm.toggleViewMode(orbit);
  };
}
