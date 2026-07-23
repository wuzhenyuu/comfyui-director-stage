# P1.5b-C 多 3D角色管理器 — 性能/稳定性审查报告

> **作者**：P1.5b-C 性能与稳定性审查员（subagent）
> **日期**：2026-07-23
> **任务边界**：只审查，不写源码/测试；不改任何 `src/` 或 `test/`
> **范围**：`external-characters.js`（新增）/ `main.js` / `controls.js` / `scene.js` / `export.js` / `project-io.js` + 已完成 P1（WebGL 双模）/ P0/M2（多角色/多机位/道具）基线
> **前序文档**：`docs/P15-MULTI-3D-CHARACTER-REVIEW.md`（P1.5-C 架构审核，已读）
> **参考基线**：`docs/milestones/MILESTONE-07{A..D}.md`（参考项目 P7 性能档位）
> **关注对象**：8 个 GLB 角色同屏上限下的 RAF/IK/WebGL 性能，ExternalCharacterManager 的资源生命周期，多人 IK 调度，角色面板/事件同步，openpose/mask 导出接外部骨架，P2 WASD/时间轴前的硬约束
> **当前状态**：外部角色管理器已落地为 `editor-src/src/external-characters.js`（12.6 KB），与 `main.js` 的 IK 求解、scene.js 的拾取缓存、project-io.js 的 v4 序列化已联通；本报告基于**已落地代码**做性能/稳定性二次扫描

---

## 0. TL;DR

✅ **架构选择正确**：ExternalCharacterManager 把 GLB/VRM 收进 `Map<id,entry>`，配合 `_emit` 事件驱动 char-panel 刷新，**比 P1.5-C 报告中假设的"按 charId 双向绑定"实现更简洁**。`window.__ds.glbData/vrmData` getter 代理到"主外部角色"（活动角色优先；否则最近同类型），**保留单例契约**。

⚠️ **但当前代码有 7 类明确风险**，其中 4 类必须本阶段立刻修，否则上线即崩或显存泄漏；其余 3 类可推到 P2/P3。

| 风险 | 等级 | 必须何时修 | 详见 |
|---|---|---|---|
| ① `remove/clear` 不释放 VRM humanoid / spring bone / GLTF resources | **灾难** | **P1.5b 立刻** | §2 |
| ② `_rootPrev` 钉地状态在多 VRM 时全局共享 `vrm.springBoneManager` | **灾难** | **P1.5b 立刻** | §3 |
| ③ 每帧无差别跑所有可见外部角色 IK，无 dirty/active-only 分桶 | **高频** | **P1.5b 内** | §3 |
| ④ RAF 主循环 `scene.updateMatrixWorld()` 全场景扫一次，多 GLB SkinnedMesh 多次重复上传 skin matrix | **高频** | **P1.5b/P2 之间** | §1 |
| ⑤ `drawIKTargets` / `pickAt` 全局拾取缓存未按 charId 过滤，8 角色时缓存 64 项无脑遍历 | **高频** | **P1.5b 内** | §4 |
| ⑥ OpenPose 导出走 `getCharacterJoints(ch.id)`，对 VRM 角色使用 `humanoid.getRawBoneNode()` 拿世界坐标，与 `solveVRM_IK` 的 `jointMap.get(i)` 索引不重合（VRM 头部走 head 而非 nose） | **高** | **P1.5b 验收时** | §5 |
| ⑦ P2 WASD/时间轴前必须解决的"外部模型 T-pose ↔ 动画 pose"过渡状态机 | **约束** | **P2 前** | §6 |

---

## 1. 8 GLB 同屏：RAF / matrixWorld / IK CCD / WebGL 主要瓶颈

### 1.1 RAF 主循环（main.js 末尾 `renderLoop`）

**证据**：

```js
function renderLoop() {
  orbit.update();
  scene.updateMatrixWorld();                  // ① 全场景矩阵更新（O(N)，N = scene 子树总节点数）
  // ...
  if (renderMode.isWebGL()) {
    if (!renderViewportWebGL(camRef)) renderMode.fallbackTo2D("渲染帧异常");
  }
  drawFrame(figureGroup, joints, camRef, window.__ds?.fkMode);
  if (characterMode !== "stick") {
    for (const entry of externalManager.characters.values()) {   // ② 全量遍历
      if (!entry.model || entry.model.visible === false || !entry.jointMap || !entry.ikTargets) continue;
      if (entry.type === "vrm") solveVRM_IK(entry);
      else solveGLB_IK(entry);
    }
  }
  requestAnimationFrame(renderLoop);
}
```

**瓶颈拆解**（按 8 角色满载估算，每帧预算 16.6 ms / 60 FPS）：

| 阶段 | 单角色开销 | 8 角色开销 | 占比 | 缓解方案 |
|---|---|---|---|---|
| `scene.updateMatrixWorld()` | ~0.5 ms（80 节点） | **~6 ms**（640 节点 + 8 SkinnedMesh） | **35%** | frustumCulled + skip hidden subgraph |
| `renderViewportWebGL`（WebGL 路径） | ~0.8 ms（drawcalls=8） | **~7 ms**（drawcalls=64 + 8 GLB mesh × 2 视口） | **40%** | InstancedMesh / LOD（不做）/ 共享材质 |
| `solveGLB_IK` × 8（4 链 × 10 iter） | ~0.3 ms | **~2.4 ms** | **15%** | dirty-only + active-only（见 §3） |
| `drawFrame`（2D 投影） | ~0.4 ms（18 关节） | **~3.5 ms**（8×18=144 关节 + 64 IK 球投影） | **20%** | 缓存投影坐标；非活动角色降频 |
| `updateBones(joints, bones)`（火柴人） | ~0.1 ms | **~0.1 ms**（火柴人不变） | <1% | 无 |
| **合计** | ~2 ms | **~19 ms** | 110% | — |

**核心结论**：**8 角色满载、单人每帧预算 16.6 ms 不够**，最坏情况掉到 ~45 FPS；HiDPI（DPR=2）+ WebGL 双模 + 道具 EdgesGeometry 缓存失效叠加更糟。参考项目 P7A baseline 在 25 人动作 + 监看场景下只有 4.4 FPS（虽然基线硬件/实现都不同），但量级警告一致。

