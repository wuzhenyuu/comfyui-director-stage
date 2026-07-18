# QA 端到端测试：模拟编辑器上传控制图 → 提交 DirectorStage 队列 → 校验输出
import json
import time
import urllib.request
import uuid
import os

BASE = "http://127.0.0.1:8388"
SRC = r"F:\comfyui\custom_nodes\comfyui-director-stage\editor-src\test\out"


def upload(path, name):
    """复现编辑器 uploadCanvas 的 multipart 上传契约。"""
    boundary = "----qa" + uuid.uuid4().hex
    with open(path, "rb") as f:
        data = f.read()
    parts = []
    def field(k, v):
        parts.append(("--%s\r\nContent-Disposition: form-data; name=\"%s\"\r\n\r\n%s\r\n" % (boundary, k, v)).encode())
    parts.append((
        "--%s\r\nContent-Disposition: form-data; name=\"image\"; filename=\"%s\"\r\n"
        "Content-Type: image/png\r\n\r\n" % (boundary, name)
    ).encode())
    parts.append(data)
    parts.append(b"\r\n")
    field("subfolder", "director_stage")
    field("type", "input")
    parts.append(("--%s--\r\n" % boundary).encode())
    body = b"".join(parts)
    req = urllib.request.Request(
        BASE + "/upload/image", data=body, method="POST",
        headers={"Content-Type": "multipart/form-data; boundary=" + boundary},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        j = json.loads(r.read().decode())
    rel = (j.get("subfolder", "") + "/" if j.get("subfolder") else "") + j["name"]
    print("uploaded:", rel)
    return rel


op = upload(os.path.join(SRC, "openpose.png"), "qa_pose_%d.png" % time.time())
dp = upload(os.path.join(SRC, "depth.png"), "qa_depth_%d.png" % time.time())
manifest = json.dumps({"files": {"openpose": op, "depth": dp}})

prompt = {
    "1": {"class_type": "DirectorStage", "inputs": {
        "width": 512, "height": 768, "scene_gz": "", "manifest": manifest}},
    "2": {"class_type": "SaveImage", "inputs": {
        "images": ["1", 0], "filename_prefix": "qa_ds_openpose"}},
    "3": {"class_type": "SaveImage", "inputs": {
        "images": ["1", 1], "filename_prefix": "qa_ds_depth"}},
}
req = urllib.request.Request(
    BASE + "/prompt", data=json.dumps({"prompt": prompt}).encode(),
    headers={"Content-Type": "application/json"}, method="POST")
with urllib.request.urlopen(req, timeout=30) as r:
    resp = json.loads(r.read().decode())
pid = resp.get("prompt_id")
print("queued prompt_id:", pid, "node_errors:", resp.get("node_errors"))

# 轮询 history
for _ in range(60):
    time.sleep(2)
    with urllib.request.urlopen(BASE + "/history/" + pid, timeout=10) as r:
        h = json.loads(r.read().decode())
    if pid in h:
        st = h[pid].get("status", {})
        print("status:", st.get("status_str"), "completed:", st.get("completed"))
        outs = h[pid].get("outputs", {})
        for nid, o in outs.items():
            for img in o.get("images", []):
                print("output node", nid, "->", img.get("subfolder", ""), img.get("filename"))
        if st.get("status_str") == "error":
            print("MESSAGES:", json.dumps(st.get("messages", []), ensure_ascii=False)[:1500])
        break
else:
    print("TIMEOUT waiting history")

# 空 manifest 容错测试：不给 manifest，应输出空白图不报错
prompt2 = {
    "1": {"class_type": "DirectorStage", "inputs": {
        "width": 256, "height": 256, "scene_gz": "", "manifest": "{}"}},
    "2": {"class_type": "PreviewImage", "inputs": {"images": ["1", 0]}},
    "3": {"class_type": "PreviewImage", "inputs": {"images": ["1", 1]}},
}
req = urllib.request.Request(
    BASE + "/prompt", data=json.dumps({"prompt": prompt2}).encode(),
    headers={"Content-Type": "application/json"}, method="POST")
with urllib.request.urlopen(req, timeout=30) as r:
    resp2 = json.loads(r.read().decode())
pid2 = resp2.get("prompt_id")
print("queued empty-manifest prompt_id:", pid2)
for _ in range(60):
    time.sleep(2)
    with urllib.request.urlopen(BASE + "/history/" + pid2, timeout=10) as r:
        h = json.loads(r.read().decode())
    if pid2 in h:
        st = h[pid2].get("status", {})
        print("empty-manifest status:", st.get("status_str"), "completed:", st.get("completed"))
        if st.get("status_str") == "error":
            print("MESSAGES:", json.dumps(st.get("messages", []), ensure_ascii=False)[:1500])
        break
else:
    print("TIMEOUT waiting history 2")
print("E2E DONE")
