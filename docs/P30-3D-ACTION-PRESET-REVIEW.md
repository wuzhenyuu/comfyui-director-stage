# P3-0-C 「默认 3D角色 + 骨骼显示 + 动作预设」架构审查报告

> **作者**：P3-0-C 架构审查员（subagent，不写源码/测试）
> **日期**：2026-07-23
> **任务边界**：仅审查架构、给出建议与风险清单；不动任何 `src/` 或 `test/`
> **审查对象**：`external-characters.js` / `main.js` / `scene.js` / `controls.js` / `export.js` / `serialization.js` / `undo.js` / `project-io.js`
> **前序文档**：`docs/P1-P3-PLAN.md`（已读）、`docs/P15B-MULTI-3D-OPTIMIZATION-REVIEW.md`（已读）
> **参考项目**：`F:\openclaw\agents\main\projects\3d-director-desk-ref\` 重点：`MILESTONE-01B-ACTION-RUNTIME-SMOKE.md`、`MILESTONE-02D-ROUTE-HOLD-ACTION-SMOKE.md`、`MILESTONE-03B-COMMUNITY-PRESETS.md`、`MILESTONE-04B-DYNAMIC-BODY-TRACKING-SMOKE.md`、`MILESTONE-05{D,E,F}-*.md`、`MILESTONE-07B-PERFORMANCE-PROFILES.md`
> **改动红线**：当前工作树有大量未提交改动，必须全部保留；**禁止 git reset/checkout/回退**

---

## 0. TL;DR

✅ **方向正确**：把"火柴人退居兼容层 → 默认 GLB 3D角色 + 骨骼显示 + 程序化动作预设"是合理升级路径。参考项目 M1B/M2D/M7B 都已验证"Mixamo FBX 真实运行时 + 多视图一致性 + 性能档位"可行；本项目当前 P1.5b 已落地 ExternalCharacterManager，**架构基础扎实**，本阶段不缺关键能力。

⚠️ **但落地有 8 类明确风险**，其中 4 类必须本阶段先修（不修即回退），2 类建议本阶段做（性能与一致性），2 类推 P3-B/C。

| # | 风险 | 等级 | 必须何时修 | 详见 |
|---|---|---|---|---|
| ① 默认开屏自动加载 GLB → WebGL/资源/cross-origin/慢环境多路径坍塌 | **灾难** | **P3-0 立刻** | §1 |
| ② SkeletonHelper 直接包 SkinnedMesh 时 attached 骨骼也被画、加线性能炸 | **高频** | **P3-0 立刻** | §3 |
| ③ 程序化动作 / Mixamo clip / Pose 三类数据格式不统一 → 时间轴卡死 | **高频** | **P3-0 立刻** | §4 |
| ④ VRM `_rootPrev` 跟全局 `vrm.springBoneManager` 共享状态（P15B-§3 已警示） | **灾难** | **P3-0 内** | §5 |
| ⑤ sceneJSON v3 写"外部 root 字段"而非 bump 到 v4（共存风险） | **高频** | **P3-0 内** | §6 |
| ⑥ 火柴人退居兼容层后：openpose / sceneGz / undo / 教程提示 / 既有 21 项回归 失守 | **高频** | **P3-0 内** | §2 |
| ⑦ action runtime 与 IK dirty 策略耦合，序列化/撤销冲掉动画 | **中** | **P3-B 前** | §5 |
| ⑧ Mixamo/GLB clip/VRMA 接入缺边界（资产管理 / 许可 / 大小） | **中** | **P3-B/C 前** | §7 |

> **同意先做 procedural（程序化）动作而不是 Mixamo** —— 见 §10 与 §0 末尾决策汇总。

---

## 1. 默认自动加载 GLB 的 UX / 性能 / 错误处理风险

### 1.1 现状回顾

`main.js:299-309`：
```js
glbBtn.addEventListener("click", async () => {
  if (externalManager.size > 0) {
    const next = characterMode !== "stick" ? "stick" : (...);
    setCharacterMode(next);
    return;
  }
  await loadMoreGLB();
});
```

`loadMoreGLB` 默认从 `/director_stage/models/ue-mannequin-retopology.glb` 异步加载。当前是**显式点击**才加载。

**P3-0 计划变体**："默认 3D角色"意味着**启动时自动**或**首次进入 3D模式自动**触发 `loadMoreGLB()`，不再要求用户点 ➕。

### 1.2 UX 风险（按优先级）

#### A. 启动链路拉长 → 首屏 1-3 秒黑 / 卡顿

**问题链**：
1. 启动 → `main.js` 同步注册 `setupProtocol`，协议触发 `applySceneSnapshot` → 启动 `externalManager` 异步加载 GLB（默认 URL）；
2. WebGL renderer 在 P1-A 已 lazy 初始化（`scene.js:34 getRenderer()`），但 P1-A 启动阶段就要在 WebGL 模式跑；
3. WebGL 模式 + GLB 加载 + SkeletonHelper 渲染三者并发，`requestAnimationFrame` 首帧可能渲染**未挂载的 GLB**（位置 NaN / 缩放为 0）；
4. 用户看到的就是"打开页面 → 几秒空白 → 突然模型出现"。

**修复建议**（架构层，不写代码）：
- **阶段 A**：先确保协议 recall 完整 + 火柴人可见 → 再异步加载 GLB → 加载完成 → 触发 `setCharacterMode("glb")` + `markAllIKDirty()`，**绝不在协议 recall 阶段阻塞主链路**；
- **阶段 B**：加载期间在视口左上角加"加载 3D角色…"toast + 进度条（已经有 `showProgress` 工具）；
- **阶段 C**：超时熔断：fetch 超过 6 秒（远端/慢磁盘）→ 报错 toast + 自动 `setCharacterMode("stick")` 回退火柴人；
- **阶段 D**：失败熔断：HTTP 404 / CORS / parser error → 同上回退，**不留半挂状态**。

#### B. cross-origin / Content-Security-Policy 风险

**问题链**：
- GLB 文件托管在用户自定义 `/director_stage/models/` 或外部 URL；
- 如果走默认 `/director_stage/models/ue-mannequin-retopology.glb` 但用户没建该目录 → 404；
- ComfyUI 内嵌页面（`web/`）有相对路径限制，file:// 协议下 fetch 报错；
- three-vrm 的 VRM 文件需要 KHR_materials_unlit / VRM 0.x 或 1.0 schema，提前在错误信息里说明"VRM 文件缺失"。

**修复建议**：
- 启动时预探测 `fetch(HEAD /director_stage/models/ue-mannequin-retopology.glb)`，成功才进入"自动加载"分支；
- 失败 → 不切 GLB mode，保持火柴人 + toast 提示"未找到默认 3D模型，点击 ➕手动导入"；
- 把 `defaultGLBUrl` 抽象成 `main.js` 顶部的常量（`DEFAULT_GLB_URL`），失败时无副作用。

#### C. 显存尖刺 → 启动 OOM 风险

**问题链**（P15B-§1.4 警示）：
- 当前 UE mannequin 类 GLB 单个 3-5 MB GPU；
- 默认 8 个角色上限保留（`MAX_EXTERNAL_CHARACTERS = 8`），但**默认只加载 1 个**，GPU 占用 < 10 MB，无 OOM；
- 如果"默认 3D角色"被误解成"加载整套模型库"或"自动补满上限"，立刻爆显存；
- 同时如果视口是 WebGL 模式 + DPR=2 + HiDPI，**单次 `viewportWebGLRenderer` 创建失败也会回退**，但失败前可能 try-create `WebGLRenderer` 已经消耗几百 MB GPU context（驱动层保留资源）。

**修复建议**：
- 默认**严格 1 个**角色，**禁止自动补满**；
- `setupProtocol` 阶段先 `await renderer.info?.memory?.geometries` 探测可用 GPU 显存，>200 MB 才允许 WebGL + 默认 GLB；否则 2D 兜底；
- 现有 2D 兜底链路（P1-B fallback）已经覆盖，继续保留。

#### D. 教程提示 / 首屏教学（用户教育风险）

**问题链**：
- 当前顶栏 hint（main.js 注入）：`"左键选关节拖动 / 空白处拖动转视角 / 右键平移 / 滚轮缩放"`；
- 默认 3D角色模式下，需要提示用户"拖手脚 IK 球摆姿势"；
- 当前 GLB 模式下 hint 仍是 FK 提示（P15B-§2 已知）→ **hint 文案必须根据 characterMode 切**；
- 顶栏「🦴IK 模式切换」勾选在 GLB 模式下默认 ON，但**首屏用户不知道要先勾**。

**修复建议**：
- 进入 GLB mode 自动弹一次**单向**教育卡："拖青/黄 IK 球摆姿势"（不强制拦截操作）；
- 顶栏 hint 文案动态切换：stick 模式 → "拖关节"；glb/vrm 模式 → "拖 IK 球"；
- ✅ 已经有 `showToast` 入口（main.js 用过多次），复用。

### 1.3 性能风险

#### E. 启动 200ms 内 RAF 仍然每帧跑 `solveGLB_IK`

**问题链**（P15B-§3 已警示）：
- 当前 GLB 加载完成 → `setModeVisible(true)` → RAF 下帧开始跑 `solveGLB_IK`；
- 启动后第 1 帧 IK 求解**未稳定**：`entry._rootPrev = new THREE.Vector3(); rootBone.getWorldPosition(...)` 拿的是 **GLB 加载完成前的旧位置**（可能是 NaN / origin）；
- 求解四链 CCD 时 `applyWorldRotation` 用上一帧未对齐的父级四元数 → **首帧手腕位置跳跃到天花板**。

**修复建议**：
- GLB 加载完成 → 主动调一次 `_glbJointRef()` 同步所有关节位置 → `markAllIKDirty(true)` → 等下一帧再 `setModeVisible(true)`；
- 在 `external-characters.js` addGLB 末尾 `_finalizeAdd` 已经 `entry._ikDirty = true`，**符合预期**；但是 main.js 的 `setCharacterMode` 必须**先** mark → 再 render，**确保第一帧 IK 已收敛**。

#### F. 8 角色满载自动启动 → 45 FPS 卡顿（P15B-§3）

- 当前 MAX=8，默认加载 1 不触发，但 UI 不能诱导用户"加到 8 个"以追求"完整场景"；
- 推荐 UI 文案："默认 1 角色 ≥ 60 FPS；多角色请按 [性能档位] 选择"。

---

## 2. 火柴人退居兼容层后，旧链路容易破的地方

> 这是 P3-0 阶段最容易回归的点，**必须给所有 21 项回归测试 + 教程 + sceneGz 兼容留出明确的兼容路径**。

### 2.1 openpose 导出

**当前链路**（`export.js:228-250`）：
```js
characters.forEach((ch) => {
  if (ch.external) {
    allJoints.push({ id: ch.id, joints: extractExternalJoints(ch.entry) });
    return;
  }
  if (window.DS_FigureAPI?.getCharacterJoints) {
    const jointData = window.DS_FigureAPI.getCharacterJoints(ch.id);
    // ...
  }
});
```

**问题**：
1. `characters` 默认来自 `getCharacterGroups()`（scene.js:280）—— 完全读 `DS_FigureAPI`；**默认 GLB 模式下 `DS_FigureAPI` 仍存在**（火柴人不被删除），`characters.length` 是 1（默认火柴人）+ 1（GLB）；
2. 但**最终输出** openpose canvas 同时画两个角色的 18 关节 —— **重叠** 在 GLB 模型骨架位置 + 火柴人骨架位置；
3. P15B-§5.A 已警示 VRM 头部五点重合；**默认 GLB + 火柴人同图输出会让 GLB 头上多 18 个火柴人点**。

**修复建议（必做）**：
- **`characters` 自动剔除被 hidden 的角色** —— 默认 GLB 模式下，**火柴人应自动 `visible=false`**，不再进入导出列表；
- `DS_FigureAPI` 增加 `getCharacterById(id).visible` 字段检查，**导出循环跳过 invisible 角色**；
- 同时调整 `scene.js:304 drawFrame` 的 `externalCharacterMode` 分支：默认 GLB mode 时，**整个火柴人 group 走 hidden 路径**，避免屏幕拾取缓存污染（目前已有 `if (!externalCharacterMode && api)` 守卫，但只隐藏绘制，没隐藏 scene tree）；

**当前实现评估**：`scene.js:299-318` 已用 `externalCharacterMode` 守卫，仅**不画**火柴人；但 scene 树里 figureGroup 还在。`main.js:341-343`：
```js
const isStick = mode === "stick";
figureGroup.visible = isStick;
```
**OK**，已经隐藏 figureGroup；但 `DS_FigureAPI` 仍有 1 个角色 → 导出循环默认会有 1 火柴人 + 1 外部 = **同图重叠**。

> **结论**：必须**新增角色级 `.visible = false`** 同步，或者 `resolveExportCharacters` 在外部模式下**完全跳过火柴人**（推荐前者，更通用）。

### 2.2 sceneGz 兼容（serialization.js）

**当前链路**（`serialization.js:60-100`）：
- `encodeSceneGz` 总是从 `DS_FigureAPI.getManager().characters` Map 读所有火柴人角色；
- 关节位置读 `char.allBones[i].getWorldPosition(...)`，**不读外部 GLB 模型**；
- 旧 M0/M1 格式是 `[ [x,y,z], ...18 ]`，纯关节坐标；M2 v2 是 `{characters: [...]}`。

**问题**：
1. **默认 GLB 模式下，旧 M0/M1 sceneGz 不会丢失** —— fire-stick 始终在 scene 树里（哪怕 hidden）；
2. 但**外部 GLB 角色 pose 不进入 sceneGz**（当前根本不序列化外部角色姿势）；
3. **跨阶段兼容**：如果用户加载旧工程（无 externalCharacters 字段），恢复后默认仍是火柴人，**但 UI 默认显示 GLB** —— 视觉不一致；
4. sceneJSON → sceneGz **双轨**：sceneJSON 走 `project-io.js` 序列化外部 URL（顶层字段），sceneGz 走 `serialization.js` 序列化火柴人。

**修复建议**：
- **sceneGz v4 bump**：在 `encodeSceneGzV2` 末尾注入 `externalClips: { [entryId]: { type: 'glb'|'vrm', joints: [18], ikTargets: {...} } }` 字段；
- **sceneGz 头部升级 `SCENE_VERSION = 4`**（`constants.js`）；
- **解码兼容**：`decodeSceneGz` 对 v < 4 的 sceneGz 走原路径；对 v4 额外恢复 `externalClips`，但**不阻塞**旧管线（外部 clip 暂不入 sceneGz，只在 timeline 阶段启用）。

> ⚠️ **P15B-§6 已警示**："sceneJSON 版本号统一升级留待后续"——本阶段必须顺手做掉。

### 2.3 undo 兼容（undo.js）

**当前链路**（`undo.js:42-95`）：
- `pushUndo(null)` / `performUndo(null)` 走 `multiCharSnapshot` / `multiCharRestore`；
- **完全没碰 externalManager**，undo 不会撤销外部角色 pose / IK 球位置；
- **默认 GLB mode 下，用户拖 IK 球 → undo 不会撤销** —— 这是 P15B-§6 已知边界。

**问题**：
1. 默认 GLB mode 下用户**几乎只能拖 IK 球**（FK 隐藏）；
2. 拖 IK 球 → `pushUndo(null)` 走多角色分支 → 由于 externalManager 没进栈，**undo 看起来"无效"**；
3. 但**实际上** undo 撤销的是图（characterMode 切换时遗留）上的火柴人关节——**这会让人困惑**。

**修复建议**：
- **本阶段最小修复**：`pushUndo(null)` 时，**当 characterMode !== "stick"，把活动外部 entry 的 joints + ikTargets 也加进快照**；
- 快照格式扩展：`{ v: 3, chars: {...}, activeId, extActive: id, externalClips: { id: {...} } }`；
- 配合 §6 的 sceneJSON v4 bump。

### 2.4 教程 / 提示文案

**当前状态**（`main.js:558-561`）：
```js
document.getElementById("hint").textContent =
  "左键拖对象 | 空白拖动转视角 | 道具默认地面X/Z | Alt+拖道具=升降 | Ctrl+1~9切机位";

