# QQ 音乐 / 酷狗音乐 扫码登录与多账号切换 —— 实现方案

> 参考对象：`folia-major`（commit `847bb51`，查阅日 2026-11-21）的登录与账号切换**结构与流程**。
> 本项目只借鉴分层与状态机，不复制其代码，也不引入任何签名算法或绕过手段；凭据一律走「官方登录页自己产生 → 我们只读」的路径，与既有 `player/bilibili-qr.js` 相同。

---

## 一、接入点清单（现有工程里可复用的位置）

| 关注点 | 现有位置 | 说明 |
| --- | --- | --- |
| 主进程入口 | `player/main.js` | 已有 8 个 `ne:*` / `bil:*` handler，新增 `acc:*` 与它们并列注册 |
| 预加载桥 | `player/preload.js` | `contextBridge.exposeInMainWorld('api', {...})` 平铺方法名，新增同类方法即可 |
| 加密落盘范例 | `player/main.js:439/450`（`readNeCookie`/`writeNeCookie`）、`:478/489`（`readBilCookie`/`writeBilCookie`） | `safeStorage` + 二进制文件；凭据层沿用同样思路，但改成单文件多账号 |
| 设置抽屉 | `player/renderer/index.html:195`（`#dSet`） | 账号面板挂在这里，与 `#neAuthState`(:222)、`#bilAuthState`(:245) 同层 |
| 二维码样式 | `player/renderer/index.html:253`（`#bilQrWrap` 的 `.qrbox/.qrimg/.qrmask`） | 复用同一套几何与遮罩，避免第三套视觉 |
| IPC 返回约定 | 全项目 | 成功 `{ok:true,...}`；失败 `{ok:false,error:{code,message}}`，本模块扩展了 `hint`/`retryAfterMs` |

## 二、新增文件（本方案已落地，可编译）

```
player/accounts/
├─ src/
│  ├─ types.ts            # 公共类型：ProviderId / QualityId / Credential / LoginSnapshot / 14 个错误码
│  ├─ errors.ts           # AccountError + providerError/qualityError/classifyUpstream/wrapUnknown
│  ├─ credentialStore.ts  # accounts.bin：账号明文 + 凭据 safeStorage 密文；tmp+rename；坏文件留档
│  ├─ loginSession.ts     # 扫码状态机（计时、过期、已扫码 60s、瞬时失败容忍、generation 作废旧结果）
│  ├─ stream.ts           # 取流降级引擎（逐档回退 / 限流立即停 / 无版权优先报）
│  ├─ accountManager.ts   # 登录、落盘、多账号、切换、取流缓存、事件
│  ├─ ipcContract.ts      # acc:* 通道名 + 载荷类型 + Ok/Fail
│  ├─ index.ts            # createAccountsModule / registerAccountsIpc（唯一装配点）
│  ├─ electronHost.ts     # 唯一依赖 electron 的适配层（safeStorage→Cipher、net→Transport、BrowserWindow→LoginWindowHost）
│  └─ providers/
│     ├─ base.ts          # PageLoginProvider：官方页 + 读 cookie + 校验；isUsableQr 要求 >=1500 字符
│     ├─ qq.ts            # QQ_CONFIG + QqProvider（qm_keyst/qqmusic_key 判断登录、gtk 由 p_skey 派生）
│     └─ kugou.ts         # KUGOU_CONFIG + KugouProvider（token/userid 必需）
├─ renderer/accountPanel.ts  # mountAccountPanel：二维码、轮询、账号列表、切换/退出
└─ dist/                  # tsc 产物（不入库或入库皆可，见「编译」）
player/tools/test-accounts.mjs  # 40 条自测（无 electron 依赖）
player/tsconfig.accounts.json   # strict + CommonJS + outDir accounts/dist
```

## 三、扫码链路与状态码

统一相位：`idle → starting → waiting → scanned → confirmed`，异常分支 `expired / failed / cancelled`。

| 平台 | 二维码来源 | 判定已登录 | 过期文案 |
| --- | --- | --- | --- |
| QQ 音乐 | `https://y.qq.com/` 登录弹层里的 canvas/img | cookie 出现 `qm_keyst` 或 `qqmusic_key` | 「二维码已失效 / 已过期 / 重新获取」 |
| 酷狗音乐 | `https://login-user.kugou.com/login/?appid=1014&…` 自己出码 | cookie 同时有 `token` 且 `userid` | 同上，另加「请点击刷新」 |

- 轮询节奏：默认 2000ms/拍（与参考实现一致），上一个请求结算后才计时；`retryAfterMs` 由状态机回传，渲染层不自己拍。
- 单次登录总时限 180s；二维码自身 180s 过期；「已扫码」后 60s 未确认按超时收尾（酷狗/QQ 都出现过扫码后永不报过期）。
- 瞬时失败（`E_UPSTREAM_UNAVAILABLE`）连续容忍 2 次，第 3 次判失败；`E_RATE_LIMITED`/`E_RISK_CONTROL` 立即失败并给 `retryAfterMs`。
- 重复点「重新获取」时 `generation + 1`，上一代晚到的结果直接丢弃，避免二维码错位。

## 四、凭据与落盘

```ts
interface Credential {
  cookie: string;                 // 整串原样，大小写与顺序都不动（B 站曾被小写化坑成 -101）
  extra: Record<string, string>;  // qq: uid/g_tk；kugou: uid/token/userid/dfid
  updatedAt: number;
  verifiedAt: number;             // 0 = 尚未校验，重启后由 ensureVerified 补一次
}
```

落盘文件 `<userData>/accounts.bin`：

```json
{ "version": 1,
  "current": { "qq": "qq:12345" },
  "buckets": { "qq": { "qq:12345": { "account": { "id": "...", "name": "..." }, "sealed": "<base64>" } } } }
```

