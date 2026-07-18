/**
 * pose-panel.js — 姿势库面板（左侧栏）
 * 启动时 fetch("/director_stage/poses/index.json")，列出姿势列表
 * 点击应用 → 压 undo 栈 + 设置关节坐标
 * ⇄ 镜像 / ⬇ 导出姿势
 */
import { JOINT_EN, MIRROR_MAP } from "./constants.js";
import { pushUndo } from "./undo.js";

const BASE = "/director_stage/poses/";

/**
 * 创建并返回面板 DOM
 * @returns {HTMLElement}
 */
export function createPosePanel() {
  const panel = document.createElement("div");
  panel.id = "pose-panel";
  panel.style.cssText =
    "width:220px;flex:0 0 auto;background:#171a22;border-right:1px solid #2a2f3d;overflow-y:auto;display:flex;flex-direction:column;user-select:none;";

  // 标题
  const header = document.createElement("div");
  header.textContent = "🎭 姿势库";
  header.style.cssText =
    "padding:12px 14px;font-weight:600;font-size:13px;border-bottom:1px solid #2a2f3d;";
  panel.appendChild(header);

  // 操作按钮行
  const actions = document.createElement("div");
  actions.style.cssText = "padding:8px 10px;display:flex;gap:6px;border-bottom:1px solid #2a2f3d;";
  actions.innerHTML = `
    <button id="poseMirror" title="左右镜像" style="flex:1;padding:6px 4px;font-size:12px;">⇄ 镜像</button>
    <button id="poseExport" title="导出当前姿势为JSON" style="flex:1;padding:6px 4px;font-size:12px;">⬇ 导出</button>
  `;
  panel.appendChild(actions);

  // 列表区
  const list = document.createElement("div");
  list.id = "pose-list";
  list.style.cssText = "flex:1;overflow-y:auto;padding:4px 0;";
  panel.appendChild(list);

  // 空态
  list.innerHTML = `<div style="padding:20px;text-align:center;color:#8a90a0;font-size:12px;">加载中…</div>`;

  return panel;
}

/**
 * 加载姿势索引并渲染列表
 * @param {Function} onApply - (joints: number[][]) => void  应用姿势回调
 */
export async function loadPoseLibrary(onApply) {
  const list = document.getElementById("pose-list");
  if (!list) return;

  try {
    const res = await fetch(BASE + "index.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.poses || !Array.isArray(data.poses)) throw new Error("格式错误");

    list.innerHTML = "";
    data.poses.forEach((pose) => {
      const item = document.createElement("div");
      item.textContent = pose.name || pose.id;
      item.style.cssText =
        "padding:8px 14px;cursor:pointer;font-size:12px;transition:background 0.15s;";
      item.addEventListener("mouseenter", () => {
        item.style.background = "#232836";
      });
      item.addEventListener("mouseleave", () => {
        item.style.background = "";
      });
      item.addEventListener("click", async () => {
        try {
          const pr = await fetch(BASE + pose.file);
          if (!pr.ok) throw new Error(`HTTP ${pr.status}`);
          const pd = await pr.json();
          if (pd.joints && typeof pd.joints === "object") {
            const arr = JOINT_EN.map((name) => pd.joints[name] || [0, 0, 0]);
            onApply(arr);
          }
        } catch (err) {
          console.warn("[姿势库] 加载姿势失败:", pose.file, err);
        }
      });
      list.appendChild(item);
    });
  } catch (err) {
    console.warn("[姿势库] 索引加载失败（dev环境无路由？）:", err.message);
    list.innerHTML = `<div style="padding:20px;text-align:center;color:#8a90a0;font-size:12px;">姿势库不可用</div>`;
  }
}

/**
 * 镜像当前姿势（x 取反 + 左右关节数据互换）
 * @param {THREE.Mesh[]} joints
 * @returns {number[][]} 新关节坐标数组
 */
export function mirrorPose(joints) {
  const arr = joints.map((j) => [j.position.x, j.position.y, j.position.z]);
  const result = arr.map((p) => p.slice());
  for (const [i, mi] of Object.entries(MIRROR_MAP)) {
    const aIdx = parseInt(i);
    // 互换前先对各自做 x 取反
    const mirroredA = [-arr[aIdx][0], arr[aIdx][1], arr[aIdx][2]];
    const mirroredB = [-arr[mi][0], arr[mi][1], arr[mi][2]];
    result[aIdx] = mirroredB;
    result[mi] = mirroredA;
  }
  // Nose 和 Neck 只做 x 取反（它们不参与左右互换）
  result[0] = [-arr[0][0], arr[0][1], arr[0][2]];
  result[1] = [-arr[1][0], arr[1][1], arr[1][2]];
  return result;
}

/**
 * 导出当前姿势为 JSON 文件下载
 * @param {THREE.Mesh[]} joints
 */
export function exportPoseJson(joints) {
  const obj = { name: "custom", id: "custom_" + Date.now(), joints: {} };
  JOINT_EN.forEach((name, i) => {
    obj.joints[name] = [
      +joints[i].position.x.toFixed(4),
      +joints[i].position.y.toFixed(4),
      +joints[i].position.z.toFixed(4),
    ];
  });
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "pose.json";
  a.click();
  URL.revokeObjectURL(a.href);
}