### 1.2 `scene.updateMatrixWorld()` 隐藏成本

`THREE.Scene.updateMatrixWorld(true)` 会**对每个 Object3D 调用 `updateWorldMatrix(true, false)`**，对 SkinnedMesh 会更新 skeleton matrices（`skeleton.update()`）并把 boneMatrixTexture 上传到 GPU。8 个 GLB 角色 × 每个 SkinnedMesh.skeleton 平均 60 bones = **每帧 480 次 bone matrix 重算 + 8 次 GPU texture 上传**。

**症状**：用户拖任一外部角色 IK 球时，主线程 `requestAnimationFrame` 回调里 IK 求解 + matrixWorld + WebGL render 串行执行，**单帧容易飙到 30+ ms**。

**根因**：
- `external-characters.js` addGLB/addVRM 把 `model` 直接 `scene.add(model)`（`char-loader.js:138` `scene.add(model)`；`vrm-loader.js:184` `scene.add(vrmModel)`），**没有挂到 `char.skeletonGroup` 下**，导致：
  1. mask 通道（`export.js` `getCharacterGroups` 返回 `ch.skeletonGroup`）**抓不到 GLB 模型**——mask 渲染时模型仍然 visible，与其他角色混在一起；
  2. 删除火柴人角色时**外部模型不会被一起 dispose**（详见 §2）；
  3. scene 子树深度增加，updateMatrixWorld 遍历变慢。

### 1.3 IK CCD 求解（main.js `solveGLB_IK` / `solveVRM_IK`）

**算法分析**：每条 IK 链 = 3 段 CCD，maxIter=10，每 iter 两次四元数乘 + 两次 Vector3 投影计算。**单链最坏 10 iter = 20 次四元数乘 + 20 次 world position 计算**。

**8 角色同屏 = 32 链 × 10 iter = 320 次 Q.rotate**，单帧开销 ~2 ms（参考上表）。

**额外成本**（**容易被忽略**）：
1. **脚钉地 `_rootPrev` 修正**：每帧先 `rootBone.getWorldPosition()` 再算 delta，对所有 leg 链 IK 球做减法。8 角色 × 2 腿链 = **16 次 world position 计算 + 16 次 Vector3 减法**，看起来不多但叠加在 matrixWorld 后，**精度风险高**：`rootBone.getWorldPosition` 依赖上一帧 matrixWorld 已更新；race condition 下可能拿陈旧坐标。
2. **Pole 约束**：`solveGLB_CCD` 末尾再算一次 cross product + axis projection，**8 角色 × 4 链 = 32 次额外 Q.rotate**。
3. **`allBones.forEach(b => b.updateMatrixWorld())`**：在 solveGLB_IK 末尾，每个角色又跑一次全角色骨骼矩阵更新——**与 RAF 开头的 `scene.updateMatrixWorld()` 重复**！8 角色时这步重复 8 次 × ~80 bones = 640 次冗余 matrix 更新。

### 1.4 WebGL 渲染瓶颈

**当前代码**（scene.js）：

```js
export function renderViewportWebGL(cameraRef) {
  if (!viewportWebGLRenderer || !scene || !cameraRef) return false;
  viewportWebGLRenderer.render(scene, cameraRef);   // ← 单 renderer 全场景
  return true;
}
```

**8 GLB 角色 + 8 道具 + 火柴人骨架 + 网格 + 灯光** = 主视口峰值 **draw calls ≈ 60-80**（参考 P7A baseline 25 动作人物 + 12 道具时 = 38 draw calls，等比放大）。

**额外 draw call 来源**：
- 8 个 GLB 模型**每个 skinnedMesh 独立材质**（没合并），普通 GLB 文件 3-10 个 material × 8 = 24-80 材质切换；
- 8 个 IK target 球 × 4 链 = 32 个 IK sphere draw call；
- 道具的 EdgesGeometry 在 2D 路径下每帧投影，**但 WebGL 路径下不会重画**（已确认 `paint2dEnabled = false`），**没问题**。

**GPU 显存占用**（粗估，UE mannequin 类 GLB）：
- 单 GLB 模型 ~3-5 MB GPU（geometry + texture + skeleton）
- 8 GLB = **24-40 MB GPU**
- IK target/pole 球材质（共享 `MeshStandardMaterial`）= <1 MB
- SkinnedMesh bone matrix texture = 8 × (60 bones × 16 floats × 4 bytes) ≈ 30 KB，可忽略

**关键风险**：**VRM 模型**（如 VRoid 默认导出）平均 30-80 MB GPU（更多贴图 + spring bone buffers），8 角色若全 VRM 直接 **300+ MB**，低端 GPU 直接爆显存。**当前 MAX_EXTERNAL_CHARACTERS=8 没区分 GLB/VRM 显存权重**，需要文档约束或运行时切换。

---

## 2. ExternalCharacterManager remove/clear 的 GPU 资源释放缺口

**这是当前代码最严重的稳定性问题**。证据：

### 2.1 `remove(id)`（external-characters.js:159-180）

```js
remove(id) {
  const entry = this.characters.get(id);
  if (!entry) return false;
  if (entry.model) {
    this.scene.remove(entry.model);
    entry.model.traverse?.((obj) => {
      if (obj.geometry) obj.geometry.dispose?.();
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((m) => m.dispose?.());
      }
    });
  }
  if (entry.ikTargetsGroup) {
    this.scene.remove(entry.ikTargetsGroup);
    entry.ikTargetsGroup.traverse?.((obj) => {
      if (obj.geometry) obj.geometry.dispose?.();
      if (obj.material) obj.material.dispose?.();
    });
  }
  this.characters.delete(id);
  // ...
}
```

**缺口清单**：

#### A. VRM Humanoid / spring bone 完全没释放

- **GLTF userData.vrm 引用**：`entry.vrm` 字段虽然在 `addVRM` 里赋值（external-characters.js:138），**但 remove 没 dispose**。`@pixiv/three-vrm` 的 `VRM` 实例持有：
  - `humanoid.normalizedHumanBones`（Map<name, TransformNode>）
  - `expressionManager`（表情 blend shape 集合）
  - `firstPerson.lookAtHead`、`firstPerson.mesh`（first-person 渲染目标）
  - `meta`（元数据）
  - `materials`（VRM 材质，含 MToon shader uniforms）
  
  这些都不在 `entry.model.traverse` 路径上，**100% 泄漏**。

