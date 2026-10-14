# grok-wechat-plugin

[中文](README.md) | [English](README.en.md)

Grok Bot 的微信 iLink 渠道。扫码绑定个人号后，私信由插件经本地 gateway **sendPrompt** 写入对应**专属助手**的持久会话；可回文字与媒体。成功收信后自动「正在输入」。每个微信号一个助手，保持会话上下文。handoff 失败或专属助手不回时，改为 sendPrompt 给安装助手（Ori）兜底——**不再使用** Cursor 外部 webhook。

## 能力

- **扫码登录**，一个连接器绑定多个微信个人号；**每号一个专属 Grok Bot 助手**（该号内保持上下文）
- **私信文字收发**：Markdown 自动转纯文本，超长消息自动分段
- **语音**：按转写文本处理
- **媒体**：收发图片、视频、文件（入站媒体下载到本机）
- **正在输入**：monitor 成功收到消息后自动打开，发完自动关闭
- **会话上下文**：按微信对端持久化完整 talk history（**不截断**）
- **Payload 带正文**：唤醒 payload 含 `msgs`；历史**首次完整同步**（`hist`），之后 `thread` 标记
- **低延迟**：独立长轮询；连发合并；收信立即「正在输入」
- **可靠取件**：peek + ack；sendPrompt 重试；message_id 去重
- **allowlist（默认拒绝）**
- **故障自愈**：专属助手不回 → sendPrompt 给 Ori；登录过期通知
- **代码 handoff**：专属优先；Ori `handoffFrom` 兜底。**无**外部 webhook
- **监听自愈**：MCP ~30s watchdog + 心跳 ~90s 僵死重启 + 收掉重复 `--monitor` 孤儿。**无需**「微信监听保活」Routine

## 绑定流程

1. 确认添加渠道  
2. 加连接器；**不要**建「微信监听保活」或「微信入站唤醒」。`wechat_set_wake(assistant_id, assistant_name)` 登记 Ori 兜底  
3. 扫码；每号建专属助手（**单个随机英文单词**，勿用「微信1」/中文用户名）+ `wechat_set_dedicated_assistant`（路由认 `asst_id`）  
4. `wechat_status`：`wake: "handoff"`、`monitor_stale: false`

## 卸载

`wechat_uninstall` → 卸连接器 → 删残留 Routine → 删专属助手。

详见 `skills/wechat-channel/SKILL.md`。
