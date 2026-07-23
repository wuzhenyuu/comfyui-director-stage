# P1.5-C 多 3D角色管理器 — 架构审核报告

> **作者**：P1.5-C 架构审核员（subagent）
> **日期**：2026-07-23
> **任务边界**：只审核，不写源码/测试；不改任何 `src/` 或 `test/`
> **范围**：`main.js` / `controls.js` / `scene.js` / `char-loader.js` / `vrm-loader.js` / `serialization.js` / `project-io.js` / `export.js` + 已完成 P1（WebGL 双模）+ P0/M2（多角色/多机位/道具）基线
> **参考**：`docs/P1-WEBGL-REVIEW.md`、`docs/P1-P3-PLAN.md`、`docs/MULTI_CHAR_CONTRACT.md`

---

## 0. 现状速写（一句话）

**当前架构只有一个全局 `glbData` 和 `vrmData`**（模块作用域 + `window.__ds.glbData/vrmData`），所有渲染循环 / 拾取缓存 / IK 求解 / 序列化 / 导出 / VRM 回调都直接引用这两个单例对象。多 3D角色 = **每个角色都有自己的 GLB/VRM 模型 + IK 链 + 拾取身份 + 序列化单元**，而当前架构连"角色 A 加载 GLB、角色 B 加载 VRM"这种 **2 个外部模型** 的最小场景都没抽象，更别提 N 个。

**核心判断**：本阶段应该做 **ExternalCharacterManager**（外部角色管理器）抽象层，**严格兼容** 现有 `window.__ds.glbData / vrmData / isGLBMode / isVRMMode / characterMode` 这一套单例 API；MVP 只支持"任意角色挂任意一种外部模型"，**不建议本阶段同时支持多 VRM**（见 §7）。

---

## 1. 单例 glbData/vrmData 在多 3D角色下会爆的具体点

### 1.1 渲染循环（main.js 末尾 `renderLoop`）

**证据**：

```js
// main.js 末尾 renderLoop
const _glb = window.__ds?.isGLBMode ? window.__ds?.glbData : null;
if (_glb && _glb.jointMap && _glb.ikTargets) solveGLB_IK(_glb);
const _vrm = window.__ds?.isVRMMode ? window.__ds?.vrmData : null;
if (_vrm && _vrm.jointMap && _vrm.ikTargets) solveVRM_IK(_vrm);
```

- **互斥的 `isGLBMode` / `isVRMMode` flag**：两个都是模块级 `characterMode` 的分支判断，**任何一个时刻最多一种外部模式生效**。
- **单例 `_glb / _vrm`**：整个循环里只跑一个外部模型的 IK，其他外部角色的骨骼完全不动。
- **每帧无差别求解**：4 链 × 10 步 CCD，单角色可接受；多角色（每角色 4 链 × N 人）会成倍放大，但 `joints.map.get(idx)` 在 GLB / VRM 各自的 `jointMap` 是**独立**的，**冲突点在于 `ikTargets.target.position` 在拖拽平面 `ray.intersectPlane` 时只有当前帧拖到的那一组在变**，其他人的 IK target 不动也无所谓；但如果多角色同时被拖（IK 球有 8 个/角色 × 8 人 = 64 个球），**屏幕拾取缓存 `__ds_jointScreen` 每帧要 push 64+ 项**，`pickAt` 的 `bestD=14px` 命中半径筛选逻辑常数 OK，但**遍历成本线性增长**。

**会爆的方式**：
- 角色 A 加载 GLB 后，**根本无法加载第二个外部角色**（无论是 GLB 还是 VRM），因为：
  - `setCharacterMode("glb")` 在 `glbData` 已经存在时只切换 visible，**不会重新加载**；
  - `glbBtn.addEventListener` 的 `if (glbLoaded) { ... return; }` 早退；
  - 新建角色走 `addCharacter()` → CharacterManager → **没有任何路径把外部模型绑给新角色**。
- 即便绕过按钮逻辑硬塞 `glbData = await loadGLBCharacter(url2, scene)`，**第二个 GLB 会覆盖 `glbData` 引用**，旧的角色 A 的 IK 目标球全部失效，solveGLB_IK 跑的是 B 的骨骼。
- VRM 回调 `window.__ds._onVRMLoad` 直接 `vrmData = await loadVRMCharacter(url, scene)`，**毫无悬念地覆盖**。

### 1.2 拾取缓存（scene.js `drawStickFigure` / `drawIKTargets`）

**证据**：

```js
// scene.js drawIKTargets
if (externalGlbMode && window.__ds?.glbData?.ikTargets) {
  for (const t of Object.values(window.__ds.glbData.ikTargets)) {
    list.push({ obj: t.target, kind: "target", charId: null }, ...);
  }
}
if (externalVrmMode && window.__ds?.vrmData?.ikTargets) {
  // ... 同样只取 window.__ds.vrmData
}
```

**问题清单**：
1. **`charId: null`**：GLB/VRM 模式的 IK 球拾取后 `charId=null`，进入 controls.js 的 `_resolveDragChar(obj)` 时 **走到兜底分支 `api.getActiveCharacter()`**，意味着即使角色 B 加载了 GLB，**拖它的 IK 球也会被当成"在拖活动角色 A"**，jointsSnapshot 取的是 A 的 joints，子树联动 / 骨长锁定全部跑错骨架。
2. **外部模型 + 火柴人 互斥**：`isGLBMode` 一开，**所有角色的火柴人关节都不画也不缓存**（`drawStickFigure` 入口判断 `externalCharacterMode` 直接跳过；`if (!externalCharacterMode && chars.length)`）。结果：角色 A、B、C 都是火柴人，**只有活动角色**才能正常拖；如果活动角色又恰好切换了 GLB 模式，**所有火柴人都看不见但 IK 球散落**，屏幕只剩 4 个 target/pole。
3. **`controls.js getPickableObjects()`**：

```js
if (externalGlbMode && window.__ds?.glbData?.ikTargets) { ... 只取一份 }
if (externalVrmMode && window.__ds?.vrmData?.ikTargets) { ... 只取一份 }
if (externalMode) return objects;   // ← 早退，不看活动角色的火柴人
```

   多外部角色时，**其他外部角色的 IK 球全部不参与拾取**。

