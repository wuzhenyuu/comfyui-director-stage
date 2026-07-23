# P1 WebGL 双模渲染回归 — 架构审核报告

> **作者**：P1-C 架构审核员（subagent）
> **日期**：2026-07-23
> **任务边界**：只审核，不写核心代码；不修改任何 `src/` 或 `test/` 文件
> **范围**：`scene.js` / `main.js` / `controls.js` / `props.js` / `export.js` 当前未提交改动
> **参考基线**：`projects/3d-director-desk-ref/docs/PROJECT-HANDOFF.md` + `MILESTONE-07A~07D` + `MILESTONE-08B/C` + `MILESTONE-06A/B`

---

## 0. 现状速写（一句话）

导演台主视口目前 **完全用 Canvas 2D 兜底**（`scene.js` 把 `WebGLRenderer` 改成懒加载、`createRenderer()` 返回 2D canvas、所有拾取/拖拽走屏幕投影缓存）；`WebGLRenderer` **只在 `pass-renderer.js` 真正导出 depth/normal/lineart/preview/mask 通道时按需创建**。这个"视口 2D + 导出 3D"的分离架构是 P1 必须 **保留** 而不是推翻的。

---

## 1. 必坑清单（按踩坑代价排序）

### 坑 #1 · 导出 renderer 与视口 renderer 共享 → 灾难级（必修）

**现状证据**

- `scene.js` 的 `getRenderer()` 是**模块级单例**：第一个调用方决定了 `setSize(512, 768)` / `setPixelRatio(1)` / `antialias:false, preserveDrawingBuffer:true`，**之后所有调用方复用**。
- `export.js` 走 `getRenderer()` → 直接喂给 `renderDepthCanvas / renderNormalCanvas`，里面会做 `renderer.setRenderTarget(rt)` + `setRenderTarget(null)`，但**`renderer.setSize()` / `setViewport()` / `setPixelRatio()` 从不重置**。
- `pass-renderer.js` 内部用 `renderDepthCanvas` 时**改写了 `camera.near/far`** 然后才 `camera.updateProjectionMatrix()` —— 恢复靠 `prevNear/prevFar` 局部缓存，没问题。
- `main.js` 的 `_dsRef.renderDepthCanvas / renderNormalCanvas` 走的也是同一份 `getRenderer()`。

**P1 双模后会发生什么**

如果视口 renderer 与导出 renderer 合并（最自然的省内存写法），以下三个链式故障一定会踩到：

1. 视口用 `setPixelRatio(window.devicePixelRatio)` 提升清晰度 → 导出离屏渲染会**采样到 DPR 倍的真实像素**，上传到 ComfyUI 的图片变成 `exportW * DPR × exportH * DPR`，宽度对不上节点 width。
2. 视口 `setSize(viewportCSS_w, viewportCSS_h)` 信箱布局后 → 导出 readRenderTargetPixels 用的 `rt.width/height` 必须保持 `exportW/exportH`，但 `renderer.getDrawingBufferSize()` 已经被视口改写，**`rt = makeRT(w, h)` 创建的尺寸 ≠ `renderer.getSize()` → `readRenderTargetPixels` 越界或空白**。
3. 导出渲染前如果视口正在跑 RAF 循环，**两套相机 + 两份 `requestAnimationFrame` 同时持有同一个 scene** → 导出帧被中途打断 / 主视口被导出帧抢走，画面闪烁或撕裂。

**当前 2D 模式为什么没炸**：因为 `getRenderer()` 的调用方**只有 export.js 走 pass**；视口 2D canvas 完全不碰 renderer。P1 引入视口 WebGL 后这条单线变成双线，必爆。

**修复方向**（写到架构章节，不在这里动代码）

- **强约束**：视口 renderer 与导出 renderer **物理分离** —— 不同的 `HTMLCanvasElement`、不同的 `WebGLRenderer` 实例、不同的 `setSize`。可以通过 `scene.js` 暴露 `getViewportRenderer()` / `getExportRenderer()` 两个独立工厂。
- **次优**：单一 renderer 但视口与导出走**不同 scene 分支 + 不同 render target**，且 `setSize` / `setPixelRatio` 在每次导出前后严格恢复（用 `try/finally` 锁住，但 `pass-renderer.js` 当前没有这个保护）。

---

### 坑 #2 · 相机 aspect 不一致 → 高频回归（必修）

**现状证据**

- `main.js` 的 `setupProtocol` 回调：
  ```
  defaultCamera.aspect = w / h;
  defaultCamera.updateProjectionMatrix();
  cameraManager.updateAspect(w / h);
  ```
  —— 改了 `defaultCamera` 和 CameraManager 内部相机，但**没改 `defaultCamera.copy(ac.camera)` 同步过来的 active camera**。
