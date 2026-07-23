# 3D导演台 P1-P3 实施计划

> 日期：2026-07-23
> 当前基线：P0 稳定性修复已完成；2D Canvas 兜底可用；多角色/道具/场景持久化/道具 2D 拖拽已验证。
> 路线：P1 WebGL 双模渲染回归 → P2 WASD 掌镜 + 轨迹点 + 时间轴 → P3 动作库 + 序列帧导出接 WanVideo。

---

## 当前已完成基线

- 2D Canvas 兜底编辑器可启动、可拖拽、可转视角。
- 多角色：添加/激活/拖动/上限验证通过。
- 道具：2D 投影显示、地面 X/Z 拖拽、Alt 升降、旋转/缩放验证通过。
- 场景持久化：`scene_gz + scene_json` 可恢复角色/机位/道具/设置。
- 回归测试：`smoke-2d`、`multi-char-verify`、`prop-restore-verify`、`prop-drag-verify`。

---

# P1 — WebGL 双模渲染回归

> **状态：P1-A/P1-B 已完成（2026-07-23）**
> - `auto / webgl / canvas2d` 三档模式管理器已实现，支持 `?force2d=1` 强制兜底。
> - WebGL 主视口与导出 renderer 物理分离；2D canvas 作为透明交互层，现有拾取/拖拽/orbit 不变。
> - 顶栏新增渲染模式指示/切换按钮；context lost / 渲染异常自动回退 2D。
> - 新增 `webgl-mode-verify` / `fallback-mode-verify`，默认 WebGL 与强制 2D 均通过。
> - 架构审核报告：`docs/P1-WEBGL-REVIEW.md`。

## 目标

利用 RTX 5090，把编辑器视口从“只有 2D 投影”升级为：

1. **WebGL 模式**：真实显示角色模型、GLB/VRM、道具、灯光、地面、网格。
2. **2D 兜底模式**：WebGL 不可用时继续用现有 Canvas 2D，不黑屏。
3. 两种模式共用同一套场景数据、拾取、拖拽、序列化和导出逻辑。

## 拆分任务

### P1-A 渲染模式管理器

- 新增 `render-mode.js` 或在 `scene.js` 中统一管理：
  - `auto / webgl / canvas2d` 三档。
  - 默认 `auto`：检测 WebGL2 + 创建测试 renderer 成功则进入 WebGL。
  - WebGL 初始化失败、首帧异常、GPU context lost 时自动回退 2D。
- UI 增加渲染模式指示与手动切换入口。

### P1-B WebGL 视口挂载

- WebGLRenderer 挂到同一个 `#viewport`。
- 复用现有 scene/camera/orbit。
- 与导出用的懒加载 renderer 分离或安全共享，避免导出 resize 影响编辑视口。
- 处理 DPR、视口 resize、画幅信箱/安全框。

### P1-C 交互一致性

- WebGL 模式下恢复真实 TransformControls 或继续使用当前 2D 屏幕拖拽。
- 保证以下行为与 2D 模式一致：
  - 角色关节屏幕拾取
  - 道具点选/拖拽 X/Z、Alt=Y
  - orbit 空白拖动
  - 多机位切换
- 3D gizmo 可见性和导出前隐藏规则统一。

### P1-D 视觉内容补齐

- WebGL 下显示：
  - 内置角色骨架/模型
  - GLB/VRM 角色
  - 道具与导入模型
  - 地面/网格/坐标轴/灯光
- 2D 模式保持现有轻量显示，不再追求完整材质。

### P1-E 性能与回归

- 增加性能档位：质量优先 / 平衡 / 兜底。
- 记录 FPS、DPR、draw calls（可先用简单 HUD）。
- 新增测试：
  - `webgl-mode-verify.mjs`：WebGL 模式非黑屏、场景对象可见。
  - `fallback-mode-verify.mjs`：强制禁用 WebGL 后 2D 可用。
  - 既有全部回归必须通过。

## 验收标准

