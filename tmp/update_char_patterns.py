"""Update char-loader.js BONE_PATTERNS for Mixamo finger/toe bones."""
path = r'F:\comfyui\custom_nodes\comfyui-director-stage\editor-src\src\char-loader.js'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

old_patterns = '''const BONE_PATTERNS = [
  // [COCO index, regex patterns]
  // 注意：14(Nose)/15(Neck) 等头部关节共享 head 骨骼在一般 GLB 中是预期行为；
  // Nose 用 nose/nosetip 优先匹配，兜底到 head；Eyes/Ears 始终走 head。
  [0,  [/nose/i, /nosetip/i, /mixamorig[:]?Nose(?:Tip)?\\b/i, /head/i, /mixamorig:Head/i]],
  [1,  [/neck/i, /mixamorig:Neck/i, /mixamorigNeck\\b/i]],
  [2,  [/rightshoulder/i, /RightShoulder/i, /mixamorig[:]?RightArm\\b/i, /RightArm\\b/i, /right[_\\s]*upper[_\\s]*arm/i, /R[_\\s]*UpperArm/i, /upperarm[_\\s]*r\\b/i]],
  [3,  [/rightforearm/i, /right[_\\s]*(forearm|elbow)/i, /mixamorig[:]?RightForeArm\\b/i, /RightForeArm/i, /Forearm[_\\s]*[rR]\\b/i, /[rR][_\\s]*Forearm/i]],
  [4,  [/righthand/i, /RightHand/i, /mixamorig[:]?RightHand\\b/i, /R[_\\s]*Hand/i, /right[_\\s]*hand/i]],
  [5,  [/leftshoulder/i, /LeftShoulder/i, /mixamorig[:]?LeftArm\\b/i, /LeftArm\\b/i, /left[_\\s]*upper[_\\s]*arm/i, /L[_\\s]*UpperArm/i, /upperarm[_\\s]*l\\b/i]],
  [6,  [/leftforearm/i, /left[_\\s]*(forearm|elbow)/i, /mixamorig[:]?LeftForeArm\\b/i, /LeftForeArm/i, /Forearm[_\\s]*[lL]\\b/i, /[lL][_\\s]*Forearm/i]],
  [7,  [/lefthand/i, /LeftHand/i, /mixamorig[:]?LeftHand\\b/i, /L[_\\s]*Hand/i, /left[_\\s]*hand/i]],
  [8,  [/rightupleg/i, /RightUpLeg/i, /R[_\\s]*Thigh/i, /right[_\\s]*thigh/i]],
  [9,  [/rightleg/i, /RightLeg/i, /R[_\\s]*Calf/i, /right[_\\s]*calf/i]],
  [10, [/rightfoot/i, /RightFoot/i, /R[_\\s]*Foot/i, /right[_\\s]*foot/i]],
  [11, [/leftupleg/i, /LeftUpLeg/i, /L[_\\s]*Thigh/i, /left[_\\s]*thigh/i]],
  [12, [/leftleg/i, /LeftLeg/i, /L[_\\s]*Calf/i, /left[_\\s]*calf/i]],
  [13, [/leftfoot/i, /LeftFoot/i, /L[_\\s]*Foot/i, /left[_\\s]*foot/i]],
  [14, [/head/i, /mixamorig:Head/i]],                             // REye — 共享 head
  [15, [/head/i, /mixamorig:Head/i]],                             // LEye
  [16, [/head/i, /mixamorig:Head/i]],                             // REar
  [17, [/head/i, /mixamorig:Head/i]],                             // LEar
];'''