- 账号元信息明文（列表要能画出来，不必逐个解密）；**只有凭据加密**；
- `safeStorage.available()` 为假时直接抛 `E_CIPHER_UNAVAILABLE`，不降级成明文；
- 写入走「临时文件 + rename」；JSON 坏了改名留档（`accounts.bin.bad-<ts>`）而不是删掉；
- 换机/密钥库重置导致解密失败 → 该账号按「登录失效」处理，界面提示重扫。

## 五、IPC 定义（`acc:*`）

| 通道 | 请求 | 返回 `data` |
| --- | --- | --- |
| `acc:begin` | `{provider}` | `LoginSnapshot`（含 `qr.image`、`qr.expiresAt`、`retryAfterMs`） |
| `acc:poll` | `{provider}` | `LoginSnapshot`（confirmed 时带 `account`） |
| `acc:refresh` | `{provider}` | 同上（先 cancel 再重新出码） |
| `acc:cancel` | `{provider}` | `{provider}` |
| `acc:status` | `{provider}` | `{account, hasCredential, upstreamReady}` |
| `acc:list` | `{provider?}` | `Account[]` |
| `acc:current` | `{provider}` | `Account \| null` |
| `acc:switch` | `{id}` | `Account`（切换前会 verify 一次） |
| `acc:logout` | `{id?}`/`{provider?}` | `{id}` |
| `acc:audio` | `{provider, songId, albumId?, quality}` | `AudioResult{url, quality, bitrateKbps, expiresAt, tried}` |
| `acc:invalidate` | `{provider?}` | `{invalidated:true}` |
| `acc:event`（主→渲染） | — | `{type:'login'\|'switch'\|'logout'\|'invalidated', provider, accountId?}` |

失败统一 `{ok:false,error:{code,message,hint?,retryAfterMs?}}`，`message` 已带平台前缀（如「QQ 音乐：…」），渲染层直接显示。

## 六、多账号与切换

- 账号 id 稳定为 `<provider>:<userId>`（QQ 的 `uin` 去掉 `o` 前缀），同一账号重复扫码只更新不新增。
- `switchTo(id)`：先 `verify`，成功才改 `current`；随后 `invalidate(provider)` 清空**取流缓存**，避免拿旧账号的直链继续播。
- 退出只删该账号；删的正好是当前账号时 `current` 置空，界面回落未登录。
- 重启后：`ensureVerified()` 对有凭据但 `verifiedAt=0` 的账号补一次校验并回写昵称头像（与 B 站 v0.7.8 的「重启后显示未登录」同因同治）。

## 七、取流与降级

`resolveAudio`（`stream.ts`）是平台无关的降级引擎，平台只提供 `ladder` 与 `fetchAudio`：

1. 从请求档位沿 `ladder` 逐档尝试（`lossless → high → standard`，`hires → lossless → high → standard`）；
2. 不可播放（`copyright`/`vip`/`region`）→ 继续降档，记入 `tried`；
3. `E_AUTH_REQUIRED`/`E_RATE_LIMITED`/`E_RISK_CONTROL`/`E_ACCOUNT_LIMIT` → **立即停**，降档只会放大风控；
4. 网络类失败继续降档，全失败报 `E_UPSTREAM_UNAVAILABLE`（不谎称没版权）；
5. 地址带 `expiresAt`（默认 15 分钟），`isUrlFresh` 留 60s 余量，快过期就重取而不是赌一次播放。

**合规边界**：两个平台的取流都要求配置 `upstreamBase`（自建网关 / 官方开放平台代理）。未配置时 `fetchAudio` 抛 `E_NOT_IMPLEMENTED` 并提示「请在设置中填写自建网关地址」，**不会**去调任何需要逆向签名的私有接口。

## 八、接入步骤（三步，均已给出代码）

1. **主进程**（`player/main.js` 末尾）：

```js
const { createAccountsModule, registerAccountsIpc } = require('./accounts/dist/src');
const { safeStorageCipher, netTransport, createElectronHost } = require('./accounts/dist/src/electronHost');
const accHost = createElectronHost();
const accounts = createAccountsModule({
  dataDir: app.getPath('userData'),
  cipher: safeStorageCipher(),
  host: accHost,
  transport: netTransport(accHost.userAgent),
  logger: { info: (m, d) => log('acc', m, d), warn: (m, d) => log('acc', m, d) },
  upstream: { qq: process.env.NCKK_QQ_UPSTREAM || '', kugou: process.env.NCKK_KUGOU_UPSTREAM || '' }
});
registerAccountsIpc({ ipcMain, module: accounts, sendEvent: (ch, p) => win && win.webContents.send(ch, p) });
```

2. **preload**（`player/preload.js`）：按现有风格追加 `accBegin/accPoll/accRefresh/accCancel/accStatus/accList/accSwitch/accLogout/accAudio/onAccEvent`，内部 `ipcRenderer.invoke('acc:*')`。
3. **渲染层**：`mountAccountPanel({ root: document.querySelector('#accPanel'), api })` 挂进设置抽屉；面板只管画码与按 `retryAfterMs` 定时 `poll`，不复制任何判定逻辑。

## 九、验证

```powershell
# 编译（strict，0 error）
cd player; npx tsc -p tsconfig.accounts.json

# 自测（不启动 Electron，40 条）
node tools/test-accounts.mjs

# 回归（既有功能不受影响，因为本方案未改动既有文件）
powershell -ExecutionPolicy Bypass -File .\启动开发版.ps1 -Probe all
```

自测覆盖：状态机正常路径与幂等、二维码过期、已扫码 60s 超时、瞬时失败容忍 2 次、凭据密文落盘与重启恢复、坏文件留档、密钥库不可用拒写、多账号切换持久化、取流三档降级、限流立即停、未登录拒绝并给提示。

