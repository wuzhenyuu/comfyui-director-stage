/**
 * external-character-move.js — P3-1 3D角色整体移动
 *
 * 用户点中 3D角色身体（不是 IK 球）时拖动整个角色：
 *   - 默认沿地面 X/Z 平移；按住 Alt 拖 = Y 升降
 *   - 模型、IK target/pole 同步平移；骨骼 / SkeletonHelper / openpose / mask 自动跟随
 *   - 点 IK 球仍走 controls.js 原有摆姿势逻辑，互不干扰
 *
 * 实现要点：
 *   1) 每个外部角色配一个【隐形 hit-proxy 盒】（object.visible=false 的 Box Mesh）。
 *      - 射线只打 proxy：SkinnedMesh.raycast 按绑定姿势（bind pose）计算，
 *        摆完姿势后点视觉身体会打不中；proxy 盒跟随模型变换，拾取稳定。
 *      - visible=false ⇒ WebGL/depth/normal/mask/traverseVisible 全部跳过，
 *        不会污染任何导出通道；THREE.Raycaster 不检查 .visible，仍可命中。
 *      - proxy 不挂在 model 下（避免 renderCharacterMasks 的 traverse 把它点亮），
 *        统一放在场景级 proxyGroup，每帧 syncProxies() 同步到模型变换。
 *   2) translateExternalCharacter 是唯一平移入口：
 *      模型 + 全部 IK target/pole 同步加 delta，并重置 entry._rootPrev——
 *      否则 solveGLB_IK/solveVRM_IK 的“脚钉地”会把整体平移误判为根骨骼漂移，
 *      反向补偿腿部 IK target，造成“脚钉原地、身体被拉走”。
 */
import * as THREE from "three";

const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _hit = new THREE.Vector3();
const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _center = new THREE.Vector3();
const _offset = new THREE.Vector3();

/**
 * 整体平移一个外部角色（模型 + IK target/pole 同步）。
 * @param {object} entry — ExternalCharacterManager entry
 * @param {number} dx @param {number} dy @param {number} dz — 世界坐标增量
 * @returns {boolean}
 */
export function translateExternalCharacter(entry, dx, dy, dz) {
  if (!entry || !entry.model) return false;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) return false;

  entry.model.position.x += dx;
  entry.model.position.y += dy;
  entry.model.position.z += dz;
  entry.model.updateMatrixWorld(true);

  if (entry.ikTargets) {
    for (const t of Object.values(entry.ikTargets)) {
      if (t?.target) {
        t.target.position.x += dx;
        t.target.position.y += dy;
        t.target.position.z += dz;
      }
      if (t?.pole) {
        t.pole.position.x += dx;
        t.pole.position.y += dy;
        t.pole.position.z += dz;
      }
    }
  }

  // 脚钉地基准重置（见文件头说明 2）
  entry._rootPrev = null;
  return true;
}

/**
 * 创建 3D角色整体移动器。
 * @param {object} opts
 * @param {THREE.Scene} opts.scene
 * @param {import("./external-characters.js").ExternalCharacterManager} opts.manager
 * @param {() => THREE.Camera} opts.getCamera — 取当前活动相机（拾取/拖拽平面投影用）
 */
