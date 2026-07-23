"""Fix hand patterns and reorder BONE_PATTERNS for finger-first matching."""
import re

path = r'F:\comfyui\custom_nodes\comfyui-director-stage\editor-src\src\char-loader.js'
with open(path, 'r', encoding='utf-8') as f:
    c = f.read()

# 1. Fix leftHand pattern: add word boundaries, remove /L[_\s]*Hand/i, /left[_\s]*hand/i (too greedy)
old_lh = "[/lefthand/i, /LeftHand/i, /mixamorig[:]?LeftHand\\b/i, /L[_\\s]*Hand/i, /left[_\\s]*hand/i]"
new_lh = "[/lefthand\\b/i, /LeftHand\\b/i, /mixamorig[:]?LeftHand\\b/i]"
c = c.replace(old_lh, new_lh, 1)

# 2. Fix rightHand pattern similarly
old_rh = "[/righthand/i, /RightHand/i, /mixamorig[:]?RightHand\\b/i, /R[_\\s]*Hand/i, /right[_\\s]*hand/i]"
new_rh = "[/righthand\\b/i, /RightHand\\b/i, /mixamorig[:]?RightHand\\b/i]"
c = c.replace(old_rh, new_rh, 1)

# 3. Now move hand entries to AFTER finger entries, BEFORE toe entries
# First extract the hand entry lines
rh_line = next((l for l in c.split('\n') if 'righthand' in l.lower() and '[4,' in l), None)
lh_line = next((l for l in c.split('\n') if 'lefthand' in l.lower() and '[7,' in l), None)

if rh_line and lh_line:
    # Remove them
    c = c.replace(rh_line + '\n', '', 1)
    c = c.replace(lh_line + '\n', '', 1)
    
    # Find the toe section start
    toe_marker = '  // === COCO 61-64'
    if toe_marker in c:
        c = c.replace(toe_marker, rh_line + '\n' + lh_line + '\n' + toe_marker)
        print('Reordered: hand entries moved before toe section')
    else:
        print('WARNING: toe marker not found, not reordered')
else:
    print('WARNING: hand lines not found')

with open(path, 'w', encoding='utf-8') as f:
    f.write(c)
print('Done')
