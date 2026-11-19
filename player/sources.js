'use strict';
/*
 * 音源适配层
 * ---------------------------------------------------------------
 * 目的：让「曲库页」不再为网易云、酷狗各写一套 UI。这一层只做三件事：
 *   1. 把两家 provider 的返回归一成同一套形状（PlaylistItem / Track / Section）；
 *   2. 把「某一家做不到」表达成结构化状态（unsupported / guest / error），
 *      而不是抛异常或返回假数据 —— 界面据此给出可读原因与下一步动作；
 *   3. 统一分页字段（page / hasMore / total），渲染层不用关心上游怎么翻页。
 *
 * 统一模型
 *   PlaylistItem = {
 *     source: 'netease' | 'kugou',
 *     id: string,                    // netease 歌单 id / kugou rankid / '__daily__'
 *     name: string,
 *     coverUrl: string,              // 可能是空串（界面用首字底色兜底）
 *     sub: string,                   // 行副标题，已包含「播放次数 / 更新频率 / N 首」
 *     count: number,
 *     playCount: number,
 *     special: '' | 'like' | 'daily'
 *   }
 *   Section = { key, title, ok, status: 'ok'|'guest'|'unsupported'|'error',
 *               error?: {code,message}, items?: PlaylistItem[], note?: string }
 *   Home = { source, loggedIn, nickname, sections: { daily, recommend, mine },
 *            caps: {daily,recommend,mine,qr,cookie} }
 *   Track = 与 player 现有 Track 完全一致（唯一键 path = `ne:<id>` / `kg:<hash>`）
 *
 * 只做 HTTP 与字段整理，不碰 DOM、不碰 BrowserWindow，和 netease.js / kugou.js 同一层。
 */

const ne = require('./netease');
const kg = require('./kugou');

const SOURCES = ['netease', 'kugou'];

const LABEL = { netease: '网易云音乐', kugou: '酷狗音乐' };

/* 能力矩阵：界面据此决定「这一栏要不要给按钮」。
 * - kugou.daily / kugou.mine：上游对匿名与 Cookie 登录都回 `Access Deny !!!`，
 *   需要 web 端签名与白名单，所以标成不支持，并给出原因文案（不装成空列表）。
 * - kugou.qr：扫码接口要签名（error_code 20010），只能走「导入 Cookie」。 */
const CAPS = {
  netease: { daily: true, recommend: true, mine: true, qr: true, cookie: false },
  kugou: { daily: false, recommend: true, mine: false, qr: false, cookie: true }
};

function capsOf(source) {
  const key = SOURCES.includes(source) ? source : 'netease';
  return { source: key, label: LABEL[key], ...CAPS[key] };
}

function need(source) {
  const key = String(source || '').toLowerCase();
  if (!SOURCES.includes(key)) {
    const e = new Error('未知音源：' + source);
    e.code = 'SRC_UNKNOWN';
    throw e;
  }
  return key;
}

/* provider 的异常统一成 {code,message}：渲染层只认这个形状，不再区分
 * NeError / KgError / 网络错误，避免每个分支各写一套判断。 */
function errInfo(e) {
  if (!e) return { code: 'SRC_ERROR', message: '未知错误' };
  const code = e.code || (e.name === 'NeError' ? 'NE_ERROR' : e.name === 'KgError' ? 'KG_ERROR' : 'SRC_ERROR');
  const message = String(e.message || '').trim() || '请求失败';
  return { code, message };
}

function section(key, title, ok, extra) {
  return { key, title, ok, status: ok ? 'ok' : 'error', ...extra };
}

/* ---------------- 网易云 ---------------- */

const neRow = p => ({
  source: 'netease',
  id: String(p.id),
  name: p.name || '歌单',
  coverUrl: p.coverUrl || '',
  count: Number(p.count) || 0,
  playCount: Number(p.playCount) || 0,
  special: p.special === 'like' ? 'like' : '',
  sub: p.special === 'like'
    ? `我喜欢的音乐 · ${Number(p.count) || 0} 首`
    : Number(p.playCount) ? bigNum(p.playCount) + ' 次播放' : (Number(p.count) || 0) + ' 首'
});