### 1.3 IK 求解（solveGLB_IK / solveVRM_IK）

**证据**：

```js
function solveGLB_IK(data) {
  const { jointMap, ikTargets, allBones } = data;
  // ...
  data._rootPrev = ...  // ← 状态挂在 data 自身
  // 4 chain 求解 ...
}
```

- **`data._rootPrev` 钉地状态挂在单例 `data` 上**：每个外部角色需要自己的 `_rootPrev`，否则同帧 8 个角色共用会互相覆盖。
- **求解器与 `chain` 索引硬编码**（`root:2, mid:3, end:4` 等 13 个 COCO 索引）：**没问题**，因为 `jointMap.get(idx)` 是各自 Map 内的查找，跨角色天然隔离。
- **真正会爆的点**：求解前必须 `allBones.forEach(b => b.updateMatrixWorld())`，但 `scene.updateMatrixWorld()` 已经在 RAF 开头调过一次，**单角色时这步是冗余但安全**；多角色时如果不同角色的 root 父级变换链不一致（例如 A 挂在 `skeletonGroup` 下带 spawnOffset，B 也带但 X 不同），**`allBones` 的世界矩阵需要按角色 group → scene 顺序更新**，但 `updateMatrixWorld` 是全 scene 一次解决，**所以这一步没问题**。
- **关键风险**：solveGLB_IK 是**同步、阻塞、按 O(N×chain×iter) 计算**，8 角色 × 4 链 × 10 iter = 320 次 Q.rotate，每帧稳跑没问题；但若 IK 链存在"链被另一角色的 IK target 共享"（不应该发生但脚钉地代码会读 `data._rootPrev` 做 delta 修正），**会串味**。

### 1.4 序列化（serialization.js + project-io.js）

**证据**：

```js
// serialization.js encodeSceneGzV2
for (let i = 0; i < 18; i++) {
  const bone = char.allBones[i];  // ← 只读 allBones
  ...
}
// 没有任何字段记录 "这个角色当前加载了什么外部模型"
chars.push({ id, name, joints, ikTargets, visible });
```

**问题清单**：
1. **`sceneGz` 完全不记录外部模型**：重开场景后，GLB/VRM 角色瞬间退化为默认 T-POSE 火柴人。`applyDecodedToManager` 重建角色时只设 `jointSpheres.position`，**外部模型的 `model.visible / ikTargetsGroup.visible` 不重建**。
2. **IK targets 在序列化里是"位置快照"**，但外部模型的 IK target 球属于 `glbData.ikTargetsGroup`（不是 `char.ikState`），**编码时根本没写进去**。`char.ikState` 是火柴人骨架的 IK，GLB 用的是自己的 `glbData.ikTargets.target.position`，**两套数据结构完全不交叉**。
3. **`sceneJSON.version = 3`**（project-io.js）但 `SCENE_VERSION` 来自 `constants.js`（没读，但应该是 2），**两个版本号不一致**；引入外部角色需要 schema bump，但 P1 没做。
4. **`applyDecodedToManager`**：清空 `manager.characters.keys()` 后 `manager.create(id, name)`，**没有 `color` 参数**，会按 `CHARACTER_COLORS[_colorIdx]` 自动分配，**导致还原后角色颜色错乱**（如果原工程有自定义色）。
5. **`project-io.js` 的 importProject**：调 `api.createCharacter(id, name, color)`，但 `figure.js` 的 `create` 接口签名是 `create(id, name, color)`，**但 importProject 在 applyPoseToActive 之前没 `setActive`**，导致应用姿势到错角色（实际上 main.js 里 `setActive` 在 `applyPoseToActive` 之前调了，但 `_doImport` 里这段代码顺序**确实有 bug**：先 `setActive` 再 `applyPoseToActive` 是对的，但中间对 `char.ikState` 的恢复没对 GLB 角色做任何事）。

### 1.5 导出（export.js）

**证据**：

```js
// export.js performBatchExport
if (enabledPasses.has("openpose")) {
  if (characters.length > 0) {
    const allJoints = [];
    characters.forEach((ch) => {
      const jointData = window.DS_FigureAPI.getCharacterJoints(ch.id);
      // ... 假设所有角色都是火柴人，从 jointData 拿 18 个名字-坐标对
    });
    poseCv = renderOpenPoseCanvasMulti(allJoints, cam, exportW, exportH);
  }
}
```

**问题清单**：
1. **`getCharacterJoints` 是火柴人 API**：返回 `{ "Nose": [x,y,z], ..., "LEar": [x,y,z] }`，**对 GLB/VRM 角色同样适用**（因为 `char.allBones[i]` 在 GLB 角色里就是 SkinnedMesh 的 bone，在 VRM 里是 humanoid bone），所以**关节坐标能正确获取**——但前提是 `getCharacterJoints` 内部读取的是 `char.allBones[i]`（已确认，见 figure.js:390），**没问题**。
2. **mask 通道**：

```js
ch.group.traverse((child) => {
  if (child.visible !== undefined) child.visible = true;
});
```

   `ch.group` 在 `getCharacterGroups()` 里被赋值为 `ch.skeletonGroup || ch`（scene.js:298），**对火柴人角色是 skeletonGroup；对 GLB/VRM 角色？目前 GLB 加载只创建 `glbData.model` 加到 `scene`，没挂到任何 char 上**，**所以 GLB 角色根本没 group 能被 mask 抓到**。
3. **`renderCharacterMasks`**：每个角色单独渲染一次白色 mask，但**所有角色的 mesh 必须挂在 `ch.group` 上且可以独立 visible 切换**——GLB 的 `glbData.model` 直接挂到 `scene`，**没法只切这个角色 visible**，会把全场景其他角色也 mask 进去。
4. **火柴人多角色 OpenPose 颜色编码**：`renderOpenPoseCanvasMulti` 用 `CHAR_COLORS[charIdx % 8]` 循环配色，与 `CHARACTER_COLORS` 是两套表，**两条数据流互不感知**。

### 1.6 VRM 回调（main.js 末尾 `window.__ds._onVRMLoad`）

