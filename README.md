# 🎬 ComfyUI 3D导演台（comfyui-director-stage）

在 ComfyUI 里内嵌一个 3D「导演台」：摆人偶姿势、搭场景、调机位，一键导出 OpenPose / Depth 等控制图，直接接 ControlNet 出图。开源、本地运行、不绑定任何生成服务。

## 功能

### M0（通路验证）
- ✅ `🎬 3D导演台` 节点：输出 `openpose` / `depth` 两路 IMAGE tensor
- ✅ 前端编辑器以 iframe 方式打开，导出 PNG 上传至 `input/director_stage/`，文件清单写回节点 manifest
- ✅ manifest 哈希参与缓存判定（场景没动就命中缓存）；文件缺失时输出空白图并打印警告，不中断队列

### M1
- ✅ 3D 摆姿器：拖拽关节旋转人偶，手部含完整 21 点指骨
- ✅ 子树联动：旋转躯干时手臂自动跟随（FK 链）
- ✅ 骨长锁定：关节旋转不改变骨骼原始长度
- ✅ undo / redo：完整编辑历史栈，Ctrl+Z 随时回退
- ✅ 焦距与构图安全框：35mm 等效焦距调节 + 三分/中心辅助线
- ✅ 姿势库：`/director_stage/poses/` 路由提供 10 组预置姿势，编辑器内一键加载
- ✅ 双通道导出：openpose + depth 同时渲染，分别走独立 ControlNet 串联出图
- ✅ 启动自动清理：`input/director_stage/` 下超过 7 天的旧控制图自动删除

### M2（本版新增）
- ✅ DirectorStage 输出升级为 6 通道：`openpose` / `depth` / `normal` / `lineart` / `char_masks` / `camera_json`
- ✅ M2 manifest 格式：`cameras[]` 数组 + `masks[]` 角色分区，向后兼容 M1 格式（`files` 顶层级）
- ✅ `char_masks` 输出：[N, 1, H, W] MASK batch，每个角色 mask 灰度图堆叠，可直连 RegionalPrompt / AttentionCouple 等分区提示节点
- ✅ `camera_json` 输出：当前机位的 `{pos, target, focalMM}` JSON 字符串，可用于动态构图参数传递
- ✅ 新增 `🎬 3D导演台·单机位`（DirectorStageShot）：从 manifest 中读取指定 `camera_index` 的机位控制图
- ✅ 多机位并联出图：一个场景配 N 个 DirectorStageShot 节点，每个独立走 ControlNet+KSampler，实现一次模板 N 张分镜
- ✅ 角色 mask 区域提示：char_masks → RegionalPrompt 链式串联，不同角色区域注入独立提示词
- ✅ 示例工作流：`multi_camera_storyboard.json`（3机位分镜）、`character_mask_regional.json`（角色分区出图）

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
| `multi_camera_storyboard.json` | **M2 多机位分镜**：1个DirectorStage(3机位场景)+3个DirectorStageShot(camera_index 0/1/2)→3路OpenPose CN→3张不同构图 |
| `character_mask_regional.json` | **M2 角色分区出图**：DirectorStage的openpose+char_masks→OpenPose CN+RegionalPrompt按mask分区提示→双角色场景 |

**使用前请注意**：
- 工作流中的模型文件名为**占位符**（`v1-5-pruned-emaonly.safetensors`、`control_v11p_sd15_openpose.pth`、`sd_xl_base_1.0.safetensors`、`control-l-openpose-sdxl.safetensors` 等），请替换为你本地 `ComfyUI/models/` 下已有的对应模型
- `character_mask_regional.json` 需要安装 rgthree 或 comfyui_controlnet_aux 插件以使用 RegionalPrompt 节点
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

**Q: M2 格式的 manifest 和 M1 有什么区别？**
A: M2（`version: 2`）使用 `cameras[]` 数组，每个相机包含 `files`（多通道控制图）+ `masks`（角色分区遮罩）+ `pos/target/focalMM` 相机参数。M1 格式（`files` 在顶层级）仍然兼容，但新通道（normal/lineart/char_masks/camera_json）会输出空白值。

**Q: 多机位分镜怎么用？**
A: 参考 `examples/multi_camera_storyboard.json`：先创建 DirectorStage 节点配好 3 机位场景，再用 3 个 DirectorStageShot 节点（camera_index=0/1/2）分别接 ControlNet+KSampler 并联出图。

**Q: 角色分区提示怎么用？**
A: 参考 `examples/character_mask_regional.json`：DirectorStage 的 `char_masks` 输出连到 RegionalPrompt 节点的 `region_mask`，配合各角色的独立提示词，实现不同区域不同描述。需要安装 rgthree 或 comfyui_controlnet_aux 插件。

## M3 姿势提取节点：依赖说明（已知事项）

`ExtractPoseFromImage` / `PoseDataToJoints` 依赖 DWPose，按以下顺序探测：

1. pip 版 `controlnet_aux`（优先）
2. ComfyUI 自定义节点 `comfyui_controlnet_aux` 的 vendored 版本（兜底）

使用 vendored 版本时请注意（上游包的行为，非本插件 bug）：

- `comfyui_controlnet_aux` 的 `__init__.py` 顶层会修改全局环境变量（如 `NPU_DEVICE_COUNT`、`MMCV_WITH_OPS`）并执行全量 `load_nodes()`。正常场景下该包已随 ComfyUI 启动加载、`sys.modules` 命中无额外成本；但若它装在非标准目录名，本插件的延迟导入未命中缓存时会触发第二次完整初始化。
- vendored 版 `DwposeDetector.from_pretrained` 存在上游 bug（pose 分支把 session 对象赋给文件名字段，导致版本判断永不相等）：若 `comfyui_controlnet_aux` 自带的 DWPose 节点与本插件共用全局 Wholebody 缓存且 det/pose 文件名不同，两侧会互相重建模型（秒级卡顿）。本插件检测器为单例、只调用一次 `from_pretrained`，实际影响有限。
- 检测器加载有重试上限（连续 3 次瞬时失败）+ 冷却（300 秒）机制；依赖缺失时节点永久降级输出默认 T-pose（`is_default=True`），不会中断队列。

## 许可

MIT
