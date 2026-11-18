'use strict';
/**
 * 源码分发打包器（不属于运行时，只是发布工具）
 * ---------------------------------------------------------------------------
 *   node tools/make-source-zip.js
 *
 * 产出：release/NckiksMusic-src-<版本>-<日期>.zip
 *
 * 三条硬要求：
 *   1. 保持原目录结构（根目录的文档 + player/ 应用目录）；
 *   2. 只装「人需要的东西」——源码、配置、依赖清单、资源、文档、测试探针；
 *      node_modules / dist / 日志 / 缓存 / 生成物一律不进；
 *   3. 包内自带文件清单（含每个文件的 SHA256 与用途）和排除项说明。
 *
 * ZIP 自己写，不引依赖：第三方压缩工具在 Windows 上经常把路径分隔符写成 `\`，
 * 解压到 macOS/Linux 会变成一个带反斜杠的怪文件名。这里固定用 `/`，
 * 非 ASCII 文件名打 UTF-8 标志位（bit 11）。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');          // 项目根目录（含 player/）
const OUT_DIR = path.join(ROOT, 'release');   // 不用点开头，方便在资源管理器里找到

/* ---------------- 清单：显式列，不靠通配扫盘 ---------------- */
const ROOT_FILES = [
  '音乐播放器设计方案.md',
  '音乐播放器代码审查报告.md',
  'music-player-prototype.html',
  '启动播放器.bat'
];

const PLAYER_FILES = [
  'README.md',
  'ENV.example',
  'package.json',
  'package-lock.json',
  'main.js',
  'preload.js',
  'netease.js',
  'make-demo.js',
  'make-icon.js',
  '启动播放器.bat'
];

// 目录按扩展名过滤：只要源码/资源，不要日志与生成物
const PLAYER_DIRS = [
  { dir: 'renderer', keep: f => /\.(html|css|js)$/i.test(f) },
  { dir: 'assets', keep: f => /\.ttf$/i.test(f), recursive: true },
  { dir: 'build', keep: f => /\.png$/i.test(f) },
  { dir: 'demo', keep: f => /\.js$/i.test(f) },                    // mock 与探针；日志/生成的 wav/png/lrc 不要
  { dir: 'screenshots', keep: f => /\.png$/i.test(f) }
];

const TOOL_FILES = ['tools/make-source-zip.js'];

/* ---------------- 每个文件的用途说明（写进清单） ---------------- */
const DESC = {
  '音乐播放器设计方案.md': '设计方案正文：设计原则、信息架构、视觉系统、歌词时间轴、技术架构、音源适配、发布与打包（v1.16）',
  '音乐播放器代码审查报告.md': '一轮独立的代码审查记录：问题清单、判断依据与修改建议',
  'music-player-prototype.html': '最早的单文件原型（纯静态 HTML），用于对照视觉与交互，不参与运行',
  '启动播放器.bat': '根目录启动器：定位 player/，缺依赖时先 npm install，再拉起 electron（纯 ASCII + CRLF）',
  'player/README.md': '应用主文档：安装/源码运行/能力清单/未实现项/字体/目录结构/各版本变更与验证记录',
  'player/ENV.example': '环境变量模板：NE_BASE、NCKIK_SKIP_MIGRATION、SHOT_* 调试开关（不自动加载，仅作参考）',
  'player/package.json': '依赖声明 + 启动/打包脚本 + electron-builder 打包配置（NSIS、asar、asarUnpack、图标）',
  'player/package-lock.json': '依赖锁文件：npm ci 可精确复现同一套依赖树',
  'player/main.js': 'Electron 主进程：窗口、media/neaudio 自定义协议、IPC、元数据解析、凭证加密、快捷键、数据迁移',
  'player/preload.js': '预加载脚本：contextBridge 白名单，渲染层只能看到这些 API',
  'player/netease.js': '网易云音源适配层：HTTP、字段归一化、扫码登录、歌单/推荐、音质档位与地址缓存',
  'player/renderer/index.html': '单界面结构：顶栏、封面、歌词、进度条、播放控制、曲库/设置抽屉、各类弹层',
  'player/renderer/app.css': '视觉系统：Design Token、日夜两套、歌词擦除、弹层与抽屉布局',
  'player/renderer/app.js': '渲染层全部逻辑：播放链、平滑时钟、歌词、取色、曲库渲染、在线音源、交互与快捷键',
  'player/make-demo.js': '生成示例素材（正弦波 WAV + 渐变 PNG + LRC），零依赖，用于本地验证播放/歌词',
  'player/make-icon.js': '生成应用图标：白底圆角 + 一笔画红色音符，多尺寸预览，零依赖手写 PNG',
  'player/启动播放器.bat': '应用目录启动器（源码运行入口，纯 ASCII + CRLF，先清 ELECTRON_RUN_AS_NODE）',
  'player/assets/fonts/PingFangSC-Medium.ttf': '苹方 Medium 字体（11 MB），通过 @font-face 全局使用；随包分发，注意商用授权',
  'player/build/icon.png': '应用图标 512×512（打包时由 electron-builder 转 .ico）',
  'player/build/icon-preview.png': '图标多尺寸预览（16/24/32/48/64/96/128/256），验收小尺寸辨识度用',
  'player/demo/mock-ne.js': '网易云接口 mock：本地起 HTTP 服务，模拟登录态/歌单/推荐/音频流（含 Range 与按档位变码率）',
  'player/demo/probe-myplaylists.js': '探针：账号歌单只列自己创建的 / 我喜欢的置顶 / 换账号不串数据（30 项，纯 Node）',
  'player/demo/probe-home.js': '探针：登录后歌单首页 → 打开歌单 → 每日推荐 → 私人FM → 搜索 → 退出/过期/失败/换账号（50 项）',
  'player/demo/probe-login.js': '探针：扫码登录全链路（二维码内容、状态机、凭证加密落盘、退出清理）',
  'player/demo/probe-login2.js': '探针：二维码轮询的生命周期（关抽屉停轮询、重开恢复、连点刷新不叠加）',
  'player/demo/probe-quality-ui.js': '探针：音质四档切换是否真的换流（按字节数判定）、进度与暂停保留、列表封面懒加载（39 项）',
  'player/demo/probe-edge.js': '探针：坏配置/空曲库/非法导入/接口全挂/并发扫描/最小窗口等异常路径（19 项）',
  'player/demo/probe-brand.js': '探针：名称统一、苹方全局生效、包内字体与图标产物（14 项）',
  'tools/make-source-zip.js': '本脚本：生成源码分发包（文件清单 + 排除说明 + 自写 ZIP 写入）'
};

