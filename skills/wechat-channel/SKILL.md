---
name: 微信渠道
description: 安装/登录/收发/卸载微信 iLink。入站 webhook 带正文+完整历史；每号一专属助手；收信自动正在输入（持续保活至回复）；回复后 ack。
---
# 微信渠道

MCP `grok-wechat` → iLink。

`私信 → monitor(立即 typing，保活至回复) → 600ms 合并连发 → webhook(msgs+hist) → 回复 wechat_send → wechat_ack`

立刻回复。typing 由 monitor 自动开启并每 5s 保活，`wechat_send` 后自动关闭，**无需**再调 `wechat_typing`。

## 安装（一次）

用户：「安装这个微信插件 https://github.com/little-thing/grok-wechat-plugin」

1. 加连接器 `grok-wechat`（`server/index.js`）
2. Routine「微信入站唤醒」(webhook)：直接用 payload 的 `msgs` + `hist`（无需 `wechat_inbox`）；按 `bot`→`asst` 转交；处理完 `wechat_ack`
3. Routine「微信监听保活」每 **20 分钟**：只调 `wechat_start_monitor`
4. 用户粘贴 webhook url+key → `wechat_set_wake`
5. `wechat_login_start` → 立刻 `wechat_login_wait` 至 `logged_in`
6. 每号：建专属助手 → `wechat_set_dedicated_assistant`

## Webhook payload / `wechat_inbox`

```
{ src, n, bot, asst, asst_id,
  msgs: [{ id, from, bot, text?, media?, sid, asst }],
  hist: { "<sid>": [{ r:"u"|"a", t }] },   // 每个会话只出现一次，完整、不截断
  ack: "wechat_ack" }
```

- `hist[sid]` = 该批消息**之前**的全部轮次（连续重复的助手回复已合并）；当前消息在 `msgs`
- 连发的多条消息合并为一次唤醒，按 `msgs` 顺序一起处理、一次回复即可
- `media[].path` 是本机文件路径

## 流程

1. 用 `msgs` + `hist[sid]` 理解上下文（webhook 缺失/失败时 `wechat_inbox`，它**只 peek 不清空**）
2. `wechat_send`（`to_user_id=from`，带同一 `bot`）
3. **`wechat_ack`（`ids` = msgs 的 id）**。未 ack 的消息保留；webhook 失败时 monitor 会自动重试唤醒（最多 6 次，间隔 30s）

## 工具

`login_start/wait` · `set_wake` · `set_dedicated_assistant` · `status` · `inbox` · `ack` · `send` · `send_media` · `typing` · `start/stop_monitor` · `approve` · `logout` · `uninstall`

## 卸载

「卸掉微信插件」→ `wechat_uninstall` → 卸连接器 → 删两 Routine → 侧栏删专属助手。
