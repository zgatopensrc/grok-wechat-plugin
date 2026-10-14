# grok-wechat-plugin

[中文](README.md) | [English](README.en.md)

WeChat iLink channel for Grok Bot. DMs go via local gateway **sendPrompt** into the **dedicated assistant** persistent session. Handoff failure or unresponsive dedicated assistant → sendPrompt Ori. **No** external Cursor webhooks.

## Capabilities

- QR login; one dedicated assistant per account
- Text / voice / media; typing; uncapped talk history
- Code handoff (dedicated first, Ori fallback)
- **Monitor self-heal** (1.11.7+): MCP watchdog ~30s + heartbeat-stale ~90s + orphan reap. External「微信监听保活」is **obsolete**

## Binding

1. Confirm channel. 2. Add connector — **do not** create keepalive or inbound-wake routines; `wechat_set_wake` for Ori. 3. QR + dedicated assistant (**one random English word**, e.g. `Cedar`; not 微信N / Chinese platform name; handoff uses `asst_id`). 4. `wechat_status` healthy.

See `skills/wechat-channel/SKILL.md`.
