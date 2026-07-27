"""ComfyUI「3D导演台」姿势提取节点 —— M3 DWPose 2D→3D 预留

ExtractPoseFromImage：
  - 从图片检测 2D 关键点（DWPose / OpenPose）
  - 输出 POSE_DATA（供后续节点转换为 3D）
  - 支持多人选择（person_index）

2D→3D 转换策略：
  1. 使用先验姿势库匹配最接近的 3D 姿势
  2. 允许用户手动调整深度/关节角
  3. 后续可集成深度学习模型（如 HybrIK）

当前阶段实现：
  - 后端：使用 controlnet_aux 的 DWPose 检测 2D 点
  - 前端：上传 UI + 2D 可视化叠加
  - 转换：简单的 2D→3D 映射（假设标准深度）
"""

import json
import time

import numpy as np
import torch

try:
    from PIL import Image
except Exception:
    Image = None

# COCO-18 标准 T-pose 3D 坐标（米，原点在髋部中心）
# 原代码 `from .constants import T_POSE` 会崩溃（constants 是 JS 模块非 Python）
_T_POSE_3D = [
    [0.0, 1.75, 0.0],   # 0  Nose
    [0.0, 1.60, 0.0],   # 1  Neck
    [-0.18, 1.55, 0.0], # 2  RShoulder
    [-0.40, 1.30, 0.0], # 3  RElbow
    [-0.60, 1.05, 0.0], # 4  RWrist
    [0.18, 1.55, 0.0],  # 5  LShoulder
    [0.40, 1.30, 0.0],  # 6  LElbow
    [0.60, 1.05, 0.0],  # 7  LWrist
    [-0.10, 0.95, 0.0], # 8  RHip
    [-0.12, 0.50, 0.0], # 9  RKnee
    [-0.12, 0.05, 0.0], # 10 RAnkle
    [0.10, 0.95, 0.0],  # 11 LHip
    [0.12, 0.50, 0.0],  # 12 LKnee
    [0.12, 0.05, 0.0],  # 13 LAnkle
    [-0.05, 1.78, 0.05],# 14 REye
    [0.05, 1.78, 0.05], # 15 LEye
    [-0.08, 1.77, -0.03],# 16 REar
    [0.08, 1.77, -0.03], # 17 LEar
]


def _log(msg):
    """安全打印：兼容 GBK 等控制台编码"""
    import sys
    text = "[3D导演台·姿势提取] " + str(msg)
    try:
        print(text)
    except Exception:
        try:
            enc = getattr(sys.stdout, "encoding", None) or "utf-8"
            print(text.encode(enc, "replace").decode(enc, "replace"))
        except Exception:
            pass


# ============================================================================
# DWPose 检测器（延迟加载 + 优雅降级 + 双版本兼容）
# ============================================================================
#
# 兼容两种真实存在的 controlnet_aux API（已按本机 F:\comfyui 实际安装核实）：
#   flavor "openpose_json"：新版 pip controlnet_aux 及 ComfyUI 自定义节点
#     comfyui_controlnet_aux 的 vendored custom_controlnet_aux（本机为此种）。
#     DwposeDetector.from_pretrained("yzd-v/DWPose", ...) 构造；
#     detector(img, include_body=True, image_and_json=True)
#       → (pil_img, {"people": [{"pose_keypoints_2d": [x,y,c] * 18}], ...})
#   flavor "bodies"：PyPI controlnet_aux 0.0.10（DWposeDetector 无 from_pretrained）。
#     DWposeDetector() 构造；detector(np_img)
#       → {"bodies": {"candidate": [K,≥2], "subset": [N,20]}, "hands", "faces"}

_DWPOSE_MAX_TRANSIENT_FAILS = 3      # 连续瞬时失败次数上限，达到后进入冷却
_DWPOSE_LOAD_COOLDOWN_SECONDS = 300  # 冷却时长（秒），过后自动重试

_dwpose_detector = None       # 加载成功： (detector, flavor)
_dwpose_dep_missing = False   # 依赖不存在：永久 fallback（重试无意义）
_dwpose_fail_count = 0        # 瞬时加载失败计数
_dwpose_last_fail = 0.0       # 上次瞬时失败时间戳


class _DependencyMissing(Exception):
    """controlnet_aux / comfyui_controlnet_aux 依赖不存在（区别于瞬时加载失败）。"""


