# grok-wechat-plugin

[中文](README.md) | [English](README.en.md)

Grok Bot 的微信 iLink 渠道。扫码绑定个人号后，私信经共享 webhook 唤醒对应**专属助手**；可回文字与媒体。成功收信后自动显示「正在输入」；每个微信号一个助手，该助手内保持会话上下文。

## 能力

- **扫码登录**，一个连接器绑定多个微信个人号；**每号一个专属 Grok Bot 助手**（该号内保持上下文）
- **私信文字收发**：Markdown 自动转纯文本，超长消息自动分段
- **语音**：按转写文本处理
- **媒体**：收发图片、视频、文件（入站媒体下载到本机）
- **正在输入**：monitor 成功收到消息后自动打开，发完自动关闭
- **会话上下文**：按微信对端持久化完整 talk history（**不截断**；追加写入的 per-peer 文件；连续重复的助手回复自动合并，用户重复的话保留）
- **Webhook 带正文**：唤醒 payload 含 `msgs`；历史**首次完整同步**给该号的专属助手（`hist`，不截断），助手处理并回复过一次后（ack 前须已有回复，提前 ack 不算同步）改由其持久会话自带（payload 只带 `thread` 标记），不再每次重发；插件本地始终保留全部轮次，可省一次 `wechat_inbox`
- **低延迟**：每个账号独立长轮询，互不阻塞；默认 3000ms 内连发合并为一次唤醒（`GROK_WECHAT_COALESCE_MS`，未设置或非法时为 3000）；收信立即「正在输入」并每 5s 保活直到回复
- **可靠取件**：`wechat_inbox` 只 peek，成功回复后 `wechat_ack` 再删；入站写入带跨进程锁；webhook 失败自动重试；按 `message_id` 去重
- **allowlist（默认拒绝）**：只处理绑定账号的主人（扫码的微信）和名单内的人；陌生人的消息被丢弃并记入 `wechat_status.blocked`，用 `wechat_approve` 放行
- **故障自愈**：专属助手被删/不回复（连续 3 次唤醒 2 分钟无回复，或 5 分钟无回复）→ 自动清掉登记、改发完整历史并在 payload 带 `warn`；监听重启后自动补发未回复的唤醒；已处理消息编号落盘去重；微信登录过期会唤醒 agent（`event: login_expired`）提醒重新扫码
- **每号 webhook 直达专属助手**：每个号的 webhook Routine 建在它自己的专属助手名下，唤醒直接进该助手，**没有中转 agent**（少一次冷启动与转交）；全局 webhook 仅作没有自有 webhook 的号的兜底
- **保活**：建议每 20 分钟 `wechat_start_monitor`（勿用 5 分钟）

## 一句话安装

在 Grok Bot 里发：

```
安装这个微信插件 https://github.com/little-thing/grok-wechat-plugin
```

## 绑定流程

按对话一步走完即可，整段过程如下：

![在 Grok Bot 里安装、确认渠道、粘贴一次 webhook、扫码](docs/bind-flow.png)

1. **确认添加渠道**  
   对话里会出现「加」按钮，点一下，把微信渠道接到 Grok Bot。

2. **连接器与保活 Routine**  
   安装助手加上微信连接器，并创建 Routine **「微信监听保活」**（每 20 分钟 `wechat_start_monitor`）。

3. **扫码登录微信，并为每个号配专属助手**  
   `wechat_login_start` 出码 → 立即 `wechat_login_wait` 至 `logged_in=true`。每次绑定成功后：创建该号的**专属 Grok Bot 助手**；在**该助手名下**创建 webhook Routine「微信入站唤醒-<助手名>」；webhook Routine 创建后平台不把 url/key 返回给 agent，需从该 Routine 面板复制地址与密钥发来，安装助手 `wechat_set_wake`（带该号 `ilink_bot_id`）写入这个号自己的 webhook，再 `wechat_set_dedicated_assistant` 登记 id/名称。绑定更多账号时，每个号重复一遍。

4. **绑定完成**  
   `wechat_status` 显示各账号 `wake: "own"` 与专属助手名称。入站由插件直接 POST 该号自己的 webhook，唤醒的就是它的专属助手，没有中转。

对方给你发一条微信私信，就能在微信里收到回复。

## 绑定后的效果

在微信里直接说话即可，例如：

![微信里发私信，助手立刻回复](docs/bind-effect.png)

成功收信后微信端会显示「正在输入」。文字、语音转写、图片、视频、文件都可处理；回媒体时用本机文件路径。同一微信对端的多轮对话会带上既往 `history`，在该账号专属助手会话内保持上下文。

默认只有你自己（扫码的微信）能对话；要让别人也能对话，让助手 `wechat_approve` 把对方加入 allowlist（`wechat_status` 的 `blocked` 里能看到被拦的人）。要解绑某个号，在对话里说登出该微信；不指定则登出全部。

## 多账号

一个连接器可绑定多个微信个人号。每个号独立扫码，并有自己的专属助手与自己的 webhook（`wechat_set_wake` 带 `ilink_bot_id`）。`wechat_status` 查看各账号 `wake`（`own`/`global`）与专属助手名称。

## 链路

微信私信 → monitor 收件箱（自动「正在输入」）→ POST 该号自己的 webhook → 该号专属助手醒来（payload 含 msgs，首次含完整 hist）→ `wechat_send` / `wechat_send_media` → `wechat_ack`

任务做完立刻回复。`bot_agent` 为 `Grokbot/1.0.0`。

安装细节见 `skills/wechat-channel/SKILL.md`。

## 一句话卸载

在 Grok Bot 里发：

```
卸掉微信插件
```

安装助手会：

1. 调用 `wechat_uninstall` 清理本机，并读取 `dedicated_assistants_sidebar_delete` 中的专属助手名称。
2. 卸载 `grok-wechat` 连接器。
3. 删除 Routine「微信监听保活」与各专属助手名下的「微信入站唤醒-<助手名>」（以及旧版全局「微信入站唤醒」，若有）。
4. 告知用户在侧栏右键删除返回列表中的专属助手（如「微信1」「微信2」）。

从 Settings 卸掉连接器后，本机 monitor 也会自动清理。完成后重装需重新为每个号配 webhook 并扫码，`wechat_status` 为零账号。
