"""ComfyUI「3D导演台」后端节点 —— M2 多通道多机位版。

DirectorStage（主节点）：
  - 读取 manifest.cameras[0] 的所有 pass 文件，输出 openpose / depth / normal / lineart / char_masks / camera_json
  - 向后兼容 M1 格式（files 在顶层级时按旧逻辑输出，新通道为空白图）

DirectorStageShot（单机位节点）：
  - 从 manifest.cameras[camera_index] 读取该机位的控制图
  - 方便一个场景多节点 = 多机位并联出图

MASK 处理：
  - masks[] 中每个角色 mask 文件读取为灰度 [1,1,H,W]，torch.cat → [N,1,H,W] MASK batch
  - 无 mask 时输出 torch.zeros((1,1,height,width))
"""

import hashlib
import json
import os
import sys

import numpy as np
import torch

try:
    import folder_paths
except Exception:  # 脱离 ComfyUI 环境（语法检查/单测）时兜底
    folder_paths = None

try:
    from PIL import Image
except Exception:
    Image = None


def _log(msg):
    """安全打印：兼容 GBK 等控制台编码，打印本身绝不抛异常。"""
    text = "[3D导演台] " + str(msg)
    try:
        print(text)
    except Exception:
        try:
            enc = getattr(sys.stdout, "encoding", None) or "utf-8"
            print(text.encode(enc, "replace").decode(enc, "replace"))
        except Exception:
            pass


# ============================================================================
# 共享工具函数
# ============================================================================

def _blank_image(width, height):
    """空白兜底图：[1, H, W, 3] 全零 tensor。"""
    return torch.zeros((1, int(height), int(width), 3), dtype=torch.float32)


def _blank_mask(width, height):
    """空白兜底 mask：[1, 1, H, W] 全零 tensor。"""
    return torch.zeros((1, 1, int(height), int(width)), dtype=torch.float32)


def _load_image(rel_path, width, height, channel):
    """按 manifest 中的相对路径读取 PNG → [1,H,W,3] float tensor。

    任何缺失 / 解析失败都返回空白图并打印中文警告，绝不抛异常炸队列。
    """
    if not rel_path or not isinstance(rel_path, str):
        _log(
            "警告：manifest 中缺少 %s 通道文件，输出空白图像"
            "（请先在编辑器中点击「应用」导出）。" % channel
        )
        return _blank_image(width, height)
    try:
        if folder_paths is None:
            raise RuntimeError("folder_paths 不可用（当前不在 ComfyUI 环境中）")
        if Image is None:
            raise RuntimeError("PIL 不可用，无法读取图像")
        path = folder_paths.get_annotated_filepath(rel_path)
        if not path or not os.path.isfile(path):
            raise FileNotFoundError("文件不存在: %s" % rel_path)
        img = Image.open(path).convert("RGB")
        arr = np.asarray(img).astype(np.float32) / 255.0
        return torch.from_numpy(arr)[None,]  # [1, H, W, 3]
    except Exception as e:
        _log(
            "警告：读取 %s 图像失败（%s）：%s，输出空白图像。"
            % (channel, rel_path, e)
        )
        return _blank_image(width, height)


def _load_mask(rel_path, width, height, name):
    """按相对路径读取 mask PNG → 灰度 [1, 1, H, W] float tensor。

    任何缺失 / 解析失败都返回 None（由调用方决定兜底）。
    """
    if not rel_path or not isinstance(rel_path, str):
        _log("警告：角色「%s」的 mask 文件缺失，将跳过。" % name)
        return None
    try:
        if folder_paths is None:
            raise RuntimeError("folder_paths 不可用（当前不在 ComfyUI 环境中）")
        if Image is None:
            raise RuntimeError("PIL 不可用，无法读取图像")
        path = folder_paths.get_annotated_filepath(rel_path)
        if not path or not os.path.isfile(path):
            raise FileNotFoundError("文件不存在: %s" % rel_path)
        img = Image.open(path).convert("L")  # 灰度
        arr = np.asarray(img).astype(np.float32) / 255.0
        # [1, 1, H, W] MASK format
        return torch.from_numpy(arr).unsqueeze(0).unsqueeze(0)
    except Exception as e:
        _log(
            "警告：读取角色「%s」的 mask 图像失败（%s）：%s，将跳过。"
            % (name, rel_path, e)
        )
        return None


def _parse_manifest(manifest_str):
    """安全解析 manifest JSON，失败返回空 dict。"""
    try:
        data = json.loads(manifest_str) if manifest_str and manifest_str.strip() else {}
        if isinstance(data, dict):
            return data
        return {}
    except Exception as e:
        _log("警告：manifest JSON 解析失败：%s，将使用默认值。" % e)
        return {}


