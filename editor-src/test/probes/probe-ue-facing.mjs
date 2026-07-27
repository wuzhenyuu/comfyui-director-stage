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
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://127.0.0.1:' + port + '/index.html');
await page.waitForFunction(() => !!window.__ds, null, { timeout: 10000 });
await page.waitForTimeout(1500);
await page.evaluate(async () => {
  const mgr = window.__ds.externalCharacters;
  for (const e of mgr.getAll()) mgr.remove(e.id);
  const e = await mgr.addGLB('/director_stage/models/ue-mannequin-retopology.glb', 'ue');
  mgr.setActive?.((e || mgr.getAll()[0]).id);
});
await page.waitForTimeout(2500);
const out = await page.evaluate(() => {
  const e = window.__ds.externalCharacters.getActive();
  const V3 = e.model.position.constructor;
  const find = (n) => e.allBones.find((b) => b.name === n);
  const wp = (b) => { const v = new V3(); b.getWorldPosition(v); return [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)]; };
  const jw = (i) => { const b = e.jointMap?.get(i); return b ? wp(b) : null; };
  // 触发 stand 捕获 rig
  document.querySelector('[data-action-id="stand"]')?.click();
  return new Promise((res) => setTimeout(() => {
    const rig = e._rig;
    res({
      head: wp(find('Bip001_Head_055')), neck: wp(find('Bip001_Neck_06')), spine: wp(find('Bip001_Spine_04')),
      rUpperArm: wp(find('Bip001_R_UpperArm_032')), lUpperArm: wp(find('Bip001_L_UpperArm_08')),
      rHand: wp(find('Bip001_R_Hand_034')),
      jmWrist4: jw(4), jmWrist7: jw(7),
      rigF: rig ? [+rig.F.x.toFixed(2), +rig.F.y.toFixed(2), +rig.F.z.toFixed(2)] : null,
      rigR: rig ? [+rig.R.x.toFixed(2), +rig.R.y.toFixed(2), +rig.R.z.toFixed(2)] : null,
      relaxedR: rig?.relaxed?.rightArm ? [+rig.relaxed.rightArm.target.x.toFixed(2), +rig.relaxed.rightArm.target.y.toFixed(2), +rig.relaxed.rightArm.target.z.toFixed(2)] : null,
      pelvisName: rig?.pelvis?.name,
      ikTargetRA: e.ikTargets?.rightArm?.target ? [+e.ikTargets.rightArm.target.position.x.toFixed(2), +e.ikTargets.rightArm.target.position.y.toFixed(2), +e.ikTargets.rightArm.target.position.z.toFixed(2)] : null,
    });
  }, 1500));
});
console.log(JSON.stringify(out, null, 1));
await browser.close(); server.close();
