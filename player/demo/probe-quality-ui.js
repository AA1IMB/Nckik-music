'use strict';
/**
 * 探针：音质切换 + 曲库列表封面（不属于项目代码）
 * ---------------------------------------------------------------------------
 * 这一轮要证明两件事，且都不靠肉眼：
 *   A. 音质档位真的换了流 —— 不是只改了一个字段。判据：不同档位拉到的
 *      音频字节数不同、进度与暂停状态保留、设置落盘、主进程默认档位同步。
 *   B. 曲库列表有封面、没封面有占位 —— 判据：真实 <img>、占位首字、上千行时
 *      只对可视区发请求（thumbUrl 缓存条数远小于曲目数）。
 */
const { app } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { createMock } = require('./mock-ne');

const root = path.join(__dirname, '..');
// 探针必须隔离：绝不把本机旧配置搬进测试环境
process.env.NCKIK_SKIP_MIGRATION = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-quality-'));
app.setPath('userData', tmp);
// 迁移守卫：main.js 会把旧数据目录搬进空 userData，这里先占位阻止它
fs.writeFileSync(path.join(tmp, 'library.json'), '[]'); // migrate-guard

const logPath = path.join(root, 'demo', 'probe-quality-ui.log');
fs.writeFileSync(logPath, '');
const log = (...a) => {
  const line = a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  fs.appendFileSync(logPath, line + '\n');
  try { console.log(line); } catch {}
};
/* 截图目录可能不存在（新解压的工程没有 screenshots/）：写之前先建好 */
function ensureShots() {
  try { fs.mkdirSync(path.join(root, 'screenshots'), { recursive: true }); } catch {}
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 15000, step = 120) {
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

let win = null;
const errors = [];
app.on('browser-window-created', (_e, w) => {
  win = w;
  w.webContents.on('console-message', (_ev, lvl, msg) => {
    if (lvl >= 2 && !/Autofill|DevTools/.test(msg)) errors.push(msg);
  });
});

/* 与 mock 里 makeWav 一致的字节数：用它判断「拉到的是哪一档的流」 */
const wavSize = (secs, rate = 8000) => 44 + secs * rate * 2;

(async () => {
  const mock = await createMock();
  process.env.NE_BASE = mock.url;

  require(path.join(root, 'main.js'));
  const ne = require(path.join(root, 'netease.js'));
  const js = code => win.webContents.executeJavaScript(code, true);

  await waitFor(() => !!win && !win.webContents.isLoading());
  await sleep(900);
  win.setSize(1180, 820);
  // 窗口必须真的可见：隐藏窗口下 IntersectionObserver 不触发（缩略图一条都不取），
  // 音频也可能一直停在 paused。上一套探针刚退出时尤其容易赶上这个时机。
  win.showInactive();
  await waitFor(() => win.isVisible(), 6000);
  await sleep(300);
  await js(`(() => { const s = document.createElement('style'); s.textContent = '*{transition:none!important;animation-duration:0s!important}'; document.head.appendChild(s); })()`);

  async function shot(name) {
    await sleep(260);
    for (let i = 0; i < 6; i++) {
      const png = (await win.webContents.capturePage()).toPNG();
      if (png.length > 3000) { ensureShots(); fs.writeFileSync(path.join(root, 'screenshots', name), png); return true; }
      await sleep(280);
    }
    return false;
  }

  /* ---------------- 0. 准备本地曲目 ---------------- */
  const withCover = path.join(root, 'demo', 'demo.wav');          // 旁边有 demo.png
  const noCover = path.join(tmp, 'nocover.wav');
  fs.copyFileSync(withCover, noCover);
  log('[0] 本地素材：带封面=' + withCover + ' 无封面=' + noCover);

  await js(`(() => {
    S.tracks = [
      { path: ${JSON.stringify(withCover)}, title: '带封面', artist: 'A', album: 'B', duration: 3 },
      { path: ${JSON.stringify(noCover)}, title: '无封面', artist: 'C', album: 'D', duration: 3 }
    ];
    S.i = -1;
    openDrawer(document.querySelector('#dLib'));
    renderLibrary();
  })()`);
  await sleep(400);

  /* ---------------- 1. 列表封面 ---------------- */
  log('\n=== 1. 曲库列表封面 ===');
  await waitFor(() => js(`document.querySelectorAll('#libList .item .th.art img').length >= 1`), 8000);
  const rowInfo = await js(`(() => {
    const rows = [...document.querySelectorAll('#libList .item')];
    return rows.map(r => {
      const th = r.querySelector('.th');
      const img = th.querySelector('img');
      return {
        name: r.querySelector('.n').textContent.trim(),
        hasImg: !!img,
        art: th.classList.contains('art'),
        srcKind: img ? String(img.getAttribute('src')).slice(0, 22) : '',
        ph: (th.textContent || '').trim(),
        w: Math.round(th.getBoundingClientRect().width),
        h: Math.round(th.getBoundingClientRect().height)
      };
    });
  })()`);
  log('  ', JSON.stringify(rowInfo));
  ok('带封面的行出现真实 <img>', rowInfo[0].hasImg && rowInfo[0].art, rowInfo[0].srcKind);
  ok('封面是 data URL（CSP 不放外域）', /^data:image\/png;base64/.test(rowInfo[0].srcKind), rowInfo[0].srcKind);
  ok('无封面的行保留首字占位', !rowInfo[1].hasImg && rowInfo[1].ph === '无', rowInfo[1].ph);
  ok('占位与封面尺寸一致（38×38，不会撑开行高）', rowInfo[0].w === 38 && rowInfo[1].w === 38 && rowInfo[0].h === 38, `${rowInfo[0].w}×${rowInfo[0].h}`);

  /* ---------------- 2. 上千行只在可视区取图 ---------------- */
  log('\n=== 2. 长列表：只给可视区取封面 ===');
  await js(`(() => {
    S.tracks = Array.from({ length: 400 }, (_, i) => ({
      path: ${JSON.stringify(tmp)} + '/missing-' + i + '.wav',
      title: '占位曲目 ' + i, artist: 'X', album: 'Y', duration: 3
    }));
    renderLibrary();
  })()`);
  await sleep(1600);
  const lazy = await js(`(() => ({
    tracks: S.tracks.length,
    rows: document.querySelectorAll('#libList .item').length,
    cached: thumbUrl.size,
    img: document.querySelectorAll('#libList .item .th img').length
  }))()`);
  log('  ', JSON.stringify(lazy));
  ok('400 首全部渲染', lazy.rows === 400, 'rows=' + lazy.rows);
  ok('只对可视区（含一屏预取）取封面', lazy.cached > 0 && lazy.cached <= 40, 'cache=' + lazy.cached);
  ok('缺失封面的行没有伪造图片', lazy.img === 0, 'img=' + lazy.img);

  /* ---------------- 3. 音质：默认档位 ---------------- */
  log('\n=== 3. 网易云曲目按档位播放 ===');
  await js(`(() => {
    S.tracks = []; S.i = -1;
    renderLibrary();
  })()`);
  const searched = await js(`(async () => {
    const r = await window.api.neSearch('晴天', 1);
    if (!r || !r.ok) return { ok: false, err: r && r.error };
    await playNet(r.tracks[0]);
    return { ok: true, id: r.tracks[0].netId, title: r.tracks[0].title };
  })()`);
  ok('搜索并开播', !!(searched && searched.ok), JSON.stringify(searched));
  const started = await waitFor(() => js(`S.playing === true && S.tracks[S.i] && !!S.tracks[S.i].bitrate`), 8000);
  if (!started) {
    // 后台窗口的自动播放偶尔会被拦一次：主动补一次 play，避免把「环境时序」记成功能失败
    await js(`audio.play().catch(() => {}); 0`);
    await waitFor(() => js(`S.playing === true`), 6000);
  }

  const st = () => js(`(() => {
    const k = S.tracks[S.i] || {};
    return {
      i: S.i, title: k.title, bitrate: k.bitrate, codec: k.codec,
      level: k.level, downgraded: !!k.downgraded,
      paused: audio.paused, t: Number(audio.currentTime.toFixed(2)),
      src: String(audio.src),
      quality: S.settings.quality
    };
  })()`);
  let s = await st();
  log('  ', JSON.stringify(s));
  ok('默认按「极高」播放', s.bitrate === 320000 && s.level === 'exhigh', `${s.bitrate} ${s.level}`);
  ok('地址走 neaudio 代理', /^neaudio:\/\/s\//.test(s.src), s.src);

  /* 拉开一点进度，后面用它验证「换档不掉进度」 */
  await js(`audio.currentTime = 1.2; 0`);
  await sleep(300);
  const streamSize = () => js(`(async () => {
    const r = await fetch(audio.src, { headers: { Range: 'bytes=0-0' } });
    const cr = r.headers.get('content-range') || '';
    const m = /\\/(\\d+)$/.exec(cr);
    return m ? Number(m[1]) : -1;
  })()`);
  const size320 = await streamSize();
  ok('当前拉的是 4 秒那份流（320k 档）', size320 === wavSize(4), 'bytes=' + size320);

  /* ---------------- 4. 弹层与四档 ---------------- */
  log('\n=== 4. 音质弹层 ===');
  await js(`document.querySelector('#btnFmt').click()`);
  await sleep(260);
  const popInfo = await js(`(() => ({
    shown: document.querySelector('#popFmt').classList.contains('show'),
    opts: [...document.querySelectorAll('#qualList .qopt')].map(b => ({
      q: b.dataset.q, name: b.querySelector('.qn').textContent,
      hint: b.querySelector('.qs').textContent,
      on: b.classList.contains('on')
    })),
    head: document.querySelector('#popFmt .pop-head').textContent
  }))()`);
  log('  ', JSON.stringify(popInfo));
  ok('弹层打开', popInfo.shown === true);
  ok('四个档位都在', popInfo.opts.length === 4, popInfo.opts.map(o => o.name).join('/'));
  ok('当前档位高亮为「极高」', popInfo.opts.find(o => o.on && o.q === 'exhigh') !== undefined);
  await shot('23-quality-pop.png');

  /* ---------------- 5. 切到标准：换流、保进度、继续播 ---------------- */
  log('\n=== 5. 切到「标准」 ===');
  const before = await st();
  mock.state.audioGets.length = 0;
  await js(`document.querySelector('#qualList .qopt[data-q="standard"]').click()`);
  const switched = await waitFor(() => js(`S.tracks[S.i] && S.tracks[S.i].bitrate === 128000`), 12000);
  await sleep(700);
  s = await st();
  log('  ', JSON.stringify(s));
  ok('码率真的变成 128k', switched && s.bitrate === 128000, s.bitrate + '');
  ok('实际拉的是 2 秒那份流（说明换源了）', (await streamSize()) === wavSize(2));
  ok('仍是播放中（没被打断）', s.paused === false);
  ok('进度保留（1.2s 附近继续）', s.t >= before.t - 0.4 && s.t <= before.t + 2.6, `${before.t} → ${s.t}`);
  ok('请求分档带到接口', mock.state.lastLevel === 'standard', mock.state.lastLevel);
  ok('音频流按档位重新拉取', mock.state.audioGets.includes('standard'), mock.state.audioGets.join(','));
  ok('设置已更新', s.quality === 'standard', s.quality);

  /* ---------------- 6. 无损降级：如实说明 ---------------- */
  log('\n=== 6. 无损（账号无权限） ===');
  await js(`document.querySelector('#qualList .qopt[data-q="lossless"]').click()`);
  await waitFor(() => js(`S.tracks[S.i] && S.tracks[S.i].bitrate === 320000`), 12000);
  await sleep(500);
  s = await st();
  const fmt = await js(`(() => ({
    note: document.querySelector('#fmtNote').textContent,
    rows: [...document.querySelectorAll('#fmtList .pop-row')].map(r => r.textContent),
    toast: document.querySelector('#toast').textContent,
    on: (document.querySelector('#qualList .qopt.on') || {}).dataset
  }))()`);
  log('  ', JSON.stringify(s));
  log('  ', JSON.stringify(fmt));
  ok('降级被标记', s.downgraded === true && s.bitrate === 320000, `${s.level} downgraded=${s.downgraded}`);
  ok('实测区写了请求档位', fmt.rows.some(t => t.includes('请求音质') && t.includes('无损')), fmt.rows[0]);
  ok('说明文字点出没权限', /没有|只能/.test(fmt.note), fmt.note);
  ok('toast 说清楚了实际码率', /只能取到/.test(fmt.toast), fmt.toast);
  ok('高亮仍在「无损」', fmt.on && fmt.on.q === 'lossless');
  await shot('24-quality-lossless.png');

  /* ---------------- 7. 暂停中换档：状态不丢 ---------------- */
  log('\n=== 7. 暂停中换档 ===');
  await js(`audio.pause(); 0`);
  await sleep(200);
  const pausedAt = await js(`Number(audio.currentTime.toFixed(2))`);
  await js(`document.querySelector('#qualList .qopt[data-q="higher"]').click()`);
  await waitFor(() => js(`S.tracks[S.i] && S.tracks[S.i].bitrate === 192000`), 12000);
  await sleep(600);
  s = await st();
  log('  ', JSON.stringify(s), '| pausedAt=' + pausedAt);
  ok('换档后仍是暂停（不会被强行播放）', s.paused === true);
  ok('仍是 192k', s.bitrate === 192000, s.bitrate + '');
  ok('进度没被重置', Math.abs(s.t - pausedAt) < 1.2, `${pausedAt} → ${s.t}`);
  ok('拉的是 3 秒那份流', (await streamSize()) === wavSize(3));

  /* ---------------- 8. 本地曲目：档位不作用于文件 ---------------- */
  log('\n=== 8. 本地曲目切档 ===');
  await js(`(async () => {
    S.tracks.push({ path: ${JSON.stringify(withCover)}, title: '带封面', artist: 'A', album: 'B', duration: 3 });
    await playIndex(S.tracks.length - 1);
  })()`);
  await waitFor(() => js(`S.playing === true && String(audio.src).startsWith('media:')`), 10000);
  const localBefore = await js(`({ src: String(audio.src), t: Number(audio.currentTime.toFixed(2)) })`);
  await js(`document.querySelector('#qualList .qopt[data-q="exhigh"]').click()`);
  await sleep(700);
  const localAfter = await js(`(() => ({
    src: String(audio.src), t: Number(audio.currentTime.toFixed(2)),
    toast: document.querySelector('#toast').textContent,
    note: document.querySelector('#fmtNote').textContent,
    quality: S.settings.quality, paused: audio.paused
  }))()`);
  log('  ', JSON.stringify(localBefore), '→', JSON.stringify(localAfter));
  ok('本地曲目不受档位影响（源没变）', localAfter.src === localBefore.src && localAfter.src.startsWith('media:'), localAfter.src.slice(0, 34));
  ok('没有打断播放', localAfter.paused === false);
  ok('明确说明本地按原文件播放', /本地文件/.test(localAfter.toast + localAfter.note), localAfter.toast);
  ok('档位本身仍然记住了', localAfter.quality === 'exhigh');

  /* ---------------- 9. 落盘与主进程同步 ---------------- */
  log('\n=== 9. 设置落盘 ===');
  await sleep(500);
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8'));
  ok('settings.json 里有 quality', saved.quality === 'exhigh', String(saved.quality));
  ok('主进程默认档位已同步（协议代理按它取地址）', ne.getQuality() === 'exhigh', ne.getQuality());

  /* ---------------- 10. 最小窗口下面板不越界 ---------------- */
  log('\n=== 10. 最小窗口（860×560）下的弹层 ===');
  win.setSize(860, 560);
  await sleep(450);
  await js(`closePops(); 0`);                 // 上一步可能还开着，先关掉再点，避免点成「收起」
  await sleep(120);
  await js(`document.querySelector('#btnFmt').click()`);
  await sleep(320);
  const box = await js(`(() => {
    const p = document.querySelector('#popFmt');
    const r = p.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left),
      right: Math.round(r.right), h: Math.round(r.height), vh: innerHeight, vw: innerWidth,
      cw: document.documentElement.clientWidth, styleLeft: p.style.left, ow: p.offsetWidth,
      scrollable: p.scrollHeight > p.clientHeight + 1 };
  })()`);
  log('  ', JSON.stringify(box));
  ok('面板完整落在窗口内', box.h > 200 && box.top >= 0 && box.bottom <= box.vh && box.left >= 0 && box.right <= box.vw, JSON.stringify(box));
  ok('内容超出时改为面板内滚动', box.scrollable === true, `content>${box.h}`);
  await shot('26-quality-pop-min.png');
  await js(`closePops(); 0`);
  win.setSize(1180, 820);

  /* ---------------- 11. 截图 + 报错 ---------------- */
  log('\n=== 10. 收尾 ===');
  await js(`(() => {
    closePops();
    closeDrawers();
    S.tracks = [
      { path: ${JSON.stringify(withCover)}, title: '带封面', artist: 'A', album: 'B', duration: 3 },
      { path: ${JSON.stringify(noCover)}, title: '无封面', artist: 'C', album: 'D', duration: 3 }
    ];
    S.i = -1;
    openDrawer(document.querySelector('#dLib'));
    renderLibrary();
  })()`);
  await sleep(900);
  await shot('25-library-covers.png');
  ok('渲染层无 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '));

  log('\n----------------------------------------');
  log(`通过 ${pass} 项，失败 ${fail} 项`);
  app.exit(fail ? 1 : 0);
})().catch(e => {
  log('FAIL ' + (e && e.stack || e));
  app.exit(1);
});
