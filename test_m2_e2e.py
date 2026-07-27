"""M2 multi-camera + mask E2E test（需要运行中的 ComfyUI）。

环境变量：
  COMFYUI_API  — 默认 http://127.0.0.1:8388
  COMFYUI_DIR  — 默认 F:/comfyui
"""
import io
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

os.makedirs(INPUT, exist_ok=True)

# 本脚本创建的文件（cleanup 只删这些）
test_files = [
    "pose_cam1.png", "depth_cam1.png", "normal_cam1.png",
    "lineart_cam1.png", "mask_char1_cam1.png", "mask_char2_cam1.png",
    "test_upload.png",
]
for name in test_files[:-1]:
    img = Image.fromarray((np.random.rand(64, 64, 3) * 255).astype(np.uint8))
    img.save(os.path.join(INPUT, name))


def wait_for_history(pid, timeout=POLL_TIMEOUT):
    """轮询 /history/{pid} 直到出结果或超时（替代 sleep 硬等待）。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            h = requests.get(f"{API}/history/{pid}", timeout=10).json()
            if pid in h:
                return h
        except Exception:
            pass
        time.sleep(1)
    return None


def check_outputs(h, pid):
    outs = h.get(pid, {}).get("outputs", {})
    for k in sorted(outs.keys()):
        for img in outs[k].get("images", []):
            fp = os.path.join(OUTPUT, img["filename"])
            exist = os.path.exists(fp)
            print(f"  Output {k}: {img['filename']} ({os.path.getsize(fp) if exist else 0}b) {'OK' if exist else 'MISSING'}")


# M2 manifest with cameras + masks
m2_manifest = json.dumps({
    "version": 2,
    "cameras": [{
        "id": "cam_01", "name": "Main",
        "files": {
            "openpose": "director_stage/pose_cam1.png",
            "depth": "director_stage/depth_cam1.png",
            "normal": "director_stage/normal_cam1.png",
            "lineart": "director_stage/lineart_cam1.png"
        },
        "width": 512, "height": 512
    }],
    "masks": [
        {"charId": "char_01", "cameraId": "cam_01", "file": "director_stage/mask_char1_cam1.png"},
        {"charId": "char_02", "cameraId": "cam_01", "file": "director_stage/mask_char2_cam1.png"}
    ]
})

# Test 1: DirectorStage M2 six-channel output
print("=== Test 1: DirectorStage M2 six-channel ===")
wf = {
    "1": {"inputs": {"width": 512, "height": 512, "manifest": m2_manifest}, "class_type": "DirectorStage"},
    "2": {"inputs": {"filename_prefix": "ds_m2", "images": ["1", 0]}, "class_type": "SaveImage"}
}
r = requests.post(f"{API}/prompt", json={"prompt": wf}).json()
print(f"  Prompt: {r.get('prompt_id', 'FAIL')}")
if r.get("prompt_id"):
    h = wait_for_history(r["prompt_id"])
    if h:
        check_outputs(h, r["prompt_id"])
    else:
        print(f"  TIMEOUT: no history within {POLL_TIMEOUT}s")

# Test 2: DirectorStageShot single camera
print("\n=== Test 2: DirectorStageShot ===")
wf2 = {
    "1": {"inputs": {"manifest": m2_manifest, "camera_index": 0}, "class_type": "DirectorStageShot"},
    "2": {"inputs": {"filename_prefix": "ds_shot", "images": ["1", 0]}, "class_type": "SaveImage"}
}
r2 = requests.post(f"{API}/prompt", json={"prompt": wf2}).json()
print(f"  Prompt: {r2.get('prompt_id', 'FAIL')}")
if r2.get("prompt_id"):
    h2 = wait_for_history(r2["prompt_id"])
    if h2:
        check_outputs(h2, r2["prompt_id"])
    else:
        print(f"  TIMEOUT: no history within {POLL_TIMEOUT}s")

# Test 3: Empty manifest (edge case)
print("\n=== Test 3: Empty manifest ===")
wf3 = {
    "1": {"inputs": {"width": 512, "height": 512, "manifest": "{}"}, "class_type": "DirectorStage"},
    "2": {"inputs": {"filename_prefix": "ds_empty", "images": ["1", 0]}, "class_type": "SaveImage"}
}
r3 = requests.post(f"{API}/prompt", json={"prompt": wf3}).json()
print(f"  Prompt: {r3.get('prompt_id', 'FAIL')} | errors: {r3.get('node_errors', {})}")
if r3.get("prompt_id"):
    h3 = wait_for_history(r3["prompt_id"])
    if h3:
        check_outputs(h3, r3["prompt_id"])
    else:
        print(f"  TIMEOUT: no history within {POLL_TIMEOUT}s")

# Test 4: Upload endpoint
print("\n=== Test 4: Upload ===")
img_buf = io.BytesIO()
Image.fromarray((np.random.rand(64, 64, 3) * 255).astype(np.uint8)).save(img_buf, "PNG")
img_buf.seek(0)
files = {"image": ("test_upload.png", img_buf, "image/png")}
data = {"subfolder": "director_stage", "type": "input"}
ur = requests.post(f"{API}/upload/image", files=files, data=data)
print(f"  Upload: HTTP {ur.status_code} | {ur.json()}")

# Cleanup：只删本脚本创建的文件
for f in test_files:
    p = os.path.join(INPUT, f)
    if os.path.isfile(p):
        os.remove(p)

print("\nAll tests complete.")
