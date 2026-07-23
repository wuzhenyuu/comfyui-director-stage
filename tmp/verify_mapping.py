"""Verify Mixamo 55-key skeleton matches michelle.glb 65 bones."""
import re

# Build patterns from BONE_PATTERNS (simulate JS regex matching)
patterns = [
    (0, [r"nose", r"nosetip", r"mixamorig:?Nose(?:Tip)?\b", r"head", r"mixamorig:Head"]),
    (1, [r"neck", r"mixamorig:Neck", r"mixamorigNeck\b"]),
    (2, [r"rightshoulder", r"RightShoulder", r"mixamorig:?RightArm\b", r"right[\s_]*upper[\s_]*arm", r"upperarm[\s_]*r\b"]),
    (3, [r"rightforearm", r"right[\s_]*(forearm|elbow)", r"mixamorig:?RightForeArm\b", r"RightForeArm"]),
    (4, [r"righthand", r"RightHand", r"mixamorig:?RightHand\b", r"right[\s_]*hand"]),
    (5, [r"leftshoulder", r"LeftShoulder", r"mixamorig:?LeftArm\b", r"left[\s_]*upper[\s_]*arm", r"upperarm[\s_]*l\b"]),
    (6, [r"leftforearm", r"left[\s_]*(forearm|elbow)", r"mixamorig:?LeftForeArm\b", r"LeftForeArm"]),
    (7, [r"lefthand", r"LeftHand", r"mixamorig:?LeftHand\b", r"left[\s_]*hand"]),
    (8, [r"rightupleg", r"RightUpLeg", r"right[\s_]*thigh"]),
    (9, [r"rightleg", r"RightLeg", r"right[\s_]*calf"]),
    (10, [r"rightfoot", r"RightFoot", r"right[\s_]*foot"]),
    (11, [r"leftupleg", r"LeftUpLeg", r"left[\s_]*thigh"]),
    (12, [r"leftleg", r"LeftLeg", r"left[\s_]*calf"]),
    (13, [r"leftfoot", r"LeftFoot", r"left[\s_]*foot"]),
    (14, [r"head", r"mixamorig:Head"]),
    (15, [r"head", r"mixamorig:Head"]),
    (16, [r"head", r"mixamorig:Head"]),
    (17, [r"head", r"mixamorig:Head"]),
    # spine/head extension
    (18, [r"spine1", r"Spine1", r"mixamorig:Spine1\b"]),
    (19, [r"spine2", r"Spine2", r"mixamorig:Spine2\b"]),
    (20, [r"headtop", r"HeadTop", r"mixamorig:HeadTop"]),
    # left fingers
    (21, [r"left.*thumb1", r"LeftHandThumb1", r"mixamorig:LeftHandThumb1\b"]),
    (22, [r"left.*thumb2", r"LeftHandThumb2", r"mixamorig:LeftHandThumb2\b"]),
    (23, [r"left.*thumb3", r"LeftHandThumb3", r"mixamorig:LeftHandThumb3\b"]),
    (24, [r"left.*thumb4", r"left.*thumbnub", r"LeftHandThumb4", r"mixamorig:LeftHandThumb4\b"]),
    (25, [r"left.*index1", r"LeftHandIndex1", r"mixamorig:LeftHandIndex1\b"]),
    (26, [r"left.*index2", r"LeftHandIndex2", r"mixamorig:LeftHandIndex2\b"]),
    (27, [r"left.*index3", r"LeftHandIndex3", r"mixamorig:LeftHandIndex3\b"]),
    (28, [r"left.*index4", r"left.*indexnub", r"LeftHandIndex4", r"mixamorig:LeftHandIndex4\b"]),
    (29, [r"left.*middle1", r"LeftHandMiddle1", r"mixamorig:LeftHandMiddle1\b"]),
    (30, [r"left.*middle2", r"LeftHandMiddle2", r"mixamorig:LeftHandMiddle2\b"]),
    (31, [r"left.*middle3", r"LeftHandMiddle3", r"mixamorig:LeftHandMiddle3\b"]),
    (32, [r"left.*middle4", r"left.*middlenub", r"LeftHandMiddle4", r"mixamorig:LeftHandMiddle4\b"]),
    (33, [r"left.*ring1", r"LeftHandRing1", r"mixamorig:LeftHandRing1\b"]),
    (34, [r"left.*ring2", r"LeftHandRing2", r"mixamorig:LeftHandRing2\b"]),
    (35, [r"left.*ring3", r"LeftHandRing3", r"mixamorig:LeftHandRing3\b"]),
    (36, [r"left.*ring4", r"left.*ringnub", r"LeftHandRing4", r"mixamorig:LeftHandRing4\b"]),
    (37, [r"left.*pinky1", r"LeftHandPinky1", r"mixamorig:LeftHandPinky1\b"]),
    (38, [r"left.*pinky2", r"LeftHandPinky2", r"mixamorig:LeftHandPinky2\b"]),
    (39, [r"left.*pinky3", r"LeftHandPinky3", r"mixamorig:LeftHandPinky3\b"]),
    (40, [r"left.*pinky4", r"left.*pinkynub", r"LeftHandPinky4", r"mixamorig:LeftHandPinky4\b"]),
    # right fingers
    (41, [r"right.*thumb1", r"RightHandThumb1", r"mixamorig:RightHandThumb1\b"]),
    (42, [r"right.*thumb2", r"RightHandThumb2", r"mixamorig:RightHandThumb2\b"]),
    (43, [r"right.*thumb3", r"RightHandThumb3", r"mixamorig:RightHandThumb3\b"]),
    (44, [r"right.*thumb4", r"right.*thumbnub", r"RightHandThumb4", r"mixamorig:RightHandThumb4\b"]),
    (45, [r"right.*index1", r"RightHandIndex1", r"mixamorig:RightHandIndex1\b"]),
    (46, [r"right.*index2", r"RightHandIndex2", r"mixamorig:RightHandIndex2\b"]),
    (47, [r"right.*index3", r"RightHandIndex3", r"mixamorig:RightHandIndex3\b"]),
    (48, [r"right.*index4", r"right.*indexnub", r"RightHandIndex4", r"mixamorig:RightHandIndex4\b"]),
    (49, [r"right.*middle1", r"RightHandMiddle1", r"mixamorig:RightHandMiddle1\b"]),
    (50, [r"right.*middle2", r"RightHandMiddle2", r"mixamorig:RightHandMiddle2\b"]),
    (51, [r"right.*middle3", r"RightHandMiddle3", r"mixamorig:RightHandMiddle3\b"]),
    (52, [r"right.*middle4", r"right.*middlenub", r"RightHandMiddle4", r"mixamorig:RightHandMiddle4\b"]),
    (53, [r"right.*ring1", r"RightHandRing1", r"mixamorig:RightHandRing1\b"]),
    (54, [r"right.*ring2", r"RightHandRing2", r"mixamorig:RightHandRing2\b"]),
    (55, [r"right.*ring3", r"RightHandRing3", r"mixamorig:RightHandRing3\b"]),
    (56, [r"right.*ring4", r"right.*ringnub", r"RightHandRing4", r"mixamorig:RightHandRing4\b"]),
    (57, [r"right.*pinky1", r"RightHandPinky1", r"mixamorig:RightHandPinky1\b"]),
    (58, [r"right.*pinky2", r"RightHandPinky2", r"mixamorig:RightHandPinky2\b"]),
    (59, [r"right.*pinky3", r"RightHandPinky3", r"mixamorig:RightHandPinky3\b"]),
    (60, [r"right.*pinky4", r"right.*pinkynub", r"RightHandPinky4", r"mixamorig:RightHandPinky4\b"]),
    # toes
    (61, [r"left.*toebase", r"LeftToeBase", r"mixamorig:LeftToeBase\b"]),
    (62, [r"left.*toe[\s_]*end", r"LeftToe_End", r"mixamorig:LeftToe_End\b"]),
    (63, [r"right.*toebase", r"RightToeBase", r"mixamorig:RightToeBase\b"]),
    (64, [r"right.*toe[\s_]*end", r"RightToe_End", r"mixamorig:RightToe_End\b"]),
]