if (!window.DS_FigureAPI) {
  document.getElementById("hint").textContent =
    "左键选关节拖动 / 空白处拖动转视角 / 右键平移 / 滚轮缩放";
}
```

**问题**：
- 进入 GLB mode 后 hint 仍是 FK 路径；
- 进入 vrm mode 后 hint 文字没变；
- VRM/GLB 模式的"拖手脚 IK 球"是新用户最大盲点。

**修复建议**：
- hint 文案必须动态切：
  - stick：`左键拖关节`；
  - glb/vrm：`拖手脚青色/黄色 IK 球摆姿势`;
- 教程（README）的 21 项回归里如果含 stick 路径文字，**仍需保留 1 屏截图**；GLB 路径加新章节。

### 2.5 既有 21 项回归测试

**当前测试套件**（`editor-src/test/`）：
- `smoke-2d.mjs`
- `multi-char-verify.mjs`
- `prop-drag-verify.mjs`
- `prop-restore-verify.mjs`
- `glb-character-verify.mjs`
- `glb-multi-character-verify.mjs`（21 项）
- `glb-multi-export-verify.mjs`（16 项）
- `external-char-panel-verify.mjs`（13 项）
- `external-dispose-verify.mjs`（22 项）
- `webgl-mode-verify.mjs` / `fallback-mode-verify.mjs`

**潜在回归点**（按风险排序）：

| 测试 | 默认 GLB 模式下风险 | 缓解 |
|---|---|---|
| `smoke-2d.mjs` | force2d=1 后默认加载 GLB 行为是否阻塞首帧？ | 加载标记 in-flight → 2D 模式不画 GLB |
| `multi-char-verify.mjs` | 火柴人多角色 + 默认 GLB 同存：openpose 重叠 | 自动 hide 火柴人 |
| `prop-drag/restore-verify` | 道具场景加载 GLB 不应影响 prop 行为 | GLB 加载与 prop 路径独立 |
| `glb-character-verify` | 默认 GLB URL 变化时测试硬编码失效 | 测试应 fetch URL 列表，不硬编码 |
| `glb-multi-character-verify`（21） | 加 default 自动加载分支 | 加 1 个 `auto-load-default-verify` |
| `external-dispose-verify`（22） | 默认自动加载 → 启动 dispose 测试会失败（GLB 仍在） | 测试启动前 `await manager.clear()` |
| `webgl-mode-verify` | 默认 GLB + WebGL 路径的 ready 状态 | 已覆盖；新加 first-frame no-black |
| `fallback-mode-verify` | force2d 下默认 GLB 不应渲染（only 2D） | 加 explicit assertion |

**建议**：新增 2 个测试 `auto-load-default-verify.mjs` 和 `compat-stick-restore-verify.mjs`，**不删旧测试，保留兼容契约**。

---

## 3. SkeletonHelper vs 自定义骨骼线 选择建议

### 3.1 选项对比

| 维度 | THREE.SkeletonHelper | 自定义 Line/LineSegments |
|---|---|---|
| **实现成本** | 1 行 `new SkeletonHelper(skinnedMesh); scene.add(helper)` | 50-150 行：遍历 allBones、查 parent、世界位置连线 |
| **骨色** | 单一灰白色（不能改） | 可以按 chain / bone / selected 高亮 |
| **joint 显示** | 仅骨头连线，**没有 joint 球** | 可加 BoneSphere，配合 POSE 调试图层 |
| **性能（8 角色×60 骨）** | 8 × SkeletonHelper = 8 × 独立 draw call | 单一 LineSegments 共享 geometry，1 draw call |
| **attached 骨骼** | **Bug**：会画 attached 物体（武器）| 自定义可控 |
| **交互性** | 不可点击 | 可加 raycaster，选中骨骼 |
| **WebGL vs 2D 双模** | WebGL only | 双模通用 |

### 3.2 推荐：自定义骨骼线 + 关节球（双模友好）

**理由**：
1. **当前 2D 编辑器是默认路径**（P1-B force2d=1 + fallback 链），SkeletonHelper **只在 WebGL 路径有效**——2D 模式用户完全看不到骨骼帮助线；
2. **P15B-§1.4 已警告 8 角色满载 → draw call 紧张**——SkeletonHelper 每个角色一个 helper = 多 8 draw call；
3. **attached bone 问题**：UE mannequin 类 GLB 经常 attach 武器 / 配饰到右手骨骼，SkeletonHelper 会**画出来**但语义上**不是"骨架"**；
4. **可点击**：P3-B 时间轴 scrub / 选择骨骼需要骨骼 hit-testing。

**推荐实现架构**：

```text
// 概念分层，不写代码：
// 1) SkeletonVisualLayer
//    - 由 ExternalCharacterManager 持有
//    - 字段: boneLines (LineSegments), jointDots (Points 或 InstancedMesh),
//            showFlag: { bones: bool, joints: bool, chain: { arm: bool, leg: bool, ... } }
//    - 构造: 遍历 entry.allBones + allBones.parent (Bone)
//            构建 pair list → 单一 BufferGeometry
//    - 更新: markVisible + 时每帧 update (或 cache 变换，重 solve 时 rebuild)
// 2) 暴露: externalManager.getSkeletonLayer(id) → { bones, joints, setVisible({bones, joints}) }
// 3) 与 figureGroup 协同: char.mode === "glb" && showSkeleton 时显示
```

**实施阶段建议**：
- **P3-0 必做（最小可用）**：
  - 自定义 LineSegments，从 `allBones` + 父级构造 pair；
  - 单一 material，可调透明度（默认 0.4）；
  - 显示开关：顶栏 `🦴骨骼显示` 复选框，默认 OFF；
  - **joint 球**：复用 figure.js 的 `createJoints` 思路，但挂在 `entry.model` 子级（而非 figureGroup）；**和现有火柴人关节球共用视觉风格**；
- **P3-A 增强**：
  - 鼠标 hover 骨骼 → 高亮（链段变色）；
  - 选中骨骼后右键菜单：重置 / 添加约束。

### 3.3 ❌ 反对直接用 SkeletonHelper 的硬证据

**当前 SkeletonHelper 行为**：
- 传入 SkinnedMesh → 取其 `.skeleton.bones` 数组，画每个 bone 到 parent 的连线；
- **不画 joint 球**（"骨骼" ≠ "关节"）；
- **不区分 attached 子级**（如果用户 attach 武器到 rightHand，攻击的连线 rightHand → 武器看起来"多一根骨头"）；
- **8 角色时**：draw call +8，**和性能档位（流畅 96 FPS）的 4.4 FPS 警示不一致**（参考项目 M7A）。

> **P3-0 阶段绝不上 SkeletonHelper**。自定义骨骼线是正确选择，能跨 WebGL/2D 双模，统一坐标系，且不污染 attached 子级。

---

## 4. 程序化动作数据格式建议（pose / procedural / clip 三类统一 schema）

### 4.1 当前各数据格式现状（混乱）

| 数据源 | 当前 schema | 例子 |
|---|---|---|
| **Pose 姿势库** | `{ pose.id, pose.name, pose.file }` + 文件内 `[ [x,y,z], ...18 ]` 关节坐标 | `/director_stage/poses/wave.json`：`[[0,1.6,0], ...]` |
| **外部 entry**（runtime） | `entry.jointMap: Map<idx, Bone>` + `entry.ikTargets: { [chain]: { target, pole } }` | jointMap.get(0) = headBone |
| **sceneGz（M2）** | `{ v, characters: [{id, name, joints:[18], ikTargets, visible}], activeCharId, focalLength, scene }` | sceneGz/version=2 |
| **sceneJSON project-io** | `{ version: 3, ..., characters:[...], externalCharacters:[...], activeExternalCharacterId }` | project-io 写 v3 |
| **poses/index.json** | `{ poses: [{ id, name, file, ... }] }` | 一个 manifest |

**未来三类**：
1. **pose**（已存在）：单帧 18 关节坐标；
2. **procedural**（计划新增）：参数化函数描述循环/位移（如 walk-cycle(amp=0.1, speed=2, legPhase=π/2)）；
3. **clip**（计划新增）：FBX/GLB clip 或关键帧序列（参考项目 M1B 的 `MixamoAnimationPlayer` + `AnimationMixer`）。

### 4.2 推荐统一 schema —— `ActionDefinition`（草稿）

```text
// 概念 schema, 字段名 / 嵌套待实现者确认：

