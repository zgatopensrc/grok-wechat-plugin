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
- **监听自愈（盒子醒着时）**：MCP ~30s watchdog + 心跳 ~90s 僵死重启 + 收掉重复 `--monitor` 孤儿。VM 冻结时这些定时器不跑
- **外部唤醒**：**要**创建并启用 Ori Routine「微信监听保活」，**每 5 分钟**、全天（Grok Bot cron 下限；分钟相位任意）。示例：`CRON_TZ=Asia/Shanghai M,M+5,... * * * *`。到点由平台唤醒盒子；不代替 MCP `ensureMonitor`
- **实测（2026-10-14 Asia/Shanghai）**：聊天/控制面活动唤醒盒子；19:04:06 标 idle 后，外层约 19:08:07 冻结 guest（idle→freeze ≈241s）。冻结时插件内定时器不跑。Ori 保活是外部唤醒

## 绑定流程

1. 确认添加渠道  
2. 加连接器。**要**建并启用 Ori Routine「微信监听保活」（每 5 分钟、全天，唤醒盒子；相位任意，如 `CRON_TZ=Asia/Shanghai 12,17,22,27,32,37,42,47,52,57 * * * *`）。**不要**建「微信入站唤醒」webhook（入站仍是插件内 sendPrompt）。`wechat_set_wake(assistant_id, assistant_name)` 登记 Ori 兜底  
3. 扫码；每号建专属助手（**单个随机英文单词**，勿用「微信1」/中文用户名）+ `wechat_set_dedicated_assistant`（路由认 `asst_id`）  
4. `wechat_status`：`wake: "handoff"`、`monitor_stale: false`

## 卸载

`wechat_uninstall` → 卸连接器 → 卸载时删「微信监听保活」与「微信入站唤醒」→ 删专属助手。安装期间保活保持启用。

详见 `skills/wechat-channel/SKILL.md`。
