# P3-1-C 「删除火柴人，只保留 3D角色」架构审查报告

> **作者**：P3-1-C 迁移审查员（subagent，不写源码/测试）
> **日期**：2026-07-23
> **任务边界**：仅审查架构、给出迁移建议与风险清单；不动任何 `src/` 或 `test/`
> **审查对象**：`editor-src/src/main.js`、`external-characters.js`、`controls.js`、`scene.js`、`serialization.js`、`project-io.js`、`export.js`、`undo.js`、`nodes.py`、`web/js/directorStage.js`、`docs/P1-P3-PLAN.md`、`docs/P30-3D-ACTION-PRESET-REVIEW.md`
> **前序文档**：`docs/P30-3D-ACTION-PRESET-REVIEW.md`（已读，关键决策：默认 3D角色 + 自定义骨骼线 + procedural 动作）
> **改动红线**：当前工作树有大量未提交改动，必须全部保留；**禁止 git reset/checkout/回退**

---

## 0. TL;DR

✅ **3D-only 是合理方向**：P1.5/P3-0 已经把「外部角色」从单例升级成 `ExternalCharacterManager`，架构基础扎实（8 角色上限、独立 IK target/pole、自动错位出生、序列化/恢复、动作系统）。**理论上删除火柴人是可行的**，但物理删除（删 `figure.js` / `DS_FigureAPI`）代价远大于"逻辑禁用"。

⚠️ **不建议一次性物理删除 `figure.js` 和 `DS_FigureAPI`**。理由：
- `figure.js`（552 行）同时承载 M1 单角色 + M2 多角色两套契约，`DS_FigureAPI` 是工程文件 `characters[].color/joints/ikTargets` 解析的唯一通路；
- 21 项既有回归（`smoke-2d`、`multi-char-verify`、`prop-drag-verify`、`prop-restore-verify`、`glb-character-verify`、`glb-multi-character-verify`、`glb-multi-export-verify`、`external-char-panel-verify`、`external-dispose-verify`、`orbit-verify`、`pick-verify`、`webgl-mode-verify`、`fallback-mode-verify`、4 个 action-preset/dispose 验证等）中**至少 8 项硬编码 `DS_FigureAPI` 调用**；
- `sceneGz` M0/M1/M2 旧工程文件加载走 `applyDecodedToManager` → `manager.create` → **必须 `DS_FigureAPI` 在线**；离线后所有旧工程恢复会崩。

**推荐路径**：**P3-1-A 逻辑禁用（首次落地）→ P3-1-B 物理清理（二次落地）**，中间间隔 ≥ 2 周让生产环境验证旧工程兼容。

| 关键发现 | 等级 | 详见 |
|---|---|---|
| `DS_FigureAPI` 被 8+ 处硬编码；删则旧工程/回归/导出全崩 | 🔴 灾难 | §1.1 |
| sceneGz v0/v1/v2 三代格式 + sceneJSON v3 不同步；版本统一未做 | 🔴 灾难 | §2 |
| scene.js `drawFrame` 与 `figure.js updateBones` 是核心耦合点，删除后导出/depth/normal/preview/mask 走样 | 🔴 灾难 | §1.2 |
| `controls.js getPickableObjects` 外部模式分支已经能优雅退到 3D角色 IK 球 | 🟢 可用 | §1.3 |
| 默认 3D角色自动加载失败回退火柴人（main.js:649-660）路径依赖 `figure.js`；删除后无兜底 | 🟡 高频 | §1.4 |
| undo 走 `multiCharSnapshot`/`multiCharRestore` → 100% 依赖 `DS_FigureAPI` | 🟡 高频 | §1.5 |
| `export.js performBatchExport` 的 openpose 分支既支持外部 entry 又回退 DS_FigureAPI；删除则无回退 | 🟡 高频 | §1.6 |
| 教程/hint/错误提示散落在 5+ 文件，文案与 characterMode 强耦合 | 🟡 高频 | §5 |
| 测试 `editor-src/test/multi-char-verify.mjs` 等硬编码 DS_FigureAPI 路径 | 🟡 高频 | §1.7 |

---

## 1. 火柴人链路 vs 3D-only 兼容性梳理

### 1.1 `DS_FigureAPI` 依赖矩阵（核心耦合点）

`DS_FigureAPI` 在 `figure.js:557-633` `exposeAPI()` 注册，提供以下 14 个方法。当前代码被引用的位置：

| API 方法 | 调用方（编辑器侧） | 调用方（导出侧） | 评估 |
|---|---|---|---|
| `getActiveCharacter` | `controls.js:296/572`、`_dsRef.joints/bones getter`、`char-panel.js`、`main.js` 多处 | `export.js` 隐式（via `_dsRef.joints`） | 🔴 必保留 |
| `getAllCharacters` | `controls.js:574`、`project-io.js`、`undo.js multiCharSnapshot`、`main.js` | `export.js resolveExportCharacters` 回退路径 | 🔴 必保留 |
| `getCharacter(id)` | `controls.js _resolveDragChar`、`project-io.js` | 无 | 🟡 短期保留 |
| `createCharacter/addCharacter` | `char-panel.js`、`project-io.js`、`main.js setupProtocol`、`undo.js` | 无 | 🔴 必保留（applyDecodedToManager 用） |
| `removeCharacter` | `char-panel.js`、`project-io.js`、`main.js setupProtocol`、`undo.js` | 无 | 🔴 必保留 |
| `setActive` | `controls.js 1-9 快捷键`、`setupPointerEvents _activateCharOfObj`、`undo.js`、`project-io.js` | 无 | 🔴 必保留 |
| `getCharacterJoints` | `export.js performBatchExport` | 🔴 openpose 必需 | 🔴 必保留 |
| `getCharacterCount` | `char-panel.js` | 无 | 🟢 可重构 |
| `getJointWorldPos` | 测试钩子 | 无 | 🟢 可删 |
| `getManager` | `serialization.js encodeSceneGz`、`project-io.js`、`main.js encodeCurrentSceneGz` | 无 | 🔴 必保留 |
| `applySpheresToBones` | `setupProtocol` 恢复 | 无 | 🟡 短期保留 |
| `applyPoseToActive` | `pose-panel.js loadPoseLibrary/mirrorPose`、`main.js`、`project-io.js` | 无 | 🟡 保留为 3D角色代理 |
| `getCharacterList` | `char-panel.js` | 无 | 🟢 可重构 |

**结论**：14 个 API 中 9 个 🔴 必保留，3 个 🟡 短期保留，2 个 🟢 可删。**一次性物理删除不可行**。

### 1.2 `figure.js` 的"无法绕过"功能点

`figure.js` 不是单纯画火柴人，还承担：