ActionDefinition {
  // 公共字段
  id: string                       // 全局唯一
  name: string                     // "走路循环"
  group: string                    // "basic" | "community" | "mixamo" | "procedural" | "user"
  kind: "pose" | "procedural" | "clip"   // 必填，决定 spec 字段
  duration: number                 // 总时长（秒），procedural=0 表示无限循环
  loop: boolean                    // 是否循环
  rootMotion: { dx: 0, dy: 0, dz: 0, dYaw: 0 }  // 根位移/朝向（用于路线运动）
  boneNames?: string[]             // 用于 clip：哪个骨骼对应哪个人体部位（参考 M5E）
  applicableTags: string[]         // ["humanoid", "ready", "bip", "cc-base", "mixamo"]
  // ─── kind 专属字段 ───

  // kind: "pose"
  joints?: [ [x,y,z], ...18 ]      // 与现有 pose 库一致

  // kind: "procedural"
  proc?: {
    type: "walk-cycle" | "wave" | "squat" | "breath" | ...
    params: { [key: string]: number }    // 振幅/速度/相位等
    bindPose: "t-pose" | "current" | string  // 起始姿势（t-pose | current | named）
  }

  // kind: "clip"
  clip?: {
    file: string                   // "/director_stage/actions/wave.fbx"
    trackName?: string             // 内部 animation name (Mixamo 多个 track)
    loopMode: "repeat" | "ping-pong" | "once"
    retargetMap?: { [src: string]: string }  // 源骨骼名 → 目标骨骼名
  }
}

