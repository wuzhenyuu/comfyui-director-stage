/**
 * openpose-import.js — OpenPose 骨骼图导入
 *
 * 从 OpenPose 可视化图片解析 BODY_18 关节 2D 坐标，
 * 映射为 3D 空间 IK 目标位置并应用到活动 3D 角色。
 *
 * 原理：
 * 1. 对 18 个关节的标准色逐个扫描像素
 * 2. 聚类相近像素定位关节圆心
 * 3. 2D→3D 映射：以颈部为锚点，用肩宽做尺度参考
 * 4. 四肢端点映射为 IK target，肘/膝映射为 pole
 */
import * as THREE from "three";
import { POSE_COLORS, BONE_LENGTHS } from "./constants.js";

/* ========================= 关节检测参数 ========================= */

const COLOR_TOLERANCE = 70;    // RGB 欧氏距离容忍度
const CLUSTER_RADIUS = 12;     // px — 聚类半径
const SAMPLE_STEP = 2;         // 采样步长（1=全采样，2=跳行跳列加速）
const MIN_MATCHES = 3;         // 最少匹配像素才算有效关节

/* ========================= 2D 关节检测 ========================= */

/**
 * @param {HTMLImageElement|string|Blob} src
 * @returns {Promise<Array<{x:number,y:number}|null>>} 18 个关节位置，未检出为 null
 */
export function parseOpenPoseImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        resolve(detectJoints(img));
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => reject(new Error("无法加载图片"));
    if (typeof src === "string") img.src = src;
    else img.src = URL.createObjectURL(src);
  });
}

function detectJoints(img) {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  // 防超大图：限制内部处理尺寸到 2048
  const scale = Math.min(1, 2048 / Math.max(w, h));
  const cw = Math.round(w * scale);
  const ch = Math.round(h * scale);

  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, cw, ch);
  const imgData = ctx.getImageData(0, 0, cw, ch);
  const px = imgData.data;

  const results = [];
  for (let jointIdx = 0; jointIdx < 18; jointIdx++) {
    const target = POSE_COLORS[jointIdx];
    const matches = [];

    // 逐像素扫描匹配
    for (let y = 0; y < ch; y += SAMPLE_STEP) {
      for (let x = 0; x < cw; x += SAMPLE_STEP) {
        const i = (y * cw + x) * 4;
        if (px[i + 3] < 100) continue; // 透明/半透明跳过

        const dr = px[i] - target[0];
        const dg = px[i + 1] - target[1];
        const db = px[i + 2] - target[2];
        const dist = Math.sqrt(dr * dr + dg * dg + db * db);

        if (dist < COLOR_TOLERANCE) {
          matches.push({ x, y, dist });
        }
      }
    }

    if (matches.length < MIN_MATCHES) {
      results.push(null);
      continue;
    }

    // 聚类：合并 12px 内的匹配
    const clusters = [];
    for (const m of matches) {
      let merged = false;
      for (const c of clusters) {
        const cx = c.sumX / c.count;
        const cy = c.sumY / c.count;
        if (Math.hypot(m.x - cx, m.y - cy) < CLUSTER_RADIUS) {
          c.sumX += m.x;
          c.sumY += m.y;
          c.count++;
          c.bestDist = Math.min(c.bestDist, m.dist);
          merged = true;
          break;
        }
      }
      if (!merged) clusters.push({ sumX: m.x, sumY: m.y, count: 1, bestDist: m.dist });
    }

    // 取颜色最匹配的聚类中心
    clusters.sort((a, b) => a.bestDist - b.bestDist);
    const best = clusters[0];
    results.push({
      x: (best.sumX / best.count) / scale, // 还原到原始图片坐标
      y: (best.sumY / best.count) / scale,
      confidence: Math.min(1, best.count / 20), // 粗略置信度
    });
  }

  return results;
}

/* ========================= 2D → 3D 映射 ========================= */

/**
 * 将 2D 关节映射为 IK 目标 3D 坐标
 *
 * @param {Array} joints - parseOpenPoseImage 返回的 18 关节数组
 * @param {number} imgWidth  - 原始图片宽度
 * @param {number} imgHeight - 原始图片高度
 * @param {object} opts
 * @param {number} opts.facingAngle - 角色面朝方向（弧度，0=+Z）
 * @param {number} opts.rootY - 脚底世界 Y（默认 0）
 * @returns {object|null} { targets: {chainName: {target, pole}}, characterPos: [x,y,z] }
 */