## 十、风险与限制

1. **官方页面改版**：二维码位置或 cookie 名变化会让 `readQrImage`/`requiredCookieNames` 失效 —— 已有 `isUsableQr >= 1500`（跳过占位白图）与「页面文案判过期」两道兜底，失败会明确报 `E_RISK_CONTROL` 并建议改用导入 Cookie。
2. **取流未接通**：本方案只做登录与凭据管理，取流要求合规上游；QQ/酷狗的播放地址涉及签名与会员权限，未授权手段一律不接。
3. **风控**：轮询 2s、限流立即停、单账号单会话，均为降低触发面；仍可能因异地登录被要求验证码，届时按 `E_RISK_CONTROL` 提示用户改用扫码。
4. **平台差异**：QQ 的 `qm_keyst` 与旧名 `qqmusic_key` 并存，酷狗要求 `token`+`userid` 双命中；新增平台只需再写一个 `providers/*.ts` 与 `CAPS`。
5. **未验证项**：「QQ 登录弹层在 1280×800 下二维码是否完整可见」「酷狗扫码后 cookie 写入延迟是否超过 60s」为**推测**，需真机扫一次确认（本项目 B 站扫码即栽在「占位图/静区」这类肉眼可见但自动化测不到的细节上）。

## 十一、已接入主程序（2026-11-21）

按用户要求「接进 main.js + 设置抽屉」后落地，改动如下（除 `accounts/` 外的既有文件只加不改语义）：

| 文件 | 改动 |
| --- | --- |
| `player/main.js` | 新增 `setupAccounts()`：`require('./accounts/dist/src')` + `electronHost`，装配 `createAccountsModule`（`dataDir` 用 `app.getPath('userData')`，`cipher` 用 `safeStorage`，`upstream` 读 `NCKK_QQ_UPSTREAM` / `NCKK_KUGOU_UPSTREAM`），`registerAccountsIpc` 注册 11 个通道；未编译时注册兜底 handler，返回 `E_NOT_IMPLEMENTED` 并提示编译命令 |
| `player/preload.js` | 追加 `accBegin/accPoll/accRefresh/accCancel/accStatus/accList/accCurrent/accSwitch/accLogout/accAudio` 与 `onAccEvent` |
| `player/renderer/index.html` | 设置抽屉新增「QQ 音乐 / 酷狗音乐」分段、扫码登录/取消/重新获取、二维码框、账号列表、取流状态行；引入 `accpanel.js` |
| `player/renderer/accpanel.js` | 新建（纯 JS，独立于 TS 编译产物）：`begin/poll/schedule` 驱动轮询，`paintQr` 按 `retryAfterMs` 定时器推进，过期/失败给遮罩与「重新获取」，账号列表支持切换与退出 |
| `player/renderer/app.css` | 账号列表样式（复用现有 `--card/--ac/--fg*` 变量） |
| `accounts/src/electronHost.ts` | ①支持 `clickText`（QQ 首页要先点「登录」）；②`readQrImage` 遍历全部子帧，跨域子帧里的普通 `<img>` 用 `session.fetch` 转 data URL，主框架远程图跳过（首页封面会误判）；③每次 `executeJavaScript`/`fetch` 都有超时；④**UA 默认不覆盖**（沿用 Electron UA） |
| `accounts/src/providers/{qq,kugou}.ts`、`base.ts` | QQ `clickText: '登录'`；酷狗登录页去掉 `callback` 参数（带它必 `ERR_FAILED(-2)`）；`start()` 增加「首次打开失败/4s 内无码 → 关窗重开一次」的静默重试（酷狗冷启动偶发 `ERR_FAILED(-2)`） |

**实测证据**：

- QQ 音乐：`y.qq.com` 首页点「登录」后，二维码在跨域子帧 `open.weixin.qq.com/connect/qrconnect?appid=wx48db31d50e334801` 里（`graph.qq.com` 那条「QQ 互联」路子只有头像、不出码）。读到的码长 62–64KB、470×470、带静区，`player/demo/shot-acc-qq.png`。**即「QQ 音乐」这一路实际是微信扫码**（官方登录页如此），帮助文案已如实写明。
- 酷狗音乐：`login-user.kugou.com/login/?appid=1014` 页面自己出码（实测拿到 423–470px、`qrLen 64447`）。注意酷狗登录页对同一出口 IP 有频控，短时间反复打开会返回 `ERR_FAILED(-2)`（已加一次静默重开 + 面板「重新获取」兜底）。
- 端到端（`.tmp/diag-acc-e2e.js`，向 `persist:acc-qq` 注入假 `qm_keyst/uin` 模拟「手机确认」）：`begin 3058ms → waiting`、`poll after cookie → confirmed（uid 1234567890）`、`accounts.bin 1285B 落盘`、`list 2 条`。
- 既有回归：`npx tsc -p tsconfig.accounts.json` 0 error；`node tools/test-accounts.mjs` 40/40。

**仍有限制**：①手机「确认」这一拍无法自动化，需真实扫一次；②取流需配置 `NCKK_QQ_UPSTREAM` / `NCKK_KUGOU_UPSTREAM`（未配置时面板显示「未配置」，只做登录与账号管理）；③酷狗冷启动偶发 `ERR_FAILED(-2)` 已有一次静默重试，若仍失败点「重新获取」。

## 十二、二次修复：三个真机问题（2026-11-21）

真机跑出 `player/demo/shot-acc-qq2.png` / `shot-acc-kugou2.png` 时暴露出三个问题，逐一定位并修好：

