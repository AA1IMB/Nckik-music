'use strict';
/**
 * 「登录后自动加载歌单」链路验证（纯 Node，跑 mock 服务）
 * 覆盖：正常账号 / 换账号 / 登录过期 / 需要登录的接口回 301 / 5xx / 空歌单 / 每日推荐 / 私人FM
 */
const { createMock } = require('./mock-ne');

const log = (...a) => console.log(...a);
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
};

(async () => {
  const mock = await createMock();
  process.env.NE_BASE = mock.url;
  const ne = require('../netease.js');
  const st = mock.state;

  log('\n=== 1. 已登录：我的歌单 + 推荐歌单 ===');
  ne.setCookie('MUSIC_U=mock-session-1001');
  let h = await ne.home();
  ok('loggedIn', h.loggedIn === true);
  ok('uid 来自账号接口', h.uid === 1001, 'uid=' + h.uid);
  ok('只列自己创建的 3 个', h.mine && h.mine.list.length === 3, 'got ' + (h.mine && h.mine.list.length));
  ok('我喜欢的音乐置顶', h.mine.list[0].special === 'like', h.mine.list[0].name);
  ok('收藏的歌单被隐藏并计数', h.mine.subscribed === 2, 'hidden=' + h.mine.subscribed);
  ok('推荐歌单 6 个', h.picked && h.picked.list.length === 6);
  ok('卡片字段齐全', (() => {
    const p = h.mine.list[1];
    return p.id && p.name && p.count === 42 && /^http:\/\/127\.0\.0\.1/.test(p.coverUrl);
  })(), JSON.stringify(h.mine.list[1]));

  log('\n=== 2. 每日推荐 ===');
  const d = await ne.dailySongs();
  ok('6 首', d.tracks.length === 6, d.tracks.map(t => t.title).join(','));
  ok('字段映射正确', d.tracks[0].path === 'ne:101' && d.tracks[0].artist === '周杰伦' && d.tracks[0].duration === 269, JSON.stringify(d.tracks[0]).slice(0, 120));
  ok('有日期键', /^\d{4}-\d{2}-\d{2}$/.test(d.day), d.day);
  const before = st.calls.filter(c => c.startsWith('/api/discovery/recommend/songs')).length;
  await ne.dailySongs();
  ok('同一天走缓存不重复请求', st.calls.filter(c => c.startsWith('/api/discovery/recommend/songs')).length === before);

  log('\n=== 3. 私人FM ===');
  const fm = await ne.personalFm(6);
  ok('凑够 6 首', fm.tracks.length === 6, 'ids=' + fm.tracks.map(t => t.netId).join(','));
  ok('无重复', new Set(fm.tracks.map(t => t.netId)).size === fm.tracks.length);
  const fm2 = await ne.personalFm(4);
  ok('第二批仍是去重的 4 首', fm2.tracks.length === 4 && new Set(fm2.tracks.map(t => t.netId)).size === 4, 'ids=' + fm2.tracks.map(t => t.netId).join(','));

  log('\n=== 4. 打开歌单详情 ===');
  const pl = await ne.playlistDetail(502);
  ok('名称/数量/曲目', pl.name === '深夜写代码' && pl.count === 42 && pl.tracks.length === 8, pl.name + ' count=' + pl.count + ' tracks=' + pl.tracks.length);

  log('\n=== 5. 换账号：不能出现上一个账号的歌单 ===');
  st.uid = 2002;
  st.nickname = '另一个号';
  st.playlists = [
    { ...mock.state.playlists[0], id: 901, name: '我喜欢的音乐', creator: { userId: 2002, nickname: '另一个号' }, specialType: 5 },
    { ...mock.state.playlists[1], id: 902, name: '新号的歌单', creator: { userId: 2002, nickname: '另一个号' } }
  ];
  ne.setCookie('MUSIC_U=mock-session-2002');     // 真实流程里扫码成功也会走这里
  h = await ne.home();
  ok('uid 跟着换', h.uid === 2002, 'uid=' + h.uid);
  ok('歌单换成新账号的', h.mine.list.length === 2 && h.mine.list.every(p => p.id === 901 || p.id === 902), h.mine.list.map(p => p.name).join(','));
  ok('昵称跟着换', h.nickname === '另一个号', h.nickname);

  log('\n=== 6. 登录过期（profile 为 null） ===');
  st.mode = 'expired';
  ne.setCookie('MUSIC_U=expired');
  h = await ne.home();
  ok('loggedIn=false', h.loggedIn === false);
  ok('有 cookie 但无账号 → 可区分「过期」与「从未登录」', h.hasCookie === true);
  // 过期不是「歌单接口报错」，而是「压根没走到那一步」：mine 为 null、没有 mineError，
  // 界面靠 hasCookie + loggedIn 组合就能说清是「过期」还是「没登录」
  ok('mine 为空且不伪造错误', h.mine === null && h.mineError === null);
  ok('推荐歌单（公开）仍然拿到', h.picked && h.picked.list.length === 6);
  let e = null;
  try { await ne.dailySongs(); } catch (err) { e = err; }
  ok('每日推荐提示登录', e && e.code === 'NE_LOGIN_REQUIRED', e && e.message);

  log('\n=== 7. 账号在但接口回 301（凭证失效的极端情况） ===');
  st.mode = 'deny';
  ne.setCookie('MUSIC_U=stale');
  h = await ne.home();
  ok('301 翻成 NE_LOGIN_REQUIRED', h.mineError && h.mineError.code === 'NE_LOGIN_REQUIRED', JSON.stringify(h.mineError));

  log('\n=== 8. 空歌单账号 ===');
  st.mode = 'ok';
  st.uid = 3003;
  st.playlists = [];
  ne.setCookie('MUSIC_U=empty');
  h = await ne.home();
  ok('mine.list 为空数组而非 null', h.mine && Array.isArray(h.mine.list) && h.mine.list.length === 0);
  ok('仍带 uid', h.uid === 3003);

  log('\n=== 9. 服务端 5xx ===');
  st.mode = 'fail';
  ne.setCookie('MUSIC_U=boom');
  let r = null;
  try { h = await ne.home(); } catch (err) { r = err; }
  // account() 先挂：整个 home 抛错，IPC 层转成 ok:false，界面显示「加载失败 + 重试」
  ok('整体失败以异常上抛（交给 IPC 统一转错误）', !!r, r && (r.code + ' ' + r.message));

  log('\n=== 10. 未登录 ===');
  st.mode = 'ok';
  st.loggedIn = false;
  ne.setCookie('');
  h = await ne.home();
  ok('loggedIn=false / hasCookie=false', h.loggedIn === false && h.hasCookie === false);
  ok('无 mineError（不是失败，是没登录）', h.mineError === null);
  ok('推荐歌单照常', h.picked && h.picked.list.length === 6);

  log('\n----------------------------------------');
  log(`通过 ${pass} / ${pass + fail}`);
  mock.server.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FAIL', e && e.stack || e); process.exit(1); });
