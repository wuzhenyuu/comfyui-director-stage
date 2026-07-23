"""Fix _resolveAll hips/root fallback (remove root key from CANON_KEYS)."""
path = r'F:\comfyui\custom_nodes\comfyui-director-stage\editor-src\src\bone-editor.js'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

old_hips = '''    // hips/root：优先 pelvis/hips 命名；否则顶层骨骼（parent 不是 Bone）
    let hips =
      bones.find((b) => /pelvis|hips/i.test(b.name || "") && !b.parent?.isBone) ||
      bones.find((b) => /pelvis|hips/i.test(b.name || "")) ||
      bones.find((b) => !b.parent?.isBone) ||
      null;
    if (hips) {
      if (!map.has("hips")) map.set("hips", hips);
      if (!map.has("root")) map.set("root", map.get("hips"));
    }'''

new_hips = '''    // hips：优先 pelvis/hips 命名；否则顶层骨骼（parent 不是 Bone）
    let hipsBone =
      bones.find((b) => /pelvis|hips/i.test(b.name || "") && !b.parent?.isBone) ||
      bones.find((b) => /pelvis|hips/i.test(b.name || "")) ||
      bones.find((b) => !b.parent?.isBone) ||
      null;
    if (hipsBone && !map.has("hips")) map.set("hips", hipsBone);'''

assert old_hips in content, 'hips fallback not found!'
content = content.replace(old_hips, new_hips)

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)
print('OK: hips/root fallback updated')