| # | 现象 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | QQ 面板二维码一出来就盖着「已登录」遮罩，账号列表却是空的 | `QqProvider.poll()` 判据是「只要 `qm_keyst` 或 `qqmusic_key` 存在就算登录」，而 y.qq.com 的登录层在**未登录**时也会写这类占位 cookie | 加 `uin` / `wxuin` 必须存在（未登录时二者皆空），且两者都在白名单里 |
| 2 | 只有微信二维码，没有 QQ 扫码入口 | QQ 音乐的 QQ 二维码不在 `<img>` / `<canvas>`，而是登录层「扫码登录」页签点开后由 `graph.qq.com` 子帧渲染的 `<div class="plain-qrcode">` 的 **CSS background-image**；而且必须先点「登录」→「QQ登录」→「扫码登录」三步，第三步的按钮在跨域子帧里 | `LoginWindowHost.open()` 支持 `clickTexts` 序列，逐帧查找并点击；`readQrImage()` 增加 CSS 背景图扫描，并按**渲染尺寸**（≥120px 且近似方形）判断，避免把另一页签里 `display:0x0` 的微信码扫进来 |
| 3 | 酷狗二维码加载失败，面板报「登录页没有出现二维码」 | 酷狗真码是调色板 PNG，data URL 仅 **1414** 字符，而识别门槛是 `length >= 1500`，于是被跳过、转而命中 236px 的 `scan-tip.png` 装饰图，主帧远程图又被跳过 | 门槛降到 800（占位白图约 900 会落在这之下，真码最小 1.3KB）；图片要近似方形、显示尺寸 ≥120；跳过 `logo/avatar/icon/sprite/scan-tip/placeholder` 类装饰图 |

附带：`qrMessage` 让状态行按平台说话（「请用手机 QQ 扫一扫」/「请用手机酷狗 App 扫一扫」），设置页帮助文案同步；点击等待放宽到 5s/1.2s、首屏找码窗口 4s→7s（QQ 登录层要点三次、还要等子帧渲染）。

真机取证：QQ 面板 `{"len":124598,"w":568,"h":568,"state":"请用手机 QQ 扫一扫","auth":"未登录"}`；酷狗 `{"len":1378,"w":423,"h":423,"state":"请用手机酷狗 App 扫一扫"}`；两者 `accStatus` 均为 `account:null`（没有误判登录）。`tsc` 0 error，`tools/test-accounts.mjs` 40/40。

> 说明：QQ 这一路的二维码是 QQ 互联官方「扫码登录」页签生成的点阵码，用**手机 QQ** 扫；若想用微信，可点弹层里的「微信登录」页签（`open.weixin.qq.com` 的普通方形码，之前那版收到的是它）。

## 十三、误判「一开码就登录 uid unknown」（2026-11-21）

真机现象：QQ 二维码一出现，面板立刻显示「已登录」，账号列表里多出一条 `uid unknown`（不是用户自己的号）。

根因在 `PageLoginProvider.poll()`：

```ts
if (this.cfg.requiredCookieNames.every(n => !!cookies[n])) { ... confirmed ... }
```

`[].every(...)` **恒为 true**，而 QQ 的 `requiredCookieNames` 恰好是空数组（它的判据写在子类 `QqProvider.poll()` 里），于是 `QqProvider` 在「还没扫」时把控制权交给父类，父类第一拍就 `confirmed`，`verify()` 在没有 `upstreamBase` 时回落 `localAccount()`，账号名写成 `uid unknown` 并被落盘。

修复三处：

| 位置 | 修复 |
| --- | --- |
| `providers/base.ts` `poll()` | 必须 `requiredCookieNames.length > 0` 且全部命中，**且** `pickExtra()` 能取到 uid，才允许 `confirmed` |
| `accountManager.ts` `persist()` | 兜底：`userId` 为空或 `unknown` 时抛 `E_AUTH_REQUIRED`（「请在手机上点确认，或用手机 App 重新扫一次」），绝不落盘 |
| `accountManager.ts` 构造函数 | 迁移：启动时清掉历史误判写进库里的 `unknown` 账号（用户本机 `accounts.bin` 里的 `qq:unknown` 已实测被清掉） |

顺带把 QQ 的 uid 识别面放宽：`uin / p_uin / luin / euin / wxuin` 任一存在即算拿到账号标识（不同登录入口写的字段不同），并把这几个名字加进 cookie 白名单。

回归：`tools/test-accounts.mjs` 从 40 条加到 **49 条**，新增用例覆盖「必填名单为空 + 无 cookie → waiting」「只有 qm_keyst 没有 uin → waiting」「token+userid 齐 → confirmed」「uqin 的 o 前缀被剥掉」「启动时清 uid unknown」。真机复测：QQ/酷狗都停在「请用手机扫码」，`accStatus` 均为 `account:null`。

## 十四、扫码确认后登录态没落到分区（2026-11-21）

真机现象（用户）：QQ 扫码后手机提示「参数错误，网页未正确配置 QQ 登录」；酷狗扫码并确认后，播放器仍是未登录。

分区取证（`%APPDATA%\NckiksMusic\Partitions\acc-*` 的 `Network\Cookies`，用 sqlite 读）：

| 分区 | cookie 数 | 关键缺失 |
| --- | --- | --- |
| `acc-kugou` | 19（`dfid/KugooID/UserName/mid/t/kg_*`） | **无 `token`、无 `userid`** |
| `acc-qq` | 7（`qlogin_uid/_tme_*`） | **无 `qm_keyst`、无 `uin`** |

也就是说「手机点了确认」之后，登录态压根没写进我们读的那个分区。查页面行为后定位到两个原因：

