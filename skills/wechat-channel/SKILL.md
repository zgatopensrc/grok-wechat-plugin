---
name: 微信渠道
description: 安装/登录/收发/卸载微信 iLink。每号一专属助手；入站插件 sendPrompt handoff 到专属助手持久会话；失败/无助手/助手不回则 sendPrompt 兜底到安装助手（Ori）。无外部 Cursor webhook。盒子醒着时监听进程插件内自愈；另建 Ori「微信监听保活」每 5 分钟 cron 唤醒盒子。不要建「微信入站唤醒」。hist 首次完整；收信自动 typing；回复后 ack。
---
# 微信渠道

MCP `grok-wechat` → iLink。

专属助手侧栏名 = 登记的 `assistant_name`（**单个随机英文单词**，如 `Cedar` / `Nimbus`；勿用「微信1」或用户中文名）；路由只认 `asst_id`。

**主路径**：`私信 → typing → 合并 → gateway sendPrompt → 专属助手持久会话 → wechat_send → wechat_ack`  
（保留专属助手侧栏上下文；不经安装助手推理。）

**兜底（仍是本地 sendPrompt）**：handoff 失败、未登记 `asst_id`、或专属助手连续不回复被 demote 后 → `sendPrompt → 安装助手（Ori）持久会话`。  
**已移除**：Cursor automation 外部 webhook（`wake.json` / `api2.cursor.sh` / `wechat_set_wake` 的 url+key）。

**监听自愈（盒子醒着时）**：连接器 MCP 进程每 ~30s `ensureMonitor`；心跳超过 ~90s 无 poll 返回则杀僵重启；pgrep 收掉重复 `--monitor` 孤儿。VM 冻结时进程定时器不前进，这两路都不会跑。

**外部唤醒（要建）**：在 Ori 上创建并启用 Routine「微信监听保活」，**每 5 分钟**、全天 24 小时（Grok Bot 日程下限；夜里微信也要解冻）。分钟相位任意，只要每 5 分钟一次。示例：`CRON_TZ=Asia/Shanghai M,M+5,... * * * *`（已启用的一例：`12,17,22,27,32,37,42,47,52,57`）。到点由平台唤醒盒子。它不代替 `ensureMonitor`。

**实测（2026-10-14 Asia/Shanghai，不外推）**：聊天/控制面活动会唤醒盒子。一次对话在 19:04:06 标为 idle 后，外层冻结约从 19:08:07 开始（idle→freeze ≈241s，约 4 分钟）。冻结期间插件内定时器不跑；t0 之后第一段 mcp-watchdog 空隙约 91s，该窗口 missing_runtime 约 +69s。平台 cron 最短 5 分钟，故保活用每 5 分钟而不是更疏的间隔。Ori 保活是外部唤醒，不是冻结 VM 里的代码定时器。

**不要建** Routine「微信入站唤醒」webhook。入站仍是插件内 sendPrompt handoff。

## 安装

1. 加连接器 `grok-wechat`（`server/index.js`）
2. **要**创建并启用 Ori Routine「微信监听保活」（每 5 分钟、全天；相位任意，如 `CRON_TZ=Asia/Shanghai 12,17,22,27,32,37,42,47,52,57 * * * *`），用来唤醒盒子。若已有则保持启用。**不要**创建「微信入站唤醒」webhook Routine；若侧栏里还有，禁用/删除。
3. 登记安装助手作兜底：`wechat_set_wake(assistant_id=<Ori的agentId>, assistant_name="Ori")`  
   （url/key 参数已忽略。）
4. `wechat_login_start` → `wechat_login_wait` 至 logged_in
5. 每号：建专属助手时 **`assistant_name` 用单个随机英文单词**（如 `Cedar` / `Nimbus`；**不要**「微信1」、平台中文用户名或微信昵称）→ `wechat_set_dedicated_assistant(ilink_bot_id, assistant_id, assistant_name)`  
   handoff **只认** `assistant_id`；仅改名且 id 不变不重置 hist 同步。  
   `wechat_status` 显示 `wake: "handoff"` 与 `fallback: { id, name, via: "sendPrompt" }`；`monitor_stale: false`。

### 安装助手（Ori）收到兜底 payload 时

payload 可能带 `warn`（如 `fallback:handoff_failed` / `fallback:assistant_unresponsive` / `assistant_missing:…`）。  
按 payload：`probe` 忽略；`event` 按 hint 告知用户；否则把内容转交给专属助手 `asst`（同一持久会话，priority:true），或在 `asst` 为空时自行 `wechat_send` 后 `wechat_ack`。

### 专属助手（主路径 handoff）

入站 JSON 出现在专属助手会话里。按 payload：`event` 按 hint 告知用户；否则 `wechat_send(to_user_id=from, ilink_bot_id=bot)` 后 `wechat_ack(ids)`。不要转交其他助手，不要把内容镜像到 App 聊天。

## 专属助手不回如何判定（无 webhook）

插件在成功 `sendPrompt` handoff 后监视收件箱：若消息仍未 ack 且期间无 `wechat_send`（`ASSISTANT_STALE_MS`≈2min 算一次 strike；连续 3 次或单次 ≥5min）→ `demoteAssistant` 清掉专属登记，并把未回复消息 **sendPrompt 给 Ori**。不经过外部 webhook。

## Payload

`{ bot, asst, asst_id, msgs[{id,from,text?,media?,sid}], hist?, thread?, ack, warn? }`

- `hist`：专属助手未同步前带完整历史（不截断；仅首次/重同步时带）
- `thread`：已在助手会话里，不再重发 hist
- 语音转写在 `media[].text`
- 回复：`wechat_send(to_user_id=from, ilink_bot_id=bot)` → `wechat_ack(ids)`

## 访问 / 卸载

默认拒绝陌生人；主人+allowlist。`wechat_uninstall` → 卸连接器 → 卸载时删残留 Routine「微信监听保活」与「微信入站唤醒」（安装期间保活应保持启用；入站唤醒不要建）→ 侧栏删专属助手。
