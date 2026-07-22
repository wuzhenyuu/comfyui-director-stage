# 多人功能契约（M4）— 并发开发防冲突必读

> 三个 agent 并发改不同文件，**必须严格遵守本契约的接口约定**。
> 项目：`F:\ComfyUI\custom_nodes\comfyui-director-stage`，编辑器源码在 `editor-src/src/`。
> **不要** `npm run build`、**不要** `git commit`——由主 agent 统一集成。
> 改完用 `node --check <file>` 验证语法即可。

## 架构速览

- 视口 = 2D Canvas（零 WebGL 依赖），Three.js 场景仅存数据/供导出
- `renderLoop`（main.js）每帧：`scene.updateMatrixWorld()` → `drawFrame(...)`（scene.js）
- 关节拖拽 = 屏幕平面拖拽（controls.js `setupPointerEvents`）
- 多角色底层已有：`CharacterManager`（figure.js），`window.DS_FigureAPI` 暴露：
  - `getAllCharacters(): Map<id, char>` — char 含 `{id, name, color, jointSpheres[18], ikState, skeletonGroup, ...}`
  - `getActiveCharacter(): char | null`
  - `setActive(id)`
- `char.color` 是十六进制数字（如 0xff9966），2D 绘制需转 CSS：`"#" + color.toString(16).padStart(6, "0")`

## 契约 1：屏幕拾取缓存 `window.__ds_jointScreen`（scene.js 写，controls.js 读）

每项格式：
```js
{ x, y, behind, obj, charId }
// x/y: canvas CSS 像素坐标（绘制用 getWorldPosition 投影，与世界坐标一致）
// behind: 相机背后=true（不可拾取）
// obj: 关节 mesh 或 IK target/pole mesh（拾取返回它）
// charId: 所属角色 id（string）；GLB/VRM 的 IK 球可为 null
```

- FK 模式：**所有角色**的关节都画都缓存
- IK 模式：只画/只缓存**活动角色**的 IK target/pole（跨角色 IK 不做）；非活动角色仍画灰色参考火柴人但不进缓存
- 缓存每帧开头重置（现有逻辑保持）

## 契约 2：整人移动开关 `window.__ds_moveWholeBody`（boolean，默认 false）

- UI：工具栏 checkbox，id=`wholeBodyCheckbox`，文案「🧍整人移动」，参照 `ikCheckbox`（main.js:404 附近）的绑定模式
- 开关 ON 且拖拽普通关节（非 IK 球）时：该角色**全部 18 个关节 position += delta**（整人平移），**跳过**子树联动和骨长锁定
- 开关 OFF：维持现状（子树联动 + 骨长锁定）

## 契约 3：拖拽角色归属 `dragChar`（controls.js 内部）

- `beginDrag` 时根据 `obj.userData.characterId`（IK 球有）或拾取缓存 charId（关节球）确定被拖角色，存入 `dragChar`
- `jointsSnapshot` / `applyDragConstraints` / `collectDescendants` / `applyBoneLock` 全部改用 `dragChar.jointSpheres`，**不再**默认 `window.__ds.joints`
- `pointerdown` 命中后：若 charId 存在且 ≠ 活动角色 → `DS_FigureAPI.setActive(charId)` 自动激活（顺带刷新角色面板高亮，调 `updateCharPanelIfExists()`）

## 契约 4：`_dsRef.joints` 改 getter（main.js，Agent B 改）

```js
get joints() {
  return window.DS_FigureAPI?.getActiveCharacter()?.jointSpheres || m1Joints;
}
```
（`m1Joints` = 原闭包 `joints` 兜底）。这样 export/mirror/姿势应用等下游自动跟随活动角色。

## 契约 5：新人错位出生 + 上限（figure.js，Agent C 改）

- `const MAX_CHARACTERS = 8;`（放 constants.js 或 figure.js 顶部均可）
- `create()` 超限：console.warn + `window.__ds?.showToast?.("最多 8 人")`，返回 null
- 错位：创建后按角色序数 n（0-based）给全部 jointSpheres 和 IK target/pole 的 position 加偏移：
  - `offsetX = (n % 4) * 1.4 - 2.1`（一排 4 人，间隔 1.4m）
  - `offsetZ = n >= 4 ? 1.8 : 0`（第 2 排后退 1.8m）
- char-panel.js 加人按钮：达上限时禁用/置灰

## 红线

- 不改 `__ds_jointScreen` 以外的全局变量名；新增全局变量必须先查本契约
- 不碰 `export.js` / `pass-renderer.js` / `nodes.py`
- 保持现有测试通过：`test/drag-verify.mjs` `test/pick-verify.mjs` `test/orbit-verify.mjs`（由主 agent 集成时跑）