def _resolve_resolution(manifest_data, camera_data, width, height):
    """从 camera 数据或 manifest 中解析宽高。

    优先级：manifest.cameras[i].width/height > manifest.width/height > 节点参数 width/height。
    如果有 files 顶层级（M1 格式），使用节点参数。
    """
    w, h = width, height
    # 从 camera 取
    if isinstance(camera_data, dict):
        if camera_data.get("width"):
            w = int(camera_data["width"])
        if camera_data.get("height"):
            h = int(camera_data["height"])
    if w == width and h == height:
        # 从 manifest 顶层取
        if isinstance(manifest_data, dict):
            if manifest_data.get("width"):
                w = int(manifest_data["width"])
            if manifest_data.get("height"):
                h = int(manifest_data["height"])
    return w, h


# ============================================================================
# DirectorStage —— 主场景节点
# ============================================================================

class DirectorStage:
    """🎬 3D导演台：读取编辑器导出的控制图，输出 6 路信号。

    M2（manifest.version >= 2）：从 cameras[0] 读取所有通道；
    M1 兼容（无 cameras 数组）：从顶层级 files 读取，新通道为空白图。
    """

    FUNCTION = "run"
    CATEGORY = "🎬DirectorStage"
    RETURN_TYPES = ("IMAGE", "IMAGE", "IMAGE", "IMAGE", "MASK", "STRING")
    RETURN_NAMES = ("openpose", "depth", "normal", "lineart", "char_masks", "camera_json")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "width": ("INT", {"default": 1024, "min": 64, "max": 4096, "step": 8}),
                "height": ("INT", {"default": 1024, "min": 64, "max": 4096, "step": 8}),
            },
            "optional": {
                "scene_gz": ("STRING", {"default": ""}),
                "manifest": ("STRING", {"default": "{}"}),
                "scene_json": ("STRING", {"default": "{}"}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, width, height, scene_gz="", manifest="{}", **kwargs):
        h = hashlib.sha256()
        h.update(str(manifest).encode("utf-8"))
        h.update(("%sx%s" % (width, height)).encode("utf-8"))
        return h.hexdigest()

    # ------------------------------------------------------------------ run

    def run(self, width, height, scene_gz="", manifest="{}", scene_json="{}"):
        data = _parse_manifest(manifest)

        # ---- M2 格式：cameras 数组存在，取第一个 camera ----
        cameras = data.get("cameras")
        if isinstance(cameras, list) and len(cameras) > 0 and isinstance(cameras[0], dict):
            return self._run_m2(cameras[0], data, width, height)

        # ---- M1 兼容：顶层级 files ----
        return self._run_m1(data, width, height)

    def _run_m2(self, camera, manifest_data, width, height):
        """M2 格式：从 cameras[0] 读取所有 pass + masks。"""
        w, h = _resolve_resolution(manifest_data, camera, width, height)
        files = camera.get("files", {})
        if not isinstance(files, dict):
            files = {}

        openpose = _load_image(files.get("openpose"), w, h, "openpose")
        depth = _load_image(files.get("depth"), w, h, "depth")
        normal = _load_image(files.get("normal"), w, h, "normal")
        lineart = _load_image(files.get("lineart"), w, h, "lineart")

        # 角色 mask batch
        char_masks = self._build_mask_batch(camera, w, h)

        # camera_json
        camera_json = self._build_camera_json(camera)

        return (openpose, depth, normal, lineart, char_masks, camera_json)

    def _run_m1(self, data, width, height):
        """M1 兼容：顶层级 files，新通道输出空白图。"""
        files = data.get("files", {})
        if not isinstance(files, dict):
            files = {}

        openpose = _load_image(files.get("openpose"), width, height, "openpose")
        depth = _load_image(files.get("depth"), width, height, "depth")

        # 新通道：M1 格式不支持，输出空白图 + 警告
        if not files.get("normal"):
            _log("警告：当前为 M1 manifest 格式，不支持 normal 通道，输出空白图像。（请升级到 M2 格式以启用 normal/lineart/char_masks）")
        if not files.get("lineart"):
            _log("警告：当前为 M1 manifest 格式，不支持 lineart 通道，输出空白图像。")
        normal = _load_image(files.get("normal"), width, height, "normal")
        lineart = _load_image(files.get("lineart"), width, height, "lineart")

        char_masks = _blank_mask(width, height)
        _log("提示：M1 manifest 不支持角色 mask，输出空白 mask。")

        camera_json = json.dumps({}, ensure_ascii=False)

        return (openpose, depth, normal, lineart, char_masks, camera_json)

    def _build_mask_batch(self, camera, width, height):
        """从 camera 的 masks[] 构建 [N, 1, H, W] MASK batch。

        masks[].version >= 2 格式：每个 mask 含 name + file 字段。
        """
        masks = camera.get("masks")
        if not isinstance(masks, list) or len(masks) == 0:
            return _blank_mask(width, height)

        mask_tensors = []
        for m in masks:
            if not isinstance(m, dict):
                continue
            name = m.get("name", "未知角色")
            file_path = m.get("file", "")
            loaded = _load_mask(file_path, width, height, name)
            if loaded is not None:
                mask_tensors.append(loaded)

        if len(mask_tensors) == 0:
            return _blank_mask(width, height)

        # torch.cat along dim=0 → [N, 1, H, W]
        return torch.cat(mask_tensors, dim=0)

    def _build_camera_json(self, camera):
        """从 camera 中提取完整内外参 → JSON 字符串。

        优先使用 cameraParams（M2 新格式），回退到旧 pose 字段。
        """
        try:
            params = camera.get("cameraParams")
            if params and isinstance(params, dict):
                # M2 新格式：完整内外参
                info = {
                    "id": camera.get("id", ""),
                    "name": camera.get("name", ""),
                    "intrinsics": params.get("intrinsics", {}),
                    "extrinsics": params.get("extrinsics", {}),
                    "projectionMatrix": params.get("projectionMatrix", []),
                    "viewMatrix": params.get("viewMatrix", []),
                }
            else:
                # 旧格式回退
                info = {
                    "pos": camera.get("pos", [0, 0, 0]),
                    "target": camera.get("target", [0, 0, 0]),
                    "focalMM": camera.get("focalMM", 35),
                }
            return json.dumps(info, ensure_ascii=False)
        except Exception as e:
            _log("警告：构建 camera_json 失败：%s" % e)
            return json.dumps({}, ensure_ascii=False)


# ============================================================================
# DirectorStageShot —— 单机位节点
# ============================================================================

class DirectorStageShot:
    """🎬 3D导演台·单机位：从 manifest.cameras[camera_index] 读取指定机位的控制图。

    方便一个场景多节点 = 多机位并联出图（storyboard 工作流）。
    """

    FUNCTION = "run"
    CATEGORY = "🎬DirectorStage"
    RETURN_TYPES = ("IMAGE", "IMAGE", "IMAGE", "IMAGE", "MASK", "STRING")
    RETURN_NAMES = ("openpose", "depth", "normal", "lineart", "char_masks", "camera_json")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "scene_gz": ("STRING", {"default": ""}),
                "manifest": ("STRING", {"default": "{}"}),
                "camera_index": ("INT", {"default": 0, "min": 0, "max": 9, "step": 1}),
            },
            "optional": {
                "width": ("INT", {"default": 1024, "min": 64, "max": 4096, "step": 8}),
                "height": ("INT", {"default": 1024, "min": 64, "max": 4096, "step": 8}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, scene_gz="", manifest="{}", camera_index=0, width=1024, height=1024, **kwargs):
        h = hashlib.sha256()
        h.update(str(manifest).encode("utf-8"))
        h.update(str(camera_index).encode("utf-8"))
        h.update(("%sx%s" % (width, height)).encode("utf-8"))
        return h.hexdigest()

    def run(self, scene_gz="", manifest="{}", camera_index=0, width=1024, height=1024):
        data = _parse_manifest(manifest)

        cameras = data.get("cameras")
        if not isinstance(cameras, list) or len(cameras) == 0:
            _log("警告：manifest 中没有 cameras 数组，所有通道输出空白。")
            return (
                _blank_image(width, height),
                _blank_image(width, height),
                _blank_image(width, height),
                _blank_image(width, height),
                _blank_mask(width, height),
                json.dumps({}, ensure_ascii=False),
            )

        if camera_index < 0 or camera_index >= len(cameras):
            _log(
                "警告：camera_index=%d 超出范围（cameras 共 %d 个，索引应为 0~%d），输出空白。"
                % (camera_index, len(cameras), len(cameras) - 1)
            )
            return (
                _blank_image(width, height),
                _blank_image(width, height),
                _blank_image(width, height),
                _blank_image(width, height),
                _blank_mask(width, height),
                json.dumps({}, ensure_ascii=False),
            )

        camera = cameras[camera_index]
        if not isinstance(camera, dict):
            _log("警告：cameras[%d] 不是有效的对象，输出空白。" % camera_index)
            return (
                _blank_image(width, height),
                _blank_image(width, height),
                _blank_image(width, height),
                _blank_image(width, height),
                _blank_mask(width, height),
                json.dumps({}, ensure_ascii=False),
            )

        w, h = _resolve_resolution(data, camera, width, height)
        files = camera.get("files", {})
        if not isinstance(files, dict):
            files = {}

        openpose = _load_image(files.get("openpose"), w, h, "openpose")
        depth = _load_image(files.get("depth"), w, h, "depth")
        normal = _load_image(files.get("normal"), w, h, "normal")
        lineart = _load_image(files.get("lineart"), w, h, "lineart")

        # 角色 mask batch —— 复用 DirectorStage 的 mask 构建逻辑
        char_masks = DirectorStage._build_mask_batch(DirectorStage, camera, w, h)

        # camera_json
        camera_json = DirectorStage._build_camera_json(DirectorStage, camera)

        return (openpose, depth, normal, lineart, char_masks, camera_json)


# ============================================================================
# 注册
# ============================================================================

NODE_CLASS_MAPPINGS = {
    "DirectorStage": DirectorStage,
    "DirectorStageShot": DirectorStageShot,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "DirectorStage": "🎬 3D导演台",
    "DirectorStageShot": "🎬 3D导演台·单机位",
}
