---
name: 微信渠道
description: 安装/登录/收发/卸载微信 iLink。每号一专属助手；webhook 入站；hist 首次完整、之后靠持久会话；收信自动 typing；回复后 ack。
---
# 微信渠道

MCP `grok-wechat` → iLink。

`私信 → typing → 合并(安静0.5s/最长3s) → webhook → 转交专属助手 → wechat_send → wechat_ack`

## 安装

1. 加连接器 `grok-wechat`（`server/index.js`）
2. Routine「微信入站唤醒」(webhook)：prompt 用下方原文
3. Routine「微信监听保活」每 5 分钟：调 `wechat_start_monitor`（会检查心跳，挂死则重启）
4. 用户贴 webhook url+key → `wechat_set_wake`（不带 `ilink_bot_id`=全局）
5. `wechat_login_start` → `wechat_login_wait` 至 logged_in
6. 每号：建专属助手 → `wechat_set_dedicated_assistant`

### 分发 prompt（原文）

```
把收到的 webhook payload 原样转交给专属助手 `asst`（同一持久会话），priority:true，然后结束。
`asst` 为空：按 msgs(+hist) 回复，wechat_send 后 wechat_ack。
probe:true：结束。event：按 hint 告知用户。
```

不要身份判断、不要等待、不要兜底回复。助手不回由插件服务端清登记。

可选直达：专属助手自建 webhook → `wechat_set_wake(ilink_bot_id,url,key)`。

## Payload

`{ bot, asst, asst_id, msgs[{id,from,text?,media?,sid}], hist?, thread?, ack, warn? }`

- `hist`：专属助手未同步前带完整历史（不截断；仅首次/重同步时带）
- `thread`：已在助手会话里，不再重发 hist
- 语音转写在 `media[].text`
- 回复：`wechat_send(to_user_id=from, ilink_bot_id=bot)` → `wechat_ack(ids)`

## 访问 / 卸载

默认拒绝陌生人；主人+allowlist。`wechat_uninstall` → 卸连接器 → 删 Routine → 侧栏删专属助手。