1. **旧分区里的快捷登录账号在捣乱**：`acc-qq` 里残留 `qlogin_uid`，于是 graph.qq.com 直接给出「快捷登录 AA1imb / 一键登录」界面；此时点「扫码登录」出的是旧会话的码，手机扫完走到 `redirect_uri` 校验就报「参数错误，网页未正确配置 QQ 登录」。
2. **`window.open` 被我们拦掉**：原实现是 `setWindowOpenHandler` → `deny` + 把 URL 就地 `loadURL`。酷狗的 `regok` / QQ 的授权跳转都靠 `window.open` 的 opener 交接来把登录态回写到 cookie；就地导航把登录页本身顶掉，流程中断 → 分区里永远没有 `token`。

修复（`player/accounts/src/electronHost.ts`）：

| 改动 | 说明 |
| --- | --- |
| 打开前 `session.clearStorageData({ storages: ['cookies'] })` | 每次登录都用干净分区，不再命中旧的快捷登录账号/旧二维码 |
| `setWindowOpenHandler` → `action: 'allow'`（`overrideBrowserWindowOptions` 里 `show:false`） | 让回调页真的开出来，opener 交接能完成；子窗口共享同一 partition，cookie 落在我们读的会话里 |
| `did-create-window` 收集子窗口并在 `close()` 里一并 `destroy` | 不留后台窗口 |

验证：`tsc` 0 error；`tools/test-accounts.mjs` 49/49；真机面板复测 QQ `{"len":124598,"w":568,"h":568,"state":"请用手机 QQ 扫一扫","auth":"未登录"}`、酷狗 `{"len":1394,"w":423,"h":423,"auth":"未登录"}`，两个 `accStatus` 都是 `account:null`（不再误判）。

## 十五、酷狗「已扫码」卡住：用页面自己的换会话函数收尾（2026-11-21）

真机现象：手机酷狗 App 扫码后，面板停在「已扫码，请在手机上确认」，一直不跳登录成功。

原因是酷狗登录页把「手机确认之后」的收尾交给 `regok.html` 的顶层回调（`KgUser.QRCodeLogin`），
在隐藏窗口里这条链路有时不执行，于是分区里永远没有 `token`。

处理办法沿用 v0.8.x 已验证的做法（不重写协议、不伪造签名）：

1. `host.tapJson(patterns, onJson)`：用 DevTools 协议 `Fetch` 旁听页面**自己**发出的
   `get_userinfo_qrcode` / `login_qr_check` 响应（只读，读完立刻 `continueRequest`）。
   返回体形如 `{"status":1,"data":{"status":1|2|4, "token":"…", "userid":…}}`。
2. `KugouProvider` 记住最新的 `data.status` / `data.token` / `data.userid`。
3. 一旦拿到 `data.status === 4` 且带 `token`，就 `host.evalInPage(...)` 调页面自己的
   `KgUser.QRCodeLogin(1014, userid, token, cb)` 完成换会话 —— 签名/加密全由官方页面做，我们只当「按键的人」。
4. 换完 600ms 再读一次 cookie，`token` + `userid` 齐全即 `confirmed`；若已确认但 cookie 还没读到时
   保持 `scanned`，不退回 `waiting`（避免面板文字来回跳）。

验证：`tsc` 0 error；`tools/test-accounts.mjs` 49/49；旁听实测每 1s 拿到一条
`{"status":1,"ds":1,"hasToken":false}`（未扫码时状态 1，符合预期），证明 CDP 旁听通道可用。

## 十六、酷狗「已扫码」仍不跳登录：直接采用旁听到的 token（2026-11-21）

上一版把收尾交给页面自己的 `KgUser.QRCodeLogin`，真机上仍有概率不生效（页面在隐藏窗口里不写 cookie）。
改为**读到即登录**，不再依赖页面执行结果：

1. `host.writeCookies(pairs, domain)`：按官方同样的形态（`.kugou.com`、`path=/`、30 天）把 cookie 写进分区。
2. `KugouProvider.poll()` 在 `data.status === 4` 且拿到 `token` / `userid` 时：
   先 `writeCookies({ token, userid }, '.kugou.com')`，再跑一次常规 `poll()` ——
   `requiredCookieNames: ['token','userid']` 命中、`pickExtra` 从 `userid` 取到账号标识，即 `confirmed`。
3. 页面自己换会话成功的场景下，这一步是幂等的（写的是同一份值）。

验证：`host.writeCookies({token:'FAKE_TOKEN_123', userid:'987654321'}, '.kugou.com')` 后
`readCookies(['token','userid'])` 立刻读回两值，分区里落到 `.kugou.com`；`tsc` 0 error、自测 49/49。

## 十七、酷狗「已扫码」卡死的真正原因：`executeJavaScript` 挂住（2026-11-21）

日志里已经看到 `[acc] 酷狗直接写入 token { userId: '1348766016' }`，分区里也确实出现了
`token`（64 字符）与 `userid`，但面板仍停在「已扫码、请确认」，账号列表无条目。

原因不在 cookie，而是紧接着那一步：

```ts
const out = await this.host.evalInPage(KgUser.QRCodeLogin(...));  // ← 页面正在跳转
```

`webContents.executeJavaScript()` 在页面跳转（酷狗确认后会走 `regok`）时**可能永远不返回**，
于是 `poll()` 卡在这个 `await` 上：既不会重新读 cookie，也不会返回新的 phase ——
表现就是「token 已经写进去，界面却一直停在已扫码」。

修复：

| 改动 | 说明 |
| --- | --- |
| 删掉 `KgUser.QRCodeLogin` 调用 | 已经能自己写 token，没必要再依赖页面函数 |
| 写入后 `sleep(500)` 再 `super.poll()`，并打一行 `[acc] 酷狗写入后重判 { phase }` | 有日志可查，不再是黑盒 |
| `PageProviderConfig.clearSession`（默认 true，酷狗设 false） | 酷狗分区不再每次登录都清空 —— 已经扫过的 `token/userid` 会留着，重启后第一拍 poll 即可恢复登录态；QQ 仍清空（避免快捷登录旧账号） |