- `cameras.js` 的 `initDefaultCamera` 创建的相机和 `defaultCamera` 是**两个对象**，由 `main.js` 在初始化时做 `cameras[0].camera = defaultCamera` 强行粘合（**典型的强一致靠手动复制**）。
- `main.js` 的 `syncActiveCamera()`：`orbit.object = ac.camera; ... defaultCamera.copy(ac.camera); propManager.camera = ac.camera;` —— 4 个对象必须永远同步，**任何一处漏写就是 bug**。

**P1 双模后会发生什么**

- WebGL 视口需要 `renderer.setSize(vw, vh)`（vw/vh 是信箱布局后的像素） → 信箱 ratio 与 `camera.aspect` 必须严格匹配，否则场景压扁/拉长。
- 切换机位时（Cntrl+1~9）当前会触发 `syncActiveCamera` + `applyViewport` + `__ds_layoutCanvas` 三件事，**任何两个不在同一个 RAF tick 里完成都会闪一帧变形**。
- 多角色/多道具的视口投影点（`scene.js` `drawFrame`）直接用 `cameraRef.project(...)`，aspect 错 → 火柴人/关节在视口里看着对、导出图里错位。

**修复方向**

- aspect 真值源（single source of truth）只保留在 `cameraManager`；`defaultCamera` 改成 getter 或在每次访问时强制 `defaultCamera.copy(ac.camera)`。
- `applyViewport()` 必须接 `(w, h) = viewportClientSize` 与 `(ew, eh) = exportSize` 两个参数，**别从模块作用域读**；现有 `ui.js` 的 `applyViewport(viewportElem)` 只接 viewportElem，aspect 用 `getExportWH()`，**视口 DOM 尺寸与导出尺寸的关系是隐式的**。
- 信箱布局算法（`scene.js` 的 `layoutCanvas2d`）目前算的是 2D canvas DOM 尺寸；WebGL 模式下 `renderer.setSize(vw, vh)` 也必须走同一份算法，**抽到 `viewport.js` 共享函数**。

---

### 坑 #3 · TransformControls 在两种模式下都"残废" → 中频（必修）

**现状证据**

- `controls.js` 的 `createTransform()` 真实创建 `tctrl = new TransformControls(camera, domElement)`，把 gizmo helper `scene.add(gizmo)`。
- `main.js` 立即 `tctrl.enabled = false;`（**因为 2D canvas 里 gizmo 不可见且拖拽语义错乱**）。
- `props.js` 的 `PropManager` 又**独立创建了一份 `this.tctrl`**，同样 `enabled = false`，加到 scene。
- `main.js` 的 `syncActiveCamera()` 还做 `propManager.tctrl.camera = ac.camera;`

**P1 双模后会发生什么**

- WebGL 视口下 gizmo 是真实 3D 轴柄 —— 如果继续 `enabled = false`，**用户没有任何 3D 操作入口**，连位置都没法调；只能沿用 2D 屏幕拖拽。
- 如果打开 `tctrl.enabled = true`，`setupPointerEvents` 里的自定义 2D 拖拽会和 TransformControls 的拖拽**互相打架**（`dragging-changed` 已经禁用了 orbit，但 2D 拖拽走的是 `pointermove` → 自定义平面射线，**不会通知 tctrl**）。
- WebGL + 道具：3D 模式下 `pickProp` 用射线能命中 box mesh（比 2D 屏幕缓存更准），但拖拽语义需要改回**直接 attach tctrl + 自动切 translate/rotate/scale**，**2D 那套屏幕平面拖拽逻辑在 3D 视图里是冗余的**。
- `tctrl` 在 Three.js 0.184+ 改了 API：`getHelper()` 才能拿到可视化对象，旧版本直接是 Group。当前代码两版都兼容，但**依赖 `scene.add(gizmo)` 这个分支有版本风险**。

**修复方向**

- 模式分支：`renderMode === 'webgl'` 时把 `tctrl.enabled = true`，**关闭自定义 2D 拖拽**，复用 Three 自带 3D 拖拽 + gizmo。
- `renderMode === 'canvas2d'` 时保持现状（`tctrl.enabled = false`，自定义 2D 拖拽接管）。
- `renderMode === 'auto'`：首帧检测成功 → webgl；首帧异常 → 自动切回 canvas2d 并 toast。
- **必须删一个 tctrl**：当前 `controls.js` 一份 + `props.js` 一份是个历史包袱，P1 应该把道具的 gizmo 合并到 controls 的 tctrl（attach 不同 object 即可），避免双 listener 抢同一 pointer 事件。

---

### 坑 #4 · WebGL context lost / 不可用 → 静默退化（必修）

**现状证据**

