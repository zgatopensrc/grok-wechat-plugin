---
name: 微信渠道
description: 安装/登录/收发/卸载微信 iLink。入站 webhook 带正文；每号一专属助手；收信自动正在输入；ack 确认删除。
---
# 微信渠道

MCP `grok-wechat` → iLink。

`私信 → monitor(+typing) → webhook(含 msgs) → 处理 → wechat_send → wechat_ack`

立刻回复。monitor 已开 typing；若未见输入中，唤醒后立刻 `wechat_typing on`。

## 安装（一次）

用户：「安装这个微信插件 https://github.com/little-thing/grok-wechat-plugin」

1. 加连接器 `grok-wechat`（`server/index.js`）
2. Routine「微信入站唤醒」(webhook)：优先用 payload.`msgs`（含 text/media/hist）；缺省再 `wechat_inbox`。按 `bot`→`asst` 转交。处理完 `wechat_ack`
3. Routine「微信监听保活」每 **20 分钟**：只调 `wechat_start_monitor`
4. 用户粘贴 webhook url+key → `wechat_set_wake`
5. `wechat_login_start` → 立刻 `wechat_login_wait` 至 `logged_in`
6. 每号：建专属助手 → `wechat_set_dedicated_assistant`

## 入站（webhook `msgs[]` 或 `wechat_inbox`）

| 字段 | 含义 |
|---|---|
| `id` | ack 用 |
| `from` / `bot` | 对端 / 本机账号 |
| `text` / `media` | 正文与本地媒体 path |
| `sid` | 会话键 |
| `asst` / `asst_id` | 专属助手 |
| `hist` | **完整**既往轮次 `{r:u\|a,t}`（不截断） |

流程：用 `msgs` 或 peek inbox → 回复 `wechat_send`（`to_user_id=from`，带同一 `bot`）→ **`wechat_ack`（ids）**。inbox 不会因 peek 清空；不 ack 会重复投递。

## 工具

`login_start/wait` · `set_wake` · `set_dedicated_assistant` · `status` · `inbox` · `ack` · `send` · `send_media` · `typing` · `start/stop_monitor` · `approve` · `logout` · `uninstall`

## 卸载

「卸掉微信插件」→ `wechat_uninstall` → 卸连接器 → 删两 Routine → 侧栏删专属助手。
