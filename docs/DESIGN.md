# ComfyUI「3D导演台」插件设计方案 v0.1

> 定位：把"万兴剧厂3D导演台"的体验（摆积木搭场景、调度演员机位、精调姿势、实时预览构图）做成开源 ComfyUI 原生插件，输出多通道控制图（OpenPose/Depth/Normal/Lineart/角色Mask/相机参数），直接喂给 ControlNet / 视频工作流。
> 创建：2026-07-19 · 状态：方案定稿待评审

---

## 1. 背景与差异化定位

| 维度 | 万兴剧厂 3D导演台 | 本插件 |
|---|---|---|
| 形态 | 闭环 SaaS 影视工具 | 开源 ComfyUI 自定义节点 |
| 模型 | 绑定自家生成服务 | 接任意本地/云模型工作流 |
| 输出 | 成片 | 多通道控制图，可组合 |
| 扩展 | 无 | VRM角色、GLB道具、姿势库、API |
| 杀手锏 | 一体化体验 | 逐角色Mask+分区提示词、多机位批量出故事板 |

核心用户故事：
1. 单图控姿势：摆一个人偶 → openpose+depth → ControlNet 出图
2. 多人构图：3个角色+道具 → 逐角色 mask → 分区提示词，解决多人污染
3. 故事板：一个场景多机位 → 批量输出每个镜头的控制图组
4. 视频（V2）：时间轴关键帧 → 姿势序列 → AnimateDiff/Wan

## 2. 生态调研（要抄的作业）
- sd-webui-3d-open-pose-editor（MIT）：3D人偶→openpose/depth/normal/canny 四通道，验证了品类可行；老、单人为主、无场景/多机位/mask
- huchenlei/ComfyUI-openpose-editor：iframe 嵌编辑器 + /upload/image 回写节点的集成模式（我们直接复用此模式）
- Fannovel16/comfyui_controlnet_aux：draw_bodypose/手部绘制的标准调色板与线宽（渲染规范以它为准）
- PoseMy.Art / Magic Poser：交互 UX 参考（拖拽、pose库、多人）
- three-vrm（pixiv, MIT）：VRM 加载与 humanoid 骨骼标准
- ComfyUI-3D-Pack：Comfy 内 3D 数据流参考

## 3. 功能规格（P0=MVP / P1=V1 / P2=V2+）

**场景系统**
- P0 地面网格、世界坐标轴、背景色
- P1 图元积木（盒/柱/球/板，可缩放当桌椅墙）、CC0低模道具库（Kenney/Quaternius）、GLB/OBJ 导入、吸附网格/落地、群组/复制/镜像
- P2 场景模板库（教室/街道/室内）

**角色与姿势**
- P0 内置低模人偶（含完整手指骨）、FK 关节旋转（gizmo）、根位移/旋转/整体缩放、身高调节
- P1 多角色、四肢 IK（腕/踝目标+极向量）+脚钉地、姿势库（预置+用户保存 JSON）、姿势镜像、从另一角色复制姿势、体型参数（男/女/儿童比例）
- P1.5 VRM 模型导入（three-vrm，humanoid 骨骼自动映射）
- P2 图片提取姿势（DWPose 2D → 3D 拟合）、表情/手势预设库
- P3 文本摆姿（LLM 输出关节角 JSON）、物理辅助（重心/碰撞）

**相机**
- P0 单相机：轨道控制 + 焦距(mm)、画幅联动节点 width/height、构图辅助线（三分/中心）
- P1 多相机（镜头列表/书签）、相机间一键切换、每相机独立焦距、安全框
- P2 相机参数 JSON 输出（内外参，供 Wan camera/Uni3C 等镜头控制）、简单相机动画

**灯光**
- P0 默认三点光（仅预览用）
- P1 可调主光方向 → 输出"光影参考pass"（灰模渲染，给 IPAdapter/重绘参考）

**输出通道（每相机 × 每通道）**
- P0 OpenPose（body18+双手21×2，controlnet_aux 标准配色）、Depth（近白远黑，MiDaS 风格相对深度）
- P1 Normal（view-space，对齐 normalbae 约定）、Lineart（深度+法线不连续边缘，白底黑线）、逐角色 Mask（solo 渲染白底黑）、灰模预览图
- P2 姿势序列批量（IMAGE batch）、语义分割色块图（ADE20K 色板，喂 seg ControlNet）

