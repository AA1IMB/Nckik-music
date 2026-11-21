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
