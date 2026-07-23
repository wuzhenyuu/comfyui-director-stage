$file = "editor-src\src\main.js"
$content = Get-Content $file -Raw

# 1. Remove characterMode variable
$content = $content -replace "let characterMode = .glb.;.*stick.*已禁用.*\r?\n", ""

# 2. Remove tctrl creation block
$content = $content -replace "const \{ tctrl \} = createTransform\(defaultCamera, viewportCanvas, scene\);\r?\n// 2D 编辑器不使用 3D gizmo 拖拽.*\r?\ntctrl\.enabled = false;\r?\n// M2: tctrl.*figure\.js\r?\n", ""

# 3. Remove setupPointerEvents + setupKeyboardShortcuts blocks
$content = $content -replace "\r?\nsetupPointerEvents\(viewportCanvas, joints\);\r?\nsetupKeyboardShortcuts\(joints, \(\) => \{\r?\n  updateBones\(joints, bones\);\r?\n  updateStatus\(\);\r?\n\}\);", ""

# 4. Remove stickman hiding block in renderLoop (figureGroup.visible + stickMgr)
$content = $content -replace "\r?\n  // P3-1 3D-only：火柴人永久隐藏.*\r?\n  figureGroup\.visible = false;\r?\n  const stickMgr = window\.DS_FigureAPI\?\.getManager\?\.\(\);\r?\n  if \(stickMgr\) \{\r?\n    if \(stickMgr\.ikTargetsGroup\) stickMgr\.ikTargetsGroup\.visible = false;\r?\n    for \(const ch of stickMgr\.characters\.values\(\)\) \{\r?\n      if \(ch\.skeletonGroup && ch\.skeletonGroup\.visible\) ch\.skeletonGroup\.visible = false;\r?\n    \}\r?\n  \}", ""

# 5. Remove updateBones call in renderLoop
$content = $content -replace "\r?\n  // FK模式更新骨骼\r?\n  updateBones\(joints, bones\);", ""

# 6. Remove drawFrame call (stickman drawing)
$content = $content -replace "\r?\n  drawFrame\(figureGroup, joints, camRef, window\.__ds\?\.fkMode\);", ""

Set-Content $file -Value $content -NoNewline
Write-Output "Batch cleanup done"