const SHOT_DESC = {
  '01-dark': '暗色主题主界面', '02-library-light': '曲库抽屉（浅色）', '03-settings-light': '设置页（浅色）',
  '04-fullscreen': '全屏歌词', '05-progress': '进度条与时间气泡', '06-settings': '设置页（暗色）',
  '07-fullscreen-1366': '1366 宽下的全屏', '08-scrub-drag': '拖拽进度中', '09-scrub-after': '拖拽松手后',
  '10-scrub-fullscreen': '全屏下拖拽进度', '11-net-source': '抽屉里的音源切换', '12-net-playing': '在线曲目播放中',
  '13-qr-wait': '二维码等待扫码', '14-qr-expired': '二维码过期', '15-qr-success': '扫码成功', '16-qr-light': '二维码（浅色）',
  '17-net-home': '网易云歌单首页', '18-net-playlist': '歌单详情', '19-net-fm': '私人 FM', '20-net-guest': '未登录态',
  '21-net-error': '接口失败态', '22-net-home-light': '歌单首页（浅色）', '23-quality-pop': '音质弹层（四档）',
  '24-quality-lossless': '无损降级提示', '25-library-covers': '曲库列表封面与占位', '26-quality-pop-min': '最小窗口下的音质弹层',
  '27-packaged-boot': '打包版启动画面', '28-packaged-lib': '打包版曲库', '29-packaged-clean': '干净配置首次启动',
  '30-installed-app': '安装后运行', '31-renamed-settings': '改名后的设置页', '32-about-renamed': '关于页（名称/字体/版本）'
};

/* ---------------- 工具 ---------------- */
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const kb = n => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(1) + ' KB');

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = buf => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** 极简 ZIP 写入：固定 `/` 分隔、UTF-8 标志位、deflate 或 store 取小者 */
function writeZip(zipPath, entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const needUtf8 = /[^\x20-\x7e]/.test(e.name);
    const deflated = zlib.deflateRawSync(e.data, { level: 9 });
    const useDeflate = deflated.length < e.data.length;
    const body = useDeflate ? deflated : e.data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(e.data);

    const d = new Date(e.mtime);
    const dosTime = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
    const dosDate = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(needUtf8 ? 0x0800 : 0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(needUtf8 ? 0x0800 : 0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE((0o100644 << 16) >>> 0, 38);   // 普通文件 0644
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += lh.length + nameBuf.length + body.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.writeFileSync(zipPath, Buffer.concat([...locals, cdBuf, eocd]));
}

/* ---------------- 收集文件 ---------------- */
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'player', 'package.json'), 'utf8'));
const version = pkg.version;
const stamp = (() => {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
})();
const pkgName = `NckiksMusic-src-${version}-${stamp}`;
const stage = path.join(OUT_DIR, pkgName);

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