| 功能 | 行号 | 是否可绕过 | 3D-only 替代方案 |
|---|---|---|---|
| `createJoints / createBones / updateBones`（M1 单一关节组） | figure.js:113/115/117，`main.js:121-124` | ❌ 删不动 | 用 external entry 的 jointMap 替代；`main.js:121-124` 必须重写 |
| `T_POSE` 加载 | figure.js:13 import | ❌ M0/M1 旧 sceneGz 必须 | 仍需保留，仅不再显示 |
| `CharacterManager.characters` Map | figure.js:51 | ❌ 旧工程恢复路径 | 必保留，"空跑"即可 |
| `Joint spheres` + 18 关节 | figure.js:99-122 | ❌ | 保留 invisible |
| `IK_CHAINS` (limb chain definitions) | figure.js:14 import + 153-170 | ❌ | 保留 |
| `applySpheresToBones`（FK → bone 反算） | figure.js:670-680 | ❌ | 保留 |
| `applyPoseToActive`（姿势库加载） | figure.js:595-625 | ❌ | 保留为外部 entry 代理（用 entry.jointMap 的对应 bone 反算） |
| 关节子树联动拖动 | 由 `controls.js collectDescendants/applyBoneLock` 接管 | ✅ | 已解耦 |

**结论**：删除 `figure.js` 会破坏 M0/M1 sceneGz 兼容 + 姿势库加载 + 多角色切换。需要：
- 把 `Joint spheres` 节点设为 `visible=false` 但**保留在 scene 树中**（已经在 `main.js:342 figureGroup.visible = isStick` 路径上）；
- `CharacterManager` 保留作为"空架子"，不画但 `snapshot/restore` 正常工作。

### 1.3 `controls.js getPickableObjects` 外部模式分支 ✅ 已优雅

`controls.js:283-330` 已实现外部模式拾取走 `mgr.characters.values()` 枚举 IK 球。**3D-only 下不需要修改 controls.js 的核心拾取逻辑**——只要 `externalMode === true` 命中，进入现有外部分支。

**但仍需修改**：
- `controls.js:230 _resolveDragChar` 仍调 `window.DS_FigureAPI.getAllCharacters` 拿角色 ID → 如果 `DS_FigureAPI` 注销，外部 IK 球的 `userData.externalCharId` 已足够（main.js:251-253），**这段可安全删除**；
- `controls.js:498-499` 键盘快捷键 1-9 切角色 → 3D-only 下应切外部角色，**改成遍历 `mgr.characters.values()`**；
- `controls.js:584-590 performUndo/Redo` 走 `DS_FigureAPI` 路径 → 3D-only 下应**新增外部 entry 的 undo 路径**（详见 §1.5）。

### 1.4 默认 3D角色自动加载失败回退（main.js:649-660）

```js
setTimeout(() => {
  if (externalManager.size > 0 || externalManager._restorePending) return;
  if (window.__ds_externalRestored) return;
  loadMoreGLB("/director_stage/models/ue-mannequin-retopology.glb", { silent: true })
    .catch((e) => console.warn("[3D导演台] 默认 3D角色自动加载失败（保持火柴人模式）:", e?.message || e));
}, 800);
```

**3D-only 影响**：
- 如果删火柴人，**"保持火柴人模式"作为回退分支必须改成 toast 错误**："未找到默认 3D模型，请手动 ➕添加GLB 或导入工程文件"；
- 用户体验：默认 3D角色加载失败 → 编辑器无角色 → 视口空白 → 用户不知道发生了什么。

**建议**：保留 `figure.js` + `DS_FigureAPI`（哪怕 disabled），作为**永久回退兜底**。理由：
- 网络抽风、磁盘 IO 抽风、CORS、parser 失败、显存不够 → **任何一项都可能让默认 GLB 加载失败**；
- 删火柴人 = 把"兜底降级"删了，违反 P30 §1.2.A 推荐路径。

### 1.5 `undo.js multiCharSnapshot/multiCharRestore`（undo.js:34-100）

```js
function multiCharSnapshot() {
  const api = window.DS_FigureAPI;
  if (!api || !api.getCharacterCount()) return null;
  // 遍历全部 characters 写关节 + IK targets
  ...
}
```

**3D-only 影响**：
- `multiCharSnapshot` 100% 走 `DS_FigureAPI.getAllCharacters()`；
- 用户拖外部角色 IK 球 → `pushUndo(null)` → 走多角色分支 → **外部 entry 没进栈** → 用户 undo → **撤销的是默认火柴人**（如果有）或空操作（如果只有外部角色）。

**P30 已警示**（§2.3）：需要把 `externalManager.getAll()` 串进多角色快照。**3D-only 阶段必做**：
- 改 `multiCharSnapshot` 为：`{ v: 3, chars: {...}, external: { [id]: { joints, ikTargets, modelTransform } }, activeId, extActiveId }`；
- `multiCharRestore` 同步支持外部 entry（通过 `externalManager` 的 `_restoreSnapshot` 类似路径）；
- 旧 `v: 2` 快照依然能恢复（向后兼容）。

### 1.6 `export.js performBatchExport` openpose 分支（export.js:215-252）

```js
characters.forEach((ch) => {
  if (ch.external) {
    allJoints.push({ id: ch.id, joints: extractExternalJoints(ch.entry) });
    return;
  }
  if (window.DS_FigureAPI?.getCharacterJoints) {
    const jointData = window.DS_FigureAPI.getCharacterJoints(ch.id);
    ...
  }
});
```

**3D-only 影响**：
- `resolveExportCharacters`（export.js:67-86）已实现"外部模式优先 + 火柴人回退"路径；
- 删火柴人后 `resolveExportCharacters` 永远走 `mgr.getAll()` 分支，**不需要修改主逻辑**；
- 但 `performApply`（export.js:296-353 M1 单机位兼容路径）仍走 `getSceneCamera()` + `renderOpenPoseCanvas(joints, cam, ...)` + `_dsRef.joints`（main.js:1168 起）—— 单角色时强制走火柴人；
- 3D-only 下：`performApply` 必须改用外部 entry；或者**新增 `performApply3D`** 路径；或者在 `getCharacterGroups`（scene.js:243-256）返回空时自动 fallback 外部 manager。

### 1.7 测试套件对 `DS_FigureAPI` 的硬依赖

| 测试 | 是否走 DS_FigureAPI | 影响 |
|---|---|---|
| `smoke-2d.mjs` | 走 `setupProtocol` → `restoreCharactersFromSnapshot` → `DS_FigureAPI.create` | 🔴 删除必崩 |
| `multi-char-verify.mjs` | 同上 | 🔴 |
| `prop-drag-verify.mjs` | 走 `setActive` 间接 | 🟡 |
| `prop-restore-verify.mjs` | 走 snapshot/restore | 🔴 |
| `glb-character-verify.mjs` | 走 `externalManager` + 测试 `__ds.glbData` | ✅ 不依赖 |
| `glb-multi-character-verify.mjs`（21 项） | 同上 | ✅ |
| `glb-multi-export-verify.mjs`（16 项） | 走 `externalManager` + `extractExternalJoints` | ✅ |
| `external-char-panel-verify.mjs`（13 项） | 同上 | ✅ |
| `external-dispose-verify.mjs`（22 项） | 走 `externalManager.clear()` | ✅ |
| `webgl-mode-verify.mjs` | 走渲染管线 | ✅ |
| `fallback-mode-verify.mjs` | 走 `renderMode` | ✅ |
| `pick-verify.mjs` | 走 `setupPointerEvents` → `_resolveDragChar` → `DS_FigureAPI` | 🟡 |
| `orbit-verify.mjs` | 走 OrbitControls | ✅ |
| `external-action-presets-verify.mjs`（20 项） | 走 `actionRuntime` | ✅ |

