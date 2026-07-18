"""ComfyUI「3D导演台」后端节点 —— M0 通路验证版。

工作方式：前端编辑器（iframe SPA）把渲染好的控制图 PNG 上传到
ComfyUI 的 input/director_stage/ 目录，并把文件清单 JSON 写入本节点的
manifest widget；队列执行时本节点读取这些 PNG 转成 IMAGE tensor 输出。

manifest 结构示例：
    {"files": {"openpose": "director_stage/xx.png",
               "depth":    "director_stage/yy.png"}}
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


class DirectorStage:
    """🎬 3D导演台：读取编辑器导出的控制图，输出 openpose / depth IMAGE。"""

    FUNCTION = "run"
    CATEGORY = "🎬DirectorStage"
    RETURN_TYPES = ("IMAGE", "IMAGE")
    RETURN_NAMES = ("openpose", "depth")

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
            },
        }

    @classmethod
    def IS_CHANGED(cls, width, height, scene_gz="", manifest="{}", **kwargs):
        h = hashlib.sha256()
        h.update(str(manifest).encode("utf-8"))
        h.update(("%sx%s" % (width, height)).encode("utf-8"))
        return h.hexdigest()

    # ------------------------------------------------------------------ utils

    @staticmethod
    def _blank(width, height):
        """空白兜底图：[1, H, W, 3] 全零 tensor。"""
        return torch.zeros((1, int(height), int(width), 3), dtype=torch.float32)

    def _load_image(self, rel_path, width, height, channel):
        """按 manifest 中的相对路径读取 PNG → [1,H,W,3] float tensor。

        任何缺失 / 解析失败都返回空白图并打印中文警告，绝不抛异常炸队列。
        """
        if not rel_path or not isinstance(rel_path, str):
            _log(
                "警告：manifest 中缺少 %s 通道文件，输出空白图像"
                "（请先在编辑器中点击「应用」导出）。" % channel
            )
            return self._blank(width, height)
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
            return self._blank(width, height)

    # -------------------------------------------------------------------- run

    def run(self, width, height, scene_gz="", manifest="{}"):
        files = {}
        try:
            data = json.loads(manifest) if manifest and manifest.strip() else {}
            if isinstance(data, dict):
                f = data.get("files", {})
                if isinstance(f, dict):
                    files = f
        except Exception as e:
            _log("警告：manifest JSON 解析失败：%s，输出空白图像。" % e)

        openpose = self._load_image(files.get("openpose"), width, height, "openpose")
        depth = self._load_image(files.get("depth"), width, height, "depth")
        return (openpose, depth)


NODE_CLASS_MAPPINGS = {"DirectorStage": DirectorStage}
NODE_DISPLAY_NAME_MAPPINGS = {"DirectorStage": "🎬 3D导演台"}
