// generate-mixamo-rig.glb — 生成带完整 Mixamo 骨架的 GLB 角色（65+ 骨骼，含手指/脚趾/多段脊椎）
// Usage: node generate-mixamo-rig.mjs
import * as THREE from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import * as fs from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

// 避免 node 环境下 window/document 缺失
global.window = global;
global.document = { createElement: () => ({ style: {}, getContext: () => null }) };

const scene = new THREE.Scene();

// === 骨骼定义（Mixamo 标准 65 骨，包括手指、脚趾、多段脊椎） ===
const bones = {};

function makeBone(name, parent = null) {
  const b = new THREE.Bone();
  b.name = name;
  if (parent) parent.add(b);
  bones[name] = b;
  return b;
}

// Root → Hips → Spine chain
const root = makeBone("mixamorig:Hips");
root.position.set(0, 0.95, 0);
const spine = makeBone("mixamorig:Spine", root);
spine.position.set(0, 0.12, 0);
const spine1 = makeBone("mixamorig:Spine1", spine);
spine1.position.set(0, 0.12, 0);
const spine2 = makeBone("mixamorig:Spine2", spine1);
spine2.position.set(0, 0.12, 0);
const neck = makeBone("mixamorig:Neck", spine2);
neck.position.set(0, 0.15, 0);
const head = makeBone("mixamorig:Head", neck);
head.position.set(0, 0.12, 0);
const headTop = makeBone("mixamorig:HeadTop_End", head);
headTop.position.set(0, 0.18, 0);

// Left arm chain
const leftShoulder = makeBone("mixamorig:LeftShoulder", spine2);
leftShoulder.position.set(0.06, 0.05, 0);
const leftArm = makeBone("mixamorig:LeftArm", leftShoulder);
leftArm.position.set(0.18, 0, 0);
const leftForeArm = makeBone("mixamorig:LeftForeArm", leftArm);
leftForeArm.position.set(0.28, 0, 0);
const leftHand = makeBone("mixamorig:LeftHand", leftForeArm);
leftHand.position.set(0.26, 0, 0);

// Left hand fingers (5 fingers × 3 bones)
const leftFingerNames = ["Thumb","Index","Middle","Ring","Pinky"];
const leftFingerRoots = [];
for (let i = 0; i < 5; i++) {
  const fn = leftFingerNames[i];
  const m0 = makeBone(`mixamorig:LeftHand${fn}1`, leftHand);
  m0.position.set(0.03 * (i - 1.5), -0.02, 0.04);
  const m1 = makeBone(`mixamorig:LeftHand${fn}2`, m0);
  m1.position.set(0, 0, 0.025);
  const m2 = makeBone(`mixamorig:LeftHand${fn}3`, m1);
  m2.position.set(0, 0, 0.02);
  leftFingerRoots.push(m0);
}

// Right arm chain
const rightShoulder = makeBone("mixamorig:RightShoulder", spine2);
rightShoulder.position.set(-0.06, 0.05, 0);
const rightArm = makeBone("mixamorig:RightArm", rightShoulder);
rightArm.position.set(-0.18, 0, 0);
const rightForeArm = makeBone("mixamorig:RightForeArm", rightArm);
rightForeArm.position.set(-0.28, 0, 0);
const rightHand = makeBone("mixamorig:RightHand", rightForeArm);
rightHand.position.set(-0.26, 0, 0);

// Right hand fingers
const rightFingerNames = ["Thumb","Index","Middle","Ring","Pinky"];
for (let i = 0; i < 5; i++) {
  const fn = rightFingerNames[i];
  const m0 = makeBone(`mixamorig:RightHand${fn}1`, rightHand);
  m0.position.set(0.03 * (1.5 - i), -0.02, 0.04);
  const m1 = makeBone(`mixamorig:RightHand${fn}2`, m0);
  m1.position.set(0, 0, 0.025);
  const m2 = makeBone(`mixamorig:RightHand${fn}3`, m1);
  m2.position.set(0, 0, 0.02);
}

