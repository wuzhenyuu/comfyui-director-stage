"""单元测试：manifest files 多帧（str | str[]）承载 —— 波次1-B。

脱离 ComfyUI 运行：mock folder_paths + 临时 input 目录构造真实 PNG 帧。

覆盖：
  1. str 单帧行为不变（batch=1，[1,H,W,3]）
  2. str[] 多帧堆叠为 IMAGE batch [N,H,W,3]
  3. 数组内帧尺寸不一致 → 按目标尺寸 resize 对齐后堆叠
  4. mask file str[] → [N,1,H,W] 堆叠（_build_mask_batch）
  5. _iter_manifest_files：数组每帧都纳入文件指纹路径（机位粒度）
  6. _hash_manifest_files：任一帧内容变化 → 指纹变化（IS_CHANGED 语义）
  7. 边界：空数组 / 数组含缺失文件 → 空白兜底，batch 语义明确
  8. DirectorStage.run 端到端：多帧 manifest → 各通道 batch 维度正确

直接运行：python test_multiframe.py
"""

import hashlib
import json
import os
import shutil
import sys
import tempfile

import numpy as np
import torch
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nodes  # noqa: E402

passed, failed = 0, 0


def check(label, cond):
    global passed, failed
    if cond:
        passed += 1
        print("  PASS  %s" % label)
    else:
        failed += 1
        print("  FAIL  %s" % label)


# ---------------------------------------------------------------------------
# 环境：临时 input 目录 + mock folder_paths
# ---------------------------------------------------------------------------
TMP = tempfile.mkdtemp(prefix="ds_multiframe_")
INPUT_DIR = os.path.join(TMP, "input")
SUB_DIR = os.path.join(INPUT_DIR, "director_stage")
os.makedirs(SUB_DIR, exist_ok=True)


class _FakeFolderPaths:
    @staticmethod
    def get_input_directory():
        return INPUT_DIR

    @staticmethod
    def get_annotated_filepath(rel):
        # ComfyUI 的同名函数还支持 "name [input]" 标注，这里 manifest 只写相对路径
        return os.path.join(INPUT_DIR, rel)


_orig_folder_paths = nodes.folder_paths
nodes.folder_paths = _FakeFolderPaths

W, H = 32, 24


def _make_png(name, size=(W, H), seed=0):
    """在 input/director_stage 下生成一张非零随机 PNG，返回 manifest 相对路径。"""
    rng = np.random.RandomState(seed)
    arr = (rng.rand(size[1], size[0], 3) * 255).astype(np.uint8)
    Image.fromarray(arr).save(os.path.join(SUB_DIR, name))
    return "director_stage/%s" % name


def _cleanup():
    nodes.folder_paths = _orig_folder_paths
    shutil.rmtree(TMP, ignore_errors=True)


