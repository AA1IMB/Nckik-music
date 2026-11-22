# Nckik′s music 工程说明（源码版 v0.9.4）

这是一个 **Electron 桌面音乐播放器**：左侧封面 + 右侧逐字歌词 + 单个播放列表，支持本地文件与网易云音乐 / QQ 音乐 / 哔哩哔哩 / 酷狗（登录入口暂时下线）四个在线来源。

本说明面向「把这套源码拿到另一台电脑上继续开发」的场景，按顺序照做即可跑起来。

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
npx electron --no-sandbox demo\probe-bil.js        # 哔哩哔哩，需要登录态，否则部分断言跳过

# 账号层单元测试（纯 Node，不需要 Electron）
node tools\test-accounts.mjs
```

v0.9.4 的基线：`playmode 48/48`、`brand 15/15`、`edge 19/19`、`quality-ui 39/39`、`playlist 53/53`、`home 50/50`、`test-accounts 76/76`。探针会把截图写到 `player\screenshots\`（目录不存在时会自己创建），失败项的详情打印在控制台。
跑之前请先确认没有残留的 electron 进程，否则会出现「窗口数不对」的假失败；也不要连着秒跑两个探针（音频设备与单实例锁会互相干扰，表现为偶发的 50/53 假失败），中间隔 2–3 秒。

`启动开发版.ps1 -Probe all` 可以一次跑完整批（脚本里维护着探针清单），加上 `-ExecutionPolicy Bypass` 才能在受限环境下执行。

---

## 4. 目录结构

```
NckiksMusic-src-0.9.4\
├─ player\                      ← 应用本体（所有运行时代码都在这里）
│  ├─ main.js                  主进程：窗口、协议注册、IPC、缓存、单实例
│  ├─ preload.js               contextBridge，把 window.api 暴露给渲染层
│  ├─ netease.js               网易云：登录、搜索、歌单、歌词、取流
│  ├─ bilibili.js              哔哩哔哩：WBI 签名、搜索、收藏夹、取流
│  ├─ bilibili-qr.js           哔哩哔哩扫码（官方登录页 + 隐藏窗口读 cookie）
│  ├─ upstream-library.js      QQ 音乐 / 酷狗：歌单、曲目、搜索、推荐
│  ├─ upstream-meta.js          上游曲目的封面 / 歌词 / 翻译
│  ├─ stream-resolve.js        上游取流：vkey、酷狗签名、合规上游网关
│  ├─ renderer\                渲染层（无框架，原生 JS）
│  │  ├─ index.html
│  │  ├─ app.css               全部样式（含主题变量、歌词排版）
│  │  ├─ app.js                主界面逻辑：播放、队列、曲库、歌词、设置
│  │  └─ accpanel.js           设置页「播放账号」两张卡（QQ 音乐 App / 酷狗）
│  ├─ accounts\                账号抽象层（TypeScript 源码 + 编译产物）
│  │  ├─ src\                  types / errors / credentialStore / loginSession /
│  │  │                        stream / accountManager / providers{qq,kugou,qqapp} /
│  │  │                        mqtt / wsConnect / ipcContract / electronHost / index
│  │  ├─ renderer\accountPanel.ts
│  │  └─ dist\                 tsc 编译产物（运行时 require 这里）
│  ├─ assets\                  字体、图标等静态资源（11 MB，必须保留）
│  ├─ build\                   打包用图标：icon.ico（16/32/48/256）、icon.png（512）
│  ├─ tools\make-ico.py        重新生成图标
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
├─ NckiksMusic-用户说明-v0.9.4.docx     面向最终用户的说明书
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
| `%APPDATA%\NckiksMusic\settings.json` | 主题、音量、播放列表、上游网关配置 |
| `%APPDATA%\NckiksMusic\library.json` | 本地曲库索引 |
| `%APPDATA%\NckiksMusic\accounts.bin` | 账号列表（safeStorage 加密后的凭据） |
| `%APPDATA%\NckiksMusic\identity.json` | 当前选中的音源账号 |
| `%APPDATA%\NckiksMusic\crash.log`、`*.log` | 崩溃与功能日志 |
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
| `NckiksMusic-用户说明-v0.9.4.docx` | 面向最终用户的操作说明 |

当前版本 **0.9.4**（`player\package.json` 的 `version`，界面设置页显示同一个值）。