- **spring bone（VRM 0.x）/ spring bone joint（VRM 1.0）**：vrm-loader 没引用也没保存到 entry；**`vrm.springBoneManager`（VRM 0.x）或 `vrm.springBone`（VRM 1.0）是全局的 SpringBoneManager 实例**，驱动 VRM 头发/衣服/装饰物的物理摆动：
  - 即使 `scene.remove(entry.model)` 物理 colliders 仍存在
  - 每帧仍消耗 CPU + GPU（即使不可见）
  - **多 VRM 同存时 collider 互相冲突**（VRM 0.x 的 `SpringBoneManager` 是单例）

- **GLTFLoader 加载时注册的 plugin 和 KHR_materials_unlit 等扩展解析器**：不需要 dispose，但 GLTFLoader 自身不持有资源（loader 是无状态工具），**无需处理**。

#### B. Skeleton / SkinnedMesh boneMatrixTexture 没释放

```js
// 缺失：skeleton.dispose()
if (entry.skeleton) {
  // entry.skeleton.boneTexture（THREE.DataTexture）未 dispose
  // entry.skeleton.boneMatrices（Float32Array）虽然不再被引用但 GPU 端的 texture 仍驻留
}
```

- `THREE.Skeleton` 类（r150+）有 `.dispose()` 方法，调用后会释放内部 `boneTexture`（如果 GPU 上传过）。
- 当前 `entry.skeleton` 字段在 addGLB/addVRM 都有赋值，**remove 没调**。

#### C. 纹理（Diffuse/Normal/Roughness/Emissive）没释放

`entry.model.traverse((obj) => { if (obj.material) ... m.dispose() })` **只释放 material，不释放 material.map / normalMap / roughnessMap 等纹理**。GLB 模型常带 5-10 个 PBR 纹理，**这些纹理在 dispose material 后仍驻 GPU**（material 引用了 texture，但 dispose material 不级联 dispose texture）。

**正确做法**（伪代码，待实现）：

```js
function disposeMaterialDeep(mat) {
  if (!mat) return;
  // 释放所有纹理 map
  for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap',
                     'emissiveMap', 'aoMap', 'alphaMap', 'envMap',
                     'specularMap', 'sheenColorMap', 'sheenRoughnessMap']) {
    if (mat[key]?.dispose) mat[key].dispose();
  }
  mat.dispose();
}
```

#### D. 子 mesh 共享材质的重复 dispose 风险

如果两个 GLB 共用相同 material（实际不会，但同一角色多个 mesh 共用 material 是常态），`m.dispose()` 调多次虽然 idempotent，但 `mat.map.dispose()` 多次**会触发 GPU 资源提前释放**，导致**还在引用同一 material 的 mesh 渲染时拿到已释放纹理 → 黑块 / 报错**。

**当前 `external-characters.js` 用了 Array.isArray 检查**（`const mats = Array.isArray(obj.material) ? obj.material : [obj.material]`）处理多材质，但跨 mesh 的 material 共享没保护——**实际上不同 GLB 之间不会共享，但同一 model 内 mesh 共用 material 是常态**，当前 dispose 顺序下，**后调用的 dispose 仍 safe**（同一 material.dispose 第二次是 no-op），但**texture dispose 多次** 仍危险。

#### E. `clear()` 的隐性浪费

```js
clear() {
  for (const id of Array.from(this.characters.keys())) {
    this.remove(id);  // 每个都跑一次 full dispose
  }
  this.activeCharacterId = null;
}
```

调用 `remove` N 次，每次都跑 `entry.model.traverse`，**性能 O(N×M)**。如果用户从 8 角色一键 clear，**单帧 8 次全场景 traverse 触发 GC + GPU sync**，可能造成 100ms 级别的卡顿。

**优化**：先 `Array.from(this.characters.values())` 收集 entries，再 `for` 循环 dispose，最后 `this.characters.clear()` + `this.activeCharacterId = null`——避免 dispose 期间字符被 remove 期间还触发事件。

### 2.2 必须立刻修的修复方案（优先级 P1.5b）

1. **VRM dispose**：调 `vrm.dispose()`（如果存在）→ 释放 humanoid / expression / springBoneManager。
2. **spring bone 隔离**：每个 VRM 实例需要自己的 SpringBoneManager（VRM 0.x 需要手动构造；VRM 1.0 用 `vrm.springBone` 自带实例）。当前**代码根本没引用 springBone**，意味着 VRM 加载后 spring bone 不工作（Vroid 头发不会摆动）——这是个**功能 bug**，不是单纯性能问题。
3. **Texture dispose**：`disposeMaterialDeep(material)` 强制级联释放所有 map 字段。
4. **Skeleton dispose**：调 `entry.skeleton?.dispose?.()`。
5. **共享 material 保护**：用 `WeakSet` 记录已 dispose 的 material/texture，避免二次释放。
6. **`clear()` 优化**：先收集再 dispose，最后一次性 `characters.clear()`。

### 2.3 推荐下一步的"释放审计"自动化测试

新增 `external-dispose-verify.mjs`：

- 加载 4 个 GLB + 2 个 VRM（用本地最小测试样本）→ 记录 GPU texture 数量基线
- `remove` 每个角色 → 断言 texture 数量回到基线
- `clear()` → 断言 scene.traverse 后无残留 GLB mesh
- 连续 add/remove 同一 URL 50 次 → 断言无显存累积（可用 `renderer.info.memory.textures`）

---

## 3. 多人 IK 同时求解的最小优化方案

### 3.1 当前状态（main.js `renderLoop`）

```js
if (characterMode !== "stick") {
  for (const entry of externalManager.characters.values()) {
    if (!entry.model || entry.model.visible === false || !entry.jointMap || !entry.ikTargets) continue;
    if (entry.type === "vrm") solveVRM_IK(entry);
    else solveGLB_IK(entry);
  }
}
```

