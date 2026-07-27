/**
 * panorama.js — 全景图背景系统
 *
 * 加载等距柱状全景图(~2:1)，在 3D 场景中以巨大球体背景呈现。
 * 支持全景模式（相机固定原点仅旋转）与自由模式切换，
 * 水平旋转调整、人物距离调节、场景序列化。
 */
import * as THREE from "three";

/* ========================= 状态 ========================= */

let panoramaSphere = null;
let panoramaTexture = null;
let enabled = false;
let rotationY = 0;       // 水平旋转（弧度）
let characterDistance = 5; // 人物距原点距离（米）
let imagePath = null;    // 序列化用图片路径
let onStateChange = null;
let _sceneRef = null;    // 场景引用，setEnabled 时自动同步背景

const SPHERE_RADIUS = 50; // 足够大以呈现远距离背景感

/* ========================= 公开 API ========================= */

export function isEnabled() { return enabled; }
export function getRotation() { return rotationY; }
export function getDistance() { return characterDistance; }
export function getImagePath() { return imagePath; }
export function getSphere() { return panoramaSphere; }

/** 注册状态变更回调，UI 控件刷新用 */
export function setStateChangeCallback(fn) { onStateChange = fn; }

function notify() {
  if (onStateChange) onStateChange({ enabled, rotationY, distance: characterDistance, path: imagePath });
}

/* ========================= 全景模式开关 ========================= */

export function setEnabled(v) {
  enabled = !!v;
  if (panoramaSphere) panoramaSphere.visible = enabled;
  if (_sceneRef) syncSceneBackground(_sceneRef);
  notify();
}

/** 获取/设置场景背景透明度（全景模式需设为 null 让球体可见） */
export function syncSceneBackground(scene) {
  if (!scene) return;
  if (enabled && panoramaSphere) {
    if (scene.background !== null) scene.background = null;
  } else {
    if (!scene.background) scene.background = new THREE.Color(0x222233);
  }
}

export function toggle() { setEnabled(!enabled); }

/* ========================= 旋转 & 距离 ========================= */

export function setRotation(rad) {
  rotationY = rad;
  if (panoramaSphere) panoramaSphere.rotation.y = rad;
  notify();
}

export function setDistance(m) {
  characterDistance = Math.max(1.5, Math.min(10, m));
  notify();
}

/* ========================= 加载/移除全景图 ========================= */

/**
 * @param {string} url - 全景图 URL
 * @param {THREE.Scene} scene
 * @returns {Promise<THREE.Mesh>}
 */
export function load(url, scene) {
  return new Promise((resolve, reject) => {
    const loader = new THREE.TextureLoader();
    loader.load(
      url,
      (texture) => {
        // 校验比例（宽松：1.7~2.3 都接受，只 warn）
        const img = texture.image;
        if (img?.width && img?.height) {
          const ratio = img.width / img.height;
          if (ratio < 1.7 || ratio > 2.3) {
            console.warn(`[全景图] 比例 ${ratio.toFixed(2)}:1，非标等距柱状全景（建议 2:1）`);
          }
        }

        // 清理旧球体
        _disposePanorama(scene);

        panoramaTexture = texture;

        const geo = new THREE.SphereGeometry(SPHERE_RADIUS, 64, 32);
        const mat = new THREE.MeshBasicMaterial({
          map: texture,
          side: THREE.BackSide, // 内表面可见
          depthWrite: false,
        });
        panoramaSphere = new THREE.Mesh(geo, mat);
        panoramaSphere.name = "panorama_sphere";
        panoramaSphere.visible = enabled;
        panoramaSphere.rotation.y = rotationY;
        panoramaSphere.renderOrder = -1; // 最先渲染，确保在背景层
        scene.add(panoramaSphere);

        imagePath = url;
        _sceneRef = scene;
        notify();
        resolve(panoramaSphere);
      },
      undefined,
      (err) => reject(err),
    );
  });
}

export function remove(scene) {
  _disposePanorama(scene);
  imagePath = null;
  enabled = false;
  notify();
}

/* ========================= 序列化 ========================= */

export function serialize() {
  return {
    enabled,
    rotationY,
    distance: characterDistance,
    path: imagePath,
  };
}

/**
 * 从快照恢复状态；scene 传入则异步加载全景图
 * @returns {boolean} 是否有数据需要恢复
 */
export function restore(state, scene) {
  if (!state || typeof state !== "object") return false;
  enabled = !!state.enabled;
  rotationY = state.rotationY ?? 0;
  characterDistance = state.distance ?? 5;

  if (state.path && scene) {
    load(state.path, scene).then(() => {
      syncSceneBackground(scene);
    }).catch((e) =>
      console.warn("[全景图] 恢复失败:", e?.message || e),
    );
  }
  return true;
}

/* ========================= 内部 ========================= */

function _disposePanorama(scene) {
  if (panoramaSphere) {
    scene.remove(panoramaSphere);
    panoramaSphere.material?.map?.dispose();
    panoramaSphere.material?.dispose();
    panoramaSphere.geometry?.dispose();
    panoramaSphere = null;
  }
  if (panoramaTexture) {
    panoramaTexture.dispose();
    panoramaTexture = null;
  }
  _sceneRef = null;
}