- RTX 5090 环境默认进入 WebGL，不再黑屏。
- 道具/角色/GLB/VRM 在主视口真实可见。
- 强制禁用 WebGL 后仍可编辑并导出 openpose。
- 现有测试 100% 通过，新增 WebGL 与 fallback 测试通过。

---

# P1.5 — 多 3D角色管理器

> **状态：P1.5 + P1.5b 已完成（2026-07-23）**
> - 新增 `ExternalCharacterManager`，统一接管 GLB/VRM 外部角色，上限 8 个。
> - 每个 3D角色独立 model / skeleton / jointMap / IK target / IK group，自动错位出生。
> - 顶栏新增「➕添加GLB」；「3D角色」保留火柴人 ↔ 外部角色显示切换。
> - 点任意 3D角色的 IK 球自动激活该角色；拖第二个角色不会影响第一个。
> - `scene_json` 保存并恢复 externalCharacters / activeExternalCharacterId。
> - P1.5b 新增外部角色面板：列表、激活、显示/隐藏、重命名、删除、数量上限徽标。
> - P1.5b 新增外部骨架导出：多 GLB openpose 同图输出、逐外部角色 mask，depth/normal 继续走 scene WebGL。
> - P1.5b 性能/资源优化：IK 求解改为活动角色每帧 + 非活动按需；删除角色时释放 geometry/material/texture/skeleton/VRM runtime。
> - 新增回归：`glb-multi-character-verify` 21/21、`glb-multi-export-verify` 16/16、`external-char-panel-verify` 13/13、`external-dispose-verify` 22/22。
> - 架构/性能审查：`docs/P15-MULTI-3D-CHARACTER-REVIEW.md`、`docs/P15B-MULTI-3D-OPTIMIZATION-REVIEW.md`。
> - 边界：多 VRM UI 仍未开放；外部角色 undo、VRM 头部关键点精确偏移、sceneJSON 版本号统一升级留待后续。

---

# P2 — WASD 掌镜 + 轨迹点 + 时间轴

## 目标

把“多机位列表”升级成“可走的镜头路线”：

1. 导演视角支持 WASD。
2. 掌镜模式像 FPS 一样移动相机。
3. `Enter` 连续记录镜头轨迹点。
4. 底部时间轴播放、暂停、拖动预览镜头运动。
5. 轨迹数据进入 `scene_json`，重开可恢复。

## 拆分任务

### P2-A 普通导演视角 WASD

- 空白视口聚焦时：
  - `W/S` 前后移动
  - `A/D` 左右移动
  - `Q/E` 下降/上升
  - Shift 加速，Ctrl 减速
- 不干扰文本输入、快捷键和现有 orbit。

### P2-B 掌镜模式

- 新增「开始掌镜」模式：
  - Pointer Lock 鼠标转向。
  - WASD/QE 移动。
  - 滚轮调整 FOV。
  - `Esc` 退出。
  - `Enter` 保存/更新轨迹点。
  - `Space` 播放/暂停。
- 屏幕中心准星与当前速度/焦距 HUD。

### P2-C 镜头轨迹点数据模型

- 新数据结构：
  - `cameraRoutes: [{ id, name, points, duration, easing, smooth }]`
  - point：`pos / target / fov / focalMM / holdSeconds / trackingTarget`
- 纳入 `scene_json` 和工程导入导出。
- 兼容旧多机位：现有多相机可转换为单点轨迹。

### P2-D 轨迹编辑 UI

- 轨迹点列表：添加、插入、删除、排序、跳转。
- 视口显示轨迹线与编号点。
- 支持平滑/折线、匀速/柔和。
- 每个点可单独改位置、朝向、焦距。

### P2-E 底部统一时间轴 v1

- 底部新增时间轴：
  - 播放/暂停
  - 当前时间
  - 总时长
  - 拖动定位
- 镜头轨显示移动段、停留段、轨迹点编号。
- 播放时实时采样镜头位置/朝向/FOV。

### P2-F 验收测试