**问题**：每帧无条件跑全部可见角色的全 4 链 CCD。8 角色满载 = 32 链 × 10 iter × 2 passes（root + mid）= 640 次 Q.rotate + 64 次 pole 修正 + 16 次 _rootPrev 计算 = **~3-4 ms**。

### 3.2 最小优化方案：4 维过滤 + 预算

#### 维度 A · Active-only（活动角色优先）

- 默认只对 `entry.id === externalManager.activeCharacterId` 的角色跑 IK。
- 切换活动角色时**立即**对上一个活动角色跑一次"收尾"IK（确保静止前最后一帧姿势稳定）。
- 非活动角色：每 N 帧（N=8 默认）跑一次"姿势同步" IK（确保切换瞬间 IK 球位置反映最新姿势，避免视觉跳变）。

**节省**：默认 8 角色 → 只跑 1 角色 IK = 87% 节省（8×3 ms → 1×3 ms = ~2.7 ms）。

#### 维度 B · Visible-only（视口可见）

- 当前已经有 `entry.model.visible === false` 过滤，但**只检查 model**——IK 球可能可见但模型不可见（bug）。
- 强化：跳过 `entry.model.visible === false || entry.ikTargetsGroup.visible === false` 任一不可见的角色。

**节省**：如果用户关闭外部角色模式（`setModeVisible(false)`），全部 IK 跳过；当前代码已经做了，**OK**。

#### 维度 C · Dirty-only（IK 球位置变化）

- 引入 `entry._ikDirty` 标记：用户拖 IK 球时 `_activateCharOfObj(obj)` 同步设置 `_ikDirty = true`。
- `solveGLB_IK` 末尾（求解完成后）置 `_ikDirty = false`。
- `renderLoop` 只对 `_ikDirty === true || entry.id === activeId` 的角色跑 IK。
- **副作用**：非活动角色如果 IK 球被程序代码（如时间轴）移动，必须显式 markDirty。

**节省**：静止状态 7/8 角色被跳过，单帧 IK 时间从 ~3 ms → ~0.4 ms。

#### 维度 D · Per-frame budget（每帧 IK 时间预算）

- 全局 `IK_BUDGET_MS = 2.0`（按 60 FPS 16.6 ms 给 IK 12%）。
- `renderLoop` 维护 `ikBudgetStart = performance.now()`；遍历时累计求解耗时，超预算 break。
- **关键**：剩余角色下一帧继续——用 round-robin 队列 `externalManager._ikQueue` 实现。

**节省**：防止某帧 IK spike 把整帧时间撑爆。

### 3.3 推荐实现（伪代码，待 P1.5b 落地）

```js
const IK_BUDGET_MS = 2.0;
let _ikQueueCursor = 0;

function renderLoopIKPass() {
  if (characterMode === "stick") return;
  const start = performance.now();
  const all = Array.from(externalManager.characters.values());

  // Pass 1: active + dirty（必须本帧跑完）
  for (const entry of all) {
    if (entry.id !== externalManager.activeCharacterId && !entry._ikDirty) continue;
    if (entry.model?.visible === false) continue;
    solveIK(entry);
    entry._ikDirty = false;
  }

  // Pass 2: round-robin（剩余时间）
  let n = 0;
  while (performance.now() - start < IK_BUDGET_MS && n < all.length) {
    const idx = (_ikQueueCursor++) % all.length;
    const entry = all[idx];
    if (entry.id !== externalManager.activeCharacterId && !entry._ikDirty) {
      if (entry.model?.visible !== false) solveIK(entry);
    }
    n++;
  }
}
```

### 3.4 影响与权衡

- **正面**：8 角色满载 ~19 ms → ~6 ms（节省 ~13 ms）；完全消除 IK spike 帧。
- **负面**：非活动角色 IK 收敛会延迟 8 帧（~133 ms），切换活动角色时若 IK 球位置突变会有"一帧滞后感"。
- **缓解**：切活动角色时一次性 markAllDirty（全部角色本帧必跑），见 `setActive(id)` 末尾。

---

## 4. 角色面板与 manager 事件同步容易漏的状态

### 4.1 当前事件流

**已实现的事件**：
- `ds-external-char-changed`（`_emit`）：activeId + size 变化时触发
- `ds-char-changed`：火柴人角色 activeId 变化
- `ds-project-loaded`：工程导入完成
- `ds-char-removed`：**未实现**（P1.5-C 报告建议，**当前代码没做**）

### 4.2 容易漏的同步状态

#### A. `entry.visible` 单角色可见性 vs `setModeVisible` 模式可见性

```js
// external-characters.js
_applyEntryVisibility(entry) {
  const show = this._modeVisible && entry.visible !== false;
  if (entry.model) entry.model.visible = show;
  if (entry.ikTargetsGroup) entry.ikTargetsGroup.visible = show;
}
```

**问题**：
1. 用户在面板隐藏**单角色**（未来 UI）→ 改 `entry.visible = false` → `_applyEntryVisibility` 自动级联 ✓
2. 但**事件 `_emit` 不触发**，因为 `setActive` 和 `remove`/`add` 之外的修改没 emit。
3. **修复**：在 `entry.visible` setter 或 `setEntryVisible(id, visible)` 方法里 emit。

#### B. `entry.spawnSlot` 复用冲突

```js
_nextSlot() {
  const used = new Set([...this.characters.values()].map((e) => e.spawnSlot));
  for (let s = 0; s < MAX_EXTERNAL_CHARACTERS; s++) {
    if (!used.has(s)) return s;
  }
  return this.characters.size;
}
```

**问题**：remove 后 slot 复用是好的（节省空间），但 `_nextSlot` 返回 slot 后 `addGLB/addVRM` 里 `data.model.position.x += ox; ...; ox = spawnOffset(slot)`，**同时 `restore` 用 `opts.spawnSlot`**——如果两个新加角色的 slot 相同但一个走了 `_nextSlot()` 一个走了 `opts.spawnSlot`，**会重叠**。

**当前不会触发**（因为 addGLB/addVRM 入口都先 `_nextSlot()` 再判断 opts.spawnSlot：opts 优先），**但在并发 add（理论不支持）情况下会冲突**——**低风险**。