**总计 13 个文件受影响**，删除 `DS_FigureAPI` 等于重写 ≥ 5 个测试。

### 1.8 `nodes.py` 后端

`nodes.py` 完全不依赖 `DS_FigureAPI`（只看 manifest/sceneGz/sceneJSON 字符串）。**3D-only 不影响后端**。

---

## 2. sceneJSON / sceneGz 版本迁移建议

### 2.1 当前状态（已发现的 bug 与不一致）

| 字段 | 当前值 | 来源 | 问题 |
|---|---|---|---|
| `SCENE_VERSION` 常量 | `2` | `constants.js` | 被 `serialization.js` 读 |
| `project-io.js` 写 `version: 3` | `version: 3` | `project-io.js:18` | 与 `SCENE_VERSION` 不一致 |
| `buildSceneJSON` 写 `version: 2` | `version: 2` | `main.js:1102` | 又改回 2 |
| `serialization.js` 解码 `v >= 2` 容错 | 隐式 | `serialization.js:152` | v3 工程文件走兼容分支时**丢失** externalCharacters |

**最大风险**：**当前 v3 工程文件包含 `externalCharacters` 字段**，但 `applyDecodedToManager` 不知道，**恢复时 18 关节恢复但 GLB/VRM 角色丢失**。

### 2.2 推荐统一方案

#### A. 立即统一 `SCENE_VERSION = 4`（P30 §6.2 已建议）

```text
// constants.js
SCENE_VERSION = 4
SCENE_GZ_VERSION = 4    // sceneGz 头（用于 §3 中迁移测试）
SCENE_PROJECT_VERSION = 4  // sceneJSON 头（与 P1.5/P3-0 保持一致）
```

**Bump 流程**：
1. `serialization.js encodeSceneGzV2` 改名为 `encodeSceneGzV4`，写 `v: 4`；
2. 解码分支：`v == 1` → M1 兼容；`v == 2` → M2 兼容；`v == 3` → P1.5 v3 兼容；`v == 4` → 当前 v4；
3. **v3 兼容必须写**：把 `v3.data.externalCharacters` 提取出来，作为"恢复 externalManager 的提示"（而非兼容误读）；
4. `project-io.js collectSceneData` 写 `version: 4`；
5. `main.js buildSceneJSON` 写 `version: 4`。

#### B. sceneJSON v4 新增字段（最小可用）

```text
{
  version: 4,
  timestamp: ...,
  cameras: [...],
  props: [...],
  sceneSettings: {...},
  focalLength: 35,
  sceneGz: "...",
  // ─── 新增 ───
  characterMode: "stick" | "glb" | "vrm",  // 顶栏模式（旧工程缺省 "stick"，新工程默认 "glb"）
  skeletonVisible: { [charId]: { bones, joints } },
  externalCharacters: [...],  // 已有，但 §6 提议统一
  activeExternalCharacterId: "ext-glb-1"
}
```

**3D-only 后**：
- `characters` 字段（figure.js CharacterManager 出来的火柴人）→ **保留字段但永空数组**（不写 `data.characters = []`）；
- 旧工程（`characters.length > 0`）→ 加载时**忽略 characters 内容**，迁移到默认 GLB（详见 §6）；
- `characterMode` 强制 `"glb"`（v4+ 不允许 stick）。

#### C. sceneGz v4 vs sceneJSON v4 职责分离（沿用 P30 §6.2.C）

- **sceneGz**：当前帧快照 + 当前模式（stick/glb/vrm）；不写动作时间轴（clip 体积大）；
- **sceneJSON**：完整工程 + 时间轴 + 资产 URL；
- 3D-only 后 sceneGz 仍然写**默认角色（外部 entry）的 18 关节**，因为 ComfyUI 节点读取 sceneGz 拿姿势参考——**这个不能删**。

### 2.3 不建议做的事

- ❌ **不要 bump 到 v5**：本阶段一次性 v4 落地；
- ❌ **不要删除 M0/M1 兼容解码**：参考 P15B §6 经验，保留兼容比加新功能重要；
- ❌ **不要把 externalCharacters 从 sceneGz 搬到 sceneJSON 后又搬回去**：sceneGz 必须保留外部 entry 的 18 关节（用于跨视图同步）。

---

## 3. 导出只保留 3D角色时的通道验收重点

### 3.1 openpose（最高优先级）

**当前 3D角色 openpose 链路**（`export.js:225-237`）：
```js
if (ch.external) {
  allJoints.push({ id: ch.id, joints: extractExternalJoints(ch.entry) });
  return;
}
```

`extractExternalJoints`（export.js:99-126）从 `entry.jointMap` 按 COCO-18 提取世界坐标。

**3D-only 验收重点**：

| 验收点 | 优先级 | 当前实现评估 |
|---|---|---|
| **多 3D角色同图输出**（不重叠） | 🔴 P0 | `renderOpenPoseCanvasMulti` 已知支持；但**所有角色绘制到一张图**时，深度排序缺失（前面角色遮挡后面角色关节）。**3D-only 后必须做深度排序**（按 entry.model.position.z 升序 / 透视变换后 z 排序） |
| **关节缺失兜底**（GLB 没有骨骼对应某 COCO 索引） | 🔴 P0 | `extractExternalJoints` 已用 `[0,0,0]` 兜底。**3D-only 后验收**：载入 3 个不同 GLB，导出 openpose，每个角色的 18 关节都要绘制或明确缺失（不能丢点） |
| **位置精度（mm 级）** | 🟡 P1 | `toFixed(4)` 已实现。验收：3D 角色站立姿势 18 关节与 Three.js `getWorldPosition` 一致 |
| **VRM 头部五点偏移**（P15B §5.B 警示） | 🟡 P1 | VRM 头部的 5 关键点（Nose/Eye/Ear）经常集中在 ~3cm 范围，**3D-only 后验收必须用测试矩阵**（载入 mixamo/ue/vrm 三个模型） |
| **跨相机多机位 openpose** | 🟡 P1 | 当前每相机投影调用 `jointMap.get(i).getWorldPosition` → `THREE.Vector3().project(cam)`。3D-only 后验收：3 机位 × 3 角色 = 9 张图，骨架位置各不相同 |
| **IK 球导出** | 🟢 P2 | 当前 IK target/pole 不进入 openpose。**3D-only 后评估是否导出**：通常 openpose 只画人体关节，但 IK 球位置对 WanVideo 有用（控制场景运动） |

### 3.2 depth（WebGL depth shader）

**当前 3D角色 depth 链路**（`pass-renderer.js renderDepthCanvas`）：
- 把 `scene` 整体传给 WebGL renderer；
- `entry.model`（外部 GLB SkinnedMesh 树）参与渲染；
- `entry.ikTargetsGroup` 在 export.js:179 被加入 `hiddenObjects` 列表，**正确隐藏**（IK 球不污染 depth）。

**3D-only 验收重点**：