function bigNum(n) {
  const v = Number(n) || 0;
  if (v >= 100000000) return (v / 100000000).toFixed(1).replace(/\.0$/, '') + ' 亿';
  if (v >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, '') + ' 万';
  return String(v);
}

async function neHome() {
  let data = null;
  let err = null;
  try {
    data = await ne.home();
  } catch (e) {
    err = errInfo(e);
  }
  const loggedIn = !!(data && data.loggedIn);

  if (!data) {
    return {
      source: 'netease',
      loggedIn: false,
      nickname: '',
      caps: CAPS.netease,
      sections: {
        daily: section('daily', '每日推荐', false, { status: 'error', error: err }),
        recommend: section('recommend', '推荐歌单', false, { status: 'error', error: err }),
        mine: section('mine', '我创建的歌单', false, { status: 'error', error: err })
      }
    };
  }

  /* 每日推荐与私人FM都是「点进去才拉曲目」的入口，首页只放两张卡；
   * 未登录时照常显示但标成不可点（guest），不给假数据。 */
  const dailyItems = [
    {
      source: 'netease', id: '__daily__', kind: 'card', action: 'daily',
      name: '每日推荐', coverUrl: '', count: 0, playCount: 0, special: 'daily',
      sub: loggedIn ? '按你的口味生成 · 每天更新' : '登录后可用'
    },
    {
      source: 'netease', id: '__fm__', kind: 'card', action: 'fm',
      name: '私人FM', coverUrl: '', count: 0, playCount: 0, special: 'fm',
      sub: loggedIn ? '无限流 · 每次加载一批' : '登录后可用'
    }
  ];
  const daily = section('daily', '每日推荐', true, {
    status: loggedIn ? 'ok' : 'guest',
    note: loggedIn ? '' : '登录后可用每日推荐与私人FM',
    items: dailyItems
  });

  const picked = data.picked && Array.isArray(data.picked.list) ? data.picked.list : null;
  const recommend = picked
    ? section('recommend', '推荐歌单', true, { items: picked.map(neRow) })
    /* 推荐歌单是公开接口，拉不到基本就是网络/接口问题：这种情况必须报错（原因 + 重试），
     * 不能因为「没登录」就把失败说成「登录后可看」。 */
    : data.pickedError
      ? section('recommend', '推荐歌单', false, { status: 'error', error: data.pickedError })
      : section('recommend', '推荐歌单', false, {
        status: 'guest',
        note: '登录后可看到推荐歌单'
      });

  const mineData = data.mine && Array.isArray(data.mine.list) ? data.mine.list : null;
  const mine = mineData
    ? section('mine', '我创建的歌单', true, {
      items: mineData.map(neRow).concat(
        Array.isArray(data.mine.subscribed) ? data.mine.subscribed.map(neRow) : []
      )
    })
    : section('mine', '我创建的歌单', false, {
      status: loggedIn ? 'error' : 'guest',
      error: data.mineError || null,
      note: loggedIn ? '' : '登录后可同步「我创建的歌单」'
    });

  return {
    source: 'netease',
    loggedIn,
    nickname: data.nickname || '',
    uid: data.uid || 0,
    caps: CAPS.netease,
    sections: { daily, recommend, mine }
  };
}

async function nePlaylist(id) {
  if (id === '__daily__') {
    const list = await ne.dailySongs();
    return {
      source: 'netease',
      id,
      name: '每日推荐',
      items: (list || []).map(t => ({ ...t, source: 'netease' })),
      page: 1,
      hasMore: false,
      total: (list || []).length
    };
  }
  const d = await ne.playlistDetail(id);
  return {
    source: 'netease',
    id: String(d.id),
    name: d.name,
    coverUrl: d.coverUrl || '',
    items: (d.tracks || []).map(t => ({ ...t, source: 'netease' })),
    page: 1,
    hasMore: false,
    total: (d.tracks || []).length
  };
}

/* ---------------- 酷狗 ---------------- */