# michelle.glb bone names
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

# Track matches
matched = {}  # bone_name -> coco_idx
unmatched = []  # bone_names that hit nothing
used_idx = {}   # coco_idx -> bone_name (first match wins)

for bone in bone_names:
    found = False
    for idx, pats in patterns:
        for p in pats:
            if re.search(p, bone, re.IGNORECASE):
                if idx not in used_idx:
                    used_idx[idx] = bone
                matched[bone] = idx
                found = True
                break
        if found:
            break
    if not found:
        unmatched.append(bone)

print(f"=== Match Results for michelle.glb ({len(bone_names)} bones) ===")
print(f"Matched: {len(matched)} / {len(bone_names)}")
print(f"Unique COCO indices covered: {len(used_idx)} / 65")

# Group by region
regions = {
    "Body Core (0-20)": [],
    "Left Fingers (21-40)": [],
    "Right Fingers (41-60)": [],
    "Legs & Toes (61-64)": [],
    "Unused COCO indices": [],
}

for bone, idx in matched.items():
    if idx <= 20: regions["Body Core (0-20)"].append(f"  [{idx:2d}] {bone}")
    elif idx <= 40: regions["Left Fingers (21-40)"].append(f"  [{idx:2d}] {bone}")
    elif idx <= 60: regions["Right Fingers (41-60)"].append(f"  [{idx:2d}] {bone}")
    else: regions["Legs & Toes (61-64)"].append(f"  [{idx:2d}] {bone}")

for idx in range(65):
    if idx not in used_idx:
        regions["Unused COCO indices"].append(f"  [{idx:2d}] — no matching bone")

for region, items in regions.items():
    print(f"\n--- {region} ---")
    for item in items:
        print(item)

if unmatched:
    print(f"\n--- UNMATCHED bones (no pattern hit) ---")
    for b in unmatched:
        print(f"  ✗ {b}")

print(f"\n=== Summary: {len(matched)}/{len(bone_names)} bones matched, {len(unmatched)} unmatched ===")