- `scene.js` 的 `getRenderer()` 用 try/catch 包了构造，**失败置 `rendererFailed = true` 永不重试**。
- **没有任何 `webglcontextlost` / `webglcontextrestored` 监听器**。
- `controls.js` 的 OrbitControls + TransformControls 在失去 context 时**会卡死**，Three.js 0.184 不自动重连。
- `pass-renderer.js` 的 `renderDepthCanvas` 里 `camera.near/far` 修改后用 `prevNear/prevFar` 恢复，但**如果中途 context lost**，恢复逻辑不会跑。

**P1 双模后会发生什么**

- RTX 5090 切到集显 / 浏览器切后台 / 长时间不交互 → 常见 context lost。视口黑屏无提示，用户不知道发生了什么。
- 导出时 GPU 抢资源（玩家游戏、视频会议）→ depth/normal 通道失败 → `export.js` 只能 `throw new Error("当前环境 WebGL 不可用...")`，用户体验是**红 toast + 整批重传**。
- 自动档 `auto` 承诺"检测失败自动回退"，但**首帧成功不代表之后一直成功**。

**修复方向**

- 视口 WebGLRenderer 注册 `canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); ... })`，丢失时 **暂停 RAF + 标记 `viewportContextLost = true`**，触发模式管理器切回 canvas2d 并 toast。
- `webglcontextrestored` 重新初始化 scene state（重建材质/纹理引用），**Three.js 不自动完成**。
- 导出 renderer 单独处理：丢失时返回明确错误码 `WEBGL_CONTEXT_LOST`，UI 让用户重试或跳过该通道。
- `rendererFailed` 标志位增加"可重试计数"，避免首次偶发失败永久打死。

---

### 坑 #5 · DPR / setSize 在 RAF 循环里被反复改写 → 中频（必修）

**现状证据**

- `main.js` 的 `requestAnimationFrame(renderLoop)` 每帧 `scene.updateMatrixWorld()` + `drawFrame()`（2D）。
- `main.js` 的 `applyViewport` 只在 `window resize` 和 protocol init 时被调用，**不每帧调**，所以 DPR 当前还稳。
- `scene.js` 的 `layoutCanvas2d` 绑了 `ResizeObserver` → viewport 尺寸变就重排 → **会动 canvas 的 width/height 属性 + ctx2d scale**。
- `pass-renderer.js` 每次渲染自己 `makeRT(w, h)` → 用完 `rt.dispose()`，是健康的。

**P1 双模后会发生什么**

- WebGL 视口下 `renderer.setPixelRatio(dpr)` 在 HiDPI 屏（2K/4K/Retina）会把 drawing buffer 放大 → 帧时间随像素量平方级增长。
- `setSize` 在 `applyViewport` 链路里被调用，但视口在拖动浏览器边缘 resize 时会**连续触发 N 次**，每次都重建 render target（如果用 RT 模式）或重建 canvas 上下文状态。
- **导出 vs 视口 DPR 一定不同**：导出按节点要求（比如 512×768），视口按设备 DPR（1x/2x/3x）。共享 renderer 必爆；分离 renderer 后这个问题就消失。
- 信箱布局变化（窗口拖宽）→ `layoutCanvas2d` 改 `canvas.width/height` + `ctx2d.scale(2,2)`，**这步对 2D 是 OK 的**；但如果同一份逻辑无脑套到 WebGL，`renderer.setSize(cssW, cssH, false)` 第二参是 setStyle，必须小心。

**修复方向**

- 视口 WebGLRenderer 初始化时 `setPixelRatio(Math.min(window.devicePixelRatio, 2))`（**封顶 2**，参考 7B 的 macOS M5 Pro DPR 2 实测）。
- 性能档位（auto / fluid / hd）按参考项目 7B 方案：统一控制主视口、监看、gizmo 的 DPR + 抗锯齿 + preserveDrawingBuffer。
- `applyViewport` 拆 `viewportSize` 和 `exportSize` 两个入参；视口 setSize 只在 ResizeObserver 回调里跑（**别在 RAF 里跑**）。

---

### 坑 #6 · 性能 / RAF 单循环吃所有事 → 中频（应修）

**现状证据**

- `main.js` 末尾的 `renderLoop` 一帧内做：orbit.update → matrixWorld → bones → drawFrame → solveGLB_IK → solveVRM_IK → RAF。
- **没有早期退出**：即便所有节点都不可见、用户停手、没在拖拽，仍然每帧重算所有 IK 链 + 全场景 matrix。
- `scene.js` `drawFrame` 里有 `window.__ds_jointScreen = [];` 每帧重置，再 push N 个 joint × M 角色 × 18 个 joint —— 每次 GC 压力。

**P1 双模后会发生什么**

- WebGL 视口下每帧还要 `renderer.render(scene, camera)`，**再叠 2D canvas 绘制**就是双重开销（即使 2D 模式继续跑，drawFrame 仍然在）。
- GLB/VRM 的 IK 求解在 IK 模式下有意义，FK 模式下 `ikTargets.target` 用户不拖的话**可以缓存不动**；当前每帧都跑是浪费。
- 多视口预留（P2/P3）：底部时间轴、监看小窗、看成片都会复用同一时间预算，**单 RAF 必须分桶**。

