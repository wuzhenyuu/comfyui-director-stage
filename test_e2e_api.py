"""E2E test for DirectorStage / DirectorStageShot（需要运行中的 ComfyUI）。

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

# 本脚本创建的文件（cleanup 只删这些，绝不动他人文件）
CREATED = [
    "pose_test_e2e.png",
    "depth_test_e2e.png",
    "normal_test_e2e.png",
    "lineart_test_e2e.png",
]


def wait_for_history(pid, timeout=POLL_TIMEOUT):
    """轮询 /history/{pid} 直到出结果或超时，返回 history dict（超时 None）。"""
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
    print(f"   Node outputs: {list(outs.keys())}")
    for k, v in outs.items():
        for img in v.get("images", []):
            fpath = os.path.join(OUTPUT, img["filename"])
            if os.path.exists(fpath):
                print(f"     OK {img['filename']} ({os.path.getsize(fpath)} bytes)")
            else:
                print(f"     MISSING: {img['filename']}")


# 0. 自包含：先创建测试输入图
os.makedirs(INPUT, exist_ok=True)
for name in CREATED:
    img = Image.fromarray((np.random.rand(64, 64, 3) * 255).astype(np.uint8))
    img.save(os.path.join(INPUT, name))
print(f"0. Created {len(CREATED)} test images in {INPUT}")

manifest = json.dumps({
    "files": {
        "openpose": "director_stage/pose_test_e2e.png",
        "depth": "director_stage/depth_test_e2e.png",
        "normal": "director_stage/normal_test_e2e.png",
        "lineart": "director_stage/lineart_test_e2e.png"
    }
})

workflow = {
    "1": {"inputs": {"width": 512, "height": 512, "manifest": manifest}, "class_type": "DirectorStage"},
    "2": {"inputs": {"filename_prefix": "ds_test", "images": ["1", 0]}, "class_type": "SaveImage"}
}

print("1. Submitting DirectorStage workflow...")
rj = requests.post(f"{API}/prompt", json={"prompt": workflow}).json()
print(f"   Response: {rj}")
if "prompt_id" in rj:
    pid = rj["prompt_id"]
    print(f"2. Polling history for {pid} (timeout {POLL_TIMEOUT}s)...")
    h = wait_for_history(pid)
    if h:
        print("3. Checking history...")
        check_outputs(h, pid)
    else:
        print(f"   TIMEOUT: no history for {pid} within {POLL_TIMEOUT}s")
else:
    print("   No prompt_id in response")
    if "node_errors" in rj:
        print(f"   Node errors: {rj['node_errors']}")

# 4. DirectorStageShot 提交（此前只构造 manifest 从未提交，是死测试）
print("\n4. Testing DirectorStageShot...")
m2_manifest = json.dumps({
    "version": 2,
    "cameras": [{
        "id": "cam_01", "name": "Test",
        "files": {
            "openpose": "director_stage/pose_test_e2e.png",
            "depth": "director_stage/depth_test_e2e.png"
        },
        "width": 512, "height": 512
    }]
})
shot_workflow = {
    "1": {"inputs": {"manifest": m2_manifest, "camera_index": 0}, "class_type": "DirectorStageShot"},
    "2": {"inputs": {"filename_prefix": "ds_shot_e2e", "images": ["1", 0]}, "class_type": "SaveImage"}
}
rj2 = requests.post(f"{API}/prompt", json={"prompt": shot_workflow}).json()
print(f"   Response: {rj2}")
if "prompt_id" in rj2:
    pid2 = rj2["prompt_id"]
    h2 = wait_for_history(pid2)
    if h2:
        check_outputs(h2, pid2)
    else:
        print(f"   TIMEOUT: no history for {pid2} within {POLL_TIMEOUT}s")
else:
    print("   No prompt_id in response")
    if "node_errors" in rj2:
        print(f"   Node errors: {rj2['node_errors']}")

# 5. Cleanup：只删本脚本创建的文件
print("\n5. Cleanup test images (only files created by this script)")
for f in CREATED:
    p = os.path.join(INPUT, f)
    if os.path.exists(p):
        os.remove(p)
        print(f"   Removed {f}")

print("Test complete.")
