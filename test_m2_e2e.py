"""M2 multi-camera + mask E2E test"""
import json, requests, time, os
import numpy as np
from PIL import Image

API = "http://127.0.0.1:8388"
INPUT = "F:/comfyui/input/director_stage"
OUTPUT = "F:/comfyui/output"

os.makedirs(INPUT, exist_ok=True)

# Create test images
test_files = [
    "pose_cam1.png", "depth_cam1.png", "normal_cam1.png",
    "lineart_cam1.png", "mask_char1_cam1.png", "mask_char2_cam1.png"
]
for name in test_files:
    img = Image.fromarray((np.random.rand(64,64,3)*255).astype(np.uint8))
    img.save(os.path.join(INPUT, name))

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

results = []

# Test 1: DirectorStage M2 six-channel output
print("=== Test 1: DirectorStage M2 six-channel ===")
wf = {
    "1": {"inputs": {"width": 512, "height": 512, "manifest": m2_manifest}, "class_type": "DirectorStage"},
    "2": {"inputs": {"filename_prefix": "ds_m2", "images": ["1", 0]}, "class_type": "SaveImage"}
}
r = requests.post(f"{API}/prompt", json={"prompt": wf}).json()
print(f"  Prompt: {r.get('prompt_id', 'FAIL')}")
if r.get("prompt_id"):
    time.sleep(10)
    h = requests.get(f"{API}/history/{r['prompt_id']}").json()
    outs = h.get(r["prompt_id"], {}).get("outputs", {})
    for k in sorted(outs.keys()):
        for img in outs[k].get("images", []):
            fp = os.path.join(OUTPUT, img["filename"])
            exist = os.path.exists(fp)
            print(f"  Output {k}: {img['filename']} ({os.path.getsize(fp) if exist else 0}b) {'OK' if exist else 'MISSING'}")

# Test 2: DirectorStageShot single camera
print("\n=== Test 2: DirectorStageShot ===")
wf2 = {
    "1": {"inputs": {"manifest": m2_manifest, "camera_index": 0}, "class_type": "DirectorStageShot"},
    "2": {"inputs": {"filename_prefix": "ds_shot", "images": ["1", 0]}, "class_type": "SaveImage"}
}
r2 = requests.post(f"{API}/prompt", json={"prompt": wf2}).json()
print(f"  Prompt: {r2.get('prompt_id', 'FAIL')}")
if r2.get("prompt_id"):
    time.sleep(8)
    h2 = requests.get(f"{API}/history/{r2['prompt_id']}").json()
    outs2 = h2.get(r2["prompt_id"], {}).get("outputs", {})
    for k in sorted(outs2.keys()):
        for img in outs2[k].get("images", []):
            fp = os.path.join(OUTPUT, img["filename"])
            exist = os.path.exists(fp)
            print(f"  Output {k}: {img['filename']} ({os.path.getsize(fp) if exist else 0}b) {'OK' if exist else 'MISSING'}")

# Test 3: Empty manifest (edge case)
print("\n=== Test 3: Empty manifest ===")
wf3 = {
    "1": {"inputs": {"width": 512, "height": 512, "manifest": "{}"}, "class_type": "DirectorStage"},
    "2": {"inputs": {"filename_prefix": "ds_empty", "images": ["1", 0]}, "class_type": "SaveImage"}
}
r3 = requests.post(f"{API}/prompt", json={"prompt": wf3}).json()
print(f"  Prompt: {r3.get('prompt_id', 'FAIL')} | errors: {r3.get('node_errors', {})}")
if r3.get("prompt_id"):
    time.sleep(8)
    h3 = requests.get(f"{API}/history/{r3['prompt_id']}").json()
    outs3 = h3.get(r3["prompt_id"], {}).get("outputs", {})
    for k in sorted(outs3.keys()):
        for img in outs3[k].get("images", []):
            fp = os.path.join(OUTPUT, img["filename"])
            exist = os.path.exists(fp)
            print(f"  Output {k}: {img['filename']} ({os.path.getsize(fp) if exist else 0}b) {'OK' if exist else 'MISSING'}")

# Test 4: Upload endpoint
print("\n=== Test 4: Upload ===")
import io
img_buf = io.BytesIO()
Image.fromarray((np.random.rand(64,64,3)*255).astype(np.uint8)).save(img_buf, "PNG")
img_buf.seek(0)
files = {"image": ("test_upload.png", img_buf, "image/png")}
data = {"subfolder": "director_stage", "type": "input"}
ur = requests.post(f"{API}/upload/image", files=files, data=data)
print(f"  Upload: HTTP {ur.status_code} | {ur.json()}")

# Cleanup
for f in os.listdir(INPUT):
    p = os.path.join(INPUT, f)
    if os.path.isfile(p):
        os.remove(p)

print("\nAll tests complete.")
