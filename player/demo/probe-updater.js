'use strict';
/**
 * 探针：GitHub 自动检查更新 + 设置页内下载安装（AA1IMB/Nckik-music）
 * ---------------------------------------------------------------------------
 * 验证：
 *   1. 版本号解析兼容本仓库 `v0.94` 标签 + `NckiksMusic-Setup-0.9.4.exe` 文件名，不误报；
 *   2. 设置页「关于」包含自动检查更新开关与检查/更新按钮，开关状态正常落盘；
 *   3. API 返回 0.9.4 时显示「已是最新」，不弹红点；
 *   4. API 返回 403 限流时自动回退到 releases.atom + expanded_assets，
 *      识别到 v0.9.5 新版本，显示更新说明与红点；
 *   5. 点击「下载更新」流式下载并更新进度条，校验 PE 文件头（MZ），
 *      下载完成后切换为「立即安装」，dry-run 安装成功；
 *   6. 伪造 HTML 错误页冒充 exe 时被文件头校验拦截；
 *   7. 渲染层无 JS 报错。
 */
const { app } = require('electron');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
const { resolveReleaseVersion, compareSemver, pickBestAsset } = require(path.join(root, 'updater.js'));
const pkgVer = String(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || '0.9.6');
const [maj, min, pat] = pkgVer.split('.').map(Number);
const nextVer = `${maj}.${min}.${(Number.isFinite(pat) ? pat : 0) + 1}`;
const sameTag = `v${maj}.${min}${pat}`;
const nextTag = `v${nextVer}`;

process.env.NCKIK_SKIP_MIGRATION = '1';
process.env.NCKIK_UPDATE_DRY_INSTALL = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-upd-'));
app.setPath('userData', tmp);
fs.writeFileSync(path.join(tmp, 'library.json'), '[]');
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  theme: 'dark',
  volume: 0.5,
  autoCheckUpdate: true,
  playlist: []
}));

const logPath = path.join(root, 'demo', 'probe-updater.log');
fs.writeFileSync(logPath, '');
const log = (...a) => {
  const line = a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  fs.appendFileSync(logPath, line + '\n');
  try { console.log(line); } catch {}
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 8000, step = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(step);
  }
  return false;
}

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
};

/* 本地模拟 GitHub API + Atom + expanded_assets + 安装包下载 */
let mode = 'same'; // same | atom_new | bad_exe
let port = 0;
const fakeExe = Buffer.alloc(192 * 1024, 0x41);
fakeExe[0] = 0x4d; // 'M'
fakeExe[1] = 0x5a; // 'Z'