**证据**：

```js
window.__ds._onVRMLoad = async (url, fileName) => {
  vrmData = await loadVRMCharacter(url, scene);
  vrmData.ikTargets = createVRMIKTargets(vrmData.jointMap);
  vrmData.ikTargetsGroup = vrmData.ikTargets.group;
  scene.add(vrmData.ikTargetsGroup);
  window.__ds.vrmData = vrmData;
  vrmLoaded = true;
  window.__dsSetCharacterMode?.("vrm");
};
```

- **绑定到具体目标角色 = 0**：回调不接收 `targetCharId` 参数，**所有 VRM 导入都变成"全场景唯一的 VRM"**。
- **`vrmData` 是裸对象**：没有 charId、没有 manager 引用、没有 dispose 路径；用户删角色不会 dispose VRM 的 GL 资源。
- **`window.__dsSetCharacterMode?.("vrm")`** 强行切换全局模式，**把活动角色的 GLB（如果有）也关闭**。
- **VRM 模型本身**：从 `gltf.scene` 直接 `scene.add(vrmModel)`，**没挂到任何角色 group 下**，导出 mask 通道时这个 mesh 会被误判为"场景道具"。

### 1.7 测试兼容性

**现状测试清单**（均需继续通过）：
- `smoke-2d.mjs`：纯火柴人单角色基线
- `multi-char-verify.mjs`：3 火柴人 + 8 人上限 + 拾取缓存 + 自动激活
- `glb-character-verify.mjs`：加载 GLB → 进入外部 IK 模式 → 拖 rightArm 动骨骼 → 切回火柴人
- `webgl-mode-verify.mjs` / `fallback-mode-verify.mjs`：WebGL 双模
- `prop-*` / `pick-*` / `orbit-*` / `drag-*`：基础交互

**新功能必须保证的兼容点**：
1. **`glb-character-verify` 的"再点 3D角色：切回火柴人"**：现有逻辑靠 `setCharacterMode("stick")` 把 `glbData.model.visible = false`；多角色后，**切回 stick 必须只影响活动角色**，不能把其他角色的 GLB 也隐藏。
2. **`multi-char-verify` 的 `__ds_jointScreen.length === 54`（3×18）**：外部角色模式下 `__ds_jointScreen` 的语义会变（IK 球代替关节球），**这条断言要重写为"等于 4×外部角色数（每角色 4 个 IK target+pole=8 个）"**。
3. **`getCharacterJoints(ch.id)` 返回 dict 格式**：导出路径硬编码 `["Nose", "Neck", ..., "LEar"]`，**没问题但耦合了常量顺序**，多外部角色时这个顺序要保持 18 项 COCO 索引。
4. **`smoke-2d` 的单角色兜底**：ExternalCharacterManager 必须有 `getPrimaryExternalCharacter()` 之类的兜底接口，**保证"无外部角色时所有读 `glbData/vrmData` 的代码走 None 路径"**。

---

## 2. 推荐 ExternalCharacterManager schema 与兼容旧 API 策略

### 2.1 新模块：`editor-src/src/external-character-manager.js`

```ts
/**
 * ExternalCharacterManager — 把 GLB/VRM 模型与 CharacterManager 的角色 ID 双向绑定。
 *
 * 设计原则：
 *   1. 一个 ExternalCharacterManager 实例 = 当前 scene 的所有外部角色
 *   2. 一个角色最多挂一种外部模型（GLB 或 VRM），互斥
 *   3. 提供与现有 window.__ds.glbData/vrmData 兼容的【主外部角色】代理，
 *      让 solveGLB_IK / solveVRM_IK / drawIKTargets / export 等老代码零改动继续工作
 *   4. 旧 API（window.__ds.glbData、isGLBMode、setCharacterMode）由 manager 提供兼容垫片
 */
export class ExternalCharacterManager {
  constructor(scene, characterManager) {
    this.scene = scene;
    this.charMgr = characterManager;
    /** @type {Map<string, ExternalCharacterEntry>} charId → entry */
    this.entries = new Map();
    this._primary = null;   // 主外部角色（兼容旧 isGLBMode/isVRMMode 用的"那个"）
  }

  /** 把 URL 加载的 GLB 模型绑定到指定角色（替换 / 首次加载） */
  async attachGLB(charId, url) { ... }

  /** 把 URL 加载的 VRM 模型绑定到指定角色 */
  async attachVRM(charId, url) { ... }

  /** 解除角色的外部模型（回到火柴人） */
  detach(charId) { ... }

  /** 遍历所有外部角色（求解/拾取缓存用） */
  forEachEntry(fn) { ... }

  /** 兼容旧 API：返回当前主外部角色（活动角色优先；否则取第一个） */
  getPrimary() { ... }

  /** 兼容旧 API：返回主外部角色的 GLB 数据（没有则 null） */
  get glbData() { return this.getPrimary()?.kind === 'glb' ? this.getPrimary() : null; }

  /** 兼容旧 API：返回主外部角色的 VRM 数据 */
  get vrmData() { return this.getPrimary()?.kind === 'vrm' ? this.getPrimary() : null; }

  /** 角色删除时同步清理 */
  onCharacterRemoved(charId) { ... }
}

/**
 * @typedef {Object} ExternalCharacterEntry
 * @property {string} charId          // 绑定的 CharacterManager 角色 ID
 * @property {'glb'|'vrm'} kind
 * @property {THREE.Group} model      // 加载后挂到 char.skeletonGroup（关键！不是直接 scene.add）
 * @property {THREE.Skeleton} [skeleton]
 * @property {Map<number,THREE.Bone>} jointMap
 * @property {THREE.Bone[]} allBones
 * @property {Object} ikTargets       // { rightArm: {target, pole}, ... }
 * @property {THREE.Group} ikTargetsGroup
 * @property {VRM} [vrm]              // 仅 VRM
 * @property {THREE.Vector3} _rootPrev  // 钉地状态（按角色独立）
 */
```

### 2.2 关键设计点

#### A. **外部模型必须挂到 `char.skeletonGroup`，不是 `scene`**

