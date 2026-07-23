"""Update bone-editor.js CANON_KEYS / NAME_FALLBACKS for Mixamo 55-key skeleton."""
import re

path = r'F:\comfyui\custom_nodes\comfyui-director-stage\editor-src\src\bone-editor.js'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# ── 1. Replace CANON_KEYS block ──
old_canon = '''/** 契约要求的规范骨骼 key（至少覆盖这些） */
const CANON_KEYS = [
  "hips", "root", "head", "neck", "spine", "chest",
  "rightUpperArm", "rightLowerArm", "rightHand",
  "leftUpperArm", "leftLowerArm", "leftHand",
  "rightUpperLeg", "rightLowerLeg", "rightFoot",
  "leftUpperLeg", "leftLowerLeg", "leftFoot",
];'''

new_canon = '''/**
 * Mixamo 完整骨骼规范 key（55 个，覆盖 michelle.glb 65 骨骼中可独立旋转的全部）
 *
 * 层次结构：
 *   Hips → Spine → Spine1 → Spine2 → Neck → Head → HeadTop_End
 *        → LeftUpLeg → LeftLeg → LeftFoot → LeftToeBase → LeftToe_End
 *        → RightUpLeg → RightLeg → RightFoot → RightToeBase → RightToe_End
 *   Spine2 → LeftShoulder → LeftArm → LeftForeArm → LeftHand → 5指x3节+1尖
 *        → RightShoulder → RightArm → RightForeArm → RightHand → 5指x3节+1尖
 */
const CANON_KEYS = [
  // 身体核心
  "hips", "spine", "spine1", "spine2",
  "neck", "head", "headTop",
  // 左臂 + 左手五指（Thumb3节+尖 / Index/Middle/Ring/Pinky 各4节尖）
  "leftShoulder", "leftUpperArm", "leftLowerArm", "leftHand",
  "leftThumb1", "leftThumb2", "leftThumb3", "leftThumb4",
  "leftIndex1", "leftIndex2", "leftIndex3", "leftIndex4",
  "leftMiddle1", "leftMiddle2", "leftMiddle3", "leftMiddle4",
  "leftRing1", "leftRing2", "leftRing3", "leftRing4",
  "leftPinky1", "leftPinky2", "leftPinky3", "leftPinky4",
  // 右臂 + 右手五指
  "rightShoulder", "rightUpperArm", "rightLowerArm", "rightHand",
  "rightThumb1", "rightThumb2", "rightThumb3", "rightThumb4",
  "rightIndex1", "rightIndex2", "rightIndex3", "rightIndex4",
  "rightMiddle1", "rightMiddle2", "rightMiddle3", "rightMiddle4",
  "rightRing1", "rightRing2", "rightRing3", "rightRing4",
  "rightPinky1", "rightPinky2", "rightPinky3", "rightPinky4",
  // 左腿
  "leftUpperLeg", "leftLowerLeg", "leftFoot", "leftToeBase", "leftToeEnd",
  // 右腿
  "rightUpperLeg", "rightLowerLeg", "rightFoot", "rightToeBase", "rightToeEnd",
];'''

assert old_canon in content, 'CANON_KEYS not found!'
content = content.replace(old_canon, new_canon)

# ── 2. Update JOINTMAP_INDEX comment ──
content = content.replace(
    '/** 规范 key → COCO-18 jointMap 索引（GLB/VRM 共用） */',
    '/** 规范 key → COCO-18 jointMap 索引（仅限身体主干关节；手指/趾不在 COCO-18 内，由 _resolveAll 直接按 allBones 名字匹配） */'
)

# ── 3. Replace NAME_FALLBACKS block ──
old_fb_start = '/** jointMap 缺失时的骨骼名模糊匹配 fallback（按优先级排列） */'
old_fb_end_text = '  leftFoot: [/leftfoot/i, /left[_\\s-]*(foot|ankle)/i, /foot[_\\s-]*l\\b/i, /l[_\\s-]*foot/i, /mixamorig:leftfoot/i],\n};'

idx_start = content.index(old_fb_start)
idx_end = content.index(old_fb_end_text, idx_start) + len(old_fb_end_text)