| 验收点 | 优先级 | 评估 |
|---|---|---|
| **多角色 depth 排序** | 🔴 P0 | WebGL depth buffer 自动处理，但**IK 球未正确隐藏**会导致 depth 在特定位置出现 0.05 半径球体。验收：`extractExternalJoints` 的 `[0,0,0]` 兜底不会画到 depth（GLB 没那点），但 IK 球必须隐藏 |
| **角色 mask 与 depth 对齐** | 🔴 P0 | mask 与 depth 应共享 projection。当前 `renderCharacterMasks`（pass-renderer.js）遍历每个角色独立渲染 mask。**3D-only 后验收**：用 mask 重叠 depth，mask 范围与 depth 像素吻合 |
| **背景（地面/网格/坐标轴）已隐藏** | 🟡 P1 | `hiddenObjects = [grid, axes]` 已实现（export.js:169-176） |
| **光线/阴影深度** | 🟢 P2 | WebGL depth shader 通常不依赖灯光。验收 depth 仅反映几何距离 |

### 3.3 normal（法线）

**当前 3D角色 normal 链路**：`pass-renderer.js renderNormalCanvas` 走 WebGL 着色器输出 normal vector。

**3D-only 验收重点**：

| 验收点 | 优先级 | 评估 |
|---|---|---|
| **SkinnedMesh 蒙皮法线** | 🔴 P0 | GLB SkinnedMesh 在 IK 解算后法线可能滞后（`updateMatrixWorld` 未触发）。验收：`entry.model.updateMatrixWorld(true)`（export.js:102 已做），normal 与 IK 解算后姿势一致 |
| **VRM 弹簧骨骼法线** | 🟡 P1 | springBone 在 export 时若仍在运行，normal 每帧抖动。**验收**：导出前 `springBoneManager.setEnabled(false)`（P15B §3.5 警示，本阶段暂不影响 3D-only 但留好接口） |
| **共面法线（如平面地面）** | 🟢 P2 | WebGL normal shader 通常用 `vec3(0,1,0)` 兜底 |

### 3.4 lineart（深度+法线派生）

**当前 3D角色 lineart 链路**（`export.js:269-279`）：
```js
const depthCv2 = renderDepthCanvas(...);
const normalCv2 = renderNormalCanvas(...);
const lineartCv = renderLineartCanvas(depthCv2, normalCv2, w, h);
```

**3D-only 验收重点**：

| 验收点 | 优先级 | 评估 |
|---|---|---|
| **深度法线对齐** | 🔴 P0 | depth + normal 必须同一帧渲染（避免角色运动时两张图错位）。**验收**：导出 1 秒序列帧，逐帧 depth/normal/lineart 角色轮廓吻合 |
| **角色身体 vs 衣服边缘** | 🟡 P1 | 当前 lineart 来自 depth+normal 边缘检测，**可能把衣服褶皱当成身体边缘**。验收：3D 角色 + 简单衣物 GLB，lineart 应保留轮廓 |
| **多角色 lineart 遮挡** | 🟡 P1 | 多 3D角色相互遮挡时，lineart 应画出双方轮廓。当前实现：每个角色独立画 lineart，**遮挡关系丢失**。验收：2 角色前后站立，lineart 显示遮挡边界 |

### 3.5 mask（角色 mask）

**当前 3D角色 mask 链路**（`pass-renderer.js renderCharacterMasks`）：
- 给每个角色一个 unique material color；
- 单独渲染该角色的 mask；
- 输出 N 张 mask PNG。

**3D-only 验收重点**：

| 验收点 | 优先级 | 评估 |
|---|---|---|
| **mask 边缘与 depth 对齐** | 🔴 P0 | 当前 `renderCharacterMasks` 通过 `scene.overrideMaterial` 单角色渲染。验收：mask 边缘与 depth 角色边界吻合 |
| **VRM spring bone 不污染 mask** | 🔴 P0 | VRM 头发等 spring bone 骨骼可能在 mask 范围外但仍属该角色。验收：3D-only 后若启用 VRM，VRM 头发动画不超出 mask |
| **多角色 mask 互不重叠** | 🟡 P1 | 当前每角色独立渲染，mask 互不重叠（good）。**验收**：3 角色站立，3 张 mask 像素和 = depth 中所有角色像素 |
| **隐藏角色不出现在 mask** | 🟡 P1 | `entry.visible === false` 的角色不应有 mask。验收：手动 hide 一个角色，导出时 mask 数量 = visible 角色数 |

### 3.6 preview（灰模光影参考）

**3D-only 验收重点**：

| 验收点 | 优先级 | 评估 |
|---|---|---|
| **材质/光照/阴影在 WebGL 视口与导出一致** | 🟡 P1 | 同一 renderer 同一光源设置，验收应通过 |
| **角色透明/镂空材质** | 🟢 P2 | 透明 GLB 在 WebGL 渲染可能异常。验收：透明/Alpha 测试 GLB 不出现"黑块" |

---

## 4. 3D角色整体移动的正确实现平面与同步对象清单

### 4.1 现状（main.js:475-489 "整人移动" 开关）

```js
wholeBodyCheckbox.addEventListener("change", () => {
  window.__ds_moveWholeBody = wholeBodyCheckbox.checked;
  showToast(wholeBodyCheckbox.checked ? "🧍整人移动：拖任一关节平移整个人" : "🧍整人移动已关闭", false);
});
```

`controls.js:445-462 moveDrag()` 实现整人移动：

```js
if (window.__ds_moveWholeBody && !dragObj.userData.ikType && dragChar && dragInitial && dragJointIdx >= 0) {
  const dx = dragObj.position.x - dragInitial[dragJointIdx][0];
  ...
  for (let i = 0; n = joints.length; ...) {
    joints[i].position.set(...);
  }
  return;
}
```

**当前实现的致命问题**：

| 问题 | 后果 | 评估 |
|---|---|---|
| **只动关节球（jointSpheres）**，没动 `entry.model.position` | 拖关节后 GLB 模型不动，**关节球飞出去** | 🔴 灾难 |
| 关节球是 `entry.model` 的子节点 | 关节球世界坐标 = `entry.model.matrixWorld * jointSpheres.position` | 如果只改 `jointSpheres.position`，关节球世界坐标变了但模型未动；IK 求解反向求 `entry.allBones[i].position` 用世界坐标，**模型骨骼仍然在原位** |
| 整人移动后 `entry._ikDirty` 没设 | 下一帧 IK 求解用旧位置，模型还是原位 | 🔴 |

### 4.2 3D-only 下的正确实现平面

**核心原则**：**3D角色整体移动必须在 `entry.model`（THREE.Object3D）层操作，不在 jointSpheres 层**。

```text
// 概念实现（不写代码）：
// 1) 鼠标 down 命中 IK 球或关节球（屏幕空间拾取）
// 2) beginDrag 时记录 entry.model.position / quaternion
// 3) 拖拽中：计算 delta（屏幕 → 地面平面交点 delta）
// 4) entry.model.position = entry.model.position + delta
// 5) 同步 entry.ikTargetsGroup.position（IK 球跟着角色平移）
// 6) 同步 entry.allBones[i].localPosition = (localPos)  // 不需要，因为 model 平移自动带动子级
// 7) entry._ikDirty = true
```