**修复方向**

- 引入 `dirty` 标记：只有用户拖动、相机变化、道具变化时才标记 `sceneDirty = true`。
- `renderLoop` 检测无 dirty + 无动画时降频到 10 FPS（窗口失焦/不交互时甚至 0）。
- 拆分：视口 RAF 用 `requestAnimationFrame`（流畅），导出 RAF 用 `setTimeout(0)` 排队（不让用户感知卡）。
- `__ds_jointScreen` 用固定长度 typed array 池（参考项目 playbackRuntime.ts 的"高频数据走 runtime 不走 React"的同款思路）。

---

### 坑 #7 · 拾取命中半径 + IK 球互相遮挡 → 中频（应修）

**现状证据**

- `controls.js` `pickAt` 屏幕命中半径 14px（注释里写的"绘制点最大 12px + 2px 余量"）。
- `scene.js` `drawStickFigure` 里关节球半径随模式/选中/活动角色变化：FK 默认 5，活动角色 6，选中 8；IK 模式 3。
- IK target 大 9-12，pole 6-7。
- **视口缩放（pinch / zoom）改变 canvas 实际显示尺寸**，但绘制半径用 CSS 像素是固定值，**pinch 放大后命中半径相对变小**。
- **WebGL 模式下用户能用滚轮缩放相机**，关节投影尺寸变化但屏幕缓存的 `__ds_jointScreen` 位置没刷。

**P1 双模后会发生什么**

- WebGL 模式如果继续走屏幕缓存拾取，**zoom 后拾取点错位**（典型 10-30px 漂移）。
- 3D 模式下 `pickProp` 用 raycaster 命中道具 mesh 是精确的，**但用户可能同时点中 IK 球 + 道具** → 优先级未定。

**修复方向**

- WebGL 模式：拾取完全交回 raycaster（**屏幕缓存只服务 2D fallback**）。Three.js 自带的 `Raycaster.intersectObjects` 在 WebGL 视口下精度足够。
- 加 raycaster 与屏幕拾取的"双轨 fallback"：raycaster 没命中时回退屏幕缓存（2D 路径）—— 模式切换时用对的那条。
- 命中半径做**最小 CSS 像素 = 14**，**最大 = 视口高度的 1.5%**（pinch 缩放后保持手感）。

---

### 坑 #8 · 视口 vs 监看 vs 导出 — 共享 scene 改写的竞态 → 中频（应修）

**现状证据**

- `export.js` `performApply` 改 `grid.visible = false; axes.visible = false;` 然后恢复。`performBatchExport` 通过 `propManager.setGizmoVisible(false)` 隐藏 gizmo。
- `pass-renderer.js` 的 `renderDepthCanvas` 改 `scene.background = new THREE.Color(0x000000)` 然后恢复。
- `pass-renderer.js` 的 `renderDepthCanvas` 改 `camera.near/far` 然后恢复。

**P1 双模后会发生什么**

- WebGL 视口正在跑 RAF，导出 export 时**改 scene.background** → 视口当前帧立刻黑屏 → 恢复后视口又正常。
- `camera.near/far` 视口用的视场（用户可能在看远处细节）→ 导出临时改成根据 bbox 算的 near/far → 视口当前帧投影错。
- 多机位导出要循环 `for (const camEntry of allCameras)` 每个相机都 `cam.aspect = exportW / exportH` + `updateProjectionMatrix()`，**恢复要靠 `savedCamId` 在最后切回去**。WebGL 视口正在用 active camera 时这一刀切，**视口会闪一帧 aspect 错**。

**修复方向**

- 导出 renderer 用独立 scene 引用（深 clone 或独立 Three.js Scene 实例），不动主 scene。
- 或者：所有"导出前改状态"的逻辑收口到一个 `exportGuard.begin()` / `exportGuard.end()` 闭包，**主 RAF 在 `end()` 之前暂停**。
- 多机位导出前先 `cameraManager.snapshotAllAspects()` + `snapshotAllFovs()`，结束后逐个还原 + 触发 `applyViewport` 一次。

---

### 坑 #9 · 缩略图 / 监看 / 高斯泼溅预留 — 当前已有多 Canvas 风险 → 低频（记录）

**现状证据**

- `cameras.js` `_scheduleThumbnail` 调 `window.__ds.renderer`（懒加载的同一个），意味着**每次切机位都会触发 WebGL 创建**（如果还没创建过）。
- `thumbnail-capture.js` 文件名存在但本审核没读其内容 —— 假设它也是走 `getRenderer()`。
- 参考项目（P2/P3）会引入监看小窗、看成片、底部时间轴等**多个 WebGLRenderer**（参考 PROJECT-HANDOFF §8 架构图）。