**编辑器基础**
- P0 undo/redo、场景序列化进 workflow（gzip+base64）、中/英 UI、快捷键（W/E/R gizmo 切换等）
- P1 自动保存草稿、暗色主题跟随 ComfyUI

## 4. 总体架构

```
┌───────────────────────────── 浏览器 ─────────────────────────────┐
│  ComfyUI 前端                                                    │
│  ├─ web/js/directorStage.js (扩展宿主)                            │
│  │   · 给节点加「🎬 打开导演台」按钮 + hidden widgets              │
│  │   · 全屏 Modal + <iframe src=web/editor/index.html>           │
│  │   · postMessage 双向协议                                       │
│  └─ web/editor/  (Vite+TS+three.js 独立SPA，构建产物)             │
│      · SceneManager / RigSystem(FK+IK) / PassRenderer             │
│      · 导出时直接 POST /upload/image (同源)                        │
└──────────────────────────────────────────────────────────────────┘
                              │ manifest(文件名清单)+scene_gz 写回 widget
┌──────────────────────────── ComfyUI 后端 ────────────────────────┐
│  nodes.py: DirectorStage / DirectorStageShot / (V2)Sequence      │
│  · 读 manifest → input/director_stage/*.png → IMAGE/MASK tensor  │
│  · IS_CHANGED = sha256(manifest)                                 │
│  server_ext.py: 资产列表路由；(V2) headless 渲染                   │
└──────────────────────────────────────────────────────────────────┘
```

技术选型：Three.js r170+（生态最大、CCDIKSolver/TransformControls 现成）、TypeScript+Vite、pako(gzip)、three-vrm(P1.5)。Python 侧 MVP 零重依赖（PIL/numpy/torch 均现成）。iframe 隔离的理由：不受 ComfyUI 新旧前端（Vue 重构）API 变动影响，编辑器可独立开发调试。

## 5. postMessage 协议

| 方向 | type | payload |
|---|---|---|
| host→editor | init | {sceneGz, width, height, theme, locale} |
| host→editor | requestExport | {passes[], cameraIds[], width, height} |
| editor→host | ready | {version} |
| editor→host | dirty | {} （防抖5s） |
| editor→host | exportDone | {manifest, sceneGz, cameraJson} |
| editor→host | error | {message} |

manifest 示例：
```json
{"camera":"cam_main","files":{"openpose":"director_stage/s01_cam1_pose.png","depth":"...","normal":"...","lineart":"..."},
 "masks":[{"charId":"char_01","name":"女主","file":"director_stage/s01_cam1_m1.png"}],
 "hash":"sha256:...","width":1024,"height":1536}
```

## 6. 骨骼规范与 OpenPose 映射（核心表）

人偶用类 VRM humanoid 命名。COCO-18 映射：

| OpenPose idx | 关键点 | 取自骨骼(世界坐标) |
|---|---|---|
| 0 | Nose | head + 鼻端 locator |
| 1 | Neck | neck |
| 2/5 | R/L Shoulder | upperArm 关节点 |
| 3/6 | R/L Elbow | lowerArm |
| 4/7 | R/L Wrist | hand |
| 8/11 | R/L Hip | upperLeg |
| 9/12 | R/L Knee | lowerLeg |
| 10/13 | R/L Ankle | foot |
| 14/15 | R/L Eye | head + 眼 locator |
| 16/17 | R/L Ear | head + 耳 locator |

- 手部 21 点/手：wrist + 5指×(MCP/PIP/DIP/TIP)，人偶必须含手指骨（这是多数竞品做不好手的根因）
- 投影：joint.getWorldPosition() → Vector3.project(camera) → 像素坐标；画法（圆半径、肢体椭圆宽、17段肢体调色板）逐像素对齐 controlnet_aux.draw_bodypose
- 脸 70 点：P2 再做（人偶脸意义有限）

## 7. 各渲染通道实现