def _load_dwpose_detector():
    """按本机实际安装情况加载 DWPose 检测器，返回 (detector, flavor)。

    依赖不存在抛 _DependencyMissing（可缓存 fallback）；
    模型下载中断 / 显存不足等瞬时错误抛原异常（调用方不缓存，下次重试）。
    """
    # 1) 优先：pip 安装的 controlnet_aux
    try:
        from controlnet_aux import DWposeDetector as _PipDWpose
    except ImportError:
        _PipDWpose = None

    if _PipDWpose is not None:
        if hasattr(_PipDWpose, "from_pretrained"):
            # 新版 pip controlnet_aux：与 vendored 版同一套 API
            return _PipDWpose.from_pretrained("yzd-v/DWPose"), "openpose_json"
        # 0.0.10 老版：无 from_pretrained，构造即加载/下载默认模型
        return _PipDWpose(), "bodies"

    # 2) 兜底：ComfyUI 自定义节点 comfyui_controlnet_aux 的 vendored 版本
    try:
        from comfyui_controlnet_aux.src.custom_controlnet_aux.dwpose import (
            DwposeDetector as _VendoredDwpose,
        )
    except ImportError as e:
        raise _DependencyMissing(
            "未安装 controlnet_aux，也未发现 comfyui_controlnet_aux 自定义节点（%s）" % e
        )

    return _VendoredDwpose.from_pretrained(
        "yzd-v/DWPose",
        det_filename="yolox_l.onnx",
        pose_filename="dw-ll_ucoco_384.onnx",
    ), "openpose_json"


def _get_dwpose_detector():
    """获取 DWPose 检测器（单例，延迟加载）。

    - 成功：缓存 (detector, flavor) 并返回；
    - 依赖不存在：永久 fallback，返回 None（重试无意义）；
    - 瞬时加载失败：不缓存，下次调用重试；连续失败达到上限后冷却一段时间。
    """
    global _dwpose_detector, _dwpose_dep_missing, _dwpose_fail_count, _dwpose_last_fail
    if _dwpose_detector is not None:
        return _dwpose_detector
    if _dwpose_dep_missing:
        return None
    if _dwpose_fail_count >= _DWPOSE_MAX_TRANSIENT_FAILS:
        if (time.time() - _dwpose_last_fail) < _DWPOSE_LOAD_COOLDOWN_SECONDS:
            return None
        _dwpose_fail_count = 0  # 冷却结束，放开重试

    try:
        _dwpose_detector = _load_dwpose_detector()
        _dwpose_fail_count = 0
        _log("DWPose 检测器加载成功（flavor=%s）" % _dwpose_detector[1])
        return _dwpose_detector
    except _DependencyMissing as e:
        _dwpose_dep_missing = True
        _log("ERROR：DWPose 依赖不存在，姿势提取将始终输出默认 T-pose：%s" % e)
        return None
    except Exception as e:
        _dwpose_fail_count += 1
        _dwpose_last_fail = time.time()
        _log("ERROR：DWPose 检测器加载失败（第 %d 次，下次调用将重试）：%s"
             % (_dwpose_fail_count, e))
        return None


def _has_valid_keypoints(person):
    """person 是否含至少一个有效关键点（c > 0.1）。

    P2-fix：DWPose 可能检出人体 bbox 但全身关键点置信度 <0.3（模糊/遮挡图），
    vendored format_result 会把这些点置 None→[0,0,0]，形成"空人"。
    空人不过滤会导致下游关节全部坍缩到原点且无 is_default 标记。
    """
    return any(kp[2] > 0.1 for kp in person.get("keypoints") or [])


def _person_from_keypoints(keypoints, is_default=False):
    """由 [[x, y, score] * 18] 组装 person dict（bbox / 平均置信度）。"""
    valid = [kp for kp in keypoints if kp[2] > 0.1]
    if valid:
        xs = [kp[0] for kp in valid]
        ys = [kp[1] for kp in valid]
        bbox = [min(xs), min(ys), max(xs), max(ys)]
        score = float(np.mean([kp[2] for kp in valid]))
    else:
        bbox = [0.0, 0.0, 0.0, 0.0]
        score = 0.0
    return {
        "keypoints": keypoints,
        "bbox": bbox,
        "score": score,
        "is_default": is_default,
    }


