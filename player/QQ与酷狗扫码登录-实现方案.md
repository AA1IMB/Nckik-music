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
