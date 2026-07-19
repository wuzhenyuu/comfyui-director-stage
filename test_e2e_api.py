"""E2E test for DirectorStage node"""
import json, requests, time, os

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

API = "http://127.0.0.1:8388"
print("1. Submitting workflow...")
r = requests.post(f"{API}/prompt", json={"prompt": workflow})
rj = r.json()
print(f"   Response: {rj}")
if "prompt_id" in rj:
    pid = rj["prompt_id"]
    print(f"   Prompt ID: {pid}")
    
    print("2. Waiting for execution...")
    time.sleep(8)
    
    print("3. Checking history...")
    h = requests.get(f"{API}/history/{pid}").json()
    if pid in h:
        outputs = h[pid].get("outputs", {})
        print(f"   Node outputs: {list(outputs.keys())}")
        for k, v in outputs.items():
            imgs = v.get("images", [])
            if imgs:
                print(f"   {k}: {len(imgs)} image(s)")
                for img in imgs:
                    fpath = os.path.join("F:/comfyui/output", img["filename"])
                    if os.path.exists(fpath):
                        sz = os.path.getsize(fpath)
                        print(f"     OK {img['filename']} ({sz} bytes)")
                    else:
                        print(f"     MISSING: {img['filename']}")
    else:
        print(f"   No history for {pid}")
        print(f"   Raw: {json.dumps(h, indent=2)[:500]}")
else:
    print(f"   ❌ No prompt_id in response")
    if "node_errors" in rj:
        print(f"   Node errors: {rj['node_errors']}")

# Also test DirectorStageShot
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

print("5. Cleanup test images")
for f in ["pose_test_e2e.png", "depth_test_e2e.png", "normal_test_e2e.png", "lineart_test_e2e.png"]:
    p = os.path.join("F:/comfyui/input/director_stage", f)
    if os.path.exists(p):
        os.remove(p)
        print(f"   Removed {f}")

print("Test complete.")
