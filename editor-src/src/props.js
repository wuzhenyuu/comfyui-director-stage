/**
 * props.js — 积木道具系统：PrimitiveFactory + PropManager
 */
import * as THREE from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";

/* ==================== PrimitiveFactory ==================== */

export const PrimitiveFactory = {
  createBox(w, h, d, color) {
    const geo = new THREE.BoxGeometry(w, h, d);
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.05 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = "box";
    return mesh;
  },

  createCylinder(rTop, rBot, h, color) {
    const geo = new THREE.CylinderGeometry(rTop, rBot, h, 32);
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.05 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = "cylinder";
    return mesh;
  },

  createSphere(r, color) {
    const geo = new THREE.SphereGeometry(r, 32, 24);
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.05 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = "sphere";
    return mesh;
  },

  createPlane(w, h, color) {
    const geo = new THREE.PlaneGeometry(w, h);
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.05, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = "plane";
    return mesh;
  },
};

/* ==================== PropManager ==================== */

let _nextId = 1;

export class PropManager {
  constructor(scene, camera, domElement) {
    this.scene = scene;
    this.camera = camera;
    this.domElement = domElement;
    /** @type {Array<{id:string, name:string, mesh:THREE.Mesh, kind:string, params:object, bbox:object}>} */
    this.props = [];
    this.selectedProp = null;
    this._wireframe = null;

    // TransformControls for prop manipulation
    this.tctrl = new TransformControls(camera, domElement);
    this.tctrl.setMode("translate");
    this.tctrl.setSize(0.65);
    this.tctrl.setTranslationSnap(0.25, 0.25, 0.25);
    this.tctrl.addEventListener("dragging-changed", (e) => {
      if (this._onDragChanged) this._onDragChanged(e.value);
    });
    const gizmo = typeof this.tctrl.getHelper === "function"
      ? this.tctrl.getHelper() : this.tctrl;
    scene.add(gizmo);
    this._gizmo = gizmo;

    // Raycaster for prop picking
    this._raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
  }

  _ensureThreeImport() {
    // noop — TransformControls is already available via THREE
  }

  /** 添加道具 */
  addProp(name, kind, mesh, params = {}, opts = {}) {
    const bbox = new THREE.Box3().setFromObject(mesh);
    const size = new THREE.Vector3();
    bbox.getSize(size);

    // 默认贴地：y = bbox.height/2
    if (opts.autoGround !== false) {
      mesh.position.y = size.y / 2;
    }

    const id = `prop_${_nextId++}`;
    mesh.userData.propId = id;
    this.scene.add(mesh);

    const entry = {
      id,
      name: name || `${kind}_${id}`,
      mesh,
      kind,
      params: { ...params },
      bbox: { min: bbox.min.toArray(), max: bbox.max.toArray(), size: size.toArray() },
    };
    this.props.push(entry);
    return entry;
  }

  /** 删除道具 */
  removeProp(id) {
    const idx = this.props.findIndex((p) => p.id === id);
    if (idx < 0) return false;
    const entry = this.props[idx];
    if (this.selectedProp === entry) this.deselectProp();
    this.scene.remove(entry.mesh);
    if (entry.mesh.geometry) entry.mesh.geometry.dispose();
    if (entry.mesh.material) {
      if (Array.isArray(entry.mesh.material)) {
        entry.mesh.material.forEach((m) => m.dispose());
      } else {
        entry.mesh.material.dispose();
      }
    }
    this.props.splice(idx, 1);
    return true;
  }

  /** 通过 id 查找 */
  getProp(id) {
    return this.props.find((p) => p.id === id);
  }

  /** 选中道具：高亮 wireframe + 绑定 TransformControls */
  selectProp(id) {
    const entry = this.getProp(id);
    if (!entry) return;
    if (this.selectedProp && this.selectedProp !== entry) {
      this._clearHighlight(this.selectedProp);
    }
    this.selectedProp = entry;
    // 高亮：绿色 wireframe 叠加
    this._showHighlight(entry);
    this.tctrl.attach(entry.mesh);
  }

  deselectProp() {
    if (this.selectedProp) {
      this._clearHighlight(this.selectedProp);
      this.tctrl.detach();
    }
    this.selectedProp = null;
  }

  getSelected() {
    return this.selectedProp;
  }

  /** 获取所有道具网格（用于渲染） */
  getAllMeshes() {
    return this.props.map((p) => p.mesh);
  }

  /** 射线拾取 */
  pickProp(pointerNdc) {
    this._ndc.copy(pointerNdc);
    this._raycaster.setFromCamera(this._ndc, this.camera);
    const meshes = this.props.map((p) => p.mesh);
    const hits = this._raycaster.intersectObjects(meshes, false);
    if (hits.length > 0) {
      const hitMesh = hits[0].object;
      const propId = hitMesh.userData.propId;
      return this.getProp(propId) || null;
    }
    return null;
  }

