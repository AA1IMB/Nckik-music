'use strict';
/*
 * 探针：酷狗扫码登录
 *
 * 验的是「真的能把官方登录页的二维码取出来、并在取消后把隐藏窗口收干净」，
 * 不验「扫码成功后保存」—— 那一步需要真人拿手机扫，机器上无法自动完成；
 * 扫码成功后的保存路径由 probe-kg-auth 的「合成凭证」用例覆盖（同一条 kgLogin）。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.NCKIK_SKIP_MIGRATION = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-qr-probe-'));
app.setPath('userData', tmp);

const root = path.join(__dirname, '..');
const wav = path.join(tmp, 'a.wav');
fs.copyFileSync(path.join(root, 'demo', 'demo.wav'), wav);
fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify([{
  path: wav, title: '样本', artist: '探针', album: '', duration: 42,
  codec: 'WAV', sampleRate: 44100, bitDepth: 16, bitrate: 1411200, lossless: true
}], null, 2));
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  theme: 'dark', volume: 0, muted: true, globalKeys: false, playMode: 'seq', playlist: []
}, null, 2));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let win = null;
app.on('browser-window-created', (_e, w) => { if (!win) win = w; });

let pass = 0, fail = 0;
const say = (ok, name, extra) => {
  if (ok) pass++; else fail++;
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (extra ? '  ' + JSON.stringify(extra) : ''));
};
const js = c => win.webContents.executeJavaScript(c, true);

async function waitFor(fn, ms = 15000, step = 200) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await sleep(step);
  }
  return false;
}

const snap = () => js(`(() => {
  const wrap = $('#kgQrWrap');
  const box = $('#kgQrBox');
  const shot = $('#kgQrShot');
  const img = shot ? shot.querySelector('img') : null;
  const mask = $('#kgQrMask');
  const state = $('#kgQrState');
  const pop = $('#popKgAuth');
  return {
    wrapShow: !!(wrap && wrap.classList.contains('show')),
    dead: !!(box && box.classList.contains('dead')),
    img: img ? (img.getAttribute('src') || '').slice(0, 30) : '',
    imgLen: img ? (img.getAttribute('src') || '').length : 0,
    mask: mask ? mask.textContent.trim() : '',
    state: state ? state.textContent.trim() : '',
    popShow: !!(pop && pop.classList.contains('show'))
  };
})()`);

(async () => {
  require(path.join(root, 'main.js'));
  while (!win || win.webContents.isLoading()) await sleep(100);
  for (let i = 0; i < 200 && !(await js('S.tracks !== undefined')); i++) await sleep(100);
  win.setSize(1100, 700);
  await sleep(400);

  console.log('\n=== 1. 设置页发起扫码：真的取到二维码 ===');
  await js("$('#btnSet').click()");
  await sleep(600);
  const before = BrowserWindow.getAllWindows().length;
  await js("$('#btnKgQr').click()");

  const gotImg = await waitFor(async () => {
    const s = await snap();
    return s.wrapShow && s.img.indexOf('data:image') === 0 && s.imgLen > 1000;
  }, 25000);
  const s1 = await snap();
  say(s1.wrapShow, '扫码面板展开', { wrapShow: s1.wrapShow });
  say(gotImg, '取到二维码（data:image 图）', { len: s1.imgLen, head: s1.img });
  say(!s1.dead, '没有走「扫码不可用」的降级遮罩', { dead: s1.dead, mask: s1.mask });
  say(/扫码/.test(s1.state), '状态行提示扫码', { state: s1.state });
  const after = BrowserWindow.getAllWindows().length;
  say(after === before + 1, '官方登录页在后台窗口里跑（不弹到用户面前）', { before, after });

  console.log('\n=== 2. 轮询期间二维码保持可用 ===');
  await sleep(4500);
  const s2 = await snap();
  say(s2.wrapShow && s2.img.indexOf('data:image') === 0, '几秒后二维码仍在', { len: s2.imgLen });
  say(/扫码|确认|刷新/.test(s2.state), '状态行仍在给指令', { state: s2.state });

  console.log('\n=== 3. 取消：会话结束、隐藏窗口收干净 ===');
  await js("$('#btnKgQrCookie').click()");
  await sleep(800);
  const s3 = await snap();
  say(!s3.wrapShow, '扫码面板收起', { wrapShow: s3.wrapShow });
  say(s3.popShow, '直接落到「导入 Cookie」面板（显式降级）', { popShow: s3.popShow });
  const left = BrowserWindow.getAllWindows().length;
  say(left === before, '隐藏的登录窗口已关闭', { before, left });
  const gone = await js("(async () => { try { const r = await window.api.kgQrPoll('1'); return r && r.ok === false ? (r.error && r.error.code) || 'err' : 'still-ok'; } catch (e) { return 'threw'; } })()");
  say(gone === 'KG_QR_GONE' || gone === 'threw', '会话结束后再轮询被拒（不残留会话）', { code: gone });

  console.log('\n=== 4. 未登录态未被污染 ===');
  const st = await js("(S.kg.status || {}).loggedIn");
  say(st === false, '扫码未完成时仍是未登录', { loggedIn: st });

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  app.exit(fail ? 1 : 0);
})().catch(e => { console.error('PROBE CRASH', e); app.exit(2); });
