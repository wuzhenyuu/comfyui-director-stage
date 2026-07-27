import { createRequire } from 'module';
const require = createRequire('C:/Users/Administrator/AppData/Roaming/npm/node_modules/');
const { chromium } = require('playwright');
import http from 'http'; import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const webRoot = path.join(repoRoot, 'web/editor');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.glb': 'model/gltf-binary' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  let file = p.startsWith('/director_stage/models/') ? path.join(repoRoot, 'assets/models', path.basename(p)) : path.join(webRoot, p === '/' ? '/index.html' : p);
  if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const browser = await chromium.launch({ channel: 'msedge' }).catch(() => chromium.launch({ channel: 'chrome' }));
const page = await browser.newPage();
await page.goto('http://127.0.0.1:' + port + '/index.html');
await page.waitForFunction(() => !!window.__ds, null, { timeout: 10000 });
await page.waitForTimeout(1500);
const out = await page.evaluate(async () => {
  const mgr = window.__ds.externalCharacters;
  for (const e of mgr.getAll()) mgr.remove(e.id);
  const e = await mgr.addGLB('/director_stage/models/ue-mannequin-retopology.glb', 'ue');
  const entry = e || mgr.getAll()[0];
  const find = (n) => entry.allBones.find((b) => b.name === n);
  const chain = (n) => { const c = []; let b = find(n); while (b) { c.push(b.name + (b.isBone ? ' [Bone]' : ' [NOT-Bone]')); b = b.parent; } return c; };
  return {
    thighParent: find('Bip001_R_Thigh_061')?.parent?.name,
    thighChain: chain('Bip001_R_Thigh_061'),
    headChain: chain('Bip001_Head_055'),
    rigPelvis: entry._rig?.pelvis?.name || '(rig未捕获)',
  };
});
console.log(JSON.stringify(out, null, 1));
await browser.close(); server.close();
