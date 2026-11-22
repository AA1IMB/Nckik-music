# 安装包（v0.9.4）

| 文件 | 用途 | 大小 |
| --- | --- | --- |
| `NckiksMusic-Setup-0.9.4.exe` | 安装版：按向导装到本机，创建桌面/开始菜单快捷方式，可在「应用」里卸载 | 89.5 MB |
| `NckiksMusic-Portable-0.9.4.exe` | 免安装版：放任意目录双击运行，删文件即卸载 | 82.3 MB |

校验：`sha256sum -c SHA256SUMS.txt`（Windows 可用 `certutil -hashfile <文件> SHA256` 手工比对）。

说明：

- v0.9.4 修掉了 v0.9.3 及更早的安装失败（产品名里的 `′` 是 U+2032，中文代码页下 NSIS 写不出 `Uninstall Nckik′s music.exe`，会提示「无法关闭 / 不能打开要写入的文件」）。
- 安装包未做代码签名，Windows 可能提示「SmartScreen 已保护你的电脑」，点「更多信息 → 仍要运行」即可。
- 这两个文件从 `player/package.json`（v0.9.4）用 `npx electron-builder --win --x64` 产出；重新打包见根目录 `README.md` 的「构建安装包」一节。