`tsc` 0 error、`tools/test-accounts.mjs` 49/49。

## 十八、QQ 音乐 App 扫码（协议通道，v0.9.0）

前两版给 QQ 音乐走的是「打开 y.qq.com → 点三层页签 → 读跨域子帧里的码」，扫的是**网页版**的码
（QQ 互联 / 微信）。folia-major 走的是客户端协议：二维码由 QQ 音乐 App 自己的登录服务签发，
手机用「QQ 音乐 App → 扫一扫」扫。这一版把那条通道也接上了，作为并列的第三个来源
（`provider = 'qqapp'`），网页通道保持不动。

### 18.1 协议四步（全部实测通过）

| 步骤 | 请求 | 关键点 |
| --- | --- | --- |
| 出码 | `POST https://u.y.qq.com/cgi-bin/musicu.fcg`，`req_0 = {module:'music.login.LoginServer', method:'CreateQRCode', param:{tmeAppID:'qqmusic', ct:11, cv:14090008}}` | comm 带上 `ct/cv/v/chid/tmeAppID`；不需要签名、不需要 QIMEI。返回 `qrcodeID` + `qrcode`（data URL）+ `expiresIn: 900` |
| 收推送 | `wss://mu.y.qq.com/ws/handshake`，MQTT 5，订阅 `management.qrcode_login/<qrcodeID>` | CONNECT 属性必须含 **Auth Method = `pass`**（漏了回 `0x8C Bad authentication method`）与 `tmeAppID/business/hashTag/clientTag/userID`；SUBSCRIBE 属性 `authorization=tmelogin, pubsub=unicast` |
| 换凭据 | 同 musicu：`module:'music.login.LoginServer', method:'Login'`，`param {musicid:<数字>, qrCodeID, token}` | `token` 是推送里的 `qqmusic_key`（只活 300 秒）；comm 必须覆盖 **`tmeLoginType: 6`**，`musicid` 必须给**数字**（字符串回 `10006`、类型给 2 回 `1000`、不覆盖回 `104400`）→ 得 `musickey`（159 字符，3 天） |
| 校验 | `module:'music.UserInfo.userInfoServer', method:'GetLoginUserInfo'`，comm `{qq, authst: musickey, tmeLoginType: 2}`，Cookie `uin=…; qqmusic_uin=…; qm_keyst=…; qqmusic_key=…` | 模块名必须是 `userInfoServer`，`userInfo` 恒回 `500003`；`data.info.nick` 就是昵称 |

### 18.2 代码结构

| 文件 | 作用 |
| --- | --- |
| `accounts/src/mqtt.ts` | 最小 MQTT 5 客户端：CONNECT / SUBSCRIBE / PINGREQ / DISCONNECT + PUBLISH 解析；`ready` 在 SUBACK 才兑现；socket 是鸭子类型，主进程传 `ws`、单测传内存假实现 |
| `accounts/src/wsConnect.ts` | 把 `ws` 包成 `MqttConnect`（Electron 33 = Node 20，主进程没有全局 WebSocket） |
| `accounts/src/providers/qqapp.ts` | 上面四步的状态机：`start()` 出码 + 订阅 → `poll()` 报 `waiting/scanned/confirmed/expired/failed` → 确认那一拍换凭据并校验昵称 |
| `accounts/src/index.ts` | `providers.qqapp` 注册；`mqttConnect` 可注入（单测用） |
| `renderer/index.html` / `accpanel.js` | 设置抽屉第三段「QQ 音乐 App」，与另两个平台共用同一套二维码 UI |

### 18.3 状态与错误

| 情形 | 相位 / 错误码 |
| --- | --- |
| 刚出码、等手机扫 | `waiting`，`retryAfterMs 2000` |
| 手机已扫、等确认（推送 `scanned`，带 `userNick`） | `scanned` |
| 确认并换到 `musickey`、校验通过 | `confirmed` + 账号（昵称来自 `GetLoginUserInfo`） |
| 超过二维码有效期（900 秒） | `expired` + `E_QR_EXPIRED` |
| 推送通道连不上 / 订阅被拒 | `E_UPSTREAM_UNAVAILABLE`（文案带底层原因） |
| 换凭证被平台拒（`104400` 等） | `failed` + 上游错误码（`classifyUpstream` 归一） |

### 18.4 验证

- 协议层：`.tmp/probe-qqmqtt.mjs`（出码 + 订阅）、`.tmp/probe-qqexchange2.js`（换凭据的三种 comm 对照：`tme6` 成功、`tme2` 回 `1000`、字符串 id 回 `10006`）、`.tmp/probe-qqprofile.js`（`GetLoginUserInfo` 取到昵称）。
- 端到端：真机扫码 → `scanned` → `cookies` → `musickey` → 昵称「月亮在不在」，全链路一次跑通。
- 自测：`node player/tools/test-accounts.mjs` **68/68**（新增 19 条：CONNECT 必须带 `pass`、出码/订阅、scanned、cookies→confirmed 及凭据断言、换凭证被拒、过期）。
- 界面：`.tmp/diag-acc3.js` 在真实主进程里点开「QQ 音乐 App」→ 150×150 码渲染进面板、`accStatus` 返回 `phase waiting`，截图 `player/demo/shot-acc-qqapp.png`。

### 18.5 依赖与边界