const files = [];       // { rel, abs }
const missing = [];
const add = (relFromRoot) => {
  const abs = path.join(ROOT, relFromRoot);
  if (!fs.existsSync(abs)) { missing.push(relFromRoot); return; }
  files.push({ rel: relFromRoot.replace(/\\/g, '/'), abs });
};

for (const f of ROOT_FILES) add(f);
for (const f of PLAYER_FILES) add('player/' + f);
for (const f of TOOL_FILES) add(f);
for (const { dir, keep, recursive } of PLAYER_DIRS) {
  const base = path.join(ROOT, 'player', dir);
  if (!fs.existsSync(base)) { missing.push('player/' + dir); continue; }
  const walk = (d, prefix) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, ent.name);
      const rel = prefix ? prefix + '/' + ent.name : ent.name;
      if (ent.isDirectory()) { if (recursive) walk(abs, rel); continue; }
      if (keep(ent.name)) add('player/' + dir + '/' + rel);
    }
  };
  walk(base, '');
}

/* ---------------- 复制 + 记账 ---------------- */
const rows = [];
for (const f of files) {
  const dst = path.join(stage, f.rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const buf = fs.readFileSync(f.abs);
  fs.writeFileSync(dst, buf);
  rows.push({
    rel: f.rel,
    size: buf.length,
    sha: sha256(buf),
    mtime: fs.statSync(f.abs).mtime
  });
}

/* ---------------- 文件清单与排除说明 ---------------- */
/* 目录树：按路径构造嵌套结构再渲染，保证缩进与分支线对齐 */
function treeLines(rels) {
  const root = { dirs: new Map(), files: [] };
  for (const rel of rels) {
    const parts = rel.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { dirs: new Map(), files: [] });
      node = node.dirs.get(parts[i]);
    }
    node.files.push(parts[parts.length - 1]);
  }
  const out = [];
  const walk = (node, prefix) => {
    const entries = [
      ...[...node.dirs.keys()].sort().map(n => ({ name: n, dir: true })),
      ...node.files.slice().sort().map(n => ({ name: n, dir: false }))
    ];
    entries.forEach((e, i) => {
      const last = i === entries.length - 1;
      out.push(prefix + (last ? '└── ' : '├── ') + e.name + (e.dir ? '/' : ''));
      if (e.dir) walk(node.dirs.get(e.name), prefix + (last ? '    ' : '│   '));
    });
  };
  walk(root, '');
  return out;
}

const descOf = rel => {
  if (DESC[rel]) return DESC[rel];
  const m = /^player\/screenshots\/(\d+)-([a-z0-9-]+)\.png$/.exec(rel);
  if (m) return '截图：' + (SHOT_DESC[m[1] + '-' + m[2]] || '界面验证图');
  return '';
};