ActionTrack {
  characterId: string              // 活动角色 id
  actionId: string                 // 引用 ActionDefinition.id
  startTime: number                // 时间轴起点（秒）
  duration: number                 // 覆盖 ActionDefinition.duration
  blendIn: number                  // 与前一条 track 混合的过渡秒数（默认 0.1）
}
```

### 4.3 为什么必须三类统一 schema

**参考项目 M1B / M2D / M7B 经验**：
- `MixamoAnimationPlayer.setTime()` 和 `procedural walk-cycle sampler` 必须在同一个时间轴上 → **共用 sampler 接口**；
- 路线运动 M2D：到点动作从 0 秒起播 → **procedural 也要支持 0 起播**（M1B 关键修复：避免首帧绑定姿势 bug）；
- M7B 性能档位：每帧只更新 runtime，按档位刷新 UI → **runtime 必须统一推进时间**，不管 source。

**统一时间轴推进函数**：
```text
sample(actionDef, t) → Pose18 {
  switch actionDef.kind:
    case "pose":       return actionDef.joints                       // 单帧
    case "procedural": return PROC_FUNCS[actionDef.proc.type](t, actionDef.proc.params)
    case "clip":       return animationSampler.sample(actionDef.clip, t)  // FBX/GLB clip
}
```

### 4.4 procedural 类型 v1 列表（建议最小可用）

| 类型 | 参数 | 实现难度 | 验收价值 |
|---|---|---|---|
| `walk-cycle` | `legPhase`, `swingAmpDeg`, `stride` | 中 | ⭐⭐⭐⭐⭐ |
| `breath` / `idle-sway` | `freqHz`, `ampDeg` | 低 | ⭐⭐⭐ |
| `wave` | `hand`, `freqHz`, `ampDeg` | 低 | ⭐⭐⭐⭐ |
| `squat-bob` | `depth`, `freqHz` | 低 | ⭐⭐ |
| `head-look` | `targetBone`, `maxDeg` | 中 | ⭐⭐⭐ |
| `root-motion-forward` | `speed` | 中 | ⭐⭐⭐⭐ |

**先做 walk-cycle + idle-sway + wave 三个**（覆盖率 80% 短视频场景），其余推 P3-B。

### 4.5 clip 类型边界（详见 §7）

clip 必须满足：
- **同一文件多次引用**：FBX 多 track / GLB 多 animation，运行时按 `trackName` 选；
- **人形适配**：参考项目 M5D / M5E 给出 15 个语义部位（head / neck / spine / hips / L/R shoulder / elbow / wrist / leg / knee / ankle）→ **必须先有 skinnedMesh.boneMap**；
- **未识别的 FBX**：参考 M5E 行为 —— 自动 broadcast + skip，非 ready 角色不可用。

---

## 5. 动作运行时与现有 IK dirty / 活动角色性能策略结合

### 5.1 现状（main.js `renderLoop`）

```js
if (characterMode !== "stick") {
  const activeId = externalManager.activeCharacterId;
  for (const entry of externalManager.characters.values()) {
    if (!entry.model?.visible) continue;
    const mustSolve = entry.id === activeId || entry._ikDirty;
    if (!mustSolve) continue;
    if (entry.type === "vrm") solveVRM_IK(entry);
    else solveGLB_IK(entry);
    entry._ikDirty = false;
  }
}
```

P15B-§3.2 已警示：活动角色每帧 + dirty 时每帧；**非活动按需**（current 实现）已部分优化，但**缺 round-robin / budget**。

### 5.2 引入 action runtime 后的 IK 求解策略

#### 关键冲突
- IK 求解输入（IK target/pole 位置）是**用户拖拽**结果，**action 应当改 IK target 球位置**而非手动求解骨骼；
- 反过来，action 也可**直接写骨骼 quaternion**（绕过 IK，目标姿势精准）；
- 二选一：
  - **方案 A（推荐 P3-0 起步）**：action runtime 只在 `IK 关闭`时直接驱动骨骼，`IK 开启`时把"目标末端 effector 位置"作为 IK target；
  - **方案 B（推荐 P3-B）**：action runtime 输出"目标骨骼局部 quaternion"，IK 求解只负责维持末端位置（如脚钉地）。

#### 性能策略保留
- **activity 分桶不破**：动作播放的角色一定是活动角色——所以「活动角色每帧 IK」天然覆盖；
- **dirty 触发**：任何 action 写 IK target → `entry._ikDirty = true` → 下一帧 IK 求解；
- **cross-character 影响**：action 切换时，前一个动作的最后一帧 IK 求解结果 = 下一动作的初始 IK target（runtime 主动调 `markAllIKDirty`）。

### 5.3 现有 dirty 链增量（推荐）

```text
// 概念：把 _ikDirty 升级为 _dirtyBitmask
entry._dirty = {
  ik: false,           // IK 求解重做
  pose: false,         // 骨骼姿势重写（user-driven 或 action-driven）
  visible: false,      // 可见性变化
  transform: false,    // entry.model.position/rotation/scale 变化（影响 IK target）
}

