# QA_BRIEF_M2 —— 3D导演台 M2 审核测试任务书

## 1. 静态检查
- python ast.parse __init__.py / nodes.py；node --check web/js/directorStage.js
- web/editor/index.html 存在+资源相对路径；npx vite build 无报错

## 2. 契约一致性
- nodes.py 输出: IMAGE(openpose/depth/normal/lineart) + MASK(char_masks) + STRING(camera_json)；DirectorStageShot 存在
- 编辑器 manifest 含 cameras[] 数组（每相机 files/width/height/focalMM/pose）
- 编辑器源码存在 ik-solver.js、char-panel.js、props.js、glb-import.js、cameras.js、pass-renderer.js 等 M2 新模块
- /director_stage/editor + /director_stage/poses 路由可用
- postMessage 同源校验保留

## 3. 集成冒烟（重点）
- 起独立实例：cd F:\comfyui; .\venv\Scripts\python.exe main.py --port 8388 --cpu --disable-auto-launch（不动8188，≤8分钟）
- 验证：/object_info/DirectorStage 200（含全部新输出）、/object_info/DirectorStageShot 200
- /director_stage/editor/index.html 200、/director_stage/poses/index.json 200
- 日志无本插件 import 错误
- 端到端队列出图：上传 openpose+depth 测试图→POST /prompt→出图成功
- 多机位 manifest（cameras[]）被 DirectorStageShot 正确解析

## 4. 功能验证
- 多角色：编辑器支持≥2个角色独立IK、pose、显示/隐藏
- IK脚钉地：移动根时脚位置不变（误差<0.01m）
- 积木道具：盒/球/柱/板可添加/移动/缩放/落地
- GLB 导入：file input→上传→场景中可见
- 多机位：≥2个相机切换，每相机独立焦距；导出 manifest 不同相机有不同 output
- 新通道：normal(RGB正确的view-space法线)、lineart(白底黑线)、char_masks(每角色独白图)

## 5. 修复原则
小问题直接修；架构问题只记录

## 6. 产出
docs/QA_REPORT_M2.md，结论 M2 可交付+遗留。汇报附核心结论。测完只 kill 8388。
