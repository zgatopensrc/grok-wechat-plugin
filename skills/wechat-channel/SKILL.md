---
name: 微信渠道
description: 安装/登录/收发/卸载微信 iLink。每号一专属助手；全局 webhook 唤醒安装助手后转交专属助手（也可选每号 webhook 直达）；历史首次完整同步、之后由其持久会话自带；收信自动正在输入（持续保活至回复）；回复后 ack。
---
# 微信渠道

MCP `grok-wechat` → iLink。

`私信 → monitor(立即 typing，保活至回复) → 连发合并（安静 1s 即唤醒，最晚首条后 3s；GROK_WECHAT_COALESCE_IDLE_MS / GROK_WECHAT_COALESCE_MS） → webhook(msgs[+hist 首次]) → 转交该号专属助手 → 助手回复 wechat_send → wechat_ack`

立刻回复。typing 由 monitor 自动开启并每 5s 保活，`wechat_send` 后自动关闭，**无需**再调 `wechat_typing`。

## 安装（一次）

用户：「安装这个微信插件 https://github.com/little-thing/grok-wechat-plugin」

1. 加连接器 `grok-wechat`（`server/index.js`）
2. Routine「微信入站唤醒」(webhook，全局一条)：直接用 payload（无需 `wechat_inbox`）；**把 payload 原样转交给 `bot` 对应的专属助手 `asst`（同一个持久会话，不要新开）**，由它回复；它回复后再 `wechat_ack`。`asst` 为空则自己直接回复
3. Routine「微信监听保活」每 **20 分钟**：只调 `wechat_start_monitor`
4. 用户粘贴 webhook url+key → `wechat_set_wake`（不带 `ilink_bot_id` = 全局）
5. `wechat_login_start` → 立刻 `wechat_login_wait` 至 `logged_in`
6. 每号：建专属助手 → `wechat_set_dedicated_assistant`

### 可选：每号 webhook 直达（省掉转交这一手）

需要专属助手**自己**建 webhook Routine（安装助手无权替别的助手建）：让「微信1」建「微信入站唤醒-微信1」，prompt 为「按 payload 处理 msgs/hist → `wechat_send` → `wechat_ack`」，把 url+key 发回，再 `wechat_set_wake(ilink_bot_id, url, key)`。有自有 webhook 的号直达该助手，其余号仍走全局转交。自有 webhook 连续失败会被当作助手已删，清掉登记并回退全局

## Webhook payload / `wechat_inbox`

```
{ src, n, bot, asst, asst_id,
  msgs: [{ id, from, bot, text?, media?, sid, asst }],
  hist:   { "<sid>": [{ r:"u"|"a", t }] },   // 仅在专属助手尚未同步该会话时出现；完整、不截断
  thread: ["<sid>"],                          // 这些会话的历史已在专属助手的持久会话里，不再重发
  ack: "wechat_ack" }
```

- **历史同步**：专属助手第一次处理某会话（首批被 ack）前，每次唤醒都带完整 `hist[sid]`（该批**之前**的全部轮次，连续重复的助手回复已合并）；ack 之后改发 `thread`，历史由助手自己的持久会话承载（LLM 在它那一侧已有完整上文）。插件本地仍保存全部轮次作为备份
- 转交时 `hist`（若有）随消息一并交给专属助手；收到 `thread`：上文已在专属助手的持久会话里，直接在它原会话续聊，**不要新开会话**
- 未登记专属助手的账号：始终带完整 `hist`；`asst` 为空时由你直接回复（不转交）
- `warn: assistant_missing:<名>`：该号的专属助手已被删/不回复，插件已自动清掉登记（并在有全局兜底 webhook 时清掉该号自有 webhook，改走兜底）。直接回复当前消息，并告诉用户重建专属助手后 `wechat_set_dedicated_assistant`（若用了直达，还要重建它的 webhook 并 `wechat_set_wake`）
- 助手会话被重置/丢失：重新 `wechat_set_dedicated_assistant`（同名即可），下一次唤醒会重发完整 `hist`
- 当前消息在 `msgs`
- 连发的多条消息合并为一次唤醒，按 `msgs` 顺序一起处理、一次回复即可
- `media[].path` 是本机文件路径

## 事件 payload（无 `msgs`）

- `event: "login_expired"`：该号微信登录已过期，收不到消息。**告知用户**，然后 `wechat_login_start` → 立刻 `wechat_login_wait`，让用户重新扫码。每 30 分钟最多提醒 6 次，恢复后自动停止
- 事件 payload 不需要 `wechat_ack`

## 访问控制

默认拒绝：只处理账号主人（扫码的微信）和 allowlist 内的人。陌生人的消息被丢弃，`wechat_status.blocked` 列出最近被拦的人；用户同意后 `wechat_approve(user_id)`

## 流程

1. 用 `msgs`（+`hist`，若有）理解并回复（转交方式下由专属助手回复）（webhook 缺失/失败时 `wechat_inbox`，它**只 peek 不清空**）
2. `wechat_send`（`to_user_id=from`，带同一 `bot`）
3. **`wechat_ack`（`ids` = msgs 的 id）**，须在 `wechat_send` 之后：只有 ack 时插件已记录到晚于该消息的回复，才视为该会话已同步到助手会话；提前 ack 会在返回里列出 `unsynced`，其历史下次唤醒会重发。未 ack 的消息保留；webhook 失败时 monitor 会自动重试唤醒（最多 6 次，间隔 30s）

## 工具

`login_start/wait` · `set_wake` · `set_dedicated_assistant` · `status` · `inbox` · `ack` · `send` · `send_media` · `typing` · `start/stop_monitor` · `approve` · `logout` · `uninstall`

## 卸载

「卸掉微信插件」→ `wechat_uninstall` → 卸连接器 → 删 Routine「微信入站唤醒」「微信监听保活」（若用过直达，还有各「微信入站唤醒-<助手名>」）→ 侧栏删专属助手。