- 新增运行时依赖 `ws@8`（仅主进程用）。
- 仍然**不做**任何签名/逆向：二维码由平台签发，登录由用户在手机 App 上确认；取流与另两条通道一样要求配置合规上游（`NCKK_QQAPP_UPSTREAM`），未配置时面板显示「未配置」，只做登录与账号管理。
- 已知边界：手机端「扫码后确认」无法自动化，必须真人操作一次；二维码 15 分钟有效，过期后点「重新获取」。

## 十九、设置页两卡分离 + 切号后刷新数据（v0.9.1）

### 19.1 为什么拆成两张卡

原来是一张「QQ 音乐 / 酷狗音乐」卡 + 分段控件，三处别扭：

1. 分段一换，上一张卡的二维码、轮询、错误提示全被覆盖 —— 两个平台的登录本来互不相干；
2. 「QQ 音乐」下面还挂着网页版（扫码走 `y.qq.com` + 微信/QQ 网页登录），与「QQ 音乐 App 扫码」重复，用户不知道该点哪个；
3. 账号列表、取流状态揉在一张卡里，看不出哪一行属于哪个平台。

现在：`#accCards` 里由 `renderer/accpanel.js` 动态生成两张独立卡片（`data-p="qqapp"` / `data-p="kugou"`），各自持有 `timer / snapshot / shownSrc / accounts`，互不打断。**网页版 `qq` 不再出现在界面上**，代码保留仅为兼容旧账号数据（`accounts.bin` 里已有的 `qq:*` 仍可读）。

### 19.2 切号后刷新收藏/歌单

新增「账号数据版本」概念，避免「切了账号还看着上一个人的歌单」：

| 层 | 改动 |
| --- | --- |
| `accounts/src/accountManager.ts` | `AccountEvent` 增加可选的 `revision` / `library` 字段 |
| `accounts/src/index.ts` | 模块内维护 `revision: { value }`；`login/switch/logout` 各加一；`registerIpcOptions.refreshLibrary` 注入刷新回调。事件**先推一版**（带 `revision`，界面立刻切到新账号），刷新完**再推一版**（带 `library`） |
| `accounts/src/ipcContract.ts` | `AccountStatusPayload.dataRevision`、`AccEvent.revision/library` |
| `main.js` | `refreshLibrary`：清 `thumbCache` / `dirCoverCache`、`invalidateStreams(provider)`，返回 `{refreshed:false, message:'…已切换到该账号并清空封面/取流缓存；歌单与收藏接口待接上游'}` |
| `renderer/app.js` | `window.__accOnAccountChange(provider, revision)`：清 `thumbUrl`、`accInvalidate(provider)`、记 `S.accRev[provider]`、B 站收藏夹 `bilFavsReset()` |
| `renderer/accpanel.js` | 监听 `acc:event`，`revision` 变化才触发失效逻辑；`library.message` 用 toast 呈现 |

边界说清楚：QQ 音乐与酷狗都还没接「收藏/歌单」接口（要走合规上游），所以这一版刷新动作=**清缓存 + 换账号上下文**，并在界面上如实写明，不假装刷新成功。

### 19.3 验证

- `npx tsc -p player/tsconfig.accounts.json` → 0 error；
- `node player/tools/test-accounts.mjs` → **76/76**（新增 8 条：初始 revision=0、切号后 +1、第一版事件无 `library`、第二版事件带 `library.message`、`status.dataRevision` 与事件同源、反注册后不再推）；
- 真机（`.tmp/diag-acc4.js`）：`[shape] {"cards":["qqapp","kugou"],"seg":false}`、点 QQ 音乐卡出码 `{"len":606,"w":150,"state":"请用手机 QQ 音乐 App 扫一扫"}`，截图 `player/demo/shot-acc-cards.png`。

## 二十、主界面当前账号切换（v0.9.2）

### 20.1 为什么要有这一层
四个音源各有自己的登录态，但用户真正关心的是「我现在用谁的歌单」。以前这个信息只藏在设置抽屉里，而「选择歌单」又无条件把网易云歌单塞进列表 —— 切到哔哩哔哩后点一个网易云歌单只会报错。这一版把「当前账号」提到主界面，并让歌单来源跟着它走。

### 20.2 数据与通道
| 位置 | 内容 |
| --- | --- |
| `userData/identity.json` | `{ version, current, active: { ne/qqapp/kugou/bil → 账号主键 } }`，只存主键，不存任何凭证 |
| `player/main.js` | `identitySnapshot()` 把四个音源归一成 `{ id, label, activeId, accounts[] }`；`idn:get` / `idn:set` 两个通道；`idn:set` 对 QQ/酷狗会额外调 `manager.switchTo()` |
| `player/preload.js` | `idnGet` / `idnSet` / `onIdnChanged` |
| `player/renderer/index.html` | 标题栏 `#btnIdn`（头像）+ `#idnPop` 下拉 |
| `player/renderer/app.js` | `idnPaint / idnRenderList / idnSwitch / idnInit`；`plSources()` 按 `S.idn.current` 过滤；`plSelectSource()` 增加哔哩哔哩分支 |

### 20.3 三处容易踩空的细节
1. **身份回落**：当前账号退出登录后，`identitySnapshot()` 会自动回落到第一个有账号的音源并落盘，界面不会卡在一个已不存在的人身上。
2. **先取状态再拉收藏夹**：切到哔哩哔哩时若 `S.bil.status` 还没就绪，`bilEnsureFavs()` 会按「未登录」直接返回，收藏夹永远空 —— 所以先 `await updateBilNote()` 再拉。
3. **收藏夹字段是 `name/sub`**（不是 `title/count`），「选择歌单」里照抄 drawer 行的字段才不会全叫「收藏夹」。