| 通道 | three.js 实现 | 校准标准 |
|---|---|---|
| preview | MeshToonMaterial + 三点光 | 目视 |
| openpose | 2D canvas 按映射表绘制（不走3D渲染） | 与 controlnet_aux 输出像素级对齐 |
| depth | overrideMaterial=自定义Shader输出线性视深 → RenderTarget readback → 按场景包围盒归一化、取反（近白远黑） | 与 Depth-Anything 对同图输出直方图对比 |
| normal | overrideMaterial=MeshNormalMaterial(view-space, n*0.5+0.5) | 与 normalbae 预处理输出 A/B，必要时翻 X |
| lineart | depth+normal 两张 RT → Sobel 后处理找不连续边 → 白底黑线 | 目视+lineart CN 实测 |
| mask | 每角色 solo 渲染（MeshBasicMaterial 纯白、无灯、关抗锯齿）N 次 → N 张二值图 | 与 preview 轮廓重合 |

导出统一走离屏 WebGLRenderTarget，按节点 width/height 渲染（预览视口另算），PNG blob → /upload/image(subfolder=director_stage)。

## 8. 场景 JSON Schema（v1，gzip+b64 存 hidden widget）

```json
{"version":1,
 "render":{"width":1024,"height":1536,"passes":["openpose","depth","mask"]},
 "characters":[{"id":"char_01","name":"女主","rig":"builtin_mannequin_v1",
   "root":{"pos":[0,0,0],"rot":[0,0,0,1],"scale":1.0},
   "morph":{"height":1.68,"preset":"female_a"},
   "pose":{"hips":[0,0,0,1],"spine":[...],"leftUpperArm":[...]},
   "ik":{"leftFoot":{"on":true,"target":[0.1,0,0.2],"pole":[0,0.5,1]}},
   "visible":true}],
 "props":[{"id":"p1","kind":"primitive:box","size":[1,0.8,0.6],"transform":{...}},
          {"id":"p2","kind":"asset:sofa01","transform":{...}},
          {"id":"p3","kind":"import:glb","src":"upload_ab12.glb","transform":{...}}],
 "cameras":[{"id":"cam_main","name":"主镜头","pos":[...],"rot":[...],"focalMM":35,"active":true},
            {"id":"cam_02","name":"特写","focalMM":85}],
 "lights":[{"kind":"dir","dir":[-1,-1,-0.5],"intensity":1}],
 "env":{"grid":true,"bg":"#7f7f7f"}}
```
兼容策略：version 字段 + 迁移函数链；骨骼字典允许缺省（缺省=绑定姿势）。

## 9. ComfyUI 节点设计

**DirectorStage（主节点）**
- required：width/height(INT)、camera(下拉，由前端同步)
- hidden widgets：scene_gz(STRING)、manifest(STRING)
- RETURN：openpose(IMAGE)、depth(IMAGE)、normal(IMAGE)、lineart(IMAGE)、char_masks(MASK batch)、camera_json(STRING)
- IS_CHANGED：sha256(manifest)（内含内容hash，场景没动就命中缓存）

```python
class DirectorStage:
    FUNCTION="render"; CATEGORY="DirectorStage"
    RETURN_TYPES=("IMAGE","IMAGE","IMAGE","IMAGE","MASK","STRING")
    RETURN_NAMES=("openpose","depth","normal","lineart","char_masks","camera_json")
    def render(self, width, height, camera, scene_gz="", manifest="{}"):
        m=json.loads(manifest); f=m.get("files",{})
        img=lambda k: load_png_tensor(f[k]) if k in f else blank(width,height)
        masks=stack_masks([x["file"] for x in m.get("masks",[])], width, height)
        return (img("openpose"),img("depth"),img("normal"),img("lineart"),masks,json.dumps(m.get("cameraJson",{})))
```

**DirectorStageShot（P1）**：输入同一 scene_gz，选不同相机 → 一个场景多镜头并联出图
**DirectorStageSequence（P2）**：输出各通道 IMAGE batch（帧序列）
**兜底**：manifest 缺文件时输出空图并 warning，不炸队列

## 10. 端到端时序

1. 加节点 → 点「🎬 打开导演台」→ Modal+iframe
2. editor ready → host 发 init(scene_gz)
3. 编辑（undo栈；防抖 dirty）
4. 点「✅ 应用」→ 逐相机逐通道离屏渲染 → 上传 PNG → exportDone(manifest+scene_gz)
5. host 写回 widget、关 Modal（workflow 保存时场景随之持久化，重开可还原）
6. Queue → Python 读文件出 tensor → ControlNet
7. 改场景重复 4-6，manifest hash 变化自动破缓存

