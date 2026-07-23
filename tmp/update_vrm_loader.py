"""Update vrm-loader.js VRM_TO_COCO for Mixamo finger/toe extension."""
path = r'F:\comfyui\custom_nodes\comfyui-director-stage\editor-src\src\vrm-loader.js'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

old_vrm = """const VRM_TO_COCO = {
  // Head
  head:          0,   // Nose → head
  neck:          1,   // Neck

  // Right arm (VRM: rightUpperArm → rightLowerArm → rightHand)
  rightUpperArm: 2,   // RShoulder
  rightLowerArm: 3,   // RElbow
  rightHand:     4,   // RWrist

  // Left arm
  leftUpperArm:  5,   // LShoulder
  leftLowerArm:  6,   // LElbow
  leftHand:      7,   // LWrist

  // Right leg
  rightUpperLeg: 8,   // RHip
  rightLowerLeg: 9,   // RKnee
  rightFoot:     10,  // RAnkle

  // Left leg
  leftUpperLeg:  11,  // LHip
  leftLowerLeg:  12,  // LKnee
  leftFoot:      13,  // LAnkle

  // Eyes
  leftEye:       15,  // LEye (COCO 15 = left eye)
  rightEye:      14,  // REye (COCO 14 = right eye)
};"""

new_vrm = """const VRM_TO_COCO = {
  // Head
  head:          0,   // Nose → head
  neck:          1,   // Neck

  // Right arm (VRM: rightUpperArm → rightLowerArm → rightHand)
  rightUpperArm: 2,   // RShoulder
  rightLowerArm: 3,   // RElbow
  rightHand:     4,   // RWrist

  // Left arm
  leftUpperArm:  5,   // LShoulder
  leftLowerArm:  6,   // LElbow
  leftHand:      7,   // LWrist

  // Right leg
  rightUpperLeg: 8,   // RHip
  rightLowerLeg: 9,   // RKnee
  rightFoot:     10,  // RAnkle

  // Left leg
  leftUpperLeg:  11,  // LHip
  leftLowerLeg:  12,  // LKnee
  leftFoot:      13,  // LAnkle

  // Eyes
  leftEye:       15,  // LEye (COCO 15 = left eye)
  rightEye:      14,  // REye (COCO 14 = right eye)

  // === Mixamo 手指/趾/脊柱扩展（VRM humanoid → COCO 18-64） ===
  upperChest:    19,  // spine2
  chest:         18,  // spine1
  spine:         18,  // spine1

  // 左手五指（VRM proximal→intermediate→distal = 1→2→3）
  leftThumbProximal:      21, leftThumbIntermediate: 22, leftThumbDistal:   23,
  leftIndexProximal:      25, leftIndexIntermediate: 26, leftIndexDistal:   27,
  leftMiddleProximal:     29, leftMiddleIntermediate:30, leftMiddleDistal:  31,
  leftRingProximal:       33, leftRingIntermediate:  34, leftRingDistal:    35,
  leftLittleProximal:     37, leftLittleIntermediate:38, leftLittleDistal:  39,

  // 右手五指
  rightThumbProximal:     41, rightThumbIntermediate:42, rightThumbDistal:  43,
  rightIndexProximal:     45, rightIndexIntermediate:46, rightIndexDistal:  47,
  rightMiddleProximal:    49, rightMiddleIntermediate:50, rightMiddleDistal: 51,
  rightRingProximal:      53, rightRingIntermediate: 54, rightRingDistal:   55,
  rightLittleProximal:    57, rightLittleIntermediate:58, rightLittleDistal: 59,

  // 脚趾
  leftToes:       61,  // leftToeBase
  rightToes:      63,  // rightToeBase
};"""

assert old_vrm in content, 'VRM_TO_COCO not found!'
content = content.replace(old_vrm, new_vrm)

# Update buildJointMap to also grab finger bones
old_bone_names = """  const vrmBoneNames = [
    "head", "neck",
    "rightUpperArm", "rightLowerArm", "rightHand",
    "leftUpperArm", "leftLowerArm", "leftHand",
    "rightUpperLeg", "rightLowerLeg", "rightFoot",
    "leftUpperLeg", "leftLowerLeg", "leftFoot",
    "leftEye", "rightEye",
  ];"""

new_bone_names = """  const vrmBoneNames = [
    "head", "neck",
    "rightUpperArm", "rightLowerArm", "rightHand",
    "leftUpperArm", "leftLowerArm", "leftHand",
    "rightUpperLeg", "rightLowerLeg", "rightFoot",
    "leftUpperLeg", "leftLowerLeg", "leftFoot",
    "leftEye", "rightEye",
    // VRM 手指骨骼（proximal→intermediate→distal）
    "leftThumbProximal", "leftThumbIntermediate", "leftThumbDistal",
    "leftIndexProximal", "leftIndexIntermediate", "leftIndexDistal",
    "leftMiddleProximal", "leftMiddleIntermediate", "leftMiddleDistal",
    "leftRingProximal", "leftRingIntermediate", "leftRingDistal",
    "leftLittleProximal", "leftLittleIntermediate", "leftLittleDistal",
    "rightThumbProximal", "rightThumbIntermediate", "rightThumbDistal",
    "rightIndexProximal", "rightIndexIntermediate", "rightIndexDistal",
    "rightMiddleProximal", "rightMiddleIntermediate", "rightMiddleDistal",
    "rightRingProximal", "rightRingIntermediate", "rightRingDistal",
    "rightLittleProximal", "rightLittleIntermediate", "rightLittleDistal",
    // 脊柱 + 脚趾
    "upperChest", "chest", "spine",
    "leftToes", "rightToes",
  ];"""

assert old_bone_names in content, 'vrmBoneNames not found!'
content = content.replace(old_bone_names, new_bone_names)

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)
print('OK: vrm-loader.js updated with Mixamo finger/toe VRM mapping')