const server = http.createServer((req, res) => {
  const u = req.url || '/';
  if (u.startsWith('/repos/AA1IMB/Nckik-music/releases')) {
    if (mode === 'same') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{
        tag_name: sameTag,
        name: 'Nckiksmusic',
        body: `release: 纳入 v${pkgVer} 安装包与免安装包`,
        draft: false,
        prerelease: true,
        published_at: '2026-11-24T08:07:38Z',
        html_url: `http://127.0.0.1:${port}/AA1IMB/Nckik-music/releases/tag/${sameTag}`,
        assets: [
          { name: `NckiksMusic-Setup-${pkgVer}.exe`, size: 93799197, browser_download_url: `http://127.0.0.1:${port}/AA1IMB/Nckik-music/releases/download/${sameTag}/NckiksMusic-Setup-${pkgVer}.exe` },
          { name: `NckiksMusic-Portable-${pkgVer}.exe`, size: 86345507, browser_download_url: `http://127.0.0.1:${port}/AA1IMB/Nckik-music/releases/download/${sameTag}/NckiksMusic-Portable-${pkgVer}.exe` }
        ]
      }]));
      return;
    }
    // 模拟 GitHub API 403 限流，强制走 Atom + expanded_assets 回退
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'API rate limit exceeded' }));
    return;
  }

  if (u === '/AA1IMB/Nckik-music/releases.atom') {
    res.writeHead(200, { 'Content-Type': 'application/atom+xml; charset=utf-8' });
    res.end(`<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <link rel="alternate" type="text/html" href="http://127.0.0.1:${port}/AA1IMB/Nckik-music/releases/tag/${nextTag}"/>
    <title>${nextTag} 任务栏缩略图控播与自动更新</title>
    <updated>2026-11-24T09:00:00Z</updated>
    <content type="html">&lt;p&gt;1. 新增任务栏缩略图控播&lt;br/&gt;2. 新增应用内检查与更新&lt;/p&gt;</content>
  </entry>
</feed>`);
    return;
  }

  if (u === `/AA1IMB/Nckik-music/releases/expanded_assets/${nextTag}`) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<ul>
      <li><a href="/AA1IMB/Nckik-music/releases/download/${nextTag}/NckiksMusic-Setup-${nextVer}.exe">NckiksMusic-Setup-${nextVer}.exe</a><span>192 KB</span></li>
      <li><a href="/AA1IMB/Nckik-music/releases/download/${nextTag}/NckiksMusic-Portable-${nextVer}.exe">NckiksMusic-Portable-${nextVer}.exe</a><span>180 KB</span></li>
    </ul>`);
    return;
  }

  if (u.includes(`/releases/download/${nextTag}/NckiksMusic-Setup-${nextVer}.exe`)) {
    if (mode === 'bad_exe') {
      const html = Buffer.from('<html><body>502 Bad Gateway</body></html>');
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': String(html.length) });
      res.end(html);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(fakeExe.length) });
    const chunkSize = 48 * 1024;
    let offset = 0;
    const pump = () => {
      if (offset >= fakeExe.length) { res.end(); return; }
      res.write(fakeExe.subarray(offset, offset + chunkSize));
      offset += chunkSize;
      setTimeout(pump, 60);
    };
    pump();
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

let win = null;
const errors = [];
app.on('browser-window-created', (_e, w) => {
  win = w;
  w.webContents.on('console-message', (_ev, lvl, msg) => {
    if (lvl >= 2 && !/Autofill|DevTools/.test(msg)) errors.push(msg);
  });
});

(async () => {
  log('=== 1. 纯逻辑单元测试（版本号与资产匹配） ===');
  const v94 = resolveReleaseVersion({
    tag: 'v0.94',
    title: 'Nckiksmusic',
    notes: 'release: 纳入 v0.9.4',
    assets: [{ name: 'NckiksMusic-Setup-0.9.4.exe', url: 'https://github.com/a' }]
  });
  ok('tag v0.94 + Setup-0.9.4.exe 解析为 0.9.4', v94 === '0.9.4', v94);
  ok('0.9.4 vs 0.9.4 相等（不误报）', compareSemver(v94, '0.9.4') === 0);
  ok('0.9.5 > 0.9.4', compareSemver('0.9.5', '0.9.4') === 1);
  const assets = [
    { name: 'NckiksMusic-Portable-0.9.5.exe', url: 'https://github.com/p' },
    { name: 'NckiksMusic-Setup-0.9.5.exe', url: 'https://github.com/s' }
  ];
  ok('安装版优先选 Setup', pickBestAsset(assets, false)?.name === 'NckiksMusic-Setup-0.9.5.exe');
  ok('免安装版优先选 Portable', pickBestAsset(assets, true)?.name === 'NckiksMusic-Portable-0.9.5.exe');

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  process.env.NCKIK_UPDATE_API = `http://127.0.0.1:${port}`;
  process.env.NCKIK_UPDATE_WEB = `http://127.0.0.1:${port}`;

  require(path.join(root, 'main.js'));
  const js = code => win.webContents.executeJavaScript(code, true);
  await waitFor(() => !!win && !win.webContents.isLoading());
  win.showInactive();
  await waitFor(() => win.isVisible(), 6000);
  await sleep(600);

  log('\n=== 2. 设置页 UI 与自动更新开关 ===');
  await js(`openDrawer(document.querySelector('#dSet')); 0`);
  await sleep(200);
  const ui = await js(`({
    sw: !!document.querySelector('#swAutoUpd'),
    swOn: document.querySelector('#swAutoUpd')?.classList.contains('on'),
    btnCheck: !!document.querySelector('#btnUpdCheck'),
    btnPage: !!document.querySelector('#btnUpdPage'),
    ver: document.querySelector('#verNum')?.textContent
  })`);
  log('  ui:', JSON.stringify(ui));
  ok('设置页存在自动检查更新开关且默认开启', ui.sw && ui.swOn === true);
  ok('设置页存在检查更新与发布页按钮', ui.btnCheck && ui.btnPage);
  await js(`document.querySelector('#swAutoUpd').click(); 0`);
  await sleep(250);
  const afterOff = JSON.parse(fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8'));
  ok('关闭自动检查更新后落盘 autoCheckUpdate=false', afterOff.autoCheckUpdate === false);
  await js(`document.querySelector('#swAutoUpd').click(); 0`);
  await sleep(150);

  log('\n=== 3. 检查更新：已是最新（API 返回 v0.94 / 0.9.4） ===');
  mode = 'same';
  await js(`document.querySelector('#btnUpdCheck').click(); 0`);
  await waitFor(() => js(`document.querySelector('#updState')?.textContent === '已是最新'`), 6000);
  const stSame = await js(`({
    state: document.querySelector('#updState')?.textContent,
    sub: document.querySelector('#updSub')?.textContent,
    actHidden: document.querySelector('#btnUpdAction')?.hidden,
    dot: document.querySelector('#btnSet')?.classList.contains('has-upd')
  })`);
  log('  same:', JSON.stringify(stSame));
  ok('显示已是最新', stSame.state === '已是最新', stSame.sub);
  ok('无更新时隐藏下载按钮且不显示红点', stSame.actHidden === true && stSame.dot === false);

  log(`\n=== 4. 检查更新：API 403 限流 → Atom + expanded_assets 回退发现 v${nextVer} ===`);
  mode = 'atom_new';
  await js(`document.querySelector('#btnUpdCheck').click(); 0`);
  await waitFor(() => js(`document.querySelector('#updState')?.textContent.includes(${JSON.stringify(nextVer)})`), 6000);
  const stNew = await js(`({
    state: document.querySelector('#updState')?.textContent,
    sub: document.querySelector('#updSub')?.textContent,
    notes: document.querySelector('#updNotes')?.textContent,
    notesHidden: document.querySelector('#updNotes')?.hidden,
    actText: document.querySelector('#btnUpdAction')?.textContent,
    actHidden: document.querySelector('#btnUpdAction')?.hidden,
    dot: document.querySelector('#btnSet')?.classList.contains('has-upd'),
    source: upd.info && upd.info.source
  })`);
  log('  new:', JSON.stringify(stNew));
  ok('API 403 时自动回退到 atom 解析', stNew.source === 'atom', String(stNew.source));
  ok(`状态显示发现 v${nextVer}`, stNew.state === `发现 v${nextVer}`, stNew.state);
  ok('显示更新说明内容', !stNew.notesHidden && stNew.notes.includes('缩略图控播'), stNew.notes);
  ok('展示「下载更新」按钮且设置图标出现提醒红点', !stNew.actHidden && stNew.actText === '下载更新' && stNew.dot === true);

  log('\n=== 5. 播放器内下载与安装校验 ===');
  await js(`document.querySelector('#btnUpdAction').click(); 0`);
  await waitFor(() => js(`document.querySelector('#updState')?.textContent === '已就绪'`), 8000);
  const stDl = await js(`({
    state: document.querySelector('#updState')?.textContent,
    actText: document.querySelector('#btnUpdAction')?.textContent,
    barW: document.querySelector('#updProgBar')?.style.width,
    filePath: upd.filePath
  })`);
  log('  downloaded:', JSON.stringify(stDl));
  ok('下载完成状态变为「已就绪」', stDl.state === '已就绪');
  ok('按钮切换为「立即安装」且进度条 100%', stDl.actText === '立即安装' && stDl.barW === '100%');
  ok('下载文件落盘在 updates 目录且大小匹配', fs.existsSync(stDl.filePath) && fs.statSync(stDl.filePath).size === fakeExe.length, stDl.filePath);

  // 点击立即安装（dry-run）
  const instRes = await js(`window.api.updInstall({ filePath: upd.filePath })`);
  log('  install dryRun:', JSON.stringify(instRes));
  ok('立即安装校验通过（dryRun）', instRes && instRes.ok === true && instRes.dryRun === true);

  log('\n=== 6. 损坏/非 PE 文件头拦截 ===');
  mode = 'bad_exe';
  const badRes = await js(`window.api.updDownload({ url: upd.info.asset.url, name: ${JSON.stringify(`NckiksMusic-Setup-${nextVer}.exe`)} })`);
  log('  badRes:', JSON.stringify(badRes));
  ok('非 MZ 文件头被拒绝', badRes && badRes.ok === false && badRes.error.message.includes('文件头校验失败'));

  log('\n=== 7. 渲染层报错 ===');
  ok('渲染层无 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '));

  log('\n----------------------------------------');
  log(`通过 ${pass} 项，失败 ${fail} 项`);
  try { server.close(); } catch {}
  app.exit(fail ? 1 : 0);
})().catch(e => {
  log('FAIL ' + (e && e.stack || e));
  try { server.close(); } catch {}
  app.exit(1);
});
