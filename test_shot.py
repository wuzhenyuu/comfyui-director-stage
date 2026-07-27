"""Test DirectorStageShot（需要运行中的 ComfyUI）。

环境变量：
  COMFYUI_API  — 默认 http://127.0.0.1:8388
  COMFYUI_DIR  — 默认 F:/comfyui
"""
import json
import os
import time

import numpy as np
import requests
from PIL import Image

API = os.environ.get("COMFYUI_API", "http://127.0.0.1:8388")
COMFYUI_DIR = os.environ.get("COMFYUI_DIR", "F:/comfyui")
INPUT = os.path.join(COMFYUI_DIR, "input", "director_stage")
OUTPUT = os.path.join(COMFYUI_DIR, "output")
POLL_TIMEOUT = 60  # 秒

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
                else:
                    print(f"  MISSING {img['filename']}")

# cleanup：只删本脚本创建的文件
for f in CREATED:
    p = os.path.join(INPUT, f)
    if os.path.isfile(p):
        os.remove(p)
print("Done")
