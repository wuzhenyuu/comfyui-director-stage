# QA_REPORT —— 3D导演台 M0 审核测试报告

- 测试日期：2026-07-19
- 测试人：QA agent（subagent）
- 测试对象：`F:\comfyui\custom_nodes\comfyui-director-stage`（M0 通路验证版）
- 测试环境：Windows / F:\comfyui venv Python / ComfyUI 独立测试实例 `--port 8388 --cpu`（未触碰 8188）

## 总结论

**✅ M0 可交付。** 静态检查、契约一致性、集成冒烟（含加分项端到端队列执行）全部通过，未发现需要修复的问题（修复数：0）。

---

## 1. 静态检查 —— 全部通过

| 项目 | 结果 | 证据 |
|---|---|---|
| `__init__.py` / `nodes.py` ast.parse | ✅ 通过 | `AST OK: __init__.py nodes.py` |
| `directorStage.js` → `%TEMP%\ds_check.mjs` + `node --check` | ✅ 通过 | `node --check OK: directorStage.js` |
| `web/editor/index.html` 存在且资源为相对路径 | ✅ 通过 | 唯一资源引用 `src="./assets/index-BLSHhtow.js"`；grep `(src|href)="/` 零命中 |
| `editor-src/vite.config.js` 的 `base: "./"` | ✅ 通过 | 文件第 2 行 `base: "./"`，且 `outDir: "../web/editor"` |

构建产物齐全：`web/editor/index.html`（2293 B）+ `web/editor/assets/index-BLSHhtow.js`（625684 B）。

## 2. 契约一致性 —— 全部通过

| 契约点 | nodes.py（后端） | directorStage.js（前端包装） | 结果 |
|---|---|---|---|
| widget 名 `scene_gz` | optional STRING（L60） | `findWidget(node,"scene_gz")`（L63/79/121） | ✅ |
| widget 名 `manifest` | optional STRING（L61） | `findWidget(node,"manifest")`（L80/122） | ✅ |
| 节点名 `DirectorStage` | `NODE_CLASS_MAPPINGS`（L126） | `nodeData.name !== "DirectorStage"` 过滤（L110） | ✅ |
| iframe 路径 | `__init__.py` L35：`web.static("/director_stage/editor", …)` | L36：`iframe.src="/director_stage/editor/index.html"` | ✅ |

编辑器源码（`editor-src/src/main.js`）上传契约：

- ✅ `fetch("/upload/image", {method:"POST", …})`（L386）
- ✅ `fd.append("subfolder", "director_stage")`（L384）
- ✅ `fd.append("type", "input")`（L385）
- ✅ postMessage 四类消息齐全：`ready`（L444，load 后发出）/ `init`（L420 起监听并应用 width/height/sceneGz）/ `exportDone`（L404）/ `cancel`（L417）
- ✅ manifest 结构 `{files:{openpose, depth}}`（L402），与 nodes.py `data.get("files")` → `files.get("openpose"/"depth")` 对齐

构建产物（压缩 bundle）中逐串验证：`/upload/image`、`director_stage`、`exportDone`、`cancel`、`ready`、`init`、`openpose`、`depth`、`files` 全部命中。
注：初次 grep `"input"` 未命中是因为压缩器把双引号换成了反引号，实际代码为 `` r.append(`type`,`input`) ``，契约成立。

## 3. 集成冒烟测试 —— 全部通过

启动方式：`Start-Process F:\comfyui\venv\Scripts\python.exe main.py --port 8388 --cpu --disable-auto-launch`（工作目录 F:\comfyui，PID 4012，日志重定向至 `docs/qa_8388.log` / `qa_8388_err.log`）。

### a) `GET /object_info/DirectorStage` → 200 ✅

返回 JSON 关键字段（摘录）：

```json
{"DirectorStage": {
  "input": {"required": {"width": ["INT", {"default": 1024, "min": 64, "max": 4096, "step": 8}],
                          "height": ["INT", {"default": 1024, ...}]},
             "optional": {"scene_gz": ["STRING", {"default": ""}],
                          "manifest": ["STRING", {"default": "{}"}]}},
  "output": ["IMAGE", "IMAGE"],
  "output_name": ["openpose", "depth"],
  "display_name": "🎬 3D导演台",
  "python_module": "custom_nodes.comfyui-director-stage"}}
```

