# 流萤弹幕消息

基于 Electron 的 QQ / 微信消息顶部弹幕工具。程序通过 OneBot v11 正向 WebSocket 获取 QQ 消息，通过 wechatauto-replica 读取微信 4.x 本地数据库获取微信消息，在屏幕顶部以弹幕形式显示私聊、群聊和群通知，并常驻系统托盘。

> 风险提示：本程序依赖第三方 QQ 协议插件（LLOneBot + LiteLoaderQQNT）实时读取 QQ 消息；启用微信消息时还会通过 wechatauto-replica 读取微信 4.x 本地数据库。两者均可能存在账号风控、功能受限或封禁等风险。请确认你已了解并自愿承担相关风险后再使用。

## 功能特性

- 私聊 / 群聊 / 群通知弹幕展示
- 群名、昵称、头像与内容归一化
- 顶部透明置顶、鼠标穿透弹幕窗口
- 按高度排队，避免消息过多时撑破屏幕顶部区域
- 特别关心好友高亮底版
- QQ 前台时自动隐藏弹幕
- 锁屏、睡眠/休眠、显示器关闭期间抑制弹幕
- 系统托盘菜单：显示/隐藏弹幕、选择范围（特别关注/普通对话）、刷新、卸载软件、退出程序
- 微信消息（可选）：wechatauto-replica 读取微信 4.x 本地数据库，私聊/群聊弹幕复用「选择范围」过滤
- 首启安装向导与开机自启动支持

## 环境要求

- Windows 10 / 11
- 官方 QQNT
- LiteLoaderQQNT
- LLOneBot 插件
- OneBot v11 正向 WebSocket，默认地址 `ws://127.0.0.1:3001`
- （可选，微信消息）微信 4.x + Python 3.9+ + `pip install wechatauto-replica`

## 安装与使用

1. 下载 Release 中的 `firefly_danmaku_message.exe`（GitHub 会重命名中文资产名，下载后可在本地改名为 `流萤弹幕消息.exe`）。
2. 运行安装器，按向导完成环境检测与安装。
3. 安装完成后程序常驻系统托盘，并通过 OneBot WebSocket 接收 QQ 消息。
4. （可选）如需接收微信消息：安装并登录官方微信 4.x，安装 Python 3.9+ 并执行 pip install wechatauto-replica，然后在设置页勾选「启用微信消息」。

## 开发构建

```bash
npm install
npm run build
npm run dist
```

构建产物位于 `release/流萤弹幕消息.exe`。

## 卸载

右键托盘图标，选择「卸载软件」，在确认对话框中点击红色「确认」按钮即可。

## License

[MIT](LICENSE)
