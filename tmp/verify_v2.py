"""Verify BONE_PATTERNS mapping v2 - check finger matching after reorder."""
import re

# Read current BONE_PATTERNS
path = r'F:\comfyui\custom_nodes\comfyui-director-stage\editor-src\src\char-loader.js'
with open(path, 'r', encoding='utf-8') as f:
    c = f.read()

# Extract patterns using regex
pattern_text = re.search(r'const BONE_PATTERNS = \[(.*?)\];', c, re.DOTALL)
entries = re.findall(r'\[(\d+),\s*\[(.*?)\]\]', pattern_text.group(1))
patterns = [(int(idx), re.findall(r'/[^/]+/[a-z]*', pats)) for idx, pats in entries]

bone_names = [
    "mixamorig:Hips", "mixamorig:Spine", "mixamorig:Spine1", "mixamorig:Spine2",
    "mixamorig:Neck", "mixamorig:Head", "mixamorig:HeadTop_End",
    "mixamorig:LeftShoulder", "mixamorig:LeftArm", "mixamorig:LeftForeArm", "mixamorig:LeftHand",
    "mixamorig:LeftHandThumb1", "mixamorig:LeftHandThumb2", "mixamorig:LeftHandThumb3", "mixamorig:LeftHandThumb4",
    "mixamorig:LeftHandIndex1", "mixamorig:LeftHandIndex2", "mixamorig:LeftHandIndex3", "mixamorig:LeftHandIndex4",
    "mixamorig:LeftHandMiddle1", "mixamorig:LeftHandMiddle2", "mixamorig:LeftHandMiddle3", "mixamorig:LeftHandMiddle4",
    "mixamorig:LeftHandRing1", "mixamorig:LeftHandRing2", "mixamorig:LeftHandRing3", "mixamorig:LeftHandRing4",
    "mixamorig:LeftHandPinky1", "mixamorig:LeftHandPinky2", "mixamorig:LeftHandPinky3", "mixamorig:LeftHandPinky4",
    "mixamorig:RightShoulder", "mixamorig:RightArm", "mixamorig:RightForeArm", "mixamorig:RightHand",
    "mixamorig:RightHandThumb1", "mixamorig:RightHandThumb2", "mixamorig:RightHandThumb3", "mixamorig:RightHandThumb4",
    "mixamorig:RightHandIndex1", "mixamorig:RightHandIndex2", "mixamorig:RightHandIndex3", "mixamorig:RightHandIndex4",
    "mixamorig:RightHandMiddle1", "mixamorig:RightHandMiddle2", "mixamorig:RightHandMiddle3", "mixamorig:RightHandMiddle4",
    "mixamorig:RightHandRing1", "mixamorig:RightHandRing2", "mixamorig:RightHandRing3", "mixamorig:RightHandRing4",
    "mixamorig:RightHandPinky1", "mixamorig:RightHandPinky2", "mixamorig:RightHandPinky3", "mixamorig:RightHandPinky4",
    "mixamorig:LeftUpLeg", "mixamorig:LeftLeg", "mixamorig:LeftFoot", "mixamorig:LeftToeBase", "mixamorig:LeftToe_End",
    "mixamorig:RightUpLeg", "mixamorig:RightLeg", "mixamorig:RightFoot", "mixamorig:RightToeBase", "mixamorig:RightToe_End",
]

def test_pattern(pats, bone_name):
    for p in pats:
        p = p.strip('/')
        flags = 0
        if p.endswith('i'):
            p = p[:-1]
            flags = re.IGNORECASE
        try:
            if re.search(p, bone_name, flags):
                return True
        except:
            pass
    return False

matched = {}
used_idx = {}
unmatched = []

for bone in bone_names:
    found = False
    for idx, pats in patterns:
        if test_pattern(pats, bone):
            if idx not in used_idx:
                used_idx[idx] = bone
            matched[bone] = idx
            found = True
            break
    if not found:
        unmatched.append(bone)

print(f"Matched: {len(matched)}/{len(bone_names)}")
print(f"Unique indices: {len(used_idx)}/65")

# Check finger bones specifically
finger_issues = []
for bone in bone_names:
    if 'Thumb' in bone or 'Index' in bone or 'Middle' in bone or 'Ring' in bone or 'Pinky' in bone:
        idx = matched.get(bone, -1)
        expected_start = 21 if 'Left' in bone else 41
        if idx == 7 or idx == 4 or idx == -1:
            finger_issues.append(f"  {bone} -> idx {idx} (expected {expected_start}+)")

if finger_issues:
    print(f"\nFINGER MATCHING ISSUES ({len(finger_issues)}):")
    for i in finger_issues:
        print(i)

print(f"\nUnmatched bones: {len(unmatched)}")
for b in unmatched[:5]:
    print(f"  - {b}")

# Show patterns in order
print(f"\nBONE_PATTERNS order (first 15 + hand-related):")
shown_hand = False
for idx, pats in patterns:
    s = ', '.join(pats[:2])
    if idx <= 5 or idx in (4,7) or (21 <= idx <= 23) or (41 <= idx <= 43):
        print(f"  idx {idx}: {s}")
    if idx == 7:
        shown_hand = True
