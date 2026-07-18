"""ComfyUI「3D导演台」插件入口：注册节点 + 挂载编辑器静态目录。"""

import os

from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

WEB_DIRECTORY = "./web/js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]


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
