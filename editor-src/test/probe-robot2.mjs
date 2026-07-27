/** probe-mixamo-vanilla.mjs �?纯净 three.js GLTFLoader 加载测试（排除编辑器管线�?*/
import { createRequire } from "module";
const require = createRequire("C:/Users/Administrator/AppData/Roaming/npm/node_modules/");
const { chromium } = require("playwright");
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const threeRoot = path.join(repoRoot, "editor-src/node_modules/three");
const outDir = path.join(__dirname, "out", "pose-check", "clean");
fs.mkdirSync(outDir, { recursive: true });

const html = `<!DOCTYPE html><html><head><style>body{margin:0;background:#223}</style>
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
</head><body>
<script type="module">
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.add(new THREE.AmbientLight(0xffffff, 1.2));
const dl = new THREE.DirectionalLight(0xffffff, 2); dl.position.set(2, 4, 3); scene.add(dl);
const cam = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.01, 100);
cam.position.set(0.6, 1.4, 3.2); cam.lookAt(0, 0.9, 0);
const grid = new THREE.GridHelper(4, 8); scene.add(grid);
new GLTFLoader().load("/director_stage/models/_tmp-robot-expressive.glb", (g) => {
  scene.add(g.scene);
  window.__loaded = true;
  const sk = new THREE.SkeletonHelper(g.scene); scene.add(sk);
  renderer.render(scene, cam);
  window.__renderOnce = () => renderer.render(scene, cam);
}, undefined, (e) => { window.__error = String(e?.message || e); });
</script></body></html>`;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".glb": "model/gltf-binary", ".map": "application/json" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  let file;
  if (p === "/vanilla.html") { res.writeHead(200, { "Content-Type": "text/html" }); res.end(html); return; }
  if (p.startsWith("/director_stage/models/")) file = path.join(repoRoot, "assets/models", path.basename(p));
  else if (p.startsWith("/three/")) file = path.join(threeRoot, p.slice(7));
  else { res.writeHead(404); res.end(); return; }
  if (!fs.existsSync(file)) { res.writeHead(404); res.end("nf:" + file); return; }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch({ channel: "chrome" }));
const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("console", (m) => { if (m.type() === "error") console.log("[console]", m.text()); });
await page.goto(`http://127.0.0.1:${port}/vanilla.html`);
const ok = await page.waitForFunction(() => window.__loaded || window.__error, null, { timeout: 20000 }).then(() => true).catch(() => false);
const err = await page.evaluate(() => window.__error || null);
console.log("loaded:", ok, "error:", err);
await page.waitForTimeout(500);
await page.evaluate(() => window.__renderOnce?.());
await page.screenshot({ path: path.join(outDir, "mixamo-vanilla.png") });
console.log("�?mixamo-vanilla.png");
await browser.close();
server.close();
