---
name: 微信渠道
description: 安装/登录/收发/卸载微信 iLink。入站 webhook；每号一专属助手；收信自动正在输入。
---
# 微信渠道

MCP `grok-wechat` → iLink。

`私信 → monitor(+typing) → webhook → wechat_inbox → 按 bot 转交专属助手 → wechat_send`

立刻回复。typing 已自动开/关，一般勿再调 `wechat_typing`。

## 安装（一次）

用户：「安装这个微信插件 https://github.com/little-thing/grok-wechat-plugin」

1. 加连接器 `grok-wechat`（`server/index.js`）
2. Routine「微信入站唤醒」(webhook)：`wechat_inbox` → 按 `bot`/`asst` 转交；用 `hist`
3. Routine「微信监听保活」每 5 分钟：只调 `wechat_start_monitor`
4. 用户粘贴 webhook url+key → `wechat_set_wake`
5. `wechat_login_start` → 立刻 `wechat_login_wait` 至 `logged_in`；expired 则重出码
6. 每号：建专属助手 → `wechat_set_dedicated_assistant`（勿重复建同号助手）

## 入站字段（`wechat_inbox` → `msgs[]`）

| 字段 | 含义 |
|---|---|
| `from` | 对端 |
| `bot` | `ilink_bot_id` |
| `text` | 文本/语音转写 |
| `media` | 非文本项（含本机 `path`） |
| `sid` | 会话键 |
| `asst` / `asst_id` | 专属助手 |
| `hist` | 既往轮次 `{r:u\|a,t}`，续聊用 |

回复用同一 `bot`：`wechat_send` / `wechat_send_media`（`to_user_id=from`）。

## 工具（短）

`login_start/wait` · `set_wake` · `set_dedicated_assistant` · `status` · `inbox` · `send` · `send_media` · `typing` · `start/stop_monitor` · `approve` · `logout` · `uninstall`

## 卸载

用户「卸掉微信插件」→ `wechat_uninstall` → 卸连接器 → 删两 Routine → 告知侧栏删专属助手。