def _parse_openpose_json(result):
    """解析 openpose JSON 格式：{"people": [{"pose_keypoints_2d": [x,y,c] * 18}]}。"""
    persons = []
    for person in (result.get("people") or []):
        flat = person.get("pose_keypoints_2d") or []
        keypoints = []
        usable = min(len(flat) - (len(flat) % 3), 54)  # 18 个关键点 × 3
        for i in range(0, usable, 3):
            keypoints.append([float(flat[i]), float(flat[i + 1]), float(flat[i + 2])])
        while len(keypoints) < 18:
            keypoints.append([0.0, 0.0, 0.0])
        persons.append(_person_from_keypoints(keypoints))
    return persons


def _parse_bodies_dict(result):
    """解析 0.0.10 格式：{"bodies": {"candidate": [K,≥2], "subset": [N,20]}}。

    subset 每行前 18 列为 candidate 索引（-1 = 该关键点缺失），后两列为整体得分/点数；
    candidate 若带第 3 列则作为单点置信度，否则置 1.0。
    """
    bodies = result.get("bodies") or {}
    candidate = np.asarray(bodies.get("candidate", []), dtype=np.float64)
    subset = np.asarray(bodies.get("subset", []), dtype=np.float64)
    if candidate.ndim != 2 or candidate.shape[0] == 0:
        return []
    if subset.ndim == 1:
        subset = subset.reshape(1, -1)

    persons = []
    for row in subset:
        keypoints = []
        for j in range(18):
            idx = int(row[j]) if j < len(row) else -1
            if 0 <= idx < candidate.shape[0]:
                c = candidate[idx]
                score = float(c[2]) if c.shape[0] >= 3 else 1.0
                keypoints.append([float(c[0]), float(c[1]), score])
            else:
                keypoints.append([0.0, 0.0, 0.0])
        persons.append(_person_from_keypoints(keypoints))
    return persons


def _detect_2d_keypoints_pil(image_pil):
    """从 PIL Image 检测 2D 关键点。

    返回: list of person dict（keypoints/bbox/score/is_default）。
    检测器不可用或检测失败时打 ERROR 级日志并返回默认 T-pose（is_default=True），不静默。
    """
    loaded = _get_dwpose_detector()

    if loaded is not None:
        detector, flavor = loaded
        try:
            if flavor == "openpose_json":
                _, pose_json = detector(
                    image_pil,
                    include_body=True,
                    include_hand=False,
                    include_face=False,
                    image_and_json=True,
                )
                persons = _parse_openpose_json(pose_json or {})
            else:  # flavor == "bodies"
                persons = _parse_bodies_dict(detector(np.asarray(image_pil)) or {})
            # P2-fix：过滤全零置信度"空人"（检出 bbox 但 18 个关键点 c 全为 0），
            # 过滤后为空则走 T-pose 兜底（带 is_default=True 显式标记）
            persons = [p for p in persons if _has_valid_keypoints(p)]
            if persons:
                return persons
            _log("ERROR：DWPose 未检测到有效人物（无检出或关键点置信度全为零），输出默认 T-pose（is_default=True）。")
        except Exception as e:
            _log("ERROR：DWPose 检测执行失败（%s），输出默认 T-pose（is_default=True）。" % e)
    else:
        _log("ERROR：DWPose 检测器不可用，输出默认 T-pose（is_default=True）。")

    # 降级：返回默认 T-pose（前端可手动调整）
    return [_create_default_pose(image_pil.width, image_pil.height)]


def _create_default_pose(width, height):
    """创建默认 T-pose（用于 DWPose 不可用时的降级方案）
    关键点坐标归一化到 [0, 1]，然后映射到图像尺寸
    """
    # COCO-18 标准 T-pose 归一化坐标
    t_pose_normalized = [
        [0.5, 0.15],   # 0 Nose
        [0.5, 0.25],   # 1 Neck
        [0.35, 0.25],  # 2 RShoulder
        [0.2, 0.25],   # 3 RElbow
        [0.05, 0.25],  # 4 RWrist
        [0.65, 0.25],  # 5 LShoulder
        [0.8, 0.25],   # 6 LElbow
        [0.95, 0.25],  # 7 LWrist
        [0.4, 0.55],   # 8 RHip
        [0.38, 0.75],  # 9 RKnee
        [0.37, 0.95],  # 10 RAnkle
        [0.6, 0.55],   # 11 LHip
        [0.62, 0.75],  # 12 LKnee
        [0.63, 0.95],  # 13 LAnkle
        [0.47, 0.12],  # 14 REye
        [0.53, 0.12],  # 15 LEye
        [0.43, 0.13],  # 16 REar
        [0.57, 0.13],  # 17 LEar
    ]
    
    keypoints = []
    for nx, ny in t_pose_normalized:
        x = nx * width
        y = ny * height
        keypoints.append([x, y, 0.5])  # score=0.5 表示这是估计值
    
    return {
        "keypoints": keypoints,
        "bbox": [0.05 * width, 0.1 * height, 0.95 * width, 0.95 * height],
        "score": 0.5,
        "is_default": True
    }