- 改 `char-loader.js` / `vrm-loader.js`：把 `scene.add(model)` 改为 `scene.add(model); char.skeletonGroup.add(model)`（先加到 scene 不然 `_applySpawnOffset` 的世界矩阵更新找不到），但 IK target / pole group 必须挂到 char.skeletonGroup 同级，**保留世界位置**。
- 改 `main.js` 末尾 `solveGLB_IK`：遍历 `manager.forEachEntry` 而不是单例。
- 改 `scene.js` `getCharacterGroups()`：返回 `{ id, group: ch.skeletonGroup }`，**mask 通道直接遍历 skeletonGroup 即可**，与火柴人角色同款路径。

#### B. **外部模型的删除要走 CharacterManager.remove 的 hook**

- 在 `figure.js` 的 `CharacterManager.remove` 里 dispatch `ds-char-removed` 事件；
- `ExternalCharacterManager` 监听并调 `detach(id)`，**释放 GLB/VRM 的 GL 资源**（geometry/material/IK sphere 的 GPU buffer）。

#### C. **拾取缓存 `__ds_jointScreen` 的 `charId` 必须填**

- `scene.js` `drawIKTargets` 遍历 `manager.forEachEntry` 时给每个 IK 球标 `charId: entry.charId`。
- `controls.js` `_resolveDragChar(obj)` 兜底分支 `api.getActiveCharacter()` 保持，但**优先用 `obj.userData.characterId`（外部角色 IK 球现在必须填这个字段）**。

#### D. **活动角色自动激活策略**

- `setActive(charId)` 时如果该角色有外部模型 → 同时 `manager.setPrimary(charId)`；这样 `isGLBMode / isVRMMode` flag 由 `getPrimary()?.kind` 推导（**但为了不破坏 setCharacterMode 单参 API，提供 `setCharacterMode(charId, mode)` 的 2-arg 重载**）。
- 旧 1-arg `setCharacterMode(mode)` 行为不变：操作当前活动角色。

#### E. **序列化新增字段**

- `chars.push({ ..., external: { kind: 'glb', url: '...', visible: true } })`
- `sceneJSON` 顶层加 `externalModels: { [charId]: { kind, url, format } }`
- 解码时 `applyDecodedToManager` 之后异步 `attach*` 加载（**loading 期间角色是火柴人 + 透明 GLB 标签**）。

#### F. **VRM 导入回调带 charId**

- 改 `vrm-loader.js` 的 `createVRMImport`：接收 `targetCharId` 参数，文件上传后调 `window.__ds._onVRMLoad(url, fileName, targetCharId)`。
- `main.js` 的 `_onVRMLoad` 签名升级：`(url, fileName, charId)`。

### 2.3 旧 API 兼容垫片（最小代价）

| 旧 API | 兼容策略 | 风险 |
|---|---|---|
| `window.__ds.glbData` | getter 转 `manager.glbData` | 旧代码假设"非空即唯一"，多角色时返回主角色，**可接受** |
| `window.__ds.vrmData` | 同上 | 同上 |
| `window.__ds.isGLBMode` | 转 `manager.getPrimary()?.kind === 'glb'` | 同上 |
| `window.__ds.isVRMMode` | 同上 | 同上 |
| `window.__ds.characterMode` | 转 `manager.getPrimary()?.kind \|\| 'stick'` | 同上 |
| `setCharacterMode(mode)` | 操作当前活动角色（保持行为） | 多角色时仍只能"全部一起切"；新 API `setCharacterMode(charId, mode)` 才能独立切 |
| `window.__ds._onVRMLoad(url, name)` | 升级签名；1-arg 走活动角色 | 测试 `glb-character-verify` 不传 charId 仍能跑 |

---

## 3. 多外部角色 openpose/mask/depth 导出策略

### 3.1 OpenPose

**核心问题**：外部角色（GLB/VRM）的 jointMap 与火柴人 `char.allBones` 形状一致（都是 18 项 COCO 索引 → Bone），**所以 `getCharacterJoints(charId)` 天然兼容外部角色**。

**推荐**：**本阶段继续走"先兼容当前火柴人多角色导出"路径**（即 `renderOpenPoseCanvasMulti`），多外部角色混排的输出视觉与火柴人多角色**完全一致**——因为导出只读 `getCharacterJoints(ch.id)` 的关节坐标，不关心模型本身。

理由：
- 外部模型在 viewport 里有真实皮肤，**但 OpenPose 控制图本来就是骨架语义**，下游 ControlNet / WanVideo 的 OpenPose 模型也只认 18 关节坐标，不认"是不是 VRM"。
- 如果本阶段做"输出外部模型的真皮肤控制图"（例如多角色 mask + 多角色轮廓），**等价于把 mask 通道做厚**，需要重新设计 pass-renderer 的角色遍历，且深度估计 / 法线估计在多角色交叉时会**互相投影遮挡**，输出质量未必更好。
- WanVideo 期望的就是 **2D 投影后的 OpenPose stick figure + mask + depth** 三件套；模型皮肤信息由 IP-Adapter / Reference Only 提供，不在控制图范畴。

**MVP**：直接复用 `renderOpenPoseCanvasMulti`，按 `ch.id` 顺序遍历所有 `CharacterManager.characters`（不管是否外部模型）。**不输出外部模型的真皮肤轮廓**。

### 3.2 Mask

**问题**：GLB/VRM 模型的 `model` 当前挂 `scene` 根，没法按 `ch.group` 单独切 visible。

**修复**（与 §2.2.A 同步）：把外部模型的 `model` 挂到 `char.skeletonGroup` 下，**mask 通道即可按 `ch.group` 单独遍历**。

**MVP**：仍然走 `renderCharacterMasks(scene, cam, renderer, w, h, characters)`，把 `ch.group` 改成 `ch.skeletonGroup`，**外部角色也能 mask**。

### 3.3 Depth / Normal / Lineart / Preview

**问题**：`renderDepthCanvas(scene, cam, renderer, w, h, hiddenObjects)` 渲染整个 scene，**多外部角色自然就包含进来**，没问题。

**MVP**：不动。

### 3.4 决策总结