## 11. 与工作流的适配建议（写进文档和示例）
- openpose → CN-openpose，strength 0.9-1.0；depth → CN-depth 0.4-0.7 与 pose 组合（给身体厚度和前后关系）
- lineart 低权重(0.3)锁构图；normal 用于打光重绘场景
- char_masks → Regional/Attention Couple 分区提示、或逐角色 inpaint 精修
- SDXL/Flux/Qwen-Image/绘世各家 ControlNet 均吃标准 openpose/depth 图，天然通用
- 示例工作流至少 4 个：单人基础 / 三人分区 / 多机位故事板 / (V2)姿势序列转视频

## 12. 路线图与工作量（单人全职估）

| 里程碑 | 内容 | 工期 |
|---|---|---|
| M0 通路验证 | iframe+postMessage+upload 打通；硬编码人偶出 openpose→CN 出图 | 1周 |
| M1 MVP | 单人FK+根变换、相机+焦距、pose/depth、序列化还原、undo、示例流 | 3-4周 |
| M2 V1 | IK+脚钉地、多角色、积木/道具/GLB导入、normal/lineart/mask、多机位、姿势库/镜像 | 4-6周 |
| M3 V1.5 | VRM、图片提姿势(DWPose→3D拟合)、光影参考pass、camera_json | 3-4周 |
| M4 V2 | 时间轴关键帧、序列batch输出、headless服务端渲染(pyrender/moderngl)、纯API模式 | 4-6周 |
| M5 V3 | LLM文本摆姿、物理辅助、协作、资产市场 | 远期 |

## 13. 仓库结构

```
comfyui-director-stage/
├─ __init__.py            # MAPPINGS + WEB_DIRECTORY="web"
├─ nodes.py  server_ext.py  pyproject.toml
├─ web/js/directorStage.js       # 宿主扩展
├─ web/editor/                   # 编辑器构建产物
├─ editor-src/{core,rig,passes,ui,assets}/   # TS 源码
├─ assets/poses/*.json  examples/*.json  docs/
```

## 14. 测试与验收
- 单元：映射表投影 golden 数据；scene JSON 迁移
- 渲染基准：固定场景各通道输出与基准图 SSIM>0.99
- 校准：depth/normal 与预处理器输出 A/B 报告
- E2E：Playwright 摆姿→应用→queue→出图；workflow 重载场景还原
- 实测清单：SD1.5/SDXL/Flux 各 CN 出图肢体正确率人工评测（20 组姿势）
- 兼容：Chrome/Edge/Firefox；ComfyUI 新旧前端

## 15. 发布与合规
- 代码 MIT；人偶自建（Blender 制作含指骨低模）或确认 MIT/CC0 来源；道具用 Kenney/Quaternius CC0；**不使用任何万兴资产**
- 注册 Comfy Registry（comfy-cli publish）+ ComfyUI-Manager 收录 PR
- README 中英 + GIF 演示 + 示例工作流 json；B站/推特发布 demo

## 16. 风险与对策
| 风险 | 对策 |
|---|---|
| ComfyUI 前端重构导致 API 变动 | iframe 隔离；宿主 JS 仅用最稳定的按钮/widget API |
| workflow 体积膨胀 | 图片走 /upload/image 文件；场景 gzip；不内嵌 base64 图 |
| 手部 21 点映射精度 | 人偶强制含完整指骨；手部单独放大编辑视图 |
| depth/normal 与 CN 训练分布差异 | 校准 A/B + 提供 gamma/对比度微调参数 |
| 多人+高模性能 | 低模人偶、道具 LOD、导出离屏渲染与预览分离 |
| 2D→3D 姿势拟合深度歧义 | 关节角先验+肘膝弯曲方向约束；允许手动修正 |

## 17. 下一步
M0 脚手架：仓库初始化 → 空节点+按钮+iframe 通路 → 硬编码 T-pose 人偶 → openpose PNG 上传回写 → ControlNet 出图验证。