try:
    # -----------------------------------------------------------------------
    # 1. str 单帧行为不变
    # -----------------------------------------------------------------------
    print("== str 单帧兼容 ==")
    p1 = _make_png("pose_f1.png", seed=1)
    out = nodes._load_image_frames(p1, W, H, "openpose")
    check("str → [1,H,W,3]", tuple(out.shape) == (1, H, W, 3))
    ref = nodes._load_image(p1, W, H, "openpose")
    check("str 结果与 _load_image 完全一致", torch.equal(out, ref))
    check("str 内容非全零（真实加载）", bool(out.any()))

    # -----------------------------------------------------------------------
    # 2. str[] 多帧堆叠
    # -----------------------------------------------------------------------
    print("== str[] 多帧堆叠 ==")
    frames = [_make_png("seq_%d.png" % i, seed=10 + i) for i in range(3)]
    out = nodes._load_image_frames(frames, W, H, "depth")
    check("3 帧 → [3,H,W,3]", tuple(out.shape) == (3, H, W, 3))
    # 帧序保持：第 i 帧与单独加载一致
    ok = all(torch.equal(out[i:i + 1], nodes._load_image(f, W, H, "depth"))
             for i, f in enumerate(frames))
    check("帧序保持（逐帧内容与单独加载一致）", ok)
    out1 = nodes._load_image_frames([frames[0]], W, H, "depth")
    check("单元素数组 → [1,H,W,3]（与 str 等效）",
          tuple(out1.shape) == (1, H, W, 3) and torch.equal(out1, nodes._load_image(frames[0], W, H, "depth")))

    # -----------------------------------------------------------------------
    # 3. 帧尺寸不一致 → resize 对齐
    # -----------------------------------------------------------------------
    print("== 帧尺寸不一致对齐 ==")
    mixed = [_make_png("mix_a.png", size=(W, H), seed=20),
             _make_png("mix_b.png", size=(64, 48), seed=21),
             _make_png("mix_c.png", size=(16, 8), seed=22)]
    out = nodes._load_image_frames(mixed, W, H, "normal")
    check("异尺寸 3 帧 → 仍堆叠为 [3,H,W,3]", tuple(out.shape) == (3, H, W, 3))

    # -----------------------------------------------------------------------
    # 4. mask file str[] → [N,1,H,W]
    # -----------------------------------------------------------------------
    print("== mask 多帧 ==")
    mframes = [_make_png("mask_%d.png" % i, seed=30 + i) for i in range(2)]
    camera = {"id": "cam_01", "masks": [{"name": "角色A", "file": mframes}]}
    manifest = {"cameras": [camera]}
    batch = nodes._build_mask_batch(camera, manifest, W, H)
    check("单条目 2 帧 mask → [2,1,H,W]", tuple(batch.shape) == (2, 1, H, W))
    check("mask batch 内容非全零", bool(batch.any()))
    # 混排：一个 str 条目 + 一个 str[] 条目
    camera2 = {"id": "cam_02", "masks": [
        {"name": "角色A", "file": mframes[0]},
        {"name": "角色B", "file": mframes},
    ]}
    batch2 = nodes._build_mask_batch(camera2, {"cameras": [camera2]}, W, H)
    check("str 条目 + 2 帧数组条目 → [3,1,H,W]", tuple(batch2.shape) == (3, 1, H, W))

    # -----------------------------------------------------------------------
    # 5. _iter_manifest_files：数组每帧纳入（机位粒度 + 全量）
    # -----------------------------------------------------------------------
    print("== _iter_manifest_files 数组覆盖 ==")
    mdata = {
        "version": 2,
        "cameras": [
            {"id": "cam_01",
             "files": {"openpose": frames, "depth": p1},
             "masks": [{"name": "角色A", "file": mframes}]},
            {"id": "cam_02",
             "files": {"openpose": "director_stage/other.png"}},
        ],
    }
    cam_paths = nodes._iter_manifest_files(mdata, camera=mdata["cameras"][0])
    check("机位粒度：数组 3 帧全部纳入", all(f in cam_paths for f in frames))
    check("机位粒度：str 通道纳入", p1 in cam_paths)
    check("机位粒度：mask 数组每帧纳入", all(f in cam_paths for f in mframes))
    check("机位粒度：不含其他机位文件", "director_stage/other.png" not in cam_paths)
    all_paths = nodes._iter_manifest_files(mdata)
    check("全量模式：数组帧 + 其他机位均纳入",
          all(f in all_paths for f in frames) and "director_stage/other.png" in all_paths)

    # -----------------------------------------------------------------------
    # 6. _hash_manifest_files：任一帧变化 → 指纹变化
    # -----------------------------------------------------------------------
    print("== 文件指纹覆盖每帧 ==")

    def _fingerprint():
        h = hashlib.sha256()
        nodes._hash_manifest_files(h, mdata, camera=mdata["cameras"][0])
        return h.hexdigest()

    fp_before = _fingerprint()
    # 重写数组中第 2 帧（同名覆盖，模拟编辑器重导出）
    _make_png("seq_1.png", seed=999)
    fp_after = _fingerprint()
    check("数组中间帧同名覆盖 → 指纹变化", fp_before != fp_after)
    # 恢复（避免影响后续用例无状态假设——其实无依赖，但保持整洁）
    _make_png("seq_1.png", seed=11)

    # -----------------------------------------------------------------------
    # 7. 边界：空数组 / 缺失文件帧
    # -----------------------------------------------------------------------
    print("== 边界兜底 ==")
    out = nodes._load_image_frames([], W, H, "openpose")
    check("空数组 → 空白单帧 [1,H,W,3]",
          tuple(out.shape) == (1, H, W, 3) and not bool(out.any()))
    out = nodes._load_image_frames([frames[0], "director_stage/不存在.png", frames[2]],
                                   W, H, "openpose")
    check("数组含缺失帧 → batch=3 且中间帧为空白", tuple(out.shape) == (3, H, W, 3)
          and not bool(out[1].any()) and bool(out[0].any()) and bool(out[2].any()))
    out = nodes._load_image_frames(["", None, 123], W, H, "openpose")
    check("数组全为非法项 → 空白单帧", tuple(out.shape) == (1, H, W, 3) and not bool(out.any()))
    cam_bad = {"id": "cam_x", "masks": [{"name": "角色A", "file": ["director_stage/不存在.png"]}]}
    bbad = nodes._build_mask_batch(cam_bad, {"cameras": [cam_bad]}, W, H)
    check("mask 数组全部加载失败 → 空白 [1,1,H,W]",
          tuple(bbad.shape) == (1, 1, H, W) and not bool(bbad.any()))

    # -----------------------------------------------------------------------
    # 8. DirectorStage.run 端到端：多机位 × 多帧（各机位帧数不同）
    # -----------------------------------------------------------------------
    print("== 节点端到端（多机位 × 多帧）==")
    cam0_frames = [_make_png("e2e_c0_%d.png" % i, seed=50 + i) for i in range(2)]
    cam1_frames = [_make_png("e2e_c1_%d.png" % i, seed=60 + i) for i in range(3)]
    e2e_manifest = json.dumps({
        "version": 2, "width": W, "height": H,
        "cameras": [
            {"id": "cam_01", "files": {"openpose": cam0_frames, "depth": p1}},
            {"id": "cam_02", "files": {"openpose": cam1_frames}},
        ],
    })
    r = nodes.DirectorStage().run(W, H, manifest=e2e_manifest)
    check("DirectorStage(cameras[0]) openpose → [2,H,W,3]", tuple(r[0].shape) == (2, H, W, 3))
    check("DirectorStage(cameras[0]) depth str → [1,H,W,3]", tuple(r[1].shape) == (1, H, W, 3))
    s0 = nodes.DirectorStageShot().run(manifest=e2e_manifest, camera_index=0, width=W, height=H)
    s1 = nodes.DirectorStageShot().run(manifest=e2e_manifest, camera_index=1, width=W, height=H)
    check("Shot(camera_index=0) openpose → [2,H,W,3]", tuple(s0[0].shape) == (2, H, W, 3))
    check("Shot(camera_index=1) openpose → [3,H,W,3]（各机位帧数可不同）",
          tuple(s1[0].shape) == (3, H, W, 3))
    check("Shot(camera_index=1) 缺省通道 → 空白 [1,H,W,3]",
          tuple(s1[1].shape) == (1, H, W, 3) and not bool(s1[1].any()))
    # IS_CHANGED：机位粒度 + 数组帧指纹（不抛异常且结果稳定）
    ic = nodes.DirectorStageShot.IS_CHANGED(manifest=e2e_manifest, camera_index=1, width=W, height=H)
    check("IS_CHANGED 返回 hex 指纹", isinstance(ic, str) and len(ic) == 64)
finally:
    _cleanup()

print("\n结果: %d passed, %d failed" % (passed, failed))
sys.exit(1 if failed else 0)