- `pilot-wasd-verify.mjs`：WASD/QE 相机位移正确。
- `camera-route-verify.mjs`：记录 3 个点，播放采样位置连续且经过关键点附近。
- `scene-route-restore-verify.mjs`：重开后轨迹和时间轴恢复。
- 既有全部回归通过。

## 验收标准

- 可以不看代码完成：开始掌镜 → 走镜头 → Enter 记录 3+ 点 → 退出 → 播放路线。
- 时间轴拖动不会跳回起点，暂停状态明确。
- 重开导演台后镜头路线仍在。

---

# P3-0 — 默认 3D角色 + 骨骼显示 + 动作预设

> **状态：已完成（2026-07-23）**
> - 火柴人退居兼容层：启动后默认自动加载 UE GLB 3D角色并进入外部角色模式；火柴人仍可显式切回。
> - 新增骨骼显示：WebGL 使用 `THREE.SkeletonHelper`，Canvas2D 使用骨骼投影连线；顶栏和 3D角色面板均有开关，默认开。
> - 新增 `action-presets.js`：stand / sit / crouch / lie / punch / idle / walk / run / wave / jump，共 10 个预设。
> - 新增 `action-runtime.js`：每个 3D角色独立播放/暂停/恢复/停止、loop/speed/intensity、动作切换混合、oneshot 自动回站立。
> - 3D角色面板新增动作栏：动作下拉、快捷按钮、播放/暂停、恢复站立、速度/强度滑杆。
> - `sceneJSON.externalCharacters[].action` 保存动作 id/time/playing/speed/intensity，reload/init 后恢复。
> - 新增 `external-action-presets-verify` 20/20；旧 GLB/面板/导出测试已更新为默认 3D角色契约并全部通过。
> - 架构审查：`docs/P30-3D-ACTION-PRESET-REVIEW.md`。
> - 边界：当前骨骼显示 WebGL 用 SkeletonHelper（后续可换自定义骨骼线）；VRM 动作/多 VRM/Mixamo clip/VRMA 留到后续。

---

# P3-1 — 3D-only：删除火柴人工作流

> **状态：已完成（2026-07-23）**
> - 用户明确要求“删除火柴人的部分，只保留3D角色”。当前用户工作流已改为 3D-only：默认/始终使用 ExternalCharacterManager 的 GLB/VRM 角色。
> - 火柴人用户路径已移除：角色列表、姿势库、3D角色切换按钮、FK/骨长/整人移动等火柴人专属 UI 不再可见；`setCharacterMode("stick")` 被拒绝。
> - 火柴人底层暂时仅作为旧工程/旧测试兼容数据保留，永久隐藏、不可交互、不参与导出；后续可做物理清理。
> - 新增 `external-character-move.js`：点 3D角色身体拖整人，默认地面 X/Z，Alt+拖=Y 升降；model、IK target/pole、SkeletonHelper、openpose/mask 数据源同步移动。
> - 添加入口强化：顶栏「➕添加GLB（3D角色）」+ 3D角色面板内 ➕，连续添加自动错位并激活新角色。
> - 导出 3D-only：openpose/mask/depth 只包含外部角色，不回退火柴人，火柴人残留防御性隐藏。
> - 新增/更新测试：`3d-only-workflow-verify` 30/30；glb-character 9/9；glb-multi-character 22/22；glb-multi-export 18/18；external-action-presets 20/20；external-char-panel 14/14；external-dispose 22/22。
> - 迁移审查：`docs/P31-3D-ONLY-MIGRATION-REVIEW.md`。
> - 边界：sceneJSON/sceneGz 版本统一、外部角色 undo、物理删除 figure.js/DS_FigureAPI 留待后续缓冲期。

---

# P3 — 动作库 + 序列帧导出接 WanVideo

## 目标

让角色/道具沿时间轴动起来，并批量输出视频工作流可用的控制图序列：

1. 内置基础动作库。
2. 角色/道具支持时间轴关键帧或路线运动。
3. 多通道逐帧渲染。
4. 输出 IMAGE batch / 文件序列，对接 WanVideo / AnimateDiff 类工作流。

## 拆分任务

### P3-A 动作运行时