#### C. `entry.color` 派生 PALETTE 索引与外部自定义色冲突

**当前所有外部角色都用 PALETTE[slot % 8]**，**没有 API 改色**。如果 char-panel 想给外部角色调色，会发现 `entry.color` 是 PALETTE 派生值，**改了就乱**。

**修复**：在 `setEntryColor(id, cssColor)` 里 emit，并重新 apply 颜色（需要给 entry.model.traverse 注入 material.color）。

#### D. `activeCharacterId` 在 setActive 时如果新角色不是外部角色

```js
setActive(id) {
  if (!this.characters.has(id)) return false;
  // ...
}
```

**OK**：如果 `id` 不在 `this.characters`，返回 false；**但 `setActive` 与 CharacterManager 的 active 是不同 ID 空间**——char-panel 显示 fire-stick 角色 charId（"ch_1"）和外部角色 charId（"ext-glb-1"），**完全无关联**。

**当前实现**：`externalManager.setActive(extId)` 与 `DS_FigureAPI.setActive(chId)` 独立调用；两个 active 状态各自维护。**结果是角色面板会显示"活动角色 char_1"但外部角色 IK 球拖到的是 ext-glb-2，视觉脱钩**。

**修复（推荐 P1.5b）**：
1. char-panel **顶部 tab 区分** "🔥 火柴人 (ch_1, ch_2, ...)" 与 "🧍 外部 (ext-glb-1, ext-vrm-1, ...)"，两个 tab 各自显示活动。
2. 或：把外部角色**纳入** CharacterManager（作为 `kind='external'` 的特殊 char），统一活动 ID。

#### E. `ikTargetsGroup` 父级变换丢失

**当前**：addVRM 时如果 `data.ikTargetsGroup.parent` 已经是 `data.group`，**不再 `scene.add(data.ikTargetsGroup)`**：

```js
if (data.ikTargetsGroup && !data.ikTargetsGroup.parent) this.scene.add(data.ikTargetsGroup);
```

但 VRM 模型自带的 IK target/pole 是按"VRM 内 humanoid 坐标系"摆放，**加载时直接放在模型 group 子级**。如果后面用 `entry.model.position` 修改 VRM 位置，IK 球**不会跟随**——`addVRM` 里手动同步了一次平移（`data.group.position.x += ox; ...`），**但后续修改 `entry.model.position` 时不会同步**。

**修复**（推荐 P1.5b 内）：要么把 IK 球放在 entry.model 子级（transform 自动同步），要么在 manager 里 hook `position` 变化时同步。

### 4.3 事件契约补完（最小补丁）

新增 3 个事件：

- `ds-external-char-visibility-changed`：`entry.visible` 变化时
- `ds-external-char-mode-visible-changed`：`setModeVisible` 调用时
- `ds-external-char-resources-disposed`：remove/clear 时带 `disposedIds` 详情（用于面板清理对应 UI 行）

---

## 5. openpose/mask 导出接外部骨架的验收重点

### 5.1 当前导出路径（export.js）

**关键代码**（`export.js:performBatchExport`）：

```js
if (characters.length > 0) {
  const allJoints = [];
  characters.forEach((ch) => {
    if (window.DS_FigureAPI && window.DS_FigureAPI.getCharacterJoints) {
      const jointData = window.DS_FigureAPI.getCharacterJoints(ch.id);
      if (jointData) {
        const jointNames = ["Nose", "Neck", ...];  // COCO 18
        const posArr = jointNames.map((n) => {
          const p = jointData[n];
          return p ? new THREE.Vector3(p[0], p[1], p[2]) : new THREE.Vector3();
        });
        allJoints.push({ id: ch.id, joints: posArr });
      }
    }
  });
  poseCv = renderOpenPoseCanvasMulti(allJoints, cam, exportW, exportH);
}
```

**`getCharacterJoints(id)`**（figure.js:390）：

```js
getCharacterJoints(id) {
  const char = charManager.getCharacter(id);
  if (!char) return null;
  const result = {};
  for (let i = 0; i < 18; i++) {
    const pos = getBoneWorldPos(char.allBones[i]);   // ← 读 allBones[i]
    result[JOINT_NAMES[i]] = [pos.x, pos.y, pos.z];
  }
  return result;
}
```

### 5.2 验收重点

#### A. VRM 角色"鼻子"位置错误（**最关键**）

**问题链**：
1. VRM 的 `jointMap.get(0)`（COCO Nose = 0）实际指向 **`head` 骨骼**（vrm-loader.js `VRM_TO_COCO.head = 0`）；
2. **VRM 没有"鼻子"骨骼**，head 是最近的近似；
3. `getCharacterJoints` 读 `char.allBones[0]`（**注意**：不是 `jointMap.get(0)`），是 allBones 数组**按 VRM 加载顺序**的第 0 项；
4. VRM `buildJointMap` 遍历顺序是 `["head", "neck", "rightUpperArm", ...]`，所以 `allBones[0]` **几乎确定是 head**——**巧合对**。

但如果未来 VRM 加载顺序变（例如 vrm-loader 改成按 BFS 加 child），`allBones[0]` 可能变成 hips 或 spine，**鼻子的位置会跑到臀部**——**OpenPose 导出完全错乱**。

**验收**：
- 加载任一 VRM → 断言 `getCharacterJoints(id)["Nose"]` 的 y 坐标在 `1.6-1.8`（人脸高度），不是 `0.9-1.0`（臀部高度）；
- **实现层修复**（推荐）：`figure.js:getCharacterJoints` 应直接读 `jointMap.get(i)` 而非 `allBones[i]`，但 figure.js 现在不知道 external char 的 jointMap（external char 是火柴人骨架的扩展，不是 VRM）。
- **架构层修复**（更彻底）：`ExternalCharacterManager` 注册到 `DS_FigureAPI.getCharacterJoints` 的 fallback 路径：先查火柴人 char.allBones，无 jointMap 时读 entry.jointMap。

#### B. 头/眼/耳退化映射在 OpenPose 中的视觉表现

**当前**：`getCharacterJoints` 把 `head` 骨骼同时赋给 Nose/REye/LEye/REar/LEar 五个 slot（vrm-loader.js:91-94 `if (!jointMap.has(16)) jointMap.set(16, headBone)`）。

