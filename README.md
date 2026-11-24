# Nckik′s music 工程说明（源码版 v1.0.1）

这是一个 **Electron 桌面音乐播放器**：左侧封面 + 右侧逐字歌词 + 单个播放列表，支持本地文件与网易云音乐 / QQ 音乐 / 哔哩哔哩 / 酷狗（登录入口暂时下线）四个在线来源，并内置 Windows 任务栏缩略图控播、任务栏进度条、系统托盘、紧凑迷你模式、桌面悬浮歌词、自定义缓存目录与 GitHub 应用内自动检查更新。

本说明面向「把这套源码拿到另一台电脑上继续开发」的场景，按顺序照做即可跑起来；**只想装来听歌**的读者可以直接跳到文末的[用户使用说明附录](#附录用户使用说明v101)。

---

## 1. 环境要求

| 依赖 | 版本要求 | 说明 |
| --- | --- | --- |
| Windows | 10 / 11 x64 | 本项目只在 Windows 上验证过 |
| Node.js | **20 LTS 或更高**（开发机为 24.11） | 内置 npm，用来装依赖、编译、打包 |
| Python | 3.8+（开发机 3.12） | **只有重新生成图标时才需要**（`player/tools/make-ico.py`） |
| PowerShell | 5.1+ | 仓库自带的启动/打包脚本是 `.ps1` |
| Git | 任意 | 可选，但强烈建议（下文有克隆方式） |

不需要全局安装 Electron：依赖装在工程里，用 `npx` 或 `node_modules\electron\dist\electron.exe` 调用。

---

## 2. 三分钟跑起来

```powershell
# 1) 进入工程目录（这里解压出来的目录名以实际为准）
cd NckiksMusic-src-0.9.4\player

# 2) 安装依赖（约 390 MB，首次 2–5 分钟）
npm ci

# 3) 编译账号模块（TypeScript；产物在 accounts\dist，已随包附带一份，改代码后必须重编）
npx tsc -p tsconfig.accounts.json

# 4) 启动
npx electron .
```

> 也可以回到解压目录，右键 `启动开发版.ps1` →「使用 PowerShell 运行」，它会带好环境变量直接启动（见第 6 节的两个坑）。

启动后应该看到一个无边框窗口：左侧封面、右侧歌词、底部进度条与控制按钮。

---

## 3. 在本机验证「原有功能没被改坏」

仓库自带一批 Electron 探针（`player/demo/probe-*.js`），它们会启动真实主进程、点真实按钮、断言 DOM 与主进程返回。

```powershell
cd NckiksMusic-src-0.9.4\player

# 逐个跑（每个 5–20 秒）
npx electron --no-sandbox demo\probe-home.js
npx electron --no-sandbox demo\probe-playlist.js
npx electron --no-sandbox demo\probe-playmode.js
npx electron --no-sandbox demo\probe-brand.js
npx electron --no-sandbox demo\probe-edge.js
npx electron --no-sandbox demo\probe-quality-ui.js
npx electron --no-sandbox demo\probe-lyric.js
npx electron --no-sandbox demo\probe-thumbar.js
npx electron --no-sandbox demo\probe-updater.js
npx electron --no-sandbox demo\probe-p0.js
npx electron --no-sandbox demo\probe-p1.js
npx electron --no-sandbox demo\probe-p2.js
npx electron --no-sandbox demo\probe-bil.js        # 哔哩哔哩，需要登录态，否则部分断言跳过

# 账号层单元测试（纯 Node，不需要 Electron）
node tools\test-accounts.mjs
```

v1.0.1 的基线：`playmode 48/48`、`brand 15/15`、`edge 19/19`、`quality-ui 39/39`、`playlist 53/53`、`lyric 46/46`、`thumbar 22/22`、`updater 20/20`、`p0 16/16`、`p1 22/22`、`p2 19/19`、`home 50/50`、`test-accounts 76/76`。探针会把截图写到 `player\screenshots\`（目录不存在时会自己创建），失败项的详情打印在控制台。
跑之前请先确认没有残留的 electron 进程，否则会出现「窗口数不对」的假失败；也不要连着秒跑两个探针（音频设备与单实例锁会互相干扰，表现为偶发的 50/53 假失败），中间隔 2–3 秒。

`启动开发版.ps1 -Probe all` 可以一次跑完整批（脚本里维护着探针清单），加上 `-ExecutionPolicy Bypass` 才能在受限环境下执行。

---

## 4. 目录结构

```
NckiksMusic-src-0.9.4\
├─ player\                      ← 应用本体（所有运行时代码都在这里）
│  ├─ main.js                  主进程：窗口、协议注册、IPC、自定义缓存目录、单实例
│  ├─ storage.js               持久化与缓存目录统计/清理（同步/异步串行原子落盘）
│  ├─ thumbar.js               Windows 任务栏缩略图三键与任务栏播放进度条
│  ├─ tray.js                  系统托盘图标与动态右键菜单
│  ├─ desktop-lyric.js         桌面悬浮歌词独立透明置顶窗口（含鼠标穿透锁定）
│  ├─ updater.js               GitHub Releases 自动检查更新与播放器内下载安装
│  ├─ preload.js               contextBridge，把 window.api 暴露给渲染层
│  ├─ netease.js               网易云：登录、搜索、歌单、歌词、取流
│  ├─ bilibili.js              哔哩哔哩：WBI 签名、搜索、收藏夹、取流
│  ├─ bilibili-qr.js           哔哩哔哩扫码（官方登录页 + 隐藏窗口读 cookie）
│  ├─ upstream-library.js      QQ 音乐 / 酷狗：歌单、曲目、搜索、推荐
│  ├─ upstream-meta.js          上游曲目的封面 / 歌词 / 翻译
│  ├─ stream-resolve.js        上游取流：vkey、酷狗签名、合规上游网关
│  ├─ renderer\                渲染层（无框架，原生 JS）
│  │  ├─ index.html
│  │  ├─ desktop-lyric.html    桌面悬浮歌词窗口页面
│  │  ├─ app.css               全部样式（含主题变量、歌词排版、迷你模式、省电动效）
│  │  ├─ app.js                主界面逻辑：播放、队列、曲库、歌词、设置、更新与缓存
│  │  ├─ p2.js                 P2 扩展逻辑：迷你模式、桌面歌词同步、睡眠定时、托盘与任务栏进度
│  │  └─ accpanel.js           设置页「播放账号」两张卡（QQ 音乐 App / 酷狗）
│  ├─ accounts\                账号抽象层（TypeScript 源码 + 编译产物）
│  │  ├─ src\                  types / errors / credentialStore / loginSession /
│  │  │                        stream / accountManager / providers{qq,kugou,qqapp} /
│  │  │                        mqtt / wsConnect / ipcContract / electronHost / index
│  │  ├─ renderer\accountPanel.ts
│  │  └─ dist\                 tsc 编译产物（运行时 require 这里）
│  ├─ assets\                  苹方 WOFF2 字体（5.1 MB）、任务栏缩略图深浅色图标
│  ├─ build\                   打包用图标：icon.ico（16/32/48/256）、icon.png（512）
│  ├─ tools\make-ico.py        重新生成应用图标
│  ├─ tools\make-thumbar-icons.py 重新生成任务栏缩略图三键图标
│  ├─ tools\test-accounts.mjs  账号层单测
│  ├─ ENV.example              环境变量参考（开发者开关，不读 .env）
│  ├─ demo\                    探针脚本（probe-*.js）与一次性诊断脚本
│  ├─ package.json             脚本、electron-builder 配置、依赖
│  └─ tsconfig.accounts.json   accounts 模块的编译配置
├─ tools\                      早期一次性探测脚本（QQ/酷狗接口调研）
├─ 启动开发版.ps1              开发启动器（含探针参数）
├─ 启动播放器.bat              旧启动器（保留）
├─ 开发说明.md                 最早一版开发环境说明（历史记录）
├─ 音乐播放器设计方案.md        主线设计文档 + 各版本变更记录（§14 起）
├─ player\QQ与酷狗扫码登录-实现方案.md   账号 / 扫码 / 取流 / 上游网关的实现细节
├─ NckiksMusic-用户说明-v1.0.1.docx     面向最终用户的说明书
└─ music-player-prototype.html          最早的静态原型（参考用，不参与构建）
```

**没有打进包里的东西**（都在 `.gitignore` 里，需要时重新生成）：

| 目录/文件 | 为什么不打 | 怎么恢复 |
| --- | --- | --- |
| `player\node_modules\` | 390 MB，`npm ci` 可复现 | `cd player; npm ci` |
| `player\dist\` | 625 MB，安装包产物 | `npx electron-builder --win --x64` |
| `player\screenshots\` | 11 MB，探针跑的截图 | 跑探针会重新生成 |
| `player\demo\shot-*.png` | 探针截图 | 跑探针会重新生成 |
| — | 演示素材 `demo\demo.wav`、`demo.png`、`demo.lrc` **已随包附带**（探针依赖它们） | 需要重建时 `node demo\make-demo.js` |
| `.tmp\` | 本机临时诊断产物 | 无需恢复 |

---

## 5. 改代码时最常碰到的地方

| 想改的东西 | 位置 |
| --- | --- |
| 窗口尺寸 / 无边框 / 标题栏按钮 | `player/main.js` 的 `createWindow()`，样式在 `renderer/app.css` 的 `.titlebar` |
| 歌词排版（字号、行距、逐字进度、间奏「…」） | `renderer/app.css` 的 `.lyr / .ln / .ch / .gap-*`；逻辑在 `app.js` 的 `renderLyric / updateLyric` |
| 播放队列、切歌、随机 / 单曲 / 顺序 | `renderer/app.js` 的 `S.q / playAt / stepIndex / shufNext` |
| 播放列表面板（左下按钮打开的那个） | `app.js` 的 `renderPl / plSources / plSelectSource`，样式 `.pop-pl` |
| 曲库抽屉（本地 / 网易云 / 哔哩哔哩 / QQ / 酷狗） | `app.js` 的 `setSource / renderLibrary / renderNet / renderBil / renderUp` |
| 设置页 | `renderer/index.html` 的 `#dSet` + `app.js` 的 `openDrawer / paintSettings` |
| 账号卡片（QQ 音乐 App 扫码、酷狗敬请期待） | `renderer/accpanel.js` + `accounts/src/providers/*` |
| QQ 音乐 / 酷狗接口 | `player/upstream-library.js`、`upstream-meta.js`、`stream-resolve.js` |
| 新增一个在线音源 | 参照 `bilibili.js`：实现 `status/search/playlist/track/lyric`，在 `main.js` 注册 IPC 与自定义协议，再到 `app.js` 的 `setSource` 加一段 |

约定：IPC 通道名统一 `<平台>:<动作>`（`ne:` / `bil:` / `kg:` / `acc:` / `idn:`），返回 `{ ok: true, ... }` 或 `{ ok: false, error: { code, message } }`。渲染层只通过 `window.api.*` 调主进程，不直接 `require`。

---

## 6. 两个必踩的环境坑（Windows 特有）

1. **`ELECTRON_RUN_AS_NODE=1`**
   如果当前 shell 里有这个环境变量，Electron 会退化成纯 Node，启动时会报 `bad option: --no-sandbox` 然后直接退出、不出窗口。
   → 启动前执行：`Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue`

2. **受限令牌下 Chromium 沙箱起不来**
   某些账户策略下裸启动会崩在 `IsSandboxedProcess`（`EXCEPTION_BREAKPOINT`）。
   → 开发与探针一律加 `--no-sandbox`（`启动开发版.ps1` 已内置）。

另外：如果 `%TEMP%` 不可写，把 `TMP` / `TEMP` 指到工程内的 `.tmp` 目录再启动，否则 Chromium 会启动失败。

---

## 7. 构建与打包

```powershell
cd NckiksMusic-src-0.9.4\player

# 重新生成图标（白底正红 N，输出 16/32/48/256 的 .ico 与 512 的 .png）
python tools\make-ico.py

# 出安装包 + 免安装版（产物在 player\dist）
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'    # 没有签名证书时必须关掉自动查找
npx electron-builder --win --x64
```

产物：

- `dist\NckiksMusic-Setup-<version>.exe` —— NSIS 安装包（默认装到 `%LOCALAPPDATA%\Programs\nckiks-music`，创建桌面与开始菜单快捷方式）
- `dist\NckiksMusic-Portable-<version>.exe` —— 免安装单文件
- `dist\win-unpacked\` —— 解包目录，排查打包问题最快

> **产品名只能用 ASCII 撇号**：`package.json` 的 `productName` 曾是 `Nckik′s music`（U+2032），NSIS 写 `Uninstall <name>.exe` 时会失败，安装到一半报「无法关闭」/「不能打开要写入的文件」。v0.9.4 起改为 `Nckik's music`，界面标题仍显示 ′ 品牌写法。改版本号时同时改 `version`，探针 `probe-brand` 会按它去找安装包。

---

## 8. 运行时数据在哪

| 路径 | 内容 |
| --- | --- |
| `%APPDATA%\NckiksMusic\settings.json` | 主题、音量、播放列表、歌词偏移、托盘与外观偏好、上游网关配置 |
| `%APPDATA%\NckiksMusic\playpos.json` | 播放期间高频保存的当前曲目与进度锚点（独立小文件） |
| `%APPDATA%\NckiksMusic\cache-config.json` | 自定义软件缓存保存位置配置 |
| `%APPDATA%\NckiksMusic\Cache\`（或自定义目录） | Chromium 网络/媒体缓存（`http/`）与更新安装包（`updates/`） |
| `%APPDATA%\NckiksMusic\library.json` | 本地曲库索引 |
| `%APPDATA%\NckiksMusic\accounts.bin` | 账号列表（safeStorage 加密后的凭据） |
| `%APPDATA%\NckiksMusic\identity.json` | 当前选中的音源账号 |
| `%APPDATA%\NckiksMusic\crash.log`、`thumbar.log`、`*.log` | 崩溃与功能诊断日志 |
| `%APPDATA%\NckiksMusic\Partitions\<name>\` | 各平台登录用的独立会话（cookie 在这里） |

调试时可以直接删掉整个 `NckiksMusic` 目录回到「全新安装」状态；注意这会丢掉登录态与播放列表。

---

## 9. 在线音源的前提

| 来源 | 登录方式 | 取流 |
| --- | --- | --- |
| 网易云音乐 | 扫码（官方网页登录页） | 官方接口，部分曲目受版权/会员限制 |
| QQ 音乐 | **手机 QQ 音乐 App 扫一扫**（`CreateQRCode` + MQTT 推送 + `Login` 换 musickey） | 自己实现 vkey 取流，非会员曲可播 |
| 哔哩哔哩 | 手机 B 站扫码（官方登录页） | `playurl` 的 dash 音频轨 |
| 酷狗音乐 | 登录入口暂时下线（「敬请期待」） | 免费曲仍可播 |

**VIP 曲目**：酷狗与 QQ 音乐的会员曲目需要平台侧权益，本项目不绕签名，也不伪造行为指纹。酷狗若要播会员曲，走「合规上游网关」：在设置 → 播放账号 → 酷狗卡片里填网关地址（例如自建的 `KuGouMusicApi`），主进程会先问网关、失败再退回免费链路。

---

## 10. 常见问题

**Q：`npm ci` 很慢或失败？**
换国内镜像：`npm config set registry https://registry.npmmirror.com`，再重试。Electron 二进制下载慢时可以设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。

**Q：启动后窗口一片空白？**
打开开发者工具（`Ctrl+Shift+I`）看渲染层报错；常见原因是 `accounts\dist` 没编译（主进程会打印 `[acc] 账号模块未启用`）。跑一次 `npx tsc -p tsconfig.accounts.json`。

**Q：改了 `accounts\src` 的 TS，为什么不生效？**
运行时加载的是 `accounts\dist`。每次改完都要 `npx tsc -p tsconfig.accounts.json` 重新编译。

**Q：探针报「窗口数不对」/ 一直卡住？**
先 `Get-Process electron | Stop-Process -Force` 清干净，再单独跑一个探针；探针之间会互相干扰。

**Q：双击 `启动开发版.ps1` 报 AuthorizationManager check failed？**
用 `powershell -ExecutionPolicy Bypass -File .\启动开发版.ps1`。

**Q：想从 git 历史恢复某个版本？**
工程根目录带完整 `.git`，`git log --oneline` 能看到从 0.4.1 到 0.9.4 的每一步（提交信息里有原因与验证）。回滚某个文件：`git checkout <commit> -- player/main.js`。

---

## 11. 版本与文档索引

| 文档 | 内容 |
| --- | --- |
| `音乐播放器设计方案.md` | 主线设计文档，§14 起是逐版本的「现象 / 根因 / 改动 / 验证 / 提交号」记录，改功能前先在这里补一节 |
| `player\QQ与酷狗扫码登录-实现方案.md` | 账号抽象、扫码协议、取流、上游网关的完整说明（§1–§32） |
| `player\README.md` | 应用自身的说明（偏历史，早期版本） |
| `开发说明.md` | 最初的开发环境与排障记录 |
| `NckiksMusic-用户说明-v1.0.1.docx` | 面向最终用户的操作说明（同一份内容也贴在本文末尾的[附录](#附录用户使用说明v101)） |
| `docs/manual/` | 上表 docx 里的插图（从 docx 导出、压到 1280px 宽），README 附录直接引用 |

当前版本 **1.0.1**（`player\package.json` 的 `version`，界面设置页显示同一个值）。

---

## 附录：用户使用说明（v1.0.1）

> 与仓库里的 [NckiksMusic-用户说明-v1.0.1.docx](NckiksMusic-用户说明-v1.0.1.docx) 同源；图片已导出到 [docs/manual/](docs/manual/)，可在网页上直接看。

版本 1.0.1 | Windows 10 / 11（64 位） | 本地音乐播放器 + 在线音源
适用对象：在自己电脑上听本地音乐、同时会用网易云音乐 / QQ 音乐 / 哔哩哔哩账号的普通用户。

### 1 软件简介与适用场景

#### 1.1 这是什么

Nckik′s music 是一个 Windows 桌面音乐播放器。它一边播放你电脑里的音乐文件，一边可以登录常用的音乐平台账号，把歌单、收藏夹和在线曲目放到同一个播放列表里播放。
- 本地播放：直接把 MP3 / FLAC / WAV / M4A / OGG 拖进窗口即可播放，自动读取内嵌封面与歌词，同目录的 `.lrc` 也会自动加载；超过 500 首本地曲目时自动启用虚拟滚动，数千首曲库依然流畅。
- 在线音源：网易云音乐、QQ 音乐、酷狗音乐、哔哩哔哩四个来源，可以在曲库里切换查看；顺序播放接近曲末时会自动静默预取下一首，切歌更顺畅。
- 歌词体验：逐字滚动、点击任意歌词跳转、悬停歌词区微调单曲时间偏移（±0.5s）、间隔超过 3 秒显示「…」并带慢速舒缓放大缩小呼吸动画，支持外文译文双语显示与独立桌面悬浮歌词。
- 桌面控播与轻形态：支持 Windows 任务栏悬停缩略图三键（上一首 / 播放·暂停 / 下一首）、任务栏播放进度条、系统托盘与关闭到托盘、紧凑迷你模式（快捷键 `M`）以及应用内自动检查更新。
- 播放列表：整个软件只有一个播放列表，所有来源的歌都汇总到这里，按你的顺序播、随机播或单曲循环。

#### 1.2 适合谁用

- 电脑里有大量本地音乐，想要一个不花哨、启动快、歌词好看的播放器。
- 平时用网易云 / QQ 音乐 / 哔哩哔哩听歌，希望把几个平台的歌单放到一个列表里连着放。
- 想把桌面播放器当成日常背景音乐，用快捷键、任务栏缩略图或迷你浮窗随时控播、看歌词。

不适合的场景：需要下载音乐文件、需要多设备同步、需要在线听会员曲库以外的付费内容。

![图 1 启动后的主界面](docs/manual/fig1.jpg)

### 2 安装与卸载

#### 2.1 用安装包安装（推荐）

1. 直接双击 `NckiksMusic-Setup-1.0.1.exe` 运行（**无需管理员权限**，建议以普通权限运行以免影响任务栏缩略图快捷按钮）。
1. 如果 Windows 弹出「SmartScreen 已保护你的电脑」，点「更多信息」→「仍要运行」。（安装包未做代码签名，属正常提示。）
1. 按向导默认选项一路「下一步」，选择安装位置后点「安装」。
1. 安装完成后，桌面和开始菜单会出现「Nckik′s music」图标；勾选「运行」即可直接打开。

说明：默认安装到当前用户目录，不需要管理员权限，也不会修改系统设置。安装完成后可在「设置 → 关于」直接在线检查并更新到后续新版本。

#### 2.2 免安装版

1. 把 `NckiksMusic-Portable-1.0.1.exe` 放到任意文件夹（建议单独建一个目录，例如 `D:\Tools\NckiksMusic`）。
1. 双击运行，无需安装；首次启动会在同目录创建临时文件。
1. 想卸载时直接删除该 exe 即可。

#### 2.3 卸载

1. 打开「设置 → 应用 → 已安装的应用」，找到 Nckik′s music，点「卸载」。
1. 或者从开始菜单「Nckik′s music」文件夹里运行「Uninstall Nckik′s music」。
1. 按提示确认卸载。卸载只删除程序文件。

如果希望连账号登录状态、播放列表一起清干净：卸载后手动删除 `%APPDATA%\NckiksMusic` 目录（在资源管理器地址栏粘贴该路径即可）；若更改过缓存保存位置，也一并删除自定义缓存目录。

![图 2 安装向导与桌面快捷方式](docs/manual/fig2.jpg)
*图 2 安装向导与桌面快捷方式*

### 3 界面与主要功能

#### 3.1 主界面与迷你模式

- 左侧大图：当前歌曲封面；没有封面时显示首字母占位。
- 右侧歌词：当前句高亮、逐字推进，上下是前后句；**点击任意一句歌词可直接跳转**到该句时间；鼠标悬停在歌词区时，右下角浮出 `−0.5s / 0.0s / +0.5s` 歌词微调条（按曲目自动记忆）。两句歌词间隔超过 3 秒时，句尾会出现带缓慢放大缩小呼吸动画的「…」。
- 底部：进度条（两端常驻显示当前时间与总时长）+ 左下角播放列表入口（带数字角标）+ 中间控制按钮（播放模式 / 上一首 / 播放暂停 / 下一首）+ 右下角音量、音质信息与输出设备按钮。
- 右上角：从左到右依次为「当前账号」头像、设置齿轮（发现新版本时带提醒红点）、**迷你模式**、全屏、最小化、最大化与关闭按钮。
- 迷你模式：点击标题栏迷你模式按钮或按 `M` 键，可将主窗口收起为紧凑置顶小浮窗（含封面、歌名/当前句歌词、控播三键与底边进度条），再次点还原键或封面即可恢复主窗口。
- 任务栏控播：后台播放或最小化时，将鼠标悬停在 Windows 任务栏图标上，预览小窗下方可直接点击「上一首 / 播放·暂停 / 下一首」，同时任务栏图标可直观展示播放进度与暂停态。

![图 3 主界面各区域标注](docs/manual/fig3.jpg)

#### 3.2 窗口内与全局快捷键

- 空格：播放 / 暂停（带 110ms 平滑淡入淡出）；← →：快退 / 快进 5 秒
- L：显示 / 隐藏歌词；M：切换 / 退出迷你模式；R：切换播放模式；F11：全屏 / 退出全屏
- 双击标题栏：最大化 / 还原；Esc：退出全屏或关闭抽屉/弹层
- Ctrl + O：导入本地文件；把文件或文件夹拖进窗口同样可以
- Ctrl + Alt + P：全局播放 / 暂停（其他窗口聚焦时也生效）
- Ctrl + Alt + ← →：全局上一首 / 下一首；Ctrl + Alt + ↑ ↓：全局音量微调

全局快捷键可在「设置 → 快捷键」里开关；若提示「键位冲突」，说明被其他程序占用。

#### 3.3 播放列表

点底部左侧的列表按钮（带数字角标）打开。所有来源的歌曲都汇总在这里，列表本身支持虚拟滚动、可以无限长。
- 点条目即播放；↑ ↓ 调整顺序；× 只从列表移除，不影响来源歌单。
- 「选择歌单」：从当前账号的歌单里整单替换进来。
- 「插入歌曲」：从曲库挑单曲追加到列表末尾，重复的会自动跳过。
- 播放键左侧的按钮切换播放模式：顺序 → 单曲循环 → 随机。

![图 4 播放列表面板](docs/manual/fig4.jpg)

#### 3.4 曲库与账号

点右上角「当前账号」的头像，点击或右键会展开账号面板，可以在网易云音乐、QQ 音乐、哔哩哔哩之间切换；切换后，曲库和「选择歌单」只显示这个账号的内容。
- 本地：导入文件 / 文件夹，支持在已导入的曲库里快速搜索（超过 500 首自动切换虚拟滚动）。
- 网易云音乐：扫码登录后可看每日推荐、推荐歌单、我创建的歌单。
- QQ 音乐：用手机 QQ 音乐 App 的「扫一扫」扫描窗口里的二维码登录（官方登录通道）。
- 哔哩哔哩：扫码登录后可读收藏夹，搜索按视频粒度返回。
- 酷狗音乐：登录功能显示「敬请期待」，曲库中的免费曲目仍可试听。

![图 5 账号下拉与曲库四段](docs/manual/fig5.jpg)

![图 6 设置页与常见提示](docs/manual/fig6.jpg)

#### 3.5 设置

设置抽屉顶部自带吸顶分组导航（**外观 / 账号 / 播放 / 缓存 / 更新**），可一键定位到对应分组：
- 外观：夜间 / 日间 / 自动（按经纬度算日出日落）、封面取色（自动保底前景与背景双边对比度）、**省电 / 低动效模式**（关闭非当前句模糊与大半径玻璃滤镜，降低集显与高分屏 GPU 占用）。
- 账号与音频输出：管理网易云 / 哔哩哔哩 / QQ 音乐 / 酷狗登录态与音频输出设备。
- 播放：
  - 歌词翻译开关（有译文的外文歌在原文下方显示中文）。
  - **桌面悬浮歌词**开关与**锁定桌面歌词穿透**开关（独立透明置顶窗口，后台办公/游戏时实时显示逐字进度；锁定后鼠标穿透不遮挡下方操作，可在设置或托盘菜单解锁）。
  - **任务栏播放进度**开关（控制 Windows 任务栏图标是否显示进度条）。
  - **点击关闭按钮行为**：可选「退出」或「托盘」（选「托盘」时点关闭隐藏到系统托盘，右键托盘可随时控播、切迷你模式/桌面歌词或彻底退出；点最小化仍留在任务栏以使用缩略图三键）。
  - **睡眠定时**：直接在设置内选择「关闭 / 播完当前曲 / 15分 / 30分 / 45分 / 60分」，到时平滑淡出并暂停。
- **存储与缓存**：自由更改软件缓存保存位置（存放音频网络缓存与更新安装包），实时查看占用体积，支持一键打开目录、清理缓存或恢复默认位置。
- **关于与检查更新**：显示当前版本号，支持「自动检查更新」开关，以及一键检查 GitHub 仓库（`AA1IMB/Nckik-music`）最新版本并在播放器内直接下载与安装更新。

### 4 常见问题与排查

#### 4.1 双击没反应 / 一闪而过

1. 先看窗口是否被最小化到后台，或已隐藏在右下角系统托盘图标里。
1. 如果确实没有任何窗口：打开 `%APPDATA%\NckiksMusic\crash.log`，把最后几十行发给开发者。
1. 用免安装版复测一次，排除安装目录权限问题。

#### 4.2 没有声音

1. 确认底部进度条在走、按钮显示为「暂停」图标。
1. 点右下角喇叭图标，检查是否静音或音量过低。
1. 「设置 → 音频输出」里换一个输出设备（插拔耳机后尤其常见）。

#### 4.3 封面 / 歌词不显示

- 本地文件：确认歌曲文件里确实带封面；或把同名 `cover.jpg` / 同名 `.lrc` 放在歌曲旁边。
- 在线曲目：部分歌曲上游本身不提供封面或歌词，界面会显示「暂无封面」「这首歌上游没有提供歌词」。
- 若歌词整体偏快或偏慢，将鼠标移至歌词区右下角，点击 `−0.5s` / `+0.5s` 微调并自动为该曲记忆。
- 网络不稳时封面可能延迟出现，切下一首再切回来即可重试。

#### 4.4 QQ 音乐登录

1. 点「QQ 音乐」卡片上的「扫码登录」，窗口里会出现二维码。
1. 用手机 QQ 音乐 App →「我的」→ 右上角「扫一扫」，扫描后在手机上确认。
1. 确认成功后，卡片会显示昵称；若一直停在「请扫码」，点「重新获取」换一张二维码再扫。

#### 4.5 提示「键位冲突」

说明该全局快捷键已被其他程序占用（常见于输入法、录屏软件）。到「设置 → 快捷键」关掉全局快捷键，或在与冲突软件之间二选一。

#### 4.6 安装时提示「无法关闭」或「不能打开要写入的文件」

这是 0.9.3 及更早版本的安装包在中文系统上的问题（产品名里用了特殊字符，安装程序写卸载文件时失败），0.9.4 起已修复。处理办法：

1. 点「中止(A)」退出当前安装，不要点「忽略」，否则会缺卸载文件。
1. 改用本说明对应的 1.0.1 安装包（`NckiksMusic-Setup-1.0.1.exe`）。
1. 如果之前装到一半留下了空目录，可以手动删除后再装。

#### 4.7 歌曲点了没反应

- 该曲目可能已失效（在线曲目链接过期、本地文件被移动或删除）。
- 程序会自动跳到下一首可播放的曲目；如果整张列表都失效，请更换歌单或重新导入文件。
- 如果是酷狗音乐的会员曲目，界面会提示需要会员权益。

#### 4.8 任务栏缩略图按钮点击无响应

- 若播放器以「管理员身份运行」，Windows 安全机制（UIPI）会拦截普通权限任务栏发出的按钮点击消息。此时「设置 → 播放」会出现「权限提醒（已提权）」，请退出后改用普通权限直接启动播放器即可恢复。

### 5 版本信息与反馈渠道

#### 5.1 当前版本

- 软件版本：1.0.1
- 发布形式：安装包（`NckiksMusic-Setup-1.0.1.exe`，88.7 MB）+ 免安装版（`NckiksMusic-Portable-1.0.1.exe`，81.8 MB）
- 支持系统：Windows 10 / 11，64 位
- 数据目录：`%APPDATA%\NckiksMusic`（设置、曲库、登录凭据、日志；缓存目录可在设置中自由指定）

升级方式：在「设置 → 关于」直接点击「检查更新」→「下载更新」→「立即安装」即可自动覆盖升级，播放列表与登录状态会保留；也可手动运行新版安装包或替换免安装版 exe。

#### 5.2 本版主要变化（v0.9.4 → v1.0.1）

- **任务栏缩略图控播与进度条**：后台/最小化悬停任务栏图标可直接点击上一首、播放/暂停、下一首（自动适配深浅色任务栏），并支持任务栏播放进度显示。
- **播放器内自动检查与更新**：对接 GitHub 仓库 `AA1IMB/Nckik-music`，支持启动自动检查、手动检查、流式下载进度条与一键启动安装。
- **自定义软件缓存保存位置**：在「设置 → 存储与缓存」中自由指定缓存目录、查看实时占用体积、打开目录、清理缓存或恢复默认。
- **歌词体验全面打磨**：修复同一句歌词按空格分割时空格后首字填充条偶发闪烁的问题；支持点击任意歌词跳转与单曲 ±0.5s 时间偏移微调；间隔超过 3 秒出现的「…」新增慢速舒缓放大缩小呼吸动画；设置内新增独立透明置顶桌面悬浮歌词（支持鼠标穿透锁定）。
- **桌面生态与效率优化（P0 / P1 / P2）**：新增系统托盘与关闭到托盘选项、紧凑迷你模式（快捷键 `M`）、设置内睡眠定时、省电低动效模式、设置页吸顶分组导航、进度条常驻起止时间、播停 110ms 平滑淡入淡出、顺序播放下一首静默预取、超大本地曲库（> 500 首）虚拟滚动、暂停/隐藏停跑 rAF 与异步独立进度落盘，并将苹方字体转为 WOFF2 压缩（体积缩减 51.4%）。

#### 5.3 如何反馈

遇到问题时，请尽量提供以下信息，便于快速定位：
- 软件版本（设置页「设置 → 关于」显示 `v1.0.1`）
- 问题现象与复现步骤（例如：点某歌单第 3 首，界面一直转圈）
- 截图或录屏
- 日志文件：`%APPDATA%\NckiksMusic\crash.log`（崩溃）与同目录下的 `thumbar.log` / `*.log`（功能日志）

#### 5.4 使用须知

- 在线音源经由各平台官方网页 / 客户端登录通道获取，账号权限（如会员曲）由平台决定，本软件不提供绕过。
- 请仅用于个人学习与日常听歌，不要用于商业分发或二次销售。
- 在线曲目的可用性会随平台调整而变化，若某个来源长期失效，建议先在设置里切换账号或改用本地文件。

—— 文档结束 ——
