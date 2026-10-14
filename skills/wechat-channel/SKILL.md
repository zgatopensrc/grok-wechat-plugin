---
name: 微信渠道
description: 安装/登录/收发/卸载微信 iLink。每号一专属助手；入站由插件代码 handoff 到专属助手持久会话（等同 SendToAgent，无 Ori LLM 转交）；hist 首次完整、之后靠持久会话；收信自动 typing；回复后 ack。
---
# 微信渠道

MCP `grok-wechat` → iLink。

**低延迟（推荐）**：`私信 → typing → 合并 → 插件代码 gateway sendPrompt → 专属助手持久会话 → wechat_send → wechat_ack`  
（不经安装助手 LLM；保留专属助手侧栏上下文。**不要**给专属助手建 own webhook——每次 webhook 是全新例程跑，会丢会话上下文。）

**兜底（全局 webhook）**：`私信 → … → POST 全局 webhook → 安装助手转交专属助手 → …`  
（handoff 失败或未登记 `asst_id` 时；多一轮 Ori 推理，约 +15–20s）

## 安装

1. 加连接器 `grok-wechat`（`server/index.js`）
2. Routine「微信入站唤醒」(webhook)：prompt 用下方「分发 prompt」——仅作**全局兜底**
3. Routine「微信监听保活」每 20 分钟：调 `wechat_start_monitor`（会检查心跳，挂死则重启）
4. 用户贴 webhook url+key → `wechat_set_wake`（**不带** `ilink_bot_id` = 全局兜底）
5. `wechat_login_start` → `wechat_login_wait` 至 logged_in
6. 每号：建专属助手 → `wechat_set_dedicated_assistant(ilink_bot_id, assistant_id, assistant_name)`  
   有 `assistant_id` 后，`wechat_status` 显示 `wake: "handoff"`；入站由插件直达该助手持久会话。
7. **不要**在专属助手上建「微信入站唤醒-<名>」own webhook（会丢上下文）。若已误建，可删掉、勿 `wechat_set_wake(..., ilink_bot_id)`。

### 分发 prompt（全局兜底，原文）

```
把收到的 webhook payload 原样转交给专属助手 `asst`（同一持久会话），priority:true，然后结束。
`asst` 为空：按 msgs(+hist) 回复，wechat_send 后 wechat_ack。
probe:true：结束。event：按 hint 告知用户。
```

不要身份判断、不要等待、不要兜底回复。助手不回由插件服务端清登记。

### 专属助手（handoff 入站）

入站消息以 JSON payload 出现在专属助手会话里（from 安装助手）。按 payload：`probe:true` 结束；`event` 按 hint 告知用户；否则 `wechat_send(to_user_id=from, ilink_bot_id=bot)` 后 `wechat_ack(ids)`。不要转交其他助手，不要把内容镜像到 App 聊天。

## Payload

`{ bot, asst, asst_id, msgs[{id,from,text?,media?,sid}], hist?, thread?, ack, warn? }`

- `hist`：专属助手未同步前带完整历史（不截断；仅首次/重同步时带）
- `thread`：已在助手会话里，不再重发 hist
- 语音转写在 `media[].text`
- 回复：`wechat_send(to_user_id=from, ilink_bot_id=bot)` → `wechat_ack(ids)`

## 访问 / 卸载

默认拒绝陌生人；主人+allowlist。`wechat_uninstall` → 卸连接器 → 删 Routine（全局「微信入站唤醒」「微信监听保活」；若误建过「微信入站唤醒-<助手名>」一并删）→ 侧栏删专属助手。