### 4.3 同步对象清单

3D角色"整体移动"必须同步的对象（按层级）：

| 对象 | 是否需要手动同步 | 原因 |
|---|---|---|
| `entry.model` (Object3D) | ✅ 是 | 整人移动的根，所有子级跟随 |
| `entry.skeleton` | ❌ 否 | `entry.model` 子级，自动跟随 |
| `entry.allBones[i]` | ❌ 否 | 骨骼在 skeleton 内，骨骼 quaternion 决定姿势；整人移动不影响姿势 |
| `entry.ikTargetsGroup` | ✅ 是 | IK target/pole 球与 model 平级（外部 manager 创建后 add 到 scene），**不会跟随 model 平移**——必须手动同步 |
| `entry.ikTargets[chain].target.position` | ✅ 是 | 在 `ikTargetsGroup` 内，group 平移后 target/pole 自动跟随；但 `target.userData.externalCharId` 等元数据保留 |
| `entry.jointMap` 中的骨骼引用 | ❌ 否 | 骨骼引用自身，整人移动不破坏引用 |
| `char.skeletonGroup` (figure.js 角色) | N/A | 3D-only 已删，**但若保留 figure.js 作为兼容层，整人移动时也需要同步**——这部分可忽略 |
| `ds.scene` 内其他依赖该角色的引用 | ⚠️ 视情况 | action-runtime 采样骨骼世界坐标时用 `getWorldPosition`（自动跟随 model）；skeletonHelper 用 SkeletonHelper（自动跟随） |

### 4.4 拖拽平面选择

**3D 拖拽平面应该是 X/Z 地面**（与 `props.js` 的 PropManager 一致）：

```text
// 推荐：沿用 PropManager 的 plane=ground 拖拽策略
dragPlane.setFromNormalAndCoplanarPoint(cameraUp, entry.model.position);
// 用户拖动时：
// - 鼠标 X 移动 → entry.model.position.x += deltaX
// - 鼠标 Y 移动 → entry.model.position.z += deltaZ（注意是 Z 不是 Y）
// - Alt 键按住 → 改 entry.model.position.y（升降）
```

**理由**：
- 当前 `controls.js:412` 用相机视线方向作平面法线，**适合单关节摆姿势但不适合整人移动**——会导致 entry.model 在 Y 轴意外漂移；
- 整人移动应**限定在地面平面**，符合用户直觉。

### 4.5 同步时序

```text
拖拽开始 (pointerdown):
  - 记录 entry.model.position.copy() → entryStartPos
  - 记录 entry.ikTargetsGroup.position.copy() → ikStartPos
  - entry._ikDirty = true

拖拽中 (pointermove):
  - 计算 delta = (currentGroundHit - startGroundHit)
  - entry.model.position.copy(entryStartPos).add(delta)
  - entry.ikTargetsGroup.position.copy(ikStartPos).add(delta)
  // 不需要 markIKDirty（model 平移不影响 IK 求解参数）

拖拽结束 (pointerup):
  - pushUndo({ entry, snapshot })  // 记录 entry.model.position
  - entry._ikDirty = true  // 收尾清理，让下一帧 IK 求解稳定
```

### 4.6 与现有「🧍整人移动」开关的关系

**建议**：3D-only 后**保留** `__ds_moveWholeBody` 开关，但语义改为：
- ON → 拖关节 / IK 球 → 整人平移（操作 `entry.model.position`）；
- OFF → 拖关节 → 子树摆姿势（操作 `jointSpheres[i].position`）；
- 拖 IK 球 → 不论开关，**永远**只移动 IK target/pole（FK/IK 模式选择）。

**当前实现需要重写**：见 §4.1 的致命问题。

---

## 5. 删除火柴人 UI 后用户教程/hint/错误提示改动清单

### 5.1 顶栏 hint 文案（main.js:836-840）

**当前文案**：
```
左键拖对象 | 空白拖动转视角 | 道具默认地面X/Z | Alt+拖道具=升降 | Ctrl+1~9切机位
```
（`DS_FigureAPI` 不存在时 fallback：
```
左键选关节拖动 / 空白处拖动转视角 / 右键平移 / 滚轮缩放
```
）

**3D-only 改动建议**：
- 删除 `if (!window.DS_FigureAPI)` 整段分支（API 永久存在但不一定展示火柴人）；
- 主 hint 加：**「拖手脚青色/黄色 IK 球摆姿势 | 整人移动开关 🧍 ON 后拖任一关节平移角色」**；
- 默认 hint 文案：
```
拖手脚 IK 球摆姿势 | 空白转视角 | 道具 X/Z 拖动 | Alt+拖道具=升降 | Ctrl+1~9 切机位 | 🧍整人移动开关 ON=拖关节平移
```

### 5.2 顶栏角色 UI 元素（main.js injectTopbarControls）

**3D-only 删除**：
- `🔄3D角色` 按钮（main.js:507-521）—— 切换 stick/glb/vrm 不再需要
- `charMgrUI`（createCharPanel 创建）—— 多火柴人管理面板
- `charPanel` 内部 `loadPoseLibrary`（pose-panel.js）—— 18 关节姿势库**保留但禁用**，或加 "已迁移到 GLB 姿势"提示

**3D-only 保留**：
- `extCharUI`（createExternalCharPanel）—— 外部 3D角色管理面板
- `addExtBtn`（➕添加GLB）—— 主入口
- `skeletonLabel`（🦴骨骼）—— 骨骼显示开关

**3D-only 新增**：
- 单一"角色"概念：用户面对的是 `externalManager` 的 entry 列表；
- 工具栏中"🦴FK / 🦴IK"模式切换**改为仅 IK 模式**（外部 GLB/VRM 必须 IK 求解）；
- 旧 IK 复选框 `ikCheckbox`（main.js:434-449）保留但**强制 checked + disabled**。

### 5.3 姿势库（pose-panel.js）

**当前**：内置 18 关节 JSON 姿势库（`/director_stage/poses/*.json`）。

**3D-only 改动建议**：
- 选项 A（保留兼容）：姿势库**保留**，但 `loadPoseLibrary` 回调改为通过 `entry.jointMap` 把 18 关节位置应用到活动外部 entry 的对应骨骼；
- 选项 B（重做姿势库）：新姿势库以 GLB 模型骨骼名 + COCO-18 映射为单位，重新收集；
- **推荐 A**：最小改动 + 旧姿势库资产不浪费。

### 5.4 错误提示（main.js showToast 调用点）

**当前 25+ 个 toast 调用点**，3D-only 后需要修改或删除：

| 调用点 | 文件:行 | 3D-only 改动 |
|---|---|---|
| `showToast("最多 8 人", false)` | figure.js:67 | 🟢 删（上限改外部 8 人，但 toast 由 external-char-panel 接管） |
| `showToast("已添加「${c.name}」", false)` | main.js:325 | 🟢 改文案为「3D角色已添加（外部）」 |
| `showToast("至少保留 1 人", false)` | main.js:341 | 🟢 删 |
| `showToast("视角已保存到当前机位", false)` | main.js:200 | ✅ 保留 |
| `showToast("已切换到 3D角色（拖手脚 IK 球摆姿势）", false)` | main.js:650 | ✅ 保留 |
| `showToast("3D角色加载失败：...")` | main.js:631 | ✅ 保留，但文案加"请检查 /director_stage/models/ 目录" |
| `showToast("GLB 加载失败", true)` | main.js:631 | ✅ 保留 |
| `showToast("🦴IK模式：拖手脚球摆姿势")` | main.js:441 | 🟢 删除 FK 模式（永远 IK） |

