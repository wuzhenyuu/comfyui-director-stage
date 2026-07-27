"""Test DirectorStageShot（需要运行中的 ComfyUI）。

环境变量：
  COMFYUI_API  — 默认 http://127.0.0.1:8388
  COMFYUI_DIR  — 默认 F:/comfyui
"""
import json
import os
import sys
import time

import numpy as np
import requests
from PIL import Image

API = os.environ.get("COMFYUI_API", "http://127.0.0.1:8388")
COMFYUI_DIR = os.environ.get("COMFYUI_DIR", "F:/comfyui")
INPUT = os.path.join(COMFYUI_DIR, "input", "director_stage")
OUTPUT = os.path.join(COMFYUI_DIR, "output")
POLL_TIMEOUT = 60  # 秒

RESULTS = {"pass": 0, "fail": 0}


def expect(cond, label):
    if cond:
        RESULTS["pass"] += 1
        print(f"  PASS {label}")
    else:
        RESULTS["fail"] += 1
        print(f"  FAIL {label}")


def check_image_content(fpath, expect_size=(512, 512), expect_blank=False):
    """读回输出 PNG 断言尺寸与是否全零（P2-4：空白兜底图与成功输出必须可区分）。"""
    name = os.path.basename(fpath)
    try:
        img = Image.open(fpath)
        arr = np.asarray(img.convert("RGB"))
        if expect_size is not None:
            expect(img.size == expect_size,
                   f"{name} 尺寸 == {expect_size}（实际 {img.size}）")
        nonzero = bool(arr.any())
        if expect_blank:
            expect(not nonzero, f"{name} 为全零空白图（兜底行为符合预期）")
        else:
            expect(nonzero, f"{name} 内容非全零（非兜底空白图）")
    except Exception as e:
        expect(False, f"{name} 读回失败: {e}")

# 本脚本创建的文件（cleanup 只删这些）
CREATED = ["pose_cam1.png", "depth_cam1.png"]

os.makedirs(INPUT, exist_ok=True)

# Create test image
img = Image.fromarray((np.random.rand(64, 64, 3) * 255).astype(np.uint8))
for name in CREATED:
    img.save(os.path.join(INPUT, name))

m2 = json.dumps({
    "version": 2,
    "cameras": [{
        "id": "cam_01", "name": "Main",
        "files": {
            "openpose": "director_stage/pose_cam1.png",
            "depth": "director_stage/depth_cam1.png"
        },
        "width": 512, "height": 512
    }]
})

wf = {
    "1": {"inputs": {"scene_gz": "", "manifest": m2, "camera_index": 0}, "class_type": "DirectorStageShot"},
    "2": {"inputs": {"filename_prefix": "ds_shot3", "images": ["1", 0]}, "class_type": "SaveImage"}
}
r = requests.post(f"{API}/prompt", json={"prompt": wf}).json()
print(f"Response: {json.dumps(r)}")

if r.get("prompt_id"):
    pid = r["prompt_id"]
    # 轮询 /history/{pid}（超时 60s），替代 sleep(8) 硬等待
    h = None
    deadline = time.time() + POLL_TIMEOUT
    while time.time() < deadline:
        try:
            tmp = requests.get(f"{API}/history/{pid}", timeout=10).json()
            if pid in tmp:
                h = tmp
                break
        except Exception:
            pass
        time.sleep(1)
    if h is None:
        print(f"TIMEOUT: no history for {pid} within {POLL_TIMEOUT}s")
    else:
        outs = h.get(pid, {}).get("outputs", {})
        for k, v in outs.items():
            for img in v.get("images", []):
                fp = os.path.join(OUTPUT, img["filename"])
                if os.path.exists(fp):
                    print(f"  OK {img['filename']} ({os.path.getsize(fp)}b)")
                    check_image_content(fp, expect_size=(512, 512))
                else:
                    print(f"  MISSING {img['filename']}")
                    expect(False, f"{img['filename']} 文件存在")

# cleanup：只删本脚本创建的文件
for f in CREATED:
    p = os.path.join(INPUT, f)
    if os.path.isfile(p):
        os.remove(p)
print("Done")
print(f"内容断言: {RESULTS['pass']} passed, {RESULTS['fail']} failed")
sys.exit(1 if RESULTS["fail"] else 0)