**P1 阶段动作**

- 把"渲染器实例"概念抽象成 `RendererPool`：viewport / thumbnail / export 各一个 named slot；后续监看 / 看成片各加一个。
- 7A 实测 25 人压力场景在 M5 Pro + DPR 2 上**画质档仍 92.7 FPS**（参考项目），证明多 Canvas 在 macOS 上不爆；Windows + RTX 5090 应该更好，但**首次集成不要做激进合并**。

---

## 2. 推荐架构（与现有 2D fallback 完全兼容）

### 2.1 三档渲染模式管理器（auto / webgl / canvas2d）

```
┌─────────────────────────────────────────────────────────────┐
│                    render-mode.js (新文件)                   │
│  ─ getMode(): 'auto' | 'webgl' | 'canvas2d'                │
│  ─ setMode(mode): 手动覆盖；auto 会跟随环境侦测               │
│  ─ detect(): 同步检测 WebGL2 可用 + create test renderer    │
│  ─ registerContextLostCallback(): context lost 时切回     │
│  ─ 暴露 window.__ds.renderMode                                │
└─────────────────────────────────────────────────────────────┘
```

**改造点**（不写代码，只指位置）

- `scene.js` 新增 `getViewportRenderer()` / `getExportRenderer()` 两个独立工厂，**`getRenderer()` 标 deprecated**，强制走显式 slot。
- `main.js` 的初始化顺序改成：
  1. `createRenderer()`（2D canvas）→ `mountRenderer(viewportEl)`（沿用当前逻辑）
  2. `renderMode.detect()` 同步跑（创建 + 立即销毁 test renderer，不留实例）
  3. `if (mode !== 'canvas2d') mountViewportRenderer(viewportEl)` 接管视口 DOM
  4. RAF 循环按 mode 分支：webgl 走 `viewportRenderer.render(scene, camera)`；canvas2d 走 `drawFrame`（沿用）
- UI 增加一个三档切换控件（自动 / WebGL / 2D），状态写 localStorage。
- `auto` 档运行时策略：context lost → 自动降回 canvas2d + toast "已切回 2D 模式"。

### 2.2 双 Renderer 物理隔离（解决坑 #1）

```
viewport (CSS 视口, 信箱布局后 vw × vh)
  └─ canvas#viewport-gl  (WebGLRenderer 实例 A)
       setSize(vw, vh), setPixelRatio(min(dpr, 2))

export (exportW × exportH, 离屏 RenderTarget)
  └─ canvas#export-gl    (WebGLRenderer 实例 B)
       setSize(exportW, exportH), setPixelRatio(1)
```

- 两个 renderer 不共享任何 GL context（强制隔离）。
- 视口 renderer 的 `setPixelRatio / setSize` 由 `applyViewport` + 性能档位驱动，**与导出尺寸解耦**。
- 导出 renderer 改成"按需创建 + 用完 dispose"：每次 export 创建新实例，export 完 dispose，避免 GPU 长期占用。参考项目 7C "自动切档不重建 WebGL Canvas" 的精神正好相反 —— 但导演台当前是低频导出，**用完就销毁**更省显存。

### 2.3 拾取双轨（解决坑 #7）

```
pickAt(event):
  if (renderMode === 'webgl') return raycaster.intersectObjects(pickables, true)
  if (renderMode === 'canvas2d') return screenSpacePickAt(event)  // 现有 __ds_jointScreen
  if (renderMode === 'auto')  return raycaster | screenSpacePickAt (前者失败回退后者)
```

- webgl 拾取精度高（raycaster 命中 mesh），但开销更大；只在 pointerdown 时跑，不每帧跑。
- canvas2d 保持现有屏幕缓存路径，零成本。

### 2.4 TransformControls 模式分支（解决坑 #3）

```
tctrl.enabled = (renderMode !== 'canvas2d')
tctrl.size = (renderMode === 'webgl') ? 0.65 : 0
custom 2D drag handler.enabled = (renderMode === 'canvas2d')
```

- 合并 props.js 的 tctrl 与 controls.js 的 tctrl 为同一实例；PropManager 改成"借用"全局 tctrl，不自己 new。

### 2.5 aspect 真值源（解决坑 #2）

- 删除 `defaultCamera` 这个独立引用，**`cameraManager.getActiveThreeCamera()` 是唯一相机源**。
- `ui.js` 的 `applyViewport(elem, exportW, exportH)` 接收完整参数，不读模块作用域。
- `defaultCamera` 保留仅为向后兼容（导出 renderer 在没人 setActive 时有个 fallback），但 `main.js` 里所有引用改成 `cameraManager.getActiveThreeCamera()`。

### 2.6 性能档位（参考项目 7B 简化版）