const totalBytes = rows.reduce((s, r) => s + r.size, 0);
const manifest = [];
manifest.push('# 文件清单与排除说明');
manifest.push('');
manifest.push(`项目：**Nckik′s music ${version}** · 单界面桌面音乐播放器（Electron + 原生 Web Audio）`);
manifest.push('');
manifest.push(`打包时间：${new Date().toISOString().replace('T', ' ').slice(0, 19)}　|　文件数：${rows.length}（另有本清单，包内共 ${rows.length + 1} 个文件）　|　解压后约 ${(totalBytes / 1048576).toFixed(1)} MB`);
manifest.push('');
manifest.push('---');
manifest.push('');
manifest.push('## 1. 这个包是什么');
manifest.push('');
manifest.push('可直接迁移到另一台电脑继续开发/运行的**源码分发包**（不是安装包）。安装包请用 `npm run dist` 自行生成，或使用同批次产出的 `NckiksMusic-Setup-' + version + '.exe`。');
manifest.push('');
manifest.push('包内保持原有目录结构：根目录放文档与启动器，`player/` 是应用本体。');
manifest.push('');
manifest.push('## 2. 目录结构');
manifest.push('');
manifest.push('```');
manifest.push(pkgName + '/');
manifest.push(treeLines([...rows.map(r => r.rel), '文件清单与排除说明.md']).join('\n'));
manifest.push('```');
manifest.push('');
manifest.push('## 3. 文件清单');
manifest.push('');
manifest.push('| 文件 | 大小 | SHA256（前 16 位） | 说明 |');
manifest.push('| --- | --- | --- | --- |');
for (const r of rows) {
  manifest.push(`| \`${r.rel}\` | ${kb(r.size)} | \`${r.sha.slice(0, 16)}\` | ${descOf(r.rel) || '—'} |`);
}
manifest.push('');
manifest.push('完整 SHA256（可用于校验文件完整性）：');
manifest.push('');
manifest.push('```');
for (const r of rows) manifest.push(r.sha + '  ' + r.rel);
manifest.push('```');
manifest.push('');
manifest.push('## 4. 已排除的内容及原因');
manifest.push('');
manifest.push('| 排除项 | 体积 | 原因 | 需要时怎么补回来 |');
manifest.push('| --- | --- | --- | --- |');
manifest.push('| `player/node_modules/` | ~359 MB | 已安装的第三方依赖；平台相关（Windows x64 二进制），拷到别的机器上大概率不可用 | 在 `player/` 里执行 `npm ci`（依据 `package-lock.json` 精确还原） |');
manifest.push('| `player/dist/` | ~370 MB | 构建产物（安装包 + win-unpacked + blockmap）。可完全由源码重建 | `cd player && npm run dist`（会先重生成图标再打包） |');
manifest.push('| `player/demo/demo.wav` / `demo.png` / `demo.lrc` | ~3.8 MB | 由脚本生成的示例素材，不是源文件 | `cd player && node make-demo.js` |');
manifest.push('| `player/demo/*.log`（probe-*.log） | ~20 KB | 探针运行日志，含当次运行的时间/端口等临时信息 | 跑探针时会自动重新生成 |');
manifest.push('| `player/dist/.icon-ico/`、`*.blockmap` | — | 打包中间产物 | 重新打包自动生成 |');
manifest.push('| 工作区 `.workbuddy/` | — | 会话/记忆等编辑器内部数据，与项目无关，且可能含对话记录 | 不需要 |');
manifest.push('| 任何 `*.tmp` / `*.bad-*` / 缓存目录 | — | 临时文件与损坏文件留档 | 不需要 |');
manifest.push('');
manifest.push('**敏感信息**：包内**不含**任何真实账号凭证。');
manifest.push('- 网易云会话串（`MUSIC_U` 等）在应用里只出现在 `%APPDATA%\\NckiksMusic\\ne-auth.bin`，且经系统密钥库加密，**不在源码目录中**；');
manifest.push('- `player/demo/` 里出现的 `MUSIC_U=mock-*` / `expired-token` / `fake-session-for-test` 都是测试用的假值；');
manifest.push('- 没有任何硬编码的密码、API Key、证书或私钥。');
manifest.push('');
manifest.push('**没有数据库脚本**：本项目不使用任何数据库。');
manifest.push('- 运行时状态是三个 JSON/二进制文件，位于 `%APPDATA%\\NckiksMusic\\`：`library.json`（曲库）、`settings.json`（设置）、`ne-auth.bin`（加密凭证）；');
manifest.push('- 设计文档第 8 章给出的是「表结构式」的字段设计（`Track` / `Playlist` / `PlayState` / `Setting`），实际持久化就是 JSON 对象，不需要 SQL；');
manifest.push('- 换机器后这些文件不会自动跟着走：想带上曲库，把上述三个文件一起拷到新机器的同名目录即可（`ne-auth.bin` 受系统密钥库加密，**换机器/换用户后必然失效，需要重新扫码登录**）。');
manifest.push('');
manifest.push('## 5. 在新电脑上继续操作');
manifest.push('');
manifest.push('### 5.1 环境要求');
manifest.push('');
manifest.push('| 项 | 要求 |');
manifest.push('| --- | --- |');
manifest.push('| 操作系统 | Windows 10 / 11 x64（本项目只在 Windows 上验证过；Electron 本身跨平台，但窗口按钮、全局快捷键、`setSinkId` 行为需自行适配） |');
manifest.push('| Node.js | 18 或更高（开发验证用 22.22.2） |');
manifest.push('| npm | 随 Node 安装（验证用 10.x） |');
manifest.push('| 网络 | 首次 `npm ci` 需要；在线音源功能需要能访问 `music.163.com` |');
manifest.push('| 磁盘 | 依赖约 360 MB，构建产物再约 370 MB |');
manifest.push('');
manifest.push('### 5.2 跑起来（源码模式）');
manifest.push('');
manifest.push('```bash');
manifest.push('cd player');
manifest.push('npm ci                 # 严格按 package-lock.json 还原依赖（首次）');
manifest.push('npm start              # 开发运行');
manifest.push('# 或双击根目录 / player 目录里的 启动播放器.bat');
manifest.push('```');
manifest.push('');
manifest.push('> 如果终端里预设了 `ELECTRON_RUN_AS_NODE=1`，Electron 会退化成纯 Node、窗口不出现。启动前清掉：cmd 用 `set "ELECTRON_RUN_AS_NODE="`，bash 用 `env -u ELECTRON_RUN_AS_NODE npm start`。两个 `.bat` 已经内置了这一行。');
manifest.push('');
manifest.push('### 5.3 出安装包');
manifest.push('');
manifest.push('```bash');
manifest.push('cd player');
manifest.push('npm run dist           # 先 make-icon.js 生成图标，再 electron-builder 出 NSIS 安装包');
manifest.push('npm run pack           # 只要免安装目录 dist/win-unpacked');
manifest.push('```');
manifest.push('');
manifest.push('产物在 `player/dist/`。未配置代码签名证书，安装时会提示「未知发布者」，属正常现象。');
manifest.push('');
manifest.push('### 5.4 跑验证探针');
manifest.push('');
manifest.push('```bash');
manifest.push('cd player');
manifest.push('node demo/probe-myplaylists.js          # 纯 Node + 本地 mock，30 项');
manifest.push('node make-demo.js                       # 先补回示例素材 demo.wav/demo.png/demo.lrc');
manifest.push('# 以下用 Electron 驱动真实 DOM（--user-data-dir 隔离，不碰你的真实配置）');
manifest.push('npx electron demo/probe-home.js         # 50 项');
manifest.push('npx electron demo/probe-quality-ui.js   # 39 项');
manifest.push('npx electron demo/probe-edge.js         # 19 项');
manifest.push('npx electron demo/probe-brand.js        # 14 项');
manifest.push('npx electron demo/probe-login.js        # 扫码登录链路');
manifest.push('npx electron demo/probe-login2.js       # 二维码轮询生命周期');
manifest.push('```');
manifest.push('');
manifest.push('探针结果写在 `demo/probe-*.log`（不进包，重跑会覆盖）。');
manifest.push('');
manifest.push('### 5.5 环境变量');
manifest.push('');
manifest.push('见 `player/ENV.example`。要点：`NE_BASE` 可把音源指到别处；`NCKIK_SKIP_MIGRATION=1` 让测试跳过旧数据迁移；`SHOT*` 是截图模式。**项目不读 `.env` 文件**，这些变量需要显式在环境里设置。');
manifest.push('');
manifest.push('### 5.6 数据目录');
manifest.push('');
manifest.push('`%APPDATA%\\NckiksMusic\\`（安装版与源码运行共用同一目录）。改名/升级时，若该目录还没有 `library.json` 与 `settings.json`，启动会自动从旧目录（`云音乐` / `yun-music-player`）迁移曲库、设置和加密凭证——有数据才迁、绝不覆盖。');
manifest.push('');
manifest.push('## 6. 想先读什么');
manifest.push('');
manifest.push('1. `player/README.md` —— 能力清单、未实现项及原因、各版本变更；');
manifest.push('2. `音乐播放器设计方案.md` —— 设计决策与取舍（含音源契约、歌词时间轴、打包策略）；');
manifest.push('3. `player/main.js` 顶部注释 + `player/netease.js` 顶部注释 —— 主进程与音源层的职责边界；');
manifest.push('4. `音乐播放器代码审查报告.md` —— 已知问题与历史判断。');
manifest.push('');