  /* ---- 高亮 ---- */
  _showHighlight(entry) {
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const box = new THREE.Box3().setFromObject(entry.mesh);
    const size = new THREE.Vector3();
    box.getSize(size);
    boxGeo.scale(size.x * 1.05, size.y * 1.05, size.z * 1.05);
    const edgeGeo = new THREE.EdgesGeometry(boxGeo);
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x00ff88, linewidth: 2 });
    const wireframe = new THREE.LineSegments(edgeGeo, edgeMat);
    wireframe.position.copy(box.getCenter(new THREE.Vector3()));
    wireframe.name = "_prop_highlight";
    this.scene.add(wireframe);
    this._wireframe = wireframe;
  }

  _clearHighlight(entry) {
    if (this._wireframe) {
      this.scene.remove(this._wireframe);
      this._wireframe.geometry.dispose();
      this._wireframe.material.dispose();
      this._wireframe = null;
    }
  }

  /* ---- 序列化 snapshot（不存 mesh 引用） ---- */
  snapshot() {
    return this.props.map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      params: p.params,
      position: p.mesh.position.toArray(),
      rotation: p.mesh.rotation.toArray().slice(0, 3),
      scale: p.mesh.scale.toArray(),
    }));
  }

  /** 从 snapshot 恢复（用于序列化往返 / undo） */
  restore(snapshotData, preserveIds = true) {
    // 清除所有现有道具
    const ids = this.props.map((p) => p.id);
    ids.forEach((id) => this.removeProp(id));
    this.deselectProp();

    snapshotData.forEach((item) => {
      let mesh;
      const color = item.kind === "imported" ? 0xcccccc : 0x5b8def;
      const actualColor = item.params && item.params.color !== undefined
        ? item.params.color : color;

      switch (item.kind) {
        case "box":
          mesh = PrimitiveFactory.createBox(
            item.params.w || 1, item.params.h || 1, item.params.d || 1, actualColor
          );
          break;
        case "cylinder":
          mesh = PrimitiveFactory.createCylinder(
            item.params.rTop !== undefined ? item.params.rTop : 0.3,
            item.params.rBot !== undefined ? item.params.rBot : 0.3,
            item.params.h || 1, actualColor
          );
          break;
        case "sphere":
          mesh = PrimitiveFactory.createSphere(item.params.r || 0.5, actualColor);
          break;
        case "plane":
          mesh = PrimitiveFactory.createPlane(
            item.params.w || 1, item.params.h || 1, actualColor
          );
          break;
        case "imported":
          // placeholder for GLB — restore minimal box
          mesh = PrimitiveFactory.createBox(
            item.params.w || 0.3, item.params.h || 1.8, item.params.d || 0.3, 0xaaaaaa
          );
          mesh.name = "imported_" + (item.params.fileName || "unknown");
          break;
        default:
          mesh = PrimitiveFactory.createBox(
            item.params.w || 1, item.params.h || 1, item.params.d || 1, actualColor
          );
      }

      mesh.position.fromArray(item.position || [0, 0, 0]);
      mesh.rotation.set(
        (item.rotation && item.rotation[0]) || 0,
        (item.rotation && item.rotation[1]) || 0,
        (item.rotation && item.rotation[2]) || 0
      );
      if (item.scale) mesh.scale.fromArray(item.scale);

      // Use provided ID if preserving
      if (preserveIds && item.id) {
        mesh.userData.propId = item.id;
        const bbox = new THREE.Box3().setFromObject(mesh);
        const size = new THREE.Vector3();
        bbox.getSize(size);
        const entry = {
          id: item.id,
          name: item.name || `${item.kind}_${item.id}`,
          mesh,
          kind: item.kind,
          params: { ...item.params },
          bbox: { min: bbox.min.toArray(), max: bbox.max.toArray(), size: size.toArray() },
        };
        this.props.push(entry);
        this.scene.add(mesh);
      } else {
        this.addProp(item.name, item.kind, mesh, item.params, { autoGround: false });
      }
    });
  }

  /** 清空所有道具 */
  clear() {
    const ids = this.props.map((p) => p.id);
    ids.forEach((id) => this.removeProp(id));
    this.deselectProp();
    _nextId = 1;
  }

  /** 设置拖动回调 */
  onDragChanged(fn) {
    this._onDragChanged = fn;
  }

  /** 获取 TransformControls 拖拽状态 */
  isDragging() {
    return this.tctrl.dragging;
  }

  /** 隐藏/显示 gizmo（渲染 pass 前隐藏） */
  setGizmoVisible(v) {
    this._gizmo.visible = v;
  }

  /** 变换模式切换 */
  setTransformMode(mode) {
    this.tctrl.setMode(mode);
  }
}