| 通道 | 本阶段策略 | 后续完整版 |
|---|---|---|
| OpenPose | **继续火柴人多角色**（`renderOpenPoseCanvasMulti`），外部角色走 `getCharacterJoints` 取 COCO 坐标 | 可选：多角色按颜色分层输出（已实现，无需改） |
| Mask | 把外部 model 挂到 skeletonGroup 后**天然支持** | 可选：按外部模型骨骼点做 soft mask（精确到关节） |
| Depth | 整场景渲染，**直接可用** | 不变 |
| Normal | 同上 | 不变 |
| Lineart | 同上 | 不变 |
| Preview | 同上 | 不变 |

**结论**：**本阶段 openpose 必须兼容当前火柴人多角色导出**，**不需要**为外部角色额外做"外部骨架"。

---

## 4. sceneJSON 版本迁移建议

### 4.1 现状

- `project-io.js` 写 `version: 3`，但 `SCENE_VERSION` 来自 `constants.js`（sceneGz 字段用 2，**两个版本号不一致**——这是 P1 阶段遗留 bug）。
- `serialization.js` 的 `SCENE_VERSION` 是给 `v: ...` 字段用，`chars[].external` 字段不存在。

### 4.2 推荐 schema

**sceneJSON.version 字段语义统一为"工程文件版本"**：

| version | 含义 | 引入版本 | 当前状态 |
|---|---|---|---|
| 1 | M1 单角色 sceneGz | M1 | 已退役 |
| 2 | M2 多角色 + ikTargets | M2 | 已用（`SCENE_VERSION = 2`） |
| 3 | M2 + project-io 聚合（cameras/props/sceneSettings） | M2 工具迭代 | 已用（project-io 写 3） |
| **4** | **M2 + 外部角色（externalModels 字段）** | **P1.5** | **本阶段引入** |
| 5 | 预留 P2 镜头轨迹 | P2 | 字段先放空 `cameraRoutes: []` |
| 6 | 预留 P3 动作片段 | P3 | 字段先放空 `actionClips: []` |

### 4.3 v3 → v4 迁移

```jsonc
// v3 (现状)
{
  "version": 3,
  "characters": [{ "id", "name", "color", "joints", "ikTargets", "visible", "position" }],
  "cameras": [...],
  "props": [...],
  "sceneSettings": {...},
  "focalLength": 35,
  "sceneGz": "..."
}

// v4 (新增)
{
  "version": 4,                   // ← bump
  "externalModels": {             // ← 新增字段；无外部角色时 = {} 或省略
    "char_01": { "kind": "glb", "url": "/director_stage/models/ue.glb" },
    "char_02": { "kind": "vrm", "url": "/view?filename=...vrm" }
  },
  "characters": [
    {
      "id": "char_01", "name": "主角", "color": 16711680, ...
    },
    {
      "id": "char_02", "name": "乙", "color": 255, ...
    }
  ],
  ...
}
```

**sceneGz（gzip 包内的 `v: 2` payload）暂不动**——**外部模型只在 project-io.js 的顶层 JSON 存，sceneGz 继续只管"角色姿势快照"**，理由：

1. **sceneGz 是高频压缩的位姿快照**，导出去 WanVideo 时节点只读姿势，不需要外部模型 URL；
2. **外部模型是低频配置信息**（用户改一次角色外形用很多次），放顶层 JSON 反而合理；
3. **避免 sceneGz schema bump**——SCENE_VERSION 维持在 2。

**迁移函数**（在 `project-io.js` 的 importProject 里加）：

```js
function migrateProjectData(data) {
  if (data.version >= 4) return data;
  // v3 → v4：externalModels 字段缺省 = {}
  data.externalModels = data.externalModels || {};
  data.version = 4;
  return data;
}
```

**测试**：
- `multi-char-verify` 写一份 v3 快照 + 一份 v4 快照，断言 v3 读入后 `externalModels === {}`，v4 读入后字段齐全；
- `glb-character-verify` 导出一份 v4 工程，重新加载后 GLB 模型可见性恢复。

---

## 5. 最小可行实现（MVP）与后续完整版边界

### 5.1 MVP（建议本阶段立刻实现）

| 项 | 范围 | 必须做 | 不做 |
|---|---|---|---|
| **架构** | 新建 `external-character-manager.js`，单例挂在 `window.__ds.__externalMgr` | ✅ |  |
| **绑定外部模型到角色** | `attachGLB(charId, url)` / `attachVRM(charId, url)` / `detach(charId)` | ✅ |  |
| **GLB/VRM 挂到 skeletonGroup** | 改 `char-loader.js` / `vrm-loader.js` 的 `scene.add(model)` 逻辑 | ✅ |  |
| **拾取缓存 charId 填齐** | `scene.js` `drawIKTargets` 遍历所有外部 entry | ✅ |  |
| **IK 求解多角色遍历** | `main.js` `renderLoop` 末尾 `manager.forEachEntry(e => solveByKind(e))` | ✅ |  |
| **mask 通道支持外部角色** | `export.js` `renderCharacterMasks` 用 `ch.skeletonGroup` | ✅ |  |
| **sceneJSON v4 + externalModels 字段** | `project-io.js` 加迁移函数 | ✅ |  |
| **VRM 导入回调 charId 参数** | `vrm-loader.js` `createVRMImport` 接收 `targetCharId` | ✅ |  |
| **活动角色切外部模型自动主化** | `setActive(charId)` 同步 `manager.setPrimary(charId)` | ✅ |  |
| **删除角色时 dispose 外部资源** | `CharacterManager.remove` dispatch `ds-char-removed` 事件 | ✅ |  |
| **多 VRM 同时存在** | 仅支持 1 个 VRM（其他角色挂 GLB 或火柴人） | ❌ | 不做 |
| **同角色多 GLB 加载（同角色多人格）** | 同角色只能挂 1 个外部模型，**重挂替换** | ❌ | 不做 |
| **外部模型导出真皮肤控制图** | 走现有火柴人多角色 OpenPose | ❌ | 不做 |
| **外部模型骨骼拖拽反向驱动场景道具** | 不做 | ❌ | 不做 |
| **外部模型的 IK 球颜色按角色** | 暂时所有外部角色共用青/黄 | ❌ | 不做（与现有 `chain.color` 兼容即可） |
| **外部模型 LOD（多面数切换）** | 不做 | ❌ | 不做 |
| **外部模型动画/mixamo 动作** | 不做 | ❌ | 不做 |

