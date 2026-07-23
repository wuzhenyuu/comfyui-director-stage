"""Fix BONE_PATTERNS ordering: finger patterns MUST come before leftHand/rightHand to avoid greedy match."""
path = r'F:\comfyui\custom_nodes\comfyui-director-stage\editor-src\src\char-loader.js'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# The problem: leftHand pattern matches LeftHandThumb1 etc.
# Solution: reorder so finger patterns (21-60) come BEFORE hand patterns (4,7)
# in the BONE_PATTERNS array. In JS, mapBoneToJoint iterates the array top-to-bottom,
# first matching idx wins. So fingers at lower index positions take priority.

# Since we can't reorder the COCO indices, we need to add finger patterns 
# to the hand entries with negative lookahead, OR add hand patterns as secondary matches
# with word boundaries.

# Simplest fix: add \b boundaries to lefthand/righthand patterns
# lefthand\b won't match LeftHandThumb1
# But that's a JS regex change, not Python. Let's verify:
# JS: /lefthand\b/i.test("mixamorig:LeftHandThumb1") = false ✓

old_left_hand = r"""  [7,  [/lefthand/i, /LeftHand/i, /mixamorig[:]?LeftHand\\b/i, /L[_\s]*Hand/i, /left[_\s]*hand/i]],"""
new_left_hand = r"""  [7,  [/lefthand\\b/i, /LeftHand\\b/i, /mixamorig[:]?LeftHand\\b/i, /left[_\s]*hand\\b/i]],"""

old_right_hand = r"""  [4,  [/righthand/i, /RightHand/i, /mixamorig[:]?RightHand\\b/i, /R[_\s]*Hand/i, /right[_\s]*hand/i]],"""
new_right_hand = r"""  [4,  [/righthand\\b/i, /RightHand\\b/i, /mixamorig[:]?RightHand\\b/i, /right[_\s]*hand\\b/i]],"""

assert old_left_hand in content, 'leftHand pattern not found!'
assert old_right_hand in content, 'rightHand pattern not found!'
content = content.replace(old_left_hand, new_left_hand)
content = content.replace(old_right_hand, new_right_hand)

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)
print('OK: Added \\b boundaries to leftHand/rightHand patterns')
