'use strict';
/**
 * 网易云接口 mock（仅测试用）
 * ---------------------------------------------------------------------------
 * 真实环境里「我的歌单 / 每日推荐 / 私人FM」都必须登录才给数据，CI 里没有账号，
 * 所以这里按官方返回结构造一份假数据，把 netease.js 的解析与降级逻辑跑通。
 * 通过 NE_BASE 指过来即可，不用改业务代码。
 */
const http = require('node:http');
const zlib = require('node:zlib');

/* 造一张真 PNG（32×32 纯色）：coverData 会拒收 <128 字节的响应，
 * 用 1×1 的占位图会被判成「封面数据为空」，测不出真实链路。 */
function makePng(size = 64) {
  const w = size, h = size;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;                       // filter: none
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      // 渐变而不是纯色：纯色会被 deflate 压到 100 字节以内，撞上 coverData 的「数据为空」判定
      raw[o] = (x * 5 + y * 3) & 255;
      raw[o + 1] = (x * 2 + y * 7) & 255;
      raw[o + 2] = 168;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, data])) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const PNG = makePng(32);

/* 真能解码的音频：8kHz 单声道 PCM WAV。
 * 不同档位给不同时长，于是响应字节数不同——探针可以直接用 content-length
 * 证明「换档后拉的确实是另一份流」，而不是只看一个状态字段。 */
const WAV_CACHE = new Map();
function makeWav(secs, rate = 8000) {
  if (WAV_CACHE.has(secs)) return WAV_CACHE.get(secs);
  const n = Math.round(secs * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 2200), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);          // PCM
  h.writeUInt16LE(1, 22);          // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  const out = Buffer.concat([h, data]);
  WAV_CACHE.set(secs, out);
  return out;
}

/* 与线上一致的降级规则：level 生效；无损在非会员账号上被静默降成 320k。
 * 时长按档位递增，方便探针用字节数区分。 */
const TIERS = {
  standard: { br: 128000, type: 'mp3', secs: 2 },
  higher: { br: 192000, type: 'mp3', secs: 3 },
  exhigh: { br: 320000, type: 'mp3', secs: 4 },
  lossless: { br: 999000, type: 'flac', secs: 5 }
};

const mkSong = (id, name, artist, album, dt) => ({
  id,
  name,
  ar: [{ id: 9000 + (id % 97), name: artist }],
  al: { id: 7000 + (id % 53), name: album, picUrl: '/img/' + (id % 5) + '.png' },
  dt,
  fee: id % 7 === 0 ? 1 : 0
});

const mkPlaylist = (id, name, count, uid, opt = {}) => ({
  id,
  name,
  trackCount: count,
  coverImgUrl: '/img/' + (id % 5) + '.png',
  playCount: opt.playCount || 12345,
  subscribed: opt.subscribed === true,
  specialType: opt.specialType || 0,
  privacy: 0,
  creator: { userId: uid, nickname: opt.creator || '我' },
  userId: uid
});

const SONGS = [
  mkSong(101, '晴天', '周杰伦', '叶惠美', 269000),
  mkSong(102, '稻香', '周杰伦', '魔杰座', 223000),
  mkSong(103, '夜曲', '周杰伦', '十一月的萧邦', 226000),
  mkSong(104, '七里香', '周杰伦', '七里香', 299000),
  mkSong(105, '告白气球', '周杰伦', '周杰伦的床边故事', 215000),
  mkSong(106, '青花瓷', '周杰伦', '我很忙', 239000),
  mkSong(107, '简单爱', '周杰伦', '范特西', 270000),
  mkSong(108, '搁浅', '周杰伦', '七里香', 247000)
];

