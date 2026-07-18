# 🎬 ComfyUI 3D导演台（comfyui-director-stage）

在 ComfyUI 里内嵌一个 3D「导演台」：摆人偶姿势、搭场景、调机位，一键导出
OpenPose / Depth 等控制图，直接接 ControlNet 出图。开源、本地运行、不绑定任何生成服务。

## 当前状态：M0（通路验证版）

- ✅ `🎬 3D导演台` 节点：输出 `openpose` / `depth` 两路 IMAGE
- ✅ 前端编辑器以 iframe 方式打开，导出 PNG 上传至 `input/director_stage/`，文件清单写回节点 manifest
- ✅ manifest 哈希参与缓存判定（场景没动就命中缓存）；文件缺失时输出空白图并打印警告，不会中断队列
- ⏳ 更多通道（normal / lineart / 逐角色 mask）、多角色、IK、多机位等见 `docs/DESIGN.md` 路线图

## 安装

1. 把本仓库放入 `ComfyUI/custom_nodes/comfyui-director-stage`
2. 重启 ComfyUI

无额外 Python 依赖（仅用 ComfyUI 自带的 torch / numpy / PIL）。

## 使用

1. 在画布中添加节点：`🎬DirectorStage → 🎬 3D导演台`
2. 点击节点上的「🎬 打开导演台」按钮，在弹出的编辑器里摆姿势 / 调整机位
3. 点「✅ 应用」：编辑器渲染并上传控制图，自动写回节点
4. 把 `openpose` / `depth` 输出接到对应的 ControlNet（建议 openpose 强度 0.9~1.0，depth 0.4~0.7），Queue 出图

> 提示：`width` / `height` 建议与出图分辨率一致；场景数据会随 workflow 保存，重新打开可继续编辑。

## 许可

MIT