export function mapTo3D(joints, imgWidth, imgHeight, opts = {}) {
  if (!joints || joints.length < 18) return null;

  const facingAngle = opts.facingAngle ?? 0;
  const rootY = opts.rootY ?? 0;

  const neck = joints[1];
  if (!neck) return null; // 至少需要颈部

  // ── 尺度估算：肩宽 ~0.36m ──
  const rSh = joints[2];
  const lSh = joints[5];
  let pxPerMeter;
  if (rSh && lSh) {
    pxPerMeter = Math.abs(rSh.x - lSh.x) / 0.36;
  } else {
    pxPerMeter = imgHeight / 2; // 兜底：图片高度≈2m
  }

  // 颈部世界 Y = 脚底Y + 踝→膝 + 膝→髋 + 髋→颈（骨长链累加）
  const neckWorldY = rootY + BONE_LENGTHS[10] + BONE_LENGTHS[9] + BONE_LENGTHS[8];

  /**
   * 2D 像素 → 3D 世界坐标
   * - X: 像素水平偏移 → 世界水平面（经 facingAngle 旋转）
   * - Y: 像素垂直偏移（倒置）→ 世界高度
   * - Z: 默认 0（平面映射），后续按肘膝前后偏移微调
   */
  const to3D = (px, py, depthOffset = 0) => {
    const dx = (px - neck.x) / pxPerMeter;
    const dy = -(py - neck.y) / pxPerMeter;
    const cos = Math.cos(facingAngle);
    const sin = Math.sin(facingAngle);
    return [
      dx * cos + depthOffset * sin,
      neckWorldY + dy,
      -dx * sin + depthOffset * cos,
    ];
  };

  const result = { targets: {}, characterPos: [0, rootY, 0] };

  // ── 右臂：RShoulder(2) → RElbow(3) → RWrist(4) ──
  const rWrist = joints[4];
  if (rWrist) {
    const armDepth = _limbDepth(joints, 3, 2, 4, pxPerMeter);
    result.targets.rightArm = {
      target: to3D(rWrist.x, rWrist.y, armDepth),
      pole: _pole3D(joints, 3, 2, 4, pxPerMeter, neckWorldY, facingAngle, neck),
    };
  }

  // ── 左臂：LShoulder(5) → LElbow(6) → LWrist(7) ──
  const lWrist = joints[7];
  if (lWrist) {
    const armDepth = _limbDepth(joints, 6, 5, 7, pxPerMeter);
    result.targets.leftArm = {
      target: to3D(lWrist.x, lWrist.y, armDepth),
      pole: _pole3D(joints, 6, 5, 7, pxPerMeter, neckWorldY, facingAngle, neck),
    };
  }

  // ── 右腿：RHip(8) → RKnee(9) → RAnkle(10) ──
  const rAnkle = joints[10];
  if (rAnkle) {
    result.targets.rightLeg = {
      target: to3D(rAnkle.x, rAnkle.y, 0),
      pole: to3D(
        joints[9] ? joints[9].x : rAnkle.x,
        joints[9] ? joints[9].y : rAnkle.y + 15 / pxPerMeter,
        -0.25, // 膝盖前凸默认值
      ),
    };
  }

  // ── 左腿：LHip(11) → LKnee(12) → LAnkle(13) ──
  const lAnkle = joints[13];
  if (lAnkle) {
    result.targets.leftLeg = {
      target: to3D(lAnkle.x, lAnkle.y, 0),
      pole: to3D(
        joints[12] ? joints[12].x : lAnkle.x,
        joints[12] ? joints[12].y : lAnkle.y + 15 / pxPerMeter,
        -0.25,
      ),
    };
  }

  return result;
}