# ============================================================================
# 2D→3D 转换（简单深度估计）
# ============================================================================

def _estimate_depth_from_2d(keypoints_2d, image_width, image_height):
    """从 2D 关键点估计 3D 坐标（简单版本）
    
    策略：
    1. 使用标准人体比例作为先验
    2. 根据 2D 投影反推 3D 位置
    3. 深度歧义通过假设标准距离解决
    
    返回: list of [x, y, z] 3D 坐标（米）
    """
    # 标准人体身高（米），用于针孔模型反推距离
    STANDARD_HEIGHT = 1.75
    
    # 计算图像中人物的像素高度
    ys = [kp[1] for kp in keypoints_2d if kp[2] > 0.1]
    if not ys:
        return [[0, 0, 0]] * 18
    
    pixel_height = max(ys) - min(ys)
    if pixel_height < 10:
        pixel_height = image_height * 0.7
    
    # 估计距离（假设标准焦距）
    # 使用针孔相机模型：real_height / distance = pixel_height / focal_length
    # 假设 focal_length ≈ image_width（标准视角）
    focal_length = image_width
    distance = (STANDARD_HEIGHT * focal_length) / pixel_height
    
    # 将 2D 坐标转换为 3D（假设人物中心在 z=0 平面）
    keypoints_3d = []
    center_x = image_width / 2
    center_y = image_height / 2
    
    for x, y, score in keypoints_2d:
        # 归一化到 [-1, 1]
        nx = (x - center_x) / center_x
        ny = (y - center_y) / center_y
        
        # 3D 坐标（米）
        # x: 左右（正方向向右）
        # y: 上下（正方向向上，需要翻转）
        # z: 深度（正方向向前）
        x_3d = nx * distance * 0.5  # 缩放因子
        y_3d = -ny * distance * 0.5  # 翻转 y 轴
        z_3d = distance  # 深度
        
        keypoints_3d.append([x_3d, y_3d, z_3d])
    
    return keypoints_3d


# ============================================================================
# ComfyUI 节点定义
# ============================================================================