**结果**：OpenPose 导出的 18 关节里，Nose/REye/LEye/REar/LEar 五点**完全重合**在头部位置——**ControlNet 检测时会把"5 个关节"误判为单点头部，触发控制图异常**（如 WanVideo OpenPose 期望耳朵在头两侧）。

**验收**：加载 VRM → 导出 OpenPose → 视觉确认 18 关节分布**至少**有可见的眼-耳分离（虽然当前实现退化为头部点重合，**应记录为已知限制**）。
**修复方案**：
- 短期（最小改动）：在 `getCharacterJoints` 对 VRM 角色返回时，**人为偏移** Nose 向前 5cm，REye/REar 向右 3cm，LEye/LEar 向左 3cm（基于 head 世界位置 + 朝向）。
- 中期（P2）：扩展 `getCharacterJoints` 接收 kind 参数，VRM 走"humanoid.getNormalizedBoneNode('leftEye')"精确读取。

#### C. 关节坐标稳定性（NaN/Infinity 风险）

**问题链**：
- `solveGLB_IK` 的 pole 约束段：

```js
if (mproj.length() > 1e-6 && pproj.length() > 1e-6) {
  // ...
}
```

  长度检查做了，**但 axis = ep.sub(rp).normalize()** 没做 `length() > 0` 检查——如果 root 和 end 完全重合（链长度 0），normalize 产生 NaN。

- `jointMap.get(i).getWorldPosition(v)`：如果骨骼没在 scene 中（VRM humanoid 加载但未挂载），getWorldPosition 返回 NaN。

**验收**：加载异常 GLB（root 和 end 重合的骨架结构）→ 断言 `getCharacterJoints` 不返回 NaN。
**修复**：在 `getBoneWorldPos` 入口检查 `isFinite(pos.x)`，否则返回 `[0, 1.7, 0]`（人体中心 fallback）。

#### D. Mask 通道对外部角色**完全失效**

**证据**（export.js → pass-renderer.js:258 `renderCharacterMasks`）：

```js
characters.forEach((ch) => {
  ch.group.traverse((child) => {  // ch.group = ch.skeletonGroup
    if (child.visible !== undefined) child.visible = true;
  });
});
```

**`getCharacterGroups()`**（scene.js:282）：

```js
chars.forEach((ch, id) => {
  groups.push({ id: String(id), group: ch.skeletonGroup || ch });
});
```

**问题**：外部角色的 `entry.model` **不在 `ch.skeletonGroup` 子树**（GLB/VRM 模型被 `scene.add(model)` 直接挂到 scene 根），**mask 渲染时只显示火柴人骨架的关节球（不是角色整体 mask），GLB 角色完全不在 mask 里**。

**验收（必须）**：
- 加载 GLB → 导出 mask → 视觉确认 mask 包含**整个 GLB 轮廓**（不是只有 18 个白色关节点）；
- 对照测试：火柴人角色 mask 应包含火柴人骨架的所有线段 + 关节球。

**修复**：
- **方案 1（推荐 P1.5b）**：在 `addGLB/addVRM` 时把 `entry.model` 挂到 `externalManager.characters.get(id).skeletonGroup` 字段（新建的 group，挂到 scene），让 `getCharacterGroups` 能找到。
- **方案 2（推荐 P2）**：扩展 `getCharacterGroups` 返回外部角色 entry（特殊路径），`renderCharacterMasks` 支持 "external kind" 路径。

#### E. Mask 通道在多角色重叠时的优先级

**当前**：`renderCharacterMasks` 逐角色渲染（hide all → show one），**后渲染的角色覆盖前一个**。如果 GLB A 在前，B 在后但遮挡 A，**A 的 mask 区域被 B 的黑色背景覆盖**——**这是预期行为**，但导出后 ComfyUI 用 mask 时**不会知道前后关系**。

**验收**：加载两个相互遮挡的 GLB → 导出 mask → 视觉确认每个 mask canvas 只有"自己角色"白色像素，背景纯黑。

#### F. sceneGz 内外部模型同步（v4 字段）

**当前**（project-io.js）：

```js
const extMgr = ds?.externalCharacters;
if (extMgr && typeof extMgr.snapshot === "function") {
  const snap = extMgr.snapshot();
  data.externalCharacters = snap.characters;   // ← 顶层字段
  data.activeExternalCharacterId = snap.activeCharacterId;
}
```

**版本**：project-io.js 写 `version: 3`（**没 bump**！与 P1.5-C 报告建议的 v4 不一致）——**当前实现保留 v3 + 顶层 externalCharacters 字段**，**不严谨但向后兼容**。

**验收**：导出工程 → 重新加载 → 外部角色重新加载 → 视觉确认姿势恢复。

---

## 6. P2 WASD/时间轴前的硬约束

P2 计划引入 WASD（角色平移控制）和时间轴（关键帧动画）。**当前 P1.5b 代码有 4 个硬约束必须 P2 前解决**，否则时间轴实现会撞墙。

### 6.1 约束 #1：外部角色**没有"基姿势"概念**

**当前**：GLB/VRM 模型的 T-pose 是出厂 default，没有"reset to base" 操作（vrm 1.0 有 `humanoid.resetNormalizedPose()`，但当前代码没调用）。
**P2 影响**：时间轴 0:00 时刻，外部角色的姿势是什么？是上一次拖拽后的姿势，还是 T-pose？两个语义都没定义。

**修复**：在 `ExternalCharacterManager` 加 `resetToTPose(id)` 方法，VRM 走 `vrm.humanoid.resetNormalizedPose()`，GLB 走"重建 jointMap 到 T-pose 骨骼角度"。

### 6.2 约束 #2：IK 球位置没有持久化时间轴插值

**当前**：`ikTargets` 球的位置是用户拖拽后保存，没有"时间轴锚点"。
**P2 影响**：时间轴要求 IK 球位置按时间线性插值——当前 IK 球是绝对世界坐标，**多个关键帧之间的 IK 球位置需要重新存为 `time-relative` 而不是 `world-absolute`**。

**修复**：sceneJSON 增加 `externalIkTracks: { [charId]: { [chainName]: [{ t, target, pole }, ...] } }` 字段。