async function kgHome() {
  const st = kg.status();
  const loggedIn = !!(st && st.loggedIn);

  /* 每日推荐 / 我创建的歌单：上游 Access Deny，能力上就是不支持。
   * 这里不抛错、也不返回空列表，而是给出状态与下一步动作。 */
  const deniedDaily = section('daily', '每日推荐', false, {
    status: 'unsupported',
    error: { code: 'KG_UNSUPPORTED', message: '酷狗未开放该接口（需要客户端签名）' },
    note: '酷狗暂不提供每日推荐；可以先用「推荐歌单（榜单）」或搜索'
  });
  const deniedMine = section('mine', '我创建的歌单', false, {
    status: 'unsupported',
    error: { code: 'KG_UNSUPPORTED', message: '酷狗未开放该接口（需要客户端签名）' },
    note: loggedIn
      ? '酷狗账号的歌单接口未开放；导入 Cookie 只影响能否播放会员曲'
      : '酷狗账号的歌单接口未开放；登录也不会解锁，可用「推荐歌单（榜单）」'
  });

  try {
    const r = await kg.ranks(1, 24);
    const recommend = section('recommend', '推荐歌单', true, {
      items: (r.items || []).map(p => ({
        source: 'kugou',
        id: String(p.id),
        name: p.name,
        coverUrl: p.coverUrl || '',
        count: p.count || 0,
        playCount: p.playCount || 0,
        special: '',
        sub: [p.updateText ? p.updateText + '更新' : '', bigNum(p.playCount) + ' 次播放']
          .filter(Boolean).join(' · ')
      })),
      hasMore: !!r.hasMore
    });
    return {
      source: 'kugou',
      loggedIn,
      nickname: '',
      caps: CAPS.kugou,
      sections: { daily: deniedDaily, recommend, mine: deniedMine }
    };
  } catch (e) {
    return {
      source: 'kugou',
      loggedIn,
      nickname: '',
      caps: CAPS.kugou,
      sections: {
        daily: deniedDaily,
        recommend: section('recommend', '推荐歌单', false, { status: 'error', error: errInfo(e) }),
        mine: deniedMine
      }
    };
  }
}

async function kgPlaylist(id, page = 1) {
  const r = await kg.rankSongs(id, page, 60);
  const meta = {
    source: 'kugou',
    id: String(id),
    items: r.items || [],
    page: r.page || page,
    hasMore: !!r.hasMore,
    total: r.total || 0
  };
  /* 第一页顺便把榜单名字带上，标题栏不用再查一次 */
  if (Number(page) <= 1) {
    try {
      const all = await kg.ranks(1, 60);
      const hit = (all.items || []).find(x => String(x.id) === String(id));
      if (hit) meta.name = hit.name;
    } catch { /* 名字拉不到不影响放歌 */ }
  }
  return meta;
}

/* ---------------- 对外接口 ---------------- */

async function home(source) {
  const key = need(source);
  return key === 'kugou' ? kgHome() : neHome();
}

async function playlist(source, id, opts = {}) {
  const key = need(source);
  const page = Math.max(1, Number(opts.page) || 1);
  if (key === 'kugou') return kgPlaylist(id, page);
  return nePlaylist(id);
}

async function cover(source, rawUrl, size = 240) {
  const key = need(source);
  /* 两家的取图返回形状不一样：酷狗直接给 data URL 字符串，网易云给 { dataUrl, bytes, at }。
   * 这一层统一成字符串 —— 否则渲染层会把对象拼进 CSS 的 url()，得到 url("[object Object]")，
   * 封面位置看起来是空的，但类名照样有（探针只数类名就发现不了）。 */
  const out = key === 'kugou'
    ? await kg.coverByUrl(rawUrl, size)
    /* 网易云的封面地址是完整的 CDN 链接，走它自己的取图（带 referer 与尺寸参数） */
    : await ne.coverData(rawUrl, size);
  return typeof out === 'string' ? out : (out && out.dataUrl) || '';
}

/* 登录能力：两家都用「凭证状态」表达，界面据此显示账号条 */
function authInfo(source) {
  const key = need(source);
  if (key === 'kugou') return { source: 'kugou', ...kg.authInfo() };
  return { source: 'netease', loggedIn: ne.hasCookie() };
}

module.exports = {
  SOURCES,
  LABEL,
  CAPS,
  capsOf,
  home,
  playlist,
  cover,
  errInfo,
  authInfo,
  // 便于测试
  neHome,
  kgHome,
  kgPlaylist,
  nePlaylist,
  bigNum
};