function createMock() {
  const state = {
    loggedIn: true,
    uid: 1001,
    nickname: '小云',
    /** 'ok' | 'expired'（profile 为 null）| 'deny'（需要登录的接口回 301）| 'fail'（5xx） */
    mode: 'ok',
    playlists: [
      mkPlaylist(501, '我喜欢的音乐', 128, 1001, { specialType: 5 }),
      mkPlaylist(502, '深夜写代码', 42, 1001),
      mkPlaylist(503, '2026 循环', 87, 1001),
      mkPlaylist(601, '收藏·别人的歌单', 30, 8888, { subscribed: true }),
      mkPlaylist(602, '收藏·另一个', 12, 9999, { subscribed: true })
    ],
    picked: [1, 2, 3, 4, 5, 6].map(i => mkPlaylist(700 + i, '推荐歌单 ' + i, 20 + i, 6666, { playCount: i * 23456 })),
    daily: SONGS.slice(0, 6),
    fm: SONGS.slice(2),
    fmCursor: 0,
    calls: [],
    /** 让 /api/user/playlist 也回 301（模拟 cookie 失效但 profile 还在的极端情况） */
    denyPlaylist: false,
    /** 账号有没有无损权限：false 时 lossless 会被降级成 320k（线上就是这个行为） */
    vip: false,
    lastLevel: '',
    audioGets: []
  };

  const send = (res, obj, status = 200) => {
    const b = Buffer.from(JSON.stringify(obj));
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length });
    res.end(b);
  };
  const sendWithHeaders = (res, obj, headers) => {
    const b = Buffer.from(JSON.stringify(obj));
    res.writeHead(200, Object.assign({ 'content-type': 'application/json; charset=utf-8', 'content-length': b.length }, headers));
    res.end(b);
  };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const p = u.pathname;
    state.calls.push(p + (u.search || ''));

    if (p.startsWith('/img/')) {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length });
      return res.end(PNG);
    }

    /* 音频流：带 Range，进度条拖拽/换档后回到原进度都依赖它 */
    if (p.startsWith('/audio/')) {
      const tier = p.slice('/audio/'.length).replace(/\.wav$/, '');
      const t = TIERS[tier] || TIERS.exhigh;
      const buf = makeWav(t.secs);
      state.audioGets.push(tier);
      const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      if (m && (m[1] || m[2])) {
        const start = m[1] ? Number(m[1]) : Math.max(0, buf.length - Number(m[2]));
        const end = m[1] && m[2] ? Math.min(Number(m[2]), buf.length - 1) : buf.length - 1;
        const body = buf.subarray(start, end + 1);
        res.writeHead(206, {
          'content-type': 'audio/wav', 'content-length': body.length,
          'content-range': `bytes ${start}-${end}/${buf.length}`, 'accept-ranges': 'bytes'
        });
        return res.end(body);
      }
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': buf.length, 'accept-ranges': 'bytes' });
      return res.end(buf);
    }

    if (state.mode === 'fail') return send(res, { code: 500, message: 'mock 5xx' }, 500);

    if (p === '/api/nuser/account/get') {
      if (!state.loggedIn || state.mode === 'expired') return send(res, { code: 200, profile: null, account: null });
      return send(res, {
        code: 200,
        profile: { userId: state.uid, nickname: state.nickname, avatarUrl: '/img/0.png', vipType: 11 },
        account: { id: state.uid, userName: 'mock' }
      });
    }

    /* 扫码登录：取码 → 第一次轮询 801 → 第二次 803 并在响应头下发会话串 */
    if (p === '/api/login/qrcode/unikey') {
      state.qrPolls = 0;
      return send(res, { code: 200, unikey: 'mock-unikey-' + Date.now() });
    }
    if (p === '/api/login/qrcode/client/login') {
      state.qrPolls = (state.qrPolls || 0) + 1;
      if (state.qrPolls < 2) return send(res, { code: 801 });
      return sendWithHeaders(res, { code: 803, nickname: state.nickname }, {
        'set-cookie': ['MUSIC_U=mock-qr-session; Path=/; HttpOnly', '__csrf=mock-csrf; Path=/']
      });
    }

    if (p === '/api/user/playlist') {
      if (!state.loggedIn || state.mode === 'deny' || state.denyPlaylist) return send(res, { code: 301 });
      const uid = Number(u.searchParams.get('uid'));
      const offset = Number(u.searchParams.get('offset') || 0);
      const limit = Number(u.searchParams.get('limit') || 500);
      // 故意只回「请求的 uid」对应的歌单，用来验证不会串到上一个账号
      const all = state.playlists.map(x => ({ ...x, creator: { ...x.creator, userId: x.creator.userId } }));
      const mine = all.filter(x => x.creator.userId === uid || x.subscribed);
      const page = mine.slice(offset, offset + limit);
      return send(res, { code: 200, more: offset + limit < mine.length, playlist: page });
    }

    if (p === '/api/personalized/playlist') {
      const n = Number(u.searchParams.get('limit') || 6);
      return send(res, { code: 200, result: state.picked.slice(0, n) });
    }

    if (p === '/api/search/get') {
      const kw = String(u.searchParams.get('s') || '').trim().toLowerCase();
      const songs = SONGS.filter(x =>
        x.name.toLowerCase().includes(kw) || x.ar[0].name.toLowerCase().includes(kw));
      return send(res, { code: 200, result: { songs: kw ? songs : [] } });
    }

    if (p === '/api/discovery/recommend/songs') {
      if (!state.loggedIn || state.mode === 'deny') return send(res, { code: 301 });
      return send(res, { code: 200, data: { dailySongs: state.daily } });
    }

    if (p === '/api/radio/get') {
      if (!state.loggedIn || state.mode === 'deny') return send(res, { code: 301 });
      const s = state.fm[state.fmCursor % state.fm.length];
      state.fmCursor++;
      return send(res, { code: 200, data: [s] });
    }

    if (p === '/api/v6/playlist/detail') {
      const id = Number(u.searchParams.get('id'));
      const pl = state.playlists.find(x => x.id === id) || state.picked.find(x => x.id === id);
      if (!pl) return send(res, { code: 404, msg: '歌单不存在' });
      if (pl.subscribed && !state.loggedIn) return send(res, { code: 301 });
      const tracks = SONGS.slice(0, Math.min(3, SONGS.length));
      // 详情只回前 3 首，完整列表走 trackIds → song/detail，正好覆盖真实接口的行为
      const ids = SONGS.slice(0, Math.min(pl.trackCount, SONGS.length)).map(s => ({ id: s.id }));
      return send(res, {
        code: 200,
        playlist: {
          id: pl.id, name: pl.name, trackCount: pl.trackCount,
          coverImgUrl: pl.coverImgUrl, specialType: pl.specialType,
          trackIds: ids,
          tracks
        }
      });
    }

    if (p === '/api/song/detail') {
      const ids = JSON.parse(u.searchParams.get('ids') || '[]');
      return send(res, { code: 200, songs: SONGS.filter(s => ids.includes(s.id)) });
    }

    /* 播放地址：v0 与 v1 都认 level（线上 v0 其实忽略 level，这里按 v1 语义实现，
     * 「v0 忽略 level」这条实测结论记在 netease.js 的注释里） */
    if (p === '/api/song/enhance/player/url' || p === '/api/song/enhance/player/url/v1') {
      const id = (JSON.parse(u.searchParams.get('ids') || '[]')[0]) || 0;
      const asked = u.searchParams.get('level') || 'exhigh';
      let tier = TIERS[asked] ? asked : 'exhigh';
      if (tier === 'lossless' && !state.vip) tier = 'exhigh';     // 无权限静默降级
      state.lastLevel = asked;
      const t = TIERS[tier];
      const origin = 'http://' + (req.headers.host || '127.0.0.1');
      return send(res, {
        code: 200,
        data: [{
          id, code: 200,
          url: origin + '/audio/' + tier + '.wav',
          br: t.br, type: t.type, level: tier,
          size: makeWav(t.secs).length, expi: 1200, fee: 0
        }]
      });
    }
    if (p === '/api/song/lyric') return send(res, { code: 200, lrc: { lyric: '[00:00.00]mock 歌词\n[00:05.00]第二句' } });

    send(res, { code: 404, msg: '接口未找到！' });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const base = 'http://127.0.0.1:' + port;
      // 真实接口回的是绝对地址，mock 也补成绝对，避免测出「相对路径被丢掉」这种假问题
      const abs = u => (typeof u === 'string' && u.startsWith('/') ? base + u : u);
      for (const p of [...state.playlists, ...state.picked]) p.coverImgUrl = abs(p.coverImgUrl);
      for (const s of [...state.daily, ...state.fm]) s.al.picUrl = abs(s.al.picUrl);
      resolve({ server, state, port, url: base });
    });
  });
}

module.exports = { createMock, SONGS };