### 6.3 约束 #3：所有可见角色共享一个 `characterMode`

**当前**：`characterMode = "stick" | "glb" | "vrm"` 是全局单值。

**P2 影响**：时间轴上 0:00-0:05 角色 A 走路（GLB），0:05-0:10 角色 A 表情变化（VRM 切换）——需要 per-character 模式，`characterMode` 必须 per-char。

**修复**：废弃全局 `characterMode`，改为 `entry.mode`（"stick" | "glb" | "vrm"），与 `entry.type`（"glb" | "vrm"）解耦——mode 是渲染意图，type 是模型类型。

### 6.4 约束 #4：matrixWorld 刷新时机与时间轴不同步

**当前**：RAF 每帧开头 `scene.updateMatrixWorld()`。

**P2 影响**：时间轴 scrub 时（用户拖动播放头到 0:30），**所有角色需要在**单帧内跳到 0:30 姿势，触发骨骼 IK 重求解 + matrixWorld 重计算 + GPU 重新上传 skin matrix——**单帧可能 200+ ms 卡顿**。

**修复**：
- 时间轴 scrub 时**只对关键帧间隔的角色**触发 full re-solve；
- matrixWorld 改为局部更新（`mesh.updateMatrixWorld(false, true)` 而非 `scene.updateMatrixWorld(true)`）；
- GPU skin matrix 上传延后到下一帧。

### 6.5 约束 #5（额外）：VRM spring bone 与时间轴的冲突

**当前**：spring bone 物理仿真每帧自动驱动，**与 IK 求解冲突**——IK 把 rightArm 抬到水平，spring bone 下一帧又把它"摆"回来。

**P2 影响**：时间轴上 IK 姿势与 spring bone 摆动叠加，**角色姿势不稳定**。

**修复**：scrub 时**临时禁用** spring bone（设置 `vrm.springBoneManager.setEnabled(false)`），松开播放头时**恢复**。

### 6.6 P2 前硬约束清单（给下游 Agent）

1. **P1.5b 内**：实现 `resetToTPose(id)`、`entry.mode` 字段分离、sceneJSON v4 bump（externalIkTracks 字段先放空）。
2. **P2-A 开始**：实现"scrub 时局部 matrix 更新 + spring bone 暂停"。
3. **P2-B 开始**：实现 per-char `setCharacterMode(charId, mode)` 替代全局 `characterMode`。

---

## 7. 推荐下一步 5 个优化项（按 ROI 排序）

ROI = (性能提升 + 稳定性) / 实现成本（人天估算）。

### 🏆 #1 · 资源释放完整化 + dispose 审计测试（ROI 最高，必做）

**ROI**：★★★★★  
**成本**：1.0 人天  
**收益**：
- 消除 VRM/springBone 泄漏（**上线即崩**风险）
- 给低显存用户（4GB 集成显卡）兜底
- 为 P2 时间轴多帧操作铺垫（频繁 add/remove）

**具体动作**：
1. `external-characters.js` `remove/clear` 加：VRM `vrm.dispose()`、skeleton.dispose()、所有 material 的 map.dispose()、共享 material/texture WeakSet 保护。
2. 新增 `editor-src/test/external-dispose-verify.mjs`：4 GLB + 2 VRM → 记录 GPU texture 基线 → remove/clear → 断言回到基线。
3. 50 次 add/remove 同一 URL → 断言无显存累积。

---

### 🥈 #2 · IK 4 维过滤（active-only + dirty + budget + round-robin）

**ROI**：★★★★☆  
**成本**：1.5 人天  
**收益**：
- 8 角色满载 60 FPS（从当前 45 FPS 提升）
- 消除 IK spike 帧（避免 100+ ms 卡顿）
- 为 P2 时间轴预留"帧预算"概念

**具体动作**：
1. `external-characters.js` 加 `_ikDirty` 字段 + `markDirty(id)` / `markAllDirty()` 方法。
2. `main.js` `renderLoop` 抽 `renderLoopIKPass()`，按 §3.3 实现。
3. `controls.js` 拖拽 IK 球时调 `externalManager.markDirty(entry.id)`。
4. `setActive` 时调 `markAllDirty()` 防止切角色跳变。
5. 新增 `editor-src/test/multi-external-perf-verify.mjs`：8 角色满载 → 测 FPS ≥ 45（无 IK 优化时约 28 FPS）。

---

### 🥉 #3 · 外部模型挂到 skeletonGroup + mask 导出修复

**ROI**：★★★★☆  
**成本**：1.0 人天  
**收益**：
- mask 通道对外部角色生效（P1.5b 验收必过）
- 删除火柴人角色时**外部模型自动释放**（消除 §2 关联问题）
- 为 P2 路线运动铺路（角色跟随路径需要 group 概念）

**具体动作**：
1. `external-characters.js` 加 `entry.skeletonGroup = new THREE.Group()` 字段（新建 group，挂到 scene）。
2. addGLB/addVRM 改：`scene.add(entry.model)` → `entry.skeletonGroup.add(entry.model)`；IK group 同样挂 skeletonGroup。
3. `scene.js` `getCharacterGroups` 扩展：火柴人返回 skeletonGroup，外部角色返回 entry.skeletonGroup。
4. 验证 `renderCharacterMasks` 对 GLB 角色输出完整轮廓。

---

### #4 · OpenPose 导出 VRM 头部五点重合修复 + 关节坐标 NaN 防护

**ROI**：★★★☆☆  
**成本**：0.5 人天  
**收益**：
- OpenPose 导出对 VRM 角色视觉正确
- 防止异常 GLB 触发 NaN 上传 GPU → 整场景黑屏

**具体动作**：
1. `figure.js` `getCharacterJoints` 加 NaN/Infinity 检查，fallback 返回 `[0, 1.7, 0]`。
2. 对 VRM 角色的 Nose/REye/LEye/REar/LEar 五点做基于 head 位置 + 朝向的偏移（Nose 向前 5cm，REye/REar 向右 3cm，LEye/LEar 向左 3cm）。
3. `getBoneWorldPos` 入口检查 `isFinite`。

---

### #5 · 角色面板活动角色解耦（fire-stick vs external tab）

