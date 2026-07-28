"""ComfyUI「3D导演台」插件入口：注册节点 + 挂载静态目录 + 启动清理过期上传。"""

import os
import time

from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

WEB_DIRECTORY = "./web/js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

#: input/director_stage/ 下 PNG 的保留天数，超过则在启动时清理
_CLEANUP_MAX_AGE_DAYS = 7

#: 无论多旧都保底保留最近 N 份控制图（防止长期项目被静默清空）
_CLEANUP_KEEP_RECENT = 20


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


def _warn_if_empty_dir(path, label, required_file=None):
    """静态目录缺失/为空（或缺关键文件）时打警告 —— 构建产物遗漏不应静默变 404/白屏。"""
    try:
        if not os.path.isdir(path) or not os.listdir(path):
            _log("警告：%s 目录缺失或为空（%s）——可能是构建产物未生成，相关页面将 404/白屏。" % (label, path))
        elif required_file and not os.path.isfile(os.path.join(path, required_file)):
            _log("警告：%s 缺少 %s（%s）——构建不完整，页面可能白屏。" % (label, required_file, path))
    except Exception:
        pass


# M3 姿势提取节点（ExtractPoseFromImage / PoseDataToJoints）
# 依赖 controlnet_aux 的 DWPose；不可用时节点内部会优雅降级，不影响注册。
try:
    from .pose_extract import (
        NODE_CLASS_MAPPINGS as _POSE_NODE_CLASS_MAPPINGS,
        NODE_DISPLAY_NAME_MAPPINGS as _POSE_NODE_DISPLAY_NAME_MAPPINGS,
    )
    NODE_CLASS_MAPPINGS.update(_POSE_NODE_CLASS_MAPPINGS)
    NODE_DISPLAY_NAME_MAPPINGS.update(_POSE_NODE_DISPLAY_NAME_MAPPINGS)
except Exception as e:
    # _log 在上方已定义，可直接使用（其内部自带编码兜底，绝不抛异常）
    _log("警告：M3 姿势提取节点注册失败（不影响主节点）：%s" % e)

# 把 web/editor（编辑器 SPA 构建产物）挂载为静态目录：/director_stage/editor
# index.html 单独路由 + Cache-Control: no-cache —— 防止浏览器缓存旧 HTML
# 引用已删除的旧 bundle（vite 每次构建换 hash 文件名），导致打开导演台白屏。
try:
    from server import PromptServer
    from aiohttp import web

    _editor_dir = os.path.join(os.path.dirname(__file__), "web", "editor")
    os.makedirs(_editor_dir, exist_ok=True)
    _warn_if_empty_dir(_editor_dir, "编辑器静态目录 web/editor", required_file="index.html")

    async def _editor_index_no_cache(request):
        return web.FileResponse(
            os.path.join(_editor_dir, "index.html"),
            headers={"Cache-Control": "no-cache, must-revalidate"},
        )

    # 先注册精确路由（优先于静态目录匹配），再挂载静态目录
    PromptServer.instance.app.router.add_get("/director_stage/editor/", _editor_index_no_cache)
    PromptServer.instance.app.router.add_get("/director_stage/editor/index.html", _editor_index_no_cache)
    PromptServer.instance.app.add_routes(
        [web.static("/director_stage/editor", _editor_dir)]
    )
    _log("编辑器静态目录已挂载：/director_stage/editor（index.html no-cache）")
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

# 把 assets/models（角色模型 GLB）挂载为静态目录：/director_stage/models
try:
    from server import PromptServer
    from aiohttp import web

    _models_dir = os.path.join(os.path.dirname(__file__), "assets", "models")
    os.makedirs(_models_dir, exist_ok=True)
    PromptServer.instance.app.add_routes(
        [web.static("/director_stage/models", _models_dir)]
    )
    _log("模型库静态目录已挂载：/director_stage/models")
except Exception as e:
    _log("警告：模型库静态目录挂载失败（不影响节点本身加载）：%s" % e)


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
        # 收集全部 PNG 按 mtime 新→旧排序；最近 _CLEANUP_KEEP_RECENT 份保底不删
        pngs = []
        for name in os.listdir(stage_dir):
            if not name.lower().endswith(".png"):
                continue
            path = os.path.join(stage_dir, name)
            try:
                if os.path.isfile(path):
                    pngs.append((os.path.getmtime(path), name, path))
            except Exception as e:
                _log("警告：读取控制图 %s 状态失败：%s" % (name, e))
        pngs.sort(reverse=True)
        removed = 0
        for mtime, name, path in pngs[_CLEANUP_KEEP_RECENT:]:
            if mtime >= deadline:
                continue
            try:
                os.remove(path)
                removed += 1
            except Exception as e:
                _log("警告：清理旧控制图 %s 失败：%s" % (name, e))
        _log(
            "启动清理：input/director_stage/ 已删除 %d 张超过 %d 天的旧控制图（保底保留最近 %d 份）。"
            % (removed, _CLEANUP_MAX_AGE_DAYS, _CLEANUP_KEEP_RECENT)
        )
    except Exception as e:
        _log("警告：启动清理 input/director_stage 旧文件失败（不影响插件功能）：%s" % e)


_cleanup_stale_uploads()