// renderLoop IK pass 复用：
const mustSolve = entry.id === activeId || entry._dirty.ik;
if (mustSolve) { solveIK(entry); entry._dirty.ik = false; }

// action runtime update：
function tickAction(actionDef, t, char, dt) {
  // 1. 采样目标姿势
  const targetPose = sample(actionDef, t);
  // 2. 应用到 char：分 IK 模式
  if (window.__ds?.fkMode || char.mode === "stick") {
    // 直接驱动骨骼（走 pose 路径）
    applyPose(char.allBones, targetPose);
    char._dirty.pose = false;
  } else {
    // 转 IK target 位移
    const deltaJoints = computeDeltaIK(char, targetPose);
    applyJointsDelta(char.ikTargets, deltaJoints);
    char._dirty.ik = true;
  }
}
```

### 5.4 P15B-§3 已警示 4 维过滤 + budget

**复述要点**（不重写）：
- IK_BUDGET_MS = 2.0；
- round-robin 队列处理非活动角色同步；
- 切活动角色时一次性 markAllIKDirty 避免跳变；
- 8 角色满载 → 当前 ~19 ms → 优化后 ~6 ms。

**action runtime 必须同样按 budget**：
- 高优先级：active 上正在播放的 action + active IK；
- 低优先级：其他 non-active role 的 action 采样（只为切换可见性 / IK 球位置缓存）；
- 预算超 → 缓存**采样时间戳**，下一帧再补。

### 5.5 VRM `_rootPrev` / spring bone 隔离（P15B-§3 已警示）

- 多 VRM 同存时**全局 springBoneManager 单例冲突**——本阶段如果引入 VRM 动作（不一定），务必先修：
  - 每个 VRM 实例一份 SpringBoneManager（VRM 0.x：手构造；VRM 1.0：用 `vrm.springBone`）；
  - `scrub` 时临时 `springBoneManager.setEnabled(false)`，松开恢复。
- `_rootPrev` 是 entry-scoped 当前实现（`data._rootPrev`），不跨 entry —— **当前 OK**。
- ⚠️ **VRM 的 5 点头部（Nose/Eye/Ear）重合**（P15B-§5.B）必须本阶段治；
- 默认模型先不用 VRM，把锅推给 GLB mannequin + 后续 v1.x 升级 VRM。

---

## 6. sceneJSON action state 版本迁移建议

### 6.1 当前 sceneJSON 版本演进

| 版本 | 文件 | schema | 主要字段 |
|---|---|---|---|
| M0 | `serialization.js` | `[ [x,y,z], ...18 ]` | 纯数组 |
| M1 | `serialization.js` | `{ v: 1, joints, focalLength }` | joints + focalLength |
| M2 | `serialization.js` | `{ v: 2, characters, activeCharId, focalLength, scene }` | 多角色 |
| **P1.5** | `project-io.js` | `{ version: 3, ..., externalCharacters, activeExternalCharacterId }` | **version 字段未与 SCENE_VERSION 统一！** |
| P3-0 | 计划 | `{ version: 4, ..., actionTracks, actionDefs }` | **待定** |

**现状 bug**（P15B-§9 已警示）：
- `serialization.js` 用 `SCENE_VERSION` 常量（`constants.js`，假设当前 = 2）；
- `project-io.js` 写硬编码 `version: 3`；
- 两者**不一致**，sceneGz 解码 `if (result.v >= 2 ...)` 容错导致 v3 数据被忽略。

### 6.2 版本迁移方案

#### A. 立即统一 `SCENE_VERSION = 4`

```text
// constants.js（推荐）：
SCENE_VERSION = 4
SCENE_GZ_VERSION = 4    // sceneGz 头
SCENE_PROJECT_VERSION = 4  // sceneJSON 头
```

两者统一为 4，**先解决 P15B 警示的 sceneJSON 没 bump 问题**。

#### B. sceneJSON v4 新增字段（最小可用）

```text
{
  version: 4,
  ...
  // ─── 新增 ───
  actionDefs: [ActionDefinition]      // 引用 / 内联
  actionTracks: [{                    // 时间轴上的动作片段
    characterId: string,
    actionId: string,
    startTime: number,
    duration: number,
    blendIn: number,
  }]
  skeletonVisible: { [characterId: string]: { bones: bool, joints: bool } }  // 骨骼显示开关
  proceduralClips: { [key: string]: { type, params } }  // procedural 参数（避免重定义）
}
```

**兼容策略**：
- `loadProject` 检查 `data.version`：
  - 1 / 2 / 3 → 解析后**立刻 bump 到 v4**：补 actionTracks = [] / skeletonVisible = {}；
  - 4 → 直接使用；
- **sceneGz 头 v 也 bump**：解码 `if (v < 4)` → 旧路径 + 自动 bump 标记 `wasLegacyGz: true`。

#### C. sceneGz 兼容（M2 v2 → v4）

- **现状 bug**：`encodeSceneGz` 不写 externalClips（不是 bug，是缺功能）；
- **本阶段建议**：sceneGz v4 仍**不写外部角色动作**（仅写姿势），理由：sceneGz 是紧凑 gz 字节，**动作 clip 体积大、应留 sceneJSON**；
- 但 sceneGz v4 必须写：
  - `characterMode: "stick" | "glb" | "vrm"`（per-character 取代全局，未来 P2 前改）；
  - `actionState: { [charId]: { t, actionId } }`（**只写当前播放时间，不写 clip 内容**）；
- ✅ 这样 sceneGz 与 sceneJSON **职责分离**：sceneGz = 当前帧快照；sceneJSON = 完整工程 + 时间轴。

#### D. 迁移测试（必加）

新增 `scene-migration-verify.mjs`：
- 载入 v1 → 解码 → 必须恢复 joints；
- 载入 v2 → 解码 → 必须恢复 multi-char；
- 载入 v3 → 解码 → 必须恢复 externalCharacters；
- 载入 v4 → 解码 → 必须恢复 actionTracks；
- 任意 v 加载后重存 → 必为 v4，**round-trip 一致**。

### 6.3 不建议做的事

- ❌ **不要 bump 到 v5**：本阶段一次性 v4 落地，**留 P3-B 再 bump** 到 v5（per-char mode + spring bone 状态）；
- ❌ **不要把 sceneGz 改成完整工程**：sceneGz 应保持"快照"语义，时间轴去 sceneJSON；
- ❌ **不要删除 v1/v2/v3 兼容代码**：参考 M5F/MILESTONE-BACKUP-RESTORE-AUDIT 的经验——保留兼容比加新功能重要。

---

## 7. 后续 Mixamo / GLB clip / VRMA 接入边界

### 7.1 Mixamo FBX clip（最成熟）

参考项目 M1B / M5D / M5E 已完整验证。
**接入边界**：
1. **必须有 SkinnedMesh + 15 部位映射**（neck/spine/hips/L-R shoulder/elbow/wrist/knee/ankle/head）；
2. **命名匹配**：自动匹配 Mixamo / mixamorig1 / Bip / UE4 / CC Base（M5D 已实现 UI 手动 15 部位映射）；
3. **轨道重定向**：用 storedMapping 把 FBX trackName 重定向到当前角色骨骼名；
4. **许可**：Mixamo 资产个人/商业混合许可，**UI 必须显示 `source` / `许可` 字段**（参考 M3B community preset 范式）；
5. **clip 体积**：单个 FBX ~1-5 MB，**默认不下载**，按需 `fetch(url)`；
6. **生命周期**：clip 一旦下载**全会话缓存**，不进 sceneJSON（**仅引用 URL + trackName**），避免工程文件爆炸。

### 7.2 GLB 内的 animation（KHR_animation）

**接入边界**：
1. 解析 KHR_animation_extensions（three.js `Object3D.animations`）；
2. gltf.animations[i] → AnimationClip → AnimationMixer（和 FBX 共用 sampler）；
3. **binding 必须命中**：参考项目 M5D 的"Skin track 是否覆盖所需骨骼"——不覆盖的角色拒绝播放；
4. **GLB 内 animation 通常只有一个 clip**（主角默认 T-pose 旋转 / 一段 idle）——只支持单一 clip，**多 clip 走 FBX**。

### 7.3 VRMA（VRM Animation）

**接入边界（最复杂，最远期）**：
1. VRMA = VRM 0.x/1.0 标准动作格式，**仅适用 VRM humanoid 角色**；
2. 解析需要 `@pixiv/three-vrm-animation`（参考项目有相关依赖）；
3. 必须 VRM 角色支持 humanoid mapping（M5D 路线）+ expression（M5F）；
4. **强烈建议**：本阶段 P3-0 **不上 VRMA**；先 Mixamo + GLB clip 跑通；VRMA 推 P3-C 末或 v2.x。

### 7.4 推荐选型矩阵

| 类别 | P3-0 (本阶段) | P3-A | P3-B | 后续 |
|---|---|---|---|---|
| pose (单帧) | ✅ 已支持 | 加 blendIn | 时间轴 | — |
| procedural | ✅ 主推 | 6+ 类型 | 路线 hold action | — |
| FBX clip (Mixamo) | ⚠️ 预留接口 | 接入 | 路线 hold action | — |
| GLB 内 anim | ⚠️ 预留接口 | 接入 | — | — |
| VRMA | ❌ 不做 | ❌ | 试用 | ⚠️ 等生态 |

### 7.5 工程文件大小与体积控制

- **sceneJSON 含 procedural params 才合理**（KB 级）；
- **FBX/GLB 不进 sceneJSON**——本地缓存 + URL 引用；
- **大 clip（>5MB）必须异步**：UI 加载 spinner，按需 fetch；本地 IndexedDB 缓存（参考项目）。

---

## 8. 必须验收的 10 项清单

> 本阶段 P3-0 完成判定。打 ✅ 才算 release-candidate。

| # | 验收项 | 优先级 | 验证方式 | 关联风险 |
|---|---|---|---|---|
| 1 | **默认 GLB 加载链路零阻塞**：协议 recall 后 ≤ 3s 内 scene tree 完整 | P0 | `auto-load-default-verify.mjs`：fetch 后 N ms 内 `window.__ds.glbData !== null` 且 `entry.model.visible === true` | §1.2.A |
| 2 | **失败回退**：默认 GLB 404 / CORS / parse 失败 → 自动回火柴人 + toast | P0 | `auto-load-default-failure-verify.mjs`：fetch 改 404 URL → 500ms 内 characterMode === "stick" 且 fire-stick 可见 | §1.2.B |
| 3 | **默认 GLB + 火柴人同存时 openpose 不重叠**：自动 hide 火柴人 | P0 | `compat-mixed-export-verify.mjs`：导出 openpose → 18 关节位置 1 套 + 非重叠 | §2.1 |
| 4 | **自定义骨骼线非 SkeletonHelper**：跨 WebGL/2D 双模可见、attached 子级不污染 | P0 | `skeleton-layer-verify.mjs`：GLB + 武器 attach → 骨骼线无武器连线 | §3.3 |
| 5 | **三类动作 schema 统一**：pose/procedural/clip 同 `ActionDefinition` 接口 | P0 | `action-schema-uniform-verify.mjs`：3 个 sample 调用有相同返回类型 + duration 处理 | §4 |
| 6 | **procedural v1 三类可用**：walk / idle-sway / wave 可在 GLB / 火柴人播放 | P0 | `procedural-v1-verify.mjs`：起播 2s，5 时间点采样骨骼差 > 0.5 | §4.4 |
| 7 | **IK dirty + activity budget 仍生效**：默认 1 GLB + 火柴人 2 角色 RAF ≤ 8ms | P0 | `runtime-budget-verify.mjs`：100 帧平均 frame < 8ms，1%low < 16ms | §5 |
| 8 | **sceneJSON v4 bump + 兼容**：v1/v2/v3 工程文件加载后 round-trip v4 | P0 | `scene-migration-verify.mjs`：载入 v1/v2/v3 三个 mock + 重存 = v4 | §6.2.A |
| 9 | **hint 文案 + 教学卡动态切**：stick/glb/vrm mode 下 hint 不同 | P1 | `hint-mode-verify.mjs`：3 次 setCharacterMode 后 `document.getElementById('hint').textContent` 包含正确关键字 | §2.4 |
| 10 | **Mixamo/FBX/clip/VRMA 边界明确**：UI 仅显示"可播放"+ 不暴露 VRMA | P1 | `clip-source-visibility-verify.mjs`：clip 卡片含 source/license/missing-warning | §7 |

**附加：既有 21 项回归必须 100% 通过**（P15B 验收规则）。

---

## 9. 最重要 5 条风险（汇总）

> **按概率×影响排序**，给 §8 的 P0 项做支撑。

### 🔴 #1 默认 GLB 启动失败链 → 全链路坍塌（**最关键**）
- **问题**：fetch 慢、404、parser 失败、CORS、GPU 不够 → 任何一项失败必须**自动回退**到火柴人；
- **不修复后果**：用户报"打不开" → 项目不可用；
- **必做路径**：6s 超时熔断 + 任意错误 → `setCharacterMode("stick")` + toast + 加载 button 不再 disabled；
- **关联**：§1.2.A/B、§8 #1/#2。

### 🔴 #2 SkeletonHelper + attached bone bug + 性能炸 → 时间轴/动作用户体验差
- **问题**：SkeletonHelper attached 子级被画；8 角色满载 draw call +8 → 流畅档位不达标；
- **不修复后果**：骨架显示时画面错误、性能崩；
- **必做路径**：**绝不上 SkeletonHelper**，统一走自定义 LineSegments + 关节球；
- **关联**：§3、§8 #4。

### 🟡 #3 三类动作 schema 不统一 → 时间轴 P3-B 推倒重来
- **问题**：pose 是裸关节坐标、procedural 是函数、clip 是 FBX/GLB；sampler 不能共用 → 时间轴首帧绑定姿势 bug（M1B 已遇）；
- **不修复后果**：P3-B 时间轴必须重构，浪费 5+ 人天；
- **必做路径**：本阶段统一 `ActionDefinition` + `sample(actionDef, t)` 抽象，先做 procedural 三类型；
- **关联**：§4、§8 #5/#6。

### 🟡 #4 sceneJSON v3 没 bump（version 字段不一致） → 工程文件 round-trip 失真
- **问题**：`project-io.js` 写 `version: 3`、`serialization.js` 读 `SCENE_VERSION = 2`、sceneGz 解码容错 `v >= 2` 静默通过 → 外部角色姿势丢失；
- **不修复后果**：导入旧工程后 GLB 角色没有正确姿势 / IK 球位置；
- **必做路径**：`SCENE_VERSION = 4`、写读对齐、sceneJSON 与 sceneGz 分离职责；
- **关联**：§6.2、§8 #8。

### 🟡 #5 IK dirty + activity 4 维过滤未实施 + VRM `_rootPrev`/`springBone` 单例冲突 → 动作播放不稳
- **问题**：P15B-§3 已警示；引入动作后每次采样都触发 dirty → IK 求解单帧能到 30+ ms；VRM 多实例 spring bone 互相干扰；
- **不修复后果**：8 角色 + 动作播放 → 45 FPS、VRM 头发乱飞；
- **必做路径**：P15B 推荐的 IK_BUDGET_MS + round-robin；本阶段默认 1 GLB 影响小，但**接口必须留好**；
- **关联**：§5、§8 #7。

---

## 10. 决策汇总

> 回答三件事：(a) 先做哪条路径，(b) 风险接受门槛，(c) 下一步提案给谁。

### 10.1 ✅ 同意先做 procedural 动作，而不是 Mixamo

**理由**（按 ROI 排序）：
1. **依赖最少**：procedural 是函数，**不依赖 FBX/GLB clip 下载 + 解析 + retarget**，可在 P3-0 立刻跑通；
2. **参考项目已验证**：M1B 验证 Mixamo 跨视图运行时可行，但**那是真实 FBX 路径**——本项目当前阶段**没有绑骨人物资产可用**（M5E 的 GUO 37 人物资产需要新增）；
3. **性能可预测**：procedural O(1) 单帧采样，**不会因 clip 体积或轨道重定向额外开销污染 8 角色满载**；
4. **UX 即时可见**：walk-cycle / wave 用户**立刻看到角色动**——比"先 Mixamo 才能用"具有 demo 价值；
5. **接口先稳定**：procedural 推完 `ActionDefinition` 三类 schema，后续 Mixamo/GLB clip **只是 `sample()` 的另一种实现**，时间轴不动；
6. **VRMA 完全旁路**：混合生态（VRM + humanoid clip）边界在 §7 已标"远期"，procedural 完全不碰。

**实施顺序**：
- **P3-0（本阶段）**：procedural 三类型（walk / idle-sway / wave）+ 骨骼显示 + 默认 GLB；
- **P3-A**：再扩 3 个 procedural 类型（squat / head-look / root-motion-forward）；
- **P3-B**：Mixamo FBX clip 接入（资产准备好后）；
- **P3-C 末**：VRMA 试用。

### 10.2 关键风险接受门槛

| 风险 | 可接受兜底 |
|---|---|
| 默认 GLB 加载失败 | 自动回退火柴人 + toast（不允许黑屏） |
| openpose 渲染多角色重叠 | 自动 hide 非视觉角色 |
| 4 维 IK 过滤未实施 | **接口先留**（`_ikDirty` + active 桶），8 角色满载性能验证推 P3-B |
| sceneJSON v3/v4 不对齐 | **本阶段必须 bump 到 v4**，否则 P3-B 时间轴推倒 |
| procedural 起步简单 | 加 §8 #5/#6 验收，确保和未来 clip sample 同接口 |

### 10.3 下一步提案（给后续 Agent）

1. **P3-A 实施负责人**：
   - 优先消化 §8 10 项验收；
   - §6.2 的 `SCENE_VERSION = 4` 和 `project-io.js` alignment 是 **依赖前置**，必须 P3-0 内做；
   - §4.4 的 3 个 procedural 类型**最优先**——把 `ActionDefinition` schema 和 `sample()` 抽象先稳定。

2. **P3-B 实施负责人**：
   - 接 Mixamo FBX：用参考项目 M1B/M5D/M5E 的成熟路径；
   - 时间轴设计：复用 §6.2.B 的 sceneJSON v4 schema。

3. **P3-C 实施负责人**：
   - GLB 内 animation 接入，VRMA 试用；
   - 性能档位（参考 M7B）扩展到本项目。

4. **测试负责人**：
   - 加 §8 提到的 8 个新 verify + 修订 `external-dispose-verify.mjs`（默认 GLB 启动路径）；
   - **不能删除**既有 16 个 verify（stick/M2 单角色回归保护）。

### 10.4 明确不做（边界）

- ❌ **不做骨骼自动 retarget 工具**——参考项目 M5D UI 手动 15 部位映射，本项目借接口不做 UX；
- ❌ **不做表情驱动**——M5F 表情 blend 推 P3-C 后或 v2.x；
- ❌ **不做春季骨骼 spring bone 优化 VRM 头发**——P15B-§3.5 警示与 IK 冲突，推 P3-C 后；
- ❌ **不做 LOD / InstancedMesh**——参考 M7B 不做，8 角色满载够用；
- ❌ **不做 VRMA 标准适配**——见 §7.3；
- ❌ **不做编辑器内的"动作 timeline 编辑 UI"**——本阶段只读 + 播放，编辑推 P3-B（参考项目 M2D 是先有 timeline 再有动作）。

---

## 11. 给后续 Agent 的硬约束

### 必须现在做（P3-0）

1. **§1.2.A 失败回退**：`loadMoreGLB()` 全部错误路径必须 → `setCharacterMode("stick")` + toast；
2. **§3 自定义骨骼线**：本阶段**禁止**用 SkeletonHelper；实现 LineSegments + 关节球；
3. **§4 ActionDefinition schema**：先实现 procedural 三类型 + sample 抽象；pose / clip 接口先留；
4. **§6.2 SCENE_VERSION = 4**：`project-io.js`、`serialization.js`、`constants.js` 三处对齐；
5. **§2.4 hint 文案动态切**：stick / glb / vrm 三档分别文字。

### 必须本阶段做（P3-0 内）

6. **§5 dirty 位图升级**：`_ikDirty` → `_dirty: {ik, pose, visible, transform}`；
7. **§8 10 项验收全部通过**（含既有 21 项回归）；
8. **VRM 头部五点偏移修复**：M2 export.js → 即使本阶段不上 VRM，也要为 P3-A 预留接口。

### 留到 P3-A

9. **procedural 类型扩展**：squat / head-look / root-motion-forward 6 个 v2 类型；
10. **Mixamo FBX 接入**：参考项目 M1B/M5D 路径复用；
11. **scrub 时局部 matrix 更新 + spring bone 暂停**（P15B-§6.4/§6.5）。

### 留到 P3-C / v2.x

12. GLB 内 animation（KHR_animation）正式接入；
13. VRMA 试用；
14. 时间轴 UI 编辑（参考项目 timeline UI）；
15. LOD / InstancedMesh。

---

## 12. 总结

P3-0 「默认 3D角色 + 骨骼显示 + 动作预设」是**架构上正确的方向**：
- 默认 GLB 接管首屏 → RTX 5090 利用率 ↑；
- 程序化动作起步 → 入口稳定、可预测、不依赖 FBX 资产；
- 自定义骨骼线 + 关节球 → 双模友好、性能可控；
- ActionDefinition 统一 schema → P3-B/P3-C 接 Mixamo/GLB clip 时**只动 `sample()` 不动时间轴**；
- sceneJSON v4 bump → 与 P1.5 外部角色 snapshot 职责对齐，避免工程文件 round-trip 失真。

**关键风险 5 条**已识别并给出兜底路径；**10 项验收**已列出，可直接灌入测试清单；**建议路径：procedural 优先、Mixamo 推 P3-A/B、VRMA 远期**。

---

**报告完成。路径**：`F:\comfyui\custom_nodes\comfyui-director-stage\docs\P30-3D-ACTION-PRESET-REVIEW.md`

**5 条风险汇总**：
1. 🔴 默认 GLB 启动失败链 → 6s 超时 + 错误回退火柴人
2. 🔴 SkeletonHelper attached bug + 性能 → 改自定义 LineSegments
3. 🟡 三类动作 schema 不统一 → 本阶段统一 ActionDefinition + sample()
4. 🟡 sceneJSON v3 没 bump → 本阶段对齐 SCENE_VERSION = 4
5. 🟡 IK 4 维过滤 + VRM springBone → 接口先留，运行时再实

**决策汇总**：
- ✅ **同意先做 procedural 动作，不是 Mixamo**（理由见 §10.1）；
- ✅ 推荐实施顺序：procedural 3 类型 → 骨骼显示 → 默认 GLB 启动 → sceneJSON v4 → P3-A 再扩 procedural + Mixamo；
- ⏸️ Mixamo 推 P3-A/B，VRMA 推 v2.x，不在 P3-0 节奏内。