new_patterns = '''/**
 * COCO-18 + Mixamo 手指/趾扩展骨骼映射表。
 *
 * COCO 0-17  = 18 个主干关节（用于 openpose 导出 / IK 求解）。
 * COCO 18-53 = Mixamo 手指/趾/额外脊柱骨骼（仅 char-loader 加载时识别，
 *              bone-editor 通过 _resolveAll 按名字直接匹配，不依赖此表）。
 *
 * COCO 扩展索引分配（与 bone-editor.js CANON_KEYS 对应）：
 *   18=spine1  19=spine2  20=headTop
 *   21=leftThumb1  22=leftThumb2  23=leftThumb3  24=leftThumb4
 *   25=leftIndex1  26=leftIndex2  27=leftIndex3  28=leftIndex4
 *   29=leftMiddle1 30=leftMiddle2 31=leftMiddle3 32=leftMiddle4
 *   33=leftRing1   34=leftRing2   35=leftRing3   36=leftRing4
 *   37=leftPinky1  38=leftPinky2  39=leftPinky3  40=leftPinky4
 *   41=rightThumb1 42=rightThumb2 43=rightThumb3 44=rightThumb4
 *   45=rightIndex1 46=rightIndex2 47=rightIndex3 48=rightIndex4
 *   49=rightMiddle1 50=rightMiddle2 51=rightMiddle3 52=rightMiddle4
 *   53=rightRing1  54=rightRing2  55=rightRing3  56=rightRing4
 *   57=rightPinky1 58=rightPinky2 59=rightPinky3 60=rightPinky4
 *   61=leftToeBase  62=leftToeEnd   63=rightToeBase  64=rightToeEnd
 */
const BONE_PATTERNS = [
  // === COCO 0-17: 主干 18 关节（openpose / IK 必需） ===
  [0,  [/nose/i, /nosetip/i, /mixamorig[:]?Nose(?:Tip)?\\b/i, /head/i, /mixamorig:Head/i]],
  [1,  [/neck/i, /mixamorig:Neck/i, /mixamorigNeck\\b/i]],
  [2,  [/rightshoulder/i, /RightShoulder/i, /mixamorig[:]?RightArm\\b/i, /RightArm\\b/i, /right[_\\s]*upper[_\\s]*arm/i, /R[_\\s]*UpperArm/i, /upperarm[_\\s]*r\\b/i]],
  [3,  [/rightforearm/i, /right[_\\s]*(forearm|elbow)/i, /mixamorig[:]?RightForeArm\\b/i, /RightForeArm/i, /Forearm[_\\s]*[rR]\\b/i, /[rR][_\\s]*Forearm/i]],
  [4,  [/righthand/i, /RightHand/i, /mixamorig[:]?RightHand\\b/i, /R[_\\s]*Hand/i, /right[_\\s]*hand/i]],
  [5,  [/leftshoulder/i, /LeftShoulder/i, /mixamorig[:]?LeftArm\\b/i, /LeftArm\\b/i, /left[_\\s]*upper[_\\s]*arm/i, /L[_\\s]*UpperArm/i, /upperarm[_\\s]*l\\b/i]],
  [6,  [/leftforearm/i, /left[_\\s]*(forearm|elbow)/i, /mixamorig[:]?LeftForeArm\\b/i, /LeftForeArm/i, /Forearm[_\\s]*[lL]\\b/i, /[lL][_\\s]*Forearm/i]],
  [7,  [/lefthand/i, /LeftHand/i, /mixamorig[:]?LeftHand\\b/i, /L[_\\s]*Hand/i, /left[_\\s]*hand/i]],
  [8,  [/rightupleg/i, /RightUpLeg/i, /R[_\\s]*Thigh/i, /right[_\\s]*thigh/i]],
  [9,  [/rightleg/i, /RightLeg/i, /R[_\\s]*Calf/i, /right[_\\s]*calf/i]],
  [10, [/rightfoot/i, /RightFoot/i, /R[_\\s]*Foot/i, /right[_\\s]*foot/i]],
  [11, [/leftupleg/i, /LeftUpLeg/i, /L[_\\s]*Thigh/i, /left[_\\s]*thigh/i]],
  [12, [/leftleg/i, /LeftLeg/i, /L[_\\s]*Calf/i, /left[_\\s]*calf/i]],
  [13, [/leftfoot/i, /LeftFoot/i, /L[_\\s]*Foot/i, /left[_\\s]*foot/i]],
  [14, [/head/i, /mixamorig:Head/i]],  // REye
  [15, [/head/i, /mixamorig:Head/i]],  // LEye
  [16, [/head/i, /mixamorig:Head/i]],  // REar
  [17, [/head/i, /mixamorig:Head/i]],  // LEar

  // === COCO 18-20: 额外脊柱/头部 ===
  [18, [/spine1/i, /Spine1/i, /mixamorig:Spine1\\b/i]],
  [19, [/spine2/i, /Spine2/i, /mixamorig:Spine2\\b/i]],
  [20, [/headtop/i, /HeadTop/i, /mixamorig:HeadTop/i]],

  // === COCO 21-40: 左手五指（每指 4 节：base→mid→tip→nub） ===
  [21, [/left.*thumb1/i, /LeftHandThumb1/i, /mixamorig:LeftHandThumb1\\b/i]],
  [22, [/left.*thumb2/i, /LeftHandThumb2/i, /mixamorig:LeftHandThumb2\\b/i]],
  [23, [/left.*thumb3/i, /LeftHandThumb3/i, /mixamorig:LeftHandThumb3\\b/i]],
  [24, [/left.*thumb4/i, /left.*thumbnub/i, /LeftHandThumb4/i, /mixamorig:LeftHandThumb4\\b/i]],
  [25, [/left.*index1/i, /LeftHandIndex1/i, /mixamorig:LeftHandIndex1\\b/i]],
  [26, [/left.*index2/i, /LeftHandIndex2/i, /mixamorig:LeftHandIndex2\\b/i]],
  [27, [/left.*index3/i, /LeftHandIndex3/i, /mixamorig:LeftHandIndex3\\b/i]],
  [28, [/left.*index4/i, /left.*indexnub/i, /LeftHandIndex4/i, /mixamorig:LeftHandIndex4\\b/i]],
  [29, [/left.*middle1/i, /LeftHandMiddle1/i, /mixamorig:LeftHandMiddle1\\b/i]],
  [30, [/left.*middle2/i, /LeftHandMiddle2/i, /mixamorig:LeftHandMiddle2\\b/i]],
  [31, [/left.*middle3/i, /LeftHandMiddle3/i, /mixamorig:LeftHandMiddle3\\b/i]],
  [32, [/left.*middle4/i, /left.*middlenub/i, /LeftHandMiddle4/i, /mixamorig:LeftHandMiddle4\\b/i]],
  [33, [/left.*ring1/i, /LeftHandRing1/i, /mixamorig:LeftHandRing1\\b/i]],
  [34, [/left.*ring2/i, /LeftHandRing2/i, /mixamorig:LeftHandRing2\\b/i]],
  [35, [/left.*ring3/i, /LeftHandRing3/i, /mixamorig:LeftHandRing3\\b/i]],
  [36, [/left.*ring4/i, /left.*ringnub/i, /LeftHandRing4/i, /mixamorig:LeftHandRing4\\b/i]],
  [37, [/left.*pinky1/i, /LeftHandPinky1/i, /mixamorig:LeftHandPinky1\\b/i]],
  [38, [/left.*pinky2/i, /LeftHandPinky2/i, /mixamorig:LeftHandPinky2\\b/i]],
  [39, [/left.*pinky3/i, /LeftHandPinky3/i, /mixamorig:LeftHandPinky3\\b/i]],
  [40, [/left.*pinky4/i, /left.*pinkynub/i, /LeftHandPinky4/i, /mixamorig:LeftHandPinky4\\b/i]],

  // === COCO 41-60: 右手五指 ===
  [41, [/right.*thumb1/i, /RightHandThumb1/i, /mixamorig:RightHandThumb1\\b/i]],
  [42, [/right.*thumb2/i, /RightHandThumb2/i, /mixamorig:RightHandThumb2\\b/i]],
  [43, [/right.*thumb3/i, /RightHandThumb3/i, /mixamorig:RightHandThumb3\\b/i]],
  [44, [/right.*thumb4/i, /right.*thumbnub/i, /RightHandThumb4/i, /mixamorig:RightHandThumb4\\b/i]],
  [45, [/right.*index1/i, /RightHandIndex1/i, /mixamorig:RightHandIndex1\\b/i]],
  [46, [/right.*index2/i, /RightHandIndex2/i, /mixamorig:RightHandIndex2\\b/i]],
  [47, [/right.*index3/i, /RightHandIndex3/i, /mixamorig:RightHandIndex3\\b/i]],
  [48, [/right.*index4/i, /right.*indexnub/i, /RightHandIndex4/i, /mixamorig:RightHandIndex4\\b/i]],
  [49, [/right.*middle1/i, /RightHandMiddle1/i, /mixamorig:RightHandMiddle1\\b/i]],
  [50, [/right.*middle2/i, /RightHandMiddle2/i, /mixamorig:RightHandMiddle2\\b/i]],
  [51, [/right.*middle3/i, /RightHandMiddle3/i, /mixamorig:RightHandMiddle3\\b/i]],
  [52, [/right.*middle4/i, /right.*middlenub/i, /RightHandMiddle4/i, /mixamorig:RightHandMiddle4\\b/i]],
  [53, [/right.*ring1/i, /RightHandRing1/i, /mixamorig:RightHandRing1\\b/i]],
  [54, [/right.*ring2/i, /RightHandRing2/i, /mixamorig:RightHandRing2\\b/i]],
  [55, [/right.*ring3/i, /RightHandRing3/i, /mixamorig:RightHandRing3\\b/i]],
  [56, [/right.*ring4/i, /right.*ringnub/i, /RightHandRing4/i, /mixamorig:RightHandRing4\\b/i]],
  [57, [/right.*pinky1/i, /RightHandPinky1/i, /mixamorig:RightHandPinky1\\b/i]],
  [58, [/right.*pinky2/i, /RightHandPinky2/i, /mixamorig:RightHandPinky2\\b/i]],
  [59, [/right.*pinky3/i, /RightHandPinky3/i, /mixamorig:RightHandPinky3\\b/i]],
  [60, [/right.*pinky4/i, /right.*pinkynub/i, /RightHandPinky4/i, /mixamorig:RightHandPinky4\\b/i]],

  // === COCO 61-64: 脚趾 ===
  [61, [/left.*toebase/i, /LeftToeBase/i, /mixamorig:LeftToeBase\\b/i]],
  [62, [/left.*toe[_\\s]*end/i, /LeftToe_End/i, /mixamorig:LeftToe_End\\b/i]],
  [63, [/right.*toebase/i, /RightToeBase/i, /mixamorig:RightToeBase\\b/i]],
  [64, [/right.*toe[_\\s]*end/i, /RightToe_End/i, /mixamorig:RightToe_End\\b/i]],
];'''

assert old_patterns in content, 'BONE_PATTERNS not found!'
content = content.replace(old_patterns, new_patterns)

# Update getGLBJointPositions to use 65 instead of 18
content = content.replace(
    'for (let i = 0; i < 18; i++) {',
    'for (let i = 0; i < 65; i++) {'
)
# Update comment
content = content.replace(
    '获取 GLB 角色的 COCO-18 关节世界坐标',
    '获取 GLB 角色的完整关节世界坐标（65 个，COCO-18 + Mixamo 手指/趾/脊柱扩展）'
)

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)
print('OK: char-loader.js updated with 65-joint BONE_PATTERNS')
