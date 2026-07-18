# 🎬 ComfyUI 3D导演台（comfyui-director-stage）

在 ComfyUI 里内嵌一个 3D「导演台」：摆人偶姿势、搭场景、调机位，一键导出 OpenPose / Depth 等控制图，直接接 ControlNet 出图。开源、本地运行、不绑定任何生成服务。

## 功能

### M0（通路验证）
- ✅ `🎬 3D导演台` 节点：输出 `openpose` / `depth` 两路 IMAGE tensor
- ✅ 前端编辑器以 iframe 方式打开，导出 PNG 上传至 `input/director_stage/`，文件清单写回节点 manifest
- ✅ manifest 哈希参与缓存判定（场景没动就命中缓存）；文件缺失时输出空白图并打印警告，不中断队列

### M1（本版新增）
- ✅ 3D 摆姿器：拖拽关节旋转人偶，手部含完整 21 点指骨
- ✅ 子树联动：旋转躯干时手臂自动跟随（FK 链）
- ✅ 骨长锁定：关节旋转不改变骨骼原始长度
- ✅ undo / redo：完整编辑历史栈，Ctrl+Z 随时回退
- ✅ 焦距与构图安全框：35mm 等效焦距调节 + 三分/中心辅助线
- ✅ 姿势库：`/director_stage/poses/` 路由提供 10 组预置姿势，编辑器内一键加载
- ✅ 双通道导出：openpose + depth 同时渲染，分别走独立 ControlNet 串联出图
- ✅ 启动自动清理：`input/director_stage/` 下超过 7 天的旧控制图自动删除

## 安装

1. 把本仓库放入 `ComfyUI/custom_nodes/comfyui-director-stage`
2. 重启 ComfyUI

无额外 Python 依赖（仅用 ComfyUI 自带的 torch / numpy / PIL）。

## 快速上手

1. 在画布中添加节点：`🎬DirectorStage → 🎬 3D导演台`
2. 点击节点上的「🎬 打开导演台」按钮，在弹出的编辑器里摆姿势 / 调整机位
3. 点「✅ 应用」：编辑器渲染并上传控制图，自动写回节点
4. 把 `openpose` 输出接到 ControlNet（OpenPose），`depth` 输出接到 ControlNet（Depth）
   - 建议 openpose 强度 0.9~1.0，depth 强度 0.4~0.7
5. Queue 出图

> **提示**：`width` / `height` 建议与 EmptyLatentImage 分辨率一致；场景数据会随 workflow 保存，重新打开可继续编辑。

## 示例工作流

`examples/` 目录提供了两个可直接在 ComfyUI 中加载的工作流：

| 文件 | 说明 |
|---|---|
| `basic_openpose.json` | DirectorStage openpose 输出 → ControlNet OpenPose → SD1.5 文生图（单通道基础版） |
| `dual_pose_depth.json` | openpose（强度 0.9）→ ControlNet OpenPose，depth（强度 0.5）→ ControlNet Depth，双通道串联出图 |

**使用前请注意**：
- 工作流中的模型文件名为**占位符**（`v1-5-pruned-emaonly.safetensors`、`control_v11p_sd15_openpose.pth`、`control_v11f1p_sd15_depth.pth`），请替换为你本地 `ComfyUI/models/` 下已有的对应模型
- 加载工作流后，先打开导演台点击「✅ 应用」导出控制图，再 Queue 出图

## FAQ

**Q: 出图姿势没变 / 控制图没更新？**
A: 重新打开导演台，确认姿势已调整，再次点击「✅ 应用」导出。manifest 哈希变化后缓存会自动破掉。

**Q: 姿势库列表为空？**
A: 确认 `/director_stage/poses/index.json` 可访问（检查 ComfyUI 日志中姿势库路由是否挂载成功）；确认 `assets/poses/` 目录下有对应的姿势 JSON 文件。

**Q: `input/director_stage/` 里有很多旧图？**
A: 插件启动时会自动删除修改时间超过 7 天的 PNG 控制图，每次重启都会清理一遍。如需提前清理可手动删除该目录内容。

**Q: 重启后场景还能恢复吗？**
A: 可以。场景数据（scene_gz）随 workflow JSON 一起保存，重新打开工作流后再点「🎬 打开导演台」即可继续编辑。

## 许可

MIT