fs.writeFileSync(path.join(stage, '文件清单与排除说明.md'), manifest.join('\n'), 'utf8');

/* ---------------- 写 ZIP ---------------- */
const entries = [];
const walkStage = (dir) => {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) { walkStage(abs); continue; }
    const rel = path.relative(stage, abs).replace(/\\/g, '/');
    entries.push({ name: pkgName + '/' + rel, data: fs.readFileSync(abs), mtime: fs.statSync(abs).mtimeMs });
  }
};
walkStage(stage);
entries.sort((a, b) => (a.name < b.name ? -1 : 1));

const zipPath = path.join(OUT_DIR, pkgName + '.zip');
writeZip(zipPath, entries);

// 暂存目录用完即删：zip 里已经有全部内容，留着只是双份占用
fs.rmSync(stage, { recursive: true, force: true });

const zipSize = fs.statSync(zipPath).size;
console.log('');
console.log('包名   :', path.basename(zipPath));
console.log('位置   :', zipPath);
console.log('文件数 :', entries.length, '（含清单）');
console.log('解压后 :', (totalBytes / 1048576).toFixed(1), 'MB');
console.log('压缩后 :', (zipSize / 1048576).toFixed(1), 'MB');
console.log('SHA256 :', sha256(fs.readFileSync(zipPath)));
if (missing.length) console.log('缺失（已跳过）:', missing.join(', '));