### 5.5 控制台错误日志

**当前调用**：`console.error/warn` 出现在 figure.js、external-characters.js、project-io.js、protocol.js。

**3D-only 改动**：
- 删除 `CharacterManager.create` 警告（figure.js:60 "已存在"）—— CharacterManager 不再被前端调用；
- 保留 `external-characters.js addGLB/addVRM` 警告；
- `project-io.js` 旧工程加载错误保留（这是兼容性关键）。

### 5.6 文档与教程

| 文件 | 3D-only 改动 |
|---|---|
| `README.md` | "添加火柴人" 章节改 "添加 GLB 3D角色"；多火柴人截图换外部角色截图 |
| `docs/P1-P3-PLAN.md` §P1.5 章节保留（外部角色上线记录）；§P3-0 章节加 "P3-1 删除火柴人" 决策 |
| `docs/MULTI_CHAR_CONTRACT.md` | **重写**：删除 "figure.js CharacterManager" 契约，保留 "externalManager" 契约 + 8 角色上限 + IK 球拾取 |
| `docs/DESIGN.md` | 加 "3D-only 架构" 章节 |

### 5.7 内置 18 关节姿势库资产

`/director_stage/poses/*.json` 资产（约 10+ 个 JSON）：

**3D-only 路径**：
- 选项 A：保留但标记 deprecated；
- 选项 B：删除但保留 demo_pose.json 作为"教程示例"；
- 选项 C：迁移到 GLB 骨骼名映射（投入大，不建议本阶段）。

**推荐 B**：保留 1 个示例 pose.json，加 README 注释。

---

## 6. 旧工程恢复策略

### 6.1 三种候选策略

| 策略 | 优点 | 缺点 |
|---|---|---|
| **A. 忽略火柴人** | 简单；旧工程立刻能加载（除姿势外）；零破坏 | 旧姿势丢失；用户困惑"角色去哪了" |
| **B. 迁移姿势到默认 GLB** | 旧姿势"在"新角色上；UX 好 | 实现复杂；COCO-18 → GLB 骨骼映射表需要测；不同 GLB 骨骼命名差异大 |
| **C. 提示不兼容** | 最诚实；强制用户用 v3+ 工程 | UX 差；旧用户必须重新摆姿势 |

### 6.2 推荐方案：A + B 混合（按"姿势来源"分流）

**主策略 A**（默认）：
- 旧工程（M0/M1/M2/v3 sceneGz）加载时，**只恢复 cameras / props / sceneSettings / focalLength**；
- 火柴人 `characters` 字段**整体忽略**（不报错，但 console.warn 提示）；
- `externalCharacters` 字段 → 走 `externalManager.restore`（既有路径）；
- 顶栏 toast：`「已加载工程（v3 兼容模式）：火柴人角色已迁移为默认 3D角色」`。

**辅助策略 B**（可选）：
- 当旧工程 `data.characters.length > 0` 且 `data.externalCharacters.length === 0` 时，**自动加载默认 GLB**（silent 模式），并把第一个火柴人的 18 关节位置映射到该 GLB 的 COCO-18 骨骼；
- 映射逻辑：`entry.jointMap.get(i).position.copy(decoded.joints[i])` + `entry._ikDirty = true`；
- 第二个及以后的旧火柴人 → **新建一个 GLB entry**，spawn slot 递增；
- 此策略的好处：用户打开旧工程立刻看到"姿势在 3D角色上"。

**策略 C 不用**：当前用户量未到必须强制升级的程度。

### 6.3 实现要点

```text
// 概念实现（不写代码），在 project-io.js _doImport 中：
if (data.characters && data.characters.length > 0) {
  // 兼容模式：旧工程的火柴人数据
  if (data.version < 4) {
    if (data.externalCharacters && data.externalCharacters.length > 0) {
      // 既有 v3 路径：走 externalManager.restore
      // 不要做"火柴人姿势迁移"，避免与外部角色姿势冲突
    } else {
      // 纯旧工程：自动加载默认 GLB + 迁移第一个火柴人的姿势
      await loadDefaultGLBInBackground(); // silent
      const entry = externalManager.getActive();
      if (entry && data.characters[0].joints) {
        for (let i = 0; i < 18; i++) {
          const bone = entry.jointMap.get(i);
          const p = data.characters[0].joints[i];
          if (bone && p) bone.position.fromArray(p);
        }
        entry._ikDirty = true;
        window.__dsSetCharacterMode?.("glb");
      }
    }
  }
}
```

### 6.4 测试要求

新增 3 个迁移测试（建议文件名）：

| 测试名 | 验证内容 |
|---|---|
| `migration-v1-to-3d-only.mjs` | 载入 v1 sceneGz（纯 joints 数组），验证：default GLB 自动加载 + 18 关节映射到 GLB 骨骼 |
| `migration-v2-to-3d-only.mjs` | 载入 v2 sceneGz（含 multi-char），验证：每个火柴人变成一个 GLB entry，spawn slot 正确 |
| `migration-v3-to-3d-only.mjs` | 载入 v3 sceneJSON（含 externalCharacters），验证：externalCharacters 完整恢复，旧 characters 字段忽略不报错 |

### 6.5 不建议做的事

- ❌ **不要在 project-io.js 里硬编码 `data.characters.length > 0` 时 throw 错误**：会破坏所有旧工程加载；
- ❌ **不要为每个 GLB 模型提供不同的 COCO-18 映射表**：维护成本高，P3-1 阶段不投入；
- ❌ **不要把旧工程"姿势迁移失败"当成 toast error**：console.warn 即可，UX 优先。

---

## 7. 必须验收的 12 项清单

> 本阶段「删除火柴人，只保留 3D角色」完成判定。打 ✅ 才算 release-candidate。