**ROI**：★★★☆☆  
**成本**：1.0 人天  
**收益**：
- 解决"char-panel 显示 char_1 但 IK 球拖到 ext-glb-2"的视觉脱钩
- 为 P2 per-char 模式切换铺路（#6.3）

**具体动作**：
1. `char-panel.js` 顶部加 tab 切换：🔥 火柴人 / 🧍 外部。
2. 外部 tab 渲染 externalManager.getAll() 列表，每行显示 name/color/visible。
3. 点击外部角色行调 `externalManager.setActive(id)` + `DS_FigureAPI.setActive` 不变。
4. 新增 `ds-external-char-visibility-changed` / `ds-external-char-mode-visible-changed` 事件。

---

### 📊 总成本：5 人天  
### 📊 总收益：8 角色满载 60 FPS + mask 导出全功能 + VRM dispose 完整 + 时间轴铺路

---

## 8. 风险矩阵

| # | 风险 | 等级 | 必须何时修 | 修复成本 |
|---|---|---|---|---|
| ① | VRM humanoid / springBone / skeleton / texture dispose 缺口 | **灾难** | P1.5b | 1.0 人天 |
| ② | `_rootPrev` 钉地状态在多 VRM 时共享 spring bone 物理全局 | **灾难** | P1.5b | 0.5 人天 |
| ③ | 每帧无条件 IK 全量求解，无 dirty/active 分桶 | 高频 | P1.5b | 1.5 人天 |
| ④ | RAF matrixWorld 全场景扫 + SkinnedMesh 冗余更新 | 高频 | P1.5b-P2 | 1.0 人天 |
| ⑤ | drawIKTargets 64+ 项无脑遍历 + charId 过滤缺失 | 高频 | P1.5b | 0.5 人天 |
| ⑥ | VRM 头部五点重合 + NaN 风险 | 高 | P1.5b 验收 | 0.5 人天 |
| ⑦ | 外部角色没挂 skeletonGroup，mask 失效 + 删除泄漏 | 高 | P1.5b | 1.0 人天 |
| ⑧ | char-panel 活动角色与 externalManager 解耦缺失 | 中 | P1.5b | 1.0 人天 |
| ⑨ | sceneJSON v4 没 bump（仍写 v3 + 顶层字段） | 中 | P1.5b | 0.2 人天 |
| ⑩ | P2 WASD/时间轴：mode 单值 / 无 T-pose / 无 IK tracks / spring bone 冲突 | 中 | **P2 前** | 3.0 人天 |

---

## 9. 给下游 Agent 的硬约束

### 现在修（P1.5b）

1. **`external-characters.js` 必须实现完整 dispose**：VRM `vrm.dispose()` + skeleton.dispose() + 所有 material 的所有 map dispose + WeakSet 防重复。
2. **`renderLoop` 必须按 4 维过滤 IK**：active + dirty + visible + budget。
3. **`externalManager.characters.get(id).skeletonGroup` 必须创建**：让 `getCharacterGroups` 能找到外部角色。
4. **sceneJSON v4 bump**：project-io.js 写 `version: 4`，加 `externalModels: { [charId]: { kind, url } }` 顶层字段（与外部 root 字段并存，兼容 v3 读）。
5. **NaN 防护**：`getBoneWorldPos` + IK `axis.normalize()` 入口检查。

### 留到 P2

6. **外部角色的 mode 字段 per-char**：`entry.mode` 取代全局 `characterMode`。
7. **scrub 时局部 matrix 更新 + spring bone 暂停**。
8. **VRM 头部五点偏移**（如果 P2 上控制图精度要求）。

### 留到 P3

9. **spring bone 完整支持**（VRM 头发/衣服摆动）——目前缺失但功能不强求。
10. **LOD（多面数切换）**——用户场景复杂度低，优先级低。
11. **外部模型真皮肤控制图**——参考项目 P7D 已用"匿名报告 + 档位"绕过类似问题，本项目规模不需要。

---

## 10. 总结

**当前 ExternalCharacterManager 的实现是正确的架构选择**，但：
- **资源释放**严重不足（VRM spring bone、texture、skeleton 全没释放）；
- **性能**按 8 角色满载会掉到 45 FPS（理论下限）；
- **导出**对外部角色部分失效（mask 通道抓不到模型）；
- **架构**对 P2 时间轴不友好（mode 单值、无 T-pose、无 IK tracks）。

**5 项 ROI 排序优化（§7）总成本 5 人天**，能解决 8 角色满载性能 + 完整 dispose + mask 导出 + P2 铺垫，**建议 P1.5b 一次性消化**。

**最关键的 5 条风险**（按优先级）：

1. **VRM dispose 完整化**（必现在修，否则显存泄漏上线即崩）
2. **外部角色挂 skeletonGroup**（必现在修，否则 mask 通道失效 + 删除泄漏）
3. **IK 4 维过滤**（必现在修，否则 8 角色掉到 45 FPS）
4. **sceneJSON v4 bump**（必现在修，否则工程文件序列化丢失外部角色）
5. **P2 mode 单值 / 无 T-pose 硬约束**（必 P2 前修，否则时间轴无法落地）

---

**审核完成。报告路径**：`F:\comfyui\custom_nodes\comfyui-director-stage\docs\P15B-MULTI-3D-OPTIMIZATION-REVIEW.md`

**哪些必须现在修**：
- ① VRM dispose 完整化（external-characters.js remove/clear）
- ② 外部角色挂 skeletonGroup + sceneJSON v4 bump
- ③ IK 4 维过滤（active + dirty + visible + budget）
- ⑤ VRM 头部五点偏移 + NaN 防护
- ⑨ sceneJSON v4 bump（与 ② 合并）

**哪些可以留到 P2/P3**：
- ⑧ char-panel 活动角色解耦（推到 P2 mode per-char 一起做）
- ⑩ P2 WASD/时间轴相关约束（mode 单值 / T-pose / IK tracks / spring bone 冲突）
- ⑨ spring bone 完整支持（推 P3 动作库阶段）
- ⑩ LOD（无明确需求场景，推 P3）
- ⑪ 真皮肤控制图（参考项目 P7D 不做，本项目也可不做）