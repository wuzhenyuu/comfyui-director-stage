# Mixamo 3D角色批量导入指南

## 第一步：下载角色 (在桌面Chrome操作)

打开 https://www.mixamo.com → 登录Adobe账号(免费注册)

以下24个Mixamo角色都有完整65骨骼(手指+脚趾+脊柱)，下载步骤相同：

### 推荐下载角色 (优先顺序):

| # | 角色名 | 类型 | 特点 |
|---|--------|------|------|
| 1 | Y Bot | 男机器人 | 最通用，和michelle同骨架 |
| 2 | X Bot | 女机器人 | 女性机器人 |
| 3 | Claire | 女 | 现代女性 |
| 4 | James | 男 | 西装男 |
| 5 | Adam | 男 | 运动装男 |
| 6 | Maya | 女 | 运动装女 |
| 7 | Remy | 女 | 休闲女 |
| 8 | Peasant Man | 男 | 农民 |
| 9 | Sporty Granny | 女 | 运动奶奶(有趣) |
| 10 | Mousey | 女 | 小老鼠风格 |
| 11 | Paladin | 男 | 盔甲骑士 |
| 12 | Swat | 男 | 特警 |

### 下载步骤（每个角色30秒）：
1. 顶部 Characters 标签 → 找到角色 → 点击
2. 右侧 Download 按钮
3. Format: **FBX for Unity** (或 FBX)
4. Pose: **T-pose**
5. 点击 Download → 保存到 F:\comfyui\custom_nodes\comfyui-director-stage\downloads\

## 第二步：FBX → GLB 转换 (在Blender中)

打开 Blender → 导入 FBX → 导出 GLB (勾选 Skinning + Animation)

## 第三步：添加到项目

1. 把 .glb 放到 assets/models/
2. 更新 index.json 添加条目

---

### 更简单的方式: 直接从Sketchfab搜索下载(无需Blender)

搜索 "mixamo rigged glb" → 筛选 Downloadable + CC Attribution → 下载GLB格式