| # | 验收项 | 优先级 | 验证方式 | 关联风险 |
|---|---|---|---|---|
| 1 | **逻辑禁用火柴人（而非物理删除）**：`figure.js` + `DS_FigureAPI` 保留，但 `figureGroup.visible = false` 永久生效；`createJoints/createBones/updateBones` 调用不报错 | P0 | `logical-disable-verify.mjs`：编辑模式下 `figureGroup.visible === false`；调 `DS_FigureAPI.createCharacter` 不抛错 | §1 |
| 2 | **默认 GLB 启动链路零阻塞**：协议 recall 后 ≤ 3s 内 scene tree 完整；默认 GLB 失败 → 自动加载第 2 个 GLB 或 toast 提示（**不**回退火柴人） | P0 | `auto-load-default-verify.mjs`：fetch 失败 → toast 出现 + 不黑屏 | §1.4 |
| 3 | **默认 GLB + 火柴人同存时 openpose 不重叠**：3D-only 后默认无火柴人，但**保留的火柴人（hidden）不应进入 openpose 列表** | P0 | `compat-hidden-fire-stick-verify.mjs`：hidden 火柴人不出现在 `extractExternalJoints` 或 `getCharacterJoints` 输出 | §1.6 |
| 4 | **整人移动（🧍）正确实现平面与同步对象**：拖关节 / IK 球 → `entry.model.position` 平移；`entry.ikTargetsGroup` 同步；`entry._ikDirty` 设置 | P0 | `whole-body-move-verify.mjs`：拖 IK 球后 `entry.model.position` 变化 + `model.position.y` 不漂移 + IK 求解后姿势不变 | §4 |
| 5 | **多 3D角色 openpose 深度排序**：3 个 3D角色站立，前/中/后顺序正确 | P0 | `openpose-depth-sort-verify.mjs`：3 角色导出 openpose，按 z 排序前后，关节不被前景角色遮挡（前景在前） | §3.1 |
| 6 | **sceneJSON v4 bump + 兼容**：v1/v2/v3 工程文件加载后 round-trip v4 | P0 | `scene-migration-verify.mjs`：载入 v1/v2/v3 三个 mock + 重存 = v4，旧 `characters` 字段被忽略但 console.warn | §2.2 |
| 7 | **sceneGz v4 bump + 兼容**：v1/v2 sceneGz 解码 → 默认 GLB 自动加载 + 姿势迁移；v3 sceneGz 含 externalCharacters 完整恢复 | P0 | `sceneGz-migration-verify.mjs`：v1 → 默认 GLB + 18 关节映射；v3 → externalCharacters 完整 | §2.2 |
| 8 | **hint 文案 + 错误提示动态切**：3D-only 模式下 hint 不再有 "拖关节"；火柴人加载/移除 toast 改为外部角色 toast | P0 | `hint-mode-verify.mjs`：hint 文本不含"火柴人"，含"IK 球摆姿势" | §5 |
| 9 | **姿势库兼容**：旧 `poses/*.json`（18 关节）可应用到活动外部 entry | P0 | `pose-library-compat-verify.mjs`：加载 wave.json → 活动外部 entry 的 rightShoulder/rightElbow 骨骼位置变化 | §5.3 |
| 10 | **undo 覆盖外部 entry 拖拽**：拖 IK 球 → undo → 拖前位置恢复；外部 entry 的 model.position + ikTargets 同时进栈 | P0 | `undo-external-entry-verify.mjs`：拖 IK 球 → undo → entry.ikTargets 位置恢复 + entry.model.position 恢复 | §1.5 |
| 11 | **导出多角色 mask / depth / normal / lineart 排序正确**：mask 与 depth 边界吻合；多角色 lineart 遮挡边界可见 | P0 | `multi-export-3d-only-verify.mjs`：3 角色 × 4 通道，mask 像素和 = depth 角色像素和（±5%） | §3.4/§3.5 |
| 12 | **既有 13 项回归 100% 通过**（含 9 项 GLB/external 验证 + smoke-2d + multi-char + prop-drag + prop-restore + orbit + pick） | P0 | 跑现有 `editor-src/test/*.mjs` 全部 | §1.7 |

**附加硬约束（来自 P30 §11）**：
- 既有 21 项 P1.5/P3-0 回归必须 100% 通过；
- VRM spring bone 隔离（即使 3D-only 不默认用 VRM，也要保留接口）；
- 自定义骨骼线（非 SkeletonHelper）跨 WebGL/2D 双模可见。

---

## 8. 最重要 5 条风险

> **按概率×影响排序**，给 §7 的 P0 项做支撑。

### 🔴 #1 `DS_FigureAPI` / `figure.js` 物理删除 → 旧工程恢复全崩（最关键）
- **问题**：`DS_FigureAPI` 被 `serialization.js encodeSceneGz`、`project-io.js _doImport`、`undo.js multiCharSnapshot`、`scene.js drawFrame` 等 9+ 处硬编码；`figure.js createJoints/createBones/updateBones` 被 `main.js:121-124` 调用；删除任何一个都会让 M0/M1/M2/v3 旧工程加载抛错；
- **不修复后果**：用户报"打开旧工程黑屏/无角色" → 项目不可用；
- **必做路径**：**保留** `figure.js` + `DS_FigureAPI` 作为兼容层 + sceneGz 解析路径；`figureGroup.visible = false` 永久生效；3D-only 是"逻辑禁用"不是"物理删除"；
- **关联**：§1、§7 #1/#6/#7、§8 推荐路径。

### 🔴 #2 整人移动（🧍）当前实现只动 jointSpheres → 3D角色"原地不动，关节球飞出去"
- **问题**：`controls.js:445-462` 整人移动分支只修改 `jointSpheres[i].position`，没有同步 `entry.model.position`；3D角色 GLB 模型仍在原位；下一帧 IK 求解反推骨骼位置，**模型与关节球双双错位**；
- **不修复后果**：🧍开关对 3D角色完全失效；用户拖关节看到"鬼影"；
- **必做路径**：整人移动改为操作 `entry.model.position`（详见 §4.2-4.5）；同步 `entry.ikTargetsGroup.position`；设置 `entry._ikDirty = true`；拖拽平面改为 X/Z 地面；
- **关联**：§4、§7 #4。

### 🟡 #3 sceneJSON v3 + sceneGz v2 不同步 → 旧工程 v3 加载丢失 externalCharacters
- **问题**：`project-io.js:18` 写 `version: 3`、`serialization.js` 读 `SCENE_VERSION = 2`、`main.js buildSceneJSON:1102` 又写 `version: 2`；sceneGz 解码容错 `v >= 2` 静默通过 v3 数据，**externalCharacters 字段丢失**；
- **不修复后果**：用户打开含外部角色的旧工程，3D角色丢失（只剩火柴人或空白）；
- **必做路径**：本阶段统一 `SCENE_VERSION = 4`；3 处对齐；sceneJSON v4 + sceneGz v4 双轨；新增迁移测试 `scene-migration-verify.mjs` + `sceneGz-migration-verify.mjs`；
- **关联**：§2、§7 #6/#7。

### 🟡 #4 undo 多角色快照未覆盖外部 entry → 3D-only 用户拖 IK 球撤销无效
- **问题**：`undo.js multiCharSnapshot` 100% 走 `DS_FigureAPI.getAllCharacters()`；外部 entry 没进栈；用户拖 IK 球 → `pushUndo(null)` → 走多角色分支 → 撤销的是火柴人关节或空操作；
- **不修复后果**：3D-only 后用户用 🦴IK 摆姿势，Ctrl+Z 无反应；
- **必做路径**：`multiCharSnapshot` 升级为 `{ v: 3, chars, external: { [id]: {...} }, activeId, extActiveId }`；同步支持外部 entry 的 model.position + ikTargets 恢复；
- **关联**：§1.5、§7 #10。

