"""Reorder BONE_PATTERNS: finger patterns before hand patterns so they match first."""
path = r'F:\comfyui\custom_nodes\comfyui-director-stage\editor-src\src\char-loader.js'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# Strategy: Move hand entries (idx 4,7) AFTER all finger entries (idx 21-60),
# keeping the same COCO index numbers. The bone pattern array is ordered by 
# matching priority, not COCO index order. First matching entry wins.

# Current order: ..., 4(rightHand), 5(leftShoulder), 6(leftForeArm), 7(leftHand), 8-10(leg), ..., 21+(fingers), ...
# Target order: ..., 5(leftShoulder), 6(leftForeArm), 21+(fingers), 7(leftHand), 4(rightHand), 8-10(leg), ...

# Extract the two hand entries
old_righthand = """  [4,  [/righthand\\b/i, /RightHand\\b/i, /mixamorig[:]?RightHand\\b/i, /right[_\\s]*hand\\b/i]],"""
old_lefthand = """  [7,  [/lefthand\\b/i, /LeftHand\\b/i, /mixamorig[:]?LeftHand\\b/i, /left[_\\s]*hand\\b/i]],"""

assert old_righthand in content, 'rightHand not found'
assert old_lefthand in content, 'leftHand not found'

# Remove them
content = content.replace(old_righthand + '\n', '')
content = content.replace(old_lefthand + '\n', '')

# Find insertion point: right after leftUpperArm (idx 5)+leftLowerArm(6) entries, 
# before left foot entries (idx 13+). Actually best to put them AFTER all finger blocks
# Find "=== COCO 18-20" section which is after the finger section

# Actually simpler: put the hand entries right before the leg/toe section
# Find "=== COCO 61-64: 脚趾 ===" 
insert_marker = '  // === COCO 61-64: 脚趾 ==='

if insert_marker not in content:
    # Alternative: find left foot marker  
    insert_marker = '  [61, [/left.*toebase'

assert insert_marker in content, 'insert marker not found'

# Insert both hand entries before the marker
replacement = old_righthand + '\n' + old_lefthand + '\n' + insert_marker
content = content.replace(insert_marker, replacement)

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)
print('OK: Reordered BONE_PATTERNS - finger patterns now before hand patterns')
