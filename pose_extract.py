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
import numpy as np
import torch

try:
    from PIL import Image
except Exception:
    Image = None


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
# DWPose 检测器（延迟加载 + 优雅降级）
# ============================================================================

_dwpose_detector = None


def _get_dwpose_detector():
    """获取 DWPose 检测器（单例，延迟加载）
    如果 controlnet_aux 不可用，返回 None
    """
    global _dwpose_detector
    if _dwpose_detector is not None:
        return _dwpose_detector
    
    try:
        from controlnet_aux import DWposeDetector
        _dwpose_detector = DWposeDetector.from_pretrained()
        _log("DWPose 检测器加载成功")
        return _dwpose_detector
    except Exception as e:
        _log(f"警告：DWPose 检测器加载失败（{e}），将使用备用 OpenPose")
        _dwpose_detector = "fallback"
        return None


def _detect_2d_keypoints_pil(image_pil):
    """从 PIL Image 检测 2D 关键点
    返回: list of dict, 每个人包含 {"keypoints": [[x, y, score], ...], "bbox": [x1, y1, x2, y2]}
    """
    detector = _get_dwpose_detector()
    
    if detector is not None and detector != "fallback":
        # 使用 DWPose
        try:
            result = detector(image_pil, output_type="dict")
            # DWPose 返回格式: {"candidates": [...], "scores": [...]}
            candidates = result.get("candidates", [])
            scores = result.get("scores", [])
            
            persons = []
            for i, candidate in enumerate(candidates):
                # candidate: [[x, y], [x, y], ...] 18 个关键点
                keypoints = []
                for j, (x, y) in enumerate(candidate):
                    score = scores[i][j] if i < len(scores) and j < len(scores[i]) else 1.0
                    keypoints.append([float(x), float(y), float(score)])
                
                # 计算 bbox
                xs = [kp[0] for kp in keypoints if kp[2] > 0.1]
                ys = [kp[1] for kp in keypoints if kp[2] > 0.1]
                if xs and ys:
                    bbox = [min(xs), min(ys), max(xs), max(ys)]
                else:
                    bbox = [0, 0, 0, 0]
                
                persons.append({
                    "keypoints": keypoints,
                    "bbox": bbox,
                    "score": float(np.mean([kp[2] for kp in keypoints if kp[2] > 0.1])) if xs else 0.0
                })
            
            return persons
        except Exception as e:
            _log(f"DWPose 检测失败（{e}），尝试备用方案")
    
    # 备用方案：返回默认 T-pose（前端可手动调整）
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
    # 标准人体尺寸（米）
    STANDARD_HEIGHT = 1.75  # 身高
    SHOULDER_WIDTH = 0.36   # 肩宽
    TORSO_LENGTH = 0.5      # 躯干长度
    LEG_LENGTH = 0.9        # 腿长
    ARM_LENGTH = 0.6        # 手臂长度
    
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
        # 获取图像尺寸
        if isinstance(image, torch.Tensor):
            _, h, w, _ = image.shape
        else:
            w, h = 512, 512
        
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
            "timestamp": float(torch.tensor([0]).item())  # 用于 IS_CHANGED
        }
        
        _log(f"检测到 {len(persons)} 个人物，选择第 {selected} 个")
        
        return (pose_data,)
    
    def _empty_pose_data(self, width, height):
        """返回空的姿势数据"""
        return {
            "persons": [],
            "selected_index": 0,
            "image_size": [width, height],
            "format": "coco_18",
            "timestamp": 0
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
            # 返回 T-pose
            from .constants import T_POSE
            return (T_POSE,)
        
        selected = pose_data.get("selected_index", 0)
        persons = pose_data["persons"]
        
        if selected >= len(persons):
            from .constants import T_POSE
            return (T_POSE,)
        
        person = persons[selected]
        keypoints_3d = person.get("keypoints_3d", [])
        
        if not keypoints_3d:
            from .constants import T_POSE
            return (T_POSE,)
        
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
