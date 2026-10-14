---
name: 微信渠道
description: 安装/登录/收发/卸载微信 iLink。每号一专属助手；入站插件 sendPrompt handoff 到专属助手持久会话；失败/无助手/助手不回则 sendPrompt 兜底到安装助手（Ori）。无外部 Cursor webhook。监听进程插件内自愈。hist 首次完整；收信自动 typing；回复后 ack。
---
# 微信渠道

MCP `grok-wechat` → iLink。

**主路径**：`私信 → typing → 合并 → gateway sendPrompt → 专属助手持久会话 → wechat_send → wechat_ack`  
（保留专属助手侧栏上下文；不经安装助手推理。）

**兜底（仍是本地 sendPrompt）**：handoff 失败、未登记 `asst_id`、或专属助手连续不回复被 demote 后 → `sendPrompt → 安装助手（Ori）持久会话`。  
**已移除**：Cursor automation 外部 webhook（`wake.json` / `api2.cursor.sh` / `wechat_set_wake` 的 url+key）。

**监听自愈（1.11.7+）**：连接器 MCP 进程每 ~30s `ensureMonitor`；心跳超过 ~90s 无 poll 返回则杀僵重启；pgrep 收掉重复 `--monitor` 孤儿。安装**不再需要** Routine「微信监听保活」。

## 安装

1. 加连接器 `grok-wechat`（`server/index.js`）
2. **不要**创建「微信监听保活」Routine（已废弃；插件自愈）。**不要**创建「微信入站唤醒」webhook Routine。若侧栏里还有，可禁用/删除。
3. 登记安装助手作兜底：`wechat_set_wake(assistant_id=<Ori的agentId>, assistant_name="Ori")`  
   （url/key 参数已忽略。）
4. `wechat_login_start` → `wechat_login_wait` 至 logged_in
5. 每号：建专属助手 → `wechat_set_dedicated_assistant(ilink_bot_id, assistant_id, assistant_name)`  
   `wechat_status` 显示 `wake: "handoff"` 与 `fallback: { id, name, via: "sendPrompt" }`；`monitor_stale: false`。

### 安装助手（Ori）收到兜底 payload 时

payload 可能带 `warn`（如 `fallback:handoff_failed` / `fallback:assistant_unresponsive` / `assistant_missing:…`）。  
按 payload：`probe` 忽略；`event` 按 hint 告知用户；否则把内容转交给专属助手 `asst`（同一持久会话，priority:true），或在 `asst` 为空时自行 `wechat_send` 后 `wechat_ack`。

### 专属助手（主路径 handoff）

入站 JSON 出现在专属助手会话里。按 payload：`event` 按 hint 告知用户；否则 `wechat_send(to_user_id=from, ilink_bot_id=bot)` 后 `wechat_ack(ids)`。不要转交其他助手，不要把内容镜像到 App 聊天。

## 「微信1不回」如何判定（无 webhook）

插件在成功 `sendPrompt` handoff 后监视收件箱：若消息仍未 ack 且期间无 `wechat_send`（`ASSISTANT_STALE_MS`≈2min 算一次 strike；连续 3 次或单次 ≥5min）→ `demoteAssistant` 清掉专属登记，并把未回复消息 **sendPrompt 给 Ori**。不经过外部 webhook。

## Payload

`{ bot, asst, asst_id, msgs[{id,from,text?,media?,sid}], hist?, thread?, ack, warn? }`

- `hist`：专属助手未同步前带完整历史（不截断；仅首次/重同步时带）
- `thread`：已在助手会话里，不再重发 hist
- 语音转写在 `media[].text`
- 回复：`wechat_send(to_user_id=from, ilink_bot_id=bot)` → `wechat_ack(ids)`

## 访问 / 卸载

默认拒绝陌生人；主人+allowlist。`wechat_uninstall` → 卸连接器 → 若残留则删「微信监听保活」「微信入站唤醒」→ 侧栏删专属助手。