new_fallbacks = r'''/** jointMap 缺失时的骨骼名模糊匹配 fallback（55 keys，按优先级排列）
 *
 * 匹配策略：
 *   - 先在 jointMap（COCO-18）中找 → 命中 13 个主干关节
 *   - 失败则在 allBones 中按本表正则搜索 → 命中手指/趾/额外脊柱/头部
 *   - 手指/趾 key 后缀数字 = Mixamo 节索引（1=base, 2=mid, 3=tip, 4=nub/end）
 */
const NAME_FALLBACKS = {
  // 身体核心
  hips: [/hips/i, /pelvis/i],
  spine: [/^spine$/i, /spine\b/i],
  spine1: [/spine1/i, /spine[_\s-]*0?1\b/i],
  spine2: [/spine2/i, /spine[_\s-]*0?2\b/i],
  neck: [/neck/i],
  head: [/^head$/i, /head/i],
  headTop: [/headtop/i, /head[_\s-]*top/i],
  // 左臂
  leftShoulder: [/leftshoulder/i, /shoulder[_\s-]*l\b/i],
  leftUpperArm: [/left[_\s-]*upper[_\s-]*arm/i, /upperarm[_\s-]*l\b/i, /leftarm\b/i, /mixamorig:leftarm\b/i],
  leftLowerArm: [/leftforearm/i, /left[_\s-]*(lower[_\s-]*arm|forearm)/i, /forearm[_\s-]*l\b/i, /mixamorig:leftforearm/i],
  leftHand: [/lefthand/i, /hand[_\s-]*l\b/i, /mixamorig:lefthand/i],
  // 左手五指
  leftThumb1: [/left.*thumb1/i],
  leftThumb2: [/left.*thumb2/i],
  leftThumb3: [/left.*thumb3/i],
  leftThumb4: [/left.*thumb4/i, /left.*thumbnub/i],
  leftIndex1: [/left.*index1/i],
  leftIndex2: [/left.*index2/i],
  leftIndex3: [/left.*index3/i],
  leftIndex4: [/left.*index4/i, /left.*indexnub/i],
  leftMiddle1: [/left.*middle1/i],
  leftMiddle2: [/left.*middle2/i],
  leftMiddle3: [/left.*middle3/i],
  leftMiddle4: [/left.*middle4/i, /left.*middlenub/i],
  leftRing1: [/left.*ring1/i],
  leftRing2: [/left.*ring2/i],
  leftRing3: [/left.*ring3/i],
  leftRing4: [/left.*ring4/i, /left.*ringnub/i],
  leftPinky1: [/left.*pinky1/i],
  leftPinky2: [/left.*pinky2/i],
  leftPinky3: [/left.*pinky3/i],
  leftPinky4: [/left.*pinky4/i, /left.*pinkynub/i],
  // 右臂
  rightShoulder: [/rightshoulder/i, /shoulder[_\s-]*r\b/i],
  rightUpperArm: [/right[_\s-]*upper[_\s-]*arm/i, /upperarm[_\s-]*r\b/i, /rightarm\b/i, /mixamorig:rightarm\b/i],
  rightLowerArm: [/rightforearm/i, /right[_\s-]*(lower[_\s-]*arm|forearm)/i, /forearm[_\s-]*r\b/i, /mixamorig:rightforearm/i],
  rightHand: [/righthand/i, /hand[_\s-]*r\b/i, /mixamorig:righthand/i],
  // 右手五指
  rightThumb1: [/right.*thumb1/i],
  rightThumb2: [/right.*thumb2/i],
  rightThumb3: [/right.*thumb3/i],
  rightThumb4: [/right.*thumb4/i, /right.*thumbnub/i],
  rightIndex1: [/right.*index1/i],
  rightIndex2: [/right.*index2/i],
  rightIndex3: [/right.*index3/i],
  rightIndex4: [/right.*index4/i, /right.*indexnub/i],
  rightMiddle1: [/right.*middle1/i],
  rightMiddle2: [/right.*middle2/i],
  rightMiddle3: [/right.*middle3/i],
  rightMiddle4: [/right.*middle4/i, /right.*middlenub/i],
  rightRing1: [/right.*ring1/i],
  rightRing2: [/right.*ring2/i],
  rightRing3: [/right.*ring3/i],
  rightRing4: [/right.*ring4/i, /right.*ringnub/i],
  rightPinky1: [/right.*pinky1/i],
  rightPinky2: [/right.*pinky2/i],
  rightPinky3: [/right.*pinky3/i],
  rightPinky4: [/right.*pinky4/i, /right.*pinkynub/i],
  // 左腿
  leftUpperLeg: [/leftupleg/i, /left[_\s-]*(up[_\s-]*leg|thigh)/i, /thigh[_\s-]*l\b/i, /mixamorig:leftupleg\b/i],
  leftLowerLeg: [/left[_\s-]*(lower[_\s-]*leg|calf|shin)/i, /calf[_\s-]*l\b/i, /leftleg\b/i, /mixamorig:leftleg\b/i],
  leftFoot: [/leftfoot/i, /foot[_\s-]*l\b/i, /mixamorig:leftfoot/i],
  leftToeBase: [/left.*toebase/i, /lefttoebase/i],
  leftToeEnd: [/left.*toe[_\s-]*end/i, /lefttoe[_\s-]*end/i],
  // 右腿
  rightUpperLeg: [/rightupleg/i, /right[_\s-]*(up[_\s-]*leg|thigh)/i, /thigh[_\s-]*r\b/i, /mixamorig:rightupleg\b/i],
  rightLowerLeg: [/right[_\s-]*(lower[_\s-]*leg|calf|shin)/i, /calf[_\s-]*r\b/i, /rightleg\b/i, /mixamorig:rightleg\b/i],
  rightFoot: [/rightfoot/i, /foot[_\s-]*r\b/i, /mixamorig:rightfoot/i],
  rightToeBase: [/right.*toebase/i, /righttoebase/i],
  rightToeEnd: [/right.*toe[_\s-]*end/i, /righttoe[_\s-]*end/i],
};'''

content = content[:idx_start] + new_fallbacks + content[idx_end:]

# ── 4. Update CHAIN_DEFS comment ──
content = content.replace(
    '/** IK 链 ↔ 骨骼 key（同步 IK target/pole 用） */',
    '/** IK 链 ↔ 骨骼 key（同步 IK target/pole 用；手指/趾不参与 IK，走骨骼编辑直接旋转） */'
)

# ── 5. DEFAULT_TRANSLATE_KEYS: "hips", "root" → "hips" ──
content = content.replace(
    'const DEFAULT_TRANSLATE_KEYS = new Set(["hips", "root"]);',
    'const DEFAULT_TRANSLATE_KEYS = new Set(["hips"]);'
)

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)
print('OK: bone-editor.js updated with Mixamo 55-key skeleton')