// Left leg chain
const leftUpLeg = makeBone("mixamorig:LeftUpLeg", root);
leftUpLeg.position.set(0.09, -0.04, 0);
const leftLeg = makeBone("mixamorig:LeftLeg", leftUpLeg);
leftLeg.position.set(0, -0.42, 0);
const leftFoot = makeBone("mixamorig:LeftFoot", leftLeg);
leftFoot.position.set(0, -0.42, 0.05);
const leftToeBase = makeBone("mixamorig:LeftToeBase", leftFoot);
leftToeBase.position.set(0, 0, 0.16);
const leftToeEnd = makeBone("mixamorig:LeftToe_End", leftToeBase);
leftToeEnd.position.set(0, 0, 0.05);

// Right leg chain
const rightUpLeg = makeBone("mixamorig:RightUpLeg", root);
rightUpLeg.position.set(-0.09, -0.04, 0);
const rightLeg = makeBone("mixamorig:RightLeg", rightUpLeg);
rightLeg.position.set(0, -0.42, 0);
const rightFoot = makeBone("mixamorig:RightFoot", rightLeg);
rightFoot.position.set(0, -0.42, 0.05);
const rightToeBase = makeBone("mixamorig:RightToeBase", rightFoot);
rightToeBase.position.set(0, 0, 0.16);
const rightToeEnd = makeBone("mixamorig:RightToe_End", rightToeBase);
rightToeEnd.position.set(0, 0, 0.05);

// Eye bones
makeBone("mixamorig:LeftEye", head).position.set(0.03, 0.04, 0.10);
makeBone("mixamorig:RightEye", head).position.set(-0.03, 0.04, 0.10);
// Jaw
makeBone("mixamorig:Jaw", head).position.set(0, -0.02, 0.05);

console.log("骨骼数:", Object.keys(bones).length);

// === 创建简单蒙皮网格（人形 T-pose） ===
const boneList = [root];
root.traverse((b) => { if (b !== root) boneList.push(b); });
const skeleton = new THREE.Skeleton(boneList);

// 生成蒙皮网格（简单的圆柱/球体组合人形）
const geo = new THREE.BufferGeometry();
const positions = [];
const skinIndices = [];
const skinWeights = [];
const uvs = [];

// 为每个骨骼创建一个小段的顶点（共约 200 个顶点组成的简单人形）
function addBoneSegment(parentBone, childBone, parentIdx, childIdx, radius = 0.04, segments = 8) {
  const p0 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  parentBone.getWorldPosition(p0);
  childBone.getWorldPosition(p1);
  const len = p0.distanceTo(p1);
  if (len < 0.001) return;
  const dir = p1.clone().sub(p0).normalize();
  const perp = new THREE.Vector3(-dir.z, 0, dir.x).normalize();
  if (perp.length() < 0.01) perp.set(1, 0, 0);
  const perp2 = new THREE.Vector3().crossVectors(dir, perp).normalize();

  const baseIdx = positions.length / 3;
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const px = perp.x * Math.cos(angle) * radius + perp2.x * Math.sin(angle) * radius;
    const py = perp.y * Math.cos(angle) * radius + perp2.y * Math.sin(angle) * radius;
    const pz = perp.z * Math.cos(angle) * radius + perp2.z * Math.sin(angle) * radius;
    
    positions.push(p0.x + px, p0.y + py, p0.z + pz); // top ring
    skinIndices.push(parentIdx, childIdx, 0, 0);
    skinWeights.push(0.8, 0.2, 0, 0);
    uvs.push(0, i / segments);
    
    positions.push(p1.x + px, p1.y + py, p1.z + pz); // bottom ring
    skinIndices.push(parentIdx, childIdx, 0, 0);
    skinWeights.push(0.2, 0.8, 0, 0);
    uvs.push(1, i / segments);
  }
}