```
档位: auto / fluid / hd
auto:  min(dpr, 2), antialias=true, preserveDrawingBuffer=true
fluid: min(dpr, 1), antialias=false, preserveDrawingBuffer=false
hd:    min(dpr, 2), antialias=true, preserveDrawingBuffer=true
```

- `preserveDrawingBuffer=true` 在视口里其实**没用**（视口不 toBlob），**只在 export 离屏 renderer 开启**。这是参考项目 7B 没拆开的点，P1 顺手拆开。
- 档位切换**不重建 renderer**，只改 `setPixelRatio` 和 `setSize`，参考 7C 的稳定策略。

---

## 3. 验收清单（P1 完成判定）

### 3.1 功能验收（必过）

- [ ] **A1**：RTX 5090 环境默认进入 WebGL（auto 档），主视口看到真实 GLB/VRM/道具/灯光/网格。
- [ ] **A2**：手动切到 `canvas2d`，主视口显示与当前 2D fallback 像素一致（截图 diff < 1%）。
- [ ] **A3**：手动切到 `webgl`，强制 createElement('canvas') 拿不到 GL 上下文 → 自动降回 `canvas2d` + toast。
- [ ] **A4**：导出 openpose 通道在 `canvas2d` 模式下**与现状完全一致**（这是 fallback 兜底的核心，不能回归）。
- [ ] **A5**：导出 depth/normal/lineart/preview/mask 通道在 `webgl` 模式下像素与 7A/7B/8B 参考项目口径一致。
- [ ] **A6**：多机位导出（M2 performBatchExport 路径）在 webgl 模式下多相机循环不闪视口、不留 grid/axes 残留。
- [ ] **A7**：键盘 Ctrl+1~9 切机位时视口 aspect / 信箱布局 / 投影全部同步，无一帧变形。
- [ ] **A8**：拖动浏览器边缘 resize viewport，2D 模式 / WebGL 模式都正确信箱化，aspect 不飘。

### 3.2 健壮性验收（必过）

- [ ] **B1**：连续触发 `WEBGL_lose_context`（DevTools → Rendering → "Force WebGL context loss"），视口自动切回 canvas2d，不白屏不卡死。
- [ ] **B2**：context restore 后手动切回 webgl 模式，重新初始化 scene 状态（材质 / 纹理引用 / gizmo helper）。
- [ ] **B3**：导出 50 道具场景（参考项目 7C 中等档），导出 renderer 用完 dispose，主视口 FPS 不掉到 30 以下。
- [ ] **B4**：propManager.tctrl 与 controls.tctrl 合并验证：只有一个 tctrl 实例，attach 不同 object 切换正确。
- [ ] **B5**：GLB / VRM 加载在两种模式下行为一致，IK 球可见、可拖。

### 3.3 性能验收（应过）

- [ ] **C1**：主视口 WebGL 模式空场景 ≥ 60 FPS（参考项目 7B 流畅档基线）。
- [ ] **C2**：主视口 WebGL 模式 25 人 + 12 道具压力场景 ≥ 30 FPS（P1 不强求 60，因为 RTX 5090 真机数据待补）。
- [ ] **C3**：导出 5 通道 × 3 相机 = 15 次渲染，总耗时 < 30 秒（参考项目 7C 中等场景 5 通道约 25 秒）。
- [ ] **C4**：HUD 简单显示 FPS（`?debug=fps` 时），记录 baseline 数据供 P3 序列导出参考。

### 3.4 回归验收（必过）

- [ ] **D1**：`smoke-2d` / `multi-char-verify` / `prop-restore-verify` / `prop-drag-verify` 全部通过（不能破坏现有 M1/M2 兜底）。
- [ ] **D2**：新增 `webgl-mode-verify.mjs` 验证 webgl 模式非黑屏、场景对象可见。
- [ ] **D3**：新增 `fallback-mode-verify.mjs` 强制禁用 WebGL 后 2D 可用。
- [ ] **D4**：新增 `context-lost-verify.mjs` 验证 context lost 自动降级。
- [ ] **D5**：`npm run build`（如果有 build 脚本）/ Vite build 通过，**没有新加的 chunk 警告**。

---

## 4. 后续 P2/P3 影响

### 4.1 P2（WASD 掌镜 + 轨迹点 + 时间轴）的依赖

