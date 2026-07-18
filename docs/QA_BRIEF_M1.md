# QA_BRIEF_M1 —— 3D导演台 M1 审核测试任务书

角色：QA agent。工作目录：F:\comfyui\custom_nodes\comfyui-director-stage
M1 新增：编辑器子树联动/骨长锁定/undo/焦距/姿势库、后端 poses 路由+上传清理+示例工作流、10个预置姿势数据。

## 1. 静态检查
- python ast.parse：__init__.py、nodes.py
- node --check：web/js/directorStage.js（复制为 %TEMP%\*.mjs）
- web/editor/index.html 存在、资源相对路径；editor-src 构建无报错记录

## 2. 契约一致性
- __init__.py 挂载 /director_stage/poses → assets/poses（web.static），且编辑器源码 fetch "/director_stage/poses/index.json"
- assets/poses/index.json 与实际文件一一对应；每个姿势 json 含全部 18 个 COCO 关节名（Nose,Neck,RShoulder,RElbow,RWrist,LShoulder,LElbow,LWrist,RHip,RKnee,RAnkle,LHip,LKnee,LAnkle,REye,LEye,REar,LEar），坐标为合理人体尺度（骨长与 T-pose 基准误差 <15%）
- 导出契约未破坏：manifest={files:{openpose,depth}}、subfolder="director_stage"、postMessage ready/init/exportDone/cancel
- 编辑器 message 监听有同源校验（event.origin）
- examples/*.json 是合法 JSON 且包含 DirectorStage 节点、连线 id 自洽

## 3. 集成冒烟（重点）
- 后台起独立实例（勿动 8188）：cd F:\comfyui; .\venv\Scripts\python.exe main.py --port 8388 --cpu --disable-auto-launch，最多等 8 分钟
- 验证：
  a) GET http://127.0.0.1:8388/object_info/DirectorStage → 200
  b) GET http://127.0.0.1:8388/director_stage/editor/index.html → 200
  c) GET http://127.0.0.1:8388/director_stage/poses/index.json → 200 且列表非空
  d) 日志中本插件无 import 错误
  e) 端到端：参考 docs/qa_e2e_prompt.py 上传测试图→POST /prompt 提交含 DirectorStage 的最小工作流→出图成功
- 上传清理逻辑验证：先在 F:\comfyui\input\director_stage\ 放一个假 png 并把 LastWriteTime 改成 9 天前，再放一个新 png；重启测试实例后确认旧的被删、新的保留（若清理在启动时执行）
- 测完只 kill 8388 测试进程（记 PID，绝不误杀其他 python）

## 4. 修复原则
小问题（语法/路径/schema 笔误/缺文件）直接修复并复测；架构问题只记录。

## 5. 产出
docs/QA_REPORT_M1.md：每项 通过/失败+证据；结论：M1 是否可交付+遗留清单。汇报附核心结论。