### 🟡 #5 默认 GLB 加载失败 + 火柴人兜底删除 → 启动失败即空白
- **问题**：当前 `main.js:649-660` 默认 GLB 自动加载失败时 console.warn（不弹窗），"保持火柴人模式"作为兜底；如果火柴人删除，**用户面对空白编辑器**；
- **不修复后果**：用户报"打开页面是空的，什么都没有"；
- **必做路径**：保留火柴人作为永久兜底（哪怕 invisible）；默认 GLB 失败时弹 toast 错误 + 引导用户 ➕添加GLB；console.warn 升级为 `showToast`；
- **关联**：§1.4、§7 #2、§5.4。

---

## 9. 决策汇总（一次性物理删除 figure.js / DS_FigureAPI？）

### 9.1 ❌ 不建议一次性物理删除

**理由**（按 ROI 排序）：
1. **依赖太多**：14 个 API 中 9 个 🔴 必保留，13 个测试受影响，9+ 处硬编码——一次性物理删除等于重写整个编辑器 + 13 个测试 + sceneGz 解析；
2. **兼容成本极高**：M0/M1/M2/v3 工程文件恢复路径全部依赖 `DS_FigureAPI.create/applyPoseToActive`；删了 = 旧工程全部失败；
3. **兜底成本极高**：默认 GLB 加载失败的兜底路径就是火柴人；删了 = 用户面对空白；
4. **业务收益不高**：物理删除 `figure.js` 节省 552 行代码 + 减少一处攻击面，但**保留它只增加 ~30 行初始化 + 3 行 visible 控制**；
5. **风险不可逆**：物理删错了，回滚 = git revert，但**生产环境的旧工程文件加载路径已损坏**——线上事故。

### 9.2 ✅ 推荐路径：分两阶段落地

#### P3-1-A（本周内）：逻辑禁用
- `figureGroup.visible = false` 永久生效（main.js 一行修改）；
- 顶栏 🔄3D角色按钮删；
- char-panel 火柴人列表组件隐藏（保留 DOM 但 CSS `display: none`）；
- hint 文案改为 3D-only（§5.1）；
- 姿势库 `poses/*.json` 改为"应用到活动外部 entry"（§5.3）；
- 既有 13 项回归 + 4 个新迁移测试 100% 通过；
- 阶段标志：`IS_3D_ONLY = true`（main.js 顶栏硬编码）；
- **代码改动量**：~150 行；测试新增：~120 行 × 4 个。

#### P3-1-B（2 周后，二次落地）：物理清理
- 删除 `figure.js`；
- 删除 `DS_FigureAPI`；
- 删除 `char-panel.js` 火柴人部分（保留外部角色面板）；
- 删除 pose-panel.js M1 路径；
- 移除 `characters` 字段在 `project-io.js collectSceneData`（保留兼容读取但永空）；
- 移除 sceneGz 中 `chars` 字段（保留解码兼容但不用）；
- 移除 `multiCharSnapshot` 改用 `multiExternalSnapshot`；
- 阶段标志：完全删除。
- **代码改动量**：~300 行删除 + ~150 行重写；测试修订：~80 行 × 6 个。

#### 中间间隔 ≥ 2 周的理由
- 让生产环境验证 §7 的 12 项验收；
- 让 13 个回归测试在 P3-1-A 阶段充分暴露问题；
- 让旧工程兼容性有缓冲期（用户有时间升级工程）；
- 让 `multiExternalSnapshot` 有 2 周实测稳定性。

### 9.3 ⏸️ 暂不做（边界）
- ❌ 不做表情驱动（推 v2.x）；
- ❌ 不做 Spring Bone 优化（推 v2.x）；
- ❌ 不做 LOD（参考 P15B §6.4 决定）；
- ❌ 不做 VRM 头部五点偏移修复（3D-only 阶段默认 GLB mannequin）；
- ❌ 不做 per-char characterMode 字段（暂时全局 + per-entry 切换）；
- ❌ 不做"姿势库资产重做"（保留兼容）。

### 9.4 决策点

**给后续 Agent 的三个硬决策**：
1. **本周 P3-1-A**：逻辑禁用 ✅ 同意；物理删除 ❌ 推迟 2 周；
2. **sceneJSON v4 bump**：✅ 同意本周做（依赖前置，所有 v4 测试需要）；
3. **默认 GLB 失败回退**：✅ 同意保留火柴人作为永久兜底（哪怕 invisible）；失败 toast 提示用户手动 ➕添加GLB。

---

## 10. 总结

P3-1「删除火柴人，只保留 3D角色」是**架构上正确的方向**（架构基础已扎实）：
- ExternalCharacterManager 已落地 8 角色上限 + 自动错位 + IK target 独立；
- scene.js drawFrame 与 controls.js getPickableObjects 已有外部模式分支；
- 姿势库 18 关节可映射到 entry.jointMap；
- 13 项既有回归已覆盖外部角色全路径。

**但物理删除 figure.js / DS_FigureAPI 不可行**：
- 9 个 API 🔴 必保留（序列化/恢复/导出/undo）；
- 13 个测试硬依赖；
- 旧工程兼容路径全部走 `DS_FigureAPI.create/applyPoseToActive`；
- 默认 GLB 加载失败需要火柴人兜底。

**核心 5 条风险已识别**并给出兜底路径：
1. 🔴 物理删除 DS_FigureAPI → 旧工程恢复全崩（保留兼容层）；
2. 🔴 整人移动当前实现 bug → 改为操作 entry.model.position + ikTargetsGroup 同步；
3. 🟡 sceneJSON/sceneGz 版本不对齐 → 本阶段统一 v4；
4. 🟡 undo 不覆盖外部 entry → 升级为 v3 多角色快照；
5. 🟡 默认 GLB 失败兜底缺失 → 保留火柴人 invisible + toast 提示。

**12 项验收**已列出，可直接灌入 P3-1-A/B 测试清单；**推荐分两阶段落地**（P3-1-A 逻辑禁用 → P3-1-B 物理清理），中间间隔 2 周。

---

**报告完成。路径**：`F:\comfyui\custom_nodes\comfyui-director-stage\docs\P31-3D-ONLY-MIGRATION-REVIEW.md`

**5 条风险汇总**：
1. 🔴 DS_FigureAPI / figure.js 物理删除 → 旧工程恢复全崩（保留兼容层）
2. 🔴 整人移动只动 jointSpheres → 改为操作 entry.model.position + 同步 ikTargetsGroup
3. 🟡 sceneJSON v3 + sceneGz v2 不对齐 → 本阶段统一 SCENE_VERSION = 4
4. 🟡 undo 未覆盖外部 entry → 升级 multiCharSnapshot 为 v3 含 external 分支
5. 🟡 默认 GLB 失败 + 火柴人兜底删除 → 保留 invisible 火柴人 + toast 提示用户手动 ➕

**决策汇总**：
- ❌ **不建议一次性物理删除 figure.js / DS_FigureAPI**（依赖太深 + 兼容成本极高 + 兜底缺失 + 业务收益低 + 风险不可逆）
- ✅ **推荐分两阶段**：P3-1-A 本周逻辑禁用 + P3-1-B 2 周后物理清理
- ✅ sceneJSON v4 bump 本周做（依赖前置）
- ✅ 保留火柴人作为永久兜底（哪怕 invisible）