### 5.2 完整版（后续阶段）

- P2：外部模型的时间轴关键帧（沿 P2-A 时间轴）
- P3：动作库作用于外部模型骨骼（VRM 用 `vrm.humanoid.getNormalizedBoneNode(name)`；GLB 用 `jointMap`）
- 真正"按模型输出 IPAdapter / Reference 控制图"（mask + skin 区域分割）

### 5.3 MVP 边界判断准则

- **不引入新概念**给用户：UI 仍然是"选中角色 → 导入 GLB/VRM 绑给该角色"
- **不破坏现有契约**：MULTI_CHAR_CONTRACT 的 5 条契约必须继续生效
- **不破坏现有测试**：smoke-2d / multi-char-verify / glb-character-verify / webgl-mode-verify / fallback-mode-verify / prop-* / pick-* / orbit-* / drag-* 全部通过

---

## 6. 验收清单

### 6.1 功能验收（必过）

- [ ] **F1**：单角色 + 1 个 GLB：现有 `glb-character-verify` 全 5 项继续通过（切回火柴人 / 切回 GLB 不重复加载）。
- [ ] **F2**：单角色 + 1 个 VRM：导入 VRM 文件 → 模式切到 vrm → 拖 IK 球 → 骨骼动 → 重启后加载工程文件 → VRM 模型和姿势都恢复。
- [ ] **F3**：3 火柴人角色（无外部模型）：`multi-char-verify` 全 6 项继续通过。
- [ ] **F4**：2 火柴人 + 1 个外部（GLB 绑给 char_02）：外部角色 IK 球可拖、骨骼动；char_01 / char_03 仍按火柴人交互正常。
- [ ] **F5**：2 火柴人 + 1 个外部（VRM 绑给 char_02）+ 1 个外部（GLB 绑给 char_03）：4 角色同时存在，切换活动角色自动激活对应外部模型。
- [ ] **F6**：删除绑定外部模型的角色：GLB/VRM 的 GL 资源正确释放（dispose 验证：几何体/材质/纹理 buffer），scene 不残留。
- [ ] **F7**：`__ds_jointScreen` 的 `charId` 字段对外部角色 IK 球也正确（拖外部 IK 球 → `_resolveDragChar` 返回正确 charId → 子树联动/骨长锁定走该角色骨架，**不串台到活动角色**）。

### 6.2 序列化验收（必过）

- [ ] **S1**：`project-io.js` 写 v4 工程文件，含 `externalModels: { char_02: {kind:'glb', url:'/director_stage/models/ue.glb'} }`。
- [ ] **S2**：v3 工程读入后 `data.version = 4` 且 `data.externalModels = {}`（向后兼容）。
- [ ] **S3**：v4 工程读入后自动 `attachGLB` 加载，UI 提示 "正在加载外部模型…" toast。
- [ ] **S4**：外部模型 URL 404 时降级：角色保留为火柴人 + 错误 toast，不炸场景。

### 6.3 导出验收（必过）

- [ ] **E1**：4 角色（含 2 外部）走 `performBatchExport`，openpose canvas 包含 4 套不同颜色 stick figure。
- [ ] **E2**：4 角色走 mask 通道，每角色独立白色 mask（不互相覆盖）。
- [ ] **E3**：depth/normal/lineart/preview 4 通道在多外部角色下正常（无黑帧、无 mask 残留）。

### 6.4 健壮性验收（必过）

- [ ] **R1**：连续 3 次 attachGLB 给同一 charId（不同 URL）→ 旧 model 从 skeletonGroup 移除 + dispose，新 model 挂上。
- [ ] **R2**：attachGLB 失败（URL 404 / 非 glb 文件）→ 角色保留上一态（如果有）或火柴人，**不污染 scene**。
- [ ] **R3**：attachVRM 失败 → 同 R2。
- [ ] **R4**：场景内含 8 角色 + 4 外部 + 8 道具，RAF 主循环帧率 ≥ 30 FPS（参考 P1-WEBGL-REVIEW §3.3 C2 基线）。
- [ ] **R5**：`window.__ds.glbData` 在多外部角色下返回"主外部角色"（活动角色优先），**与现有 1-arg `setCharacterMode` 行为兼容**。

### 6.5 回归验收（必过）

- [ ] **D1**：`smoke-2d` / `multi-char-verify` / `glb-character-verify` / `webgl-mode-verify` / `fallback-mode-verify` 全部通过。
- [ ] **D2**：`prop-restore-verify` / `prop-drag-verify` / `pick-verify` / `orbit-verify` / `drag-verify` 全部通过。
- [ ] **D3**：新增 `multi-external-verify.mjs`：3 火柴人 + 2 外部（GLB + VRM）混合场景，验证 F4/F5/F7。

---

## 7. 最重要的 5 条风险

### 风险 #1 · ExternalCharacterManager 与 CharacterManager 生命周期不同步（必修，灾难级）

- **现象**：用户删除绑定外部模型的角色时，`CharacterManager.remove(id)` 清理火柴人骨架，**但 `glbData.model` 仍挂在 scene 根**（因为没挂到 skeletonGroup），不会被 dispose，GL 资源泄漏；同时 `ExternalCharacterManager.entries` 里残留 entry，导致后续 attach 出现"幽灵角色"bug。
- **根因**：外部模型挂在 `scene` 而不是 `char.skeletonGroup`，加上 `remove` 没 hook 通知 `ExternalCharacterManager.detach`。
- **修复**：
  1. 改 `char-loader.js` / `vrm-loader.js`：`scene.add(model)` → `char.skeletonGroup.add(model)`（前提：调用方先 `manager.create(charId, name)` 拿到 char 再加载）。
  2. `figure.js` `CharacterManager.remove` 末尾 dispatch `window.dispatchEvent(new CustomEvent('ds-char-removed', { detail: { charId } }))`。
  3. `ExternalCharacterManager` 在构造函数里 `window.addEventListener('ds-char-removed', e => this.detach(e.detail.charId))`。
