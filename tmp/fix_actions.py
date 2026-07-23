"""Fix action-presets.js: Forward direction + home capture bug."""
path = r'F:\comfyui\custom_nodes\comfyui-director-stage\editor-src\src\action-presets.js'
with open(path, 'r', encoding='utf-8') as f:
    c = f.read()

# Fix 1: Forward direction (R×up → up×R)
old_fwd = '''  // 角色面朝方向：right = up × forward → forward = right × up
  let R = new THREE.Vector3(1, 0, 0);
  if (rig.shoulderR && rig.shoulderL) {
    R = rig.shoulderR.clone().sub(rig.shoulderL);
    R.y = 0;
    if (R.lengthSq() < 1e-6) R.set(1, 0, 0);
    else R.normalize();
  }
  rig.R = R;
  rig.F = new THREE.Vector3().crossVectors(R, rig.up);
  if (rig.F.lengthSq() < 1e-6) rig.F.set(0, 0, 1);
  rig.F.normalize();'''

new_fwd = '''  // 角色面朝方向（修复：R=RShoulder-LShoulder→R=LShoulder-RShoulder, F=R×up→F=up×R）
  //   LShoulder.x > RShoulder.x → R = L-R → R.x > 0（右方向指向世界+X）
  //   up(0,1,0) × right(1,0,0) = forward(0,0,1) → 面朝 +Z ✓
  let R = new THREE.Vector3(1, 0, 0);
  if (rig.shoulderR && rig.shoulderL) {
    R = rig.shoulderL.clone().sub(rig.shoulderR);  // L→R = 角色右侧方向
    R.y = 0;
    if (R.lengthSq() < 1e-6) R.set(1, 0, 0);
    else R.normalize();
  }
  rig.R = R;
  rig.F = new THREE.Vector3().crossVectors(rig.up, R);  // up × right = forward
  if (rig.F.lengthSq() < 1e-6) rig.F.set(0, 0, 1);
  rig.F.normalize();'''

assert old_fwd in c, 'Forward code not found!'
c = c.replace(old_fwd, new_fwd)

# Fix 2: Ensure rig.home is captured from jointMap bones (not IK targets) on first call
# The home should be the model's initial skeleton pose, not current IK target positions.
# IK targets may have been dragged away from skeleton. We need to capture from bone world positions.
old_home = '''  // 初始 IK 姿势（= 站立基准）
  for (const [name, t] of Object.entries(entry.ikTargets || {})) {
    if (!t?.target || !t?.pole) continue;
    rig.home[name] = {
      target: t.target.getWorldPosition(new THREE.Vector3()),
      pole: t.pole.getWorldPosition(new THREE.Vector3()),
    };
  }'''

new_home = '''  // 初始 IK 姿势（= 站立基准）
  // 修复：从骨骼世界坐标推算 home，而非当前的 IK 球位置。
  // IK 球可能已被用户拖离骨架，用 IK 球位置做 home 会导致 stand 动作回不到 T-pose。
  const jm = entry.jointMap;
  const getEnd = (idx) => jm?.get?.(idx)?.getWorldPosition(new THREE.Vector3()) || null;
  const getMid = (idx) => jm?.get?.(idx)?.getWorldPosition(new THREE.Vector3()) || null;
  const COCO_CHAIN_HOME = {
    rightArm: { end: 4, mid: 3 },  // RWrist, RElbow
    leftArm:  { end: 7, mid: 6 },  // LWrist, LElbow
    rightLeg: { end: 10, mid: 9 }, // RAnkle, RKnee
    leftLeg:  { end: 13, mid: 12 },// LAnkle, LKnee
  };
  for (const [name, def] of Object.entries(COCO_CHAIN_HOME)) {
    const endPos = getEnd(def.end);
    const midPos = getMid(def.mid);
    if (!endPos || !midPos) continue;
    // pole 放肘/膝外侧：mid + (right方向 * 0.15)
    const poleDir = name === 'rightArm' || name === 'rightLeg' ? R : R.clone().negate();
    rig.home[name] = {
      target: endPos.clone(),
      pole: midPos.clone().addScaledVector(poleDir, 0.15),
    };
  }'''

assert old_home in c, 'Home capture code not found!'
c = c.replace(old_home, new_home)

# Fix 3: Also fix the rig.home for the __walk/run Idle case: ensure leg amplitude uses correct F
# No code change needed — the place() function already uses the corrected rig.F/rig.R

with open(path, 'w', encoding='utf-8') as f:
    f.write(c)
print('OK: Fixed Forward direction + home capture in action-presets.js')