// 遍历所有骨骼对，创建段
boneList.forEach((bone, idx) => {
  bone.children.forEach((child) => {
    if (!child.isBone) return;
    const childIdx = boneList.indexOf(child);
    if (childIdx < 0) return;
    let r = 0.04; // 默认半径
    // 不同骨骼类型不同半径
    if (bone.name.includes("Head")) r = 0.06;
    else if (bone.name.includes("Spine") || bone.name.includes("Hips")) r = 0.07;
    else if (bone.name.includes("Shoulder") || bone.name.includes("Arm") || bone.name.includes("UpLeg")) r = 0.045;
    addBoneSegment(bone, child, idx, childIdx, r);
  });
});

// 三角形索引
const tris = [];
const rows = positions.length / 3 / 2; // 每段 2 行顶点
for (let r = 0; r < rows; r++) {
  const topBase = r * 18; // segments=8 → 2个环各9个顶点 = 18
  const botBase = topBase + 9;
  const nextTop = topBase + 18;
  const nextBot = botBase + 18;
  if (nextBot > positions.length / 3) break;
  for (let i = 0; i < 9; i++) {
    const next = (i + 1) % 9;
    // top ring triangle
    tris.push(topBase + i, topBase + next, nextTop + next);
    tris.push(topBase + i, nextTop + next, nextTop + i);
    // bottom ring triangle
    tris.push(botBase + i, nextBot + next, botBase + next);
    tris.push(botBase + i, nextBot + i, nextBot + next);
    // side triangles
    tris.push(topBase + i, botBase + i, botBase + next);
    tris.push(topBase + i, botBase + next, topBase + next);
  }
}

geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndices, 4));
geo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeights, 4));
geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
geo.setIndex(tris);
geo.computeVertexNormals();

const mat = new THREE.MeshStandardMaterial({
  color: 0xcc9966,
  roughness: 0.5,
  metalness: 0.1,
  skinning: true,
});

const mesh = new THREE.SkinnedMesh(geo, mat);
mesh.name = "Character";
mesh.bind(skeleton);
mesh.castShadow = true;
mesh.receiveShadow = true;

// 头部球体
const headGeo = new THREE.SphereGeometry(0.08, 16, 12);
const headPositions = [];
const headIndices = [];
const headWeights = [];
const headIdx = boneList.indexOf(head);
for (let i = 0; i < headGeo.attributes.position.count; i++) {
  const px = headGeo.attributes.position.getX(i);
  const py = headGeo.attributes.position.getY(i);
  const pz = headGeo.attributes.position.getZ(i);
  headPositions.push(px, py + 0.08, pz);
  headIndices.push(headIdx, 0, 0, 0);
  headWeights.push(1, 0, 0, 0);
}
headGeo.setAttribute("position", new THREE.Float32BufferAttribute(headPositions, 3));
headGeo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(headIndices, 4));
headGeo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(headWeights, 4));
const headMesh = new THREE.SkinnedMesh(headGeo, new THREE.MeshStandardMaterial({ color: 0xddbb88, roughness: 0.4, skinning: true }));
headMesh.name = "HeadMesh";
headMesh.bind(skeleton);

const group = new THREE.Group();
group.add(mesh);
group.add(headMesh);
root.position.set(0, 0.95, 0);
group.add(root);

scene.add(group);

// 更新矩阵
root.updateMatrixWorld(true);
mesh.updateMatrixWorld(true);

// 导出 GLB
const exporter = new GLTFExporter();
const outPath = new URL("../../../assets/models/mixamo-rigged-character.glb", import.meta.url).pathname.replace(/^\//, "");

exporter.parse(
  scene,
  (glb) => {
    fs.writeFileSync(outPath, Buffer.from(glb));
    console.log(`✅ 已生成: ${outPath} (${(glb.byteLength / 1024).toFixed(1)} KB)`);
    console.log(`   骨骼数: ${Object.keys(bones).length}`);
  },
  (err) => { console.error("导出失败:", err); },
  { binary: true, embedImages: true, onlyVisible: true }
);