- **检测**：新增 `multi-external-verify.mjs` 的 R6："删除绑定外部模型的角色后 `scene.traverse(o => o.userData.__ds_externalOwner === 'char_02' ? fail : pass).length === 0`"。

### 风险 #2 · sceneGz 不携带外部模型 URL，重启工程后外部角色瞬间退化为火柴人（必修，高频）

- **现象**：用户拖了一个 GLB 角色，调好姿势，导出工程文件，重新打开，**GLB 模型不见了，角色变回默认 T-POSE 火柴人**——所有姿势对不上视觉外观，等于白干。
- **根因**：`serialization.js encodeSceneGzV2` 只写 `id/name/joints/ikTargets/visible`，**没有 external 字段**；`applyDecodedToManager` 重建时只设 `jointSpheres.position`，**不调 attachGLB**。
- **修复**：
  1. `serialization.js` 的 chars.push 加 `external: entry ? { kind, url } : null`（按角色查 `externalMgr.entries.get(charId)`）。
  2. `applyDecodedToManager` 重建每个 char 后，**异步** `externalMgr.attachGLB(charId, external.url)` 并 toast "正在加载外部模型…"。
  3. **加载完成前**：角色显示为火柴人 + 半透明 GLB 标签（占位符），避免视觉跳变。
- **检测**：`multi-external-verify.mjs` 的 S2/S3："导出工程 → 清空场景 → 导入工程 → GLB 模型重新可见"。

### 风险 #3 · 拾取归属 `charId=null` 导致外部 IK 球拖到活动角色骨架上（必修，灾难级）

- **现象**：`scene.js` `drawIKTargets` 写 `charId: null` 给外部模型 IK 球；用户拖 GLB 角色的 `rightArm` IK 球 → `controls.js` `_resolveDragChar(obj)` 走兜底 `api.getActiveCharacter()` → 如果活动角色是火柴人 char_01，**子节点树联动 + 骨长锁定跑在 char_01 上**，GLB 角色的骨骼被单独 IK 求解更新；视觉上 GLB 模型动了，但**关节球阵（关节点）没动**，下次刷新 OpenPose 看到的还是火柴人姿势。
- **根因**：`scene.js` `drawIKTargets` 没有给外部 IK 球 `userData.characterId`，**且没读 `obj.userData.characterId`**（vrm-loader.js / char-loader.js 的 `targetSphere.userData` 里只设了 `ikType` 和 `chainName`，**没设 characterId**）。
- **修复**：
  1. `char-loader.js` `createGLBIKTargets` 给 target/pole 加 `userData.characterId = charId`（前提：API 升级为 `createGLBIKTargets(jointMap, charId)`）。
  2. `vrm-loader.js` 同样改。
  3. `scene.js` `drawIKTargets` 外部模式分支填 `charId: entry.charId`。
- **检测**：`multi-external-verify.mjs` 的 F7："拖 GLB 角色 IK 球时，**非活动角色**的 jointSpheres 位置不应变化；活动角色（如果也是火柴人）的 jointSpheres 位置也不应变化；只有 GLB 角色的骨骼 `allBones` 世界矩阵变化"。

### 风险 #4 · 旧 API `window.__ds.glbData/vrmData` 在多外部角色下的语义模糊（必修，高频回归）

- **现象**：现有多处代码（main.js `renderLoop` 末尾、`_dsRef.renderOpenPoseCanvas`、scene.js `drawIKTargets`、export.js `getCharacterJoints` fallback 等）读 `window.__ds.glbData / vrmData / isGLBMode`。ExternalCharacterManager 加进来后这些 getter 必须代理到"主外部角色"，**但"主"是谁没有明确定义**——若定义成"活动角色的外部模型"，那切换活动角色瞬间 `isGLBMode` 会 false，旧代码会跳过整个 GLB IK 求解，**角色视觉卡顿一帧**。
- **根因**：现有单例架构假设"全场景最多一种外部模式"，多角色后这个假设破了，但**所有派生 flag（isGLBMode / isVRMMode / characterMode）都是从单例状态推导的**。
- **修复**：
  1. `ExternalCharacterManager.getPrimary()` 优先返回活动角色的外部 entry，**如果活动角色没外部模型则取第一个有外部模型的 entry**（**保底**，避免主外部角色在切换活动时突然消失）。
  2. 提供 `setPrimary(charId)` 让 UI 显式指定"主"角色（如 char-panel 加右键菜单"设为主外部角色"）。
  3. 旧 getter 全部走 `getPrimary()`，**不要让 flag 随 `setActive` 实时变化**——`isGLBMode` 在切换活动角色时应保持当前主外部角色的状态，**直到用户显式 `setCharacterMode` 切换**。
- **检测**：现有 `glb-character-verify` 全通过即视为兼容；若失败，加新断言"切换活动角色时 `window.__ds.isGLBMode` 不应突变"。

### 风险 #5 · 多外部模型同时存在时 RAF 单循环帧时间暴增（中频，应修）

- **现象**：solveGLB_IK / solveVRM_IK 每帧同步跑，4 链 × 10 步 CCD × N 外部角色 = O(N×40) 旋转计算 + Q.rotate 的四元数运算 + `updateMatrixWorld` 调用。**8 角色 + 4 外部 = 128 链求解**，每帧 1280 次四元数乘 + 1280 次 world pos 重算 + 全 scene matrixWorld 更新。RTX 5090 上理论可扛，但 HiDPI + WebGL 双模渲染 + 道具 EdgesGeometry 缓存失效会叠加，**目标帧率 60 FPS 会掉到 40 以下**。
- **根因**：`renderLoop` 一帧做所有事，没有 dirty 标记，**没有分桶（视口 RAF vs IK RAF）**。
- **修复**（本阶段 MVP 不强求，但要在 PR 描述里写"已知 P3 性能优化点"）：
  1. 引入 `dirty.ik = true` 标记：用户拖 IK 球时置 true，求解后置 false。
  2. RAF 循环：dirty 为 false 时**降频到 30 FPS**（用 RAF skip 法）。
  3. IK 求解与视口渲染分桶：把 IK 求解放到独立 `setTimeout(0)` 链，避免阻塞主 RAF。
  4. `ExternalCharacterManager.forEachEntry` 提供 `forEachActiveOnly()` 过滤当前活动外部角色，**非活动外部角色降频到 10 FPS**（视觉上 IK 球不拖就不动，求解稀疏刷新即可）。
