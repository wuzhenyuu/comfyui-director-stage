/**
 * constants.js — COCO-18 关节定义、T-pose、limbSeq、颜色、树结构、镜像映射
 */

// COCO-18 关节中文名
export const JOINT_CN = [
  "鼻", "颈", "右肩", "右肘", "右腕", "左肩", "左肘", "左腕",
  "右髋", "右膝", "右踝", "左髋", "左膝", "左踝",
  "右眼", "左眼", "右耳", "左耳",
];

// COCO-18 关节英文名（序列化用）
export const JOINT_EN = [
  "Nose", "Neck", "RShoulder", "RElbow", "RWrist",
  "LShoulder", "LElbow", "LWrist",
  "RHip", "RKnee", "RAnkle", "LHip", "LKnee", "LAnkle",
  "REye", "LEye", "REar", "LEar",
];

// T-pose 默认坐标（米），COCO-18 顺序
export const T_POSE = [
  [0.0, 1.62, 0.05],   // 0 Nose
  [0.0, 1.45, 0.0],    // 1 Neck
  [-0.18, 1.45, 0.0],  // 2 RShoulder
  [-0.45, 1.45, 0.0],  // 3 RElbow
  [-0.7, 1.45, 0.0],   // 4 RWrist
  [0.18, 1.45, 0.0],   // 5 LShoulder
  [0.45, 1.45, 0.0],   // 6 LElbow
  [0.7, 1.45, 0.0],    // 7 LWrist
  [-0.1, 0.95, 0.0],   // 8 RHip
  [-0.11, 0.52, 0.0],  // 9 RKnee
  [-0.12, 0.08, 0.0],  // 10 RAnkle
  [0.1, 0.95, 0.0],    // 11 LHip
  [0.11, 0.52, 0.0],   // 12 LKnee
  [0.12, 0.08, 0.0],   // 13 LAnkle
  [-0.03, 1.66, 0.07], // 14 REye
  [0.03, 1.66, 0.07],  // 15 LEye
  [-0.07, 1.64, 0.02], // 16 REar
  [0.07, 1.64, 0.02],  // 17 LEar
];

// OpenPose limbSeq（0 基索引对）: [parent, child]
export const LIMB_SEQ = [
  [1, 2], [1, 5], [2, 3], [3, 4], [5, 6], [6, 7],
  [1, 8], [8, 9], [9, 10], [1, 11], [11, 12], [12, 13],
  [1, 0], [0, 14], [14, 16], [0, 15], [15, 17],
];

// OpenPose 18 色调色板
export const POSE_COLORS = [
  [255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0],
  [170, 255, 0], [85, 255, 0], [0, 255, 0], [0, 255, 85],
  [0, 255, 170], [0, 255, 255], [0, 170, 255], [0, 85, 255],
  [0, 0, 255], [85, 0, 255], [170, 0, 255], [255, 0, 255],
  [255, 0, 170], [255, 0, 85],
];

export const JOINT_COLOR = 0x4da6ff;
export const SELECT_COLOR = 0xffcc00;

// --------------- 树结构（从 LIMB_SEQ 推导） ---------------
// childIndex → parentIndex
export const JOINT_PARENT = {};
// parentIndex → [childIndex, ...]
export const JOINT_CHILDREN = Array.from({ length: 18 }, () => []);

for (const [a, b] of LIMB_SEQ) {
  JOINT_PARENT[b] = a;
  JOINT_CHILDREN[a].push(b);
}
// Neck 没有父节点
JOINT_PARENT[1] = undefined;

// --------------- 原始骨长（T-pose 下 child 到 parent 距离） ---------------
export const BONE_LENGTHS = [];
for (let i = 0; i < 18; i++) {
  if (i === 1) { BONE_LENGTHS[i] = 0; continue; }
  const pi = JOINT_PARENT[i];
  const dx = T_POSE[i][0] - T_POSE[pi][0];
  const dy = T_POSE[i][1] - T_POSE[pi][1];
  const dz = T_POSE[i][2] - T_POSE[pi][2];
  BONE_LENGTHS[i] = Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// --------------- 左右镜像映射（index → mirrorIndex） ---------------
export const MIRROR_MAP = {
  2: 5, 5: 2,     // RShoulder ↔ LShoulder
  3: 6, 6: 3,     // RElbow ↔ LElbow
  4: 7, 7: 4,     // RWrist ↔ LWrist
  8: 11, 11: 8,   // RHip ↔ LHip
  9: 12, 12: 9,   // RKnee ↔ LKnee
  10: 13, 13: 10, // RAnkle ↔ LAnkle
  14: 15, 15: 14, // REye ↔ LEye
  16: 17, 17: 16, // REar ↔ LEar
};

// --------------- 场景序列化版本 ---------------
export const SCENE_VERSION = 2;

// --------------- IK 链定义 ---------------
// 四肢 IK 链配置（每链 3 个骨骼：根→中→末端，对应 COCO 关节索引）
export const IK_CHAINS = {
  leftArm:  { bones: [5, 6, 7],   maxIterations: 15, tolerance: 0.0005, name: "leftArm"  },  // LShoulder→LElbow→LWrist
  rightArm: { bones: [2, 3, 4],   maxIterations: 15, tolerance: 0.0005, name: "rightArm" },  // RShoulder→RElbow→RWrist
  leftLeg:  { bones: [11, 12, 13], maxIterations: 15, tolerance: 0.0005, name: "leftLeg"  },  // LHip→LKnee→LAnkle
  rightLeg: { bones: [8, 9, 10],  maxIterations: 15, tolerance: 0.0005, name: "rightLeg" },  // RHip→RKnee→RAnkle
};

// 角色默认颜色（8 种循环使用）
export const CHARACTER_COLORS = [
  "#ff6b6b", "#4ecdc4", "#45b7d1", "#96ceb4",
  "#ffeaa7", "#dfe6e9", "#fd79a8", "#a29bfe",
];

// 右侧暖色 / 左侧冷色关节色（用于 joint index → color）
export const JOINT_COLOR_WARM = 0xff9966;   // 右侧暖色
// 左右分组定义
export const RIGHT_JOINTS = new Set([2, 3, 4, 8, 9, 10, 14, 16]);  // RShoulder,RElbow,RWrist,RHip,RKnee,RAnkle,REye,REar
export const LEFT_JOINTS  = new Set([5, 6, 7, 11, 12, 13, 15, 17]); // LShoulder,LElbow,LWrist,LHip,LKnee,LAnkle,LEye,LEar
// 中心关节（中性色）: 0 Nose, 1 Neck
