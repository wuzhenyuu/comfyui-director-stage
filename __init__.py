"""ComfyUI「3D导演台」插件入口：注册节点 + 挂载静态目录 + 启动清理过期上传。"""

import os
import time

from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

WEB_DIRECTORY = "./web/js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

#: input/director_stage/ 下 PNG 的保留天数，超过则在启动时清理
_CLEANUP_MAX_AGE_DAYS = 7


def _log(msg):
    """安全打印：兼容 GBK 等控制台编码，打印本身绝不抛异常。"""
    import sys

    text = "[3D导演台] " + str(msg)
    try:
        print(text)
    except Exception:
        try:
            enc = getattr(sys.stdout, "encoding", None) or "utf-8"
            print(text.encode(enc, "replace").decode(enc, "replace"))
        except Exception:
            pass


# 把 web/editor（编辑器 SPA 构建产物）挂载为静态目录：/director_stage/editor
try:
    from server import PromptServer
    from aiohttp import web

    _editor_dir = os.path.join(os.path.dirname(__file__), "web", "editor")
    os.makedirs(_editor_dir, exist_ok=True)
    PromptServer.instance.app.add_routes(
        [web.static("/director_stage/editor", _editor_dir)]
    )
    _log("编辑器静态目录已挂载：/director_stage/editor")
except Exception as e:
    _log("警告：编辑器静态目录挂载失败（不影响节点本身加载）：%s" % e)


# 把 assets/poses（姿势库 JSON：index.json + 各姿势文件）挂载为静态目录：/director_stage/poses
try:
    from server import PromptServer
    from aiohttp import web

    _poses_dir = os.path.join(os.path.dirname(__file__), "assets", "poses")
    os.makedirs(_poses_dir, exist_ok=True)
    PromptServer.instance.app.add_routes(
        [web.static("/director_stage/poses", _poses_dir)]
    )
    _log("姿势库静态目录已挂载：/director_stage/poses")
except Exception as e:
    _log("警告：姿势库静态目录挂载失败（不影响节点本身加载）：%s" % e)


def _cleanup_stale_uploads():
    """启动清理：删除 input/director_stage/ 下修改时间超过 7 天的 *.png。

    - 只处理 director_stage 这一个子目录，只删 .png，其余文件一概不动；
    - 任何异常仅打印中文警告，绝不影响插件加载与队列执行。
    """
    try:
        import folder_paths

        stage_dir = os.path.join(folder_paths.get_input_directory(), "director_stage")
        if not os.path.isdir(stage_dir):
            return
        deadline = time.time() - _CLEANUP_MAX_AGE_DAYS * 24 * 60 * 60
        removed = 0
        for name in os.listdir(stage_dir):
            if not name.lower().endswith(".png"):
                continue
            path = os.path.join(stage_dir, name)
            try:
                if os.path.isfile(path) and os.path.getmtime(path) < deadline:
                    os.remove(path)
                    removed += 1
            except Exception as e:
                _log("警告：清理旧控制图 %s 失败：%s" % (name, e))
        _log(
            "启动清理：input/director_stage/ 已删除 %d 张超过 %d 天的旧控制图。"
            % (removed, _CLEANUP_MAX_AGE_DAYS)
        )
    except Exception as e:
        _log("警告：启动清理 input/director_stage 旧文件失败（不影响插件功能）：%s" % e)


_cleanup_stale_uploads()