- **Pointer Lock + WASD 与渲染模式无关**，但要在 `controls.js` 把相机操作从 `OrbitControls` 拆成"导演视角"和"掌镜视角"两种 state machine，P1 阶段就把接口预留。
- **时间轴 runtime sampler**（参考项目 playbackRuntime.ts 的核心抽象）：P1 必须先有"runtime = 高频数据"的概念，否则 P2 每帧写 Zustand 会让 WebGL 视口的 React/Vue 重渲染爆炸（P1 当前没有 React，但 Canvas 2D drawFrame 仍然每帧跑全量 IK，所以概念要平移）。
- **监看小窗 + 看成片**：P2 会引入第二个 WebGLRenderer。P1 把"renderer slot"概念定下来（§2.2），P2 就能直接挂第三个 slot。
- **轨迹线 / 轨迹点**：2D 模式已经用 `drawProps2D` 模式在画（仅道具），P2 加轨迹线时复用同一套 drawFrame 钩子，WebGL 模式用 `THREE.Line` + `THREE.Sprite`。

### 4.2 P3（动作库 + 序列帧导出接 WanVideo）的依赖

- **序列帧导出 = 高频调 performBatchExport**：当前实现是同步循环，P3 会改成 `frame_idx → setTimeout(0) → render → upload` 的 event-loop 友好模式。P1 必须先保证"导出 renderer 用完即销毁"（§2.2），否则连续 24 帧导出 OOM。
- **动作库 = 高频采样**：P1 的 IK 求解（GLB/VRM）目前在 RAF 里每帧跑，P3 的动作采样会加进来；P1 阶段就要预留"动作 runtime sampler"接口，否则 P3 每帧 IK + 动作双重计算。
- **WanVideo IMAGE batch 节点**：导出 manifest 加 `sequence: { fps, frame_count, frames: [...] }`，P1 阶段 manifest schema 升级时预留这个字段。
- **场景数据快照**：参考项目 8C 的 `projectFingerprint` 是 fvn1a32 摘要。导演台当前没有这个概念，P3 接 WanVideo 时需要"工程版本绑定结果"的指纹，P1 不强制但建议 `sceneJSON.version` 字段预留。

### 4.3 性能档位的最终形态

参考项目最终收敛为 `auto / fluid / hd` 三档，P1 阶段直接采用同一套命名和内部策略，**不要**自创第四档。7C 经验：`auto` 不只看 CPU，要看主视口的真实帧时间，连续两个差窗口降档、连续三个好窗口升档、9 秒冷却 —— 这套逻辑 P1 不实现（因为 P1 还没有"看用户长期使用"的场景），但接口要预留。

### 4.4 工程数据冻结点

P1 阶段建议冻结的 schema 字段（防止 P2/P3 反复返工）：

- `sceneJSON.version = 3`（P0 = 1, P1 = 2, P2 = 3, P3 = 4 之类递增）
- `sceneJSON.renderMode = 'auto' | 'webgl' | 'canvas2d'`（P1 加）
- `sceneJSON.performanceProfile = 'auto' | 'fluid' | 'hd'`（P1 加）
- `sceneJSON.cameraRoutes` 字段先放空数组（`[]`），P2 填入
- `sceneJSON.timeline = { duration, fps }` 字段先放默认（`{ duration: 8, fps: 24 }`），P2 填入
- `sceneJSON.actionClips` 字段先放空数组（`[]`），P3 填入

冻结的代价是 P1 多写 ~30 行 schema 代码 + 5 行 default migration，收益是 P2/P3 不再为字段加在哪里、要不要兼容老工程打架。

---

## 5. 风险评级与建议

### 5.1 auto / webgl / canvas2d 三档实现是否同意？

**同意，且强烈建议按这个三档实现**，理由：

1. **auto 档是产品承诺**：P1-P3-PLAN.md §P1-A 明确写了"默认 auto，检测失败自动回退"；用户对"打开就能用"的预期是 RTX 5090 上必须 webgl、低端机器/无 GPU 环境必须 canvas2d。
2. **canvas2d 是兜底，不是临时**：当前 M0/M1/M2 整条 2D 路径已经覆盖多角色 / 多机位 / 道具 / 持久化 / 缩略图 / 协议，**完全砍掉 2D 等于推翻 4 个 milestone**。保留 canvas2d 档意味着即使 P1 的 WebGL 集成翻车，导演台仍然可用。
3. **webgl 档是能力升级**：只在用户机器能跑时才显示 GLB/VRM 真实材质、灯光、阴影；不要在 canvas2d 上去硬模拟这些（参考项目 6B/7B 都走了这条线）。
4. **手动切换**：给开发者 / 高级用户一个 force canvas2d 入口，用于排查 WebGL 兼容性问题（参考项目 `?benchmark=standard` / `?performance=fluid` 的同款设计）。

### 5.2 三档之间的优先级建议

实现顺序：

1. **先做 `canvas2d` 不动**：当前已经是 canvas2d 路径，P1 不要改它，作为 baseline。
2. **再做 `webgl` 独立**：先实现一个**和现有 2D canvas 完全平行的 WebGL 视口**（不共享 canvas、不共享 renderer、不共享 RAF），验证 RTX 5090 上能跑、能交互、能导出。
3. **最后做 `auto` 模式管理器**：把前两个档串起来，加 context lost 检测，加 UI 切换，加 localStorage 持久化。