### 20.4 验证
- `node --check` 四个文件全通过。
- 真机：`.tmp/diag-idn.js` → `[pop] items 4`（网易云/QQ/酷狗/哔哩哔哩各 1 个账号）、`[src-before]` 17 条网易云歌单、切到哔哩哔哩后 `[after-switch]` 出现 8 个收藏夹（默认收藏夹/学习/摄影/键盘/pr/电脑…）、切回网易云 17 条复原；截图 `player/demo/shot-idn-pop.png`。
- 头像加载失败自动回落首字母（QQ 音乐当前没有头像 URL、酷狗只有 uid）。

## 二十一、上游歌单接口（v0.9.3）

### 21.1 协议与端点

| 用途 | 平台 | 端点 / 模块 | 关键字段 |
| --- | --- | --- | --- |
| 我的歌单 | QQ 音乐 | musicu `music.musicasset.PlaylistBaseRead / GetPlaylistByUin` | `v_playlist[].tid/dirId/name/songnum` |
| 歌单曲目 | QQ 音乐 | musicu `music.srfDissInfo.DissInfo / CgiGetDiss` | `songlist[].mid/name/singer[].name/interval` |
| 我的歌单 | 酷狗 | `m.kugou.com/plist/index?json=true&uid=<userid>&page=1&pagesize=100` | `plist.list.info[].specialid/specialname/songcount/imgurl` |
| 歌单曲目 | 酷狗 | `m.kugou.com/plist/index?json=true&specialid=<id>&page=N` | `plist.list.info[].songs[].hash/filename/duration` |

QQ 的 comm 用登录换来的 `uin` + `musickey`（`tmeLoginType: 2`），与 qqapp 扫码同一条通道；酷狗直接用登录落盘的 `token/userid` 走 `Cookie` 头。两者都不做签名、不碰写操作。

### 21.2 实现

- `player/upstream-library.js`：`qqPlaylists / qqPlaylistTracks / kgPlaylists / kgPlaylistTracks`，统一返回 `{id,name,count,cover}` 与 `{id,title,artist,duration}`；非 0 码转 `E_UPSTREAM_CODE`，1000/104400 转 `E_AUTH_REQUIRED`。
- `player/main.js`：`acc:playlists` / `acc:tracks` 两个 IPC，凭证用 `accAccounts.manager.credentialOf(provider)`，失败统一 `{ok:false,error:{code,message}}`。
- `player/renderer/app.js`：`S.up` 缓存 + `upEnsure()` 预取；当前账号是 QQ 音乐 / 酷狗时，「选择歌单」列出该账号的歌单；点选后 `accTracks` 拉曲目并整体覆盖播放列表。

### 21.3 酷狗曲目为什么要摊平多页

`m.kugou.com` 的歌单详情**不直接返回歌曲数组**：每页给 30 个歌单卡片、每张卡片带 3 首 `songs[]`。实测 page1 摊平去重得 89 首、page2 累到 178 首，而歌单 `songcount` 是 156。因此实现里「按页累加 + 按 hash 去重 + 到达 songcount 即停并截断」，得到 156 首（不再翻到 533 首）。

### 21.4 边界

- QQ 只接「自建歌单」；收藏歌单要 `encryptUin`（`PlaylistFavRead`），本版未接。
- QQ 歌单不返回曲目数（`count` 可能为 0），列表里按「打开时读取」显示。
- 曲目只能入列表，播放还需要取流（QQ 需合规上游，酷狗需 `kg:<hash>` 协议），面板会提示「取流尚未接入」。

## 二十二、取流（v0.9.4）

- 新增 `player/stream-resolve.js`：`kgResolve(hash,prefer)` 走 `m.kugou.com/app/i/getSongInfo.php?cmd=playInfo`（`pay_type>0` 直接判 `E_NO_COPYRIGHT`），`qqResolve(mid,{uin,musickey})` 走 musicu `music.vkey.GetVkey / UrlGetVkey`（`M800`→320k、`M500`→128k）。
- 新增自定义协议 `upaudio://s/<provider>/<id>`（与 `bilaudio` 同构：解析直链 → 带 Referer/UA 代理 → 透传 Range，直链缓存 90s），`media:url` 把 `kg:<hash>` / `qq:<mid>` 映射到它，CSP 的 `media-src` 同步放开。
- 实测：酷狗免费曲（`FC21EFCE59906B54DF2E47EDE9CC757A`）`duration 221.5s`、`readyState 4`、播放 2.44s 正常推进；VIP 曲目给 `E_NO_COPYRIGHT` 并被面板提示。
- QQ 音乐：`GetVkey` 已接通但当前账号下仍拿不到 `purl`（返回 `err 4 / no supported sources`），需继续核对 comm 的 `qq/authst` 与 `guid`，暂按「取流不可用」处理，列表与歌单不受影响。
- 顺手修掉一个真 bug：`main.js` 里 `app.whenReady().then(() => { if (!gotLock) return; ... })` —— Chromium 单实例锁拿不到（权限/杀软占用）时会**整段跳过启动**，表现为「双击没反应」；改为只有 `pidState === 'held'` 才退出。

### 22.1 QQ 取流打通（v0.9.5）

两个关键点（对照 folia `services/auth/playback.js` 才定位到）：

1. `filename` 必须是**两段识别值**：`M800 + songmid + media_mid + .mp3`（media_mid 缺省用 songmid 补）。只送一段时 `UrlGetVkey` 照样回 `purl`，但 CDN 一律 403/404 —— 这正是之前「有 purl、播不出」的原因。
2. CDN 主机首选 `sjy6.stream.qqmusic.qq.com`（其次 isure / dl / ws）。`purl` 是相对路径，拼错主机同样 404。

实测：`[up] qqapp 206 audio/mpeg … sjy6…` → `dur 265.8s`、`currentTime 1.95` 推进正常；酷狗同时 `206 / 221.5s`。
