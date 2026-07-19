"""Test DirectorStageShot"""
import json, requests, time, os
import numpy as np
from PIL import Image

API = "http://127.0.0.1:8388"
INPUT = "F:/comfyui/input/director_stage"
OUTPUT = "F:/comfyui/output"
os.makedirs(INPUT, exist_ok=True)

# Create test image
img = Image.fromarray((np.random.rand(64,64,3)*255).astype(np.uint8))
img.save(f"{INPUT}/pose_cam1.png")
img.save(f"{INPUT}/depth_cam1.png")

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
    time.sleep(8)
    h = requests.get(f"{API}/history/{pid}").json()
    outs = h.get(pid, {}).get("outputs", {})
    for k, v in outs.items():
        for img in v.get("images", []):
            fp = f"{OUTPUT}/{img['filename']}"
            if os.path.exists(fp):
                print(f"  OK {img['filename']} ({os.path.getsize(fp)}b)")
            else:
                print(f"  MISSING {img['filename']}")

# cleanup
for f in os.listdir(INPUT):
    p = os.path.join(INPUT, f)
    if os.path.isfile(p):
        os.remove(p)
print("Done")