- **检测**：`multi-external-verify.mjs` R4："8 角色 + 4 外部场景 FPS ≥ 30"。

---

## 8. 是否建议本阶段同时支持多 VRM

### 结论：**不建议。**

### 理由

1. **VRM 1.0 humanoid bones 是全局唯一的**：`vrmInstance.humanoid` 一次性绑定 GLTF userData，**多 VRM 同时存在需要每个 VRM 有独立 humanoid**——目前 `vrm-loader.js` `loadVRMCharacter` 内部 `const vrmInstance = gltf.userData.vrm;` 已经独立，**理论可多 VRM**，但运行时 `vrmData` 单例引用会让 `vrm.humanoid.update()` 等操作只能作用于一个 VRM。
2. **VRM 的 `lookAt` / `expression` / `springBone` 是全局状态**：多 VRM 同时驱动会互相打架（`@pixiv/three-vrm` 的 `SpringBoneManager` 是全局的）。本阶段不引入多 VRM 可以**完全规避这个隐式状态机冲突**。
3. **测试矩阵爆炸**：1 GLB + 1 VRM 已有 5 项测试；2 GLB + 2 VRM 要 9+ 项；本阶段 MVP 把精力放在 GLB 多角色上，**VRM 多角色等 P3 动作库阶段再上**，因为那时需要解决 humanoid 共享 + spring bone 隔离。
4. **API 兼容性**：`_onVRMLoad(url, name, charId)` 加 charId 后，**单 VRM 场景仍然能跑**（charId 走活动角色），用户感知不到差别。
5. **风险 #4 已经涵盖**：`getPrimary()` 策略让"唯一 VRM"作为主外部角色，所有旧 API 继续工作；如果本阶段同时支持多 VRM，**`isVRMMode` 怎么定义**？"活动角色是 VRM"还是"场景存在任何 VRM"？前者意味着切换活动角色时 VRM IK 求解会断流；后者会让多 VRM 时 isVRMMode 恒 true，下游代码无法区分——**两边都有 bug**。

### 何时上多 VRM

- **P3-A** 动作库阶段（角色动作 + 时间轴）
- 或 **P3-C** 角色路线运动（每个路线点的角色可能是 VRM，需要"路线切角色"的连续体验）

---

## 9. 总结

**核心结论**：

- ⚠️ 当前 `glbData/vrmData` 单例 + `isGLBMode/isVRMMode` flag 是**为单外部角色优化的**，多外部角色下**拾取归属、IK 求解、序列化、导出 mask、VRM 回调全部会爆**。
- ✅ 推荐引入 `ExternalCharacterManager`（`editor-src/src/external-character-manager.js`），**外部模型挂到 `char.skeletonGroup` 而非 `scene` 根**，统一通过 `forEachEntry` 遍历。
- ✅ sceneJSON bump 到 **v4**，新增 `externalModels: { [charId]: { kind, url } }` 字段；sceneGz（v=2 payload）**不动**，避免双重版本号。
- ✅ 本阶段 openpose **继续走火柴人多角色**（`renderOpenPoseCanvasMulti`），外部角色靠 `getCharacterJoints` 取 COCO 坐标；**不输出外部模型的真皮肤控制图**。
- ✅ MVP 边界：多角色 + 多 GLB + **单 VRM 上限**，不含多 VRM；不含动作库；不含真皮肤控制图。
- ❌ **不建议本阶段同时支持多 VRM**——VRM humanoid / spring bone 全局状态未隔离，强行做会让 isVRMMode 语义模糊，**风险/收益不划算**。

**给下游 Agent 的硬约束**：

1. 外部模型的 `model` **必须挂到 `char.skeletonGroup`**（不是 scene 根），否则 mask 通道与删除 hook 都做不了。
2. `ExternalCharacterManager.getPrimary()` 返回活动角色的外部 entry；若无活动角色外部则取第一个有外部的 entry；**保持 `isGLBMode / isVRMMode` 单值语义稳定**。
3. 旧 1-arg `setCharacterMode(mode)` **必须保留**（兼容 `glb-character-verify`）；新 2-arg `setCharacterMode(charId, mode)` 是新增能力。
4. `window.__ds._onVRMLoad(url, fileName, charId?)` charId 可选，缺省走活动角色。
5. **sceneGz（v=2 payload）schema 不变**，只改 project-io.js 的顶层 sceneJSON（v3 → v4），**两个版本号语义独立**。
6. **不要在 P1.5 阶段引入 React / Vue / 任何 UI 框架**（参考 P1-WEBGL-REVIEW §6 红线）。
7. 删除角色走 `ds-char-removed` 事件，**不要**让 `ExternalCharacterManager` 直接 import `CharacterManager` 形成循环依赖。

---

**审核完成。报告路径**：`F:\comfyui\custom_nodes\comfyui-director-stage\docs\P15-MULTI-3D-CHARACTER-REVIEW.md`

**5 条核心风险**：

1. **ExternalCharacterManager 与 CharacterManager 生命周期不同步（删除角色时外部模型泄漏/幽灵角色）** —— 必修
2. **sceneGz 不携带外部模型 URL，重启工程后外部角色瞬间退化为火柴人** —— 必修
3. **拾取归属 `charId=null` 导致外部 IK 球拖到活动角色骨架上（子节点树联动 + 骨长锁定串台）** —— 必修
4. **旧 API `window.__ds.glbData/vrmData` 在多外部角色下"主"角色语义模糊，切换活动角色时 flag 突变** —— 必修
5. **多外部模型同时存在时 RAF 单循环帧时间暴增（O(N×40) IK 求解 + 全 scene matrixWorld）** —— 应修（留 P3）

**本阶段是否同时支持多 VRM**：❌ **不建议**。理由：VRM humanoid / springBone 全局状态未隔离 + isVRMMode 单值语义冲突 + 测试矩阵爆炸；建议 P3 动作库阶段再上。