- 新增 `action-runtime.js`：
  - 动作定义、采样、循环、暂停、时间缩放。
  - 所有视图/导出共用同一采样结果。
- 内置动作 v1：
  - 站立、行走、跑步、挥手、坐下、跳跃。
- 动作可先基于现有火柴人骨架，后续再接 VRM/Mixamo。

### P3-B 角色/道具时间轴关键帧

- 角色：
  - 根位置/朝向关键帧
  - 姿势关键帧
  - 动作片段
- 道具：
  - 位置/旋转/缩放关键帧
- 与 P2 时间轴共用当前时间和总时长。

### P3-C 角色路线运动

- 角色路线点：添加、插入、删除、拖动。
- 每段可选动作：行走/跑步/挥手/站立。
- 支持停留点与停留秒数。
- 与镜头轨在同一时间轴显示。

### P3-D 序列帧导出

- 导出参数：
  - FPS：12 / 24 / 30
  - 时长：跟随时间轴
  - 通道：openpose / depth / normal / lineart / mask / preview
  - 相机：当前镜头路线或选定机位
- 逐帧采样 → 离屏渲染 → 上传 PNG 序列。
- manifest 增加 `sequence` 结构。

### P3-E Python 序列节点

- 新增或扩展节点：
  - `DirectorStageSequence`
  - 输出 `IMAGE batch`、`MASK batch`、`camera_json sequence`
- 文件缺失时空帧兜底，不炸队列。

### P3-F WanVideo 对接

- 示例工作流：多帧 openpose/depth → WanVideo 控制输入。
- 文档说明推荐参数与目录结构。
- 必要时提供 JSON 元数据：fps、frame_count、相机轨迹、每帧相机参数。

## 验收标准

- 角色行走 + 镜头移动可同步播放。
- 导出 1 秒 24fps 序列，得到 24 张 openpose 与对应通道图。
- ComfyUI 序列节点能输出 IMAGE batch。
- 示例 WanVideo 工作流能读取序列并运行到生成阶段。
- 既有全部回归通过。

---

# 推荐执行顺序与并发方式

## 阶段顺序

1. **先做 P1**：没有稳定 WebGL，后续掌镜/动作/序列导出都会继续被黑屏风险拖住。
2. **再做 P2**：先建立统一时间轴和镜头路线数据模型。
3. **最后做 P3**：复用 P2 时间轴，把角色/道具运动和序列导出接上。

## 每个阶段默认多 Agent 并发

### P1 建议 3 路

- A：WebGL renderer / 模式管理 / fallback
- B：交互一致性与道具/角色拾取
- C：性能、测试、截图验收

### P2 建议 3 路

- A：WASD + Pointer Lock 掌镜控制
- B：轨迹点数据模型 + 路线 UI
- C：时间轴 + 序列化 + 回归测试

### P3 建议 3 路

- A：动作运行时 + 内置动作库
- B：角色/道具关键帧 + 路线运动
- C：序列导出 + Python batch 节点 + WanVideo 示例

---

# 主要风险与控制

| 风险 | 控制 |
|---|---|
| WebGL 回归再次黑屏 | 保留 2D 兜底；首帧检测失败自动回退；每次改动跑 fallback 测试 |
| P2/P3 数据模型反复返工 | 先冻结 `cameraRoutes/timeline/actionClips` schema，再写 UI |
| 时间轴不同视图姿势不一致 | 所有播放/拖动/导出共用一个 runtime sampler |
| 序列导出太慢 | 离屏渲染、可关通道、先 512px 冒烟，再全尺寸导出 |
| WanVideo 输入格式不确定 | 先输出通用 PNG 序列 + IMAGE batch，再做专用适配层 |

---

# 建议立即开工的第一个小目标

**P1-A/P1-B：WebGL 双模渲染管理器 + 主视口挂载**

原因：这是后续所有高级功能的地基，也能立刻利用 RTX 5090。

完成判定：

- 默认进入 WebGL，主视口看到真实场景。
- 强制 fallback 后 2D 仍可操作。
- 现有回归全部通过。
