"""单元测试：pose_extract 的 DWPose 解析逻辑（mock detector，不依赖真实模型/网络）。

覆盖：
  1. openpose_json 格式解析（新版 pip controlnet_aux / vendored custom_controlnet_aux）
  2. bodies(candidate/subset) 格式解析（PyPI controlnet_aux 0.0.10）
  3. 检测执行抛异常 → ERROR 级兜底默认 T-pose（is_default=True），不静默
  4. 单例策略：依赖不存在可缓存 fallback；瞬时加载失败不毒化单例（下次重试）

直接运行：python test_pose_extract.py
"""

import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pose_extract  # noqa: E402

passed, failed = 0, 0


def check(label, cond):
    global passed, failed
    if cond:
        passed += 1
        print("  PASS  %s" % label)
    else:
        failed += 1
        print("  FAIL  %s" % label)


class _FakeImage:
    """模拟 PIL Image（仅需 width/height 属性）。"""

    def __init__(self, width=100, height=200):
        self.width = width
        self.height = height


def _reset_detector_state():
    pose_extract._dwpose_detector = None
    pose_extract._dwpose_dep_missing = False
    pose_extract._dwpose_fail_count = 0
    pose_extract._dwpose_last_fail = 0.0


# ---------------------------------------------------------------------------
# 1. openpose_json 格式解析
# ---------------------------------------------------------------------------
print("== openpose_json 格式解析 ==")

flat = []
for i in range(18):
    flat += [float(i), float(i * 2), 0.9]
flat[2] = 0.0  # 关键点 0 缺失（c=0）
mock_json = {
    "people": [{"pose_keypoints_2d": flat}],
    "canvas_height": 200,
    "canvas_width": 100,
}


class _MockOpenposeDetector:
    def __call__(self, img, **kwargs):
        assert kwargs.get("image_and_json") is True, "必须以 image_and_json=True 调用"
        return (None, mock_json)


_reset_detector_state()
pose_extract._dwpose_detector = (_MockOpenposeDetector(), "openpose_json")
persons = pose_extract._detect_2d_keypoints_pil(_FakeImage())

check("检测到 1 个人", len(persons) == 1)
p0 = persons[0]
check("18 个关键点", len(p0["keypoints"]) == 18)
check("关键点 1 坐标/置信度正确", p0["keypoints"][1] == [1.0, 2.0, 0.9])
check("缺失关键点 c=0", p0["keypoints"][0][2] == 0.0)
check("非默认姿势（is_default=False）", p0.get("is_default") is False)
check("bbox 覆盖有效关键点", p0["bbox"] == [1.0, 2.0, 17.0, 34.0])

# ---------------------------------------------------------------------------
# 2. bodies(candidate/subset) 格式解析（0.0.10）
# ---------------------------------------------------------------------------
print("== bodies(candidate/subset) 格式解析 ==")

candidate = np.array([[10.0, 20.0, 0.8], [30.0, 40.0, 0.7]])
subset_row = [-1.0] * 18 + [0.9, 2.0]  # 18 个索引 + 整体得分 + 点数
subset_row[0] = 0  # 关键点 0 → candidate[0]
subset_row[5] = 1  # 关键点 5 → candidate[1]
subset = np.array([subset_row])


class _MockBodiesDetector:
    def __call__(self, img_np):
        assert isinstance(img_np, np.ndarray), "bodies flavor 应接收 numpy 图像"
        return {"bodies": {"candidate": candidate, "subset": subset},
                "hands": [], "faces": []}


_reset_detector_state()
pose_extract._dwpose_detector = (_MockBodiesDetector(), "bodies")
persons = pose_extract._detect_2d_keypoints_pil(_FakeImage())

check("检测到 1 个人", len(persons) == 1)
p0 = persons[0]
check("18 个关键点", len(p0["keypoints"]) == 18)
check("关键点 0 映射 candidate[0]", p0["keypoints"][0] == [10.0, 20.0, 0.8])
check("关键点 5 映射 candidate[1]", p0["keypoints"][5] == [30.0, 40.0, 0.7])
check("subset=-1 的关键点缺失", p0["keypoints"][1] == [0.0, 0.0, 0.0])
check("非默认姿势（is_default=False）", p0.get("is_default") is False)

# ---------------------------------------------------------------------------
# 3. 检测执行抛异常 → 默认 T-pose（is_default=True）
# ---------------------------------------------------------------------------
print("== 检测失败兜底 ==")


class _BoomDetector:
    def __call__(self, *a, **kw):
        raise RuntimeError("mock: 显存不足")


_reset_detector_state()
pose_extract._dwpose_detector = (_BoomDetector(), "openpose_json")
persons = pose_extract._detect_2d_keypoints_pil(_FakeImage(100, 200))

check("失败仍返回 1 个默认人物", len(persons) == 1)
check("is_default=True（显式标记，不静默）", persons[0].get("is_default") is True)
check("默认 T-pose 18 个关键点", len(persons[0]["keypoints"]) == 18)

# ---------------------------------------------------------------------------
# 4. 单例策略：依赖不存在永久 fallback；瞬时失败下次重试
# ---------------------------------------------------------------------------
print("== 单例策略 ==")

orig_loader = pose_extract._load_dwpose_detector
try:
    # 4a. 依赖不存在：缓存 fallback，不再重复加载
    calls = {"n": 0}

    def _dep_missing_loader():
        calls["n"] += 1
        raise pose_extract._DependencyMissing("no controlnet_aux")

    _reset_detector_state()
    pose_extract._load_dwpose_detector = _dep_missing_loader
    check("依赖不存在返回 None", pose_extract._get_dwpose_detector() is None)
    check("第二次仍返回 None", pose_extract._get_dwpose_detector() is None)
    check("加载函数只被调用 1 次（fallback 被缓存）", calls["n"] == 1)

    # 4b. 瞬时失败：不缓存，下次重试，且可最终成功
    state = {"fail": True, "n": 0}

    class _OkDetector:
        def __call__(self, img, **kw):
            return (None, {"people": []})

    def _flaky_loader():
        state["n"] += 1
        if state["fail"]:
            raise RuntimeError("mock: 模型下载中断")
        return _OkDetector(), "openpose_json"

    _reset_detector_state()
    pose_extract._load_dwpose_detector = _flaky_loader
    check("瞬时失败返回 None", pose_extract._get_dwpose_detector() is None)
    state["fail"] = False
    loaded = pose_extract._get_dwpose_detector()
    check("下次调用成功重试并拿到检测器", loaded is not None and loaded[1] == "openpose_json")
    check("加载函数被调用了 2 次（未被毒化）", state["n"] == 2)
    check("成功后命中缓存", pose_extract._get_dwpose_detector() is loaded and state["n"] == 2)
finally:
    pose_extract._load_dwpose_detector = orig_loader
    _reset_detector_state()

print("\n结果: %d passed, %d failed" % (passed, failed))
sys.exit(1 if failed else 0)