/** 估算肢体深度偏移：对比 2D 骨长与标准骨长，差值映射到 Z */
function _limbDepth(joints, midIdx, rootIdx, endIdx, pxPerMeter) {
  const mid = joints[midIdx];
  const root = joints[rootIdx];
  const end = joints[endIdx];
  if (!mid || !root || !end) return 0;

  // 2D 中 root→end 像素距离
  const pxDist = Math.hypot(end.x - root.x, end.y - root.y);
  // 标准骨长之和（root→mid + mid→end）
  const expectedPx = (BONE_LENGTHS[midIdx] + BONE_LENGTHS[endIdx]) * pxPerMeter;

  if (pxDist >= expectedPx * 0.95) return 0; // 几乎无前后偏移
  // 短缩比例 → Z 偏移估算
  const ratio = pxDist / expectedPx;
  const sinAngle = Math.sqrt(Math.max(0, 1 - ratio * ratio));
  const depth = sinAngle * (BONE_LENGTHS[midIdx] + BONE_LENGTHS[endIdx]);
  // 符号：如果 2D 中肘在肩和腕之间连线之外则为正
  const cross2d = (mid.x - root.x) * (end.y - root.y) - (mid.y - root.y) * (end.x - root.x);
  return cross2d > 0 ? depth : -depth;
}

function _pole3D(joints, midIdx, rootIdx, endIdx, pxPerMeter, neckWorldY, facing, neckRef) {
  const mid = joints[midIdx];
  const root = joints[rootIdx];
  const end = joints[endIdx];

  // 有肘关节 → 取其 3D 位置略后移
  if (mid && root) {
    const cos = Math.cos(facing);
    const sin = Math.sin(facing);
    const dx = (mid.x - neckRef.x) / pxPerMeter;
    const dy = -(mid.y - neckRef.y) / pxPerMeter;
    return [
      dx * cos - 0.15 * sin,
      neckWorldY + dy,
      -dx * sin - 0.15 * cos,
    ];
  }

  // 无肘关节 → 在肩和腕连线中点后侧放置 pole
  if (root && end) {
    const cos = Math.cos(facing);
    const sin = Math.sin(facing);
    const midX = (root.x + end.x) / 2;
    const midY = (root.y + end.y) / 2;
    const dx = (midX - neckRef.x) / pxPerMeter;
    const dy = -(midY - neckRef.y) / pxPerMeter;
    return [
      dx * cos - 0.2 * sin,
      neckWorldY + dy,
      -dx * sin - 0.2 * cos,
    ];
  }

  return [0, neckWorldY - 0.3, -0.3];
}

/* ========================= 应用到角色 ========================= */

/**
 * 将映射结果应用到 ExternalCharacterManager 的活动角色 IK target
 *
 * @param {object} mapping - mapTo3D 的返回值
 * @param {import("./external-characters.js").ExternalCharacterManager} manager
 * @returns {boolean} 是否成功
 */
export function applyToCharacter(mapping, manager) {
  if (!mapping || !mapping.targets) return false;

  const entry = manager.getActive();
  if (!entry || !entry.ikTargets) return false;

  for (const [chainName, ikData] of Object.entries(mapping.targets)) {
    const chain = entry.ikTargets[chainName];
    if (!chain) continue;

    if (ikData.target && Array.isArray(ikData.target) && ikData.target.length >= 3) {
      chain.target.position.set(ikData.target[0], ikData.target[1], ikData.target[2]);
    }
    if (ikData.pole && Array.isArray(ikData.pole) && ikData.pole.length >= 3) {
      chain.pole.position.set(ikData.pole[0], ikData.pole[1], ikData.pole[2]);
    }
  }

  entry._ikDirty = true;
  return true;
}

/* ========================= 调试/便捷：完整导入流程 ========================= */

/**
 * 一键导入：从文件/URL → 检测 → 映射 → 应用到角色
 *
 * @param {string|Blob} src - 图片源
 * @param {import("./external-characters.js").ExternalCharacterManager} manager
 * @param {number} imgWidth
 * @param {number} imgHeight
 * @param {object} opts
 * @returns {Promise<{joints:Array, mapping:object, applied:boolean}>}
 */
export async function importPose(src, manager, imgWidth, imgHeight, opts = {}) {
  const joints = await parseOpenPoseImage(src);
  const detected = joints.filter(Boolean).length;
  if (detected < 3) {
    throw new Error(`仅检测到 ${detected} 个关节，至少需要 3 个（颈+肩/髋）`);
  }

  const mapping = mapTo3D(joints, imgWidth, imgHeight, opts);
  if (!mapping) {
    throw new Error("无法映射 2D 关节到 3D（缺少颈部参考点）");
  }

  const applied = applyToCharacter(mapping, manager);
  return { joints, mapping, applied };
}
