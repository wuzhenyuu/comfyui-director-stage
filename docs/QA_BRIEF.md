# QA_BRIEF —— 3D导演台 M0 审核测试任务书

角色：QA agent。工作目录：F:\comfyui\custom_nodes\comfyui-director-stage
目标：对 M0 交付物做静态检查 + 契约一致性 + 集成冒烟测试，产出报告。

## 1. 静态检查
- 用 python 对 __init__.py、nodes.py 做 ast.parse 语法检查
- 把 web/js/directorStage.js 复制为 %TEMP%\ds_check.mjs 后 `node --check`
- 确认 web/editor/index.html 存在，且内部资源引用为相对路径（"./assets/..."）
- 确认 editor-src/vite.config.js 中 base:"./"

## 2. 契约一致性检查（grep 对照）
- nodes.py 与 web/js/directorStage.js 中 widget 名一致：scene_gz、manifest；节点名 "DirectorStage" 一致
- directorStage.js 的 iframe src 为 /director_stage/editor/index.html，且 __init__.py 用 web.static 挂载了该路径
- 编辑器源码中：POST /upload/image、subfolder="director_stage"、type="input"
- postMessage 消息类型齐全：ready / init / exportDone / cancel；manifest 结构 {files:{openpose,depth}}

## 3. 集成冒烟测试（重点）
- 后台启动独立测试实例（不要动可能正在运行的 8188 实例！）：
  cd F:\comfyui; .\venv\Scripts\python.exe main.py --port 8388 --cpu --disable-auto-launch
- 轮询等待启动（最多 8 分钟，插件多启动慢）
- 验证：
  a) GET http://127.0.0.1:8388/object_info/DirectorStage → 200，JSON 含 width/height/scene_gz/manifest 输入与 IMAGE 双输出
  b) GET http://127.0.0.1:8388/director_stage/editor/index.html → 200
  c) 启动日志中本插件无 import 报错（其他插件报错与本项目无关，注明即可）
- 测完只 kill 8388 这个测试进程，不得误杀其他 python/ComfyUI 进程

## 4. 修复原则
- 小问题（语法错误、路径笔误、缺文件）：直接修复并复测
- 架构性问题：只记录，不擅自重构

## 5. 产出
- 写 docs/QA_REPORT.md：每项 通过/失败 + 证据（命令输出摘录）
- 结论：M0 是否可交付 + 遗留问题清单
- 汇报时附核心结论