width/height/scene_gz/manifest 输入与 IMAGE 双输出（openpose/depth）全部符合。

### b) 编辑器静态资源 → 200 ✅

```
/director_stage/editor/index.html                    -> HTTP 200 (2293 B)
/director_stage/editor/assets/index-BLSHhtow.js      -> HTTP 200 (625684 B)
/extensions/comfyui-director-stage/directorStage.js  -> HTTP 200 (3943 B)   # WEB_DIRECTORY 挂载亦正常
```

### c) 启动日志无本插件 import 错误 ✅

- `[3D导演台] 编辑器静态目录已挂载：/director_stage/editor`（stdout log）
- stderr import-times：`0.0 seconds: F:\comfyui\custom_nodes\comfyui-director-stage`（无 FAILED 标记）
- 全日志 grep `IMPORT FAILED` → 零命中（其余第三方插件本次启动也未见 import 失败；latentsync/ImpactPack 等的 INFO 输出与本项目无关）

### d) 加分项：端到端队列执行（脚本 `docs/qa_e2e_prompt.py`）✅

复现编辑器完整链路：multipart 上传 2 张控制图（`subfolder=director_stage`、`type=input`）→ 组 manifest → POST `/prompt`（DirectorStage → 2×SaveImage）→ 轮询 `/history`：

```
uploaded: director_stage/qa_pose_1784407399.png
uploaded: director_stage/qa_depth_1784407399.png
queued prompt_id: 554f9df1-... node_errors: {}
status: success completed: True
output node 2 -> qa_ds_openpose_00001_.png   # 768×512 RGB，与上传源图尺寸一致，RGBA→RGB 正常
output node 3 -> qa_ds_depth_00001_.png
```

空 manifest 容错：`manifest="{}"` 队列同样 `success`，日志正确打印中文警告并输出空白图（未炸队列）：

```
[3D导演台] 警告：manifest 中缺少 openpose 通道文件，输出空白图像（请先在编辑器中点击「应用」导出）。
[3D导演台] 警告：manifest 中缺少 depth 通道文件，输出空白图像（请先在编辑器中点击「应用」导出）。
```

（控制台 GBK 下个别汉字被 `?` 替换属 `_log()` 的预期降级行为，非错误。）

### 清理确认 ✅

- 仅 kill PID 4012（kill 前校验其命令行确为 `main.py --port 8388 --cpu --disable-auto-launch`）
- 端口 8388 已释放；系统中无其他 python 进程被波及（8188 全程无实例在跑，未触碰）
- 已删除 QA 上传/输出的临时 PNG 与 `%TEMP%\ds_check.mjs`

## 4. 修复记录

无。未发现语法错误、路径笔误或缺文件，零改动交付。

## 5. 遗留问题清单（非阻塞，仅记录）

1. **width/height 不参与输出图缩放**：节点直接按 manifest 里 PNG 的实际尺寸输出，width/height 仅用于空白兜底图。真实流程中编辑器按 width/height 渲染导出，二者一致；但若用户手工改 widget 值而不重新「应用」，输出尺寸与 widget 不符。建议 M1 在 `_load_image` 里按需 resize 或加尺寸校验警告。
2. **`IS_CHANGED` 未纳入 scene_gz**：现哈希 manifest+width+height。scene_gz 只影响编辑器回显、不影响输出，当前合理；若未来节点端直接用 scene_gz 渲染需补上。
3. **iframe/postMessage 用 `"*"` targetOrigin 且父页仅校验 `event.source`**：同源部署下风险低，M1 可收紧为同源校验。
4. **上传文件无清理机制**：每次「应用」都会在 `input/director_stage/` 新增时间戳 PNG，长期使用会堆积，建议后续加保留策略。
5. **`editor-src/test/e2e.mjs` 本轮未执行**（属于开发侧 Playwright/浏览器测试，QA 冒烟以 HTTP 层为准）；`viewport.png` 等 test/out 产物随仓库存在，若嫌体积可入 .gitignore。

## 6. 证据文件

- `docs/qa_8388.log` / `docs/qa_8388_err.log`：8388 测试实例完整启动+执行日志
- `docs/qa_e2e_prompt.py`：可复用的端到端冒烟脚本（上传→组 manifest→队列→校验 history）