class ExtractPoseFromImage:
    """从图片提取 2D 关键点，转换为 3D 姿势
    
    输入：
      - image: IMAGE tensor [B, H, W, C]
      - person_index: 选择第几个人（默认 0）
    
    输出：
      - POSE_DATA: dict 包含 2D/3D 关键点、置信度等
    """
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
            },
            "optional": {
                "person_index": ("INT", {"default": 0, "min": 0, "max": 10}),
                "estimate_depth": ("BOOLEAN", {"default": True}),
            }
        }
    
    RETURN_TYPES = ("POSE_DATA",)
    RETURN_NAMES = ("pose_data",)
    FUNCTION = "extract"
    CATEGORY = "🎬DirectorStage"
    
    def extract(self, image, person_index=0, estimate_depth=True):
        """提取姿势
        
        返回 POSE_DATA:
        {
            "persons": [
                {
                    "keypoints_2d": [[x, y, score], ...],  # 18 个 COCO 关键点
                    "keypoints_3d": [[x, y, z], ...],      # 估计的 3D 坐标
                    "bbox": [x1, y1, x2, y2],
                    "score": float,
                    "is_default": bool
                }
            ],
            "selected_index": int,
            "image_size": [width, height],
            "format": "coco_18"
        }
        """
        w, h = 512, 512  # 兜底尺寸（异常路径返回 _empty_pose_data 时使用）
        try:
            # 获取图像尺寸（P2-fix：解包前校验维度与 batch，避免 IndexError/ValueError 炸队列）
            if isinstance(image, torch.Tensor):
                if image.dim() != 4 or image.shape[0] < 1:
                    raise ValueError(
                        "非法 IMAGE 张量：期望 [B,H,W,C] 且 B>=1，实际 shape=%s"
                        % (tuple(image.shape),)
                    )
                batch, h, w, _ = image.shape
                if batch > 1:
                    _log("警告：输入 batch=%d，姿势提取仅处理第 0 帧，其余帧被忽略。" % batch)

            # 转换为 PIL Image
            if Image is None:
                _log("错误：PIL 不可用，无法处理图像")
                return (self._empty_pose_data(w, h),)

            # tensor → numpy → PIL
            if isinstance(image, torch.Tensor):
                img_np = image[0].cpu().numpy()  # [H, W, C]
                img_np = (img_np * 255).clip(0, 255).astype(np.uint8)
                image_pil = Image.fromarray(img_np)
            else:
                image_pil = image

            # 检测 2D 关键点
            persons = _detect_2d_keypoints_pil(image_pil)

            # 估计 3D 坐标
            if estimate_depth:
                for person in persons:
                    person["keypoints_3d"] = _estimate_depth_from_2d(
                        person["keypoints"], w, h
                    )

            # 选择人物
            selected = min(person_index, len(persons) - 1) if persons else 0

            pose_data = {
                "persons": persons,
                "selected_index": selected,
                "image_size": [w, h],
                "format": "coco_18",
                "depth_estimated": "planar",  # 3D 为平面深度估计，供下游判断可信度
                "timestamp": time.time(),  # 记录提取时间，供调试/缓存排查
            }

            _log(f"检测到 {len(persons)} 个人物，选择第 {selected} 个")

            return (pose_data,)
        except Exception as e:
            # P2-fix：与 nodes.py 六路输出同样的「绝不炸队列」防御深度——
            # 任何异常都 ERROR 日志 + 空 POSE_DATA，不中断整个 prompt 队列
            _log("ERROR：姿势提取失败（%s），返回空 POSE_DATA（不炸队列）。" % e)
            return (self._empty_pose_data(w, h),)
    
    def _empty_pose_data(self, width, height):
        """返回空的姿势数据"""
        return {
            "persons": [],
            "selected_index": 0,
            "image_size": [width, height],
            "format": "coco_18",
            "timestamp": 0.0
        }


# ============================================================================
# 姿势数据转换工具（供后续节点使用）
# ============================================================================

class PoseDataToJoints:
    """将 POSE_DATA 转换为关节坐标（供 Figure 节点使用）
    
    输入：POSE_DATA
    输出：JOINTS（18 个关节的 3D 坐标）
    """
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "pose_data": ("POSE_DATA",),
            },
            "optional": {
                "depth_scale": ("FLOAT", {"default": 1.0, "min": 0.1, "max": 10.0}),
                "height_offset": ("FLOAT", {"default": 0.0, "min": -2.0, "max": 2.0}),
            }
        }
    
    RETURN_TYPES = ("JOINTS",)
    RETURN_NAMES = ("joints",)
    FUNCTION = "convert"
    CATEGORY = "🎬DirectorStage"
    
    def convert(self, pose_data, depth_scale=1.0, height_offset=0.0):
        """转换姿势数据为关节坐标
        
        返回: list of [x, y, z]，18 个关节
        """
        if not pose_data or not pose_data.get("persons"):
            return (_T_POSE_3D,)
        
        selected = pose_data.get("selected_index", 0)
        persons = pose_data["persons"]
        
        if selected >= len(persons):
            return (_T_POSE_3D,)
        
        person = persons[selected]
        keypoints_3d = person.get("keypoints_3d", [])
        
        if not keypoints_3d:
            return (_T_POSE_3D,)

        # P2-fix：全零 3D 关节（空人 / 深度估计失败的产物）回退 T-pose，
        # 避免下游 3D 人偶全部关节坍缩到原点
        if not any(any(abs(v) > 1e-9 for v in joint) for joint in keypoints_3d):
            _log("警告：选中人物的 3D 关键点全为零（空人/检测失败），回退默认 T-pose。")
            return (_T_POSE_3D,)

        # 应用深度缩放和高度偏移
        joints = []
        for x, y, z in keypoints_3d:
            joints.append([
                x * depth_scale,
                y * depth_scale + height_offset,
                z * depth_scale
            ])
        
        return (joints,)


# ============================================================================
# 注册
# ============================================================================

NODE_CLASS_MAPPINGS = {
    "ExtractPoseFromImage": ExtractPoseFromImage,
    "PoseDataToJoints": PoseDataToJoints,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ExtractPoseFromImage": "🎬 从图片提取姿势",
    "PoseDataToJoints": "🎬 姿势数据转关节",
}
