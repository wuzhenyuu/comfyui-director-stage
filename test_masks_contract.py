"""P0 回归测试：char_masks 契约 —— 兼容两种 manifest 布局。

布局 A：masks 嵌在 cameras[i].masks（示例工作流手写格式）
布局 B：masks 在 manifest 顶层，按 cameraId 归属（export.js 实际导出格式）

不依赖 ComfyUI 运行时：mock folder_paths 后可直接 python 执行。
"""

import json
import os
import sys
import tempfile

import numpy as np
import torch
from PIL import Image

# ---- mock folder_paths（节点模块顶层 import）----
TMPDIR = tempfile.mkdtemp(prefix="ds_mask_test_")


class _FakeFolderPaths:
    @staticmethod
    def get_input_directory():
        return TMPDIR

    @staticmethod
    def get_annotated_filepath(rel):
        return os.path.join(TMPDIR, rel)


sys.modules["folder_paths"] = _FakeFolderPaths

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nodes  # noqa: E402

W, H = 64, 48

# ---- 造测试 mask 图（非零灰度，验证内容真的被读到）----
os.makedirs(os.path.join(TMPDIR, "director_stage"), exist_ok=True)
for name, gray in [("mask_a.png", 200), ("mask_b.png", 120)]:
    img = Image.fromarray(np.full((H, W), gray, dtype=np.uint8), mode="L")
    img.save(os.path.join(TMPDIR, "director_stage", name))

CAMERA_ID = "cam_01"

manifest_layout_a = {
    "version": 2,
    "cameras": [{
        "id": CAMERA_ID, "name": "主镜头",
        "files": {},
        "width": W, "height": H,
        "masks": [
            {"name": "角色A", "file": "director_stage/mask_a.png"},
            {"name": "角色B", "file": "director_stage/mask_b.png"},
        ],
    }],
}

manifest_layout_b = {
    "version": 2,
    "cameras": [{
        "id": CAMERA_ID, "name": "主镜头",
        "files": {},
        "width": W, "height": H,
    }],
    "masks": [
        {"charId": "char_01", "name": "角色A", "cameraId": CAMERA_ID, "file": "director_stage/mask_a.png"},
        {"charId": "char_02", "name": "角色B", "cameraId": CAMERA_ID, "file": "director_stage/mask_b.png"},
        # 属于其他机位的 mask 应被过滤掉
        {"charId": "char_03", "name": "角色C", "cameraId": "cam_02", "file": "director_stage/mask_a.png"},
    ],
}

passed, failed = 0, 0


def check(label, cond):
    global passed, failed
    if cond:
        passed += 1
        print("  PASS  %s" % label)
    else:
        failed += 1
        print("  FAIL  %s" % label)


def run_case(label, manifest):
    print("== %s ==" % label)
    stage = nodes.DirectorStage()
    out = stage.run(width=W, height=H, manifest=json.dumps(manifest))
    masks = out[4]
    check("DirectorStage char_masks 形状 [2,1,H,W]",
          isinstance(masks, torch.Tensor) and tuple(masks.shape) == (2, 1, H, W))
    check("DirectorStage char_masks 非零（内容真实读取）",
          float(masks.max()) > 0.4)

    shot = nodes.DirectorStageShot()
    out2 = shot.run(manifest=json.dumps(manifest), camera_index=0, width=W, height=H)
    masks2 = out2[4]
    check("DirectorStageShot char_masks 形状 [2,1,H,W]",
          isinstance(masks2, torch.Tensor) and tuple(masks2.shape) == (2, 1, H, W))
    check("DirectorStageShot char_masks 非零",
          float(masks2.max()) > 0.4)


run_case("布局 A：masks 嵌在 camera 内", manifest_layout_a)
run_case("布局 B：masks 在顶层按 cameraId 过滤", manifest_layout_b)

# 边界：无 masks → 空白兜底不炸
print("== 边界：无 masks ==")
out = nodes.DirectorStage().run(width=W, height=H,
                                manifest=json.dumps({"version": 2, "cameras": [{"id": "c", "files": {}, "width": W, "height": H}]}))
check("无 masks 时输出 [1,1,H,W] 空白", tuple(out[4].shape) == (1, 1, H, W) and float(out[4].max()) == 0.0)

# 边界：M1 格式 → 空白不炸
out = nodes.DirectorStage().run(width=W, height=H, manifest=json.dumps({"files": {}}))
check("M1 格式输出 [1,1,H,W] 空白", tuple(out[4].shape) == (1, 1, H, W))

print("\n结果: %d passed, %d failed" % (passed, failed))
sys.exit(1 if failed else 0)