export function createExternalBodyMover({ scene, manager, getCamera }) {
  /** entryId -> { mesh: THREE.Mesh, offset: THREE.Vector3（盒心相对 model.position 的世界偏移，创建时快照） } */
  const proxies = new Map();

  const proxyGroup = new THREE.Group();
  proxyGroup.name = "ExtChar_HitProxies";
  proxyGroup.visible = false; // 双保险：整组不参与任何渲染/导出遍历
  scene.add(proxyGroup);

  /** 当前拖拽状态；null = 未拖拽 */
  let drag = null;

  /* ---------------- proxy 生命周期 ---------------- */

  function _ensureProxy(entry) {
    let p = proxies.get(entry.id);
    if (p) return p;

    _box.setFromObject(entry.model);
    if (_box.isEmpty()) {
      _box.setFromCenterAndSize(new THREE.Vector3(0, 0.9, 0), new THREE.Vector3(0.7, 1.8, 0.5));
    }
    _box.getSize(_size);
    _box.getCenter(_center);
    // 兜底最小尺寸：保证瘦长/小型模型也可点中
    _size.x = Math.max(_size.x, 0.45);
    _size.y = Math.max(_size.y, 1.2);
    _size.z = Math.max(_size.z, 0.35);

    const geo = new THREE.BoxGeometry(_size.x, _size.y, _size.z);
    const mat = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `ExtHitProxy_${entry.id}`;
    mesh.visible = false; // 永不渲染；Raycaster 不检查 .visible，拾取不受影响
    mesh.userData.externalCharId = entry.id;
    mesh.userData.isExternalHitProxy = true;
    proxyGroup.add(mesh);

    // 盒心相对模型原点的偏移（创建时刻快照；之后每帧按模型变换重放）
    const offset = _center.clone().sub(entry.model.position);
    p = { mesh, offset };
    proxies.set(entry.id, p);
    return p;
  }

  /** 每帧调用：补齐新角色 proxy、清理已删角色 proxy、同步 proxy 到模型变换 */
  function syncProxies() {
    if (!manager) return;
    const alive = new Set();
    for (const entry of manager.characters.values()) {
      if (!entry.model) continue;
      alive.add(entry.id);
      const p = _ensureProxy(entry);
      // proxy 位姿 = 模型位姿 + 创建时快照的盒心偏移（随模型旋转）
      _offset.copy(p.offset).applyQuaternion(entry.model.quaternion);
      p.mesh.position.copy(entry.model.position).add(_offset);
      p.mesh.quaternion.copy(entry.model.quaternion);
      p.mesh.updateMatrixWorld(true);
    }
    for (const [id, p] of proxies) {
      if (!alive.has(id)) {
        proxyGroup.remove(p.mesh);
        p.mesh.geometry?.dispose();
        p.mesh.material?.dispose();
        proxies.delete(id);
      }
    }
  }

  /* ---------------- 拾取 ---------------- */

  function _entryPickable(entry) {
    if (!entry || !entry.model) return false;
    if (entry.visible === false) return false;
    if (entry.model.visible === false) return false; // 叠加模式可见性
    return true;
  }

  /**
   * 射线拾取 3D角色身体（只打 hit-proxy，不打 IK 球——IK 球由 controls.js 屏幕缓存优先）。
   * @param {THREE.Vector3} [outPoint] — 提供时拷入命中点世界坐标（拖拽参考点用）
   * @returns {object|null} 命中的 entry（最近优先）
   */
  function pick(clientX, clientY, domElement, outPoint) {
    const cam = getCamera?.();
    if (!cam || !manager || manager.size === 0) return null;
    const r = domElement.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    _ndc.x = ((clientX - r.left) / r.width) * 2 - 1;
    _ndc.y = -((clientY - r.top) / r.height) * 2 + 1;
    _ray.setFromCamera(_ndc, cam);

    const meshes = [];
    for (const entry of manager.characters.values()) {
      if (!_entryPickable(entry)) continue;
      const p = proxies.get(entry.id);
      if (p) meshes.push(p.mesh);
    }
    if (!meshes.length) return null;

    const hits = _ray.intersectObjects(meshes, false);
    if (!hits.length) return null;
    if (outPoint) outPoint.copy(hits[0].point);
    const id = hits[0].object.userData.externalCharId;
    return manager.get(id) || null;
  }

  /* ---------------- 拖拽 ---------------- */

  /**
   * 开始整体拖拽。
   * 参考点 P0 = 射线命中 proxy 的表面点（抓取点）。拖拽平面取【过抓取点的水平面】
   * （而非模型脚底 y=0 平面）——身体上半身的视线与地面夹角很浅，用脚底平面会把
   * 几十像素放大成数米位移（手感差、角色"跑飞"）；过抓取点的平面 ≈1:1 跟手。
   */
  function begin(entry, clientX, clientY, domElement, hitPoint) {
    const cam = getCamera?.();
    if (!cam || !entry) return false;

    const startModelPos = entry.model.position.clone();
    const startTargets = new Map();
    if (entry.ikTargets) {
      for (const [name, t] of Object.entries(entry.ikTargets)) {
        startTargets.set(name, {
          target: t?.target ? t.target.position.clone() : null,
          pole: t?.pole ? t.pole.position.clone() : null,
        });
      }
    }

    let startPoint;
    if (hitPoint) {
      startPoint = hitPoint.clone();
    } else {
      // 无命中点（程序化调用）：退化为射线与模型原点水平面的交点
      const r = domElement.getBoundingClientRect();
      _ndc.x = ((clientX - r.left) / r.width) * 2 - 1;
      _ndc.y = -((clientY - r.top) / r.height) * 2 + 1;
      _ray.setFromCamera(_ndc, cam);
      startPoint = new THREE.Vector3();
      const originPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -startModelPos.y);
      if (!_ray.ray.intersectPlane(originPlane, startPoint)) {
        startPoint.copy(startModelPos);
      }
    }
    // 水平拖拽面：过抓取点（X/Z 拖动只取水平分量，Y 恒定）
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -startPoint.y);

    drag = { entry, startModelPos, startTargets, groundPlane, startPoint };
    return true;
  }

  /**
   * 拖拽移动。
   * @param {boolean} altKey — true：Y 升降（屏幕平行面取垂直分量）；false：地面 X/Z
   */
  function move(clientX, clientY, domElement, altKey) {
    if (!drag) return;
    const cam = getCamera?.();
    if (!cam) return;
    const { entry, startModelPos, startTargets, groundPlane, startPoint } = drag;

    const r = domElement.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    _ndc.x = ((clientX - r.left) / r.width) * 2 - 1;
    _ndc.y = -((clientY - r.top) / r.height) * 2 + 1;
    _ray.setFromCamera(_ndc, cam);

    let dx = 0, dy = 0, dz = 0;

    // 竖直参考面（过 startPoint，法线 = 相机水平视线）：Alt 升降专用；
    // 也作地面求交失败（点中头部/上半身、视线朝上打不到地面）时的 X/Z 兑底。
    const n = new THREE.Vector3();
    cam.getWorldDirection(n);
    n.y = 0;
    if (n.lengthSq() < 1e-8) n.set(0, 0, 1);
    n.normalize();
    const vPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, startPoint);

    if (!altKey) {
      // 地面 X/Z：优先与参考水平面求交
      if (_ray.ray.intersectPlane(groundPlane, _hit)) {
        dx = _hit.x - startPoint.x;
        dz = _hit.z - startPoint.z;
      } else {
        // 视线朝上打不到地面：退到竖直面取 X/Z，保证点上半身也能拖
        if (!_ray.ray.intersectPlane(vPlane, _hit)) return;
        dx = _hit.x - startPoint.x;
        dz = _hit.z - startPoint.z;
      }
    } else {
      // Alt：Y 升降（竖直面交点的 Y 差）
      if (!_ray.ray.intersectPlane(vPlane, _hit)) return;
      dy = _hit.y - startPoint.y;
    }

    // 以 begin 快照为基准重放（不累积误差）
    entry.model.position.set(
      startModelPos.x + dx,
      startModelPos.y + dy,
      startModelPos.z + dz
    );
    entry.model.updateMatrixWorld(true);
    if (entry.ikTargets) {
      for (const [name, t] of Object.entries(entry.ikTargets)) {
        const s = startTargets.get(name);
        if (s?.target && t?.target) {
          t.target.position.set(s.target.x + dx, s.target.y + dy, s.target.z + dz);
        }
        if (s?.pole && t?.pole) {
          t.pole.position.set(s.pole.x + dx, s.pole.y + dy, s.pole.z + dz);
        }
      }
    }
    entry._rootPrev = null; // 脚钉地基准重置
  }

  function end() {
    drag = null;
  }

  return {
    pick,
    begin,
    move,
    end,
    syncProxies,
    proxyGroup,
    get dragging() { return !!drag; },
    get dragEntry() { return drag?.entry || null; },
  };
}
