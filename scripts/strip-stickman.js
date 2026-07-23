// strip-stickman.js — 从 main.js 中删除所有火柴人代码
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'editor-src', 'src', 'main.js');
let content = fs.readFileSync(file, 'utf8');

// 1. 删除 figure.js import（替换为注释）
content = content.replace(
  /import \{ createJoints, createBones, updateBones \} from "\.\/figure\.js";\r?\n/,
  '// figure.js import removed (stickman purged)\n'
);

// 2. 删除 pose-panel.js import
content = content.replace(
  /import \{ mirrorPose \} from "\.\/pose-panel\.js";\r?\n/,
  ''
);

// 3. 删除 figureGroup/joints/bones 创建代码块
content = content.replace(
  /\/\* ========================= 火柴人[\s\S]*?========================= \*\/[\s\S]*?updateBones\(joints, bones\);[\s]*/,
  '// stickman figureGroup/joints/bones removed\n'
);

// 4. 删除 renderLoop 中的 updateBones 调用
content = content.replace(
  /  \/\/ FK模式更新骨骼\r?\n  updateBones\(joints, bones\);\r?\n/,
  ''
);

// 5. 删除 renderLoop 中的火柴人隐藏防御代码
content = content.replace(
  /  \/\/ P3-1 3D-only：火柴人永久隐藏[\s\S]*?    \}\r?\n  \}\r?\n/,
  ''
);

// 6. 删除 renderLoop 中的 drawFrame(figureGroup,...) 调用
content = content.replace(
  /  drawFrame\(figureGroup, joints, camRef, window\.__ds\?\.fkMode\);\r?\n/,
  ''
);

// 7. 删除 _dsRef 中的 figureGroup getter
content = content.replace(
  /  get figureGroup\(\) \{ return figureGroup; \},\r?\n/,
  ''
);

// 8. 删除注释中的 figure.js 引用
content = content.replace(
  /\/\/ M2: tctrl.*figure\.js\r?\n/,
  ''
);

// 9. 清理空行（连续3个以上空行变成2个）
content = content.replace(/\r?\n\r?\n\r?\n\r?\n+/g, '\n\n\n');

fs.writeFileSync(file, content, 'utf8');
console.log('Done. Stripped stickman code from main.js');
console.log('Lines:', content.split('\n').length);