这样如果 P1 时间不够，最差也能交付"canvas2d 默认 + webgl 手动开关"，比"auto 半成品 + 两边都不稳定"强。

### 5.3 是否需要拆分任务到多 Agent？

参考 P1-P3-PLAN.md §"P1 建议 3 路"，本审核员建议保持三路并发，但**任务边界要重新划**：

- **A 路**：render-mode.js + 视口 WebGL 集成 + DPR/size（**含坑 #1 #5 #6**）
- **B 路**：交互一致性 + 拾取双轨 + TransformControls 合并（**含坑 #3 #7**）
- **C 路**：context lost 兜底 + 性能档位 + 测试 + 截图（**含坑 #4**）

坑 #2（aspect 一致性）由 A 路负责，跨 B 路 call 时 A 提供接口。
坑 #8（多 Canvas 共享 scene 改写）由 B 路在 export.js 重构时统一处理。

### 5.4 最危险的 5 条风险（按踩坑概率 × 修复成本）

1. **坑 #1（renderer 共享）** —— 必修必修必修，**否则 RTX 5090 上视口渲染与导出渲染互相撕，导出图尺寸错乱**。修复成本：~150 行新代码 + 重构 scene.js 的 renderer 工厂。
2. **坑 #2（aspect 真值源）** —— 高频踩坑，每次加新视口或新机位都复发。修复成本：~80 行 + 全链路 audit。
3. **坑 #4（context lost）** —— 用户切后台 / 长时间不交互 100% 触发，不处理就会出"看起来明明有 GPU 怎么黑屏"的客诉。修复成本：~60 行监听器 + 模式管理器。
4. **坑 #3（TransformControls 双实例）** —— WebGL 模式下 gizmo 与 2D 拖拽必然打架，必须在双模接通前合并。修复成本：~120 行重构 + PropManager API 调整。
5. **坑 #5（DPR / setSize 反复改写）** —— HiDPI 屏 + 信箱布局 + 频繁 resize 一定踩；不处理性能崩。修复成本：~40 行 applyViewport 重构。

---

## 6. 总结

**核心结论**：

- ✅ 当前 2D 兜底架构是健康的，**不要推翻**。
- ✅ auto / webgl / canvas2d 三档实现方向**完全同意**。
- ⚠️ 视口 WebGLRenderer 与导出 WebGLRenderer **必须物理分离**（坑 #1）—— 这是 P1 集成最大的架构决策。
- ⚠️ TransformControls 在两套路径里现在是"双实例残废"，必须在 P1 合并为单实例 + 模式分支启用（坑 #3）。
- ⚠️ context lost 必须有自动降级处理（坑 #4），否则 RTX 5090 用户后台切回会看到黑屏。
- ⚠️ aspect 唯一真值源要收敛到 cameraManager，**`defaultCamera` 这个独立引用必须逐步淘汰**（坑 #2）。
- ⚠️ 视口与导出的 `setPixelRatio / setSize` 必须彻底解耦（坑 #5）。

**给下游 Agent 的硬约束**：

1. P1 不要修改 `scene.js` 里 `drawFrame` 的 2D 路径，**这是兜底**。
2. `export.js` 的 `getRenderer()` 调用先保留，**但要保证它只命中"导出 renderer slot"**，不能漏到视口 renderer。
3. `main.js` 的 `renderLoop` 末尾 `requestAnimationFrame(renderLoop)` 暂时不动；P1 在循环顶部分模式 if 即可。
4. `controls.js` 的 `pickAt` 屏幕拾取保留（canvas2d 模式要用），webgl 模式另开 raycaster 路径。
5. **不要在 P1 阶段做 React 化 / Vue 化 / 任何 UI 框架引入** —— 当前原生 DOM 已经够用，P2 之前不要换。

---

**审核完成。报告路径**：`F:\comfyui\custom_nodes\comfyui-director-stage\docs\P1-WEBGL-REVIEW.md`

**5 条核心风险**：

1. **视口/导出 renderer 共享导致 setSize/DPR 互相污染** —— 必修
2. **aspect 真值源分裂（defaultCamera ↔ cameraManager.cameras[i].camera）** —— 必修
3. **TransformControls 双实例 + 永远 enabled=false** —— WebGL 模式必须合并并分支启用
4. **WebGL context lost 无监听无降级** —— RTX 5090 切后台 100% 黑屏
5. **DPR / setSize 信箱布局在 RAF/resize 反复触发** —— HiDPI 性能崩

**auto / webgl / canvas2d 三档实现是否同意**：✅ **完全同意**。建议实现顺序：先稳 canvas2d 不动 → 独立做 webgl 视口（不与 2D 共享）→ 最后串 auto 模式管理器 + context lost 兜底。